"""
GIS Claude Backend Server
提供 DeepSeek API 代理、OSM 数据代理、空间分析服务
"""
import os
import json
from contextlib import asynccontextmanager
from pathlib import Path
from typing import List, Optional
from fastapi import FastAPI, HTTPException, Query, Header, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import httpx
from dotenv import load_dotenv
load_dotenv(dotenv_path=Path(__file__).parent / ".env")  # 必须在 auth 导入之前加载，否则 ADMIN_EMAILS 为空
from auth import (
    init_db,
    create_user,
    authenticate_user,
    create_access_token,
    get_current_user,
    get_admin_user,
    reset_daily_quota_if_needed,
    increment_quota,
    verify_token,
    get_user_by_id,
    verify_user_email,
    get_user_by_email,
    list_all_users,
    get_user_stats,
    is_admin,
    upgrade_user_plan,
    add_user_quota,
    PLAN_QUOTAS,
    UserRegister,
    UserLogin,
    UserInfo,
)
from email_verification import send_verification_code, verify_code
from projects import (
    init_project_tables,
    create_project,
    list_projects,
    get_project,
    update_project,
    delete_project,
    save_layers,
    load_layers,
)

# ====== Lifespan ======

@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    init_project_tables()
    yield

app = FastAPI(title="GIS Claude API", version="1.0.0", lifespan=lifespan)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Config
DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY", "")
DEEPSEEK_API_URL = "https://api.deepseek.com/chat/completions"

# Proxy config for OSM access (国内用户可设置 HTTP_PROXY 环境变量或 .env 中的 HTTPS_PROXY)
# 例如: HTTPS_PROXY=http://127.0.0.1:7890
OSM_PROXY = os.getenv("HTTPS_PROXY", os.getenv("HTTP_PROXY", None))

NOMINATIM_URL = "https://nominatim.openstreetmap.org"
OVERPASS_URL = "https://overpass-api.de"
OSM_HEADERS = {
    "User-Agent": "GISClaude/1.0 (gis-learning-tool)",
    "Accept": "application/json",
}

SYSTEM_PROMPT = """你是 GIS Claude，一个专业的地理信息系统（GIS）智能助手。你具备以下能力：

1. **空间分析专家**：你能帮助用户理解和执行各种空间分析操作，包括：
   - 缓冲区分析（Buffer）
   - 叠加分析（Intersect、Union、Difference）
   - 距离和面积计算
   - 中心点、边界框计算
   - 简化（Simplify）、凸包（Convex Hull）
   - 空间查询和邻近分析

2. **GIS 知识库**：你精通：
   - 坐标系和投影（WGS84、Web Mercator、UTM、CGCS2000等）
   - 空间数据格式（GeoJSON、Shapefile、KML、WKT等）
   - 地图渲染和可视化最佳实践
   - 空间数据库（PostGIS、SpatiaLite）
   - OGC标准（WMS、WFS、WCS）

3. **编程辅助**：你可以帮助编写：
   - Turf.js 空间分析代码
   - MapLibre GL JS 地图操作代码
   - GeoPandas/Python 空间数据处理脚本
   - SQL 空间查询语句

4. **数据建议**：根据不同分析需求，推荐合适的配色方案、分类方法、符号化方案。

请用中文回答，保持专业、简洁、实用。当用户提出空间分析需求时，主动提供具体的操作步骤或代码示例。"""


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    messages: List[ChatMessage]


class ChatResponse(BaseModel):
    content: str
    model: str = "deepseek-chat"


class RechargeUpgradeRequest(BaseModel):
    plan: str  # "free" | "pro" | "team"


class RechargeQuotaRequest(BaseModel):
    amount: int


class AdminUpgradeRequest(BaseModel):
    plan: str
    quota_daily: int | None = None


class AdminQuotaRequest(BaseModel):
    amount: int


def get_httpx_client(timeout: float = 30.0) -> httpx.AsyncClient:
    """创建 httpx 客户端，支持代理"""
    kwargs = {"timeout": timeout, "headers": OSM_HEADERS}
    if OSM_PROXY:
        kwargs["proxy"] = OSM_PROXY
    return httpx.AsyncClient(**kwargs)


def get_overpass_client() -> httpx.AsyncClient:
    """Overpass 专用客户端（大数据查询需要更长超时）"""
    return get_httpx_client(timeout=120.0)


# ====== Health ======

@app.get("/api/health")
async def health_check():
    from auth import DB_PATH, _USE_TURSO
    turso_configured = bool(os.getenv("TURSO_URL") and os.getenv("TURSO_TOKEN"))
    user_count = -1
    try:
        conn = __import__('auth')._get_conn()
        r = conn.execute("SELECT COUNT(*) as c FROM users").fetchone()
        user_count = r.get("c", 0) if isinstance(r, dict) else (r[0] if r else 0)
        conn.close()
    except Exception as e:
        user_count = -1
    return {
        "status": "ok",
        "service": "GIS Claude API",
        "use_turso": _USE_TURSO,
        "turso_env_set": turso_configured,
        "db_path": DB_PATH[:60] + "..." if len(DB_PATH) > 60 else DB_PATH,
        "user_count": user_count,
        "db": "Turso Cloud",
    }


# ====== Auth ======


@app.post("/api/auth/register")
async def auth_register(req: UserRegister):
    """注册新用户"""
    print(f"[REGISTER] 收到注册请求: email={req.email}, password_len={len(req.password)}", flush=True)
    try:
        user = create_user(req.email, req.password)
        print(f"[REGISTER] 注册成功: id={user['id']}, email={user['email']}", flush=True)
        token = create_access_token(user["id"], user["email"])
        return {"token": token, "user": {"id": user["id"], "email": user["email"], "plan": user["plan"], "verified": user.get("verified", 0), "is_admin": is_admin(user)}}
    except HTTPException:
        print(f"[REGISTER] 注册失败(HTTPException): {req.email}", flush=True)
        raise
    except Exception as e:
        print(f"[REGISTER] 注册失败(Exception): {req.email}, error={e}", flush=True)
        raise HTTPException(status_code=500, detail=f"注册失败: {str(e)}")


@app.post("/api/auth/login")
async def auth_login(req: UserLogin):
    """登录"""
    user = authenticate_user(req.email, req.password)
    if not user:
        raise HTTPException(status_code=401, detail="邮箱或密码错误")
    token = create_access_token(user["id"], user["email"])
    return {"token": token, "user": {"id": user["id"], "email": user["email"], "plan": user["plan"], "verified": user.get("verified", 0), "is_admin": is_admin(user)}}


class SendCodeRequest(BaseModel):
    email: str


class VerifyCodeRequest(BaseModel):
    email: str
    code: str


@app.post("/api/auth/send-code")
async def auth_send_code(req: SendCodeRequest):
    """发送邮箱验证码"""
    try:
        existing = get_user_by_email(req.email)
        if existing and existing.get("verified"):
            return {"success": False, "message": "该邮箱已注册，请直接登录"}
        return send_verification_code(req.email)
    except Exception as e:
        return {"success": False, "message": f"发送失败: {str(e)}"}


@app.post("/api/auth/verify-email")
async def auth_verify_email(req: VerifyCodeRequest):
    """验证邮箱验证码"""
    try:
        ok = verify_code(req.email, req.code)
        if not ok:
            raise HTTPException(status_code=400, detail="验证码错误或已过期")
        # 如果用户已注册则标记验证，未注册也不报错（注册在验证之后）
        verify_user_email(req.email)
        return {"ok": True, "message": "邮箱验证成功"}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"验证失败: {str(e)}")


@app.get("/api/auth/me")
async def auth_me(user: dict = Depends(get_current_user)):
    """获取当前用户信息"""
    remaining = reset_daily_quota_if_needed(user)
    return {
        "id": user["id"],
        "email": user["email"],
        "plan": user["plan"],
        "quota_daily": user["quota_daily"],
        "quota_remaining": remaining,
        "is_admin": is_admin(user),
    }


# ====== 管理员接口 ======


@app.get("/api/admin/users")
async def admin_list_users(admin: dict = Depends(get_admin_user)):
    """管理员：列出所有注册用户"""
    users = list_all_users()
    stats = get_user_stats()
    return {"users": users, "stats": stats}


@app.get("/api/admin/users/export")
async def admin_export_users(admin: dict = Depends(get_admin_user)):
    """管理员：导出用户 CSV"""
    import io
    users = list_all_users()
    output = io.StringIO()
    output.write("id,email,plan,verified,quota_daily,quota_used_today,created_at\n")
    for u in users:
        output.write(f'{u["id"]},{u["email"]},{u["plan"]},{u["verified"]},{u["quota_daily"]},{u["quota_used_today"]},"{u["created_at"]}"\n')
    csv_content = output.getvalue()
    output.close()
    from fastapi.responses import Response
    return Response(
        content=csv_content.encode("utf-8-sig"),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=users_export.csv"},
    )


# ====== 充值 / 升级 ======


def _user_response(user: dict) -> dict:
    """构建统一的用户信息返回"""
    quota_remaining = max(0, user.get("quota_daily", 0) - user.get("quota_used_today", 0))
    return {
        "id": user["id"],
        "email": user["email"],
        "plan": user["plan"],
        "quota_daily": user["quota_daily"],
        "quota_used_today": user.get("quota_used_today", 0),
        "quota_remaining": quota_remaining,
        "is_admin": is_admin(user),
    }


@app.post("/api/recharge/upgrade")
async def recharge_upgrade(req: RechargeUpgradeRequest, user: dict = Depends(get_current_user)):
    """自助升级套餐"""
    if req.plan not in PLAN_QUOTAS:
        raise HTTPException(status_code=400, detail=f"无效套餐: {req.plan}，可选: {', '.join(PLAN_QUOTAS.keys())}")
    updated = upgrade_user_plan(user["id"], req.plan)
    plan_names = {"free": "免费版", "pro": "专业版", "team": "团队版"}
    return {"ok": True, "user": _user_response(updated), "message": f"已升级至 {plan_names.get(req.plan, req.plan)}"}


@app.post("/api/recharge/quota")
async def recharge_quota(req: RechargeQuotaRequest, user: dict = Depends(get_current_user)):
    """自助充值配额"""
    if req.amount <= 0:
        raise HTTPException(status_code=400, detail="充值数量必须大于 0")
    updated = add_user_quota(user["id"], req.amount)
    return {"ok": True, "user": _user_response(updated), "message": f"已增加 {req.amount} 次每日配额"}


@app.post("/api/admin/users/{user_id}/upgrade")
async def admin_upgrade_user(user_id: int, req: AdminUpgradeRequest, admin: dict = Depends(get_admin_user)):
    """管理员给指定用户升级套餐"""
    if req.plan not in PLAN_QUOTAS:
        raise HTTPException(status_code=400, detail=f"无效套餐: {req.plan}")
    target = get_user_by_id(user_id)
    if not target:
        raise HTTPException(status_code=404, detail="用户不存在")
    updated = upgrade_user_plan(user_id, req.plan, req.quota_daily)
    return {"ok": True, "user": _user_response(updated)}


@app.post("/api/admin/users/{user_id}/quota")
async def admin_add_user_quota(user_id: int, req: AdminQuotaRequest, admin: dict = Depends(get_admin_user)):
    """管理员给指定用户增加配额"""
    if req.amount <= 0:
        raise HTTPException(status_code=400, detail="充值数量必须大于 0")
    target = get_user_by_id(user_id)
    if not target:
        raise HTTPException(status_code=404, detail="用户不存在")
    updated = add_user_quota(user_id, req.amount)
    return {"ok": True, "user": _user_response(updated)}


# ====== Projects ======


class ProjectCreate(BaseModel):
    name: str
    map_state: dict | None = None


class ProjectUpdate(BaseModel):
    name: str | None = None
    map_state: dict | None = None
    chat_history: list | None = None


class LayersSave(BaseModel):
    layers: list[dict]


@app.get("/api/projects")
async def api_list_projects(user: dict = Depends(get_current_user)):
    """列出用户的所有项目"""
    return list_projects(user["id"])


@app.post("/api/projects")
async def api_create_project(body: ProjectCreate, user: dict = Depends(get_current_user)):
    """创建新项目"""
    return create_project(user["id"], body.name, body.map_state)


@app.get("/api/projects/{project_id}")
async def api_get_project(project_id: int, user: dict = Depends(get_current_user)):
    """获取项目详情"""
    proj = get_project(project_id, user["id"])
    if not proj:
        raise HTTPException(status_code=404, detail="项目不存在")
    return proj


@app.put("/api/projects/{project_id}")
async def api_update_project(project_id: int, body: ProjectUpdate, user: dict = Depends(get_current_user)):
    """更新项目"""
    kwargs = {k: v for k, v in body.model_dump().items() if v is not None}
    proj = update_project(project_id, user["id"], **kwargs)
    if not proj:
        raise HTTPException(status_code=404, detail="项目不存在")
    return proj


@app.delete("/api/projects/{project_id}")
async def api_delete_project(project_id: int, user: dict = Depends(get_current_user)):
    """删除项目"""
    if not delete_project(project_id, user["id"]):
        raise HTTPException(status_code=404, detail="项目不存在")
    return {"ok": True}


@app.get("/api/projects/{project_id}/layers")
async def api_load_layers(project_id: int, user: dict = Depends(get_current_user)):
    """加载项目的图层"""
    proj = get_project(project_id, user["id"])
    if not proj:
        raise HTTPException(status_code=404, detail="项目不存在")
    return load_layers(project_id)


@app.post("/api/projects/{project_id}/layers")
async def api_save_layers(project_id: int, body: LayersSave, user: dict = Depends(get_current_user)):
    """保存项目的图层"""
    proj = get_project(project_id, user["id"])
    if not proj:
        raise HTTPException(status_code=404, detail="项目不存在")
    save_layers(project_id, body.layers)
    return {"ok": True, "count": len(body.layers)}


async def _get_optional_user(authorization: str | None = Header(None)) -> dict | None:
    """可选认证：已登录返回 user，未登录返回 None（不报错）"""
    if not authorization or not authorization.startswith("Bearer "):
        return None
    token = authorization[7:]
    # API Key 以 sk- 开头，不是 JWT
    if token.startswith("sk-"):
        return None
    payload = verify_token(token)
    if not payload:
        return None
    return get_user_by_id(int(payload["sub"]))


# ====== DeepSeek Chat ======

# 内存级请求限流: {key_hash: [timestamps]}
import time as _time
from collections import defaultdict
_rate_limit_store: dict[str, list[float]] = defaultdict(list)
_RATE_LIMIT_WINDOW = 60  # 秒
_RATE_LIMIT_MAX = 20      # 每窗口最大请求数


def _check_rate_limit(key: str) -> bool:
    """简单滑窗限流，返回 True=允许"""
    now = _time.time()
    timestamps = _rate_limit_store[key]
    # 清理过期记录
    timestamps[:] = [t for t in timestamps if now - t < _RATE_LIMIT_WINDOW]
    if len(timestamps) >= _RATE_LIMIT_MAX:
        return False
    timestamps.append(now)
    return True


@app.post("/api/chat", response_model=ChatResponse)
async def chat(
    req: ChatRequest,
    user: dict = Depends(get_current_user),
):
    """代理 DeepSeek API 聊天请求 — 需要登录

    API Key: 使用 server/.env 中的 DEEPSEEK_API_KEY
    """
    api_key = DEEPSEEK_API_KEY
    if not api_key:
        raise HTTPException(
            status_code=501,
            detail="服务端 DeepSeek API Key 未配置，请联系管理员",
        )

    # 检查配额
    remaining = reset_daily_quota_if_needed(user)
    if remaining <= 0:
        raise HTTPException(
            status_code=429,
            detail=f"今日 API 配额已用完（{user['quota_daily']}次/天）。请明天再试或升级套餐。",
        )

    # 限流
    if not _check_rate_limit(user["email"]):
        raise HTTPException(
            status_code=429,
            detail=f"请求过于频繁，每 {_RATE_LIMIT_WINDOW} 秒最多 {_RATE_LIMIT_MAX} 次",
        )

    # 扣减配额
    increment_quota(user["id"])

    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    for m in req.messages:
        if m.role in ("user", "assistant", "system"):
            messages.append({"role": m.role, "content": m.content})

    async with httpx.AsyncClient(timeout=60.0) as client:
        try:
            response = await client.post(
                DEEPSEEK_API_URL,
                json={
                    "model": "deepseek-chat",
                    "messages": messages,
                    "temperature": 0.7,
                    "max_tokens": 4096,
                },
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {api_key}",
                },
            )
            response.raise_for_status()
            data = response.json()
            return ChatResponse(
                content=data["choices"][0]["message"]["content"],
                model=data.get("model", "deepseek-chat"),
            )
        except httpx.HTTPStatusError as e:
            if e.response.status_code == 401:
                raise HTTPException(status_code=401, detail="Invalid API Key")
            if e.response.status_code == 429:
                raise HTTPException(status_code=429, detail="Rate limited")
            raise HTTPException(
                status_code=e.response.status_code,
                detail=f"DeepSeek API error: {e.response.text}",
            )
        except httpx.TimeoutException:
            raise HTTPException(status_code=504, detail="DeepSeek API timeout")
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Request failed: {str(e)}")


@app.post("/api/chat/stream")
async def chat_stream(
    req: ChatRequest,
    user: dict = Depends(get_current_user),
):
    """SSE 流式代理 DeepSeek API — 需要登录"""
    api_key = DEEPSEEK_API_KEY
    if not api_key:
        raise HTTPException(status_code=501, detail="服务端 API Key 未配置")

    remaining = reset_daily_quota_if_needed(user)
    if remaining <= 0:
        raise HTTPException(status_code=429, detail="今日配额已用完")

    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    for m in req.messages:
        if m.role in ("user", "assistant", "system"):
            messages.append({"role": m.role, "content": m.content})

    async def event_stream():
        try:
            async with httpx.AsyncClient(timeout=120.0) as client:
                async with client.stream(
                    "POST",
                    DEEPSEEK_API_URL,
                    json={
                        "model": "deepseek-chat",
                        "messages": messages,
                        "temperature": 0.7,
                        "max_tokens": 4096,
                        "stream": True,
                    },
                    headers={
                        "Content-Type": "application/json",
                        "Authorization": f"Bearer {api_key}",
                    },
                ) as response:
                    if response.status_code != 200:
                        error_text = await response.aread()
                        yield f"event: error\ndata: DeepSeek API error ({response.status_code})\n\n"
                        return

                    async for line in response.aiter_lines():
                        if line.startswith("data: "):
                            data = line[6:]
                            if data == "[DONE]":
                                yield "event: done\ndata: [DONE]\n\n"
                                break
                            try:
                                chunk = json.loads(data)
                                delta = chunk.get("choices", [{}])[0].get("delta", {})
                                content = delta.get("content", "")
                                if content:
                                    # SSE 格式: 每行以 data: 开头
                                    yield f"data: {json.dumps({'content': content})}\n\n"
                            except json.JSONDecodeError:
                                pass
        except Exception as e:
            yield f"event: error\ndata: {json.dumps({'error': str(e)})}\n\n"

        # 扣配额
        if user:
            increment_quota(user["id"])

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ====== 地图视觉分析 ======

class VisionRequest(BaseModel):
    image: str       # base64 data:image/png;...
    prompt: str      # 用户输入的提示词

@app.post("/api/vision")
async def vision_analyze(
    req: VisionRequest,
    user: dict = Depends(get_current_user),
):
    """地图截图视觉分析 — SSE 流式返回（需要登录）"""
    api_key = DEEPSEEK_API_KEY
    if not api_key:
        raise HTTPException(status_code=501, detail="服务端 API Key 未配置")

    remaining = reset_daily_quota_if_needed(user)
    if remaining <= 0:
        raise HTTPException(status_code=429, detail="今日配额已用完")

    _check_rate_limit(user["id"])

    # 构建视觉消息：图片 + 文本
    vision_messages = [{
        "role": "user",
        "content": [
            {"type": "image_url", "image_url": {"url": req.image}},
            {"type": "text", "text": req.prompt},
        ]
    }]

    async def event_stream():
        try:
            async with httpx.AsyncClient(timeout=120.0) as client:
                async with client.stream(
                    "POST",
                    DEEPSEEK_API_URL,
                    json={
                        "model": "deepseek-chat",
                        "messages": vision_messages,
                        "temperature": 0.7,
                        "max_tokens": 2048,
                        "stream": True,
                    },
                    headers={
                        "Content-Type": "application/json",
                        "Authorization": f"Bearer {api_key}",
                    },
                ) as response:
                    if response.status_code != 200:
                        error_text = await response.aread()
                        yield f"event: error\ndata: DeepSeek Vision API error ({response.status_code}): {error_text.decode()[:200]}\n\n"
                        return

                    async for line in response.aiter_lines():
                        if line.startswith("data: "):
                            data = line[6:]
                            if data == "[DONE]":
                                yield "event: done\ndata: [DONE]\n\n"
                                break
                            try:
                                chunk = json.loads(data)
                                delta = chunk.get("choices", [{}])[0].get("delta", {})
                                content = delta.get("content", "")
                                if content:
                                    yield f"data: {json.dumps({'content': content})}\n\n"
                            except json.JSONDecodeError:
                                pass
        except Exception as e:
            yield f"event: error\ndata: {json.dumps({'error': str(e)})}\n\n"

        if user:
            increment_quota(user["id"])

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ====== OSM 数据代理 ======

@app.get("/api/osm/nominatim/search")
async def osm_nominatim_search(
    q: str = Query(..., description="搜索关键词"),
    limit: int = Query(5, description="结果数量"),
    polygon_geojson: int = Query(1, description="是否返回 GeoJSON 边界"),
):
    """代理 Nominatim 地理编码查询（国内需配代理访问 OSM）"""
    params = {
        "q": q,
        "format": "jsonv2",
        "limit": limit,
        "addressdetails": "1",
        "polygon_geojson": str(polygon_geojson),
        "accept-language": "zh",
    }

    try:
        async with get_httpx_client() as client:
            response = await client.get(f"{NOMINATIM_URL}/search", params=params)
            response.raise_for_status()
            return response.json()
    except httpx.TimeoutException:
        raise HTTPException(
            status_code=504,
            detail="Nominatim 请求超时。OSM API 在国内可能无法直接访问，请配置代理。在 server/.env 中设置 HTTPS_PROXY=http://127.0.0.1:端口",
        )
    except httpx.ConnectError as e:
        raise HTTPException(
            status_code=502,
            detail=f"无法连接到 Nominatim ({NOMINATIM_URL})。国内用户请配置代理: 在 server/.env 中设置 HTTPS_PROXY=http://127.0.0.1:你的代理端口",
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Nominatim 查询失败: {str(e)}")


@app.get("/api/osm/nominatim/reverse")
async def osm_nominatim_reverse(
    lat: float = Query(...),
    lon: float = Query(...),
):
    """代理 Nominatim 逆地理编码"""
    params = {
        "lat": lat,
        "lon": lon,
        "format": "jsonv2",
        "accept-language": "zh",
    }
    try:
        async with get_httpx_client() as client:
            response = await client.get(f"{NOMINATIM_URL}/reverse", params=params)
            response.raise_for_status()
            return response.json()
    except httpx.ConnectError:
        raise HTTPException(status_code=502, detail="无法连接到 Nominatim，请配置代理")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"查询失败: {str(e)}")


@app.post("/api/osm/overpass")
async def osm_overpass_query(data: str = Query(..., description="Overpass QL 查询语句")):
    """代理 Overpass API 空间查询（国内需配代理访问 OSM）"""
    try:
        async with get_overpass_client() as client:
            response = await client.post(
                f"{OVERPASS_URL}/api/interpreter",
                data={"data": data},
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
            response.raise_for_status()
            return response.json()
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Overpass 请求超时，请配置代理")
    except httpx.ConnectError:
        raise HTTPException(
            status_code=502,
            detail=f"无法连接到 Overpass API。国内用户请在 server/.env 中设置 HTTPS_PROXY=http://127.0.0.1:你的代理端口",
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Overpass 查询失败: {str(e)}")


# ====== Wikidata 代理（国内访问 Wikidata 可能需要代理） ======

WIKIDATA_URL = "https://www.wikidata.org"


@app.get("/api/wikidata/search")
async def wikidata_search(
    q: str = Query(..., description="搜索关键词"),
    language: str = Query("zh", description="语言"),
    limit: int = Query(3, description="结果数量"),
):
    """代理 Wikidata 实体搜索"""
    params = {
        "action": "wbsearchentities",
        "search": q,
        "language": language,
        "format": "json",
        "limit": str(limit),
    }
    try:
        async with get_httpx_client() as client:
            response = await client.get(f"{WIKIDATA_URL}/w/api.php", params=params)
            response.raise_for_status()
            return response.json()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Wikidata 搜索失败: {str(e)}")


@app.get("/api/wikidata/entity/{entity_id}")
async def wikidata_entity(entity_id: str):
    """代理 Wikidata 实体数据获取"""
    try:
        async with get_httpx_client() as client:
            response = await client.get(
                f"{WIKIDATA_URL}/wiki/Special:EntityData/{entity_id}.json"
            )
            response.raise_for_status()
            return response.json()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Wikidata 实体查询失败: {str(e)}")


# ====== 空间分析 ======

@app.get("/api/spatial/analyze")
async def spatial_analyze(
    operation: str,
    geojson: str,
    radius: Optional[float] = None,
):
    """服务器端空间分析"""
    try:
        data = json.loads(geojson)
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid GeoJSON")

    if not isinstance(data, dict) or data.get("type") != "FeatureCollection":
        raise HTTPException(status_code=400, detail="Expected a FeatureCollection")

    try:
        import geopandas as gpd
        from shapely.geometry import shape
        from shapely import ops

        features = data.get("features", [])
        geometries = [shape(f["geometry"]) for f in features]

        if operation == "buffer":
            if radius is None:
                raise HTTPException(status_code=400, detail="Radius required for buffer")
            buffered = [g.buffer(radius / 111.0) for g in geometries]
            result = {
                "type": "FeatureCollection",
                "features": [
                    {"type": "Feature", "geometry": b.__geo_interface__, "properties": {}}
                    for b in buffered
                ],
            }
            return {"result": result, "description": f"Buffered {len(buffered)} features"}

        elif operation == "area":
            gdf = gpd.GeoDataFrame(geometry=geometries, crs="EPSG:4326")
            gdf_proj = gdf.to_crs("EPSG:3857")
            total_area = gdf_proj.area.sum()
            return {
                "result": None,
                "description": f"总面积: {total_area / 1e6:.2f} 平方公里 ({total_area / 1e6 * 1500:.2f} 亩)",
            }

        elif operation == "centroid":
            centroids = [g.centroid for g in geometries]
            result = {
                "type": "FeatureCollection",
                "features": [
                    {"type": "Feature", "geometry": c.__geo_interface__, "properties": {}}
                    for c in centroids
                ],
            }
            return {"result": result, "description": f"Calculated {len(centroids)} centroids"}

        elif operation == "convex_hull":
            all_points = ops.unary_union(geometries)
            hull = all_points.convex_hull
            result = {
                "type": "FeatureCollection",
                "features": [
                    {"type": "Feature", "geometry": hull.__geo_interface__, "properties": {}}
                ],
            }
            return {"result": result, "description": "Convex hull computed"}

        else:
            raise HTTPException(status_code=400, detail=f"Unknown operation: {operation}")

    except ImportError:
        raise HTTPException(
            status_code=501,
            detail="Server spatial analysis requires geopandas and shapely. Install with: pip install geopandas shapely",
        )


# ====== OSRM 路径规划代理（国内需要代理访问） ======

OSRM_URL = "https://router.project-osrm.org"


@app.get("/api/osrm/route/{profile}")
async def osrm_route(
    profile: str,
    coordinates: str = Query(..., description="坐标串: lng1,lat1;lng2,lat2;..."),
    steps: bool = Query(True, description="是否返回导航步骤"),
    alternatives: bool = Query(False, description="是否返回备选路线"),
    language: str = Query("zh-Hans", description="导航语言"),
):
    """代理 OSRM 路径规划请求（国内需配代理）"""
    # Build query string with only supported parameters
    query_parts = [
        "geometries=geojson",
        "overview=full",
        f"steps={str(steps).lower()}",
        f"alternatives={str(alternatives).lower()}",
    ]
    query_string = "&".join(query_parts)
    full_url = f"{OSRM_URL}/route/v1/{profile}/{coordinates}?{query_string}"

    try:
        print(f"[OSRM] Requesting: {full_url}")
        async with get_httpx_client() as client:
            response = await client.get(full_url)
            if not response.is_success:
                error_body = response.text[:500]
                print(f"[OSRM] Error {response.status_code}: {error_body}")
                raise HTTPException(
                    status_code=502,
                    detail=f"OSRM returned {response.status_code}: {error_body}",
                )
            return response.json()
    except HTTPException:
        raise
    except httpx.TimeoutException:
        raise HTTPException(
            status_code=504,
            detail="OSRM 请求超时。如在国内，请确认 server/.env 中已设置 HTTPS_PROXY",
        )
    except httpx.ConnectError:
        raise HTTPException(
            status_code=502,
            detail=f"无法连接到 OSRM 路由服务器。国内用户请在 server/.env 中配置 HTTPS_PROXY=http://127.0.0.1:代理端口",
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"OSRM 路径规划失败: {str(e)}")


# ====== 高德地图 API（国内地理编码，不需要代理） ======

import math

GAODE_API_KEY = os.getenv("GAODE_API_KEY", "")
GAODE_GEOCODE_URL = "https://restapi.amap.com/v3/geocode/geo"
GAODE_REGEO_URL = "https://restapi.amap.com/v3/geocode/regeo"
GAODE_POI_URL = "https://restapi.amap.com/v3/place/text"


def gcj02_to_wgs84(lng: float, lat: float) -> tuple[float, float]:
    """GCJ-02 → WGS-84 坐标转换（高德/国内地图 → 国际标准）"""
    a = 6378245.0
    ee = 0.00669342162296594323

    def _transform_lat(x: float, y: float) -> float:
        ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * math.sqrt(abs(x))
        ret += (20.0 * math.sin(6.0 * x * math.pi) + 20.0 * math.sin(2.0 * x * math.pi)) * 2.0 / 3.0
        ret += (20.0 * math.sin(y * math.pi) + 40.0 * math.sin(y / 3.0 * math.pi)) * 2.0 / 3.0
        ret += (160.0 * math.sin(y / 12.0 * math.pi) + 320.0 * math.sin(y * math.pi / 30.0)) * 2.0 / 3.0
        return ret

    def _transform_lng(x: float, y: float) -> float:
        ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * math.sqrt(abs(x))
        ret += (20.0 * math.sin(6.0 * x * math.pi) + 20.0 * math.sin(2.0 * x * math.pi)) * 2.0 / 3.0
        ret += (20.0 * math.sin(x * math.pi) + 40.0 * math.sin(x / 3.0 * math.pi)) * 2.0 / 3.0
        ret += (150.0 * math.sin(x / 12.0 * math.pi) + 300.0 * math.sin(x / 30.0 * math.pi)) * 2.0 / 3.0
        return ret

    dlat = _transform_lat(lng - 105.0, lat - 35.0)
    dlng = _transform_lng(lng - 105.0, lat - 35.0)
    radlat = lat / 180.0 * math.pi
    magic = math.sin(radlat)
    magic = 1 - ee * magic * magic
    sqrtmagic = math.sqrt(magic)
    dlat = (dlat * 180.0) / ((a * (1 - ee)) / (magic * sqrtmagic) * math.pi)
    dlng = (dlng * 180.0) / (a / sqrtmagic * math.cos(radlat) * math.pi)
    return lng - dlng, lat - dlat


def get_direct_client() -> httpx.AsyncClient:
    """创建直连 httpx 客户端（不走代理，用于国内 API）"""
    return httpx.AsyncClient(timeout=10.0)


@app.get("/api/gaode/geocode")
async def gaode_geocode(
    address: str = Query(..., description="地址/地名"),
    city: str = Query("", description="城市（可选，限定搜索范围）"),
    location: str = Query("", description="坐标 lng,lat（可选，后端自动反查城市来限定范围）"),
):
    """高德地理编码：地名 → 坐标（GCJ-02，与高德底图对齐）"""
    if not GAODE_API_KEY:
        raise HTTPException(status_code=501, detail="GAODE_API_KEY not configured")

    params = {
        "key": GAODE_API_KEY,
        "address": address,
        "city": city,  # 只有前端显式传 city 才限定
        "output": "JSON",
    }
    try:
        async with get_direct_client() as client:
            resp = await client.get(GAODE_GEOCODE_URL, params=params)
            resp.raise_for_status()
            data = resp.json()
            # 底图已换高德(GCJ-02)，数据保留 GCJ-02 以对齐底图
            return data
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"高德地理编码失败: {str(e)}")


@app.get("/api/gaode/reverse")
async def gaode_reverse(
    lat: float = Query(...),
    lng: float = Query(...),
):
    """高德逆地理编码：坐标 → 地址"""
    if not GAODE_API_KEY:
        raise HTTPException(status_code=501, detail="GAODE_API_KEY not configured")
    params = {
        "key": GAODE_API_KEY,
        "location": f"{lng},{lat}",
        "output": "JSON",
    }
    try:
        async with get_direct_client() as client:
            resp = await client.get(GAODE_REGEO_URL, params=params)
            resp.raise_for_status()
            return resp.json()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"高德逆地理编码失败: {str(e)}")


@app.get("/api/gaode/poi")
async def gaode_poi_search(
    keywords: str = Query(..., description="POI 关键词"),
    city: str = Query("", description="城市（可选）"),
    types: str = Query("", description="POI 类型代码（可选）"),
    offset: int = Query(10, description="返回数量"),
):
    """高德 POI 搜索"""
    if not GAODE_API_KEY:
        raise HTTPException(status_code=501, detail="GAODE_API_KEY not configured")
    params = {
        "key": GAODE_API_KEY,
        "keywords": keywords,
        "city": city,
        "types": types,
        "offset": offset,
        "output": "JSON",
        "extensions": "all",
    }
    try:
        async with get_direct_client() as client:
            resp = await client.get(GAODE_POI_URL, params=params)
            resp.raise_for_status()
            data = resp.json()
            # 底图已换高德(GCJ-02)，数据保留 GCJ-02 以对齐底图
            return data
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"高德POI搜索失败: {str(e)}")


# ====== GeoTIFF DEM 导出 ======


class DEMExportRequest(BaseModel):
    grid: list[dict]  # [{lng, lat, elevation}, ...]
    name: str = "DEM"


@app.post("/api/dem/geotiff")
async def dem_export_geotiff(req: DEMExportRequest):
    """将高程采样网格导出为 GeoTIFF 文件（纯 Python 实现，零依赖）"""
    import numpy as np
    import struct
    import io

    valid = [p for p in req.grid if p.get("elevation") is not None]
    if len(valid) < 4:
        raise HTTPException(status_code=400, detail="有效高程点不足（至少需要4个）")

    lngs = [p["lng"] for p in valid]
    lats = [p["lat"] for p in valid]

    w, e = min(lngs), max(lngs)
    s, n = min(lats), max(lats)

    grid_size = int(len(valid) ** 0.5)
    if grid_size < 2:
        raise HTTPException(status_code=400, detail="无法推断网格尺寸")

    # IDW 插值到均匀网格
    lng_step = (e - w) / grid_size
    lat_step = (n - s) / grid_size
    data = np.zeros((grid_size, grid_size), dtype=np.float32)

    for i in range(grid_size):
        for j in range(grid_size):
            lng = w + (i + 0.5) * lng_step
            lat = s + (j + 0.5) * lat_step
            weight_sum = 0.0
            elev_sum = 0.0
            for vp in valid:
                dx = lng - vp["lng"]
                dy = lat - vp["lat"]
                dist = (dx * dx + dy * dy) ** 0.5
                weight = 1e10 if dist < 1e-10 else 1.0 / (dist * dist)
                elev_sum += vp["elevation"] * weight
                weight_sum += weight
            data[j, i] = float(elev_sum / weight_sum if weight_sum > 0 else 0.0)

    pixel_width = (e - w) / grid_size
    pixel_height = (n - s) / grid_size

    # 写入 GeoTIFF (手动构建 TIFF + GeoKeys)
    buf = io.BytesIO()
    write_le = lambda fmt, *vals: buf.write(struct.pack("<" + fmt, *vals))

    # Float32 光栅数据（行优先，左上角开始）
    raw_data = data.tobytes()

    # TIFF 头
    write_le("H", 0x4949)  # little-endian
    write_le("H", 42)       # TIFF magic
    # IFD 偏移（紧接头后）
    ifd_offset = 8
    # GeoKey 值
    gt_model_type = 2          # geographic
    gt_raster_type = 1         # pixel is area
    gt_citation = "WGS 84 / EPSG:4326"
    geographic_type = 4326
    geog_angular_units = 9102  # degree

    # 构建 GeoKeyDirectory
    # 每个 key: {key_id, tiff_tag_location, count, value}
    geo_keys = [
        (1024, 0, 1, gt_model_type),
        (1025, 0, 1, gt_raster_type),
        (2048, 0, 1, geographic_type),
        (2054, 0, 1, geog_angular_units),
    ]
    geo_key_data = b""
    for kid, loc, cnt, val in geo_keys:
        geo_key_data += struct.pack("<HHHH", kid, loc, cnt, val)

    # GeoAsciiParams
    geo_ascii = gt_citation.encode("ascii") + b"\x00"

    # ModelTiepointTag: (0, 0, 0) → (west, north, 0)
    tiepoint = struct.pack("<ddd", 0.0, 0.0, 0.0) + struct.pack("<ddd", w, n, 0.0)

    # ModelPixelScaleTag: (pixel_width, pixel_height, 0)
    pixel_scale = struct.pack("<ddd", pixel_width, pixel_height, 0.0)

    # 构建所有 TIFF 标签
    tags = [
        (256, 4, 1, struct.pack("<I", grid_size)),                # ImageWidth
        (257, 4, 1, struct.pack("<I", grid_size)),                # ImageLength
        (258, 3, 1, struct.pack("<H", 32)),                       # BitsPerSample
        (259, 3, 1, struct.pack("<H", 1)),                        # Compression (none)
        (262, 3, 1, struct.pack("<H", 1)),                        # Photometric (min is black)
        (273, 4, 1, b"\x00"),                                     # StripOffsets (placeholder)
        (277, 3, 1, struct.pack("<H", 1)),                        # SamplesPerPixel
        (278, 4, 1, struct.pack("<I", grid_size)),                # RowsPerStrip
        (279, 4, 1, b"\x00"),                                     # StripByteCounts (placeholder)
        (282, 5, 1, b"\x00"),                                     # XResolution (placeholder)
        (283, 5, 1, b"\x00"),                                     # YResolution (placeholder)
        (296, 3, 1, struct.pack("<H", 2)),                        # ResolutionUnit (inch)
        (339, 3, 1, struct.pack("<H", 3)),                        # SampleFormat (float)
        (33550, 12, 3, pixel_scale),                               # ModelPixelScaleTag
        (33922, 12, 6, tiepoint),                                  # ModelTiepointTag
        (34735, 3, len(geo_key_data) // 2, geo_key_data),          # GeoKeyDirectoryTag
        (34737, 2, len(geo_ascii), geo_ascii),                     # GeoAsciiParamsTag
    ]

    # 计算 strip 偏移位置
    ifd_entry_size = 12
    num_tags = len(tags)
    tag_data_start = ifd_offset + 2 + num_tags * ifd_entry_size + 4
    # 按数据 -> 标签顺序排列
    extra_data = tiepoint + pixel_scale + geo_key_data + geo_ascii
    extra_offset = tag_data_start
    strip_offset = extra_offset + len(extra_data)
    strip_byte_count = len(raw_data)

    # 更新 StripOffsets 和 StripByteCounts
    for i, (tid, _, _, _) in enumerate(tags):
        if tid == 273:
            tags[i] = (273, 4, 1, struct.pack("<I", strip_offset))
        elif tid == 279:
            tags[i] = (279, 4, 1, struct.pack("<I", strip_byte_count))

    # 写 IFD 条目
    buf.seek(ifd_offset)
    write_le("H", num_tags)
    for tid, dtype, count, value in tags:
        write_le("H", tid)
        write_le("H", dtype)
        write_le("I", count)
        if len(value) <= 4:
            buf.write(value.ljust(4, b"\x00"))
        else:
            write_le("I", extra_offset)
            extra_offset += len(value)
    write_le("I", 0)  # next IFD

    # 写额外数据
    buf.write(tiepoint)
    buf.write(pixel_scale)
    buf.write(geo_key_data)
    buf.write(geo_ascii)

    # 写光栅数据
    buf.seek(strip_offset)
    buf.write(raw_data)

    buf.seek(0)
    filename = f"{req.name}_DEM.tif"
    from fastapi.responses import Response
    return Response(
        content=buf.getvalue(),
        media_type="image/tiff",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ====== 前端静态文件（生产环境部署用） ======

FRONTEND_DIR = Path(__file__).parent.parent / "dist"

if FRONTEND_DIR.exists():
    # 静态资源
    app.mount("/assets", StaticFiles(directory=FRONTEND_DIR / "assets"), name="assets")

    @app.get("/{full_path:path}")
    async def serve_frontend(full_path: str):
        """SPA 回退：先匹配静态文件，再返回 index.html"""
        # 跳过 API 路径
        if full_path.startswith("api/"):
            raise HTTPException(status_code=404)
        file_path = FRONTEND_DIR / full_path
        if file_path.exists() and file_path.is_file():
            return FileResponse(file_path)
        return FileResponse(FRONTEND_DIR / "index.html")


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", "8001"))
    print(f"Starting GIS Claude API server...")
    print(f"OSM proxy: {OSM_PROXY or 'direct (may be blocked in China)'}")
    print(f"Gaode API: {'configured' if GAODE_API_KEY else 'not configured (set GAODE_API_KEY in .env)'}")
    if FRONTEND_DIR.exists():
        print(f"Frontend: serving from {FRONTEND_DIR}")
    uvicorn.run(app, host="0.0.0.0", port=port)
