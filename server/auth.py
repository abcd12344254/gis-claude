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
# Render 持久化磁盘 /data，本地开发回退到 server/ 目录
# 用 RENDER 环境变量判断更可靠（Render 平台始终注入此变量）
if os.environ.get("RENDER"):
    _DATA_DIR = "/data"
    os.makedirs(_DATA_DIR, exist_ok=True)  # 确保目录存在且可写
else:
    _DATA_DIR = os.path.dirname(__file__)
DB_PATH = os.path.join(_DATA_DIR, "users.db")
print(f"[auth] 用户数据库路径: {DB_PATH}")

# 套餐配额映射
PLAN_QUOTAS = {"free": 50, "pro": 200, "team": 1000}

# === 密码哈希 ===
# bcrypt 72字节限制 → create_user / authenticate_user 中已处理
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
    # bcrypt 72字节限制：始终截断防止任何异常
    pwd_bytes = password.encode("utf-8")
    if len(pwd_bytes) > 72:
        pwd_bytes = pwd_bytes[:72]
    hashed = pwd_context.hash(pwd_bytes.decode("utf-8", errors="ignore"))
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
    pwd_bytes = password.encode("utf-8")
    if len(pwd_bytes) > 72:
        pwd_bytes = pwd_bytes[:72]
    if not pwd_context.verify(pwd_bytes.decode("utf-8", errors="ignore"), user_dict["password_hash"]):
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


ADMIN_EMAILS = os.getenv("ADMIN_EMAILS", "").split(",")  # 逗号分隔的管理员邮箱列表


def is_admin(user: dict) -> bool:
    """检查用户是否为管理员（id=1 或邮箱在 ADMIN_EMAILS 中）"""
    if user.get("id") == 1:
        return True
    if user.get("email", "").strip() in [e.strip() for e in ADMIN_EMAILS if e.strip()]:
        return True
    return False


async def get_admin_user(authorization: str | None = Header(None)) -> dict:
    """管理员权限校验"""
    user = await get_current_user(authorization)
    if not is_admin(user):
        raise HTTPException(status_code=403, detail="需要管理员权限")
    return user


def list_all_users() -> list[dict]:
    """管理员：列出所有注册用户"""
    conn = _get_conn()
    rows = conn.execute(
        "SELECT id, email, plan, quota_daily, quota_used_today, quota_date, verified, created_at "
        "FROM users ORDER BY id DESC"
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_user_stats() -> dict:
    """管理员：用户统计"""
    conn = _get_conn()
    total = conn.execute("SELECT COUNT(*) as c FROM users").fetchone()["c"]
    verified = conn.execute("SELECT COUNT(*) as c FROM users WHERE verified = 1").fetchone()["c"]
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    today_new = conn.execute(
        "SELECT COUNT(*) as c FROM users WHERE date(created_at) = ?", (today,)
    ).fetchone()["c"]
    conn.close()
    return {"total": total, "verified": verified, "today_new": today_new}


def upgrade_user_plan(user_id: int, plan: str, quota_daily: int | None = None) -> dict:
    """升级用户套餐，可选自定义配额"""
    if plan not in PLAN_QUOTAS:
        raise HTTPException(status_code=400, detail=f"无效套餐: {plan}，可选: {', '.join(PLAN_QUOTAS.keys())}")
    new_quota = quota_daily if quota_daily is not None else PLAN_QUOTAS[plan]
    conn = _get_conn()
    conn.execute(
        "UPDATE users SET plan = ?, quota_daily = ?, quota_used_today = 0 WHERE id = ?",
        (plan, new_quota, user_id),
    )
    conn.commit()
    user = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    conn.close()
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")
    return dict(user)


def add_user_quota(user_id: int, amount: int) -> dict:
    """为用户增加每日配额"""
    if amount <= 0:
        raise HTTPException(status_code=400, detail="充值数量必须大于 0")
    conn = _get_conn()
    conn.execute(
        "UPDATE users SET quota_daily = quota_daily + ? WHERE id = ?",
        (amount, user_id),
    )
    conn.commit()
    user = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    conn.close()
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")
    return dict(user)
