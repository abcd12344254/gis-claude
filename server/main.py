"""
GIS Claude Backend Server
提供 DeepSeek API 代理、OSM 数据代理、空间分析服务
"""
import os
import json
from pathlib import Path
from typing import List, Optional
from fastapi import FastAPI, HTTPException, Query, Header, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import httpx
from dotenv import load_dotenv
from auth import (
    init_db,
    create_user,
    authenticate_user,
    create_access_token,
    get_current_user,
    reset_daily_quota_if_needed,
    increment_quota,
    verify_token,
    get_user_by_id,
    verify_user_email,
    get_user_by_email,
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

load_dotenv()

app = FastAPI(title="GIS Claude API", version="1.0.0")

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

@app.on_event("startup")
async def startup():
    init_db()
    init_project_tables()


@app.get("/api/health")
async def health_check():
    return {
        "status": "ok",
        "service": "GIS Claude API",
        "osm_proxy": OSM_PROXY or "direct",
    }


# ====== Auth ======


@app.post("/api/auth/register")
async def auth_register(req: UserRegister):
    """注册新用户 — 需先调用 /send-code 获取验证码"""
    user = create_user(req.email, req.password)
    token = create_access_token(user["id"], user["email"])
    return {"token": token, "user": {"id": user["id"], "email": user["email"], "plan": user["plan"], "verified": user.get("verified", 0)}}


@app.post("/api/auth/login")
async def auth_login(req: UserLogin):
    """登录"""
    user = authenticate_user(req.email, req.password)
    if not user:
        raise HTTPException(status_code=401, detail="邮箱或密码错误")
    token = create_access_token(user["id"], user["email"])
    return {"token": token, "user": {"id": user["id"], "email": user["email"], "plan": user["plan"], "verified": user.get("verified", 0)}}


class SendCodeRequest(BaseModel):
    email: str


class VerifyCodeRequest(BaseModel):
    email: str
    code: str


@app.post("/api/auth/send-code")
async def auth_send_code(req: SendCodeRequest):
    """发送邮箱验证码"""
    # 检查邮箱是否已被注册
    existing = get_user_by_email(req.email)
    if existing and existing.get("verified"):
        return {"success": False, "message": "该邮箱已注册，请直接登录"}
    return send_verification_code(req.email)


@app.post("/api/auth/verify-email")
async def auth_verify_email(req: VerifyCodeRequest):
    """验证邮箱验证码并激活账号"""
    ok = verify_code(req.email, req.code)
    if not ok:
        raise HTTPException(status_code=400, detail="验证码错误或已过期")
    # 激活用户
    if not verify_user_email(req.email):
        raise HTTPException(status_code=404, detail="用户不存在")
    return {"ok": True, "message": "邮箱验证成功"}


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
    }


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
    """高德地理编码：地名 → 坐标（GCJ-02 → WGS-84）"""
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
            if data.get("status") == "1" and data.get("geocodes"):
                for geo in data["geocodes"]:
                    location = geo.get("location", "")
                    if location:
                        gcj_lng, gcj_lat = map(float, location.split(","))
                        wgs_lng, wgs_lat = gcj02_to_wgs84(gcj_lng, gcj_lat)
                        geo["wgs84_location"] = f"{wgs_lng},{wgs_lat}"
                return data
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
            # 转换坐标
            if data.get("status") == "1" and data.get("pois"):
                for poi in data["pois"]:
                    location = poi.get("location", "")
                    if location:
                        gcj_lng, gcj_lat = map(float, location.split(","))
                        wgs_lng, wgs_lat = gcj02_to_wgs84(gcj_lng, gcj_lat)
                        poi["wgs84_location"] = f"{wgs_lng},{wgs_lat}"
            return data
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"高德POI搜索失败: {str(e)}")


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
