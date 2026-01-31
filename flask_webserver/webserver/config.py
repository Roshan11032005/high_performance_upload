from datetime import timedelta

SECRET_KEY="DONT_CHANGE_THIS_EVER"
SQLALCHEMY_URI = "postgresql://webapp:webapp@pg_db:5432/webapp"
POSTGRES_ADMIN_URI = "postgresql://postgres:postgres@pg_db:5432/postgres"
JWT_SECRET_KEY = "dev-secret"
JWT_ACCESS_TOKEN_EXPIRES = timedelta(minutes=15)
JWT_REFRESH_TOKEN_EXPIRES = timedelta(days=7)

JWT_TOKEN_LOCATION= ["headers", "cookies"]
JWT_REFRESH_COOKIE_NAME = "refresh_token"

JWT_COOKIE_SECURE = False
JWT_COOKIE_SAMESITE = "Lax"
JWT_COOKIE_CSRF_PROTECT = False