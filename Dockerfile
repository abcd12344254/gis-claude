FROM python:3.12-slim
WORKDIR /app
COPY server/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
RUN find /app -name "*.pyc" -delete && find /app -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null; true
WORKDIR /app/server
CMD ["python", "-B", "main.py"]
