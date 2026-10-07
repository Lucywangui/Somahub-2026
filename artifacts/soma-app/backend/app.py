import hmac
import os
import secrets
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation

from flask import Flask, jsonify, request, session
from flask_cors import CORS
from dotenv import load_dotenv
from werkzeug.security import check_password_hash


# ============================================================
# LOAD ENVIRONMENT FIRST
# ============================================================

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

load_dotenv(
    os.path.join(BASE_DIR, ".env"),
    override=True,
)


# ============================================================
# DATABASE / PAYMENT IMPORTS
# ============================================================

import database

from coins import (
    create_coins_blueprint,
    is_valid_purpose,
)

from intasend import APIService


# ============================================================
# ENVIRONMENT
# ============================================================

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
        "true",
    ).strip().lower()
    in {"1", "true", "yes", "on"}
)

INTASEND_WEBHOOK_CHALLENGE = os.getenv(
    "INTASEND_WEBHOOK_CHALLENGE",
    ""
).strip()

PAYMENT_REDIRECT_URL = os.getenv(
    "PAYMENT_REDIRECT_URL",
    "https://somaahub.co.ke",
).strip()

SOMA_CORS_ORIGINS = os.getenv(
    "SOMA_CORS_ORIGINS",
    "",
).strip()


# ============================================================
# FLASK APP
# ============================================================

app = Flask(__name__)

app.secret_key = os.getenv(
    "FLASK_SECRET_KEY",
    secrets.token_hex(32),
)


# IMPORTANT:
# Always allow the live SOMA HUB domains.
# Also preserve any origins supplied through the environment.
configured_origins = [
    origin.strip()
    for origin in SOMA_CORS_ORIGINS.split(",")
    if origin.strip()
]

required_production_origins = [
    "https://somaahub.co.ke",
    "https://www.somaahub.co.ke",
]

development_origins = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
]

allowed_origins = list(
    dict.fromkeys(
        required_production_origins
        + development_origins
        + configured_origins
    )
)

CORS(
    app,
    resources={
        r"/api/*": {
            "origins": allowed_origins,
            "methods": [
                "GET",
                "POST",
                "PUT",
                "PATCH",
                "DELETE",
                "OPTIONS",
            ],
            "allow_headers": [
                "Content-Type",
                "Authorization",
                "Accept",
                "X-Requested-With",
            ],
            "supports_credentials": True,
            "send_wildcard": False,
            "automatic_options": True,
        }
    },
    supports_credentials=True,
)

app.config["SESSION_COOKIE_SECURE"] = True
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "None"


# ============================================================
# TIME HELPERS
# ============================================================

def utc_now():
    return datetime.now(timezone.utc)


def now_string():
    return utc_now().isoformat()


def parse_database_datetime(value):
    """
    Convert PostgreSQL datetime/string values into
    timezone-aware UTC.
    """
    if value is None:
        return None

    if isinstance(value, datetime):
        result = value
    else:
        value = str(value).strip()

        if not value:
            return None

        try:
            result = datetime.fromisoformat(
                value.replace("Z", "+00:00")
            )
        except ValueError:
            return None

    if result.tzinfo is None:
        result = result.replace(tzinfo=timezone.utc)

    return result.astimezone(timezone.utc)


# ============================================================
# DATABASE HELPERS
# ============================================================

def get_db():
    return database.get_connection()


def is_sandbox():
    return INTASEND_TEST_ENVIRONMENT


# ============================================================
# WALLET
# ============================================================

def calculate_wallet_balance(conn_or_code, code=None):
    """
    Supports both:

        calculate_wallet_balance("SH-XXXXXX")

    and:

        calculate_wallet_balance(conn, "SH-XXXXXX")

    Wallet ledger rules:

    CREDIT:
        Positive amount adds money to the wallet.

    DEBIT:
        Negative amount subtracts money from the wallet.

    The current coins.py stores DEBIT amounts as negative
    values. The calculation below also safely handles any
    older DEBIT rows that may have been stored as positive
    values by converting those positive DEBITs into negative
    wallet effects.

    This makes the wallet balance calculation permanently
    consistent with the wallet transaction ledger.
    """

    if code is None:
        code = conn_or_code
        connection = None
        should_close = True
    else:
        connection = conn_or_code
        should_close = False

    try:
        if connection is None:
            connection = get_db()

        row = connection.execute(
            """
            SELECT
                COALESCE(
                    SUM(
                        CASE
                            WHEN transaction_type = 'CREDIT'
                                THEN amount

                            WHEN transaction_type = 'DEBIT'
                                THEN
                                    CASE
                                        WHEN amount < 0
                                            THEN amount
                                        ELSE -amount
                                    END

                            ELSE 0
                        END
                    ),
                    0
                ) AS balance
            FROM wallet_transactions
            WHERE soma_hub_code = %s
            """,
            (code,),
        ).fetchone()

        if not row:
            return 0.0

        balance = row.get("balance", 0)

        if balance is None:
            return 0.0

        return float(balance)

    finally:
        if should_close and connection is not None:
            connection.close()


# ============================================================
# PHONE NUMBER
# ============================================================

def normalize_kenyan_phone(phone):
    if phone is None:
        return None

    value = str(phone).strip()

    value = (
        value
        .replace(" ", "")
        .replace("-", "")
        .replace("(", "")
        .replace(")", "")
    )

    if value.startswith("+254"):
        value = "254" + value[4:]

    elif value.startswith("254"):
        pass

    elif value.startswith("07"):
        value = "254" + value[1:]

    elif value.startswith("01"):
        value = "254" + value[1:]

    elif value.startswith("7") and len(value) == 9:
        value = "254" + value

    elif value.startswith("1") and len(value) == 9:
        value = "254" + value

    else:
        return None

    if len(value) != 12:
        return None

    if not value.startswith("254"):
        return None

    if not value[3:].isdigit():
        return None

    return value


# ============================================================
# AMOUNT HELPERS
# ============================================================

def normalize_amount(value):
    try:
        amount = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return None

    if amount <= 0:
        return None

    return amount.quantize(Decimal("0.01"))


def amounts_match(first, second):
    first_amount = normalize_amount(first)
    second_amount = normalize_amount(second)

    if first_amount is None or second_amount is None:
        return False

    return first_amount == second_amount


# ============================================================
# PAYMENT PURPOSE NORMALIZATION
# ============================================================

def normalize_payment_purpose(value):
    """
    Normalizes wallet funding purposes.

    Missing purpose means normal wallet top-up.
    """

    if value is None:
        return "topup"

    purpose = str(value).strip()

    if not purpose:
        return "topup"

    normalized = purpose.lower()

    wallet_aliases = {
        "topup": "topup",
        "wallet_topup": "topup",
        "wallet-topup": "topup",
        "wallet topup": "topup",
        "wallet_top_up": "topup",
        "wallet-top-up": "topup",
        "wallet top up": "topup",
        "add_funds": "topup",
        "add-funds": "topup",
        "add funds": "topup",
        "addfunds": "topup",
        "fund_wallet": "topup",
        "fund-wallet": "topup",
        "fund wallet": "topup",
    }

    if normalized in wallet_aliases:
        return "topup"

    if normalized == "subscribe":
        return "subscribe"

    if normalized.startswith("unlock:"):
        return "unlock:" + purpose[len("unlock:"):].strip()

    return purpose


def validate_payment_purpose(purpose):
    """
    Validate a normalized payment purpose.

    "topup" is handled here because coins.py's validator
    intentionally supports the legacy purposes.
    """

    if purpose == "topup":
        return True

    return is_valid_purpose(purpose)


# ============================================================
# INTASEND SERVICE
# ============================================================

def get_intasend_service():
    return APIService(
        token=INTASEND_SECRET_KEY or None,
        publishable_key=INTASEND_PUBLISHABLE_KEY or None,
        test=INTASEND_TEST_ENVIRONMENT,
    )


# ============================================================
# INTASEND RESPONSE HELPERS
# ============================================================

def extract_intasend_invoice_id(response):
    if not response:
        return None

    if isinstance(response, dict):
        invoice = response.get("invoice")

        if isinstance(invoice, dict):
            value = invoice.get("invoice_id")

            if value:
                return str(value).strip()

        for key in (
            "invoice_id",
            "invoiceId",
            "invoice",
        ):
            value = response.get(key)

            if isinstance(value, str) and value.strip():
                return value.strip()

    return None


def extract_intasend_api_ref(response):
    if not response:
        return None

    if isinstance(response, dict):
        invoice = response.get("invoice")

        if isinstance(invoice, dict):
            value = invoice.get("api_ref")

            if value:
                return str(value).strip()

        for key in (
            "api_ref",
            "api_reference",
            "apiRef",
        ):
            value = response.get(key)

            if isinstance(value, str) and value.strip():
                return value.strip()

    return None


def extract_intasend_invoice(response):
    if not response:
        return {}

    if isinstance(response, dict):
        invoice = response.get("invoice")

        if isinstance(invoice, dict):
            return invoice

        return response

    return {}


# ============================================================
# STUDENT HELPERS
# ============================================================

def get_student_by_code(conn, soma_hub_code):
    return conn.execute(
        """
        SELECT *
        FROM students
        WHERE soma_hub_code = %s
        LIMIT 1
        """,
        (soma_hub_code,),
    ).fetchone()


# ============================================================
# PAYMENT PROCESSING
# ============================================================

def process_completed_payment(
    payment_session_id,
    invoice_id=None,
):
    """
    Atomically credits a completed payment.

    Important:
    - Locks the payment session.
    - Uses a PostgreSQL advisory transaction lock.
    - Checks for an existing wallet credit.
    - Never credits the same payment twice.
    """

    conn = get_db()

    try:
        payment_session = conn.execute(
            """
            SELECT *
            FROM payment_sessions
            WHERE id = %s
            FOR UPDATE
            """,
            (payment_session_id,),
        ).fetchone()

        if not payment_session:
            conn.rollback()

            return {
                "success": False,
                "error": "Payment session not found.",
            }

        payment_session = dict(payment_session)

        existing_status = (
            str(
                payment_session.get("status") or ""
            )
            .strip()
            .upper()
        )

        if existing_status == "COMPLETED":
            balance = calculate_wallet_balance(
                conn,
                payment_session["soma_hub_code"],
            )

            conn.commit()

            return {
                "success": True,
                "already_processed": True,
                "payment_session_id": payment_session_id,
                "balance": balance,
            }

        amount = normalize_amount(
            payment_session.get("amount")
        )

        if amount is None:
            conn.rollback()

            return {
                "success": False,
                "error": "Invalid payment amount.",
            }

        soma_hub_code = str(
            payment_session.get("soma_hub_code") or ""
        ).strip()

        student_id = payment_session.get("student_id")

        if not soma_hub_code or not student_id:
            conn.rollback()

            return {
                "success": False,
                "error": "Payment session has no valid student.",
            }

        reference = (
            payment_session.get("checkout_request_id")
            or invoice_id
            or payment_session.get("merchant_request_id")
            or payment_session.get("session_id")
        )

        if not reference:
            conn.rollback()

            return {
                "success": False,
                "error": "Payment has no valid reference.",
            }

        reference = str(reference).strip()

        conn.execute(
            """
            SELECT pg_advisory_xact_lock(hashtext(%s))
            """,
            (reference,),
        )

        existing_transaction = conn.execute(
            """
            SELECT
                id,
                amount,
                transaction_type,
                reference
            FROM wallet_transactions
            WHERE reference = %s
            LIMIT 1
            """,
            (reference,),
        ).fetchone()

        if existing_transaction:
            conn.execute(
                """
                UPDATE payment_sessions
                SET
                    status = 'COMPLETED',
                    completed_at = COALESCE(
                        completed_at,
                        %s
                    )
                WHERE id = %s
                """,
                (
                    now_string(),
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
                "payment_session_id": payment_session_id,
                "transaction_id": existing_transaction["id"],
                "balance": balance,
            }

        student = conn.execute(
            """
            SELECT
                id,
                soma_hub_code
            FROM students
            WHERE id = %s
              AND soma_hub_code = %s
            LIMIT 1
            """,
            (
                student_id,
                soma_hub_code,
            ),
        ).fetchone()

        if not student:
            conn.rollback()

            return {
                "success": False,
                "error": (
                    "Student associated with payment "
                    "was not found."
                ),
            }

        transaction = conn.execute(
            """
            INSERT INTO wallet_transactions (
                student_id,
                soma_hub_code,
                amount,
                transaction_type,
                reference,
                description,
                created_at
            )
            VALUES (
                %s,
                %s,
                %s,
                'CREDIT',
                %s,
                %s,
                %s
            )
            RETURNING id
            """,
            (
                student_id,
                soma_hub_code,
                amount,
                reference,
                "SOMA HUB wallet top-up",
                now_string(),
            ),
        ).fetchone()

        transaction_id = (
            transaction["id"]
            if transaction
            else None
        )

        conn.execute(
            """
            UPDATE payment_sessions
            SET
                status = 'COMPLETED',
                completed_at = %s
            WHERE id = %s
            """,
            (
                now_string(),
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
            "payment_session_id": payment_session_id,
            "transaction_id": transaction_id,
            "balance": balance,
        }

    except Exception:
        conn.rollback()
        raise

    finally:
        conn.close()


# ============================================================
# SYNC PAYMENT STATUS FROM INTASEND
# ============================================================

def sync_payment_from_intasend(payment_session):
    if not payment_session:
        return {
            "success": False,
            "error": "Payment session not found.",
        }

    invoice_id = payment_session.get(
        "checkout_request_id"
    )

    if not invoice_id:
        return {
            "success": False,
            "error": "Payment has no IntaSend invoice ID.",
        }

    service = get_intasend_service()

    response = service.collect.status(
        invoice_id=invoice_id
    )

    invoice = extract_intasend_invoice(response)

    state = str(
        invoice.get("state")
        or response.get("state", "")
        or ""
    ).strip().upper()

    returned_invoice_id = (
        invoice.get("invoice_id")
        or response.get("invoice_id")
    )

    returned_api_ref = (
        invoice.get("api_ref")
        or response.get("api_ref")
        or response.get("api_reference")
    )

    expected_api_ref = payment_session.get(
        "merchant_request_id"
    )

    if (
        returned_invoice_id
        and str(returned_invoice_id).strip()
        != str(invoice_id).strip()
    ):
        return {
            "success": False,
            "error": "IntaSend invoice mismatch.",
        }

    if (
        expected_api_ref
        and returned_api_ref
        and str(returned_api_ref).strip()
        != str(expected_api_ref).strip()
    ):
        return {
            "success": False,
            "error": "IntaSend payment reference mismatch.",
        }

    returned_amount = (
        invoice.get("value")
        or invoice.get("amount")
        or response.get("value")
        or response.get("amount")
    )

    if returned_amount is not None:
        if not amounts_match(
            returned_amount,
            payment_session.get("amount"),
        ):
            return {
                "success": False,
                "error": "IntaSend payment amount mismatch.",
            }

    if state == "COMPLETE":
        result = process_completed_payment(
            payment_session["id"],
            invoice_id=invoice_id,
        )

        if result.get("success"):
            result["state"] = "COMPLETE"

        return result

    if state == "FAILED":
        conn = get_db()

        try:
            conn.execute(
                """
                UPDATE payment_sessions
                SET status = 'FAILED'
                WHERE id = %s
                  AND status <> 'COMPLETED'
                """,
                (payment_session["id"],),
            )

            conn.commit()

        finally:
            conn.close()

        return {
            "success": True,
            "state": "FAILED",
            "status": "FAILED",
        }

    return {
        "success": True,
        "state": state or "PENDING",
        "status": state or "PENDING",
    }


# ============================================================
# BASIC ROUTES
# ============================================================

@app.get("/")
def home():
    return jsonify({
        "message": "SOMA HUB Flask backend is running",
        "success": True,
    })


@app.get("/api/test")
def api_test():
    return jsonify({
        "success": True,
        "message": "SOMA HUB API is working",
    })


@app.get("/api/intasend-config-test")
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
        "test_environment": INTASEND_TEST_ENVIRONMENT,
        "redirect_url": PAYMENT_REDIRECT_URL,
    })


# ============================================================
# STUDENT REGISTRATION
# ============================================================

@app.post("/api/students/register")
def register_student():
    data = request.get_json(silent=True) or {}

    soma_hub_code = str(
        data.get("somaHubCode")
        or data.get("soma_hub_code")
        or ""
    ).strip()

    name = str(
        data.get("name")
        or ""
    ).strip()

    grade = str(
        data.get("grade")
        or ""
    ).strip()

    school_name = str(
        data.get("schoolName")
        or data.get("school_name")
        or data.get("school")
        or ""
    ).strip()

    if not soma_hub_code:
        return jsonify({
            "success": False,
            "error": "SOMA HUB code is required.",
        }), 400

    if not name:
        return jsonify({
            "success": False,
            "error": "Student name is required.",
        }), 400

    conn = get_db()

    try:
        existing = get_student_by_code(
            conn,
            soma_hub_code,
        )

        if existing:
            student_id = existing["id"]

            conn.execute(
                """
                UPDATE students
                SET
                    name = %s,
                    school_name = %s,
                    school = %s,
                    grade = %s,
                    updated_at = %s
                WHERE id = %s
                """,
                (
                    name,
                    school_name,
                    school_name,
                    grade,
                    now_string(),
                    student_id,
                ),
            )

        else:
            row = conn.execute(
                """
                INSERT INTO students (
                    soma_hub_code,
                    name,
                    school_name,
                    school,
                    grade,
                    created_at,
                    updated_at
                )
                VALUES (
                    %s,
                    %s,
                    %s,
                    %s,
                    %s,
                    %s,
                    %s
                )
                RETURNING id
                """,
                (
                    soma_hub_code,
                    name,
                    school_name,
                    school_name,
                    grade,
                    now_string(),
                    now_string(),
                ),
            ).fetchone()

            student_id = row["id"]

        conn.commit()

        return jsonify({
            "success": True,
            "student": {
                "id": student_id,
                "somaHubCode": soma_hub_code,
                "name": name,
                "schoolName": school_name,
                "grade": grade,
            },
        })

    except Exception:
        conn.rollback()
        raise

    finally:
        conn.close()


# ============================================================
# STUDENT PERFORMANCE
# ============================================================

@app.post("/api/students/performance")
def save_student_performance():
    data = request.get_json(silent=True) or {}

    soma_hub_code = str(
        data.get("somaHubCode")
        or data.get("soma_hub_code")
        or ""
    ).strip()

    term_points = data.get("termPoints") or []
    quiz_results = data.get("quizResults") or []

    if not soma_hub_code:
        return jsonify({
            "success": False,
            "error": "SOMA HUB code is required.",
        }), 400

    if not isinstance(term_points, list):
        return jsonify({
            "success": False,
            "error": "termPoints must be an array.",
        }), 400

    if not isinstance(quiz_results, list):
        return jsonify({
            "success": False,
            "error": "quizResults must be an array.",
        }), 400

    conn = get_db()

    try:
        student = get_student_by_code(
            conn,
            soma_hub_code,
        )

        if not student:
            return jsonify({
                "success": False,
                "error": "Student not found.",
            }), 404

        student_id = student["id"]

        for item in term_points:
            if not isinstance(item, dict):
                continue

            term_key = str(
                item.get("termKey")
                or item.get("term_key")
                or ""
            ).strip()

            if not term_key:
                continue

            study_notes = min(
                max(
                    float(
                        item.get("studyNotes")
                        or item.get("study_notes_points")
                        or 0
                    ),
                    0,
                ),
                20,
            )

            topical_quizzes = min(
                max(
                    float(
                        item.get("topicalQuizzes")
                        or item.get("topical_quiz_points")
                        or 0
                    ),
                    0,
                ),
                25,
            )

            exams = min(
                max(
                    float(
                        item.get("exams")
                        or item.get("exam_points")
                        or 0
                    ),
                    0,
                ),
                25,
            )

            consistency = min(
                max(
                    float(
                        item.get("consistency")
                        or item.get("consistency_points")
                        or 0
                    ),
                    0,
                ),
                15,
            )

            improvement = min(
                max(
                    float(
                        item.get("progress")
                        or item.get("improvement")
                        or item.get("improvement_points")
                        or 0
                    ),
                    0,
                ),
                15,
            )

            total = min(
                study_notes
                + topical_quizzes
                + exams
                + consistency
                + improvement,
                100,
            )

            conn.execute(
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
                ON CONFLICT (
                    student_id,
                    term_key
                )
                DO UPDATE SET
                    study_notes_points =
                        EXCLUDED.study_notes_points,
                    topical_quiz_points =
                        EXCLUDED.topical_quiz_points,
                    exam_points =
                        EXCLUDED.exam_points,
                    consistency_points =
                        EXCLUDED.consistency_points,
                    improvement_points =
                        EXCLUDED.improvement_points,
                    total_points =
                        EXCLUDED.total_points
                """,
                (
                    student_id,
                    term_key,
                    study_notes,
                    topical_quizzes,
                    exams,
                    consistency,
                    improvement,
                    total,
                ),
            )

        for item in quiz_results:
            if not isinstance(item, dict):
                continue

            material_id = str(
                item.get("materialId")
                or item.get("material_id")
                or ""
            ).strip()

            if not material_id:
                continue

            material_title = str(
                item.get("materialTitle")
                or item.get("material_title")
                or ""
            ).strip()

            subject = str(
                item.get("subject")
                or ""
            ).strip()

            grade_key = str(
                item.get("gradeKey")
                or item.get("grade_key")
                or ""
            ).strip()

            quiz_type = str(
                item.get("quizType")
                or item.get("quiz_type")
                or "TOPICAL"
            ).strip()

            score = float(
                item.get("score") or 0
            )

            total = float(
                item.get("total") or 0
            )

            percentage = float(
                item.get("percentage")
                or (
                    (score / total * 100)
                    if total > 0
                    else 0
                )
            )

            completed_at = (
                item.get("completedAt")
                or item.get("completed_at")
                or now_string()
            )

            duplicate = conn.execute(
                """
                SELECT id
                FROM quiz_results
                WHERE student_id = %s
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
            ).fetchone()

            if duplicate:
                continue

            conn.execute(
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

        saved_terms = conn.execute(
            """
            SELECT *
            FROM term_points
            WHERE student_id = %s
            ORDER BY term_key
            """,
            (student_id,),
        ).fetchall()

        saved_quizzes = conn.execute(
            """
            SELECT *
            FROM quiz_results
            WHERE student_id = %s
            ORDER BY completed_at DESC
            """,
            (student_id,),
        ).fetchall()

        return jsonify({
            "success": True,
            "termPoints": [
                dict(row)
                for row in saved_terms
            ],
            "quizResults": [
                dict(row)
                for row in saved_quizzes
            ],
        })

    except Exception:
        conn.rollback()
        raise

    finally:
        conn.close()


# ============================================================
# GET STUDENT PERFORMANCE
# ============================================================

@app.get(
    "/api/students/performance/<soma_hub_code>"
)
def get_student_performance(soma_hub_code):
    soma_hub_code = str(
        soma_hub_code
    ).strip()

    conn = get_db()

    try:
        student = get_student_by_code(
            conn,
            soma_hub_code,
        )

        if not student:
            return jsonify({
                "success": False,
                "error": "Student not found.",
            }), 404

        student_id = student["id"]

        terms = conn.execute(
            """
            SELECT *
            FROM term_points
            WHERE student_id = %s
            ORDER BY term_key
            """,
            (student_id,),
        ).fetchall()

        quizzes = conn.execute(
            """
            SELECT *
            FROM quiz_results
            WHERE student_id = %s
            ORDER BY completed_at DESC
            """,
            (student_id,),
        ).fetchall()

        return jsonify({
            "success": True,
            "student": dict(student),
            "termPoints": [
                dict(row)
                for row in terms
            ],
            "quizResults": [
                dict(row)
                for row in quizzes
            ],
        })

    finally:
        conn.close()


# ============================================================
# ADMIN LOGIN
# ============================================================

@app.post("/api/admin/login")
def admin_login():
    data = request.get_json(silent=True) or {}

    username = str(
        data.get("username")
        or ""
    ).strip()

    password = str(
        data.get("password")
        or ""
    )

    if not username or not password:
        return jsonify({
            "success": False,
            "error": (
                "Username and password are required."
            ),
        }), 400

    conn = get_db()

    try:
        admin = conn.execute(
            """
            SELECT *
            FROM admins
            WHERE username = %s
            LIMIT 1
            """,
            (username,),
        ).fetchone()

        if not admin:
            return jsonify({
                "success": False,
                "error": "Invalid credentials.",
            }), 401

        if not check_password_hash(
            admin["password_hash"],
            password,
        ):
            return jsonify({
                "success": False,
                "error": "Invalid credentials.",
            }), 401

        session["admin_id"] = admin["id"]
        session["admin_username"] = admin["username"]

        return jsonify({
            "success": True,
            "admin": {
                "id": admin["id"],
                "username": admin["username"],
            },
        })

    finally:
        conn.close()


@app.get("/api/admin/me")
def admin_me():
    admin_id = session.get("admin_id")

    if not admin_id:
        return jsonify({
            "success": False,
            "authenticated": False,
        }), 401

    return jsonify({
        "success": True,
        "authenticated": True,
        "admin": {
            "id": admin_id,
            "username": session.get(
                "admin_username"
            ),
        },
    })


@app.post("/api/admin/logout")
def admin_logout():
    session.clear()

    return jsonify({
        "success": True,
        "message": "Logged out successfully.",
    })


# ============================================================
# ADMIN STUDENT LOOKUP
# ============================================================

@app.get(
    "/api/admin/students/<soma_hub_code>"
)
def admin_student_lookup(soma_hub_code):
    if not session.get("admin_id"):
        return jsonify({
            "success": False,
            "error": "Admin authentication required.",
        }), 401

    soma_hub_code = str(
        soma_hub_code
    ).strip()

    conn = get_db()

    try:
        student = get_student_by_code(
            conn,
            soma_hub_code,
        )

        if not student:
            return jsonify({
                "success": False,
                "error": "Student not found.",
            }), 404

        student_id = student["id"]

        terms = conn.execute(
            """
            SELECT *
            FROM term_points
            WHERE student_id = %s
            ORDER BY term_key
            """,
            (student_id,),
        ).fetchall()

        quizzes = conn.execute(
            """
            SELECT *
            FROM quiz_results
            WHERE student_id = %s
            ORDER BY completed_at DESC
            """,
            (student_id,),
        ).fetchall()

        return jsonify({
            "success": True,
            "student": dict(student),
            "termPoints": [
                dict(row)
                for row in terms
            ],
            "quizResults": [
                dict(row)
                for row in quizzes
            ],
        })

    finally:
        conn.close()


# ============================================================
# ADMIN TOP STUDENTS
# ============================================================

@app.get("/api/admin/top-students")
def admin_top_students():
    if not session.get("admin_id"):
        return jsonify({
            "success": False,
            "error": "Admin authentication required.",
        }), 401

    conn = get_db()

    try:
        rows = conn.execute(
            """
            SELECT
                s.id,
                s.soma_hub_code,
                s.name,
                s.school_name,
                s.school,
                s.grade,
                COALESCE(
                    SUM(tp.total_points),
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
            LIMIT 100
            """
        ).fetchall()

        return jsonify({
            "success": True,
            "students": [
                dict(row)
                for row in rows
            ],
        })

    finally:
        conn.close()


# ============================================================
# CREATE INTASEND PAYMENT SESSION
# ============================================================

@app.post(
    "/api/intasend/payment-session"
)
def create_payment_session():
    data = request.get_json(
        silent=True
    ) or {}

    soma_hub_code = str(
        data.get("somaHubCode")
        or data.get("soma_hub_code")
        or ""
    ).strip()

    raw_purpose = data.get("purpose")

    purpose = normalize_payment_purpose(
        raw_purpose
    )

    raw_amount = data.get("amount")

    # IMPORTANT:
    # payments.ts sends "phone_number".
    # Keep support for the older field names too.
    phone = normalize_kenyan_phone(
        data.get("phone_number")
        or data.get("phoneNumber")
        or data.get("phone")
    )

    if not soma_hub_code:
        return jsonify({
            "success": False,
            "error": "SOMA HUB code is required.",
            "field": "somaHubCode",
        }), 400

    if not validate_payment_purpose(purpose):
        app.logger.warning(
            "Rejected payment session with invalid purpose: %s",
            purpose,
        )

        return jsonify({
            "success": False,
            "error": "Invalid payment purpose.",
            "field": "purpose",
        }), 400

    if purpose == "subscribe":
        app.logger.warning(
            "Rejected subscription payment session for %s.",
            soma_hub_code,
        )

        return jsonify({
            "success": False,
            "error": (
                "Subscription payments are not available "
                "through this payment flow."
            ),
            "field": "purpose",
        }), 400

    amount = normalize_amount(
        raw_amount
    )

    if amount is None:
        return jsonify({
            "success": False,
            "error": "Invalid payment amount.",
            "field": "amount",
        }), 400

    if (
        amount < Decimal("1")
        or amount > Decimal("150000")
    ):
        return jsonify({
            "success": False,
            "error": (
                "Payment amount must be between "
                "KSh 1 and KSh 150,000."
            ),
            "field": "amount",
        }), 400

    if not phone:
        return jsonify({
            "success": False,
            "error": (
                "Enter a valid Kenyan M-Pesa "
                "phone number."
            ),
            "field": "phone",
        }), 400

    conn = get_db()

    payment_session_id = None
    session_id = None

    try:
        student = get_student_by_code(
            conn,
            soma_hub_code,
        )

        if not student:
            return jsonify({
                "success": False,
                "error": "Student not found.",
                "field": "somaHubCode",
            }), 404

        session_id = secrets.token_urlsafe(24)

        api_ref = f"SOMA-{session_id}"

        expires_at = (
            utc_now()
            + timedelta(minutes=30)
        )

        row = conn.execute(
            """
            INSERT INTO payment_sessions (
                session_id,
                student_id,
                soma_hub_code,
                amount,
                status,
                phone_number,
                created_at,
                expires_at,
                purpose
            )
            VALUES (
                %s,
                %s,
                %s,
                %s,
                'PENDING',
                %s,
                %s,
                %s,
                %s
            )
            RETURNING id
            """,
            (
                session_id,
                student["id"],
                soma_hub_code,
                amount,
                phone,
                now_string(),
                expires_at.isoformat(),
                purpose,
            ),
        ).fetchone()

        payment_session_id = row["id"]

        conn.commit()

    except Exception:
        conn.rollback()
        raise

    finally:
        conn.close()

    # --------------------------------------------------------
    # INITIATE INTASEND M-PESA STK PUSH
    # --------------------------------------------------------

    try:
        service = get_intasend_service()

        response = service.collect.mpesa_stk_push(
            phone_number=phone,
            amount=float(amount),
            narrative=f"SOMA HUB {purpose}",
            currency="KES",
            api_ref=api_ref,
        )

        invoice_id = extract_intasend_invoice_id(
            response
        )

        returned_api_ref = extract_intasend_api_ref(
            response
        )

        if not invoice_id:
            raise RuntimeError(
                "IntaSend did not return an invoice ID."
            )

        if (
            returned_api_ref
            and str(returned_api_ref).strip()
            != api_ref
        ):
            raise RuntimeError(
                "IntaSend returned an unexpected "
                "payment reference."
            )

        conn = get_db()

        try:
            conn.execute(
                """
                UPDATE payment_sessions
                SET
                    checkout_request_id = %s,
                    merchant_request_id = %s
                WHERE id = %s
                """,
                (
                    invoice_id,
                    api_ref,
                    payment_session_id,
                ),
            )

            conn.commit()

        finally:
            conn.close()

        return jsonify({
            "success": True,
            "session_id": session_id,
            "sessionId": session_id,
            "payment_session_id": payment_session_id,
            "paymentSessionId": payment_session_id,
            "invoice_id": invoice_id,
            "invoiceId": invoice_id,
            "amount": float(amount),
            "phone": phone,
            "purpose": purpose,
            "payment_url": None,
            "status": "pending",
        })

    except Exception as exc:
        conn = get_db()

        try:
            conn.execute(
                """
                UPDATE payment_sessions
                SET status = 'FAILED'
                WHERE id = %s
                """,
                (payment_session_id,),
            )

            conn.commit()

        finally:
            conn.close()

        app.logger.exception(
            "IntaSend payment initiation failed."
        )

        return jsonify({
            "success": False,
            "error": str(exc),
        }), 502


# ============================================================
# INTASEND WEBHOOK
# ============================================================

@app.post("/api/intasend/webhook")
def intasend_webhook():
    payload = request.get_json(
        silent=True
    ) or {}

    supplied_challenge = str(
        payload.get("challenge")
        or request.args.get("challenge")
        or ""
    ).strip()

    expected_challenge = (
        INTASEND_WEBHOOK_CHALLENGE
    )

    if not expected_challenge:
        app.logger.error(
            "INTASEND_WEBHOOK_CHALLENGE "
            "is not configured."
        )

        return jsonify({
            "success": False,
            "error": "Webhook is not configured.",
        }), 503

    if not supplied_challenge:
        return jsonify({
            "success": False,
            "error": "Webhook challenge missing.",
        }), 403

    if not hmac.compare_digest(
        supplied_challenge,
        expected_challenge,
    ):
        app.logger.warning(
            "Rejected IntaSend webhook with "
            "invalid challenge."
        )

        return jsonify({
            "success": False,
            "error": "Invalid webhook challenge.",
        }), 403

    invoice_id = str(
        payload.get("invoice_id")
        or ""
    ).strip()

    api_ref = str(
        payload.get("api_ref")
        or payload.get("api_reference")
        or ""
    ).strip()

    state = str(
        payload.get("state")
        or ""
    ).strip().upper()

    if not invoice_id and not api_ref:
        return jsonify({
            "success": False,
            "error": "Missing payment reference.",
        }), 400

    conn = get_db()

    try:
        payment_session = None

        if invoice_id and api_ref:
            payment_session = conn.execute(
                """
                SELECT *
                FROM payment_sessions
                WHERE checkout_request_id = %s
                  AND merchant_request_id = %s
                LIMIT 1
                """,
                (
                    invoice_id,
                    api_ref,
                ),
            ).fetchone()

            if not payment_session:
                invoice_match = conn.execute(
                    """
                    SELECT *
                    FROM payment_sessions
                    WHERE checkout_request_id = %s
                    LIMIT 1
                    """,
                    (invoice_id,),
                ).fetchone()

                if invoice_match:
                    conn.rollback()

                    app.logger.warning(
                        "Rejected webhook: api_ref mismatch "
                        "for invoice %s",
                        invoice_id,
                    )

                    return jsonify({
                        "success": False,
                        "error": (
                            "Payment reference mismatch."
                        ),
                    }), 403

        elif invoice_id:
            payment_session = conn.execute(
                """
                SELECT *
                FROM payment_sessions
                WHERE checkout_request_id = %s
                LIMIT 1
                """,
                (invoice_id,),
            ).fetchone()

        elif api_ref:
            payment_session = conn.execute(
                """
                SELECT *
                FROM payment_sessions
                WHERE merchant_request_id = %s
                LIMIT 1
                """,
                (api_ref,),
            ).fetchone()

        if not payment_session:
            conn.rollback()

            app.logger.warning(
                "Received IntaSend webhook for "
                "unknown payment. invoice_id=%s "
                "api_ref=%s state=%s",
                invoice_id,
                api_ref,
                state,
            )

            return jsonify({
                "success": True,
                "processed": False,
                "message": (
                    "Payment session not found."
                ),
            })

        payment_session = dict(
            payment_session
        )

        stored_invoice = str(
            payment_session.get(
                "checkout_request_id"
            )
            or ""
        ).strip()

        stored_api_ref = str(
            payment_session.get(
                "merchant_request_id"
            )
            or ""
        ).strip()

        if (
            invoice_id
            and stored_invoice
            and invoice_id != stored_invoice
        ):
            conn.rollback()

            return jsonify({
                "success": False,
                "error": (
                    "Invoice ownership mismatch."
                ),
            }), 403

        if (
            api_ref
            and stored_api_ref
            and api_ref != stored_api_ref
        ):
            conn.rollback()

            return jsonify({
                "success": False,
                "error": (
                    "API reference ownership mismatch."
                ),
            }), 403

        webhook_amount = (
            payload.get("value")
            if payload.get("value") is not None
            else payload.get("amount")
        )

        if webhook_amount is not None:
            if not amounts_match(
                webhook_amount,
                payment_session.get("amount"),
            ):
                conn.rollback()

                app.logger.warning(
                    "Rejected webhook: amount mismatch "
                    "for payment session %s",
                    payment_session["id"],
                )

                return jsonify({
                    "success": False,
                    "error": (
                        "Payment amount mismatch."
                    ),
                }), 403

        conn.rollback()

    finally:
        conn.close()

    if state == "COMPLETE":
        result = process_completed_payment(
            payment_session["id"],
            invoice_id=(
                invoice_id
                or payment_session.get(
                    "checkout_request_id"
                )
            ),
        )

        if not result.get("success"):
            return jsonify(result), 500

        try:
            fulfil_result = (
                coins_bp.fulfil_payment_purpose(
                    payment_session["session_id"]
                )
            )

        except Exception:
            app.logger.exception(
                "Wallet credit succeeded but "
                "payment purpose fulfilment failed "
                "for session %s",
                payment_session["session_id"],
            )

            return jsonify({
                "success": False,
                "paymentCredited": True,
                "fulfilment": False,
                "error": (
                    "Payment credited but fulfilment "
                    "failed."
                ),
            }), 500

        return jsonify({
            "success": True,
            "processed": True,
            "alreadyProcessed": result.get(
                "already_processed",
                False,
            ),
            "payment_session_id": payment_session["id"],
            "paymentSessionId": payment_session["id"],
            "session_id": payment_session["session_id"],
            "sessionId": payment_session["session_id"],
            "wallet_balance": result.get("balance"),
            "balance": result.get("balance"),
            "fulfilment": fulfil_result,
            "state": "COMPLETE",
        })

    if state == "FAILED":
        conn = get_db()

        try:
            conn.execute(
                """
                UPDATE payment_sessions
                SET status = 'FAILED'
                WHERE id = %s
                  AND status <> 'COMPLETED'
                """,
                (payment_session["id"],),
            )

            conn.commit()

        finally:
            conn.close()

        return jsonify({
            "success": True,
            "processed": True,
            "state": "FAILED",
        })

    return jsonify({
        "success": True,
        "processed": False,
        "state": state or "PENDING",
    })


# ============================================================
# PAYMENT STATUS
# ============================================================

@app.get(
    "/api/intasend/payment-status/<session_id>"
)
def payment_status(session_id):
    session_id = str(
        session_id
    ).strip()

    conn = get_db()

    try:
        payment_session = conn.execute(
            """
            SELECT *
            FROM payment_sessions
            WHERE session_id = %s
            LIMIT 1
            """,
            (session_id,),
        ).fetchone()

    finally:
        conn.close()

    if not payment_session:
        return jsonify({
            "success": False,
            "error": "Payment session not found.",
        }), 404

    payment_session = dict(
        payment_session
    )

    if (
        str(
            payment_session.get("status") or ""
        ).upper()
        == "PENDING"
    ):
        expires_at = parse_database_datetime(
            payment_session.get("expires_at")
        )

        if (
            expires_at
            and utc_now() > expires_at
        ):
            conn = get_db()

            try:
                conn.execute(
                    """
                    UPDATE payment_sessions
                    SET status = 'EXPIRED'
                    WHERE id = %s
                      AND status = 'PENDING'
                    """,
                    (payment_session["id"],),
                )

                conn.commit()

            finally:
                conn.close()

            payment_session["status"] = "EXPIRED"

    local_status = str(
        payment_session.get("status") or ""
    ).upper()

    if local_status in {
        "FAILED",
        "EXPIRED",
    }:
        balance = calculate_wallet_balance(
            payment_session["soma_hub_code"]
        )

        frontend_status = (
            "failed"
            if local_status == "FAILED"
            else "expired"
        )

        return jsonify({
            "success": True,
            "session_id": session_id,
            "status": frontend_status,
            "wallet_balance": balance,
            "purpose_result": None,
            "sessionId": session_id,
            "balance": balance,
        })

    # ========================================================
    # IMPORTANT FIX:
    #
    # A webhook can complete the payment before the frontend
    # polls payment-status.
    #
    # In that case the payment session is already COMPLETED.
    # We MUST still run the existing idempotent fulfilment
    # function so the frontend receives the actual purpose
    # result instead of purpose_result: null.
    #
    # This does NOT double-charge the wallet because
    # coins.py already protects the fulfilment operation.
    # ========================================================

    if local_status == "COMPLETED":
        try:
            fulfil_result = (
                coins_bp.fulfil_payment_purpose(
                    payment_session["session_id"]
                )
            )

        except Exception:
            app.logger.exception(
                "Payment already completed but "
                "purpose fulfilment failed for session %s",
                payment_session["session_id"],
            )

            return jsonify({
                "success": False,
                "paymentCredited": True,
                "error": (
                    "Payment was completed, but the "
                    "requested material could not be "
                    "confirmed."
                ),
            }), 500

        balance = calculate_wallet_balance(
            payment_session["soma_hub_code"]
        )

        return jsonify({
            "success": True,
            "session_id": session_id,
            "status": "completed",
            "wallet_balance": balance,
            "purpose_result": fulfil_result,
            "sessionId": session_id,
            "balance": balance,
            "fulfilment": fulfil_result,
        })

    try:
        result = sync_payment_from_intasend(
            payment_session
        )

    except Exception:
        app.logger.exception(
            "Failed to check IntaSend payment status."
        )

        return jsonify({
            "success": False,
            "error": (
                "Unable to check payment status."
            ),
        }), 502

    if not result.get("success"):
        return jsonify(result), 502

    if result.get("state") == "COMPLETE":
        conn = get_db()

        try:
            latest_session = conn.execute(
                """
                SELECT *
                FROM payment_sessions
                WHERE id = %s
                LIMIT 1
                """,
                (payment_session["id"],),
            ).fetchone()

        finally:
            conn.close()

        latest_session = dict(
            latest_session
            or payment_session
        )

        try:
            fulfil_result = (
                coins_bp.fulfil_payment_purpose(
                    latest_session["session_id"]
                )
            )

        except Exception:
            app.logger.exception(
                "Payment completed but fulfilment "
                "failed for session %s",
                latest_session["session_id"],
            )

            return jsonify({
                "success": False,
                "paymentCredited": True,
                "error": (
                    "Payment credited but fulfilment "
                    "failed."
                ),
            }), 500

        balance = calculate_wallet_balance(
            latest_session["soma_hub_code"]
        )

        return jsonify({
            "success": True,
            "session_id": session_id,
            "status": "completed",
            "wallet_balance": balance,
            "purpose_result": fulfil_result,
            "sessionId": session_id,
            "balance": balance,
            "fulfilment": fulfil_result,
        })

    if str(
        result.get("state") or ""
    ).upper() == "FAILED":
        balance = calculate_wallet_balance(
            payment_session["soma_hub_code"]
        )

        return jsonify({
            "success": True,
            "session_id": session_id,
            "status": "failed",
            "wallet_balance": balance,
            "purpose_result": None,
            "sessionId": session_id,
            "balance": balance,
        })

    balance = calculate_wallet_balance(
        payment_session["soma_hub_code"]
    )

    return jsonify({
        "success": True,
        "session_id": session_id,
        "status": "pending",
        "wallet_balance": balance,
        "purpose_result": None,
        "sessionId": session_id,
        "balance": balance,
    })


# ============================================================
# WALLET BALANCE
# ============================================================

@app.get(
    "/api/wallet/<soma_hub_code>"
)
def wallet_balance(soma_hub_code):
    soma_hub_code = str(
        soma_hub_code
    ).strip()

    balance = calculate_wallet_balance(
        soma_hub_code
    )

    return jsonify({
        "success": True,
        "balance": balance,
        "coins": balance,
        "ksh": balance,
    })


# ============================================================
# DEV TEST PAYMENT
# ============================================================

@app.post(
    "/api/dev/test-payment/<session_id>"
)
def dev_test_payment(session_id):
    if not is_sandbox():
        return jsonify({
            "success": False,
            "error": (
                "Test payment endpoint is "
                "disabled in live mode."
            ),
        }), 403

    session_id = str(
        session_id
    ).strip()

    conn = get_db()

    try:
        payment_session = conn.execute(
            """
            SELECT *
            FROM payment_sessions
            WHERE session_id = %s
            LIMIT 1
            """,
            (session_id,),
        ).fetchone()

    finally:
        conn.close()

    if not payment_session:
        return jsonify({
            "success": False,
            "error": "Payment session not found.",
        }), 404

    payment_session = dict(payment_session)

    result = process_completed_payment(
        payment_session["id"],
        invoice_id=payment_session.get(
            "checkout_request_id"
        ),
    )

    if not result.get("success"):
        return jsonify(result), 500

    try:
        fulfil_result = (
            coins_bp.fulfil_payment_purpose(
                payment_session["session_id"]
            )
        )

    except Exception:
        app.logger.exception(
            "Test payment credited but "
            "fulfilment failed."
        )

        return jsonify({
            "success": False,
            "paymentCredited": True,
            "error": (
                "Payment credited but fulfilment "
                "failed."
            ),
        }), 500

    return jsonify({
        "success": True,
        "payment": result,
        "fulfilment": fulfil_result,
    })


# ============================================================
# COINS / MATERIALS BLUEPRINT
# ============================================================

coins_bp = create_coins_blueprint(
    get_db,
    now_string,
    calculate_wallet_balance,
    is_sandbox,
)

app.register_blueprint(
    coins_bp
)


# ============================================================
# DATABASE INITIALIZATION
# ============================================================

try:
    database.init_db()
except Exception:
    app.logger.exception(
        "Database initialization failed."
    )


# ============================================================
# RUN SERVER
# ============================================================

if __name__ == "__main__":
    port = int(
        os.getenv(
            "PORT",
            "5000",
        )
    )

    app.run(
        host="0.0.0.0",
        port=port,
    )