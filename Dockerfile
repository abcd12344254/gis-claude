FROM python:3.12-slim

WORKDIR /app

# 安装 Python 依赖
COPY server/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 复制整个项目（含预构建的 dist）
COPY . .

# 强制 Docker 重建层
RUN echo "BUILD_TIME=$(date)" > /app/build_info.txt

# 前端已预构建在 dist/，直接启动后端
WORKDIR /app/server
CMD ["python", "main.py"]
