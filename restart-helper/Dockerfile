FROM python:3.13-alpine
RUN apk add --no-cache docker-cli
COPY restart.py /opt/restart.py
CMD ["python", "/opt/restart.py"]
