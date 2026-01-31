from sqlalchemy import text

from webserver import db


def insert_s3_metadata(email_id: str, file_path: str, size: int):
    query = "INSERT INTO TABLE BUCKET_INFO (email_id, file_path, size) VALUES (:email_id, :file_path, :size)"
    with db.engine.begin() as conn:
        conn.execute(text(query), {"email_id": email_id, "file_path": file_path, "size": size})
