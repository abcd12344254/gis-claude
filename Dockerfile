FROM python:3.12-slim

# 系统依赖 + Node.js
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgdal-dev gcc g++ curl \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Python 依赖
COPY server/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 前端构建
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
RUN npm run build

# 清理
RUN find /app -name "*.pyc" -delete && find /app -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null; true

WORKDIR /app/server
CMD ["python", "-B", "main.py"]
