import os
import secrets
import hmac
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation

from flask import Flask, jsonify, request, session
from flask_cors import CORS
from dotenv import load_dotenv
from werkzeug.security import check_password_hash


# ============================================================
# ENVIRONMENT
# ============================================================

BASE_DIR = os.path.dirname(
    os.path.abspath(__file__)
)

# Load .env BEFORE importing database.py because
# database.py reads DATABASE_URL when it is imported.
load_dotenv(
    os.path.join(
        BASE_DIR,
        ".env"
    ),
    override=True,
)

import database
from coins import create_coins_blueprint, is_valid_purpose
from intasend import APIService


INTASEND_PUBLISHABLE_KEY = os.getenv(
    "INTASEND_PUBLISHABLE_KEY",
    ""
).strip()

INTASEND_SECRET_KEY = os.getenv(
    "INTASEND_SECRET_KEY",
    ""
).strip()

INTASEND_TEST_ENVIRONMENT = (
    os.getenv(
        "INTASEND_TEST_ENVIRONMENT",
        "true"
    ).strip().lower()
    in ("1", "true", "yes", "on")
)

INTASEND_WEBHOOK_CHALLENGE = os.getenv(
    "INTASEND_WEBHOOK_CHALLENGE",
    ""
).strip()

PAYMENT_REDIRECT_URL = os.getenv(
    "PAYMENT_REDIRECT_URL",
    "https://somaahub.co.ke"
).strip()

SOMA_CORS_ORIGINS = os.getenv(
    "SOMA_CORS_ORIGINS",
    "https://somaahub.co.ke,https://www.somaahub.co.ke,http://localhost:5173,http://127.0.0.1:5173"
).replace("\n", "").strip()


# ============================================================
# APP
# ============================================================

app = Flask(__name__)

app.secret_key = os.getenv(
    "FLASK_SECRET_KEY",
    secrets.token_hex(32)
)

CORS(
    app,
    resources={
        r"/api/*": {
            "origins": [
                origin.strip()
                for origin in SOMA_CORS_ORIGINS.split(",")
                if origin.strip()
            ]
        }
    },
    supports_credentials=True,
)

app.config["SESSION_COOKIE_SECURE"] = True
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "None"


# ============================================================
# TIME / DATABASE HELPERS
# ============================================================

def utc_now():
    return datetime.now(timezone.utc)


def now_string():
    return datetime.now().strftime(
        "%Y-%m-%d %H:%M:%S"
    )


def parse_database_datetime(value):
    """
    Convert PostgreSQL datetime values returned either as
    datetime objects or strings into timezone-aware UTC
    datetime objects.
    """

    if value is None:
        return None

    if isinstance(value, datetime):
        parsed = value
    else:
        text = str(value).strip()

        if not text:
            return None

        parsed = None

        formats = [
            "%Y-%m-%d %H:%M:%S.%f",
            "%Y-%m-%d %H:%M:%S",
            "%Y-%m-%dT%H:%M:%S.%f",
            "%Y-%m-%dT%H:%M:%S",
            "%Y-%m-%dT%H:%M:%S.%fZ",
            "%Y-%m-%dT%H:%M:%SZ",
        ]

        for fmt in formats:
            try:
                parsed = datetime.strptime(
                    text,
                    fmt
                )
                break
            except ValueError:
                continue

        if parsed is None:
            try:
                parsed = datetime.fromisoformat(
                    text.replace(
                        "Z",
                        "+00:00"
                    )
                )
            except ValueError:
                return None

    if parsed.tzinfo is None:
        parsed = parsed.replace(
            tzinfo=timezone.utc
        )

    return parsed.astimezone(
        timezone.utc
    )


def get_db():
    return database.get_connection()


def is_sandbox():
    return INTASEND_TEST_ENVIRONMENT


# ============================================================
# WALLET BALANCE
# ============================================================

def calculate_wallet_balance(
    conn_or_code,
    soma_hub_code=None,
):
    """
    Calculate the student's paid SOMA Points balance.

    Supports:

        calculate_wallet_balance(code)

    and:

        calculate_wallet_balance(conn, code)
    """

    if soma_hub_code is None:
        code = str(
            conn_or_code
        ).strip().upper()

        with database.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT
                        COALESCE(
                            SUM(
                                CASE
                                    WHEN transaction_type = 'CREDIT'
                                        THEN amount
                                    WHEN transaction_type = 'DEBIT'
                                        THEN -amount
                                    ELSE 0
                                END
                            ),
                            0
                        ) AS balance
                    FROM wallet_transactions
                    WHERE soma_hub_code = %s
                    """,
                    (code,),
                )

                row = cur.fetchone()

        if not row:
            return 0

        return max(
            0,
            int(row["balance"] or 0)
        )

    conn = conn_or_code

    code = str(
        soma_hub_code
    ).strip().upper()

    cursor = conn.cursor()

    try:
        cursor.execute(
            """
            SELECT
                COALESCE(
                    SUM(
                        CASE
                            WHEN transaction_type = 'CREDIT'
                                THEN amount
                            WHEN transaction_type = 'DEBIT'
                                THEN -amount
                            ELSE 0
                        END
                    ),
                    0
                ) AS balance
            FROM wallet_transactions
            WHERE soma_hub_code = %s
            """,
            (code,),
        )

        row = cursor.fetchone()

    finally:
        cursor.close()

    if not row:
        return 0

    return max(
        0,
        int(row["balance"] or 0)
    )


# ============================================================
# PHONE / INTASEND HELPERS
# ============================================================

def normalize_phone(phone):
    """
    Normalize common Kenyan phone formats.

    0712345678 -> 254712345678
    712345678  -> 254712345678
    +254712345678 -> 254712345678
    """

    if phone is None:
        return None

    phone = (
        str(phone)
        .strip()
        .replace(" ", "")
        .replace("-", "")
    )

    if phone.startswith("+"):
        phone = phone[1:]

    if phone.startswith("0") and len(phone) == 10:
        phone = "254" + phone[1:]

    elif phone.startswith("7") and len(phone) == 9:
        phone = "254" + phone

    elif phone.startswith("1") and len(phone) == 9:
        phone = "254" + phone

    if not phone.isdigit():
        return None

    if not phone.startswith("254"):
        return None

    if len(phone) != 12:
        return None

    return phone


def get_intasend_service():
    if (
        not INTASEND_SECRET_KEY
        and not INTASEND_PUBLISHABLE_KEY
    ):
        raise RuntimeError(
            "IntaSend credentials are not configured."
        )

    return APIService(
        token=INTASEND_SECRET_KEY or None,
        publishable_key=(
            INTASEND_PUBLISHABLE_KEY or None
        ),
        test=INTASEND_TEST_ENVIRONMENT,
    )


def extract_intasend_invoice_id(response):
    if not isinstance(response, dict):
        return None

    invoice_id = response.get(
        "invoice_id"
    )

    if invoice_id:
        return str(invoice_id)

    invoice = response.get(
        "invoice"
    )

    if isinstance(invoice, dict):
        invoice_id = (
            invoice.get("invoice_id")
            or invoice.get("id")
        )

        if invoice_id:
            return str(invoice_id)

    data = response.get(
        "data"
    )

    if isinstance(data, dict):
        invoice_id = (
            data.get("invoice_id")
            or data.get("id")
        )

        if invoice_id:
            return str(invoice_id)

        nested_invoice = data.get(
            "invoice"
        )

        if isinstance(nested_invoice, dict):
            invoice_id = (
                nested_invoice.get("invoice_id")
                or nested_invoice.get("id")
            )

            if invoice_id:
                return str(invoice_id)

    return None


def extract_intasend_api_ref(response):
    if not isinstance(response, dict):
        return None

    api_ref = (
        response.get("api_ref")
        or response.get("api_reference")
    )

    if api_ref:
        return str(api_ref)

    data = response.get(
        "data"
    )

    if isinstance(data, dict):
        api_ref = (
            data.get("api_ref")
            or data.get("api_reference")
        )

        if api_ref:
            return str(api_ref)

    return None


def extract_intasend_invoice(response):
    if not isinstance(response, dict):
        return {}

    invoice = response.get(
        "invoice"
    )

    if isinstance(invoice, dict):
        return invoice

    data = response.get(
        "data"
    )

    if isinstance(data, dict):
        nested_invoice = data.get(
            "invoice"
        )

        if isinstance(nested_invoice, dict):
            return nested_invoice

        return data

    return response


# ============================================================
# AMOUNT HELPERS
# ============================================================

def normalize_amount(value):
    try:
        amount = Decimal(
            str(value)
        )
    except (
        InvalidOperation,
        TypeError,
        ValueError,
    ):
        return None

    if amount <= 0:
        return None

    return amount.quantize(
        Decimal("0.01")
    )


def amounts_match(
    first,
    second,
):
    first_amount = normalize_amount(
        first
    )

    second_amount = normalize_amount(
        second
    )

    if (
        first_amount is None
        or second_amount is None
    ):
        return False

    return first_amount == second_amount


def is_whole_shilling(
    amount
):
    if amount is None:
        return False

    return amount == amount.to_integral_value()


# ============================================================
# PAYMENT PURPOSE
# ============================================================

def normalize_payment_purpose(
    purpose
):
    if purpose is None:
        return "topup"

    purpose = str(
        purpose
    ).strip()

    if not purpose:
        return "topup"

    aliases = {
        "top_up": "topup",
        "top-up": "topup",
        "wallet": "topup",
        "deposit": "topup",
    }

    normalized = aliases.get(
        purpose.lower(),
        purpose,
    )

    if normalized.lower() == "topup":
        return "topup"

    if normalized.lower() == "subscribe":
        return "subscribe"

    if normalized.lower().startswith(
        "unlock:"
    ):
        material_id = normalized[
            len("unlock:"):
        ].strip()

        if material_id:
            return (
                "unlock:"
                + material_id
            )

    return normalized


def validate_payment_purpose(
    purpose
):
    normalized = normalize_payment_purpose(
        purpose
    )

    if normalized == "topup":
        return True

    return is_valid_purpose(
        normalized
    )


# ============================================================
# STUDENT LOOKUP
# ============================================================

def get_student_by_code(
    soma_hub_code
):
    code = str(
        soma_hub_code
    ).strip().upper()

    with database.get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT *
                FROM students
                WHERE soma_hub_code = %s
                LIMIT 1
                """,
                (code,),
            )

            return cur.fetchone()


# ============================================================
# PAYMENT SESSION HELPERS
# ============================================================

def payment_session_reference(
    payment_session
):
    return (
        payment_session.get(
            "checkout_request_id"
        )
        or payment_session.get(
            "invoice_id"
        )
        or payment_session.get(
            "merchant_request_id"
        )
        or payment_session.get(
            "session_id"
        )
    )


def process_completed_payment(
    payment_session_id,
    invoice_id=None,
):
    """
    Credit the wallet exactly once.

    The payment_sessions row is locked first.
    A PostgreSQL advisory lock based on the transaction
    reference provides another layer of duplicate protection.
    """

    conn = database.get_connection()

    try:
        cur = conn.cursor()

        cur.execute(
            """
            SELECT *
            FROM payment_sessions
            WHERE id = %s
            FOR UPDATE
            """,
            (
                payment_session_id,
            ),
        )

        payment_session = cur.fetchone()

        if not payment_session:
            conn.rollback()
            return {
                "success": False,
                "message": (
                    "Payment session not found."
                ),
            }

        current_status = str(
            payment_session.get(
                "status",
                ""
            )
        ).upper()

        if current_status == "COMPLETED":
            balance = calculate_wallet_balance(
                conn,
                payment_session[
                    "soma_hub_code"
                ],
            )

            conn.rollback()

            return {
                "success": True,
                "already_processed": True,
                "balance": balance,
            }

        amount = normalize_amount(
            payment_session.get(
                "amount"
            )
        )

        if amount is None:
            conn.rollback()

            return {
                "success": False,
                "message": (
                    "Invalid payment session amount."
                ),
            }

        soma_hub_code = str(
            payment_session.get(
                "soma_hub_code"
            )
        ).strip().upper()

        if not soma_hub_code:
            conn.rollback()

            return {
                "success": False,
                "message": (
                    "Payment session has no student code."
                ),
            }

        student_id = payment_session.get(
            "student_id"
        )

        cur.execute(
            """
            SELECT *
            FROM students
            WHERE soma_hub_code = %s
            LIMIT 1
            """,
            (
                soma_hub_code,
            ),
        )

        student = cur.fetchone()

        if not student:
            conn.rollback()

            return {
                "success": False,
                "message": (
                    "Student for payment was not found."
                ),
            }

        if (
            student_id is not None
            and student.get("id") != student_id
        ):
            conn.rollback()

            return {
                "success": False,
                "message": (
                    "Payment student verification failed."
                ),
            }

        reference = (
            payment_session.get(
                "checkout_request_id"
            )
            or invoice_id
            or payment_session.get(
                "merchant_request_id"
            )
            or payment_session.get(
                "session_id"
            )
        )

        if not reference:
            conn.rollback()

            return {
                "success": False,
                "message": (
                    "Payment has no transaction reference."
                ),
            }

        reference = str(
            reference
        )

        # Serialize all processing attempts for this
        # exact payment reference.
        cur.execute(
            """
            SELECT pg_advisory_xact_lock(
                hashtext(%s)
            )
            """,
            (
                reference,
            ),
        )

        cur.execute(
            """
            SELECT id
            FROM wallet_transactions
            WHERE reference = %s
            LIMIT 1
            """,
            (
                reference,
            ),
        )

        existing_transaction = (
            cur.fetchone()
        )

        if existing_transaction:
            cur.execute(
                """
                UPDATE payment_sessions
                SET status = 'COMPLETED'
                WHERE id = %s
                """,
                (
                    payment_session_id,
                ),
            )

            balance = calculate_wallet_balance(
                conn,
                soma_hub_code,
            )

            conn.commit()

            return {
                "success": True,
                "already_processed": True,
                "balance": balance,
            }

        stored_invoice_id = (
            payment_session.get(
                "checkout_request_id"
            )
        )

        if (
            invoice_id
            and stored_invoice_id
            and str(invoice_id)
            != str(stored_invoice_id)
        ):
            conn.rollback()

            return {
                "success": False,
                "message": (
                    "Payment invoice verification failed."
                ),
            }

        cur.execute(
            """
            INSERT INTO wallet_transactions (
                soma_hub_code,
                transaction_type,
                amount,
                reference,
                created_at
            )
            VALUES (
                %s,
                'CREDIT',
                %s,
                %s,
                %s
            )
            """,
            (
                soma_hub_code,
                amount,
                reference,
                now_string(),
            ),
        )

        cur.execute(
            """
            UPDATE payment_sessions
            SET status = 'COMPLETED'
            WHERE id = %s
            """,
            (
                payment_session_id,
            ),
        )

        balance = calculate_wallet_balance(
            conn,
            soma_hub_code,
        )

        conn.commit()

        return {
            "success": True,
            "already_processed": False,
            "balance": balance,
            "amount": float(amount),
        }

    except Exception:
        conn.rollback()
        raise

    finally:
        conn.close()

# ============================================================
# INTASEND PAYMENT STATUS VERIFICATION
# ============================================================

def verify_intasend_completed_payment(
    payment_session,
    invoice_id=None,
):
    """
    Independently verify a COMPLETE payment with IntaSend
    before any wallet credit is released.

    The webhook itself is NOT trusted as the final source
    of payment truth.
    """

    stored_invoice_id = (
        payment_session.get(
            "checkout_request_id"
        )
    )

    invoice_id = (
        invoice_id
        or stored_invoice_id
    )

    if not invoice_id:
        return {
            "success": False,
            "message": (
                "No IntaSend invoice ID is available."
            ),
        }

    if (
        stored_invoice_id
        and str(invoice_id)
        != str(stored_invoice_id)
    ):
        return {
            "success": False,
            "message": (
                "IntaSend invoice ID does not "
                "match the payment session."
            ),
        }

    try:
        service = get_intasend_service()

        response = service.collect.status(
            invoice_id=str(invoice_id)
        )

    except Exception as exc:
        return {
            "success": False,
            "message": (
                "Unable to verify payment status "
                "with IntaSend."
            ),
            "error": str(exc),
        }

    invoice = extract_intasend_invoice(
        response
    )

    returned_invoice_id = (
        extract_intasend_invoice_id(
            response
        )
        or invoice.get("invoice_id")
        or invoice.get("id")
    )

    if (
        returned_invoice_id
        and str(returned_invoice_id)
        != str(invoice_id)
    ):
        return {
            "success": False,
            "message": (
                "IntaSend returned a different invoice ID."
            ),
        }

    state = str(
        invoice.get(
            "state",
            response.get("state", "")
            if isinstance(response, dict)
            else "",
        )
    ).upper()

    if state != "COMPLETE":
        return {
            "success": False,
            "message": (
                "IntaSend has not confirmed this payment "
                "as COMPLETE."
            ),
            "state": state or "UNKNOWN",
        }

    stored_api_ref = (
        payment_session.get(
            "merchant_request_id"
        )
    )

    returned_api_ref = (
        invoice.get("api_ref")
        or invoice.get("api_reference")
        or extract_intasend_api_ref(
            response
        )
    )

    if (
        stored_api_ref
        and returned_api_ref
        and str(returned_api_ref)
        != str(stored_api_ref)
    ):
        return {
            "success": False,
            "message": (
                "IntaSend API reference does not "
                "match the payment session."
            ),
        }

    stored_amount = normalize_amount(
        payment_session.get(
            "amount"
        )
    )

    returned_amount = (
        invoice.get("value")
        if invoice.get("value") is not None
        else invoice.get("amount")
    )

    if returned_amount is None and isinstance(
        response,
        dict,
    ):
        returned_amount = (
            response.get("value")
            if response.get("value") is not None
            else response.get("amount")
        )

    if (
        returned_amount is not None
        and not amounts_match(
            stored_amount,
            returned_amount,
        )
    ):
        return {
            "success": False,
            "message": (
                "IntaSend payment amount does not "
                "match the payment session."
            ),
        }

    returned_currency = (
        invoice.get("currency")
        or (
            response.get("currency")
            if isinstance(response, dict)
            else None
        )
    )

    if (
        returned_currency
        and str(returned_currency).upper()
        != "KES"
    ):
        return {
            "success": False,
            "message": (
                "Payment currency is not KES."
            ),
        }

    returned_provider = (
        invoice.get("provider")
        or (
            response.get("provider")
            if isinstance(response, dict)
            else None
        )
    )

    if returned_provider:
        provider_text = str(
            returned_provider
        ).upper().replace(
            "_",
            "-",
        )

        allowed_providers = {
            "MPESA",
            "M-PESA",
            "MPESA-STK",
            "M-PESA-STK",
        }

        if provider_text not in allowed_providers:
            return {
                "success": False,
                "message": (
                    "Payment provider is not M-Pesa."
                ),
            }

    return {
        "success": True,
        "state": state,
        "invoice_id": str(
            returned_invoice_id
            or invoice_id
        ),
        "api_ref": (
            str(returned_api_ref)
            if returned_api_ref
            else None
        ),
        "amount": (
            float(
                normalize_amount(
                    returned_amount
                )
            )
            if returned_amount is not None
            else None
        ),
        "currency": returned_currency,
        "provider": returned_provider,
        "raw": response,
    }


# ============================================================
# SYNC PAYMENT FROM INTASEND
# ============================================================

def sync_payment_from_intasend(
    payment_session
):
    invoice_id = (
        payment_session.get(
            "checkout_request_id"
        )
    )

    if not invoice_id:
        return {
            "status": "FAILED",
            "message": (
                "Payment has no IntaSend invoice ID."
            ),
        }

    try:
        service = get_intasend_service()

        response = service.collect.status(
            invoice_id=str(invoice_id)
        )

    except Exception as exc:
        return {
            "status": "PENDING",
            "message": (
                "Payment status is temporarily unavailable."
            ),
            "error": str(exc),
        }

    invoice = extract_intasend_invoice(
        response
    )

    returned_invoice_id = (
        extract_intasend_invoice_id(
            response
        )
        or invoice.get("invoice_id")
        or invoice.get("id")
    )

    if (
        returned_invoice_id
        and str(returned_invoice_id)
        != str(invoice_id)
    ):
        return {
            "status": "FAILED",
            "message": (
                "IntaSend invoice verification failed."
            ),
        }

    returned_api_ref = (
        invoice.get("api_ref")
        or invoice.get("api_reference")
        or extract_intasend_api_ref(
            response
        )
    )

    stored_api_ref = (
        payment_session.get(
            "merchant_request_id"
        )
    )

    if (
        stored_api_ref
        and returned_api_ref
        and str(returned_api_ref)
        != str(stored_api_ref)
    ):
        return {
            "status": "FAILED",
            "message": (
                "IntaSend API reference verification failed."
            ),
        }

    stored_amount = normalize_amount(
        payment_session.get(
            "amount"
        )
    )

    returned_amount = (
        invoice.get("value")
        if invoice.get("value") is not None
        else invoice.get("amount")
    )

    if returned_amount is not None:
        if not amounts_match(
            stored_amount,
            returned_amount,
        ):
            return {
                "status": "FAILED",
                "message": (
                    "IntaSend payment amount does not "
                    "match the payment session."
                ),
            }

    returned_currency = (
        invoice.get("currency")
        or (
            response.get("currency")
            if isinstance(response, dict)
            else None
        )
    )

    if (
        returned_currency
        and str(returned_currency).upper()
        != "KES"
    ):
        return {
            "status": "FAILED",
            "message": (
                "Payment currency is not KES."
            ),
        }

    returned_provider = (
        invoice.get("provider")
        or (
            response.get("provider")
            if isinstance(response, dict)
            else None
        )
    )

    if returned_provider:
        provider_text = str(
            returned_provider
        ).upper().replace(
            "_",
            "-",
        )

        allowed_providers = {
            "MPESA",
            "M-PESA",
            "MPESA-STK",
            "M-PESA-STK",
        }

        if provider_text not in allowed_providers:
            return {
                "status": "FAILED",
                "message": (
                    "Payment provider is not M-Pesa."
                ),
            }

    state = str(
        invoice.get(
            "state",
            response.get("state", "")
            if isinstance(response, dict)
            else "",
        )
    ).upper()

    if state == "COMPLETE":
        verification = (
            verify_intasend_completed_payment(
                payment_session,
                invoice_id=str(invoice_id),
            )
        )

        if not verification.get("success"):
            return {
                "status": "FAILED",
                "message": verification.get(
                    "message",
                    "Payment verification failed.",
                ),
            }

        result = process_completed_payment(
            payment_session["id"],
            invoice_id=str(invoice_id),
        )

        if not result.get("success"):
            return {
                "status": "FAILED",
                "message": result.get(
                    "message",
                    "Payment could not be completed.",
                ),
            }

        return {
            "status": "COMPLETE",
            "wallet_balance": result.get(
                "balance",
                0,
            ),
            "already_processed": result.get(
                "already_processed",
                False,
            ),
        }

    if state in {
        "FAILED",
        "CANCELED",
        "CANCELLED",
    }:
        return {
            "status": "FAILED",
            "message": (
                "IntaSend reports that the payment failed."
            ),
        }

    return {
        "status": state or "PENDING",
    }


# ============================================================
# BASIC ROUTES
# ============================================================

@app.route("/")
def home():
    return jsonify({
        "success": True,
        "service": "SOMA HUB API",
        "status": "running",
    })


@app.route("/api/test")
def api_test():
    return jsonify({
        "success": True,
        "message": "SOMA HUB API is working.",
    })


# ============================================================
# INTASEND CONFIG TEST
# ============================================================

@app.route(
    "/api/intasend-config-test",
    methods=["GET"],
)
def intasend_config_test():
    return jsonify({
        "success": True,
        "publishable_key_configured": bool(
            INTASEND_PUBLISHABLE_KEY
        ),
        "secret_key_configured": bool(
            INTASEND_SECRET_KEY
        ),
        "webhook_challenge_configured": bool(
            INTASEND_WEBHOOK_CHALLENGE
        ),
        "test_environment": (
            INTASEND_TEST_ENVIRONMENT
        ),
        "redirect_url": PAYMENT_REDIRECT_URL,
    })


# ============================================================
# STUDENT REGISTRATION
# ============================================================

@app.route(
    "/api/students/register",
    methods=["POST"],
)
def register_student():
    data = request.get_json(
        silent=True
    ) or {}

    soma_hub_code = str(
        data.get(
            "soma_hub_code",
            "",
        )
    ).strip().upper()

    name = str(
        data.get(
            "name",
            "",
        )
    ).strip()

    school_name = str(
        data.get(
            "school_name",
            data.get(
                "school",
                "",
            ),
        )
    ).strip()

    grade = str(
        data.get(
            "grade",
            "",
        )
    ).strip()

    if not soma_hub_code:
        return jsonify({
            "success": False,
            "message": (
                "SOMA HUB code is required."
            ),
        }), 400

    if not name:
        return jsonify({
            "success": False,
            "message": (
                "Student name is required."
            ),
        }), 400

    conn = database.get_connection()

    try:
        cur = conn.cursor()

        cur.execute(
            """
            SELECT id
            FROM students
            WHERE soma_hub_code = %s
            LIMIT 1
            """,
            (
                soma_hub_code,
            ),
        )

        existing = cur.fetchone()

        if existing:
            cur.execute(
                """
                UPDATE students
                SET
                    name = %s,
                    school_name = %s,
                    school = %s,
                    grade = %s
                WHERE soma_hub_code = %s
                """,
                (
                    name,
                    school_name,
                    school_name,
                    grade,
                    soma_hub_code,
                ),
            )

        else:
            cur.execute(
                """
                INSERT INTO students (
                    soma_hub_code,
                    name,
                    school_name,
                    school,
                    grade,
                    created_at
                )
                VALUES (
                    %s,
                    %s,
                    %s,
                    %s,
                    %s,
                    %s
                )
                """,
                (
                    soma_hub_code,
                    name,
                    school_name,
                    school_name,
                    grade,
                    now_string(),
                ),
            )

        conn.commit()

        return jsonify({
            "success": True,
            "soma_hub_code": soma_hub_code,
        })

    except Exception:
        conn.rollback()
        raise

    finally:
        conn.close()

# ============================================================
# STUDENT PERFORMANCE
# ============================================================

@app.route(
    "/api/students/performance",
    methods=["POST"],
)
def save_student_performance():
    data = request.get_json(
        silent=True
    ) or {}

    soma_hub_code = str(
        data.get(
            "soma_hub_code",
            "",
        )
    ).strip().upper()

    if not soma_hub_code:
        return jsonify({
            "success": False,
            "message": (
                "SOMA HUB code is required."
            ),
        }), 400

    term_points = data.get(
        "term_points",
        {},
    ) or {}

    quiz_results = data.get(
        "quiz_results",
        [],
    ) or {}

    conn = database.get_connection()

    try:
        cur = conn.cursor()

        # ----------------------------------------------------
        # FIND STUDENT
        # ----------------------------------------------------

        cur.execute(
            """
            SELECT id
            FROM students
            WHERE soma_hub_code = %s
            LIMIT 1
            """,
            (
                soma_hub_code,
            ),
        )

        student = cur.fetchone()

        if not student:
            conn.rollback()

            return jsonify({
                "success": False,
                "message": (
                    "Student not found."
                ),
            }), 404

        student_id = student["id"]

        # ----------------------------------------------------
        # TERM POINTS
        #
        # Existing SOMA HUB tracking uses:
        #
        #   term_points
        #
        # and the existing categories are:
        #
        #   study_notes_points
        #   topical_quiz_points
        #   exam_points
        #   consistency_points
        #   improvement_points
        #   total_points
        #
        # Do NOT create a new student_performance table.
        # ----------------------------------------------------

        if isinstance(
            term_points,
            dict,
        ):
            term_items = term_points.items()
        else:
            term_items = []

        saved_terms = []

        for term_key, raw_term in term_items:

            if not isinstance(
                raw_term,
                dict,
            ):
                continue

            term_key = str(
                term_key
            ).strip()

            if not term_key:
                continue

            def clean_points(
                value,
                maximum,
            ):
                try:
                    number = float(
                        value or 0
                    )
                except (
                    TypeError,
                    ValueError,
                ):
                    number = 0

                return max(
                    0,
                    min(
                        maximum,
                        number,
                    ),
                )

            study_notes_points = clean_points(
                raw_term.get(
                    "studyNotes",
                    raw_term.get(
                        "study_notes_points",
                        0,
                    ),
                ),
                20,
            )

            topical_quiz_points = clean_points(
                raw_term.get(
                    "topicalQuizzes",
                    raw_term.get(
                        "topical_quiz_points",
                        0,
                    ),
                ),
                25,
            )

            exam_points = clean_points(
                raw_term.get(
                    "exams",
                    raw_term.get(
                        "exam_points",
                        0,
                    ),
                ),
                25,
            )

            consistency_points = clean_points(
                raw_term.get(
                    "consistency",
                    raw_term.get(
                        "consistency_points",
                        0,
                    ),
                ),
                15,
            )

            # The existing database has one 15-point
            # improvement field. Support both frontend
            # names without creating another database field.
            improvement_points = clean_points(
                raw_term.get(
                    "improvement",
                    raw_term.get(
                        "progress",
                        raw_term.get(
                            "improvement_points",
                            0,
                        ),
                    ),
                ),
                15,
            )

            total_points = min(
                100,
                (
                    study_notes_points
                    + topical_quiz_points
                    + exam_points
                    + consistency_points
                    + improvement_points
                ),
            )

            # ------------------------------------------------
            # UPSERT EXISTING TERM RECORD
            # ------------------------------------------------

            cur.execute(
                """
                SELECT id
                FROM term_points
                WHERE
                    student_id = %s
                    AND term_key = %s
                LIMIT 1
                """,
                (
                    student_id,
                    term_key,
                ),
            )

            existing_term = cur.fetchone()

            if existing_term:
                cur.execute(
                    """
                    UPDATE term_points
                    SET
                        study_notes_points = %s,
                        topical_quiz_points = %s,
                        exam_points = %s,
                        consistency_points = %s,
                        improvement_points = %s,
                        total_points = %s
                    WHERE id = %s
                    """,
                    (
                        study_notes_points,
                        topical_quiz_points,
                        exam_points,
                        consistency_points,
                        improvement_points,
                        total_points,
                        existing_term["id"],
                    ),
                )

            else:
                cur.execute(
                    """
                    INSERT INTO term_points (
                        student_id,
                        term_key,
                        study_notes_points,
                        topical_quiz_points,
                        exam_points,
                        consistency_points,
                        improvement_points,
                        total_points
                    )
                    VALUES (
                        %s,
                        %s,
                        %s,
                        %s,
                        %s,
                        %s,
                        %s,
                        %s
                    )
                    """,
                    (
                        student_id,
                        term_key,
                        study_notes_points,
                        topical_quiz_points,
                        exam_points,
                        consistency_points,
                        improvement_points,
                        total_points,
                    ),
                )

            saved_terms.append({
                "term_key": term_key,
                "studyNotes": study_notes_points,
                "topicalQuizzes": topical_quiz_points,
                "exams": exam_points,
                "consistency": consistency_points,
                "improvement": improvement_points,
                "total": total_points,
            })

        # ----------------------------------------------------
        # QUIZ RESULTS
        #
        # Use the existing quiz_results table.
        # Do NOT create student_quiz_results.
        # ----------------------------------------------------

        if isinstance(
            quiz_results,
            list,
        ):
            for result in quiz_results:

                if not isinstance(
                    result,
                    dict,
                ):
                    continue

                material_id = str(
                    result.get(
                        "material_id",
                        result.get(
                            "materialId",
                            "",
                        ),
                    )
                ).strip()

                if not material_id:
                    continue

                material_title = str(
                    result.get(
                        "material_title",
                        result.get(
                            "materialTitle",
                            "",
                        ),
                    )
                ).strip()

                subject = str(
                    result.get(
                        "subject",
                        "",
                    )
                ).strip()

                grade_key = str(
                    result.get(
                        "grade_key",
                        result.get(
                            "gradeKey",
                            "",
                        ),
                    )
                ).strip()

                quiz_type = str(
                    result.get(
                        "quiz_type",
                        result.get(
                            "type",
                            "topical",
                        ),
                    )
                ).strip()

                try:
                    score = float(
                        result.get(
                            "score",
                            0,
                        ) or 0
                    )
                except (
                    TypeError,
                    ValueError,
                ):
                    score = 0

                try:
                    total = float(
                        result.get(
                            "total",
                            0,
                        ) or 0
                    )
                except (
                    TypeError,
                    ValueError,
                ):
                    total = 0

                try:
                    percentage = float(
                        result.get(
                            "percentage",
                            0,
                        ) or 0
                    )
                except (
                    TypeError,
                    ValueError,
                ):
                    percentage = 0

                completed_at = (
                    result.get(
                        "completed_at"
                    )
                    or result.get(
                        "completedAt"
                    )
                    or now_string()
                )

                # ------------------------------------------------
                # DUPLICATE CHECK
                # ------------------------------------------------

                cur.execute(
                    """
                    SELECT id
                    FROM quiz_results
                    WHERE
                        student_id = %s
                        AND material_id = %s
                        AND quiz_type = %s
                        AND completed_at = %s
                    LIMIT 1
                    """,
                    (
                        student_id,
                        material_id,
                        quiz_type,
                        completed_at,
                    ),
                )

                duplicate = cur.fetchone()

                if duplicate:
                    continue

                # ------------------------------------------------
                # INSERT EXISTING QUIZ RESULT
                # ------------------------------------------------

                cur.execute(
                    """
                    INSERT INTO quiz_results (
                        student_id,
                        material_id,
                        material_title,
                        subject,
                        grade_key,
                        quiz_type,
                        score,
                        total,
                        percentage,
                        completed_at
                    )
                    VALUES (
                        %s,
                        %s,
                        %s,
                        %s,
                        %s,
                        %s,
                        %s,
                        %s,
                        %s,
                        %s
                    )
                    """,
                    (
                        student_id,
                        material_id,
                        material_title,
                        subject,
                        grade_key,
                        quiz_type,
                        score,
                        total,
                        percentage,
                        completed_at,
                    ),
                )

        conn.commit()

        return jsonify({
            "success": True,
            "soma_hub_code": soma_hub_code,
            "term_points": saved_terms,
        })

    except Exception:
        conn.rollback()
        raise

    finally:
        conn.close()
        
    # ============================================================
# ADMIN LOGIN
# ============================================================

@app.post("/api/admin/login")
def admin_login():
    data = request.get_json(
        silent=True
    ) or {}

    username = str(
        data.get(
            "username",
            ""
        )
    ).strip()

    password = str(
        data.get(
            "password",
            ""
        )
    )

    if not username or not password:
        return jsonify({
            "success": False,
            "message": (
                "Username and password are required."
            ),
        }), 400

    admin_username = os.getenv(
        "ADMIN_USERNAME",
        ""
    ).strip()

    admin_password_hash = os.getenv(
        "ADMIN_PASSWORD_HASH",
        ""
    ).strip()

    if (
        not admin_username
        or not admin_password_hash
        or username != admin_username
        or not check_password_hash(
            admin_password_hash,
            password,
        )
    ):
        return jsonify({
            "success": False,
            "message": "Invalid admin credentials.",
        }), 401

    session["admin_authenticated"] = True
    session["admin_username"] = username

    return jsonify({
        "success": True,
        "authenticated": True,
        "username": username,
    })


@app.get("/api/admin/me")
def admin_me():
    authenticated = (
        session.get(
            "admin_authenticated"
        )
        is True
    )

    return jsonify({
        "success": True,
        "authenticated": authenticated,
        "username": (
            session.get("admin_username")
            if authenticated
            else None
        ),
    })


@app.post("/api/admin/logout")
def admin_logout():
    session.pop(
        "admin_authenticated",
        None,
    )

    session.pop(
        "admin_username",
        None,
    )

    return jsonify({
        "success": True,
        "authenticated": False,
    })


def require_admin():
    if (
        session.get(
            "admin_authenticated"
        )
        is not True
    ):
        return jsonify({
            "success": False,
            "message": "Admin authentication required.",
        }), 401

    return None


# ============================================================
# ADMIN STUDENT LOOKUP
# ============================================================

@app.get("/api/admin/students/<soma_hub_code>")
def admin_student_lookup(
    soma_hub_code
):
    auth_error = require_admin()

    if auth_error:
        return auth_error

    soma_hub_code = str(
        soma_hub_code
    ).strip().upper()

    conn = database.get_connection()

    try:
        cur = conn.cursor()

        cur.execute(
            """
            SELECT
                id,
                soma_hub_code,
                name,
                school_name,
                school,
                grade,
                created_at
            FROM students
            WHERE soma_hub_code = %s
            LIMIT 1
            """,
            (
                soma_hub_code,
            ),
        )

        student = cur.fetchone()

        if not student:
            return jsonify({
                "success": False,
                "message": "Student not found.",
            }), 404

        student_id = student["id"]

        cur.execute(
            """
            SELECT
                term_key,
                study_notes_points,
                topical_quiz_points,
                exam_points,
                consistency_points,
                improvement_points,
                total_points
            FROM term_points
            WHERE student_id = %s
            ORDER BY term_key
            """,
            (
                student_id,
            ),
        )

        terms = cur.fetchall()

        cur.execute(
            """
            SELECT
                material_id,
                material_title,
                subject,
                grade_key,
                quiz_type,
                score,
                total,
                percentage,
                completed_at
            FROM quiz_results
            WHERE student_id = %s
            ORDER BY completed_at DESC
            """,
            (
                student_id,
            ),
        )

        quizzes = cur.fetchall()

        wallet_balance = calculate_wallet_balance(
            conn,
            soma_hub_code,
        )

        return jsonify({
            "success": True,
            "student": student,
            "wallet_balance": wallet_balance,
            "coins": wallet_balance,
            "ksh": wallet_balance,
            "term_points": terms,
            "quiz_results": quizzes,
        })

    finally:
        conn.close()


# ============================================================
# ADMIN TOP STUDENTS
# ============================================================

@app.get("/api/admin/students/top")
def admin_top_students():
    auth_error = require_admin()

    if auth_error:
        return auth_error

    conn = database.get_connection()

    try:
        cur = conn.cursor()

        cur.execute(
            """
            SELECT
                s.id,
                s.soma_hub_code,
                s.name,
                s.school_name,
                s.school,
                s.grade,
                COALESCE(
                    SUM(
                        COALESCE(
                            tp.total_points,
                            0
                        )
                    ),
                    0
                ) AS total_points
            FROM students s
            LEFT JOIN term_points tp
                ON tp.student_id = s.id
            GROUP BY
                s.id,
                s.soma_hub_code,
                s.name,
                s.school_name,
                s.school,
                s.grade
            ORDER BY
                total_points DESC,
                s.name ASC
            LIMIT 50
            """
        )

        students = cur.fetchall()

        return jsonify({
            "success": True,
            "students": students,
        })

    finally:
        conn.close()


# ============================================================
# INTASEND PAYMENT SESSION
# ============================================================

@app.post(
    "/api/intasend/payment-session"
)
def create_payment_session():
    data = request.get_json(
        silent=True
    ) or {}

    soma_hub_code = str(
        data.get(
            "soma_hub_code",
            ""
        )
    ).strip().upper()

    phone = normalize_phone(
        data.get("phone")
    )

    purpose = normalize_payment_purpose(
        data.get("purpose")
    )

    amount = normalize_amount(
        data.get("amount")
    )

    if not soma_hub_code:
        return jsonify({
            "success": False,
            "message": (
                "SOMA HUB code is required."
            ),
        }), 400

    if not phone:
        return jsonify({
            "success": False,
            "message": (
                "A valid Kenyan M-Pesa number is required."
            ),
        }), 400

    if amount is None:
        return jsonify({
            "success": False,
            "message": (
                "A valid payment amount is required."
            ),
        }), 400

    if not is_whole_shilling(
        amount
    ):
        return jsonify({
            "success": False,
            "message": (
                "Payment amounts must be whole "
                "Kenya shillings."
            ),
        }), 400

    if amount < Decimal("1"):
        return jsonify({
            "success": False,
            "message": (
                "Minimum payment is KSh 1."
            ),
        }), 400

    if amount > Decimal("150000"):
        return jsonify({
            "success": False,
            "message": (
                "Maximum payment is KSh 150,000."
            ),
        }), 400

    if not validate_payment_purpose(
        purpose
    ):
        return jsonify({
            "success": False,
            "message": (
                "Invalid payment purpose."
            ),
        }), 400

    # New IntaSend payment sessions are wallet top-ups.
    # Subscription purchases remain disabled in the new
    # payment flow.
    if purpose == "subscribe":
        return jsonify({
            "success": False,
            "message": (
                "Subscription payments are not available "
                "through the new wallet payment flow."
            ),
        }), 400

    conn = database.get_connection()

    try:
        cur = conn.cursor()

        cur.execute(
            """
            SELECT
                id,
                soma_hub_code,
                name
            FROM students
            WHERE soma_hub_code = %s
            LIMIT 1
            """,
            (
                soma_hub_code,
            ),
        )

        student = cur.fetchone()

        if not student:
            conn.rollback()

            return jsonify({
                "success": False,
                "message": (
                    "Student not found."
                ),
            }), 404

        session_id = secrets.token_urlsafe(
            24
        )

        api_ref = (
            "SOMA-"
            + session_id
        )

        expires_at = (
            utc_now()
            + timedelta(minutes=30)
        )

        cur.execute(
            """
            INSERT INTO payment_sessions (
                session_id,
                student_id,
                soma_hub_code,
                amount,
                phone,
                purpose,
                status,
                merchant_request_id,
                expires_at,
                created_at
            )
            VALUES (
                %s,
                %s,
                %s,
                %s,
                %s,
                %s,
                'PENDING',
                %s,
                %s,
                %s
            )
            """,
            (
                session_id,
                student["id"],
                soma_hub_code,
                amount,
                phone,
                purpose,
                api_ref,
                expires_at,
                now_string(),
            ),
        )

        conn.commit()

    except Exception:
        conn.rollback()
        raise

    finally:
        conn.close()

    try:
        service = get_intasend_service()

        response = service.collect.mpesa_stk_push(
            phone_number=phone,
            amount=float(amount),
            narrative=(
                "SOMA HUB "
                + purpose
            ),
            currency="KES",
            api_ref=api_ref,
        )

        invoice_id = (
            extract_intasend_invoice_id(
                response
            )
        )

        returned_api_ref = (
            extract_intasend_api_ref(
                response
            )
        )

        if not invoice_id:
            raise RuntimeError(
                "IntaSend did not return an invoice ID."
            )

        if (
            returned_api_ref
            and returned_api_ref != api_ref
        ):
            raise RuntimeError(
                "IntaSend returned an unexpected API reference."
            )

        conn = database.get_connection()

        try:
            cur = conn.cursor()

            cur.execute(
                """
                UPDATE payment_sessions
                SET
                    checkout_request_id = %s,
                    merchant_request_id = %s
                WHERE session_id = %s
                """,
                (
                    invoice_id,
                    api_ref,
                    session_id,
                ),
            )

            conn.commit()

        except Exception:
            conn.rollback()
            raise

        finally:
            conn.close()

        return jsonify({
            "success": True,
            "session_id": session_id,
            "invoice_id": invoice_id,
            "checkout_request_id": invoice_id,
            "merchant_request_id": api_ref,
            "amount": float(amount),
            "phone": phone,
            "purpose": purpose,
            "status": "PENDING",
        })

    except Exception as exc:
        conn = database.get_connection()

        try:
            cur = conn.cursor()

            cur.execute(
                """
                UPDATE payment_sessions
                SET status = 'FAILED'
                WHERE session_id = %s
                """,
                (
                    session_id,
                ),
            )

            conn.commit()

        except Exception:
            conn.rollback()

        finally:
            conn.close()

        return jsonify({
            "success": False,
            "message": (
                "Could not start the M-Pesa payment."
            ),
            "error": str(exc),
        }), 502

    