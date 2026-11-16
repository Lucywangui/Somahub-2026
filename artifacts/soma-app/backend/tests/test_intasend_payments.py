"""
IntaSend payment flow: crediting, unlocking, missed confirmations and refunds.

IntaSend itself is replaced by FakeIntaSend, which records every call.
"""
from datetime import timedelta

import pytest

import app as soma_app
from conftest import PHONE, STUDENT_CODE
from intasend_client import IntaSendError

MATERIAL_ID = "cbc-7-english-topical-1"


class FakeIntaSend:
    def __init__(self):
        self.invoices = {}
        self.refunds = []
        self.status_calls = 0
        self.refund_error = None

    # -- the three calls the backend makes -------------------------------
    def mpesa_stk_push(self, phone_number, amount, narrative, api_ref, currency="KES"):
        invoice_id = f"INV-{len(self.invoices) + 1}"
        self.invoices[invoice_id] = {
            "invoice_id": invoice_id,
            "api_ref": api_ref,
            "state": "PENDING",
            "value": f"{amount:.2f}",
            "net_amount": f"{amount:.2f}",
            "charges": "0.00",
            "currency": currency,
        }
        return {"invoice": dict(self.invoices[invoice_id])}

    def payment_status(self, invoice_id):
        self.status_calls += 1
        return {"invoice": dict(self.invoices[invoice_id])}

    def request_refund(self, invoice_id, amount, reason, reason_details=None):
        if self.refund_error:
            raise self.refund_error
        self.refunds.append({"invoice": invoice_id, "amount": amount, "reason_details": reason_details})
        return {"chargeback_id": f"CB-{len(self.refunds)}"}

    # -- test helpers ----------------------------------------------------
    def pay(self, invoice_id, **fields):
        self.invoices[invoice_id].update({"state": "COMPLETE", **fields})

    def only_invoice(self):
        assert len(self.invoices) == 1
        return next(iter(self.invoices))


@pytest.fixture
def intasend(monkeypatch):
    fake = FakeIntaSend()
    monkeypatch.setattr(soma_app, "get_intasend_service", lambda: fake)
    return fake


def start_payment(client, amount=50, purpose=None):
    body = {"soma_hub_code": STUDENT_CODE, "phone_number": PHONE, "amount": amount}
    if purpose:
        body["purpose"] = purpose
    response = client.post("/api/intasend/payment-session", json=body)
    assert response.status_code == 200, response.get_json()
    return response.get_json()["session_id"]


def status(client, session_id):
    response = client.get(f"/api/intasend/payment-status/{session_id}")
    assert response.status_code == 200, response.get_json()
    return response.get_json()


def account(client):
    return client.get(f"/api/account/{STUDENT_CODE}").get_json()


def wallet(client):
    return client.get(f"/api/wallet/{STUDENT_CODE}").get_json()["balance"]


def backdate(session_id, minutes):
    """Make a session look older (past its 30-minute window, last check, etc.)."""
    past = (soma_app.utc_now() - timedelta(minutes=minutes)).isoformat()
    conn = soma_app.get_db()
    conn.execute(
        "UPDATE payment_sessions SET created_at = %s, expires_at = %s, last_checked_at = NULL "
        "WHERE session_id = %s",
        (past, past, session_id),
    )
    conn.commit()
    conn.close()


def session_row(session_id):
    return soma_app.load_payment_session(session_id)


# -- crediting -------------------------------------------------------------

def test_pending_payment_reports_pending(client, intasend):
    session_id = start_payment(client)
    assert status(client, session_id)["status"] == "pending"
    assert wallet(client) == 0


@pytest.mark.parametrize("paid", [
    {"value": "50.00", "net_amount": "48.50", "charges": "1.50"},   # business pays charges
    {"value": "51.50", "net_amount": "50.00", "charges": "1.50"},   # customer pays charges on top
])
def test_completed_payment_credits_wallet_under_either_charge_setting(client, intasend, paid):
    session_id = start_payment(client, amount=50)
    intasend.pay(intasend.only_invoice(), **paid)

    result = status(client, session_id)

    assert result["status"] == "completed"
    assert wallet(client) == 50
    assert intasend.refunds == []


def test_paying_for_a_material_unlocks_it(client, intasend):
    session_id = start_payment(client, amount=5, purpose=f"unlock:{MATERIAL_ID}")
    intasend.pay(intasend.only_invoice())

    result = status(client, session_id)

    assert result["status"] == "completed"
    assert result["purpose_result"] == "done"
    assert MATERIAL_ID in account(client)["unlocked"]


def test_completed_payment_is_credited_only_once(client, intasend):
    session_id = start_payment(client, amount=50)
    intasend.pay(intasend.only_invoice())
    for _ in range(3):
        status(client, session_id)
    client.post(
        "/api/intasend/webhook",
        json={"challenge": soma_app.INTASEND_WEBHOOK_CHALLENGE, "invoice_id": intasend.only_invoice(),
              "api_ref": session_row(session_id)["merchant_request_id"], "state": "COMPLETE"},
    )
    assert wallet(client) == 50


# -- missed confirmations ----------------------------------------------------

def test_session_past_its_window_is_rechecked_before_being_called_expired(client, intasend):
    session_id = start_payment(client, amount=50)
    backdate(session_id, minutes=45)
    intasend.pay(intasend.only_invoice())

    assert status(client, session_id)["status"] == "completed"
    assert wallet(client) == 50


def test_unpaid_session_past_its_window_expires(client, intasend):
    session_id = start_payment(client, amount=50)
    backdate(session_id, minutes=45)

    assert status(client, session_id)["status"] == "expired"


def test_expired_session_paid_later_is_applied_when_the_app_syncs(client, intasend):
    """The app gave up waiting and the webhook never arrived."""
    session_id = start_payment(client, amount=5, purpose=f"unlock:{MATERIAL_ID}")
    backdate(session_id, minutes=45)
    assert status(client, session_id)["status"] == "expired"

    intasend.pay(intasend.only_invoice())
    backdate(session_id, minutes=45)  # clear the recent-check throttle

    acc = account(client)

    assert MATERIAL_ID in acc["unlocked"]
    assert session_row(session_id)["status"] == "COMPLETED"


def test_reconcile_does_not_hammer_intasend(client, intasend):
    session_id = start_payment(client, amount=50)
    backdate(session_id, minutes=1)
    account(client)
    calls = intasend.status_calls
    account(client)
    account(client)
    assert intasend.status_calls == calls  # checked at most every 2 minutes


# -- refunds ---------------------------------------------------------------

def test_payment_of_the_wrong_amount_is_refunded_once(client, intasend):
    session_id = start_payment(client, amount=50)
    intasend.pay(intasend.only_invoice(), value="20.00", net_amount="20.00")

    first = status(client, session_id)
    second = status(client, session_id)

    assert first["status"] == "refunded"
    assert first["refund_amount"] == 20.0
    assert second["status"] == "refunded"
    assert intasend.refunds == [
        {"invoice": intasend.only_invoice(), "amount": 20.0, "reason_details": "Payment amount mismatch."}
    ]
    assert wallet(client) == 0


def test_payment_with_a_foreign_reference_is_refunded(client, intasend):
    session_id = start_payment(client, amount=50)
    intasend.pay(intasend.only_invoice(), api_ref="SOMEONE-ELSE")

    assert status(client, session_id)["status"] == "refunded"
    assert len(intasend.refunds) == 1
    assert wallet(client) == 0


def test_refund_failure_is_flagged_for_review_not_retried(client, intasend):
    intasend.refund_error = IntaSendError("boom", status_code=500)
    session_id = start_payment(client, amount=50)
    intasend.pay(intasend.only_invoice(), currency="USD")

    assert status(client, session_id)["status"] == "review"
    assert session_row(session_id)["status"] == "NEEDS_REVIEW"
    intasend.refund_error = None
    assert status(client, session_id)["status"] == "review"
    assert intasend.refunds == []


def test_credited_payment_is_never_refunded(client, intasend):
    session_id = start_payment(client, amount=50)
    intasend.pay(intasend.only_invoice())
    status(client, session_id)

    result = soma_app.refund_unapplied_payment(session_row(session_id), "50.00", "test")

    assert result["state"] == "COMPLETE"
    assert intasend.refunds == []
    assert wallet(client) == 50


# -- rate limits and the scheduler endpoint ----------------------------------

def test_status_limit_is_per_payment_not_shared_by_everyone(client, intasend):
    first = start_payment(client, amount=50)
    second = start_payment(client, amount=60)
    for _ in range(40):
        client.get(f"/api/intasend/payment-status/{first}")
    assert client.get(f"/api/intasend/payment-status/{first}").status_code == 429
    assert client.get(f"/api/intasend/payment-status/{second}").status_code == 200


def test_reconcile_endpoint_requires_token(client, intasend, monkeypatch):
    monkeypatch.setattr(soma_app, "RECONCILE_TOKEN", "")
    assert client.post("/api/internal/reconcile-payments").status_code == 503

    monkeypatch.setattr(soma_app, "RECONCILE_TOKEN", "secret-token")
    assert client.post("/api/internal/reconcile-payments", headers={"X-Reconcile-Token": "nope"}).status_code == 403

    session_id = start_payment(client, amount=50)
    backdate(session_id, minutes=45)
    intasend.pay(intasend.only_invoice())
    response = client.post("/api/internal/reconcile-payments", headers={"X-Reconcile-Token": "secret-token"})

    assert response.status_code == 200
    assert response.get_json()["completed"] == 1
    assert wallet(client) == 50
