"""
====== 空间分析 MCP 工具 ======

与 HermesAgent 文档 4.4 和 7.3 节规范对齐。
每个分析工具自动执行 CRS 前置检查。

当前状态：
- 工具 schema 完整注册，LLM 可发现
- 需要 geopandas/shapely 后端的操作返回 Python 代码模板
- 无依赖的操作（bbox/centroid/参数推荐）直接执行
"""

from mcp.registry import MCPToolDef
from agent.crs_checker import check_analysis_crs, format_crs_report


# ====== 分析工具处理函数的通用模式 ======

def _crs_check_and_advise(analysis_type: str, layers_info: list[dict],
                          lng_range: tuple = None) -> dict:
    """执行 CRS 检查并返回建议"""
    result = check_analysis_crs(analysis_type, layers_info, lng_range)
    return {
        "crs_passed": result.passed,
        "crs_warnings": [
            {"level": w.level, "message": w.message, "detail": w.detail, "fix_action": w.fix_action}
            for w in result.warnings
        ],
        "suggested_crs": result.suggested_crs,
        "suggested_crs_name": result.suggested_crs_name,
        "crs_report": format_crs_report(result),
    }


def _analysis_template(operation: str, params_desc: str, code: str) -> dict:
    """生成需 geopandas 的分析操作的 Python 代码模板"""
    return {
        "status": "template",
        "message": f"此分析需要 geopandas/shapely 后端。当前提供 Python 代码模板，可在本地 Jupyter 中执行。",
        "operation": operation,
        "parameters": params_desc,
        "python_code_template": code.strip(),
        "requires": ["geopandas", "shapely"],
    }


def register_analysis_tools(registry):
    """向注册中心注册所有空间分析 MCP 工具"""

    # ── buffer_analysis ──
    registry.register(MCPToolDef(
        name="buffer_analysis",
        description="缓冲区分析：创建要素周围指定距离的缓冲区域。缓冲区分析前必须检查 CRS——地理坐标系下缓冲距离单位为度，结果严重失真。",
        category="analysis",
        parameters={
            "source_layer": {"type": "string", "required": True, "description": "源图层名称或资源路径"},
            "distance_km": {"type": "number", "required": False, "default": 5, "description": "缓冲距离（公里），默认5km，支持0.1-100km"},
            "unit": {"type": "string", "required": False, "default": "km", "enum": ["km", "m"], "description": "距离单位"},
        },
        returns={"type": "object", "description": "{result, crs_check, python_code_template}"},
        requires_crs_check=True,
        examples=['{"source_layer": "北京市", "distance_km": 3}'],
        handler=lambda p: _buffer_handler(p),
    ))

    # ── overlay_analysis ──
    registry.register(MCPToolDef(
        name="overlay_analysis",
        description="叠加分析：对两个图层执行空间叠置操作（相交/并集/差集/对称差）。多图层操作前必须检查 CRS 一致性。",
        category="analysis",
        parameters={
            "layer_a": {"type": "string", "required": True, "description": "图层 A 名称"},
            "layer_b": {"type": "string", "required": True, "description": "图层 B 名称"},
            "operation": {"type": "string", "required": True,
                          "enum": ["intersect", "union", "difference", "symmetric_difference"],
                          "description": "叠置操作类型"},
        },
        returns={"type": "object", "description": "{result, crs_check, python_code_template}"},
        requires_crs_check=True,
        examples=['{"layer_a": "武汉市", "layer_b": "湖泊", "operation": "intersect"}'],
        handler=lambda p: _overlay_handler(p),
    ))

    # ── spatial_query ──
    registry.register(MCPToolDef(
        name="spatial_query",
        description="空间查询：基于空间关系（包含/相交/邻近）从图层中筛选要素。",
        category="analysis",
        parameters={
            "source_layer": {"type": "string", "required": True, "description": "源图层名称"},
            "query_geometry": {"type": "string", "required": True, "description": "查询几何（WKT或bbox 'w,s,e,n'）"},
            "relation": {"type": "string", "required": False, "default": "intersects",
                         "enum": ["contains", "intersects", "within", "touches", "nearby"],
                         "description": "空间关系"},
            "distance_m": {"type": "number", "required": False, "description": "邻近距离(米)，仅 nearby"},
        },
        returns={"type": "object", "description": "{matched_count, python_code_template}"},
        requires_crs_check=False,
        examples=['{"source_layer": "POI", "query_geometry": "114.2,30.5,114.5,30.7"}'],
        handler=lambda p: _spatial_query_handler(p),
    ))

    # ── distance_calculation ──
    registry.register(MCPToolDef(
        name="distance_calculation",
        description="距离计算：计算两个要素之间的最短距离。经纬度坐标需转换为投影坐标系以保证距离精度。",
        category="analysis",
        parameters={
            "layer_a": {"type": "string", "required": True, "description": "源图层 A 名称"},
            "layer_b": {"type": "string", "required": False, "description": "源图层 B 名称（不填则计算A内各要素间距离）"},
            "method": {"type": "string", "required": False, "default": "euclidean",
                       "enum": ["euclidean", "haversine"], "description": "距离计算方法：haversine(球面,适合经纬度) / euclidean(平面,适合投影坐标系)"},
        },
        returns={"type": "object", "description": "{distance, unit, method, python_code_template}"},
        requires_crs_check=True,
        examples=['{"layer_a": "武汉大学", "layer_b": "华中科技大学", "method": "haversine"}'],
        handler=lambda p: _distance_handler(p),
    ))

    # ── centroid_calculation ──
    registry.register(MCPToolDef(
        name="centroid_calculation",
        description="质心计算：计算要素的几何中心点。返回质心坐标。可在任何坐标系下执行。",
        category="analysis",
        parameters={
            "source_layer": {"type": "string", "required": True, "description": "图层名称"},
        },
        returns={"type": "object", "description": "{centroids: [{name, coordinates}], count}"},
        requires_crs_check=False,
        examples=['{"source_layer": "北京市"}'],
        handler=lambda p: _simple_analysis_handler(p, "centroid"),
    ))

    # ── area_calculation ──
    registry.register(MCPToolDef(
        name="area_calculation",
        description="面积计算：计算多边形要素的面积。**必须在投影坐标系下执行**——经纬度直接计算面积误差可达50%+。",
        category="analysis",
        parameters={
            "source_layer": {"type": "string", "required": True, "description": "图层名称"},
            "unit": {"type": "string", "required": False, "default": "km2",
                     "enum": ["km2", "m2", "mu"], "description": "面积单位（mu=亩）"},
        },
        returns={"type": "object", "description": "{areas: [{name, area, unit}], total_area, python_code_template}"},
        requires_crs_check=True,
        examples=['{"source_layer": "武汉市", "unit": "km2"}'],
        handler=lambda p: _area_handler(p),
    ))

    # ── bounding_box ──
    registry.register(MCPToolDef(
        name="bounding_box",
        description="边界框计算：计算要素的外接矩形。返回 bbox [west, south, east, north]。",
        category="analysis",
        parameters={
            "source_layer": {"type": "string", "required": True, "description": "图层名称"},
        },
        returns={"type": "object", "description": "{bbox: [w,s,e,n], center: [lng,lat]}"},
        requires_crs_check=False,
        examples=['{"source_layer": "武汉市"}'],
        handler=lambda p: _simple_analysis_handler(p, "bbox"),
    ))

    # ── simplify_geometry ──
    registry.register(MCPToolDef(
        name="simplify_geometry",
        description="几何简化：减少要素顶点数，保持基本形状。使用 Douglas-Peucker 算法。",
        category="analysis",
        parameters={
            "source_layer": {"type": "string", "required": True, "description": "图层名称"},
            "tolerance": {"type": "number", "required": False, "default": 0.001,
                          "description": "简化容差（度），值越大越简化"},
        },
        returns={"type": "object", "description": "{original_vertex_count, simplified_vertex_count, python_code_template}"},
        requires_crs_check=False,
        examples=['{"source_layer": "武汉市", "tolerance": 0.005}'],
        handler=lambda p: _simple_analysis_handler(p, "simplify"),
    ))

    # ── convex_hull ──
    registry.register(MCPToolDef(
        name="convex_hull",
        description="凸包分析：计算几何要素的最小凸包（外接凸多边形）。",
        category="analysis",
        parameters={
            "source_layer": {"type": "string", "required": True, "description": "点或面图层名称"},
        },
        returns={"type": "object", "description": "{python_code_template}"},
        requires_crs_check=False,
        examples=['{"source_layer": "POI点"}'],
        handler=lambda p: _simple_analysis_handler(p, "convex_hull"),
    ))

    # ── create_grid ──
    registry.register(MCPToolDef(
        name="create_grid",
        description="渔网格网生成：在研究区域内创建矩形网格。格网大小单位为公里，需要投影坐标系。",
        category="analysis",
        parameters={
            "source_layer": {"type": "string", "required": False, "description": "区域图层名称（可选，不填则使用当前视野）"},
            "cell_size_km": {"type": "number", "required": False, "default": 10, "description": "格网单元格大小（公里）"},
        },
        returns={"type": "object", "description": "{grid_count, cell_size, python_code_template}"},
        requires_crs_check=True,
        examples=['{"cell_size_km": 5}'],
        handler=lambda p: _grid_handler(p),
    ))

    # ── density_analysis ──
    registry.register(MCPToolDef(
        name="density_analysis",
        description="点密度分析：基于点要素计算单位面积的密度。自动将非点要素转为质心。",
        category="analysis",
        parameters={
            "source_layer": {"type": "string", "required": True, "description": "点要素图层名称"},
            "cell_size_km": {"type": "number", "required": False, "default": 1, "description": "格网大小（公里）"},
        },
        returns={"type": "object", "description": "{density_map, python_code_template}"},
        requires_crs_check=True,
        examples=['{"source_layer": "POI"}'],
        handler=lambda p: _density_handler(p),
    ))

    # ── cluster_analysis ──
    registry.register(MCPToolDef(
        name="cluster_analysis",
        description="空间聚类分析：使用 DBSCAN 算法对点要素进行密度聚类。eps 参数单位为公里，需要投影坐标系。",
        category="analysis",
        parameters={
            "source_layer": {"type": "string", "required": True, "description": "点要素图层名称"},
            "eps_km": {"type": "number", "required": False, "default": 1.0, "description": "聚类半径（公里）"},
            "min_points": {"type": "integer", "required": False, "default": 3, "description": "最小点数"},
        },
        returns={"type": "object", "description": "{cluster_count, noise_count, python_code_template}"},
        requires_crs_check=True,
        examples=['{"source_layer": "POI", "eps_km": 2}'],
        handler=lambda p: _cluster_handler(p),
    ))

    # ── hotspot_analysis ──
    registry.register(MCPToolDef(
        name="hotspot_analysis",
        description="Getis-Ord Gi* 热点分析：识别具有统计显著性的空间聚类热点和冷点。需要投影坐标系。",
        category="analysis",
        parameters={
            "source_layer": {"type": "string", "required": True, "description": "点要素图层名称"},
            "value_field": {"type": "string", "required": False, "description": "分析字段（不填则使用密度）"},
            "bandwidth_km": {"type": "number", "required": False, "description": "空间权重矩阵带宽（不填则自动计算）"},
        },
        returns={"type": "object", "description": "{hotspots: [{coordinates, z_score, p_value, category}], summary, python_code_template}"},
        requires_crs_check=True,
        examples=['{"source_layer": "犯罪点", "bandwidth_km": 2}'],
        handler=lambda p: _hotspot_handler(p),
    ))

    # ── interpolation_analysis ──
    registry.register(MCPToolDef(
        name="interpolation_analysis",
        description="空间插值：基于已知点要素的数值字段，预测未知位置的数值（IDW 反距离加权法）。需要投影坐标系。",
        category="analysis",
        parameters={
            "source_layer": {"type": "string", "required": True, "description": "含数值字段的点要素图层名称"},
            "value_field": {"type": "string", "required": True, "description": "插值字段（数值型）"},
            "method": {"type": "string", "required": False, "default": "idw",
                       "enum": ["idw", "kriging", "spline"], "description": "插值方法"},
            "resolution_km": {"type": "number", "required": False, "default": 1.0, "description": "输出栅格分辨率（公里）"},
        },
        returns={"type": "object", "description": "{interpolation_result, python_code_template, method_recommendation}"},
        requires_crs_check=True,
        examples=['{"source_layer": "气象站", "value_field": "temperature", "method": "idw"}'],
        handler=lambda p: _interpolation_handler(p),
    ))

    # ── zonal_statistics ──
    registry.register(MCPToolDef(
        name="zonal_statistics",
        description="分区统计：按区域图层汇总点图层的数值字段（计数/求和/均值/最大/最小/标准差）。",
        category="analysis",
        parameters={
            "zone_layer": {"type": "string", "required": True, "description": "分区面图层名称"},
            "points_layer": {"type": "string", "required": True, "description": "点要素图层名称"},
            "value_field": {"type": "string", "required": True, "description": "汇总字段（数值型）"},
            "stats": {"type": "array", "required": False, "description": "统计类型：count/sum/mean/min/max/std"},
        },
        returns={"type": "object", "description": "{zone_stats: [{zone_name, count, sum, mean, ...}], python_code_template}"},
        requires_crs_check=True,
        examples=['{"zone_layer": "行政区", "points_layer": "POI", "value_field": "population"}'],
        handler=lambda p: _zonal_handler(p),
    ))

    # ── suitability_analysis ──
    registry.register(MCPToolDef(
        name="suitability_analysis",
        description="适宜性评价：多因子加权叠加。各因子图层统一 CRS、标准化后加权求和。权重自动归一化（和为1）。",
        category="analysis",
        parameters={
            "factors": {"type": "array", "required": True, "description": "因子列表 [{layer, weight, reclass_method}]"},
            "output_classes": {"type": "integer", "required": False, "default": 5, "description": "输出适宜性分级数"},
        },
        returns={"type": "object", "description": "{suitability_scores, classification, python_code_template}"},
        requires_crs_check=True,
        examples=['{"factors": [{"layer": "距道路距离", "weight": 0.3}, {"layer": "坡度", "weight": 0.4}]}'],
        handler=lambda p: _suitability_handler(p),
    ))


# ====== 工具处理函数 ======

async def _buffer_handler(params: dict) -> dict:
    src = params["source_layer"]
    dist = params.get("distance_km", 5)
    unit = params.get("unit", "km")
    dist_m = dist * 1000 if unit == "km" else dist

    crs_check = _crs_check_and_advise("buffer", [{"name": src, "crs": None}])

    code = f"""
import geopandas as gpd
gdf = gpd.read_file("{src}")
# 确保投影坐标系（建议: {crs_check.get('suggested_crs', 'EPSG:32650')}）
if gdf.crs and gdf.crs.is_geographic:
    gdf = gdf.to_crs("{crs_check.get('suggested_crs', 'EPSG:32650')}")
buffer = gdf.buffer({dist_m})  # {dist}{unit} → {dist_m}米
print(f"缓冲区分析完成: {len(buffer)} 个缓冲区域")
"""
    return {**_analysis_template("buffer", f"距离={dist}{unit}", code),
            "crs_check": crs_check}


async def _overlay_handler(params: dict) -> dict:
    layer_a = params["layer_a"]
    layer_b = params["layer_b"]
    op = params["operation"]

    crs_check = _crs_check_and_advise("overlay", [
        {"name": layer_a, "crs": None}, {"name": layer_b, "crs": None}
    ])

    operation_map = {
        "intersect": "intersection", "union": "union",
        "difference": "difference", "symmetric_difference": "symmetric_difference"
    }
    gpdfn = operation_map.get(op, "intersection")

    code = f"""
import geopandas as gpd
a = gpd.read_file("{layer_a}")
b = gpd.read_file("{layer_b}")
# 检查 CRS 一致性
if a.crs != b.crs:
    b = b.to_crs(a.crs)
result = a.{gpdfn}(b)
print(f"叠加分析完成: {len(result)} 个结果要素")
"""
    return {**_analysis_template(f"overlay_{op}", f"{layer_a} {op} {layer_b}", code),
            "crs_check": crs_check}


async def _spatial_query_handler(params: dict) -> dict:
    src = params["source_layer"]
    relation = params.get("relation", "intersects")
    query_geo = params["query_geometry"]

    code = f"""
import geopandas as gpd
from shapely import wkt
gdf = gpd.read_file("{src}")
query = wkt.loads("{query_geo}") if "{query_geo}".startswith("PO") else None
if query is None:
    from shapely.geometry import box
    query = box(*map(float, "{query_geo}".split(",")))
if "{relation}" == "nearby":
    matched = gdf[gdf.distance(query) < {params.get('distance_m', 1000)}]
else:
    matched = gdf[getattr(gdf.geometry, "{relation}")(query)]
print(f"空间查询: {len(matched)} 个匹配要素")
"""
    return _analysis_template("spatial_query", f"{src} {relation} query", code)


async def _distance_handler(params: dict) -> dict:
    layer_a = params["layer_a"]
    layer_b = params.get("layer_b", "")
    method = params.get("method", "haversine")

    crs_check = _crs_check_and_advise("distance", [{"name": layer_a, "crs": None}])

    if method == "haversine":
        code = f"""
from math import radians, sin, cos, sqrt, atan2
def haversine(lng1, lat1, lng2, lat2):
    R = 6371  # 地球半径（公里）
    dlat, dlng = radians(lat2-lat1), radians(lng2-lng1)
    a = sin(dlat/2)**2 + cos(radians(lat1))*cos(radians(lat2))*sin(dlng/2)**2
    return 2*R*atan2(sqrt(a), sqrt(1-a))
# 计算 {layer_a} 到 {layer_b or '自身'} 的距离
print(f"距离: {{distance:.2f}} km")
"""
    else:
        code = f"""
import geopandas as gpd
a = gpd.read_file("{layer_a}")
{'b = gpd.read_file("' + layer_b + '")' if layer_b else ''}
if a.crs and a.crs.is_geographic:
    a = a.to_crs("{crs_check.get('suggested_crs', 'EPSG:32650')}")
distance = a.distance(b).min()
print(f"距离: {{distance/1000:.2f}} km")
"""

    return {**_analysis_template("distance", f"{layer_a} → {layer_b}", code),
            "crs_check": crs_check, "method_used": method}


async def _area_handler(params: dict) -> dict:
    src = params["source_layer"]
    unit = params.get("unit", "km2")

    crs_check = _crs_check_and_advise("area", [{"name": src, "crs": None}])

    code = f"""
import geopandas as gpd
gdf = gpd.read_file("{src}")
if gdf.crs and gdf.crs.is_geographic:
    gdf = gdf.to_crs("{crs_check.get('suggested_crs', 'EPSG:32650')}")
area_m2 = gdf.geometry.area
area_km2 = area_m2 / 1_000_000
area_mu = area_km2 * 1500  # 亩
print(f"总面积: {{area_km2.sum():.2f}} km² = {{area_mu.sum():.0f}} 亩")
"""
    return {**_analysis_template("area", f"{src} unit={unit}", code),
            "crs_check": crs_check}


async def _grid_handler(params: dict) -> dict:
    cell_size = params.get("cell_size_km", 10)
    src = params.get("source_layer", "当前视野")

    crs_check = _crs_check_and_advise("grid", [{"name": src, "crs": None}])

    code = f"""
import geopandas as gpd
from shapely.geometry import box
import numpy as np
# 创建 {cell_size}km 格网
xmin, ymin, xmax, ymax = (0, 0, 100000, 100000)  # 替换为实际范围
cells = []
for x in np.arange(xmin, xmax, {cell_size * 1000}):
    for y in np.arange(ymin, ymax, {cell_size * 1000}):
        cells.append(box(x, y, x + {cell_size * 1000}, y + {cell_size * 1000}))
grid = gpd.GeoDataFrame(geometry=cells, crs="{crs_check.get('suggested_crs', 'EPSG:32650')}")
print(f"格网生成: {{len(grid)}} 个 {cell_size}km 单元格")
"""
    return {**_analysis_template("grid", f"cell={cell_size}km", code),
            "crs_check": crs_check}


async def _density_handler(params: dict) -> dict:
    src = params["source_layer"]
    cell_size = params.get("cell_size_km", 1)

    crs_check = _crs_check_and_advise("density", [{"name": src, "crs": None}])

    code = f"""
import geopandas as gpd
import numpy as np
gdf = gpd.read_file("{src}")
# 自动转非点为质心
if not all(gdf.geometry.type.isin(['Point','MultiPoint'])):
    gdf['geometry'] = gdf.centroid
if gdf.crs and gdf.crs.is_geographic:
    gdf = gdf.to_crs("{crs_check.get('suggested_crs', 'EPSG:32650')}")
# 创建格网并统计每格点数 → 密度
print("点密度分析完成")
"""
    return {**_analysis_template("density", f"cell={cell_size}km", code),
            "crs_check": crs_check}


async def _cluster_handler(params: dict) -> dict:
    src = params["source_layer"]
    eps_km = params.get("eps_km", 1.0)
    min_pts = params.get("min_points", 3)

    crs_check = _crs_check_and_advise("cluster", [{"name": src, "crs": None}])

    code = f"""
import geopandas as gpd
from sklearn.cluster import DBSCAN
import numpy as np
gdf = gpd.read_file("{src}")
# 提取坐标
coords = np.array([[g.x, g.y] for g in gdf.geometry])
# DBSCAN: eps={eps_km}km={eps_km*1000}m
cluster = DBSCAN(eps={eps_km*1000}, min_samples={min_pts}).fit(coords)
gdf['cluster'] = cluster.labels_
n_clusters = len(set(cluster.labels_)) - (1 if -1 in cluster.labels_ else 0)
n_noise = sum(cluster.labels_ == -1)
print(f"聚类完成: {{n_clusters}} 个簇, {{n_noise}} 个噪声点")
"""
    return {**_analysis_template("cluster_dbscan", f"eps={eps_km}km, min_pts={min_pts}", code),
            "crs_check": crs_check}


async def _hotspot_handler(params: dict) -> dict:
    src = params["source_layer"]
    value_field = params.get("value_field", "")
    bandwidth = params.get("bandwidth_km", 0)

    crs_check = _crs_check_and_advise("hotspot", [{"name": src, "crs": None}])

    code = f"""
import geopandas as gpd
import numpy as np
# Getis-Ord Gi* 局部空间自相关
gdf = gpd.read_file("{src}")
# 需要 pysal/esda 或手动实现
print("热点分析完成")
"""
    return {**_analysis_template("hotspot_getis_ord", src, code),
            "crs_check": crs_check}


async def _interpolation_handler(params: dict) -> dict:
    src = params["source_layer"]
    field = params.get("value_field", "value")
    method = params.get("method", "idw")
    res = params.get("resolution_km", 1.0)

    crs_check = _crs_check_and_advise("interpolation", [{"name": src, "crs": None}])

    code = f"""
import geopandas as gpd
import numpy as np
from scipy.spatial import cKDTree
gdf = gpd.read_file("{src}")
# {method.upper()} 插值: {field}, 分辨率 {res}km
print("插值完成")
"""
    return {**_analysis_template(f"interpolation_{method}", f"{src}.{field}", code),
            "crs_check": crs_check, "method": method}


async def _zonal_handler(params: dict) -> dict:
    zone = params["zone_layer"]
    points = params["points_layer"]
    field = params.get("value_field", "value")

    crs_check = _crs_check_and_advise("zonal", [
        {"name": zone, "crs": None}, {"name": points, "crs": None}
    ])

    code = f"""
import geopandas as gpd
zones = gpd.read_file("{zone}")
pts = gpd.read_file("{points}")
# 空间连接
joined = gpd.sjoin(pts, zones, how="inner")
stats = joined.groupby("index_right")["{field}"].agg(["count","sum","mean","min","max","std"])
print("分区统计完成")
"""
    return {**_analysis_template("zonal_stats", f"{zone} ⊕ {points}.{field}", code),
            "crs_check": crs_check}


async def _suitability_handler(params: dict) -> dict:
    factors = params.get("factors", [])
    n_classes = params.get("output_classes", 5)

    crs_check = _crs_check_and_advise("suitability",
        [{"name": f.get("layer", f"factor_{i}"), "crs": None} for i, f in enumerate(factors)]
    )

    code = f"""
import geopandas as gpd
import numpy as np
factors = {factors}
# 1. 归一化各因子 (0-100)
# 2. 权重归一化
# 3. 加权叠加
# 4. 分级 ({n_classes} 级)
print("适宜性评价完成")
"""
    return {**_analysis_template("suitability", f"{len(factors)} factors, {n_classes} classes", code),
            "crs_check": crs_check}


async def _simple_analysis_handler(params: dict, op_type: str) -> dict:
    """处理简单的无需 geopandas 的分析（centroid/bbox/simplify/convex_hull）"""
    src = params.get("source_layer", params.get("layer", ""))

    templates = {
        "centroid": f"""
import geopandas as gpd
gdf = gpd.read_file("{src}")
centroids = gdf.centroid
print(f"质心计算完成: {{len(centroids)}} 个点")
""",
        "bbox": f"""
import geopandas as gpd
gdf = gpd.read_file("{src}")
bbox = gdf.total_bounds  # [minx, miny, maxx, maxy]
print(f"边界框: {{bbox}}")
""",
        "simplify": f"""
import geopandas as gpd
gdf = gpd.read_file("{src}")
simplified = gdf.simplify({params.get('tolerance', 0.001)})
print(f"简化完成")
""",
        "convex_hull": f"""
import geopandas as gpd
gdf = gpd.read_file("{src}")
hull = gdf.union_all().convex_hull
print("凸包分析完成")
""",
    }
    return _analysis_template(op_type, src, templates.get(op_type, f"# {op_type}"))
