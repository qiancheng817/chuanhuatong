FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    TZ=Asia/Shanghai

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY bridge.py .

RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 8788

CMD ["python", "-u", "bridge.py"]
