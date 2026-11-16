"""
Backend test fixtures.

The backend runs on PostgreSQL, so the tests need one. Point TEST_DATABASE_URL
at a throwaway database — every test DROPS and recreates its schema:

    TEST_DATABASE_URL=postgresql://postgres@localhost:5432/soma_test pytest

Tests are skipped when TEST_DATABASE_URL is not set, so they can never touch
a real database by accident.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

TEST_DATABASE_URL = os.getenv("TEST_DATABASE_URL")
if TEST_DATABASE_URL:
    os.environ["DATABASE_URL"] = TEST_DATABASE_URL

import app as soma_app  # noqa: E402
import database  # noqa: E402

STUDENT_CODE = "SOMA-TEST-001"
PHONE = "0708374149"


def _reset_schema():
    conn = database.get_connection()
    try:
        conn.execute("DROP SCHEMA public CASCADE")
        conn.execute("CREATE SCHEMA public")
        conn.commit()
    finally:
        conn.close()
    database.init_database()


@pytest.fixture
def client():
    if not TEST_DATABASE_URL:
        pytest.skip("TEST_DATABASE_URL is not set (needs a throwaway PostgreSQL database)")

    _reset_schema()
    soma_app.limiter.reset()

    client = soma_app.app.test_client()
    response = client.post("/api/students/register", json={
        "soma_hub_code": STUDENT_CODE,
        "name": "Test Student",
        "school_name": "Test School",
        "grade": "Grade 7",
    })
    assert response.status_code in (200, 201), response.get_json()
    return client


def credit_ksh(amount, soma_hub_code=STUDENT_CODE):
    """Puts KSh in the wallet the way a completed M-Pesa top-up does."""
    conn = soma_app.get_db()
    student = conn.execute(
        "SELECT id FROM students WHERE soma_hub_code = %s", (soma_hub_code,)
    ).fetchone()
    conn.execute(
        "INSERT INTO wallet_transactions (student_id, soma_hub_code, amount, "
        "transaction_type, reference, description, created_at) "
        "VALUES (%s, %s, %s, 'CREDIT', %s, 'test top-up', '2026-01-01 00:00:00')",
        (student["id"], soma_hub_code, amount, f"TEST-{amount}"),
    )
    conn.commit()
    conn.close()
