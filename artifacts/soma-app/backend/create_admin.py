from datetime import datetime

import psycopg2
from dotenv import load_dotenv
from werkzeug.security import generate_password_hash

load_dotenv()

import database


username = input("Enter developer username: ").strip()
password = input("Enter developer password: ").strip()

if not username or not password:
    print("Username and password are required.")
    raise SystemExit


try:
    # Make sure the Neon database tables exist.
    database.init_database()

    connection = database.get_connection()

    try:
        password_hash = generate_password_hash(password)

        connection.execute(
            """
            INSERT INTO admins (username, password_hash, created_at)
            VALUES (%s, %s, %s)
            """,
            (
                username,
                password_hash,
                datetime.now().isoformat(),
            )
        )

        connection.commit()

        print("Developer account created successfully.")

    except psycopg2.IntegrityError:
        connection.rollback()
        print("That username already exists.")

    finally:
        connection.close()

except Exception as exc:
    print("Unable to create developer account:", exc)