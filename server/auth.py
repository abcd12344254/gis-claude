"""
JWT 认证模块 — Turso/SQLite 存储 + bcrypt 密码哈希
"""
import os, json
from datetime import datetime, timedelta, timezone
from jose import jwt, JWTError
from passlib.context import CryptContext
from fastapi import HTTPException, Header
from pydantic import BaseModel

# === 配置 ===
SECRET_KEY = os.getenv("JWT_SECRET_KEY", "gis-claude-dev-secret-change-in-production")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_HOURS = 24 * 7

# Turso 优先，否则本地 SQLite
TURSO_URL = os.getenv("TURSO_URL", "")
TURSO_TOKEN = os.getenv("TURSO_TOKEN", "")
_USE_TURSO = bool(TURSO_URL and TURSO_TOKEN)

if _USE_TURSO:
    import httpx
    TURSO_HTTP_URL = TURSO_URL.replace("libsql://", "https://")
    DB_PATH = TURSO_URL
    print(f"[auth] Turso: {TURSO_URL} → {TURSO_HTTP_URL}")
else:
    import sqlite3 as _sql_driver
    if os.environ.get("RENDER"):
        _DATA_DIR = "/data"
        os.makedirs(_DATA_DIR, exist_ok=True)
    else:
        _DATA_DIR = os.path.dirname(__file__)
    DB_PATH = os.path.join(_DATA_DIR, "users.db")
    print(f"[auth] SQLite: {DB_PATH}")

PLAN_QUOTAS = {"free": 50, "pro": 200, "team": 1000}
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

# === Models ===
class UserRegister(BaseModel):
    email: str; password: str

class UserLogin(BaseModel):
    email: str; password: str

class UserInfo(BaseModel):
    id: int; email: str; plan: str; quota_daily: int; quota_used_today: int; created_at: str


# === Turso HTTP 客户端 ===

class _TursoResult:
    """Turso 查询结果，模拟 sqlite3 Cursor"""
    def __init__(self, raw_result):
        cols = raw_result.get("cols") or []
        self.columns = [c["name"] for c in cols]
        self.rows = raw_result.get("rows") or []
        self.lastrowid = raw_result.get("last_insert_rowid")
        self.rowcount = len(self.rows)

    @staticmethod
    def _unwrap(v):
        """Turso 可能返回 {'type':'integer','value':'123'} 格式"""
        if isinstance(v, dict) and 'value' in v:
            raw = v['value']
            t = v.get('type', '')
            if t == 'integer': return int(raw) if raw is not None else None
            if t == 'float': return float(raw) if raw is not None else None
            return raw
        return v

    def _d(self, row):
        if not self.columns: return row
        if isinstance(row, (list, tuple)):
            return {k: self._unwrap(v) for k, v in zip(self.columns, row)}
        return row

    def fetchone(self):
        return self._d(self.rows[0]) if self.rows else None

    def fetchall(self):
        return [self._d(r) for r in self.rows]


class _TursoConn:
    """Turso 连接包装，对外暴露 execute/commit/close 接口"""
    def execute(self, sql, params=None):
        args = []
        if params:
            for p in params:
                if isinstance(p, int): args.append({"type": "integer", "value": str(p)})
                elif isinstance(p, float): args.append({"type": "float", "value": str(p)})
                elif p is None: args.append({"type": "null", "value": ""})
                else: args.append({"type": "text", "value": str(p)})

        body = {"requests": [
            {"type": "execute", "stmt": {"sql": sql, "args": args}},
            {"type": "close"}
        ]}
        try:
            resp = httpx.post(
                f"{TURSO_HTTP_URL}/v2/pipeline",
                headers={"Authorization": f"Bearer {TURSO_TOKEN}"},
                json=body, timeout=30.0
            )
            data = resp.json()
            results = data.get("results") or []
            if not results:
                return _TursoResult({})
            r = results[0]
            if r.get("type") == "error":
                raise Exception(r.get("error", {}).get("message", "Turso error"))
            return _TursoResult(r.get("response", {}).get("result", {}))
        except httpx.HTTPError as e:
            raise Exception(f"Turso 连接失败: {e}")

    def commit(self): pass
    def close(self): pass


# === 连接获取 ===

def _get_conn():
    if _USE_TURSO:
        return _TursoConn()
    else:
        conn = _sql_driver.connect(DB_PATH)
        conn.row_factory = _sql_driver.Row
        return conn


def _d(row):
    return dict(row) if row is not None else None


# === 初始化 ===

def init_db():
    conn = _get_conn()
    conn.execute(
        """CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            plan TEXT DEFAULT 'free',
            quota_daily INTEGER DEFAULT 50,
            quota_used_today INTEGER DEFAULT 0,
            quota_date TEXT,
            verified INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now'))
        )"""
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
    pwd_bytes = password.encode("utf-8")
    if len(pwd_bytes) > 72: pwd_bytes = pwd_bytes[:72]
    hashed = pwd_context.hash(pwd_bytes.decode("utf-8", errors="ignore"))
    conn.execute("INSERT INTO users (email, password_hash) VALUES (?, ?)", (email, hashed))
    conn.commit()
    user = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
    conn.close()
    return _d(user)


def authenticate_user(email: str, password: str) -> dict | None:
    conn = _get_conn()
    user = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
    conn.close()
    if not user: return None
    user_dict = _d(user)
    pwd_bytes = password.encode("utf-8")
    if len(pwd_bytes) > 72: pwd_bytes = pwd_bytes[:72]
    if not pwd_context.verify(pwd_bytes.decode("utf-8", errors="ignore"), user_dict["password_hash"]):
        return None
    return user_dict


def get_user_by_id(user_id: int) -> dict | None:
    conn = _get_conn()
    user = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    conn.close()
    return _d(user) if user else None


def get_user_by_email(email: str) -> dict | None:
    conn = _get_conn()
    user = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
    conn.close()
    return _d(user) if user else None


def verify_user_email(email: str) -> bool:
    conn = _get_conn()
    conn.execute("UPDATE users SET verified = 1 WHERE email = ?", (email,))
    conn.commit()
    updated = conn.execute("SELECT verified FROM users WHERE email = ?", (email,)).fetchone()
    conn.close()
    d = _d(updated) if updated else {}
    return d.get("verified") == 1


def reset_daily_quota_if_needed(user: dict) -> int:
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    if user["quota_date"] != today:
        conn = _get_conn()
        conn.execute("UPDATE users SET quota_used_today = 0, quota_date = ? WHERE id = ?", (today, user["id"]))
        conn.commit()
        conn.close()
        user["quota_used_today"] = 0; user["quota_date"] = today
    return max(0, user["quota_daily"] - user["quota_used_today"])


def increment_quota(user_id: int) -> int:
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    conn = _get_conn()
    conn.execute("UPDATE users SET quota_used_today = quota_used_today + 1, quota_date = ? WHERE id = ?", (today, user_id))
    conn.commit()
    user = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    conn.close()
    return max(0, _d(user)["quota_daily"] - _d(user)["quota_used_today"])


# === JWT ===

def create_access_token(user_id: int, email: str) -> str:
    expires = datetime.now(timezone.utc) + timedelta(hours=ACCESS_TOKEN_EXPIRE_HOURS)
    return jwt.encode({"sub": str(user_id), "email": email, "exp": expires}, SECRET_KEY, algorithm=ALGORITHM)

def verify_token(token: str) -> dict | None:
    try: return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except JWTError: return None

async def get_current_user(authorization: str | None = Header(None)) -> dict:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="未登录，请先注册或登录")
    token = authorization[7:]
    payload = verify_token(token)
    if not payload: raise HTTPException(status_code=401, detail="登录已过期，请重新登录")
    user = get_user_by_id(int(payload["sub"]))
    if not user: raise HTTPException(status_code=401, detail="用户不存在")
    return user

ADMIN_EMAILS = os.getenv("ADMIN_EMAILS", "").split(",")

def is_admin(user: dict) -> bool:
    return user.get("id") == 1 or user.get("email", "").strip() in [e.strip() for e in ADMIN_EMAILS if e.strip()]

async def get_admin_user(authorization: str | None = Header(None)) -> dict:
    user = await get_current_user(authorization)
    if not is_admin(user): raise HTTPException(status_code=403, detail="需要管理员权限")
    return user

def list_all_users() -> list[dict]:
    conn = _get_conn()
    rows = conn.execute("SELECT id, email, plan, quota_daily, quota_used_today, quota_date, verified, created_at FROM users ORDER BY id DESC").fetchall()
    conn.close()
    return rows

def get_user_stats() -> dict:
    conn = _get_conn()
    total = conn.execute("SELECT COUNT(*) as c FROM users").fetchone()
    verified = conn.execute("SELECT COUNT(*) as c FROM users WHERE verified = 1").fetchone()
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    today_new = conn.execute("SELECT COUNT(*) as c FROM users WHERE date(created_at) = ?", (today,)).fetchone()
    conn.close()
    return {"total": (_d(total) or {}).get("c", 0), "verified": (_d(verified) or {}).get("c", 0), "today_new": (_d(today_new) or {}).get("c", 0)}

def upgrade_user_plan(user_id: int, plan: str, quota_daily: int | None = None) -> dict:
    if plan not in PLAN_QUOTAS: raise HTTPException(status_code=400, detail=f"无效套餐: {plan}")
    new_quota = quota_daily if quota_daily is not None else PLAN_QUOTAS[plan]
    conn = _get_conn()
    conn.execute("UPDATE users SET plan = ?, quota_daily = ?, quota_used_today = 0 WHERE id = ?", (plan, new_quota, user_id))
    conn.commit()
    user = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    conn.close()
    if not user: raise HTTPException(status_code=404, detail="用户不存在")
    return _d(user)

def add_user_quota(user_id: int, amount: int) -> dict:
    if amount <= 0: raise HTTPException(status_code=400, detail="充值数量必须大于 0")
    conn = _get_conn()
    conn.execute("UPDATE users SET quota_daily = quota_daily + ? WHERE id = ?", (amount, user_id))
    conn.commit()
    user = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    conn.close()
    if not user: raise HTTPException(status_code=404, detail="用户不存在")
    return _d(user)
