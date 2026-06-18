"""
JWT 认证模块 — SQLite 存储 + bcrypt 密码哈希
"""
import sqlite3
import os
from datetime import datetime, timedelta, timezone
from jose import jwt, JWTError
from passlib.context import CryptContext
from fastapi import HTTPException, Header
from pydantic import BaseModel

# === 配置 ===
SECRET_KEY = os.getenv("JWT_SECRET_KEY", "gis-claude-dev-secret-change-in-production")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_HOURS = 24 * 7  # 7 天
DB_PATH = os.path.join(os.path.dirname(__file__), "users.db")

# === 密码哈希 ===
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

# === Models ===


class UserRegister(BaseModel):
    email: str
    password: str


class UserLogin(BaseModel):
    email: str
    password: str


class UserInfo(BaseModel):
    id: int
    email: str
    plan: str  # "free" | "pro" | "team"
    quota_daily: int
    quota_used_today: int
    created_at: str


# === SQLite 初始化 ===


def _get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = _get_conn()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            plan TEXT DEFAULT 'free',
            quota_daily INTEGER DEFAULT 50,
            quota_used_today INTEGER DEFAULT 0,
            quota_date TEXT,
            verified INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now'))
        )
    """
    )
    conn.commit()
    conn.close()


# === 用户操作 ===


def create_user(email: str, password: str) -> dict:
    conn = _get_conn()
    existing = conn.execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone()
    if existing:
        conn.close()
        raise HTTPException(status_code=409, detail="该邮箱已注册")
    hashed = pwd_context.hash(password)
    conn.execute(
        "INSERT INTO users (email, password_hash) VALUES (?, ?)", (email, hashed)
    )
    conn.commit()
    user = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
    conn.close()
    return dict(user)


def authenticate_user(email: str, password: str) -> dict | None:
    conn = _get_conn()
    user = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
    conn.close()
    if not user:
        return None
    user_dict = dict(user)
    if not pwd_context.verify(password, user_dict["password_hash"]):
        return None
    return user_dict


def get_user_by_id(user_id: int) -> dict | None:
    conn = _get_conn()
    user = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    conn.close()
    return dict(user) if user else None


def get_user_by_email(email: str) -> dict | None:
    conn = _get_conn()
    user = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
    conn.close()
    return dict(user) if user else None


def verify_user_email(email: str) -> bool:
    """标记用户邮箱已验证"""
    conn = _get_conn()
    conn.execute("UPDATE users SET verified = 1 WHERE email = ?", (email,))
    conn.commit()
    updated = conn.execute("SELECT verified FROM users WHERE email = ?", (email,)).fetchone()
    conn.close()
    return updated["verified"] == 1 if updated else False


def reset_daily_quota_if_needed(user: dict) -> int:
    """如果跨天了，重置配额，返回可用次数"""
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    if user["quota_date"] != today:
        conn = _get_conn()
        conn.execute(
            "UPDATE users SET quota_used_today = 0, quota_date = ? WHERE id = ?",
            (today, user["id"]),
        )
        conn.commit()
        conn.close()
        user["quota_used_today"] = 0
        user["quota_date"] = today
    remaining = user["quota_daily"] - user["quota_used_today"]
    return max(0, remaining)


def increment_quota(user_id: int) -> int:
    """配额 +1，返回剩余次数"""
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    conn = _get_conn()
    conn.execute(
        "UPDATE users SET quota_used_today = quota_used_today + 1, quota_date = ? WHERE id = ?",
        (today, user_id),
    )
    conn.commit()
    user = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    conn.close()
    u = dict(user)
    return max(0, u["quota_daily"] - u["quota_used_today"])


# === JWT ===


def create_access_token(user_id: int, email: str) -> str:
    expires = datetime.now(timezone.utc) + timedelta(hours=ACCESS_TOKEN_EXPIRE_HOURS)
    return jwt.encode(
        {"sub": str(user_id), "email": email, "exp": expires},
        SECRET_KEY,
        algorithm=ALGORITHM,
    )


def verify_token(token: str) -> dict | None:
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        return payload
    except JWTError:
        return None


async def get_current_user(authorization: str | None = Header(None)) -> dict:
    """从 Authorization 头解析 JWT，返回 user dict"""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="未登录，请先注册或登录")
    token = authorization[7:]
    payload = verify_token(token)
    if not payload:
        raise HTTPException(status_code=401, detail="登录已过期，请重新登录")
    user_id = int(payload["sub"])
    user = get_user_by_id(user_id)
    if not user:
        raise HTTPException(status_code=401, detail="用户不存在")
    return user
