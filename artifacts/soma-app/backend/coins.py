"""
SOMA Coins and material unlocks.

The server owns both balances:

    coins -> coin_transactions ledger

    KSh   -> wallet_transactions ledger

Quiz answers are graded in the app, so the server cannot verify a
reward claim. It limits abuse instead: each attempt pays once and
earnings are capped per day.

This version uses PostgreSQL/Neon.
"""

import os
import re
import uuid
from datetime import date, datetime, timedelta

from flask import Blueprint, jsonify, request


MATERIAL_PRICE_COINS = int(os.getenv("MATERIAL_PRICE_COINS", "5"))
KSH_PER_COIN = int(os.getenv("KSH_PER_COIN", "1"))

DAILY_COIN_CAP = int(os.getenv("DAILY_COIN_CAP", "200"))
IMPORT_COIN_CAP = int(os.getenv("IMPORT_COIN_CAP", "500"))

DEFAULT_STARTING_COINS = 100
MAX_COINS_PER_PURCHASE = 10000
MAX_IMPORTED_UNLOCKS = 1000

REWARD_BASE = {
    "topical": 15,
    "exam": 25,
}

PERFECT_BONUS = 10
STREAK_MILESTONE_BONUS = 40
STREAK_MILESTONE_DAYS = 7

SUBSCRIPTION_PRICE_KSH = int(
    os.getenv("SUBSCRIPTION_PRICE_KSH", "100")
)

SUBSCRIPTION_DAYS = int(
    os.getenv("SUBSCRIPTION_DAYS", "30")
)

ID_PATTERN = re.compile(r"[A-Za-z0-9_:.\\-]{1,120}")

TIME_FORMAT = "%Y-%m-%d %H:%M:%S"


def covers(grade_key, material_id):
    """
    Material IDs start with their grade key.

    Example:
        cbc-7-english-...
    """
    return bool(grade_key) and material_id.startswith(grade_key + "-")


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

    # --------------------------------------------------------
    # Helpers
    # --------------------------------------------------------

    def find_student(conn, soma_hub_code):
        return conn.execute(
            """
            SELECT id, soma_hub_code, grade
            FROM students
            WHERE soma_hub_code = %s
            """,
            (soma_hub_code,),
        ).fetchone()

    def coin_balance(conn, soma_hub_code):
        row = conn.execute(
            """
            SELECT COALESCE(SUM(amount), 0) AS balance
            FROM coin_transactions
            WHERE soma_hub_code = %s
            """,
            (soma_hub_code,),
        ).fetchone()

        return int(row["balance"])

    def ksh_balance(conn, soma_hub_code):
        return int(
            round(
                calculate_wallet_balance(
                    conn,
                    soma_hub_code,
                )
            )
        )

    def earned_today(conn, soma_hub_code):
        row = conn.execute(
            """
            SELECT COALESCE(SUM(amount), 0) AS earned
            FROM coin_transactions
            WHERE soma_hub_code = %s
              AND transaction_type = 'REWARD'
              AND SUBSTRING(created_at, 1, 10) = %s
            """,
            (
                soma_hub_code,
                date.today().isoformat(),
            ),
        ).fetchone()

        return int(row["earned"])

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
        """
        The student's current-grade subscription,
        else their latest one.
        """

        grade_row = conn.execute(
            """
            SELECT grade
            FROM students
            WHERE soma_hub_code = %s
            """,
            (soma_hub_code,),
        ).fetchone()

        grade = grade_row["grade"] if grade_row else None

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
            "coins": coin_balance(
                conn,
                soma_hub_code,
            ),
            "ksh": ksh_balance(
                conn,
                soma_hub_code,
            ),
            "unlocked": [
                row["material_id"]
                for row in unlocked
            ],
            "earned_today": earned_today(
                conn,
                soma_hub_code,
            ),
            "imported": bool(imported),
            "prices": {
                "material_coins": MATERIAL_PRICE_COINS,
                "ksh_per_coin": KSH_PER_COIN,
                "daily_cap": DAILY_COIN_CAP,
                "subscription_ksh": SUBSCRIPTION_PRICE_KSH,
                "subscription_days": SUBSCRIPTION_DAYS,
            },
            "subscription": subscription_summary(
                conn,
                soma_hub_code,
            ),
        }

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
            VALUES (%s, %s, %s, 'DEBIT', %s, %s, %s)
            """,
            (
                student["id"],
                student["soma_hub_code"],
                amount,
                reference,
                description,
                now_string(),
            ),
        )

    def reference_exists(
        conn,
        reference,
    ):
        return (
            conn.execute(
                """
                SELECT 1
                FROM coin_transactions
                WHERE reference = %s
                LIMIT 1
                """,
                (reference,),
            ).fetchone()
            is not None
        )

    def reward_streak_after_today(
        conn,
        soma_hub_code,
    ):
        """
        Consecutive days with a reward,
        ending today.
        """

        rows = conn.execute(
            """
            SELECT DISTINCT
                SUBSTRING(created_at, 1, 10) AS day
            FROM coin_transactions
            WHERE soma_hub_code = %s
              AND transaction_type = 'REWARD'
            """,
            (soma_hub_code,),
        ).fetchall()

        days = {
            row["day"]
            for row in rows
        }

        days.add(
            date.today().isoformat()
        )

        streak = 0
        current_day = date.today()

        while current_day.isoformat() in days:
            streak += 1
            current_day -= timedelta(days=1)

        return streak

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
        """
        Opens a connection, loads the student,
        and always closes it.
        """

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

    # --------------------------------------------------------
    # Account
    # --------------------------------------------------------

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
        """
        One-time move of a device's local
        coins and unlocks to the server.
        """

        code = student["soma_hub_code"]
        reference = f"IMPORT-{code}"

        if not reference_exists(
            conn,
            reference,
        ):
            try:
                local_coins = int(
                    data.get(
                        "coins",
                        DEFAULT_STARTING_COINS,
                    )
                )
            except (TypeError, ValueError):
                local_coins = DEFAULT_STARTING_COINS

            coins = max(
                0,
                min(
                    local_coins,
                    IMPORT_COIN_CAP,
                ),
            )

            add_coins(
                conn,
                student,
                coins,
                "IMPORT",
                reference,
                "Coins moved from this device",
            )

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
                )

                if ID_PATTERN.fullmatch(
                    material_id
                ):
                    conn.execute(
                        """
                        INSERT INTO material_unlocks (
                            student_id,
                            soma_hub_code,
                            material_id,
                            created_at
                        )
                        VALUES (%s, %s, %s, %s)
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

    # --------------------------------------------------------
    # Unlock a material
    # --------------------------------------------------------

    def perform_unlock(
        conn,
        student,
        material_id,
        allow_ksh,
    ):
        """
        Unlocks inside the caller's transaction.

        Returns:
            (http_status, body)

        The caller commits on success.
        """

        code = student["soma_hub_code"]

        already = conn.execute(
            """
            SELECT 1
            FROM material_unlocks
            WHERE student_id = %s
              AND material_id = %s
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

        # Covered materials open without a permanent unlock.
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

        price = MATERIAL_PRICE_COINS

        coins = coin_balance(
            conn,
            code,
        )

        ksh = ksh_balance(
            conn,
            code,
        )

        if coins >= price:
            coins_spent = price
            ksh_spent = 0

        else:
            shortfall = price - coins
            ksh_needed = (
                shortfall * KSH_PER_COIN
            )

            if (
                not allow_ksh
                or ksh < ksh_needed
            ):
                return 402, {
                    "message": "Not enough coins",
                    "coins": coins,
                    "ksh": ksh,
                    "price": price,
                    "shortfall_coins": shortfall,
                    "ksh_needed": ksh_needed,
                    "can_pay_with_ksh": (
                        ksh >= ksh_needed
                    ),
                }

            coins_spent = coins
            ksh_spent = ksh_needed

        reference = (
            f"UNLOCK-{code}-{material_id}"
        )

        if ksh_spent:
            debit_ksh(
                conn,
                student,
                ksh_spent,
                reference,
                f"Unlocked {material_id}",
            )

        if coins_spent:
            add_coins(
                conn,
                student,
                -coins_spent,
                "UNLOCK",
                reference,
                f"Unlocked {material_id}",
            )

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
            VALUES (%s, %s, %s, %s, %s, %s)
            """,
            (
                student["id"],
                code,
                material_id,
                coins_spent,
                ksh_spent,
                now_string(),
            ),
        )

        return 200, {
            "already_unlocked": False,
            "via_subscription": False,
            "coins_spent": coins_spent,
            "ksh_spent": ksh_spent,
        }

    # --------------------------------------------------------
    # Subscriptions
    # --------------------------------------------------------

    def perform_subscribe(
        conn,
        student,
        reference,
    ):
        """
        Subscribes inside the caller's transaction.

        Returns:
            (http_status, body)
        """

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

        ksh = ksh_balance(
            conn,
            code,
        )

        if ksh < SUBSCRIPTION_PRICE_KSH:
            return 402, {
                "message": (
                    "Not enough KSh in your wallet"
                ),
                "ksh": ksh,
                "ksh_needed": (
                    SUBSCRIPTION_PRICE_KSH - ksh
                ),
                "price_ksh": SUBSCRIPTION_PRICE_KSH,
            }

        # Renewing early extends from the current
        # subscription end date.
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
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
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
            "ksh_spent": SUBSCRIPTION_PRICE_KSH,
        }

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

    # --------------------------------------------------------
    # Unlock a material
    # --------------------------------------------------------

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

        allow_ksh = (
            data.get("allow_ksh") is True
        )

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
            allow_ksh,
        )

        return respond(
            conn,
            student,
            status,
            body,
        )

    # --------------------------------------------------------
    # Subscriptions
    # --------------------------------------------------------

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

    # --------------------------------------------------------
    # Buy coins with KSh
    # --------------------------------------------------------

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
        code = student["soma_hub_code"]

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

        coins = data.get("coins")

        if (
            not isinstance(coins, int)
            or isinstance(coins, bool)
            or not (
                1 <= coins <= MAX_COINS_PER_PURCHASE
            )
        ):
            return error(
                (
                    "Coins must be a whole number "
                    f"from 1 to {MAX_COINS_PER_PURCHASE}"
                ),
                400,
            )

        reference = f"BUY-{request_id}"

        if reference_exists(
            conn,
            reference,
        ):
            conn.commit()

            return jsonify({
                "success": True,
                "duplicate": True,
                **account_payload(
                    conn,
                    code,
                ),
            })

        ksh_cost = (
            coins * KSH_PER_COIN
        )

        ksh = ksh_balance(
            conn,
            code,
        )

        if ksh < ksh_cost:
            conn.rollback()

            return error(
                "Not enough KSh in your wallet",
                402,
                ksh=ksh,
                ksh_needed=ksh_cost,
            )

        debit_ksh(
            conn,
            student,
            ksh_cost,
            reference,
            f"Bought {coins} coins",
        )

        add_coins(
            conn,
            student,
            coins,
            "PURCHASE",
            reference,
            f"Bought {coins} coins",
        )

        conn.commit()

        return jsonify({
            "success": True,
            "duplicate": False,
            "ksh_spent": ksh_cost,
            **account_payload(
                conn,
                code,
            ),
        })

    # --------------------------------------------------------
    # Quiz rewards
    # --------------------------------------------------------

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
        code = student["soma_hub_code"]

        attempt_id = str(
            data.get(
                "attempt_id",
                "",
            )
        ).strip()

        material_id = str(
            data.get(
                "material_id",
                "",
            )
        ).strip()

        quiz_type = data.get("type")
        percentage = data.get("percentage")

        if not ID_PATTERN.fullmatch(
            attempt_id
        ):
            return error(
                "An attempt ID is required",
                400,
            )

        if not ID_PATTERN.fullmatch(
            material_id
        ):
            return error(
                "A valid material ID is required",
                400,
            )

        if quiz_type not in REWARD_BASE:
            return error(
                "Type must be 'topical' or 'exam'",
                400,
            )

        if (
            not isinstance(
                percentage,
                (int, float),
            )
            or isinstance(
                percentage,
                bool,
            )
            or not 0 <= percentage <= 100
        ):
            return error(
                "Percentage must be between 0 and 100",
                400,
            )

        reference = (
            f"REWARD-{code}-{attempt_id}"
        )

        if reference_exists(
            conn,
            reference,
        ):
            conn.commit()

            return jsonify({
                "success": True,
                "duplicate": True,
                "coins_awarded": 0,
                **account_payload(
                    conn,
                    code,
                ),
            })

        first_reward_today = (
            conn.execute(
                """
                SELECT 1
                FROM coin_transactions
                WHERE soma_hub_code = %s
                  AND transaction_type = 'REWARD'
                  AND SUBSTRING(created_at, 1, 10) = %s
                LIMIT 1
                """,
                (
                    code,
                    date.today().isoformat(),
                ),
            ).fetchone()
            is None
        )

        reward = REWARD_BASE[
            quiz_type
        ]

        if percentage >= 100:
            reward += PERFECT_BONUS

        streak = reward_streak_after_today(
            conn,
            code,
        )

        milestone = (
            first_reward_today
            and streak % STREAK_MILESTONE_DAYS == 0
        )

        if milestone:
            reward += STREAK_MILESTONE_BONUS

        remaining = max(
            0,
            DAILY_COIN_CAP
            - earned_today(
                conn,
                code,
            ),
        )

        awarded = min(
            reward,
            remaining,
        )

        description = (
            f"Quiz reward + {streak}-day streak"
            if milestone
            else "Quiz reward"
        )

        add_coins(
            conn,
            student,
            awarded,
            "REWARD",
            reference,
            description,
        )

        conn.commit()

        return jsonify({
            "success": True,
            "duplicate": False,
            "coins_awarded": awarded,
            "capped": awarded < reward,
            "streak_bonus": milestone,
            **account_payload(
                conn,
                code,
            ),
        })

    # --------------------------------------------------------
    # Development coins
    # --------------------------------------------------------

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
        if not is_sandbox():
            return error(
                "Development coins are disabled in production",
                403,
            )

        add_coins(
            conn,
            student,
            100,
            "DEV_GRANT",
            f"DEV-{uuid.uuid4().hex}",
            "Development test coins",
        )

        conn.commit()

        return jsonify({
            "success": True,
            **account_payload(
                conn,
                student["soma_hub_code"],
            ),
        })

    # --------------------------------------------------------
    # Payment purposes
    # --------------------------------------------------------

    def fulfil_payment_purpose(
        session_id,
    ):
        """
        Runs after an M-Pesa payment has been
        credited to the wallet.

        Unlocks the material or starts the subscription
        the payment was for.

        On failure the money simply stays in the wallet.

        Returns the saved purpose_result,
        or None for plain top-ups.
        """

        conn = get_db()

        try:
            session = conn.execute(
                """
                SELECT *
                FROM payment_sessions
                WHERE session_id = %s
                """,
                (session_id,),
            ).fetchone()

            if (
                not session
                or not session["purpose"]
                or session["purpose_result"]
            ):
                return (
                    session["purpose_result"]
                    if session
                    else None
                )

            student = find_student(
                conn,
                session["soma_hub_code"],
            )

            if not student:
                return None

            purpose = session["purpose"]

            if purpose == "subscribe":
                status, body = perform_subscribe(
                    conn,
                    student,
                    f"SUB-{session_id}",
                )

            elif purpose.startswith("unlock:"):
                status, body = perform_unlock(
                    conn,
                    student,
                    purpose[len("unlock:"):],
                    allow_ksh=True,
                )

            else:
                status, body = 400, {
                    "message": "Unknown purpose"
                }

            if status == 200:
                result = "done"

            else:
                conn.rollback()

                result = (
                    f"failed: "
                    f"{body.get('message', 'unknown error')}"
                )

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


def is_valid_purpose(purpose):
    if purpose is None or purpose == "subscribe":
        return True

    return (
        isinstance(purpose, str)
        and purpose.startswith("unlock:")
        and bool(
            ID_PATTERN.fullmatch(
                purpose[len("unlock:"):]
            )
        )
    )