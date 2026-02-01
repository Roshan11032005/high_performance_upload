CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    user_name VARCHAR(100),
    password_hash TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    email_id VARCHAR(100) NOT NULL,
    face_auth VARCHAR,
    public_id VARCHAR NOT NULL
);