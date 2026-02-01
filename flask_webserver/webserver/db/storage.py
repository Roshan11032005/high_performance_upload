import json

from sqlalchemy import text
from datetime import datetime, timezone

from webserver import db


def insert_s3_metadata(email_id: str, file_path: str, size: int):
    query = "INSERT INTO TABLE s3_metadata (email_id, file_path, file_size) VALUES (:email_id, :file_path, :file_size)"
    with db.engine.begin() as conn:
        conn.execute(text(query), {"email_id": email_id, "file_path": file_path, "file_size": size})
