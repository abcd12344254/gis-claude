"""
项目持久化模块 — Turso/SQLite 存储
"""
import os, json
from datetime import datetime

TURSO_URL = os.getenv("TURSO_URL", "")
TURSO_TOKEN = os.getenv("TURSO_TOKEN", "")
_USE_TURSO = bool(TURSO_URL and TURSO_TOKEN)

if _USE_TURSO:
    import httpx
    from auth import _TursoConn as _ConnClass, _TursoResult, _d as _row_to_dict
    DB_PATH = TURSO_URL
else:
    import sqlite3 as _sql_driver
    from auth import DB_PATH
    _row_to_dict = dict

def _conn():
    if _USE_TURSO:
        return _ConnClass()
    else:
        c = _sql_driver.connect(DB_PATH)
        c.row_factory = _sql_driver.Row
        c.execute("PRAGMA foreign_keys = ON")
        return c


def init_project_tables():
    c = _conn()
    c.execute("""CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
        name TEXT NOT NULL, map_state TEXT DEFAULT '{}',
        chat_history TEXT DEFAULT '[]',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id))""")
    c.execute("""CREATE TABLE IF NOT EXISTS project_layers (
        id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL,
        name TEXT NOT NULL, layer_type TEXT DEFAULT 'geojson',
        geojson_data TEXT NOT NULL, color TEXT DEFAULT '#1677ff',
        opacity REAL DEFAULT 0.7, visible INTEGER DEFAULT 1,
        sort_order INTEGER DEFAULT 0,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE)""")
    c.commit()
    c.close()


def create_project(user_id: int, name: str, map_state: dict | None = None) -> dict:
    c = _conn()
    cur = c.execute("INSERT INTO projects (user_id, name, map_state) VALUES (?, ?, ?)",
                     (user_id, name, json.dumps(map_state or {})))
    c.commit()
    pid = cur.lastrowid if hasattr(cur, 'lastrowid') and cur.lastrowid else None
    if pid is None:
        r = c.execute("SELECT last_insert_rowid()").fetchone()
        pid = r.get("last_insert_rowid()") if isinstance(r, dict) else (r[0] if r else 1)
    row = c.execute("SELECT * FROM projects WHERE id = ?", (pid,)).fetchone()
    c.close()
    return _row_to_dict(row) if row else {}


def list_projects(user_id: int) -> list[dict]:
    c = _conn()
    rows = c.execute("SELECT * FROM projects WHERE user_id = ? ORDER BY updated_at DESC", (user_id,)).fetchall()
    c.close()
    return [_row_to_dict(r) for r in rows] if rows else []


def get_project(project_id: int, user_id: int) -> dict | None:
    c = _conn()
    row = c.execute("SELECT * FROM projects WHERE id = ? AND user_id = ?", (project_id, user_id)).fetchone()
    c.close()
    return _row_to_dict(row) if row else None


def update_project(project_id: int, user_id: int, **kwargs) -> dict | None:
    allowed = {"name", "map_state", "chat_history"}
    updates = {k: v for k, v in kwargs.items() if k in allowed}
    if not updates: return None
    if "map_state" in updates: updates["map_state"] = json.dumps(updates["map_state"])
    if "chat_history" in updates: updates["chat_history"] = json.dumps(updates["chat_history"])
    updates["updated_at"] = datetime.utcnow().isoformat()
    set_clause = ", ".join(f"{k} = ?" for k in updates)
    values = list(updates.values()) + [project_id, user_id]
    c = _conn()
    c.execute(f"UPDATE projects SET {set_clause} WHERE id = ? AND user_id = ?", values)
    c.commit()
    row = c.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
    c.close()
    return _row_to_dict(row) if row else None


def delete_project(project_id: int, user_id: int) -> bool:
    c = _conn()
    c.execute("DELETE FROM projects WHERE id = ? AND user_id = ?", (project_id, user_id))
    c.commit()
    c.close()
    return True


def save_layers(project_id: int, layers: list[dict]):
    c = _conn()
    c.execute("DELETE FROM project_layers WHERE project_id = ?", (project_id,))
    for i, layer in enumerate(layers):
        c.execute(
            "INSERT INTO project_layers (project_id, name, layer_type, geojson_data, color, opacity, visible, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (project_id, layer.get("name", "未命名"), layer.get("type", "geojson"),
             json.dumps(layer.get("data", {})), layer.get("color", "#1677ff"),
             layer.get("opacity", 0.7), 1 if layer.get("visible", True) else 0, i))
    c.commit()
    c.close()


def load_layers(project_id: int) -> list[dict]:
    c = _conn()
    rows = c.execute("SELECT * FROM project_layers WHERE project_id = ? ORDER BY sort_order", (project_id,)).fetchall()
    c.close()
    return [
        {"name": r["name"] if isinstance(r, dict) else r[2],
         "type": r["layer_type"] if isinstance(r, dict) else r[3],
         "data": json.loads(r["geojson_data"] if isinstance(r, dict) else r[4]),
         "color": r.get("color", "#1677ff") if isinstance(r, dict) else r[5],
         "opacity": r.get("opacity", 0.7) if isinstance(r, dict) else r[6],
         "visible": bool(r.get("visible", True) if isinstance(r, dict) else r[7])}
        for r in (rows or [])
    ]
