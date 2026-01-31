from flask import (
    Blueprint,
    request,
    jsonify,
    url_for,
    make_response,
    render_template,
    redirect,
    session,
    g,
    current_app,
)
from datetime import datetime, timezone, timedelta
import jwt
import uuid
from werkzeug.security import generate_password_hash, check_password_hash

from webserver.db import user as User

auth_bp = Blueprint("auth", __name__)


@auth_bp.get("/")
def index():
    return redirect("https://google.com")

@auth_bp.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        email_id = request.form['username']
        password = request.form['password']
        user = User.get_user(email_id)

        if not user or not check_password_hash(user["password_hash"], password):
            return jsonify({'message': 'Invalid email or password'}), 401

        token = jwt.encode({'public_id': user["public_id"], 'exp': datetime.now(timezone.utc) + timedelta(hours=1)},
                           current_app.config['SECRET_KEY'], algorithm="HS256")

        response = make_response(redirect("https://google.com"))
        response.set_cookie('jwt_token', token)

        return response
    else:
        return render_template('login.html')

@auth_bp.route('/register', methods=['GET', 'POST'])
def register():
    if request.method == 'POST':
        email_id = request.form['username']
        password = request.form['password']
        public_id = str(uuid.uuid4())

        existing_user = User.get_user(email_id)
        if existing_user:
            return jsonify({'message': 'User already exists. Please login.'}), 400

        hashed_password = generate_password_hash(password)
        User.register_user(email_id, hashed_password, public_id)

        return redirect(url_for('auth.login'))

    return render_template('register.html')
