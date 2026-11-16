"""
Minimal IntaSend client with timeouts.

The intasend-python library calls requests without a timeout, so one slow
IntaSend response can hang a gunicorn worker (and every learner waiting on
it). These helpers send the same requests as the library (same endpoints,
payloads and headers) but always give up after INTASEND_TIMEOUT.
"""

import requests

# (connect, read) seconds.
INTASEND_TIMEOUT = (5, 20)

LIVE_BASE_URL = "https://payment.intasend.com/api/v1/"
SANDBOX_BASE_URL = "https://sandbox.intasend.com/api/v1/"


class IntaSendError(Exception):
    def __init__(self, message, status_code=None, body=None):
        super().__init__(message)
        self.status_code = status_code
        self.body = body


class IntaSendClient:
    def __init__(self, secret_key, publishable_key, test=False, session=None):
        self.secret_key = secret_key
        self.publishable_key = publishable_key
        self.base_url = SANDBOX_BASE_URL if test else LIVE_BASE_URL
        self.http = session or requests

    # -- transport --------------------------------------------------------

    def _post(self, endpoint, payload, authenticated=True):
        headers = {"INTASEND_PUBLIC_API_KEY": self.publishable_key or ""}
        if authenticated:
            headers["Authorization"] = f"Bearer {self.secret_key or ''}"

        try:
            response = self.http.post(
                self.base_url + endpoint,
                json=payload,
                headers=headers,
                timeout=INTASEND_TIMEOUT,
            )
        except requests.RequestException as exc:
            raise IntaSendError(f"IntaSend request failed: {exc}") from exc

        try:
            body = response.json()
        except ValueError:
            body = {"raw": response.text}

        if response.status_code >= 400:
            raise IntaSendError(
                f"IntaSend returned HTTP {response.status_code}",
                status_code=response.status_code,
                body=body,
            )

        return body

    # -- API --------------------------------------------------------------

    def mpesa_stk_push(self, phone_number, amount, narrative, api_ref, currency="KES"):
        return self._post(
            "payment/mpesa-stk-push/",
            {
                "public_key": self.publishable_key,
                "currency": currency,
                "method": "M-PESA",
                "amount": amount,
                "phone_number": phone_number,
                "api_ref": api_ref,
                "narrative": narrative,
            },
        )

    def payment_status(self, invoice_id):
        return self._post(
            "payment/status/",
            {"invoice_id": invoice_id, "public_key": self.publishable_key},
            authenticated=False,
        )

    def request_refund(self, invoice_id, amount, reason, reason_details=None):
        """Ask IntaSend to refund (all or part of) a collected invoice to the payer."""
        return self._post(
            "chargebacks/",
            {
                "invoice": invoice_id,
                "amount": amount,
                "reason": reason,
                "reason_details": reason_details,
            },
        )
