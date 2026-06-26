"""
====== 数据资源 MCP 工具 ======

封装 OSM / 高德 / 资源目录查询为 MCP 标准工具。
与 HermesAgent 文档 3.2 和 7.1 节的规范对齐。

现有后端能力复用：
- osmService: Nominatim geocode + Overpass 查询
- gaodeService: 高德 geocode + POI
- catalog.yaml: 本地资源清单
"""

import os, json, httpx
from pathlib import Path
from dotenv import load_dotenv
from mcp.registry import MCPToolDef

load_dotenv(dotenv_path=Path(__file__).parent.parent / ".env")


# ====== 内部辅助函数 ======

def _get_proxy():
    return os.getenv("HTTPS_PROXY", "")

def _get_gaode_key():
    return os.getenv("GAODE_API_KEY", "")


async def _nominatim_search(query: str, limit: int = 5) -> dict:
    """OSM Nominatim 地理编码"""
    url = "https://nominatim.openstreetmap.org/search"
    proxy = _get_proxy()
    client_config = {"timeout": httpx.Timeout(30.0)}
    if proxy:
        client_config["proxy"] = proxy
    async with httpx.AsyncClient(**client_config) as client:
        resp = await client.get(url, params={
            "q": query, "format": "json", "limit": limit,
            "accept-language": "zh-CN",
        }, headers={"User-Agent": "GIS-Claude/1.0"})
        resp.raise_for_status()
        return resp.json()


async def _overpass_query(ql: str) -> dict:
    """OSM Overpass QL 查询"""
    proxy = _get_proxy()
    urls = [
        "https://overpass-api.de/api/interpreter",
        "https://overpass.kumi.systems/api/interpreter",
        "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    ]
    client_config = {"timeout": httpx.Timeout(90.0)}
    if proxy:
        client_config["proxy"] = proxy
    async with httpx.AsyncClient(**client_config) as client:
        for url in urls:
            try:
                resp = await client.post(url, data={"data": ql})
                resp.raise_for_status()
                return resp.json()
            except Exception:
                continue
        raise Exception("所有 Overpass API 端点均无法访问")


async def _gaode_geocode(query: str) -> dict:
    """高德地理编码"""
    key = _get_gaode_key()
    if not key:
        return {"error": "高德 API Key 未配置"}
    url = "https://restapi.amap.com/v3/geocode/geo"
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(url, params={"key": key, "address": query})
        return resp.json()


async def _gaode_poi(keywords: str, city: str = "", limit: int = 20) -> dict:
    """高德 POI 搜索"""
    key = _get_gaode_key()
    if not key:
        return {"error": "高德 API Key 未配置"}
    url = "https://restapi.amap.com/v3/place/text"
    params = {"key": key, "keywords": keywords, "extensions": "all", "offset": limit}
    if city:
        params["city"] = city
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(url, params=params)
        return resp.json()


def _gcj02_to_wgs84(lng: float, lat: float) -> tuple[float, float]:
    """GCJ-02 → WGS-84 坐标转换"""
    import math
    a = 6378245.0
    ee = 0.00669342162296594323
    dlat = _transform_lat(lng - 105.0, lat - 35.0)
    dlng = _transform_lng(lng - 105.0, lat - 35.0)
    radlat = lat / 180.0 * math.pi
    magic = math.sin(radlat)
    magic = 1 - ee * magic * magic
    sqrtmagic = math.sqrt(magic)
    dlat = (dlat * 180.0) / ((a * (1 - ee)) / (magic * sqrtmagic) * math.pi)
    dlng = (dlng * 180.0) / (a / sqrtmagic * math.cos(radlat) * math.pi)
    return lng - dlng, lat - dlat


def _transform_lat(x: float, y: float) -> float:
    import math
    ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * math.sqrt(abs(x))
    ret += (20.0 * math.sin(6.0 * x * math.pi) + 20.0 * math.sin(2.0 * x * math.pi)) * 2.0 / 3.0
    ret += (20.0 * math.sin(y * math.pi) + 40.0 * math.sin(y / 3.0 * math.pi)) * 2.0 / 3.0
    ret += (160.0 * math.sin(y / 12.0 * math.pi) + 320 * math.sin(y * math.pi / 30.0)) * 2.0 / 3.0
    return ret


def _transform_lng(x: float, y: float) -> float:
    import math
    ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * math.sqrt(abs(x))
    ret += (20.0 * math.sin(6.0 * x * math.pi) + 20.0 * math.sin(2.0 * x * math.pi)) * 2.0 / 3.0
    ret += (20.0 * math.sin(x * math.pi) + 40.0 * math.sin(x / 3.0 * math.pi)) * 2.0 / 3.0
    ret += (150.0 * math.sin(x / 12.0 * math.pi) + 300.0 * math.sin(x / 30.0 * math.pi)) * 2.0 / 3.0
    return ret


# ====== MCP 工具定义 ======

def register_data_tools(registry):
    """向注册中心注册所有数据资源 MCP 工具"""

    # ── list_resources ──
    registry.register(MCPToolDef(
        name="list_resources",
        description="查询本地资源清单，发现可用的 GIS 数据资源。支持按关键词和数据分类筛选。",
        category="resource",
        parameters={
            "keywords": {"type": "string", "required": False,
                         "description": "关键词筛选（匹配资源名称和描述）"},
            "category": {"type": "string", "required": False,
                         "description": "数据分类筛选（行政区划/POI/路网/影像/灾害数据等）"},
        },
        returns={"type": "object", "description": "{resources: [...], total: N}"},
        requires_crs_check=False,
        examples=['{"keywords": "行政区划"}', '{"category": "POI"}'],
        handler=_handle_list_resources,
    ))

    # ── get_resource_handle ──
    registry.register(MCPToolDef(
        name="get_resource_handle",
        description="根据资源名称获取资源的访问句柄（文件路径/数据库连接/服务URL）。",
        category="resource",
        parameters={
            "resource_name": {"type": "string", "required": True,
                              "description": "资源名称（从 list_resources 结果中选择）"},
        },
        returns={"type": "object", "description": "{resource_id, resource_name, resource_type, access: {type, path/url}}"},
        requires_crs_check=False,
        examples=['{"resource_name": "邯郸区县"}'],
        handler=_handle_get_resource_handle,
    ))

    # ── search_gis_data ──
    registry.register(MCPToolDef(
        name="search_gis_data",
        description="搜索 GIS 空间数据。自动依次尝试 OSM Nominatim、高德地图、Wikidata，返回最匹配的地理实体信息。适用于查询行政区划、自然地物、地名等的空间数据。",
        category="resource",
        parameters={
            "query": {"type": "string", "required": True,
                      "description": "地名或地理实体名称（中文）"},
            "geometry_type": {"type": "string", "required": False, "default": "auto",
                              "description": "几何类型：point/line/polygon/auto（默认自动判断）"},
            "data_source": {"type": "string", "required": False, "default": "auto",
                            "enum": ["auto", "osm", "gaode", "wikidata"],
                            "description": "数据源偏好：auto（自动选择）/osm/gaode/wikidata"},
        },
        returns={"type": "object", "description": "{results: [{name, display_name, coordinates, bbox, osm_type, data_source}], source_used}"},
        requires_crs_check=False,
        examples=['{"query": "武汉大学"}', '{"query": "塔克拉玛干沙漠", "geometry_type": "polygon"}'],
        handler=_handle_search_gis_data,
    ))

    # ── query_osm ──
    registry.register(MCPToolDef(
        name="query_osm",
        description="直接执行 OSM Overpass QL 查询。适合高级用户自定查询逻辑。返回原始 OSM JSON。",
        category="resource",
        parameters={
            "query_ql": {"type": "string", "required": True,
                         "description": "Overpass QL 查询语句"},
            "bbox": {"type": "string", "required": False,
                     "description": "空间范围：west,south,east,north（WGS84）"},
        },
        returns={"type": "object", "description": "{elements: [...], osm3s: {...}}"},
        requires_crs_check=False,
        examples=['{"query_ql": "[out:json];rel[\\"boundary\\"=\\"administrative\\"][\\"name\\"=\\"武汉市\\"];out geom;"}'],
        handler=_handle_query_osm,
    ))

    # ── search_poi ──
    registry.register(MCPToolDef(
        name="search_poi",
        description="搜索兴趣点（POI）。自动使用高德地图优先（国内数据更好），OSM 作为补充。",
        category="resource",
        parameters={
            "keywords": {"type": "string", "required": True,
                         "description": "POI 类型关键词（如 university/restaurant/hospital）"},
            "location": {"type": "string", "required": False,
                         "description": "限定区域（地名或地址，如 '武汉市'）"},
            "limit": {"type": "integer", "required": False, "default": 20,
                      "description": "返回数量上限"},
        },
        returns={"type": "object", "description": "{pois: [{name, address, coordinates, category}], total, source}"},
        requires_crs_check=False,
        examples=['{"keywords": "大学", "location": "武汉"}', '{"keywords": "restaurant", "limit": 10}'],
        handler=_handle_search_poi,
    ))


# ====== 工具处理函数 ======

async def _handle_list_resources(params: dict) -> dict:
    """处理 list_resources 调用"""
    import yaml
    catalog_path = Path(__file__).parent.parent / "resources" / "catalog.yaml"
    try:
        with open(catalog_path, "r", encoding="utf-8") as f:
            catalog = yaml.safe_load(f)
    except Exception:
        return {"resources": [], "total": 0, "error": "资源清单文件未找到"}

    resources = catalog.get("resources", [])
    kw = (params.get("keywords") or "").lower()
    cat = (params.get("category") or "")

    if kw:
        resources = [r for r in resources
                     if kw in r.get("resource_name", "").lower()
                     or kw in r.get("description", "").lower()]
    if cat:
        resources = [r for r in resources if r.get("data_category") == cat]

    return {"resources": resources, "total": len(resources)}


async def _handle_get_resource_handle(params: dict) -> dict:
    """处理 get_resource_handle 调用"""
    import yaml
    catalog_path = Path(__file__).parent.parent / "resources" / "catalog.yaml"
    with open(catalog_path, "r", encoding="utf-8") as f:
        catalog = yaml.safe_load(f)

    name = params["resource_name"]
    for r in catalog.get("resources", []):
        if r.get("resource_id") == name or r.get("resource_name") == name:
            return r
    return {"error": f"资源 '{name}' 未找到", "available": [r["resource_name"] for r in catalog.get("resources", [])]}


async def _handle_search_gis_data(params: dict) -> dict:
    """处理 search_gis_data 调用：依次尝试 OSM + 高德"""
    query = params["query"]
    data_source = params.get("data_source", "auto")
    results = []
    source_used = "osm"

    # OSM Nominatim
    try:
        osm_results = await _nominatim_search(query)
        for r in osm_results[:5]:
            lng, lat = float(r["lon"]), float(r["lat"])
            bbox = r.get("boundingbox", [])
            results.append({
                "name": r.get("display_name", ""),
                "display_name": r.get("display_name", ""),
                "coordinates": [lng, lat],
                "bbox": [float(bbox[2]), float(bbox[0]), float(bbox[3]), float(bbox[1])] if len(bbox) >= 4 else None,
                "osm_type": r.get("osm_type", ""),
                "category": r.get("category", ""),
                "importance": r.get("importance", 0),
                "data_source": "osm",
            })
    except Exception as e:
        if data_source == "osm":
            return {"results": [], "error": str(e), "source_used": "osm"}

    # 高德补充
    if data_source in ("auto", "gaode") and _get_gaode_key():
        try:
            gd = await _gaode_geocode(query)
            if gd.get("status") == "1" and gd.get("geocodes"):
                source_used = "gaode" if not results else "osm+gaode"
                for g in gd["geocodes"][:5]:
                    location = g.get("location", "")
                    if location and "," in location:
                        lng_str, lat_str = location.split(",")
                        lng_gg, lat_gg = float(lng_str), float(lat_str)
                        lng_wg, lat_wg = _gcj02_to_wgs84(lng_gg, lat_gg)
                        results.append({
                            "name": g.get("formatted_address", g.get("name", "")),
                            "display_name": g.get("formatted_address", ""),
                            "coordinates": [lng_wg, lat_wg],
                            "coordinates_gcj02": [lng_gg, lat_gg],
                            "address": g.get("address", ""),
                            "level": g.get("level", ""),
                            "data_source": "gaode",
                        })
        except Exception:
            pass

    return {"results": results, "total": len(results), "source_used": source_used}


async def _handle_query_osm(params: dict) -> dict:
    """处理 query_osm 调用"""
    ql = params["query_ql"]
    bbox = params.get("bbox")
    if bbox:
        parts = bbox.split(",")
        if len(parts) == 4:
            bbox_str = f"{parts[1]},{parts[0]},{parts[3]},{parts[2]}"
            ql = ql.replace("[out:json];", f"[out:json][bbox:{bbox_str}];")
    result = await _overpass_query(ql)
    return {"elements": result.get("elements", []), "total": len(result.get("elements", [])),
            "osm3s": result.get("osm3s", {})}


async def _handle_search_poi(params: dict) -> dict:
    """处理 search_poi 调用：高德优先 + OSM 补充"""
    keywords = params["keywords"]
    location = params.get("location", "")
    limit = params.get("limit", 20)
    pois = []
    source = "gaode"

    # 高德 POI
    if _get_gaode_key():
        try:
            gd = await _gaode_poi(keywords, location, limit)
            if gd.get("status") == "1" and gd.get("pois"):
                for p in gd["pois"][:limit]:
                    loc = p.get("location", "")
                    if loc and "," in loc:
                        lng_gg, lat_gg = map(float, loc.split(","))
                        lng_wg, lat_wg = _gcj02_to_wgs84(lng_gg, lat_gg)
                        pois.append({
                            "name": p.get("name", ""),
                            "address": p.get("address", ""),
                            "coordinates": [lng_wg, lat_wg],
                            "category": p.get("type", ""),
                            "data_source": "gaode",
                        })
        except Exception:
            pass

    # OSM 补充（如果没有高德结果）
    if not pois:
        source = "osm"
        try:
            if location:
                geo = await _nominatim_search(location, limit=1)
                if geo:
                    b = geo[0]["boundingbox"]
                    w, s, e, n = float(b[2]), float(b[0]), float(b[3]), float(b[1])
                    ql = f'[out:json];node["amenity"="{keywords}"]({s},{w},{n},{e});out {limit};'
                    result = await _overpass_query(ql)
                    for e in result.get("elements", [])[:limit]:
                        pois.append({
                            "name": e.get("tags", {}).get("name", ""),
                            "coordinates": [e.get("lon", 0), e.get("lat", 0)],
                            "category": e.get("tags", {}).get("amenity", keywords),
                            "data_source": "osm",
                        })
        except Exception:
            pass

    return {"pois": pois, "total": len(pois), "source": source}
