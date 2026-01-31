import json

from sqlalchemy import text
from datetime import datetime, timezone

from webserver import db


def check_if_user_name_is_unique(user_name: str) -> bool:
    query = 'SELECT user_name FROM "user" WHERE user_name = :user_name'
    with db.engine.connect() as conn:
        res = conn.execute(text(query), {"user_name": user_name})
        if res.rowcount == 0:
            return True
        else:
            return False


def register_user(user_name: str, password_hash: str):
    mail_id = user_name
    query = 'INSERT INTO "user" (user_name, password_hash, mail_id) VALUES (:user_name, :password_hash, :mail_id)'
    with db.engine.begin() as conn:
        conn.execute(
            text(query),
            {"user_name": user_name, "password_hash": password_hash, "mail_id": mail_id},
        )


def get_user(email_id: str):
    query = 'SELECT * FROM users WHERE OR email_id=:email_id'
    with db.engine.connect() as conn:
        res = conn.execute(text(query), {"email_id": email_id, "user_id": user_id})
        return res.mappings().fetchone()
