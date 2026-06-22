"""
项目持久化模块 — SQLite/Turso 存储用户的项目、图层、对话历史
"""
import os, json
from datetime import datetime

# 复用 auth 的 Turso 检测
TURSO_URL = os.getenv("TURSO_URL", "")
TURSO_TOKEN = os.getenv("TURSO_TOKEN", "")
_USE_TURSO = bool(TURSO_URL and TURSO_TOKEN)

if _USE_TURSO:
    import libsql_experimental as _sql_driver
    DB_PATH = TURSO_URL
else:
    import sqlite3 as _sql_driver
    from auth import DB_PATH


def _conn():
    if _USE_TURSO:
        c = _sql_driver.connect(TURSO_URL, auth_token=TURSO_TOKEN, sync_mode="write")
        c.execute("PRAGMA foreign_keys = ON")
        return c
    else:
        c = _sql_driver.connect(DB_PATH)
        c.row_factory = _sql_driver.Row
        c.execute("PRAGMA foreign_keys = ON")
        return c


def _dict(row):
    """转 dict"""
    if row is None: return None
    if _USE_TURSO:
        if isinstance(row, dict): return row
        if hasattr(row, '_fields'): return dict(zip(row._fields, row))
        return row
    return dict(row)


def _fetchone(cursor, conn=None):
    if _USE_TURSO:
        rows = cursor.fetchall()
        return rows[0] if rows else None
    return cursor.fetchone()


def _fetchall(cursor, conn=None):
    if _USE_TURSO:
        rows = cursor.fetchall()
        if rows and hasattr(cursor, 'description') and cursor.description:
            return [dict(zip(cursor.description, r)) for r in rows]
        return [dict(r) if isinstance(r, dict) else r for r in rows]
    return [dict(r) for r in cursor.fetchall()]


# === 表初始化 ===

def init_project_tables():
    c = _conn()
    c.execute(
        """
        CREATE TABLE IF NOT EXISTS projects (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            map_state TEXT DEFAULT '{}',
            chat_history TEXT DEFAULT '[]',
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (user_id) REFERENCES users(id)
        )
    """
    )
    c.execute(
        """
        CREATE TABLE IF NOT EXISTS project_layers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            layer_type TEXT DEFAULT 'geojson',
            geojson_data TEXT NOT NULL,
            color TEXT DEFAULT '#1677ff',
            opacity REAL DEFAULT 0.7,
            visible INTEGER DEFAULT 1,
            sort_order INTEGER DEFAULT 0,
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        )
    """
    )
    c.commit()
    c.close()


# === 项目 CRUD ===

def create_project(user_id: int, name: str, map_state: dict | None = None) -> dict:
    c = _conn()
    cur = c.execute(
        "INSERT INTO projects (user_id, name, map_state) VALUES (?, ?, ?)",
        (user_id, name, json.dumps(map_state or {})),
    )
    c.commit()
    pid = cur.lastrowid if hasattr(cur, 'lastrowid') else None
    if pid is None:
        pid = _fetchone(c.execute("SELECT last_insert_rowid()"), c)
        pid = pid[0] if pid and not isinstance(pid, dict) else (pid.get('last_insert_rowid()') if isinstance(pid, dict) else 1)
    row = _fetchone(c.execute("SELECT * FROM projects WHERE id = ?", (pid,)), c)
    c.close()
    return _dict(row)


def list_projects(user_id: int) -> list[dict]:
    c = _conn()
    rows = _fetchall(c.execute(
        "SELECT * FROM projects WHERE user_id = ? ORDER BY updated_at DESC", (user_id,)
    ), c)
    c.close()
    return rows


def get_project(project_id: int, user_id: int) -> dict | None:
    c = _conn()
    row = _fetchone(c.execute(
        "SELECT * FROM projects WHERE id = ? AND user_id = ?", (project_id, user_id)
    ), c)
    c.close()
    return _dict(row) if row else None


def update_project(project_id: int, user_id: int, **kwargs) -> dict | None:
    allowed = {"name", "map_state", "chat_history"}
    updates = {k: v for k, v in kwargs.items() if k in allowed}
    if not updates:
        return None
    if "map_state" in updates:
        updates["map_state"] = json.dumps(updates["map_state"])
    if "chat_history" in updates:
        updates["chat_history"] = json.dumps(updates["chat_history"])
    updates["updated_at"] = datetime.utcnow().isoformat()
    set_clause = ", ".join(f"{k} = ?" for k in updates)
    values = list(updates.values()) + [project_id, user_id]
    c = _conn()
    c.execute(f"UPDATE projects SET {set_clause} WHERE id = ? AND user_id = ?", values)
    c.commit()
    row = _fetchone(c.execute("SELECT * FROM projects WHERE id = ?", (project_id,)), c)
    c.close()
    return _dict(row) if row else None


def delete_project(project_id: int, user_id: int) -> bool:
    c = _conn()
    c.execute("DELETE FROM projects WHERE id = ? AND user_id = ?", (project_id, user_id))
    c.commit()
    deleted = c.rowcount > 0 if hasattr(c, 'rowcount') and c.rowcount else True
    c.close()
    return deleted


# === 图层 CRUD ===

def save_layers(project_id: int, layers: list[dict]):
    c = _conn()
    c.execute("DELETE FROM project_layers WHERE project_id = ?", (project_id,))
    for i, layer in enumerate(layers):
        c.execute(
            "INSERT INTO project_layers (project_id, name, layer_type, geojson_data, color, opacity, visible, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                project_id,
                layer.get("name", "未命名"),
                layer.get("type", "geojson"),
                json.dumps(layer.get("data", {})),
                layer.get("color", "#1677ff"),
                layer.get("opacity", 0.7),
                1 if layer.get("visible", True) else 0,
                i,
            ),
        )
    c.commit()
    c.close()


def load_layers(project_id: int) -> list[dict]:
    c = _conn()
    rows = _fetchall(c.execute(
        "SELECT * FROM project_layers WHERE project_id = ? ORDER BY sort_order",
        (project_id,),
    ), c)
    c.close()
    return [
        {
            "name": r["name"] if isinstance(r, dict) else (r[2] if len(r) > 2 else "unknown"),
            "type": r["layer_type"] if isinstance(r, dict) else (r[3] if len(r) > 3 else "geojson"),
            "data": json.loads(r["geojson_data"] if isinstance(r, dict) else (r[4] if len(r) > 4 else "{}")),
            "color": r.get("color", "#1677ff") if isinstance(r, dict) else (r[5] if len(r) > 5 else "#1677ff"),
            "opacity": r.get("opacity", 0.7) if isinstance(r, dict) else (r[6] if len(r) > 6 else 0.7),
            "visible": bool(r.get("visible", True) if isinstance(r, dict) else (r[7] if len(r) > 7 else 1)),
        }
        for r in rows
    ]
