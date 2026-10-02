import os
import secrets
from datetime import datetime, timedelta, timezone

from flask import Flask, jsonify, request, session
from flask_cors import CORS
from dotenv import load_dotenv
from werkzeug.security import check_password_hash

import database
from coins import create_coins_blueprint, is_valid_purpose
from intasend import APIService


# ============================================================
# ENVIRONMENT
# ============================================================

load_dotenv()

INTASEND_PUBLISHABLE_KEY = os.getenv("INTASEND_PUBLISHABLE_KEY", "").strip()
INTASEND_SECRET_KEY = os.getenv("INTASEND_SECRET_KEY", "").strip()

INTASEND_TEST_ENVIRONMENT = (
    os.getenv("INTASEND_TEST_ENVIRONMENT", "true").strip().lower()
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
# HELPERS
# ============================================================

def utc_now():
    return datetime.now(timezone.utc)


def normalize_phone(phone):
    """
    Normalize common Kenyan phone formats.

    Examples:
        0712345678 -> 254712345678
        712345678 -> 254712345678
        +254712345678 -> 254712345678
    """
    if phone is None:
        return None

    phone = str(phone).strip().replace(" ", "").replace("-", "")

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


def calculate_wallet_balance(soma_hub_code):
    """
    Calculate the student's paid SOMA Points balance from
    wallet transactions.

    CREDIT  = adds points
    DEBIT   = removes points
    """

    with database.get_db_connection() as conn:
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
                (soma_hub_code,),
            )

            row = cur.fetchone()

    if not row:
        return 0

    return max(0, int(row["balance"] or 0))


def get_intasend_service():
    if not INTASEND_SECRET_KEY and not INTASEND_PUBLISHABLE_KEY:
        raise RuntimeError(
            "IntaSend credentials are not configured."
        )

    return APIService(
        token=INTASEND_SECRET_KEY or None,
        publishable_key=INTASEND_PUBLISHABLE_KEY or None,
        test=INTASEND_TEST_ENVIRONMENT,
    )


def extract_intasend_invoice_id(response):
    if not isinstance(response, dict):
        return None

    return (
        response.get("invoice_id")
        or response.get("invoice", {}).get("invoice_id")
        if isinstance(response.get("invoice"), dict)
        else response.get("invoice_id")
    )


def extract_intasend_url(response):
    if not isinstance(response, dict):
        return None

    return (
        response.get("url")
        or response.get("checkout_url")
        or response.get("payment_url")
    )


def extract_intasend_api_ref(response):
    if not isinstance(response, dict):
        return None

    return response.get("api_ref") or response.get("api_reference")


def extract_intasend_invoice(response):
    if not isinstance(response, dict):
        return {}

    invoice = response.get("invoice")

    if isinstance(invoice, dict):
        return invoice

    return response


def process_completed_payment(payment_session_id, invoice_id=None):
    """
    Credit the student's wallet exactly once after IntaSend
    confirms the payment as COMPLETE.
    """

    with database.get_db_connection() as conn:
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

            if payment_session["status"] == "completed":
                return {
                    "success": True,
                    "already_processed": True,
                    "message": "Payment already processed."
                }

            amount = int(payment_session["amount"])
            soma_hub_code = payment_session["soma_hub_code"]

            reference = (
                payment_session["checkout_request_id"]
                or invoice_id
                or payment_session["id"]
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
                    soma_hub_code,
                    transaction_type,
                    amount,
                    reference,
                    description,
                    created_at
                )
                VALUES (
                    %s,
                    'CREDIT',
                    %s,
                    %s,
                    %s,
                    CURRENT_TIMESTAMP
                )
                """,
                (
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


def sync_payment_from_intasend(payment_session):
    """
    Ask IntaSend for the latest payment status.
    """

    invoice_id = payment_session.get("checkout_request_id")

    if not invoice_id:
        return {
            "success": False,
            "state": "FAILED",
            "message": "Missing IntaSend invoice ID."
        }

    try:
        service = get_intasend_service()

        response = service.collect.status(
            invoice_id=invoice_id
        )

        invoice = extract_intasend_invoice(response)

        state = (
            invoice.get("state")
            or invoice.get("status")
            or response.get("state")
            or response.get("status")
            if isinstance(response, dict)
            else None
        )

        state = str(state or "").upper()

        if state == "COMPLETE":
            result = process_completed_payment(
                payment_session["id"],
                invoice_id=invoice_id,
            )

            return {
                "success": True,
                "state": "COMPLETE",
                "message": "Payment completed.",
                "processed": result.get("success", False),
            }

        if state == "FAILED":
            with database.get_db_connection() as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        UPDATE payment_sessions
                        SET status = 'failed'
                        WHERE id = %s
                        """,
                        (payment_session["id"],),
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
            "message": "Unable to verify payment right now."
        }


def get_student_by_code(soma_hub_code):
    with database.get_db_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT *
                FROM students
                WHERE soma_hub_code = %s
                LIMIT 1
                """,
                (soma_hub_code,),
            )

            return cur.fetchone()


# ============================================================
# BASIC ROUTES
# ============================================================

@app.get("/")
def home():
    return jsonify({
        "message": "SOMA HUB Flask backend is running",
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
    data = request.get_json(silent=True) or {}

    soma_hub_code = str(
        data.get("soma_hub_code", "")
    ).strip()

    name = str(
        data.get("name", "")
    ).strip()

    grade = str(
        data.get("grade", "")
    ).strip()

    school = str(
        data.get("school", "")
    ).strip()

    if not soma_hub_code:
        return jsonify({
            "success": False,
            "message": "SOMA HUB code is required."
        }), 400

    with database.get_db_connection() as conn:
        with conn.cursor() as cur:

            cur.execute(
                """
                SELECT *
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
                        name = COALESCE(NULLIF(%s, ''), name),
                        grade = COALESCE(NULLIF(%s, ''), grade),
                        school = COALESCE(NULLIF(%s, ''), school)
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
                        school
                    )
                    VALUES (%s, %s, %s, %s)
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
        "message": "Student synced successfully.",
        "soma_hub_code": soma_hub_code
    })


# ============================================================
# STUDENT PERFORMANCE
# ============================================================

@app.route(
    "/api/students/performance",
    methods=["GET", "POST"]
)
def student_performance():
    if request.method == "GET":
        soma_hub_code = (
            request.args.get("soma_hub_code")
            or request.args.get("code")
        )

        if not soma_hub_code:
            return jsonify({
                "success": False,
                "message": "SOMA HUB code is required."
            }), 400

        with database.get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT *
                    FROM student_performance
                    WHERE soma_hub_code = %s
                    ORDER BY term
                    """,
                    (soma_hub_code,),
                )

                rows = cur.fetchall()

        return jsonify({
            "success": True,
            "soma_hub_code": soma_hub_code,
            "performance": rows
        })

    data = request.get_json(silent=True) or {}

    soma_hub_code = str(
        data.get("soma_hub_code", "")
    ).strip()

    term = str(
        data.get("term", "")
    ).strip()

    if not soma_hub_code or not term:
        return jsonify({
            "success": False,
            "message": "SOMA HUB code and term are required."
        }), 400

    study_notes = int(
        data.get("studyNotes", 0) or 0
    )

    topical_quizzes = int(
        data.get("topicalQuizzes", 0) or 0
    )

    exams = int(
        data.get("exams", 0) or 0
    )

    consistency = int(
        data.get("consistency", 0) or 0
    )

    progress = int(
        data.get("progress", 0) or 0
    )

    total = min(
        100,
        study_notes
        + topical_quizzes
        + exams
        + consistency
        + progress
    )

    with database.get_db_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO student_performance (
                    soma_hub_code,
                    term,
                    study_notes,
                    topical_quizzes,
                    exams,
                    consistency,
                    progress,
                    total_points
                )
                VALUES (
                    %s, %s, %s, %s, %s, %s, %s, %s
                )
                ON CONFLICT (
                    soma_hub_code,
                    term
                )
                DO UPDATE SET
                    study_notes = EXCLUDED.study_notes,
                    topical_quizzes = EXCLUDED.topical_quizzes,
                    exams = EXCLUDED.exams,
                    consistency = EXCLUDED.consistency,
                    progress = EXCLUDED.progress,
                    total_points = EXCLUDED.total_points
                """,
                (
                    soma_hub_code,
                    term,
                    study_notes,
                    topical_quizzes,
                    exams,
                    consistency,
                    progress,
                    total,
                ),
            )

            conn.commit()

    return jsonify({
        "success": True,
        "message": "Performance synced successfully.",
        "soma_hub_code": soma_hub_code,
        "term": term,
        "total_points": total
    })


# ============================================================
# ADMIN LOGIN
# ============================================================

@app.post("/api/admin/login")
def admin_login():
    data = request.get_json(silent=True) or {}

    username = str(
        data.get("username", "")
    ).strip()

    password = str(
        data.get("password", "")
    )

    if not username or not password:
        return jsonify({
            "success": False,
            "message": "Username and password are required."
        }), 400

    with database.get_db_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT *
                FROM admin_users
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
        or admin.get("password")
    )

    if not password_hash:
        return jsonify({
            "success": False,
            "message": "Admin account is not configured correctly."
        }), 500

    if not check_password_hash(password_hash, password):
        return jsonify({
            "success": False,
            "message": "Invalid login details."
        }), 401

    session["admin_id"] = admin["id"]
    session["admin_username"] = admin["username"]

    return jsonify({
        "success": True,
        "message": "Admin login successful.",
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
        "username": session.get("admin_username")
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

@app.get("/api/admin/student/<soma_hub_code>")
def admin_student_lookup(soma_hub_code):
    if not session.get("admin_id"):
        return jsonify({
            "success": False,
            "message": "Admin authentication required."
        }), 401

    student = get_student_by_code(soma_hub_code)

    if not student:
        return jsonify({
            "success": False,
            "message": "Student not found."
        }), 404

    with database.get_db_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT *
                FROM student_performance
                WHERE soma_hub_code = %s
                ORDER BY term
                """,
                (soma_hub_code,),
            )

            performance = cur.fetchall()

    return jsonify({
        "success": True,
        "student": student,
        "performance": performance
    })


@app.get("/api/admin/top-students")
def admin_top_students():
    if not session.get("admin_id"):
        return jsonify({
            "success": False,
            "message": "Admin authentication required."
        }), 401

    with database.get_db_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT
                    s.soma_hub_code,
                    s.name,
                    s.grade,
                    s.school,
                    COALESCE(
                        SUM(p.total_points),
                        0
                    ) AS total_points
                FROM students s
                LEFT JOIN student_performance p
                    ON p.soma_hub_code = s.soma_hub_code
                GROUP BY
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

@app.post("/api/intasend/payment-session")
def create_intasend_payment_session():
    data = request.get_json(silent=True) or {}

    soma_hub_code = str(
        data.get("soma_hub_code", "")
    ).strip()

    purpose = str(
        data.get("purpose", "topup")
    ).strip()

    phone_number = normalize_phone(
        data.get("phone_number")
        or data.get("phone")
    )

    try:
        amount = int(data.get("amount", 0))
    except (TypeError, ValueError):
        amount = 0

    if not soma_hub_code:
        return jsonify({
            "success": False,
            "message": "SOMA HUB code is required."
        }), 400

    if not is_valid_purpose(purpose):
        return jsonify({
            "success": False,
            "message": "Invalid payment purpose."
        }), 400

    if amount < 1:
        return jsonify({
            "success": False,
            "message": "Payment amount must be at least KSh 1."
        }), 400

    if amount > 150000:
        return jsonify({
            "success": False,
            "message": "Payment amount exceeds the allowed limit."
        }), 400

    if not phone_number:
        return jsonify({
            "success": False,
            "message": "A valid Kenyan phone number is required."
        }), 400

    student = get_student_by_code(soma_hub_code)

    if not student:
        return jsonify({
            "success": False,
            "message": "Student account not found."
        }), 404

    session_id = secrets.token_urlsafe(24)

    with database.get_db_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO payment_sessions (
                    id,
                    soma_hub_code,
                    amount,
                    purpose,
                    phone_number,
                    status,
                    created_at
                )
                VALUES (
                    %s,
                    %s,
                    %s,
                    %s,
                    %s,
                    'pending',
                    CURRENT_TIMESTAMP
                )
                """,
                (
                    session_id,
                    soma_hub_code,
                    amount,
                    purpose,
                    phone_number,
                ),
            )

            conn.commit()

    try:
        service = get_intasend_service()

        checkout_response = service.collect.checkout(
            phone_number=phone_number,
            email=None,
            amount=amount,
            currency="KES",
            comment=f"SOMA HUB {purpose}",
            redirect_url=PAYMENT_REDIRECT_URL,
        )

        invoice_id = extract_intasend_invoice_id(
            checkout_response
        )

        checkout_url = extract_intasend_url(
            checkout_response
        )

        api_ref = extract_intasend_api_ref(
            checkout_response
        )

        if not invoice_id:
            raise RuntimeError(
                "IntaSend did not return an invoice ID."
            )

        with database.get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
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
                        session_id,
                    ),
                )

                conn.commit()

        return jsonify({
            "success": True,
            "message": "IntaSend checkout created.",
            "session_id": session_id,
            "invoice_id": invoice_id,

            # IMPORTANT:
            # Frontend payments.ts expects payment_url.
            "payment_url": checkout_url,

            "amount": amount,
            "phone_number": phone_number,
        })

    except Exception as exc:
        app.logger.exception(
            "Unable to create IntaSend checkout: %s",
            exc
        )

        with database.get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE payment_sessions
                    SET status = 'failed'
                    WHERE id = %s
                    """,
                    (session_id,),
                )

                conn.commit()

        return jsonify({
            "success": False,
            "message": (
                "Unable to create the IntaSend payment session."
            ),
            "error": str(exc),
        }), 500


# ============================================================
# INTASEND WEBHOOK
# ============================================================

@app.post("/api/intasend/webhook")
def intasend_webhook():
    payload = request.get_json(silent=True) or {}

    if INTASEND_WEBHOOK_CHALLENGE:
        received_challenge = (
            payload.get("challenge")
            or request.args.get("challenge")
        )

        if received_challenge != INTASEND_WEBHOOK_CHALLENGE:
            return jsonify({
                "success": False,
                "message": "Invalid webhook challenge."
            }), 403

    invoice_id = payload.get("invoice_id")

    state = str(
        payload.get("state", "")
    ).upper()

    api_ref = payload.get("api_ref")

    if not invoice_id and not api_ref:
        return jsonify({
            "success": True,
            "message": "Webhook received."
        })

    with database.get_db_connection() as conn:
        with conn.cursor() as cur:

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
            else:
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
            "message": "Webhook received; no matching payment session."
        })

    if state == "COMPLETE":
        result = process_completed_payment(
            payment_session["id"],
            invoice_id=invoice_id,
        )

        try:
            from coins import fulfil_payment_purpose

            fulfil_payment_purpose(
                payment_session["soma_hub_code"],
                payment_session["purpose"],
                payment_session["amount"],
            )

        except Exception:
            app.logger.exception(
                "Unable to fulfil payment purpose."
            )

        return jsonify({
            "success": True,
            "message": "Payment completed.",
            "processed": result.get("success", False)
        })

    if state == "FAILED":
        with database.get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE payment_sessions
                    SET status = 'failed'
                    WHERE id = %s
                    """,
                    (payment_session["id"],),
                )

                conn.commit()

        return jsonify({
            "success": True,
            "message": "Payment marked as failed."
        })

    return jsonify({
        "success": True,
        "message": "Payment status received.",
        "state": state or "PENDING"
    })


# ============================================================
# INTASEND PAYMENT STATUS
# ============================================================

@app.get("/api/intasend/payment-status/<session_id>")
def intasend_payment_status(session_id):
    with database.get_db_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT *
                FROM payment_sessions
                WHERE id = %s
                LIMIT 1
                """,
                (session_id,),
            )

            payment_session = cur.fetchone()

    if not payment_session:
        return jsonify({
            "success": False,
            "message": "Payment session not found."
        }), 404

    status = str(
        payment_session["status"]
    ).lower()

    if status == "pending":
        created_at = payment_session.get("created_at")

        if created_at:
            if created_at.tzinfo is None:
                created_at = created_at.replace(
                    tzinfo=timezone.utc
                )

            if utc_now() - created_at > timedelta(minutes=30):
                with database.get_db_connection() as conn:
                    with conn.cursor() as cur:
                        cur.execute(
                            """
                            UPDATE payment_sessions
                            SET status = 'expired'
                            WHERE id = %s
                            """,
                            (session_id,),
                        )

                        conn.commit()

                status = "expired"

        if status == "pending":
            result = sync_payment_from_intasend(
                payment_session
            )

            status = result.get(
                "state",
                "PENDING"
            ).lower()

    if status == "completed":
        status = "complete"

    wallet_balance = calculate_wallet_balance(
        payment_session["soma_hub_code"]
    )

    latest_transaction = None

    with database.get_db_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT *
                FROM wallet_transactions
                WHERE soma_hub_code = %s
                ORDER BY created_at DESC
                LIMIT 1
                """,
                (
                    payment_session["soma_hub_code"],
                ),
            )

            latest_transaction = cur.fetchone()

    return jsonify({
        "success": True,
        "session_id": session_id,
        "status": status,
        "state": status.upper(),
        "amount": payment_session["amount"],
        "purpose": payment_session["purpose"],
        "soma_hub_code": payment_session["soma_hub_code"],
        "balance": wallet_balance,
        "latest_transaction": latest_transaction,
    })


# ============================================================
# WALLET
# ============================================================

@app.get("/api/wallet/<soma_hub_code>")
def wallet_balance(soma_hub_code):
    student = get_student_by_code(soma_hub_code)

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

@app.post("/api/dev/test-payment/<session_id>")
def dev_test_payment(session_id):
    """
    Sandbox-only helper.

    This does NOT connect to any real payment provider.
    It is only available when IntaSend is configured for
    sandbox/test mode.
    """

    if not INTASEND_TEST_ENVIRONMENT:
        return jsonify({
            "success": False,
            "message": "Test payment is disabled in live mode."
        }), 403

    with database.get_db_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT *
                FROM payment_sessions
                WHERE id = %s
                LIMIT 1
                """,
                (session_id,),
            )

            payment_session = cur.fetchone()

    if not payment_session:
        return jsonify({
            "success": False,
            "message": "Payment session not found."
        }), 404

    result = process_completed_payment(
        session_id,
        invoice_id=payment_session.get(
            "checkout_request_id"
        ),
    )

    try:
        from coins import fulfil_payment_purpose

        fulfil_payment_purpose(
            payment_session["soma_hub_code"],
            payment_session["purpose"],
            payment_session["amount"],
        )

    except Exception:
        app.logger.exception(
            "Unable to fulfil test payment purpose."
        )

    balance = calculate_wallet_balance(
        payment_session["soma_hub_code"]
    )

    return jsonify({
        "success": True,
        "message": "Sandbox test payment completed.",
        "session_id": session_id,
        "balance": balance,
        "processed": result.get("success", False),
    })


# ============================================================
# COINS / WALLET BLUEPRINT
# ============================================================

coins_bp = create_coins_blueprint()

app.register_blueprint(coins_bp)


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
        os.getenv("PORT", "5000")
    )

    app.run(
        host="0.0.0.0",
        port=port,
        debug=False,
    )