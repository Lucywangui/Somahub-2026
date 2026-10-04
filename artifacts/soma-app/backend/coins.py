"""
SOMA HUB wallet-backed points and material unlocks.

SOMA Points are now exactly equal to the student's paid wallet balance:

    KSh 50 paid -> 50 SOMA Points
    KSh 20 spent -> 20 SOMA Points remaining

The wallet_transactions ledger is the source of truth.
There are no free starting points, quiz rewards, or coin purchases.

This version uses PostgreSQL/Neon.
"""

import os
import re
from datetime import datetime, timedelta

from flask import Blueprint, jsonify, request


# ============================================================
# PRICING
# ============================================================

MATERIAL_PRICE_KSH = int(
    os.getenv("MATERIAL_PRICE_KSH", "5")
)

SUBSCRIPTION_PRICE_KSH = int(
    os.getenv("SUBSCRIPTION_PRICE_KSH", "100")
)

SUBSCRIPTION_DAYS = int(
    os.getenv("SUBSCRIPTION_DAYS", "30")
)

# Kept for frontend compatibility.
# Points are now always equal to KSh wallet balance.
KSH_PER_COIN = 1

ID_PATTERN = re.compile(
    r"[A-Za-z0-9_:.\\-]{1,120}"
)

TIME_FORMAT = "%Y-%m-%d %H:%M:%S"

MAX_IMPORTED_UNLOCKS = 1000


# ============================================================
# HELPERS
# ============================================================

def covers(grade_key, material_id):
    return (
        bool(grade_key)
        and material_id.startswith(grade_key + "-")
    )


def error(message, status, **extra):
    return jsonify({
        "success": False,
        "message": message,
        **extra,
    }), status


def create_coins_blueprint(
    get_db,
    now_string,
    calculate_wallet_balance,
    is_sandbox,
):
    bp = Blueprint("coins", __name__)

    # ========================================================
    # STUDENT
    # ========================================================

    def find_student(conn, soma_hub_code):
        return conn.execute(
            """
            SELECT id, soma_hub_code, grade
            FROM students
            WHERE soma_hub_code = %s
            """,
            (soma_hub_code,),
        ).fetchone()

    # ========================================================
    # LOCK STUDENT
    #
    # This lock is used for wallet spending operations.
    #
    # It prevents two simultaneous purchases for the same
    # student from both reading the same wallet balance.
    # ========================================================

    def lock_student(conn, student_id):
        return conn.execute(
            """
            SELECT id, soma_hub_code, grade
            FROM students
            WHERE id = %s
            FOR UPDATE
            """,
            (student_id,),
        ).fetchone()

    # ========================================================
    # LEGACY COIN BALANCE
    #
    # Kept only for backwards compatibility with old database
    # records. It is NOT used for material payments anymore.
    # ========================================================

    def legacy_coin_balance(conn, soma_hub_code):
        row = conn.execute(
            """
            SELECT COALESCE(SUM(amount), 0) AS balance
            FROM coin_transactions
            WHERE soma_hub_code = %s
            """,
            (soma_hub_code,),
        ).fetchone()

        return int(row["balance"])

    # ========================================================
    # WALLET BALANCE
    #
    # THIS IS NOW THE SOURCE OF TRUTH.
    # ========================================================

    def ksh_balance(conn, soma_hub_code):
        return int(
            round(
                calculate_wallet_balance(
                    conn,
                    soma_hub_code,
                )
            )
        )

    # ========================================================
    # SUBSCRIPTIONS
    #
    # Legacy support only.
    # New IntaSend payment sessions cannot create subscriptions.
    # ========================================================

    def active_subscriptions(conn, soma_hub_code):
        return conn.execute(
            """
            SELECT
                grade_key,
                MAX(expires_at) AS expires_at
            FROM subscriptions
            WHERE soma_hub_code = %s
              AND expires_at > %s
            GROUP BY grade_key
            """,
            (
                soma_hub_code,
                now_string(),
            ),
        ).fetchall()

    def subscription_covering(
        conn,
        soma_hub_code,
        material_id,
    ):
        for row in active_subscriptions(
            conn,
            soma_hub_code,
        ):
            if covers(
                row["grade_key"],
                material_id,
            ):
                return row

        return None

    def subscription_summary(
        conn,
        soma_hub_code,
    ):
        grade_row = conn.execute(
            """
            SELECT grade
            FROM students
            WHERE soma_hub_code = %s
            """,
            (soma_hub_code,),
        ).fetchone()

        grade = (
            grade_row["grade"]
            if grade_row
            else None
        )

        row = conn.execute(
            """
            SELECT
                grade_key,
                MAX(expires_at) AS expires_at
            FROM subscriptions
            WHERE soma_hub_code = %s
            GROUP BY grade_key
            ORDER BY
                (grade_key = %s) DESC,
                MAX(expires_at) DESC
            LIMIT 1
            """,
            (
                soma_hub_code,
                grade,
            ),
        ).fetchone()

        if not row:
            return None

        return {
            "grade_key": row["grade_key"],
            "expires_at": row["expires_at"],
            "active": row["expires_at"] > now_string(),
        }

    # ========================================================
    # ACCOUNT PAYLOAD
    #
    # "coins" is kept in the response because the existing
    # frontend expects it.
    #
    # IMPORTANT:
    # coins == ksh == actual paid wallet balance.
    # ========================================================

    def account_payload(
        conn,
        soma_hub_code,
    ):
        unlocked = conn.execute(
            """
            SELECT material_id
            FROM material_unlocks
            WHERE soma_hub_code = %s
            ORDER BY id
            """,
            (soma_hub_code,),
        ).fetchall()

        wallet = ksh_balance(
            conn,
            soma_hub_code,
        )

        imported = conn.execute(
            """
            SELECT 1
            FROM coin_transactions
            WHERE soma_hub_code = %s
              AND transaction_type = 'IMPORT'
            LIMIT 1
            """,
            (soma_hub_code,),
        ).fetchone()

        return {
            "coins": wallet,
            "ksh": wallet,

            "unlocked": [
                row["material_id"]
                for row in unlocked
            ],

            "earned_today": 0,

            "imported": bool(imported),

            "prices": {
                "material_coins": MATERIAL_PRICE_KSH,
                "ksh_per_coin": 1,
                "daily_cap": 0,

                # Kept for frontend compatibility.
                "subscription_ksh": (
                    SUBSCRIPTION_PRICE_KSH
                ),

                "subscription_days": (
                    SUBSCRIPTION_DAYS
                ),
            },

            "subscription": subscription_summary(
                conn,
                soma_hub_code,
            ),
        }

    # ========================================================
    # LEGACY COIN LEDGER
    #
    # Kept so old database records/endpoints do not break.
    # New real-money balances must NOT be created here.
    # ========================================================

    def add_coins(
        conn,
        student,
        amount,
        transaction_type,
        reference,
        description,
    ):
        conn.execute(
            """
            INSERT INTO coin_transactions (
                student_id,
                soma_hub_code,
                amount,
                transaction_type,
                reference,
                description,
                created_at
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            """,
            (
                student["id"],
                student["soma_hub_code"],
                amount,
                transaction_type,
                reference,
                description,
                now_string(),
            ),
        )

    # ========================================================
    # WALLET DEBIT
    # ========================================================

    def debit_ksh(
        conn,
        student,
        amount,
        reference,
        description,
    ):
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
            VALUES (
                %s,
                %s,
                %s,
                'DEBIT',
                %s,
                %s,
                %s
            )
            """,
            (
                student["id"],
                student["soma_hub_code"],
                -abs(int(amount)),
                reference,
                description,
                now_string(),
            ),
        )

    # ========================================================
    # LEGACY REFERENCE CHECK
    # ========================================================

    def reference_exists(
        conn,
        reference,
    ):
        coin_exists = conn.execute(
            """
            SELECT 1
            FROM coin_transactions
            WHERE reference = %s
            LIMIT 1
            """,
            (reference,),
        ).fetchone()

        if coin_exists:
            return True

        wallet_exists = conn.execute(
            """
            SELECT 1
            FROM wallet_transactions
            WHERE reference = %s
            LIMIT 1
            """,
            (reference,),
        ).fetchone()

        return wallet_exists is not None

    # ========================================================
    # REQUEST HELPERS
    # ========================================================

    def read_body():
        data = request.get_json(
            silent=True
        ) or {}

        code = str(
            data.get(
                "soma_hub_code",
                "",
            )
        ).strip().upper()

        return data, code

    def with_student(handler):
        def wrapper(*args, **kwargs):
            data, code = read_body()

            if not code:
                return error(
                    "SOMA HUB code is required",
                    400,
                )

            conn = get_db()

            try:
                student = find_student(
                    conn,
                    code,
                )

                if not student:
                    return error(
                        "Student not found",
                        404,
                    )

                return handler(
                    conn,
                    student,
                    data,
                    *args,
                    **kwargs,
                )

            except Exception:
                conn.rollback()
                raise

            finally:
                conn.close()

        wrapper.__name__ = handler.__name__

        return wrapper

    # ========================================================
    # GET ACCOUNT
    # ========================================================

    @bp.route(
        "/api/account/<soma_hub_code>",
        methods=["GET"],
    )
    def get_account(soma_hub_code):
        conn = get_db()

        try:
            code = soma_hub_code.strip().upper()

            if not find_student(
                conn,
                code,
            ):
                return error(
                    "Student not found",
                    404,
                )

            return jsonify({
                "success": True,
                **account_payload(
                    conn,
                    code,
                ),
            })

        finally:
            conn.close()

    # ========================================================
    # IMPORT OLD LOCAL ACCOUNT DATA
    #
    # We DO NOT import old coins.
    #
    # We only preserve previously unlocked materials.
    # ========================================================

    @bp.route(
        "/api/account/import",
        methods=["POST"],
    )
    @with_student
    def import_account(
        conn,
        student,
        data,
    ):
        code = student["soma_hub_code"]

        unlocked = data.get(
            "unlocked"
        ) or []

        if not isinstance(
            unlocked,
            list,
        ):
            unlocked = []

        for material_id in unlocked[
            :MAX_IMPORTED_UNLOCKS
        ]:
            material_id = str(
                material_id
            ).strip()

            if not ID_PATTERN.fullmatch(
                material_id
            ):
                continue

            conn.execute(
                """
                INSERT INTO material_unlocks (
                    student_id,
                    soma_hub_code,
                    material_id,
                    created_at
                )
                VALUES (
                    %s,
                    %s,
                    %s,
                    %s
                )
                ON CONFLICT (
                    student_id,
                    material_id
                )
                DO NOTHING
                """,
                (
                    student["id"],
                    code,
                    material_id,
                    now_string(),
                ),
            )

        conn.commit()

        return jsonify({
            "success": True,
            **account_payload(
                conn,
                code,
            ),
        })

    # ========================================================
    # MATERIAL UNLOCK
    #
    # MAIN ECONOMY:
    #
    # Wallet = KSh 50
    # Material = KSh 5
    # After unlock = KSh 45
    #
    # SOMA Points:
    # 50 -> 45
    # ========================================================

    def perform_unlock(
        conn,
        student,
        material_id,
        allow_ksh=True,
    ):
        code = student["soma_hub_code"]

        # ----------------------------------------------------
        # IMPORTANT CONCURRENCY LOCK
        #
        # Lock the student's row before reading the wallet.
        #
        # This makes concurrent purchases for the same student
        # execute one at a time.
        # ----------------------------------------------------

        locked_student = lock_student(
            conn,
            student["id"],
        )

        if not locked_student:
            return 404, {
                "message": "Student not found"
            }

        student = locked_student
        code = student["soma_hub_code"]

        # ----------------------------------------------------
        # Already unlocked?
        # ----------------------------------------------------

        already = conn.execute(
            """
            SELECT 1
            FROM material_unlocks
            WHERE student_id = %s
              AND material_id = %s
            FOR UPDATE
            """,
            (
                student["id"],
                material_id,
            ),
        ).fetchone()

        if already:
            return 200, {
                "already_unlocked": True,
                "via_subscription": False,
                "coins_spent": 0,
                "ksh_spent": 0,
            }

        # ----------------------------------------------------
        # Active legacy subscription?
        # ----------------------------------------------------

        if subscription_covering(
            conn,
            code,
            material_id,
        ):
            return 200, {
                "already_unlocked": False,
                "via_subscription": True,
                "coins_spent": 0,
                "ksh_spent": 0,
            }

        # ----------------------------------------------------
        # Wallet is the ONLY source of usable points.
        # ----------------------------------------------------

        price = MATERIAL_PRICE_KSH

        wallet = ksh_balance(
            conn,
            code,
        )

        if wallet < price:
            return 402, {
                "message": (
                    "Not enough balance. "
                    "Please add funds to your wallet."
                ),
                "coins": wallet,
                "ksh": wallet,
                "price": price,
                "shortfall_coins": (
                    price - wallet
                ),
                "ksh_needed": (
                    price - wallet
                ),
                "can_pay_with_ksh": False,
            }

        reference = (
            f"UNLOCK-{code}-{material_id}"
        )

        # ----------------------------------------------------
        # Prevent duplicate debit.
        # ----------------------------------------------------

        existing_payment = conn.execute(
            """
            SELECT id
            FROM wallet_transactions
            WHERE reference = %s
              AND transaction_type = 'DEBIT'
            LIMIT 1
            FOR UPDATE
            """,
            (reference,),
        ).fetchone()

        if existing_payment:
            existing_unlock = conn.execute(
                """
                SELECT 1
                FROM material_unlocks
                WHERE student_id = %s
                  AND material_id = %s
                LIMIT 1
                """,
                (
                    student["id"],
                    material_id,
                ),
            ).fetchone()

            if not existing_unlock:
                conn.execute(
                    """
                    INSERT INTO material_unlocks (
                        student_id,
                        soma_hub_code,
                        material_id,
                        coins_spent,
                        ksh_spent,
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
                    ON CONFLICT (
                        student_id,
                        material_id
                    )
                    DO NOTHING
                    """,
                    (
                        student["id"],
                        code,
                        material_id,
                        price,
                        price,
                        now_string(),
                    ),
                )

            return 200, {
                "already_unlocked": True,
                "via_subscription": False,
                "coins_spent": 0,
                "ksh_spent": 0,
            }

        # ----------------------------------------------------
        # Deduct REAL wallet balance.
        #
        # Student row is already locked above, so another
        # concurrent purchase cannot pass the same balance
        # check for this student.
        # ----------------------------------------------------

        debit_ksh(
            conn,
            student,
            price,
            reference,
            f"Unlocked {material_id}",
        )

        # ----------------------------------------------------
        # Record the unlock.
        # ----------------------------------------------------

        unlock_cursor = conn.execute(
            """
            INSERT INTO material_unlocks (
                student_id,
                soma_hub_code,
                material_id,
                coins_spent,
                ksh_spent,
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
            ON CONFLICT (
                student_id,
                material_id
            )
            DO NOTHING
            RETURNING id
            """,
            (
                student["id"],
                code,
                material_id,
                price,
                price,
                now_string(),
            ),
        )

        inserted_unlock = unlock_cursor.fetchone()

        # This should normally always insert because the
        # student's row is locked. Keep the safeguard anyway.
        if not inserted_unlock:
            conn.execute(
                """
                DELETE FROM wallet_transactions
                WHERE reference = %s
                  AND transaction_type = 'DEBIT'
                """,
                (reference,),
            )

            return 200, {
                "already_unlocked": True,
                "via_subscription": False,
                "coins_spent": 0,
                "ksh_spent": 0,
            }

        return 200, {
            "already_unlocked": False,
            "via_subscription": False,
            "coins_spent": price,
            "ksh_spent": price,
        }

    # ========================================================
    # LEGACY SUBSCRIPTION
    #
    # Kept for compatibility with existing old data/routes.
    # New IntaSend payment sessions are NOT allowed to create
    # subscriptions.
    # ========================================================

    def perform_subscribe(
        conn,
        student,
        reference,
    ):
        code = student["soma_hub_code"]

        grade_key = (
            student["grade"] or ""
        ).strip()

        if not grade_key:
            return 400, {
                "message": (
                    "Choose your grade before subscribing"
                )
            }

        existing = conn.execute(
            """
            SELECT grade_key, expires_at
            FROM subscriptions
            WHERE reference = %s
            """,
            (reference,),
        ).fetchone()

        if existing:
            return 200, {
                "duplicate": True,
                "ksh_spent": 0,
            }

        # Lock the student before checking and spending wallet.
        locked_student = lock_student(
            conn,
            student["id"],
        )

        if not locked_student:
            return 404, {
                "message": "Student not found"
            }

        student = locked_student

        wallet = ksh_balance(
            conn,
            code,
        )

        if wallet < SUBSCRIPTION_PRICE_KSH:
            return 402, {
                "message": (
                    "Not enough KSh in your wallet"
                ),
                "ksh": wallet,
                "ksh_needed": (
                    SUBSCRIPTION_PRICE_KSH
                    - wallet
                ),
                "price_ksh": (
                    SUBSCRIPTION_PRICE_KSH
                ),
            }

        current = conn.execute(
            """
            SELECT MAX(expires_at) AS expires_at
            FROM subscriptions
            WHERE soma_hub_code = %s
              AND grade_key = %s
              AND expires_at > %s
            """,
            (
                code,
                grade_key,
                now_string(),
            ),
        ).fetchone()["expires_at"]

        starts_at = (
            current
            or now_string()
        )

        expires_at = (
            datetime.strptime(
                starts_at,
                TIME_FORMAT,
            )
            + timedelta(
                days=SUBSCRIPTION_DAYS
            )
        ).strftime(
            TIME_FORMAT
        )

        debit_ksh(
            conn,
            student,
            SUBSCRIPTION_PRICE_KSH,
            reference,
            (
                f"{SUBSCRIPTION_DAYS}-day "
                f"subscription for {grade_key}"
            ),
        )

        conn.execute(
            """
            INSERT INTO subscriptions (
                student_id,
                soma_hub_code,
                grade_key,
                starts_at,
                expires_at,
                ksh_paid,
                reference,
                created_at
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
                student["id"],
                code,
                grade_key,
                starts_at,
                expires_at,
                SUBSCRIPTION_PRICE_KSH,
                reference,
                now_string(),
            ),
        )

        return 200, {
            "duplicate": False,
            "ksh_spent": (
                SUBSCRIPTION_PRICE_KSH
            ),
        }

    # ========================================================
    # COMMON RESPONSE
    # ========================================================

    def respond(
        conn,
        student,
        status,
        body,
    ):
        if status == 200:
            conn.commit()

            return jsonify({
                "success": True,
                **body,
                **account_payload(
                    conn,
                    student["soma_hub_code"],
                ),
            })

        conn.rollback()

        return jsonify({
            "success": False,
            **body,
        }), status

    # ========================================================
    # UNLOCK MATERIAL
    # ========================================================

    @bp.route(
        "/api/unlocks",
        methods=["POST"],
    )
    @with_student
    def unlock_material(
        conn,
        student,
        data,
    ):
        material_id = str(
            data.get(
                "material_id",
                "",
            )
        ).strip()

        if not ID_PATTERN.fullmatch(
            material_id
        ):
            return error(
                "A valid material ID is required",
                400,
            )

        status, body = perform_unlock(
            conn,
            student,
            material_id,
            allow_ksh=True,
        )

        return respond(
            conn,
            student,
            status,
            body,
        )

    # ========================================================
    # LEGACY SUBSCRIBE ENDPOINT
    #
    # Existing frontend compatibility only.
    # New IntaSend payment flow does not call this.
    # ========================================================

    @bp.route(
        "/api/subscriptions",
        methods=["POST"],
    )
    @with_student
    def subscribe(
        conn,
        student,
        data,
    ):
        request_id = str(
            data.get(
                "request_id",
                "",
            )
        ).strip()

        if not ID_PATTERN.fullmatch(
            request_id
        ):
            return error(
                "A request ID is required",
                400,
            )

        status, body = perform_subscribe(
            conn,
            student,
            f"SUB-{request_id}",
        )

        return respond(
            conn,
            student,
            status,
            body,
        )

    # ========================================================
    # OLD BUY-COINS ENDPOINT
    #
    # Coins are no longer purchased separately.
    # Money goes directly into the wallet and becomes points.
    # ========================================================

    @bp.route(
        "/api/coins/buy",
        methods=["POST"],
    )
    @with_student
    def buy_coins(
        conn,
        student,
        data,
    ):
        conn.rollback()

        return error(
            (
                "Buying SOMA Coins separately is no longer "
                "available. Add funds to your wallet instead."
            ),
            410,
        )

    # ========================================================
    # OLD QUIZ REWARD ENDPOINT
    #
    # No free points are awarded for quizzes anymore.
    # ========================================================

    @bp.route(
        "/api/coins/reward",
        methods=["POST"],
    )
    @with_student
    def claim_reward(
        conn,
        student,
        data,
    ):
        return jsonify({
            "success": True,
            "reward_disabled": True,
            "coins_awarded": 0,
            "message": (
                "SOMA Points come from paid wallet funds."
            ),
            **account_payload(
                conn,
                student["soma_hub_code"],
            ),
        })

    # ========================================================
    # DEVELOPMENT GRANT
    #
    # Disabled completely because points must come from
    # actual paid wallet funds.
    # ========================================================

    @bp.route(
        "/api/dev/grant-coins",
        methods=["POST"],
    )
    @with_student
    def dev_grant_coins(
        conn,
        student,
        data,
    ):
        conn.rollback()

        return error(
            (
                "Free development points are disabled. "
                "SOMA Points come from paid wallet funds."
            ),
            403,
        )

    # ========================================================
    # PAYMENT PURPOSE FULFILMENT
    #
    # Called after a successful payment.
    #
    # IMPORTANT:
    # The payment session is locked before checking
    # purpose_result.
    #
    # This prevents simultaneous webhook/status requests
    # from fulfilling the same payment twice.
    #
    # Current supported real-money purpose:
    #
    #     topup
    #
    # Material unlock purposes are retained for compatibility
    # with any existing sessions.
    # ========================================================

    def fulfil_payment_purpose(
        session_id,
    ):
        conn = get_db()

        try:
            # ------------------------------------------------
            # LOCK PAYMENT SESSION
            # ------------------------------------------------
            #
            # Webhook, payment-status and development payment
            # calls can arrive at nearly the same time.
            #
            # FOR UPDATE ensures only one fulfilment transaction
            # handles this session at a time.
            # ------------------------------------------------

            session = conn.execute(
                """
                SELECT *
                FROM payment_sessions
                WHERE session_id = %s
                FOR UPDATE
                """,
                (session_id,),
            ).fetchone()

            if not session:
                conn.rollback()
                return None

            # ------------------------------------------------
            # Already fulfilled.
            # ------------------------------------------------

            if session["purpose_result"]:
                result = session["purpose_result"]
                conn.commit()
                return result

            purpose = session["purpose"]

            # ------------------------------------------------
            # Normal wallet top-up.
            #
            # process_completed_payment() already credited the
            # wallet. There is nothing else to debit/unlock.
            # ------------------------------------------------

            if not purpose or purpose == "topup":
                result = "done"

            else:
                student = find_student(
                    conn,
                    session["soma_hub_code"],
                )

                if not student:
                    result = "failed: Student not found"

                elif purpose.startswith(
                    "unlock:"
                ):
                    material_id = purpose[
                        len("unlock:"):
                    ]

                    if not ID_PATTERN.fullmatch(
                        material_id
                    ):
                        result = (
                            "failed: Invalid material ID"
                        )

                    else:
                        status, body = perform_unlock(
                            conn,
                            student,
                            material_id,
                            allow_ksh=True,
                        )

                        if status == 200:
                            result = "done"
                        else:
                            result = (
                                f"failed: "
                                f"{body.get('message', 'unknown error')}"
                            )

                elif purpose == "subscribe":
                    # ------------------------------------------------
                    # Subscription fulfilment is retained ONLY for
                    # old already-created sessions.
                    #
                    # New payment sessions are prevented from using
                    # this purpose by app.py.
                    # ------------------------------------------------

                    status, body = perform_subscribe(
                        conn,
                        student,
                        f"SUB-{session_id}",
                    )

                    if status == 200:
                        result = "done"
                    else:
                        result = (
                            f"failed: "
                            f"{body.get('message', 'unknown error')}"
                        )

                else:
                    result = "failed: Unknown purpose"

            # ------------------------------------------------
            # Store the result while the payment session is
            # still locked.
            # ------------------------------------------------

            conn.execute(
                """
                UPDATE payment_sessions
                SET purpose_result = %s
                WHERE session_id = %s
                """,
                (
                    result,
                    session_id,
                ),
            )

            conn.commit()

            return result

        except Exception as exc:
            conn.rollback()

            print(
                "PAYMENT PURPOSE ERROR:",
                session_id,
                exc,
            )

            return None

        finally:
            conn.close()

    bp.fulfil_payment_purpose = (
        fulfil_payment_purpose
    )

    return bp


# ============================================================
# PAYMENT PURPOSE VALIDATION
# ============================================================

def is_valid_purpose(purpose):
    if purpose is None:
        return True

    # Subscription is retained only so older requests do not
    # crash unexpectedly. New payment-session creation in
    # app.py rejects it.
    if purpose == "subscribe":
        return True

    return (
        isinstance(
            purpose,
            str,
        )
        and purpose.startswith(
            "unlock:"
        )
        and bool(
            ID_PATTERN.fullmatch(
                purpose[
                    len("unlock:"):
                ]
            )
        )
    )