from flask import Flask, request, jsonify, session
from flask_cors import CORS
from dotenv import load_dotenv
import requests
import base64
import os
import re
import sqlite3
import uuid
from datetime import datetime, timedelta
from werkzeug.security import check_password_hash

from coins import create_coins_blueprint, is_valid_purpose
import database

# ============================================================
# LOAD ENVIRONMENT
# ============================================================

load_dotenv()

app = Flask(__name__)

app.secret_key = os.getenv("SOMA_SECRET_KEY", "change-this-secret-key")

# Extra origins (deployed site, Capacitor app) come from
# SOMA_CORS_ORIGINS as a comma-separated list.
EXTRA_CORS_ORIGINS = [
    origin.strip()
    for origin in os.getenv("SOMA_CORS_ORIGINS", "").split(",")
    if origin.strip()
]

CORS(
    app,
    supports_credentials=True,
    origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://10.48.151.52:5173",
         "http://192.168.100.54:5173",
        *EXTRA_CORS_ORIGINS,
    ],
)

# ============================================================
# DATABASE
# ============================================================

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.getenv(
    "SOMA_DB_PATH",
    os.path.join(BASE_DIR, "soma_hub.db"),
)


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


# ============================================================
# MPESA CONFIGURATION
# ============================================================

MPESA_CONSUMER_KEY = os.getenv("MPESA_CONSUMER_KEY", "")
MPESA_CONSUMER_SECRET = os.getenv("MPESA_CONSUMER_SECRET", "")

MPESA_SHORTCODE = os.getenv("MPESA_SHORTCODE", "174379")
MPESA_PASSKEY = os.getenv("MPESA_PASSKEY", "")

MPESA_CALLBACK_URL = os.getenv(
    "MPESA_CALLBACK_URL",
    "https://example.com/api/mpesa/callback"
)

MPESA_ENVIRONMENT = os.getenv("MPESA_ENVIRONMENT", "sandbox").lower()

SOMA_HUB_CODE_PATTERN = re.compile(r"[A-Z0-9-]{3,32}")

MIN_TOPUP_AMOUNT = 1
MAX_TOPUP_AMOUNT = 150000

if MPESA_ENVIRONMENT == "production":
    MPESA_BASE_URL = "https://api.safaricom.co.ke"
else:
    MPESA_BASE_URL = "https://sandbox.safaricom.co.ke"

# Lets local tests point at a stand-in for Safaricom's API.
MPESA_BASE_URL = os.getenv("MPESA_BASE_URL", MPESA_BASE_URL).rstrip("/")


# ============================================================
# GENERAL HELPERS
# ============================================================

def now_string():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def safe_int(value, default=None):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def normalize_mpesa_phone(phone):
    """
    Accept common Kenyan M-Pesa phone formats and return:
    2547XXXXXXXX or 2541XXXXXXXX

    Accepted examples:
        0712345678
        0112345678
        254712345678
        254112345678
        +254712345678
        +254112345678
        712345678
        112345678
    """

    if phone is None:
        return None

    phone = str(phone).strip()

    # Remove common formatting characters
    phone = phone.replace(" ", "")
    phone = phone.replace("-", "")
    phone = phone.replace("(", "")
    phone = phone.replace(")", "")

    # +254XXXXXXXXX
    if phone.startswith("+254"):
        phone = phone[1:]

    # 07XXXXXXXX
    elif phone.startswith("07"):
        phone = "254" + phone[1:]

    # 01XXXXXXXX
    elif phone.startswith("01"):
        phone = "254" + phone[1:]

    # 7XXXXXXXX
    elif phone.startswith("7"):
        phone = "254" + phone

    # 1XXXXXXXX
    elif phone.startswith("1"):
        phone = "254" + phone

    # Must now be exactly 12 digits
    if len(phone) != 12:
        return None

    if not phone.isdigit():
        return None

    if not phone.startswith("254"):
        return None

    # Kenyan mobile numbers normally begin 7 or 1 after 254
    if phone[3] not in ("7", "1"):
        return None

    return phone


def calculate_wallet_balance(conn, soma_hub_code):
    """
    CREDIT increases wallet.
    DEBIT decreases wallet.
    """

    row = conn.execute(
        """
        SELECT COALESCE(
            SUM(
                CASE
                    WHEN transaction_type = 'CREDIT' THEN amount
                    WHEN transaction_type = 'DEBIT' THEN -amount
                    ELSE 0
                END
            ),
            0
        ) AS balance
        FROM wallet_transactions
        WHERE soma_hub_code = ?
        """,
        (soma_hub_code,),
    ).fetchone()

    return float(row["balance"] or 0)


# ============================================================
# BASIC TEST ROUTES
# ============================================================

@app.route("/", methods=["GET"])
def home():
    return jsonify({
        "success": True,
        "message": "SOMA HUB Flask backend is running"
    })


@app.route("/api/test", methods=["GET"])
def api_test():
    return jsonify({
        "success": True,
        "message": "Frontend can connect to Flask"
    })


@app.route("/api/mpesa-config-test", methods=["GET"])
def mpesa_config_test():
    return jsonify({
        "success": True,
        "environment": MPESA_ENVIRONMENT,
        "consumer_key_loaded": bool(MPESA_CONSUMER_KEY),
        "consumer_secret_loaded": bool(MPESA_CONSUMER_SECRET),
        "shortcode_loaded": bool(MPESA_SHORTCODE),
        "passkey_loaded": bool(MPESA_PASSKEY),
        "callback_url_loaded": bool(MPESA_CALLBACK_URL),
        "callback_url": MPESA_CALLBACK_URL,
    })


# ============================================================
# STUDENT REGISTRATION
# ============================================================

@app.route("/api/students/register", methods=["POST"])
def register_student():
    data = request.get_json(silent=True) or {}

    name = str(data.get("name", "")).strip()
    school_name = str(data.get("school_name", "")).strip()
    grade = str(data.get("grade", "")).strip()

    if not name:
        return jsonify({
            "success": False,
            "message": "Name is required"
        }), 400

    if not school_name:
        return jsonify({
            "success": False,
            "message": "School name is required"
        }), 400

    if not grade:
        return jsonify({
            "success": False,
            "message": "Grade is required"
        }), 400

    # The app creates its own SOMA HUB code and syncs it here
    # repeatedly, so keep that code and update the existing
    # student. Only generate one when the client sends none.
    soma_hub_code = str(
        data.get("soma_hub_code", "")
    ).strip().upper()

    if soma_hub_code and not SOMA_HUB_CODE_PATTERN.fullmatch(
        soma_hub_code
    ):
        return jsonify({
            "success": False,
            "message": "Invalid SOMA HUB code"
        }), 400

    if not soma_hub_code:
        soma_hub_code = "SH-" + uuid.uuid4().hex[:8].upper()

    conn = get_db()

    try:
        conn.execute(
            """
            INSERT INTO students (
                soma_hub_code,
                name,
                school_name,
                grade,
                created_at,
                updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(soma_hub_code) DO UPDATE SET
                name = excluded.name,
                school_name = excluded.school_name,
                grade = excluded.grade,
                updated_at = excluded.updated_at
            """,
            (
                soma_hub_code,
                name,
                school_name,
                grade,
                now_string(),
                now_string(),
            ),
        )

        conn.commit()

        student_id = conn.execute(
            "SELECT id FROM students WHERE soma_hub_code = ?",
            (soma_hub_code,),
        ).fetchone()["id"]

        return jsonify({
            "success": True,
            "message": "Student registered successfully",
            "student_id": student_id,
            "soma_hub_code": soma_hub_code,
            "name": name,
            "school_name": school_name,
            "grade": grade,
        })

    except sqlite3.IntegrityError as e:
        conn.rollback()

        return jsonify({
            "success": False,
            "message": "Could not register student",
            "error": str(e),
        }), 500

    finally:
        conn.close()


# ============================================================
# STUDENT PERFORMANCE
# ============================================================

@app.route("/api/students/performance", methods=["GET"])
def student_performance():
    soma_hub_code = request.args.get("soma_hub_code", "").strip()

    if not soma_hub_code:
        return jsonify({
            "success": False,
            "message": "SOMA HUB code is required"
        }), 400

    conn = get_db()

    try:
        student = conn.execute(
            """
            SELECT
                id,
                soma_hub_code,
                name,
                school_name,
                grade,
                created_at,
                updated_at
            FROM students
            WHERE soma_hub_code = ?
            """,
            (soma_hub_code,),
        ).fetchone()

        if not student:
            return jsonify({
                "success": False,
                "message": "Student not found"
            }), 404

        points = conn.execute(
            """
            SELECT
                COALESCE(SUM(points), 0) AS total_points
            FROM term_points
            WHERE student_id = ?
            """,
            (student["id"],),
        ).fetchone()

        return jsonify({
            "success": True,
            "student": dict(student),
            "total_points": points["total_points"] or 0,
        })

    finally:
        conn.close()


# ============================================================
# ADMIN LOGIN
# ============================================================

@app.route("/api/admin/login", methods=["POST"])
def admin_login():
    data = request.get_json(silent=True) or {}

    username = str(data.get("username", "")).strip()
    password = str(data.get("password", ""))

    if not username or not password:
        return jsonify({
            "success": False,
            "message": "Username and password are required"
        }), 400

    conn = get_db()

    try:
        admin = conn.execute(
            """
            SELECT id, username, password_hash
            FROM admins
            WHERE username = ?
            """,
            (username,),
        ).fetchone()

        if not admin:
            return jsonify({
                "success": False,
                "message": "Invalid username or password"
            }), 401

        if not check_password_hash(admin["password_hash"], password):
            return jsonify({
                "success": False,
                "message": "Invalid username or password"
            }), 401

        session["admin_id"] = admin["id"]
        session["admin_username"] = admin["username"]

        return jsonify({
            "success": True,
            "message": "Admin login successful",
            "username": admin["username"],
        })

    finally:
        conn.close()


@app.route("/api/admin/me", methods=["GET"])
def admin_me():
    if "admin_id" not in session:
        return jsonify({
            "success": False,
            "authenticated": False,
        }), 401

    return jsonify({
        "success": True,
        "authenticated": True,
        "username": session.get("admin_username"),
    })


@app.route("/api/admin/logout", methods=["POST"])
def admin_logout():
    session.pop("admin_id", None)
    session.pop("admin_username", None)

    return jsonify({
        "success": True,
        "message": "Admin logged out"
    })


# ============================================================
# ADMIN STUDENT LOOKUP
# ============================================================

@app.route("/api/admin/student/<soma_hub_code>", methods=["GET"])
def admin_student_lookup(soma_hub_code):
    if "admin_id" not in session:
        return jsonify({
            "success": False,
            "message": "Admin authentication required"
        }), 401

    soma_hub_code = soma_hub_code.strip()

    conn = get_db()

    try:
        student = conn.execute(
            """
            SELECT
                id,
                soma_hub_code,
                name,
                school_name,
                grade,
                created_at,
                updated_at
            FROM students
            WHERE soma_hub_code = ?
            """,
            (soma_hub_code,),
        ).fetchone()

        if not student:
            return jsonify({
                "success": False,
                "message": "Student not found"
            }), 404

        total_points = conn.execute(
            """
            SELECT COALESCE(SUM(points), 0) AS total_points
            FROM term_points
            WHERE student_id = ?
            """,
            (student["id"],),
        ).fetchone()["total_points"]

        wallet_balance = calculate_wallet_balance(
            conn,
            soma_hub_code
        )

        return jsonify({
            "success": True,
            "student": dict(student),
            "total_points": total_points or 0,
            "wallet_balance": wallet_balance,
        })

    finally:
        conn.close()


# ============================================================
# ADMIN TOP STUDENTS
# ============================================================

@app.route("/api/admin/top-students", methods=["GET"])
def admin_top_students():
    if "admin_id" not in session:
        return jsonify({
            "success": False,
            "message": "Admin authentication required"
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
                s.grade,
                COALESCE(SUM(tp.points), 0) AS total_points
            FROM students s
            LEFT JOIN term_points tp
                ON tp.student_id = s.id
            GROUP BY
                s.id,
                s.soma_hub_code,
                s.name,
                s.school_name,
                s.grade
            ORDER BY total_points DESC
            LIMIT 50
            """
        ).fetchall()

        return jsonify({
            "success": True,
            "students": [dict(row) for row in rows]
        })

    finally:
        conn.close()


# ============================================================
# MPESA ACCESS TOKEN
# ============================================================

def get_mpesa_access_token():
    if not MPESA_CONSUMER_KEY or not MPESA_CONSUMER_SECRET:
        raise Exception(
            "M-Pesa consumer key or consumer secret is missing"
        )

    credentials = (
        f"{MPESA_CONSUMER_KEY}:{MPESA_CONSUMER_SECRET}"
    )

    encoded_credentials = base64.b64encode(
        credentials.encode("utf-8")
    ).decode("utf-8")

    url = (
        MPESA_BASE_URL
        + "/oauth/v1/generate?grant_type=client_credentials"
    )

    headers = {
        "Authorization": f"Basic {encoded_credentials}"
    }

    response = requests.get(
        url,
        headers=headers,
        timeout=30
    )

    print("M-PESA TOKEN STATUS:", response.status_code)
    print("M-PESA TOKEN RESPONSE:", response.text)

    if response.status_code != 200:
        raise Exception(
            f"M-Pesa token request failed: "
            f"{response.status_code} {response.text}"
        )

    result = response.json()

    access_token = result.get("access_token")

    if not access_token:
        raise Exception(
            "M-Pesa response did not contain access_token"
        )

    return access_token


@app.route("/api/mpesa/token", methods=["GET"])
def mpesa_token():
    try:
        token = get_mpesa_access_token()

        return jsonify({
            "success": True,
            "token_received": bool(token)
        })

    except Exception as e:
        print("M-PESA TOKEN ERROR:", str(e))

        return jsonify({
            "success": False,
            "message": str(e)
        }), 500


# ============================================================
# MPESA PASSWORD
# ============================================================

def generate_mpesa_password(timestamp):
    raw = (
        f"{MPESA_SHORTCODE}"
        f"{MPESA_PASSKEY}"
        f"{timestamp}"
    )

    return base64.b64encode(
        raw.encode("utf-8")
    ).decode("utf-8")


# ============================================================
# CREATE PAYMENT SESSION + STK PUSH
# ============================================================

@app.route("/api/mpesa/payment-session", methods=["POST"])
def create_payment_session():
    data = request.get_json(silent=True) or {}

    soma_hub_code = str(
        data.get("soma_hub_code", "")
    ).strip()

    phone_number = data.get("phone_number")
    amount = data.get("amount")

    # What to do once the money arrives: "subscribe",
    # "unlock:<material_id>", or nothing for a plain top-up.
    purpose = data.get("purpose")

    if not is_valid_purpose(purpose):
        return jsonify({
            "success": False,
            "message": "Invalid payment purpose"
        }), 400

    # --------------------------------------------------------
    # Validate SOMA HUB code
    # --------------------------------------------------------

    if not soma_hub_code:
        return jsonify({
            "success": False,
            "message": "SOMA HUB code is required"
        }), 400

    # --------------------------------------------------------
    # Validate amount
    # --------------------------------------------------------

    # M-Pesa only charges whole shillings. Accepting 10.5 here
    # would send 10 to Safaricom and the callback amount check
    # would then reject the payment.
    try:
        amount = float(amount)
    except (TypeError, ValueError):
        return jsonify({
            "success": False,
            "message": "A valid amount is required"
        }), 400

    if not amount.is_integer():
        return jsonify({
            "success": False,
            "message": "Amount must be a whole number of shillings"
        }), 400

    amount = int(amount)

    if amount < MIN_TOPUP_AMOUNT or amount > MAX_TOPUP_AMOUNT:
        return jsonify({
            "success": False,
            "message": (
                f"Amount must be between KSh {MIN_TOPUP_AMOUNT} "
                f"and KSh {MAX_TOPUP_AMOUNT:,}"
            )
        }), 400

    # --------------------------------------------------------
    # Validate phone
    # --------------------------------------------------------

    normalized_phone = normalize_mpesa_phone(phone_number)

    print("============================================")
    print("PAYMENT SESSION REQUEST")
    print("SOMA HUB CODE:", soma_hub_code)
    print("PHONE RECEIVED:", phone_number)
    print("PHONE NORMALIZED:", normalized_phone)
    print("AMOUNT:", amount)
    print("============================================")

    if not normalized_phone:
        return jsonify({
            "success": False,
            "message": "A valid M-Pesa phone number is required"
        }), 400

    conn = get_db()

    try:
        # ----------------------------------------------------
        # Find student
        # ----------------------------------------------------

        student = conn.execute(
            """
            SELECT
                id,
                soma_hub_code,
                name,
                school_name,
                grade
            FROM students
            WHERE soma_hub_code = ?
            """,
            (soma_hub_code,),
        ).fetchone()

        if not student:
            return jsonify({
                "success": False,
                "message": "Student not found"
            }), 404

        # ----------------------------------------------------
        # Create internal payment session
        # ----------------------------------------------------

        session_id = (
            "SOMA-"
            + uuid.uuid4().hex[:32].upper()
        )

        created_at = now_string()
        expires_at = (
            datetime.now() + timedelta(minutes=15)
        ).strftime("%Y-%m-%d %H:%M:%S")

        conn.execute(
            """
            INSERT INTO payment_sessions (
                session_id,
                student_id,
                soma_hub_code,
                amount,
                status,
                created_at,
                expires_at,
                purpose
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                session_id,
                student["id"],
                soma_hub_code,
                amount,
                "pending",
                created_at,
                expires_at,
                purpose,
            ),
        )

        conn.commit()

        # ----------------------------------------------------
        # Get M-Pesa token
        # ----------------------------------------------------

        try:
            access_token = get_mpesa_access_token()
        except Exception as e:
            print("TOKEN ERROR DURING STK PUSH:", str(e))

            conn.execute(
                """
                UPDATE payment_sessions
                SET status = ?
                WHERE session_id = ?
                """,
                ("failed", session_id),
            )

            conn.commit()

            return jsonify({
                "success": False,
                "message": "Could not connect to M-Pesa",
                "error": str(e),
            }), 500

        # ----------------------------------------------------
        # Timestamp
        # ----------------------------------------------------

        timestamp = datetime.now().strftime(
            "%Y%m%d%H%M%S"
        )

        password = generate_mpesa_password(timestamp)

        # ----------------------------------------------------
        # STK Push request
        # ----------------------------------------------------

        stk_url = (
            MPESA_BASE_URL
            + "/mpesa/stkpush/v1/processrequest"
        )

        stk_payload = {
            "BusinessShortCode": MPESA_SHORTCODE,
            "Password": password,
            "Timestamp": timestamp,
            "TransactionType": "CustomerPayBillOnline",
            "Amount": int(amount),
            "PartyA": normalized_phone,
            "PartyB": MPESA_SHORTCODE,
            "PhoneNumber": normalized_phone,
            "CallBackURL": MPESA_CALLBACK_URL,
            "AccountReference": soma_hub_code,
            "TransactionDesc": "SOMA HUB wallet deposit",
        }

        headers = {
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json",
        }

        print("============================================")
        print("SENDING STK PUSH")
        print("URL:", stk_url)
        print("SHORTCODE:", MPESA_SHORTCODE)
        print("PHONE:", normalized_phone)
        print("AMOUNT:", int(amount))
        print("ACCOUNT REFERENCE:", soma_hub_code)
        print("CALLBACK:", MPESA_CALLBACK_URL)
        print("============================================")

        response = requests.post(
            stk_url,
            json=stk_payload,
            headers=headers,
            timeout=30,
        )

        print("STK RESPONSE STATUS:", response.status_code)
        print("STK RESPONSE:", response.text)

        try:
            result = response.json()
        except Exception:
            result = {
                "raw_response": response.text
            }

        response_code = str(
            result.get("ResponseCode", "")
        )

        if response.status_code != 200 or response_code != "0":
            conn.execute(
                """
                UPDATE payment_sessions
                SET status = ?
                WHERE session_id = ?
                """,
                ("failed", session_id),
            )

            conn.commit()

            # Safaricom explains rejections in errorMessage (e.g. a
            # request already waiting on the phone); pass it on.
            mpesa_message = (
                result.get("errorMessage")
                or result.get("ResponseDescription")
                or result.get("CustomerMessage")
            )

            return jsonify({
                "success": False,
                "message": (
                    f"M-Pesa couldn't send the request: {mpesa_message}"
                    if mpesa_message
                    else "M-Pesa STK Push could not be sent"
                ),
                "mpesa_response": result,
                "session_id": session_id,
            }), 502

        # ----------------------------------------------------
        # Save M-Pesa request IDs
        # ----------------------------------------------------

        checkout_request_id = result.get(
            "CheckoutRequestID"
        )

        merchant_request_id = result.get(
            "MerchantRequestID"
        )

        conn.execute(
            """
            UPDATE payment_sessions
            SET
                checkout_request_id = ?,
                merchant_request_id = ?
            WHERE session_id = ?
            """,
            (
                checkout_request_id,
                merchant_request_id,
                session_id,
            ),
        )

        conn.commit()

        print("PAYMENT SESSION CREATED:", session_id)
        print("CHECKOUT REQUEST ID:", checkout_request_id)
        print("MERCHANT REQUEST ID:", merchant_request_id)

        return jsonify({
            "success": True,
            "message": "STK Push sent. Check your phone.",
            "session_id": session_id,
            "checkout_request_id": checkout_request_id,
            "merchant_request_id": merchant_request_id,
            "amount": amount,
            "phone_number": normalized_phone,
        })

    except Exception as e:
        conn.rollback()

        print("PAYMENT SESSION ERROR:", str(e))

        return jsonify({
            "success": False,
            "message": "Could not create payment session",
            "error": str(e),
        }), 500

    finally:
        conn.close()


# ============================================================
# MPESA CALLBACK
# ============================================================

@app.route("/api/mpesa/callback", methods=["POST"])
def mpesa_callback():

    print("\n")
    print("============================================================")
    print("            M-PESA CALLBACK RECEIVED")
    print("============================================================")

    callback_data = request.get_json(silent=True)

    print("RAW CALLBACK DATA:")
    print(callback_data)

    if not callback_data:
        print("CALLBACK ERROR: No JSON body received")
        print("============================================================")

        return jsonify({
            "ResultCode": 1,
            "ResultDesc": "No callback data received"
        }), 400

    try:
        body = callback_data.get("Body", {})
        stk_callback = body.get("stkCallback", {})

        merchant_request_id = str(
            stk_callback.get("MerchantRequestID", "")
        ).strip()

        checkout_request_id = str(
            stk_callback.get("CheckoutRequestID", "")
        ).strip()

        result_code = safe_int(
            stk_callback.get("ResultCode"),
            default=None
        )

        result_desc = str(
            stk_callback.get("ResultDesc", "")
        )

        print("MerchantRequestID:", merchant_request_id)
        print("CheckoutRequestID:", checkout_request_id)
        print("ResultCode:", result_code)
        print("ResultDesc:", result_desc)

        if not checkout_request_id and not merchant_request_id:
            print(
                "CALLBACK ERROR: Neither CheckoutRequestID "
                "nor MerchantRequestID was received"
            )

            print("============================================================")

            return jsonify({
                "ResultCode": 0,
                "ResultDesc": "Accepted"
            })

        # ----------------------------------------------------
        # Extract callback metadata
        # ----------------------------------------------------

        callback_metadata = {}

        metadata = stk_callback.get(
            "CallbackMetadata",
            {}
        )

        items = metadata.get("Item", [])

        for item in items:
            name = item.get("Name")

            if name:
                callback_metadata[name] = item.get("Value")

        print("CALLBACK METADATA:")
        print(callback_metadata)

        mpesa_amount = callback_metadata.get("Amount")
        mpesa_receipt = callback_metadata.get(
            "MpesaReceiptNumber"
        )
        transaction_date = callback_metadata.get(
            "TransactionDate"
        )
        mpesa_phone = callback_metadata.get(
            "PhoneNumber"
        )

        # ----------------------------------------------------
        # Database
        # ----------------------------------------------------

        conn = get_db()

        try:
            payment_session = None

            # First try CheckoutRequestID
            if checkout_request_id:
                payment_session = conn.execute(
                    """
                    SELECT *
                    FROM payment_sessions
                    WHERE checkout_request_id = ?
                    LIMIT 1
                    """,
                    (checkout_request_id,),
                ).fetchone()

            # Fallback to MerchantRequestID
            if not payment_session and merchant_request_id:
                payment_session = conn.execute(
                    """
                    SELECT *
                    FROM payment_sessions
                    WHERE merchant_request_id = ?
                    LIMIT 1
                    """,
                    (merchant_request_id,),
                ).fetchone()

            if not payment_session:
                print(
                    "WARNING: PAYMENT SESSION NOT FOUND"
                )
                print(
                    "CheckoutRequestID:",
                    checkout_request_id
                )
                print(
                    "MerchantRequestID:",
                    merchant_request_id
                )

                print("============================================================")

                # We acknowledge the callback so the request
                # itself is not treated as malformed.
                return jsonify({
                    "ResultCode": 0,
                    "ResultDesc": "Accepted"
                })

            print("PAYMENT SESSION FOUND:")
            print(dict(payment_session))

            session_id = payment_session["session_id"]
            expected_amount = float(
                payment_session["amount"]
            )

            # ------------------------------------------------
            # Handle failed/cancelled STK
            # ------------------------------------------------

            if result_code != 0:

                print("M-PESA PAYMENT FAILED/CANCELLED")
                print("Session:", session_id)
                print("ResultCode:", result_code)
                print("ResultDesc:", result_desc)

                conn.execute(
                    """
                    UPDATE payment_sessions
                    SET
                        status = ?,
                        completed_at = ?
                    WHERE session_id = ?
                    """,
                    (
                        "failed",
                        now_string(),
                        session_id,
                    ),
                )

                conn.commit()

                print("PAYMENT SESSION MARKED FAILED")
                print("============================================================")

                return jsonify({
                    "ResultCode": 0,
                    "ResultDesc": "Accepted"
                })

            # ------------------------------------------------
            # Successful callback validation
            # ------------------------------------------------

            if result_code == 0:

                if mpesa_amount is None:
                    print(
                        "CALLBACK ERROR: Successful callback "
                        "has no Amount"
                    )

                    # Keep pending so it can be investigated.
                    conn.rollback()

                    return jsonify({
                        "ResultCode": 0,
                        "ResultDesc": "Accepted"
                    })

                try:
                    paid_amount = float(mpesa_amount)
                except (TypeError, ValueError):
                    print(
                        "CALLBACK ERROR: Invalid callback amount:",
                        mpesa_amount
                    )

                    conn.rollback()

                    return jsonify({
                        "ResultCode": 0,
                        "ResultDesc": "Accepted"
                    })

                print("EXPECTED AMOUNT:", expected_amount)
                print("M-PESA AMOUNT:", paid_amount)

                # ------------------------------------------------
                # Amount must match payment session
                # ------------------------------------------------

                if paid_amount != expected_amount:

                    print(
                        "CALLBACK ERROR: PAYMENT AMOUNT "
                        "DOES NOT MATCH SESSION"
                    )

                    conn.execute(
                        """
                        UPDATE payment_sessions
                        SET
                            status = ?,
                            completed_at = ?
                        WHERE session_id = ?
                        """,
                        (
                            "failed",
                            now_string(),
                            session_id,
                        ),
                    )

                    conn.commit()

                    return jsonify({
                        "ResultCode": 0,
                        "ResultDesc": "Accepted"
                    })

                # ------------------------------------------------
                # Receipt is required for successful credit
                # ------------------------------------------------

                if not mpesa_receipt:
                    print(
                        "CALLBACK ERROR: No M-Pesa receipt number"
                    )

                    conn.rollback()

                    return jsonify({
                        "ResultCode": 0,
                        "ResultDesc": "Accepted"
                    })

                # ------------------------------------------------
                # Check for duplicate transaction
                # ------------------------------------------------

                existing_transaction = conn.execute(
                    """
                    SELECT *
                    FROM mpesa_transactions
                    WHERE transaction_id = ?
                    LIMIT 1
                    """,
                    (str(mpesa_receipt),),
                ).fetchone()

                if existing_transaction:

                    print(
                        "DUPLICATE M-PESA TRANSACTION:",
                        mpesa_receipt
                    )

                    # If it belongs to this payment session,
                    # make sure the session is completed.
                    if (
                        existing_transaction["payment_session_id"]
                        == payment_session["session_id"]
                    ):

                        conn.execute(
                            """
                            UPDATE payment_sessions
                            SET
                                status = ?,
                                completed_at = ?
                            WHERE session_id = ?
                            """,
                            (
                                "completed",
                                now_string(),
                                session_id,
                            ),
                        )

                        conn.commit()

                        print(
                            "EXISTING TRANSACTION BELONGS "
                            "TO THIS SESSION."
                        )

                    else:

                        print(
                            "WARNING: RECEIPT ALREADY BELONGS "
                            "TO ANOTHER PAYMENT SESSION."
                        )

                    print(
                        "============================================================"
                    )

                    return jsonify({
                        "ResultCode": 0,
                        "ResultDesc": "Accepted"
                    })

                # ------------------------------------------------
                # Optional transaction date formatting
                # ------------------------------------------------

                formatted_transaction_time = None

                if transaction_date:
                    transaction_date = str(
                        transaction_date
                    )

                    try:
                        if len(transaction_date) == 14:
                            formatted_transaction_time = datetime.strptime(
                                transaction_date,
                                "%Y%m%d%H%M%S"
                            ).strftime(
                                "%Y-%m-%d %H:%M:%S"
                            )
                    except Exception:
                        formatted_transaction_time = None

                # ------------------------------------------------
                # Insert M-Pesa transaction
                # ------------------------------------------------

                print("INSERTING M-PESA TRANSACTION...")

                conn.execute(
                    """
                    INSERT INTO mpesa_transactions (
                        transaction_id,
                        payment_session_id,
                        student_id,
                        soma_hub_code,
                        amount,
                        transaction_type,
                        transaction_time,
                        mpesa_phone,
                        first_name,
                        middle_name,
                        last_name,
                        status,
                        created_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        str(mpesa_receipt),
                        payment_session["session_id"],
                        payment_session["student_id"],
                        payment_session["soma_hub_code"],
                        paid_amount,
                        "STK_PUSH",
                        formatted_transaction_time,
                        str(mpesa_phone)
                        if mpesa_phone
                        else None,
                        callback_metadata.get("FirstName"),
                        callback_metadata.get("MiddleName"),
                        callback_metadata.get("LastName"),
                        "completed",
                        now_string(),
                    ),
                )

                # ------------------------------------------------
                # Credit wallet
                # ------------------------------------------------

                print("CREDITING SOMA HUB WALLET...")

                conn.execute(
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
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        payment_session["student_id"],
                        payment_session["soma_hub_code"],
                        paid_amount,
                        "CREDIT",
                        str(mpesa_receipt),
                        "M-Pesa wallet deposit",
                        now_string(),
                    ),
                )

                # ------------------------------------------------
                # Complete payment session
                # ------------------------------------------------

                conn.execute(
                    """
                    UPDATE payment_sessions
                    SET
                        status = ?,
                        completed_at = ?
                    WHERE session_id = ?
                    """,
                    (
                        "completed",
                        now_string(),
                        session_id,
                    ),
                )

                # ------------------------------------------------
                # ATOMIC COMMIT
                # ------------------------------------------------

                conn.commit()

                # Calculate balance AFTER commit
                wallet_balance = calculate_wallet_balance(
                    conn,
                    payment_session["soma_hub_code"]
                )

                print("------------------------------------------------------------")
                print("M-PESA PAYMENT COMPLETED SUCCESSFULLY")
                print("Session:", session_id)
                print(
                    "SOMA HUB CODE:",
                    payment_session["soma_hub_code"]
                )
                print("Amount credited:", paid_amount)
                print("M-Pesa receipt:", mpesa_receipt)
                print("Wallet balance:", wallet_balance)
                print("------------------------------------------------------------")
                print("============================================================")

                # Separate transaction: the credit above stands
                # even if this fails.
                coins_bp.fulfil_payment_purpose(session_id)

                return jsonify({
                    "ResultCode": 0,
                    "ResultDesc": "Accepted"
                })

        except sqlite3.IntegrityError as e:
            conn.rollback()

            print(
                "DATABASE INTEGRITY ERROR WHILE PROCESSING "
                "M-PESA CALLBACK:"
            )
            print(str(e))
            print("============================================================")

            # Keep the payment pending rather than falsely
            # claiming it was successfully credited.
            return jsonify({
                "ResultCode": 1,
                "ResultDesc": "Database processing error"
            }), 500

        except Exception as e:
            conn.rollback()

            print(
                "CRITICAL ERROR WHILE PROCESSING "
                "M-PESA CALLBACK:"
            )
            print(str(e))

            import traceback
            traceback.print_exc()

            print("============================================================")

            return jsonify({
                "ResultCode": 1,
                "ResultDesc": "Callback processing error"
            }), 500

        finally:
            conn.close()

    except Exception as e:

        print("CRITICAL CALLBACK PARSING ERROR:")
        print(str(e))

        import traceback
        traceback.print_exc()

        print("============================================================")

        return jsonify({
            "ResultCode": 1,
            "ResultDesc": "Callback processing error"
        }), 500


# ============================================================
# PAYMENT STATUS
# ============================================================

@app.route("/api/mpesa/payment-status/<session_id>", methods=["GET"])
def payment_status(session_id):

    session_id = session_id.strip()

    conn = get_db()

    try:

        payment_session = conn.execute(
            """
            SELECT *
            FROM payment_sessions
            WHERE session_id = ?
            LIMIT 1
            """,
            (session_id,),
        ).fetchone()

        if not payment_session:
            return jsonify({
                "success": False,
                "message": "Payment session not found"
            }), 404

        soma_hub_code = payment_session[
            "soma_hub_code"
        ]

        # ----------------------------------------------------
        # Safety repair:
        # If the wallet transaction exists but the session
        # was somehow left pending, mark it completed.
        # ----------------------------------------------------

        wallet_transaction = conn.execute(
            """
            SELECT *
            FROM wallet_transactions
            WHERE reference IN (
                SELECT transaction_id
                FROM mpesa_transactions
                WHERE payment_session_id = ?
            )
            LIMIT 1
            """,
            (payment_session["session_id"],),
        ).fetchone()

        if (
            wallet_transaction
            and payment_session["status"] != "completed"
        ):

            conn.execute(
                """
                UPDATE payment_sessions
                SET
                    status = ?,
                    completed_at = ?
                WHERE session_id = ?
                """,
                (
                    "completed",
                    now_string(),
                    session_id,
                ),
            )

            conn.commit()

            payment_session = conn.execute(
                """
                SELECT *
                FROM payment_sessions
                WHERE session_id = ?
                LIMIT 1
                """,
                (session_id,),
            ).fetchone()

        # ----------------------------------------------------
        # Expire sessions the customer never completed.
        # A late successful callback still credits the wallet,
        # because the callback looks sessions up by request ID.
        # ----------------------------------------------------

        if (
            payment_session["status"] == "pending"
            and payment_session["expires_at"]
            and payment_session["expires_at"] < now_string()
        ):

            conn.execute(
                """
                UPDATE payment_sessions
                SET status = ?
                WHERE session_id = ?
                """,
                ("expired", session_id),
            )

            conn.commit()

            payment_session = conn.execute(
                """
                SELECT *
                FROM payment_sessions
                WHERE session_id = ?
                LIMIT 1
                """,
                (session_id,),
            ).fetchone()

        # Retry the purpose if the callback credited the wallet
        # but didn't get to finish it.
        if (
            payment_session["status"] == "completed"
            and payment_session["purpose"]
            and not payment_session["purpose_result"]
        ):
            coins_bp.fulfil_payment_purpose(session_id)

            payment_session = conn.execute(
                """
                SELECT *
                FROM payment_sessions
                WHERE session_id = ?
                LIMIT 1
                """,
                (session_id,),
            ).fetchone()

        wallet_balance = calculate_wallet_balance(
            conn,
            soma_hub_code
        )

        transaction = conn.execute(
            """
            SELECT
                transaction_id,
                amount,
                transaction_type,
                transaction_time,
                mpesa_phone,
                status,
                created_at
            FROM mpesa_transactions
            WHERE payment_session_id = ?
            ORDER BY id DESC
            LIMIT 1
            """,
            (payment_session["session_id"],),
        ).fetchone()

        return jsonify({
            "success": True,
            "session_id": payment_session["session_id"],
            "soma_hub_code": payment_session["soma_hub_code"],
            "amount": payment_session["amount"],
            "status": payment_session["status"],
            "checkout_request_id": payment_session[
                "checkout_request_id"
            ],
            "merchant_request_id": payment_session[
                "merchant_request_id"
            ],
            "created_at": payment_session["created_at"],
            "expires_at": payment_session["expires_at"],
            "purpose": payment_session["purpose"],
            "purpose_result": payment_session["purpose_result"],
            "completed_at": payment_session["completed_at"],
            "wallet_balance": wallet_balance,
            "transaction": (
                dict(transaction)
                if transaction
                else None
            ),
        })

    finally:
        conn.close()


# ============================================================
# WALLET
# ============================================================

@app.route("/api/wallet/<soma_hub_code>", methods=["GET"])
def get_wallet(soma_hub_code):

    soma_hub_code = soma_hub_code.strip()

    conn = get_db()

    try:
        student = conn.execute(
            """
            SELECT
                id,
                soma_hub_code,
                name
            FROM students
            WHERE soma_hub_code = ?
            """,
            (soma_hub_code,),
        ).fetchone()

        if not student:
            return jsonify({
                "success": False,
                "message": "Student not found"
            }), 404

        balance = calculate_wallet_balance(
            conn,
            soma_hub_code
        )

        transactions = conn.execute(
            """
            SELECT
                id,
                amount,
                transaction_type,
                reference,
                description,
                created_at
            FROM wallet_transactions
            WHERE soma_hub_code = ?
            ORDER BY id DESC
            LIMIT 50
            """,
            (soma_hub_code,),
        ).fetchall()

        return jsonify({
            "success": True,
            "soma_hub_code": soma_hub_code,
            "balance": balance,
            "transactions": [
                dict(transaction)
                for transaction in transactions
            ],
        })

    finally:
        conn.close()


# ============================================================
# DEVELOPMENT TEST PAYMENT
# ============================================================

@app.route("/api/dev/test-payment/<session_id>", methods=["POST"])
def dev_test_payment(session_id):

    # Never allow this in production
    if MPESA_ENVIRONMENT != "sandbox":
        return jsonify({
            "success": False,
            "message": "Development test payment is disabled in production"
        }), 403

    session_id = session_id.strip()

    conn = get_db()

    try:

        payment_session = conn.execute(
            """
            SELECT *
            FROM payment_sessions
            WHERE session_id = ?
            LIMIT 1
            """,
            (session_id,),
        ).fetchone()

        if not payment_session:
            return jsonify({
                "success": False,
                "message": "Payment session not found"
            }), 404

        if payment_session["status"] == "completed":
            balance = calculate_wallet_balance(
                conn,
                payment_session["soma_hub_code"]
            )

            return jsonify({
                "success": True,
                "message": "Payment session is already completed",
                "session_id": session_id,
                "wallet_balance": balance,
            })

        fake_receipt = (
            "DEV"
            + uuid.uuid4().hex[:10].upper()
        )

        amount = float(
            payment_session["amount"]
        )

        # Insert test M-Pesa transaction
        conn.execute(
            """
            INSERT INTO mpesa_transactions (
                transaction_id,
                payment_session_id,
                student_id,
                soma_hub_code,
                amount,
                transaction_type,
                transaction_time,
                mpesa_phone,
                first_name,
                middle_name,
                last_name,
                status,
                created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                fake_receipt,
                payment_session["session_id"],
                payment_session["student_id"],
                payment_session["soma_hub_code"],
                amount,
                "DEV_TEST",
                now_string(),
                None,
                None,
                None,
                None,
                "completed",
                now_string(),
            ),
        )

        # Credit wallet
        conn.execute(
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
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                payment_session["student_id"],
                payment_session["soma_hub_code"],
                amount,
                "CREDIT",
                fake_receipt,
                "Development test wallet deposit",
                now_string(),
            ),
        )

        # Complete session
        conn.execute(
            """
            UPDATE payment_sessions
            SET
                status = ?,
                completed_at = ?
            WHERE session_id = ?
            """,
            (
                "completed",
                now_string(),
                session_id,
            ),
        )

        conn.commit()

        balance = calculate_wallet_balance(
            conn,
            payment_session["soma_hub_code"]
        )

        print("============================================")
        print("DEVELOPMENT TEST PAYMENT COMPLETED")
        print("Session:", session_id)
        print("Amount:", amount)
        print("Receipt:", fake_receipt)
        print("Wallet balance:", balance)
        print("============================================")

        purpose_result = coins_bp.fulfil_payment_purpose(session_id)

        return jsonify({
            "purpose_result": purpose_result,
            "success": True,
            "message": "Development test payment completed",
            "session_id": session_id,
            "amount": amount,
            "reference": fake_receipt,
            "wallet_balance": balance,
        })

    except sqlite3.IntegrityError as e:
        conn.rollback()

        return jsonify({
            "success": False,
            "message": "Could not process development payment",
            "error": str(e),
        }), 500

    except Exception as e:
        conn.rollback()

        return jsonify({
            "success": False,
            "message": "Could not process development payment",
            "error": str(e),
        }), 500

    finally:
        conn.close()


# ============================================================
# LEGACY STK PUSH ROUTE
# ============================================================

@app.route("/api/mpesa/stk-push", methods=["POST"])
def legacy_stk_push():

    data = request.get_json(silent=True) or {}

    phone_number = data.get("phone_number")
    amount = data.get("amount")
    account_reference = data.get(
        "account_reference",
        "SOMA-HUB"
    )

    normalized_phone = normalize_mpesa_phone(
        phone_number
    )

    if not normalized_phone:
        return jsonify({
            "success": False,
            "message": "A valid M-Pesa phone number is required"
        }), 400

    try:
        amount = float(amount)
    except (TypeError, ValueError):
        return jsonify({
            "success": False,
            "message": "A valid amount is required"
        }), 400

    if amount <= 0:
        return jsonify({
            "success": False,
            "message": "Amount must be greater than zero"
        }), 400

    try:
        access_token = get_mpesa_access_token()

        timestamp = datetime.now().strftime(
            "%Y%m%d%H%M%S"
        )

        password = generate_mpesa_password(
            timestamp
        )

        stk_url = (
            MPESA_BASE_URL
            + "/mpesa/stkpush/v1/processrequest"
        )

        payload = {
            "BusinessShortCode": MPESA_SHORTCODE,
            "Password": password,
            "Timestamp": timestamp,
            "TransactionType": "CustomerPayBillOnline",
            "Amount": int(amount),
            "PartyA": normalized_phone,
            "PartyB": MPESA_SHORTCODE,
            "PhoneNumber": normalized_phone,
            "CallBackURL": MPESA_CALLBACK_URL,
            "AccountReference": account_reference,
            "TransactionDesc": "SOMA HUB payment",
        }

        headers = {
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json",
        }

        response = requests.post(
            stk_url,
            json=payload,
            headers=headers,
            timeout=30,
        )

        try:
            result = response.json()
        except Exception:
            result = {
                "raw_response": response.text
            }

        return jsonify({
            "success": response.status_code == 200,
            "mpesa_response": result,
        }), response.status_code

    except Exception as e:

        print("LEGACY STK PUSH ERROR:", str(e))

        return jsonify({
            "success": False,
            "message": str(e)
        }), 500


# ============================================================
# RUN FLASK
# ============================================================

# ============================================================
# COINS AND UNLOCKS
# ============================================================

coins_bp = create_coins_blueprint(
    get_db=get_db,
    now_string=now_string,
    calculate_wallet_balance=calculate_wallet_balance,
    is_sandbox=lambda: MPESA_ENVIRONMENT == "sandbox",
)

app.register_blueprint(coins_bp)


if __name__ == "__main__":
    # Creates any tables added since this database was made.
    database.DATABASE_PATH = DB_PATH
    database.init_database()

    print("")
    print("============================================================")
    print("                 SOMA HUB BACKEND")
    print("============================================================")
    print("Database:", DB_PATH)
    print("M-Pesa environment:", MPESA_ENVIRONMENT)
    print("M-Pesa shortcode:", MPESA_SHORTCODE)
    print("M-Pesa callback configured:", bool(MPESA_CALLBACK_URL))
    print("============================================================")
    print("Flask running at http://127.0.0.1:5000")
    print("============================================================")
    print("")

    app.run(
        host="127.0.0.1",
        port=5000,   
        debug=False,
        use_reloader=False

    )