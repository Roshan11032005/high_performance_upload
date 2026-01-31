CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    user_name VARCHAR(100) UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    email_id VARCHAR(100) NOT NULL,
    face_auth VARCHAR,
    public_id VARCHAR NOT NULL
);

CREATE TABLE s3_metadata(
    id SERIAL PRIMARY KEY,
    email_id VARCHAR(100) REFERENCES users(email_id),
    file_path VARCHAR,
    file_size INT
);