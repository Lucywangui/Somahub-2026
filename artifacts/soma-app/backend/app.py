import os
import secrets
from datetime import datetime, timedelta, timezone

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
    "http://localhost:5173,http://127.0.0.1:5173"
).strip()


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

        # Try common PostgreSQL timestamp formats.
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
    """
    Compatibility wrapper used by coins.py.
    """
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
    """
    Extract an IntaSend invoice ID.

    Direct M-Pesa STK Push responses should provide
    an invoice ID which is then used for payment
    status verification.
    """

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
    """
    Extract an IntaSend API reference when supplied.
    """

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
# STUDENT LOOKUP
# ============================================================

def get_student_by_code(soma_hub_code):
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
# PAYMENT COMPLETION
# ============================================================

def process_completed_payment(
    payment_session_id,
    invoice_id=None,
):
    """
    Credit the student's paid SOMA Points wallet exactly once.

    payment_session_id is the INTEGER primary-key ID from
    payment_sessions.
    """

    with database.get_connection() as conn:
        with conn.cursor() as cur:

            cur.execute(
                """
                SELECT *
                FROM payment_sessions
                WHERE id = %s
                FOR UPDATE
                """,
                (payment_session_id,),
            )

            payment_session = cur.fetchone()

            if not payment_session:
                return {
                    "success": False,
                    "message": "Payment session not found."
                }

            if str(
                payment_session["status"]
            ).lower() == "completed":
                return {
                    "success": True,
                    "already_processed": True,
                    "message": "Payment already processed."
                }

            amount = int(
                payment_session["amount"]
            )

            student_id = int(
                payment_session["student_id"]
            )

            soma_hub_code = (
                payment_session["soma_hub_code"]
            )

            reference = (
                payment_session["checkout_request_id"]
                or invoice_id
                or payment_session["merchant_request_id"]
                or payment_session["session_id"]
            )

            cur.execute(
                """
                SELECT id
                FROM wallet_transactions
                WHERE reference = %s
                LIMIT 1
                """,
                (reference,),
            )

            existing_transaction = cur.fetchone()

            if existing_transaction:
                cur.execute(
                    """
                    UPDATE payment_sessions
                    SET
                        status = 'completed',
                        completed_at = CURRENT_TIMESTAMP
                    WHERE id = %s
                    """,
                    (payment_session_id,),
                )

                conn.commit()

                return {
                    "success": True,
                    "already_processed": True,
                    "message": "Payment was already credited."
                }

            cur.execute(
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
                    CURRENT_TIMESTAMP
                )
                """,
                (
                    student_id,
                    soma_hub_code,
                    amount,
                    reference,
                    "IntaSend wallet top-up",
                ),
            )

            cur.execute(
                """
                UPDATE payment_sessions
                SET
                    status = 'completed',
                    completed_at = CURRENT_TIMESTAMP
                WHERE id = %s
                """,
                (payment_session_id,),
            )

            conn.commit()

    return {
        "success": True,
        "already_processed": False,
        "message": "Wallet credited successfully."
    }


# ============================================================
# INTASEND STATUS SYNC
# ============================================================

def sync_payment_from_intasend(
    payment_session
):
    """
    Ask IntaSend for the latest payment status.

    Direct STK Push stores the IntaSend invoice ID in
    checkout_request_id for compatibility with the existing
    payment-session schema.
    """

    invoice_id = (
        payment_session.get(
            "checkout_request_id"
        )
    )

    if not invoice_id:
        return {
            "success": True,
            "state": "PENDING",
            "message": (
                "Waiting for IntaSend payment confirmation."
            )
        }

    try:
        service = get_intasend_service()

        response = service.collect.status(
            invoice_id=invoice_id
        )

        invoice = extract_intasend_invoice(
            response
        )

        state = None

        if isinstance(invoice, dict):
            state = (
                invoice.get("state")
                or invoice.get("status")
            )

        if not state and isinstance(
            response,
            dict
        ):
            state = (
                response.get("state")
                or response.get("status")
            )

        state = str(
            state or ""
        ).upper()

        if state == "COMPLETE":
            result = process_completed_payment(
                payment_session["id"],
                invoice_id=invoice_id,
            )

            return {
                "success": True,
                "state": "COMPLETE",
                "message": "Payment completed.",
                "processed": result.get(
                    "success",
                    False
                ),
            }

        if state == "FAILED":
            with database.get_connection() as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        UPDATE payment_sessions
                        SET status = 'failed'
                        WHERE id = %s
                        """,
                        (
                            payment_session["id"],
                        ),
                    )

                    conn.commit()

            return {
                "success": False,
                "state": "FAILED",
                "message": "Payment failed."
            }

        return {
            "success": True,
            "state": state or "PENDING",
            "message": "Payment is still pending."
        }

    except Exception as exc:
        app.logger.exception(
            "IntaSend status check failed: %s",
            exc
        )

        return {
            "success": False,
            "state": "PENDING",
            "message": (
                "Unable to verify payment right now."
            )
        }


# ============================================================
# BASIC ROUTES
# ============================================================

@app.get("/")
def home():
    return jsonify({
        "message": (
            "SOMA HUB Flask backend is running"
        ),
        "success": True
    })


@app.get("/api/test")
def api_test():
    return jsonify({
        "success": True,
        "message": "SOMA HUB API is working."
    })


@app.get("/api/intasend-config-test")
def intasend_config_test():
    return jsonify({
        "success": bool(
            INTASEND_PUBLISHABLE_KEY
            and INTASEND_SECRET_KEY
        ),
        "provider": "IntaSend",
        "environment": (
            "sandbox"
            if INTASEND_TEST_ENVIRONMENT
            else "live"
        ),
        "publishable_key_configured": bool(
            INTASEND_PUBLISHABLE_KEY
        ),
        "secret_key_configured": bool(
            INTASEND_SECRET_KEY
        ),
    })


# ============================================================
# STUDENT REGISTRATION
# ============================================================

@app.post("/api/students/register")
def register_student():
    data = request.get_json(
        silent=True
    ) or {}

    soma_hub_code = str(
        data.get(
            "soma_hub_code",
            ""
        )
    ).strip().upper()

    name = str(
        data.get(
            "name",
            ""
        )
    ).strip()

    grade = str(
        data.get(
            "grade",
            ""
        )
    ).strip()

    school = str(
        data.get(
            "school",
            ""
        )
    ).strip()

    if not soma_hub_code:
        return jsonify({
            "success": False,
            "message": (
                "SOMA HUB code is required."
            )
        }), 400

    if not name:
        return jsonify({
            "success": False,
            "message": "Student name is required."
        }), 400

    with database.get_connection() as conn:
        with conn.cursor() as cur:

            cur.execute(
                """
                SELECT id
                FROM students
                WHERE soma_hub_code = %s
                LIMIT 1
                """,
                (soma_hub_code,),
            )

            existing = cur.fetchone()

            if existing:
                cur.execute(
                    """
                    UPDATE students
                    SET
                        name = COALESCE(
                            NULLIF(%s, ''),
                            name
                        ),
                        grade = COALESCE(
                            NULLIF(%s, ''),
                            grade
                        ),
                        school = COALESCE(
                            NULLIF(%s, ''),
                            school
                        ),
                        updated_at = CURRENT_TIMESTAMP
                    WHERE soma_hub_code = %s
                    """,
                    (
                        name,
                        grade,
                        school,
                        soma_hub_code,
                    ),
                )

            else:
                cur.execute(
                    """
                    INSERT INTO students (
                        soma_hub_code,
                        name,
                        grade,
                        school,
                        created_at,
                        updated_at
                    )
                    VALUES (
                        %s,
                        %s,
                        %s,
                        %s,
                        CURRENT_TIMESTAMP,
                        CURRENT_TIMESTAMP
                    )
                    """,
                    (
                        soma_hub_code,
                        name,
                        grade,
                        school,
                    ),
                )

            conn.commit()

    return jsonify({
        "success": True,
        "message": (
            "Student synced successfully."
        ),
        "soma_hub_code": soma_hub_code
    })


# ============================================================
# STUDENT PERFORMANCE
# ============================================================

@app.post("/api/students/performance")
def save_student_performance():
    """
    Save the exact structure sent by storage.ts:

        soma_hub_code
        term_points[]
        quiz_results[]
    """

    data = request.get_json(
        silent=True
    ) or {}

    soma_hub_code = str(
        data.get(
            "soma_hub_code",
            ""
        )
    ).strip().upper()

    term_points = data.get(
        "term_points"
    ) or []

    quiz_results = data.get(
        "quiz_results"
    ) or []

    if not soma_hub_code:
        return jsonify({
            "success": False,
            "message": (
                "SOMA HUB code is required."
            )
        }), 400

    student = get_student_by_code(
        soma_hub_code
    )

    if not student:
        return jsonify({
            "success": False,
            "message": "Student account not found."
        }), 404

    if not isinstance(term_points, list):
        return jsonify({
            "success": False,
            "message": "term_points must be a list."
        }), 400

    if not isinstance(quiz_results, list):
        return jsonify({
            "success": False,
            "message": "quiz_results must be a list."
        }), 400

    student_id = student["id"]

    terms_synced = 0
    quiz_results_synced = 0

    with database.get_connection() as conn:
        with conn.cursor() as cur:

            for item in term_points:

                if not isinstance(item, dict):
                    continue

                term_key = str(
                    item.get(
                        "term_key",
                        ""
                    )
                ).strip()

                if not term_key:
                    continue

                study_notes = max(
                    0,
                    min(
                        20,
                        int(
                            item.get(
                                "study_notes_points",
                                0
                            ) or 0
                        )
                    )
                )

                topical_quizzes = max(
                    0,
                    min(
                        25,
                        int(
                            item.get(
                                "topical_quiz_points",
                                0
                            ) or 0
                        )
                    )
                )

                exams = max(
                    0,
                    min(
                        25,
                        int(
                            item.get(
                                "exam_points",
                                0
                            ) or 0
                        )
                    )
                )

                consistency = max(
                    0,
                    min(
                        15,
                        int(
                            item.get(
                                "consistency_points",
                                0
                            ) or 0
                        )
                    )
                )

                improvement = max(
                    0,
                    min(
                        15,
                        int(
                            item.get(
                                "improvement_points",
                                0
                            ) or 0
                        )
                    )
                )

                total = min(
                    100,
                    study_notes
                    + topical_quizzes
                    + exams
                    + consistency
                    + improvement
                )

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

                terms_synced += 1

            for item in quiz_results:

                if not isinstance(item, dict):
                    continue

                material_id = (
                    item.get("material_id")
                )

                material_title = str(
                    item.get(
                        "material_title",
                        ""
                    )
                ).strip()

                subject = str(
                    item.get(
                        "subject",
                        ""
                    )
                ).strip()

                grade_key = str(
                    item.get(
                        "grade_key",
                        ""
                    )
                ).strip()

                quiz_type = str(
                    item.get(
                        "quiz_type",
                        "topical"
                    )
                ).strip()

                completed_at = str(
                    item.get(
                        "completed_at",
                        ""
                    )
                ).strip()

                if not completed_at:
                    completed_at = now_string()

                try:
                    score = int(
                        item.get(
                            "score",
                            0
                        ) or 0
                    )
                except (
                    TypeError,
                    ValueError
                ):
                    score = 0

                try:
                    total = int(
                        item.get(
                            "total",
                            0
                        ) or 0
                    )
                except (
                    TypeError,
                    ValueError
                ):
                    total = 0

                try:
                    percentage = float(
                        item.get(
                            "percentage",
                            0
                        ) or 0
                    )
                except (
                    TypeError,
                    ValueError
                ):
                    percentage = 0.0

                cur.execute(
                    """
                    SELECT id
                    FROM quiz_results
                    WHERE student_id = %s
                      AND (
                          material_id = %s
                          OR (
                              material_id IS NULL
                              AND %s IS NULL
                          )
                      )
                      AND quiz_type = %s
                      AND completed_at = %s
                    LIMIT 1
                    """,
                    (
                        student_id,
                        material_id,
                        material_id,
                        quiz_type,
                        completed_at,
                    ),
                )

                existing_result = cur.fetchone()

                if existing_result:
                    continue

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

                quiz_results_synced += 1

            conn.commit()

    return jsonify({
        "success": True,
        "message": (
            "Student performance synced successfully."
        ),
        "soma_hub_code": soma_hub_code,
        "terms_synced": terms_synced,
        "quiz_results_synced": quiz_results_synced
    })


@app.get("/api/students/performance")
def get_student_performance():
    soma_hub_code = (
        request.args.get(
            "soma_hub_code"
        )
        or request.args.get(
            "code"
        )
    )

    if not soma_hub_code:
        return jsonify({
            "success": False,
            "message": (
                "SOMA HUB code is required."
            )
        }), 400

    soma_hub_code = str(
        soma_hub_code
    ).strip().upper()

    with database.get_connection() as conn:
        with conn.cursor() as cur:

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
                WHERE student_id = (
                    SELECT id
                    FROM students
                    WHERE soma_hub_code = %s
                )
                ORDER BY term_key
                """,
                (soma_hub_code,),
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
                WHERE student_id = (
                    SELECT id
                    FROM students
                    WHERE soma_hub_code = %s
                )
                ORDER BY completed_at DESC
                """,
                (soma_hub_code,),
            )

            quizzes = cur.fetchall()

    return jsonify({
        "success": True,
        "soma_hub_code": soma_hub_code,
        "term_points": terms,
        "quiz_results": quizzes
    })


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
            )
        }), 400

    with database.get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT *
                FROM admins
                WHERE username = %s
                LIMIT 1
                """,
                (username,),
            )

            admin = cur.fetchone()

    if not admin:
        return jsonify({
            "success": False,
            "message": "Invalid login details."
        }), 401

    password_hash = (
        admin.get("password_hash")
    )

    if not password_hash:
        return jsonify({
            "success": False,
            "message": (
                "Admin account is not configured correctly."
            )
        }), 500

    if not check_password_hash(
        password_hash,
        password
    ):
        return jsonify({
            "success": False,
            "message": "Invalid login details."
        }), 401

    session["admin_id"] = admin["id"]
    session["admin_username"] = (
        admin["username"]
    )

    return jsonify({
        "success": True,
        "message": (
            "Admin login successful."
        ),
        "username": admin["username"]
    })


@app.get("/api/admin/me")
def admin_me():
    if not session.get("admin_id"):
        return jsonify({
            "success": False,
            "authenticated": False
        }), 401

    return jsonify({
        "success": True,
        "authenticated": True,
        "username": session.get(
            "admin_username"
        )
    })


@app.post("/api/admin/logout")
def admin_logout():
    session.clear()

    return jsonify({
        "success": True,
        "message": "Logged out successfully."
    })


# ============================================================
# ADMIN STUDENT LOOKUP
# ============================================================

@app.get(
    "/api/admin/student/<soma_hub_code>"
)
def admin_student_lookup(
    soma_hub_code
):
    if not session.get("admin_id"):
        return jsonify({
            "success": False,
            "message": (
                "Admin authentication required."
            )
        }), 401

    soma_hub_code = str(
        soma_hub_code
    ).strip().upper()

    student = get_student_by_code(
        soma_hub_code
    )

    if not student:
        return jsonify({
            "success": False,
            "message": "Student not found."
        }), 404

    with database.get_connection() as conn:
        with conn.cursor() as cur:

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
                    student["id"],
                ),
            )

            performance = cur.fetchall()

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
                    student["id"],
                ),
            )

            quiz_results = cur.fetchall()

    return jsonify({
        "success": True,
        "student": student,
        "performance": performance,
        "quiz_results": quiz_results
    })


@app.get("/api/admin/top-students")
def admin_top_students():
    if not session.get("admin_id"):
        return jsonify({
            "success": False,
            "message": (
                "Admin authentication required."
            )
        }), 401

    with database.get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT
                    s.soma_hub_code,
                    s.name,
                    s.grade,
                    s.school,
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
                    s.grade,
                    s.school
                ORDER BY total_points DESC
                LIMIT 50
                """
            )

            students = cur.fetchall()

    return jsonify({
        "success": True,
        "students": students
    })


# ============================================================
# INTASEND PAYMENT SESSION
# ============================================================

@app.post(
    "/api/intasend/payment-session"
)
def create_intasend_payment_session():
    data = request.get_json(
        silent=True
    ) or {}

    soma_hub_code = str(
        data.get(
            "soma_hub_code",
            ""
        )
    ).strip().upper()

    purpose = str(
        data.get(
            "purpose",
            "topup"
        )
    ).strip()

    phone_number = normalize_phone(
        data.get(
            "phone_number"
        )
        or data.get(
            "phone"
        )
    )

    try:
        amount = int(
            data.get(
                "amount",
                0
            )
        )
    except (
        TypeError,
        ValueError
    ):
        amount = 0

    if not soma_hub_code:
        return jsonify({
            "success": False,
            "message": (
                "SOMA HUB code is required."
            )
        }), 400

    if (
        purpose != "topup"
        and not is_valid_purpose(purpose)
    ):
        return jsonify({
            "success": False,
            "message": (
                "Invalid payment purpose."
            )
        }), 400

    if amount < 1:
        return jsonify({
            "success": False,
            "message": (
                "Payment amount must be at least KSh 1."
            )
        }), 400

    if amount > 150000:
        return jsonify({
            "success": False,
            "message": (
                "Payment amount exceeds "
                "the allowed limit."
            )
        }), 400

    if not phone_number:
        return jsonify({
            "success": False,
            "message": (
                "A valid Kenyan phone number "
                "is required."
            )
        }), 400

    student = get_student_by_code(
        soma_hub_code
    )

    if not student:
        return jsonify({
            "success": False,
            "message": (
                "Student account not found."
            )
        }), 404

    session_id = secrets.token_urlsafe(
        24
    )

    # Our own reference identifies this payment
    # session inside SOMA HUB.
    api_ref = (
        f"SOMA-{session_id}"
    )

    expires_at = (
        utc_now()
        + timedelta(minutes=30)
    ).strftime(
        "%Y-%m-%d %H:%M:%S"
    )

    with database.get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO payment_sessions (
                    session_id,
                    student_id,
                    soma_hub_code,
                    amount,
                    purpose,
                    phone_number,
                    status,
                    merchant_request_id,
                    created_at,
                    expires_at
                )
                VALUES (
                    %s,
                    %s,
                    %s,
                    %s,
                    %s,
                    %s,
                    'pending',
                    %s,
                    CURRENT_TIMESTAMP,
                    %s
                )
                RETURNING id
                """,
                (
                    session_id,
                    student["id"],
                    soma_hub_code,
                    amount,
                    purpose,
                    phone_number,
                    api_ref,
                    expires_at,
                ),
            )

            payment_row = cur.fetchone()

            conn.commit()

    payment_db_id = payment_row["id"]

    try:
        service = get_intasend_service()

        # =====================================================
        # DIRECT INTASEND M-PESA STK PUSH
        #
        # This does NOT create an IntaSend checkout page.
        # It sends the M-Pesa payment prompt directly to
        # the supplied phone number.
        # =====================================================

        stk_response = (
            service.collect.mpesa_stk_push(
                phone_number=phone_number,
                amount=amount,
                narrative=f"SOMA HUB {purpose}",
                currency="KES",
                api_ref=api_ref,
            )
        )

        invoice_id = (
            extract_intasend_invoice_id(
                stk_response
            )
        )

        response_api_ref = (
            extract_intasend_api_ref(
                stk_response
            )
        )

        final_api_ref = (
            response_api_ref
            or api_ref
        )

        # Direct STK Push must provide an invoice ID
        # because it is required for later status checks.
        if not invoice_id:
            app.logger.error(
                "IntaSend STK Push response did not "
                "contain an invoice ID. "
                "response_type=%s response_keys=%s "
                "response=%s",
                type(stk_response).__name__,
                (
                    list(stk_response.keys())
                    if isinstance(
                        stk_response,
                        dict
                    )
                    else []
                ),
                stk_response,
            )

            raise RuntimeError(
                "IntaSend did not return "
                "a payment invoice ID."
            )

        # Store IntaSend's invoice ID in the existing
        # checkout_request_id column for compatibility.
        with database.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE payment_sessions
                    SET
                        checkout_request_id = %s,
                        merchant_request_id = %s,
                        status = 'pending'
                    WHERE id = %s
                    """,
                    (
                        invoice_id,
                        final_api_ref,
                        payment_db_id,
                    ),
                )

                conn.commit()

        app.logger.info(
            "IntaSend M-Pesa STK Push created successfully. "
            "session_id=%s invoice_id=%s api_ref=%s",
            session_id,
            invoice_id,
            final_api_ref,
        )

        return jsonify({
            "success": True,
            "message": (
                "M-Pesa payment prompt sent successfully."
            ),
            "session_id": session_id,
            "invoice_id": invoice_id,
            "payment_url": None,
            "amount": amount,
            "phone_number": phone_number,
        })

    except Exception as exc:
        app.logger.exception(
            "Unable to create IntaSend M-Pesa STK Push: %s",
            exc
        )

        with database.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE payment_sessions
                    SET status = 'failed'
                    WHERE id = %s
                    """,
                    (payment_db_id,),
                )

                conn.commit()

        return jsonify({
            "success": False,
            "message": (
                "Unable to create the "
                "IntaSend M-Pesa payment."
            ),
            "error": str(exc),
        }), 500


# ============================================================
# INTASEND WEBHOOK
# ============================================================

@app.post("/api/intasend/webhook")
def intasend_webhook():
    payload = request.get_json(
        silent=True
    ) or {}

    if INTASEND_WEBHOOK_CHALLENGE:
        received_challenge = (
            payload.get("challenge")
            or request.args.get(
                "challenge"
            )
        )

        if (
            received_challenge
            != INTASEND_WEBHOOK_CHALLENGE
        ):
            return jsonify({
                "success": False,
                "message": (
                    "Invalid webhook challenge."
                )
            }), 403

    invoice_id = payload.get(
        "invoice_id"
    )

    state = str(
        payload.get(
            "state",
            ""
        )
    ).upper()

    api_ref = (
        payload.get("api_ref")
        or payload.get("api_reference")
    )

    if not invoice_id and not api_ref:
        return jsonify({
            "success": True,
            "message": "Webhook received."
        })

    with database.get_connection() as conn:
        with conn.cursor() as cur:

            payment_session = None

            if invoice_id:
                cur.execute(
                    """
                    SELECT *
                    FROM payment_sessions
                    WHERE checkout_request_id = %s
                    LIMIT 1
                    """,
                    (invoice_id,),
                )

                payment_session = cur.fetchone()

            if not payment_session and api_ref:
                cur.execute(
                    """
                    SELECT *
                    FROM payment_sessions
                    WHERE merchant_request_id = %s
                    LIMIT 1
                    """,
                    (api_ref,),
                )

                payment_session = cur.fetchone()

    if not payment_session:
        return jsonify({
            "success": True,
            "message": (
                "Webhook received; "
                "no matching payment session."
            )
        })

    if state == "COMPLETE":

        result = process_completed_payment(
            payment_session["id"],
            invoice_id=invoice_id,
        )

        try:
            coins_bp.fulfil_payment_purpose(
                payment_session["id"]
            )
        except Exception:
            app.logger.exception(
                "Unable to fulfil payment purpose."
            )

        return jsonify({
            "success": True,
            "message": "Payment completed.",
            "processed": result.get(
                "success",
                False
            )
        })

    if state == "FAILED":
        with database.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE payment_sessions
                    SET status = 'failed'
                    WHERE id = %s
                    """,
                    (
                        payment_session["id"],
                    ),
                )

                conn.commit()

        return jsonify({
            "success": True,
            "message": (
                "Payment marked as failed."
            )
        })

    return jsonify({
        "success": True,
        "message": (
            "Payment status received."
        ),
        "state": state or "PENDING"
    })


# ============================================================
# INTASEND PAYMENT STATUS
# ============================================================

@app.get(
    "/api/intasend/payment-status/<session_id>"
)
def intasend_payment_status(
    session_id
):
    with database.get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT *
                FROM payment_sessions
                WHERE session_id = %s
                LIMIT 1
                """,
                (session_id,),
            )

            payment_session = cur.fetchone()

    if not payment_session:
        return jsonify({
            "success": False,
            "message": (
                "Payment session not found."
            )
        }), 404

    status = str(
        payment_session["status"]
    ).lower()

    if status == "pending":

        # =====================================================
        # FIX:
        # PostgreSQL may return created_at as a string.
        # Convert it safely before checking tzinfo.
        # =====================================================

        created_at = (
            parse_database_datetime(
                payment_session.get(
                    "created_at"
                )
            )
        )

        if created_at:

            if (
                utc_now() - created_at
                > timedelta(minutes=30)
            ):
                with database.get_connection() as conn:
                    with conn.cursor() as cur:
                        cur.execute(
                            """
                            UPDATE payment_sessions
                            SET status = 'expired'
                            WHERE id = %s
                            """,
                            (
                                payment_session["id"],
                            ),
                        )

                        conn.commit()

                status = "expired"

        if status == "pending":

            result = (
                sync_payment_from_intasend(
                    payment_session
                )
            )

            state = str(
                result.get(
                    "state",
                    "PENDING"
                )
            ).lower()

            if state == "complete":
                status = "completed"

                try:
                    coins_bp.fulfil_payment_purpose(
                        payment_session["id"]
                    )
                except Exception:
                    app.logger.exception(
                        "Unable to fulfil payment purpose "
                        "during payment status check."
                    )

            elif state == "failed":
                status = "failed"

            else:
                status = state

    if status == "completed":
        response_status = "complete"
    else:
        response_status = status

    wallet_balance_value = (
        calculate_wallet_balance(
            payment_session[
                "soma_hub_code"
            ]
        )
    )

    with database.get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT *
                FROM wallet_transactions
                WHERE soma_hub_code = %s
                ORDER BY created_at DESC, id DESC
                LIMIT 1
                """,
                (
                    payment_session[
                        "soma_hub_code"
                    ],
                ),
            )

            latest_transaction = cur.fetchone()

    return jsonify({
        "success": True,
        "session_id": session_id,
        "status": response_status,
        "state": response_status.upper(),
        "amount": payment_session[
            "amount"
        ],
        "purpose": payment_session[
            "purpose"
        ],
        "soma_hub_code": payment_session[
            "soma_hub_code"
        ],
        "balance": wallet_balance_value,
        "latest_transaction": (
            latest_transaction
        ),
    })


# ============================================================
# WALLET
# ============================================================

@app.get(
    "/api/wallet/<soma_hub_code>"
)
def wallet_balance(
    soma_hub_code
):
    soma_hub_code = str(
        soma_hub_code
    ).strip().upper()

    student = get_student_by_code(
        soma_hub_code
    )

    if not student:
        return jsonify({
            "success": False,
            "message": "Student not found."
        }), 404

    balance = calculate_wallet_balance(
        soma_hub_code
    )

    return jsonify({
        "success": True,
        "soma_hub_code": soma_hub_code,
        "balance": balance,
        "coins": balance,
        "ksh": balance
    })


# ============================================================
# DEVELOPMENT PAYMENT TEST
# ============================================================

@app.post(
    "/api/dev/test-payment/<session_id>"
)
def dev_test_payment(
    session_id
):
    """
    Sandbox-only helper.

    This does not connect to real payment processing.
    It simply completes an existing sandbox payment session
    so the wallet-credit flow can be tested.
    """

    if not INTASEND_TEST_ENVIRONMENT:
        return jsonify({
            "success": False,
            "message": (
                "Test payment is disabled "
                "in live mode."
            )
        }), 403

    with database.get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT *
                FROM payment_sessions
                WHERE session_id = %s
                LIMIT 1
                """,
                (session_id,),
            )

            payment_session = cur.fetchone()

    if not payment_session:
        return jsonify({
            "success": False,
            "message": (
                "Payment session not found."
            )
        }), 404

    result = process_completed_payment(
        payment_session["id"],
        invoice_id=(
            payment_session.get(
                "checkout_request_id"
            )
        ),
    )

    try:
        coins_bp.fulfil_payment_purpose(
            payment_session["id"]
        )
    except Exception:
        app.logger.exception(
            "Unable to fulfil test payment purpose."
        )

    balance = calculate_wallet_balance(
        payment_session[
            "soma_hub_code"
        ]
    )

    return jsonify({
        "success": True,
        "message": (
            "Sandbox test payment completed."
        ),
        "session_id": session_id,
        "balance": balance,
        "processed": result.get(
            "success",
            False
        ),
    })


# ============================================================
# COINS / WALLET BLUEPRINT
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

except Exception as exc:
    app.logger.exception(
        "Database initialization failed: %s",
        exc
    )


# ============================================================
# RUN
# ============================================================

if __name__ == "__main__":
    port = int(
        os.getenv(
            "PORT",
            "5000"
        )
    )

    app.run(
        host="0.0.0.0",
        port=port,
        debug=False,
    )