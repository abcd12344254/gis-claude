FROM python:3.12-slim
ARG CACHEBUST=1
WORKDIR /app
COPY server/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
WORKDIR /app/server
CMD ["python", "main.py"]
