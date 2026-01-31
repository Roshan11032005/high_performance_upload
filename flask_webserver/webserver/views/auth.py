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
from flask_jwt_extended import (
    create_access_token,
    create_refresh_token,
    set_refresh_cookies,
    jwt_required,
    get_jwt_identity,
    unset_jwt_cookies
)
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

        access_token = create_access_token(identity=email_id)
        refresh_token = create_refresh_token(identity=email_id)
        response = jsonify({"access_token": access_token})
        set_refresh_cookies(response, refresh_token)
        
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


@auth_bp.post("/refresh")
@jwt_required(refresh=True)
def refresh():
    email_id = get_jwt_identity()
    new_access = create_access_token(identity=email_id)
    return {"access_token": new_access}


@auth_bp.post("/logout")
def logout():
    response = jsonify({"msg": "logged out"})
    unset_jwt_cookies(response)
    return response
