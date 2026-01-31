FROM python:3.11-slim

RUN apt-get update 

# dir and pip
WORKDIR /app/flask_webserver

COPY requirements.txt .
RUN pip install -r requirements.txt

# real shit
COPY . .
