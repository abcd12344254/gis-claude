"""
JWT 认证模块 — SQLite/Turso 存储 + bcrypt 密码哈希
"""
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

# Turso 云端数据库（优先），否则用本地 SQLite
TURSO_URL = os.getenv("TURSO_URL", "")
TURSO_TOKEN = os.getenv("TURSO_TOKEN", "")
_USE_TURSO = bool(TURSO_URL and TURSO_TOKEN)

if _USE_TURSO:
    import libsql_experimental as _sql_driver
    DB_PATH = TURSO_URL
    print(f"[auth] 使用 Turso 云端数据库: {TURSO_URL}")
else:
    import sqlite3 as _sql_driver
    if os.environ.get("RENDER"):
        _DATA_DIR = "/data"
        os.makedirs(_DATA_DIR, exist_ok=True)
    else:
        _DATA_DIR = os.path.dirname(__file__)
    DB_PATH = os.path.join(_DATA_DIR, "users.db")
    print(f"[auth] 用户数据库路径: {DB_PATH}")

# 套餐配额映射
PLAN_QUOTAS = {"free": 50, "pro": 200, "team": 1000}

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
    plan: str
    quota_daily: int
    quota_used_today: int
    created_at: str


# === 数据库连接 ===

def _get_conn():
    """获取数据库连接（Turso 或 SQLite）"""
    if _USE_TURSO:
        conn = _sql_driver.connect(TURSO_URL, auth_token=TURSO_TOKEN, sync_mode="write")
        return conn
    else:
        conn = _sql_driver.connect(DB_PATH)
        conn.row_factory = _sql_driver.Row
        return conn


def _dict(row, conn=None):
    """将查询结果行转为 dict。Turso 返回 tuple，SQLite 返回 Row"""
    if row is None:
        return None
    if _USE_TURSO:
        # libsql 返回 tuple，需要用 cursor description 转 dict
        if hasattr(row, '_fields'):
            return dict(zip(row._fields, row))
        if isinstance(row, dict):
            return row
        return row  # fallback
    return dict(row)


def _fetchone(cursor, conn):
    """fetchone + 转 dict"""
    if _USE_TURSO:
        rows = cursor.fetchall()
        return rows[0] if rows else None
    return cursor.fetchone()


def _fetchall(cursor, conn):
    """fetchall + 转 dict 列表"""
    if _USE_TURSO:
        rows = cursor.fetchall()
        return [dict(zip(cursor.description or [], r)) if cursor.description else r for r in rows] if rows else []
    return [dict(r) for r in cursor.fetchall()]


# === SQLite 初始化 ===

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
    existing = _fetchone(conn.execute("SELECT id FROM users WHERE email = ?", (email,)), conn)
    if existing:
        conn.close()
        raise HTTPException(status_code=409, detail="该邮箱已注册")
    pwd_bytes = password.encode("utf-8")
    if len(pwd_bytes) > 72:
        pwd_bytes = pwd_bytes[:72]
    hashed = pwd_context.hash(pwd_bytes.decode("utf-8", errors="ignore"))
    conn.execute(
        "INSERT INTO users (email, password_hash) VALUES (?, ?)", (email, hashed)
    )
    conn.commit()
    user = _fetchone(conn.execute("SELECT * FROM users WHERE email = ?", (email,)), conn)
    conn.close()
    return _dict(user, conn)


def authenticate_user(email: str, password: str) -> dict | None:
    conn = _get_conn()
    user = _fetchone(conn.execute("SELECT * FROM users WHERE email = ?", (email,)), conn)
    conn.close()
    if not user:
        return None
    user_dict = _dict(user, conn)
    pwd_bytes = password.encode("utf-8")
    if len(pwd_bytes) > 72:
        pwd_bytes = pwd_bytes[:72]
    if not pwd_context.verify(pwd_bytes.decode("utf-8", errors="ignore"), user_dict["password_hash"]):
        return None
    return user_dict


def get_user_by_id(user_id: int) -> dict | None:
    conn = _get_conn()
    user = _fetchone(conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)), conn)
    conn.close()
    return _dict(user, conn) if user else None


def get_user_by_email(email: str) -> dict | None:
    conn = _get_conn()
    user = _fetchone(conn.execute("SELECT * FROM users WHERE email = ?", (email,)), conn)
    conn.close()
    return _dict(user, conn) if user else None


def verify_user_email(email: str) -> bool:
    conn = _get_conn()
    conn.execute("UPDATE users SET verified = 1 WHERE email = ?", (email,))
    conn.commit()
    updated = _fetchone(conn.execute("SELECT verified FROM users WHERE email = ?", (email,)), conn)
    conn.close()
    d = _dict(updated, conn) if updated else {}
    return d.get("verified") == 1


def reset_daily_quota_if_needed(user: dict) -> int:
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
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    conn = _get_conn()
    conn.execute(
        "UPDATE users SET quota_used_today = quota_used_today + 1, quota_date = ? WHERE id = ?",
        (today, user_id),
    )
    conn.commit()
    user = _fetchone(conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)), conn)
    conn.close()
    u = _dict(user, conn)
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


ADMIN_EMAILS = os.getenv("ADMIN_EMAILS", "").split(",")


def is_admin(user: dict) -> bool:
    if user.get("id") == 1:
        return True
    if user.get("email", "").strip() in [e.strip() for e in ADMIN_EMAILS if e.strip()]:
        return True
    return False


async def get_admin_user(authorization: str | None = Header(None)) -> dict:
    user = await get_current_user(authorization)
    if not is_admin(user):
        raise HTTPException(status_code=403, detail="需要管理员权限")
    return user


def list_all_users() -> list[dict]:
    conn = _get_conn()
    rows = _fetchall(conn.execute(
        "SELECT id, email, plan, quota_daily, quota_used_today, quota_date, verified, created_at "
        "FROM users ORDER BY id DESC"
    ), conn)
    conn.close()
    return rows


def get_user_stats() -> dict:
    conn = _get_conn()
    total = _dict(_fetchone(conn.execute("SELECT COUNT(*) as c FROM users"), conn), conn)
    verified = _dict(_fetchone(conn.execute("SELECT COUNT(*) as c FROM users WHERE verified = 1"), conn), conn)
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    today_new = _dict(_fetchone(conn.execute(
        "SELECT COUNT(*) as c FROM users WHERE date(created_at) = ?", (today,)
    ), conn), conn)
    conn.close()
    return {
        "total": total.get("c", 0) if total else 0,
        "verified": verified.get("c", 0) if verified else 0,
        "today_new": today_new.get("c", 0) if today_new else 0,
    }


def upgrade_user_plan(user_id: int, plan: str, quota_daily: int | None = None) -> dict:
    if plan not in PLAN_QUOTAS:
        raise HTTPException(status_code=400, detail=f"无效套餐: {plan}，可选: {', '.join(PLAN_QUOTAS.keys())}")
    new_quota = quota_daily if quota_daily is not None else PLAN_QUOTAS[plan]
    conn = _get_conn()
    conn.execute(
        "UPDATE users SET plan = ?, quota_daily = ?, quota_used_today = 0 WHERE id = ?",
        (plan, new_quota, user_id),
    )
    conn.commit()
    user = _fetchone(conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)), conn)
    conn.close()
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")
    return _dict(user, conn)


def add_user_quota(user_id: int, amount: int) -> dict:
    if amount <= 0:
        raise HTTPException(status_code=400, detail="充值数量必须大于 0")
    conn = _get_conn()
    conn.execute(
        "UPDATE users SET quota_daily = quota_daily + ? WHERE id = ?",
        (amount, user_id),
    )
    conn.commit()
    user = _fetchone(conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)), conn)
    conn.close()
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")
    return _dict(user, conn)
