from flask import (
    Blueprint,
    request,
    jsonify,
    url_for,
    flash,
    render_template,
    redirect,
    session,
    g,
    current_app,
)
import jwt
from werkzeug.security import generate_password_hash, check_password_hash

from webserver.db import user as User

auth_bp = Blueprint("auth", __name__)


@auth_bp.get("/")
def index():
    return redirect("https://google.com")

@auth_bp.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        email_id = request.form['email']
        password = request.form['password']
        user = User.get_user(email_id)

        if not user or not check_password_hash(user["password_hash"], password):
            return jsonify({'message': 'Invalid email or password'}), 401

        token = jwt.encode({'public_id': user.public_id, 'exp': datetime.now(timezone.utc) + timedelta(hours=1)},
                           app.config['SECRET_KEY'], algorithm="HS256")

        response = make_response(redirect(url_for('dashboard')))
        response.set_cookie('jwt_token', token)

        return response

    return render_template('login.html')