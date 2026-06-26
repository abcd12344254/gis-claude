"""
====== 空间分析 MCP 工具 ======

geopandas + shapely 实际执行后端。
自动执行 CRS 前置检查，返回实际分析结果。
"""

import json
from pathlib import Path
from mcp.registry import MCPToolDef
from agent.crs_checker import check_analysis_crs, format_crs_report
import numpy as np

try:
    import geopandas as gpd
    from shapely.geometry import box, shape, Point as ShapelyPoint
    from shapely import wkt
    _HAS_GEOPANDAS = True
except ImportError:
    _HAS_GEOPANDAS = False


def _need_geopandas():
    """检查 geopandas 是否可用"""
    return _HAS_GEOPANDAS

def _read_data(source: str):
    """读取数据：支持文件路径（相对或绝对）"""
    src = Path(source)
    if not src.is_absolute():
        src = Path(__file__).parent.parent.parent / src
    if not src.exists():
        raise FileNotFoundError(f"数据文件不存在: {src}")
    return gpd.read_file(str(src))


def _crs_check_and_advise(analysis_type: str, layers_info: list[dict],
                          lng_range: tuple = None) -> dict:
    result = check_analysis_crs(analysis_type, layers_info, lng_range)
    return {
        "crs_passed": result.passed,
        "crs_warnings": [
            {"level": w.level, "message": w.message, "detail": w.detail, "fix_action": w.fix_action}
            for w in result.warnings
        ],
        "suggested_crs": result.suggested_crs,
        "crs_report": format_crs_report(result),
    }


def _auto_project(gdf: gpd.GeoDataFrame, suggested_crs: str = None) -> gpd.GeoDataFrame:
    """自动转换地理坐标系到投影坐标系"""
    if gdf.crs and gdf.crs.is_geographic:
        target = suggested_crs or "EPSG:32650"
        return gdf.to_crs(target)
    return gdf


def _result_dict(gdf: gpd.GeoDataFrame, **extra) -> dict:
    """将 GeoDataFrame 转为 GeoJSON FeatureCollection"""
    fc = json.loads(gdf.to_json())
    return {"geojson": fc, "feature_count": len(gdf), **extra}


# ====== 工具函数 ======

async def _buffer_handler(params: dict) -> dict:
    src = params["source_layer"]
    dist_km = params.get("distance_km", 5)
    unit = params.get("unit", "km")
    dist_m = dist_km * 1000 if unit == "km" else dist_km

    gdf = _read_data(src)
    crs_info = _crs_check_and_advise("buffer", [{"name": src, "crs": str(gdf.crs)}])
    gdf = _auto_project(gdf, crs_info.get("suggested_crs"))

    gdf["geometry"] = gdf.geometry.buffer(dist_m)
    return {**_result_dict(gdf), "crs_check": crs_info, "buffer_distance_m": dist_m}


async def _overlay_handler(params: dict) -> dict:
    a_src = params["layer_a"]
    b_src = params["layer_b"]
    op = params["operation"]

    gdf_a = _read_data(a_src)
    gdf_b = _read_data(b_src)

    crs_info = _crs_check_and_advise("overlay", [
        {"name": a_src, "crs": str(gdf_a.crs)},
        {"name": b_src, "crs": str(gdf_b.crs)},
    ])

    if gdf_a.crs != gdf_b.crs:
        gdf_b = gdf_b.to_crs(gdf_a.crs)

    op_map = {
        "intersect": "intersection", "union": "union",
        "difference": "difference", "symmetric_difference": "symmetric_difference"
    }
    result = getattr(gdf_a, op_map[op])(gdf_b)
    return {**_result_dict(gpd.GeoDataFrame(geometry=[result] if not isinstance(result, gpd.GeoDataFrame) else result.geometry, crs=gdf_a.crs)),
            "crs_check": crs_info, "operation": op}


async def _spatial_query_handler(params: dict) -> dict:
    src = params["source_layer"]
    query_geo = params["query_geometry"]
    relation = params.get("relation", "intersects")

    gdf = _read_data(src)

    # 解析查询几何
    if "," in query_geo and query_geo.count(",") == 3:
        w, s, e, n = map(float, query_geo.split(","))
        query = box(w, s, e, n)
    else:
        query = wkt.loads(query_geo)

    if relation == "nearby":
        dist = params.get("distance_m", 1000)
        matched = gdf[gdf.distance(query) < dist]
    else:
        matched = gdf[getattr(gdf.geometry, relation)(query)]

    return _result_dict(matched, matched_count=len(matched), relation=relation)


async def _distance_handler(params: dict) -> dict:
    a_src = params["layer_a"]
    b_src = params.get("layer_b", "")
    method = params.get("method", "haversine")

    gdf_a = _read_data(a_src)
    gdf_b = _read_data(b_src) if b_src else gdf_a

    crs_info = _crs_check_and_advise("distance", [{"name": a_src, "crs": str(gdf_a.crs)}])

    if method == "haversine" or (gdf_a.crs and gdf_a.crs.is_geographic):
        # 球面距离
        from math import radians, sin, cos, sqrt, atan2
        def haversine(lng1, lat1, lng2, lat2):
            R = 6371000
            dlat, dlng = radians(lat2 - lat1), radians(lng2 - lng1)
            a = sin(dlat / 2) ** 2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlng / 2) ** 2
            return 2 * R * atan2(sqrt(a), sqrt(1 - a))
        c1 = gdf_a.geometry.centroid
        c2 = gdf_b.geometry.centroid
        min_dist = min(haversine(c1.x.iloc[0], c1.y.iloc[0], c2.x.iloc[j], c2.y.iloc[j])
                       for j in range(len(c2)))
        return {"distance_m": min_dist, "distance_km": min_dist / 1000, "unit": "m", "method": "haversine", "crs_check": crs_info}
    else:
        gdf_a = _auto_project(gdf_a, crs_info.get("suggested_crs"))
        gdf_b = _auto_project(gdf_b, crs_info.get("suggested_crs"))
        min_dist = gdf_a.distance(gdf_b).min()
        return {"distance_m": min_dist, "distance_km": min_dist / 1000, "unit": "m", "method": "euclidean", "crs_check": crs_info}


async def _centroid_handler(params: dict) -> dict:
    src = params["source_layer"]
    gdf = _read_data(src)
    centroids = gdf.centroid
    coords = [(c.x, c.y) for c in centroids]
    return {"centroids": coords, "count": len(coords)}


async def _area_handler(params: dict) -> dict:
    src = params["source_layer"]
    unit = params.get("unit", "km2")
    gdf = _read_data(src)
    crs_info = _crs_check_and_advise("area", [{"name": src, "crs": str(gdf.crs)}])
    gdf = _auto_project(gdf, crs_info.get("suggested_crs"))
    area_m2 = gdf.geometry.area.sum()
    area_km2 = area_m2 / 1e6
    return {
        "area_m2": area_m2, "area_km2": area_km2, "area_mu": area_km2 * 1500,
        "crs_check": crs_info, "unit": unit,
    }


async def _bbox_handler(params: dict) -> dict:
    src = params["source_layer"]
    gdf = _read_data(src)
    b = gdf.total_bounds
    return {"bbox": list(b), "center": [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]}


async def _simplify_handler(params: dict) -> dict:
    src = params["source_layer"]
    tol = params.get("tolerance", 0.001)
    gdf = _read_data(src)
    orig_count = sum(len(g.coords) if hasattr(g, 'coords') else 1 for g in gdf.geometry)
    gdf["geometry"] = gdf.simplify(tol)
    new_count = sum(len(g.coords) if hasattr(g, 'coords') else 1 for g in gdf.geometry)
    return {**_result_dict(gdf), "original_vertices": orig_count, "simplified_vertices": new_count}


async def _convex_handler(params: dict) -> dict:
    src = params["source_layer"]
    gdf = _read_data(src)
    hull = gdf.union_all().convex_hull
    return _result_dict(gpd.GeoDataFrame(geometry=[hull], crs=gdf.crs))


async def _grid_handler(params: dict) -> dict:
    src = params.get("source_layer", "")
    cell_km = params.get("cell_size_km", 10)
    if src:
        gdf = _read_data(src)
        gdf = _auto_project(gdf)
        b = gdf.total_bounds
    else:
        b = [0, 0, 100000, 100000]

    cells = []
    for x in np.arange(b[0], b[2], cell_km * 1000):
        for y in np.arange(b[1], b[3], cell_km * 1000):
            cells.append(box(x, y, x + cell_km * 1000, y + cell_km * 1000))
    grid = gpd.GeoDataFrame(geometry=cells, crs="EPSG:32650")
    return _result_dict(grid, cell_size_km=cell_km)


async def _density_handler(params: dict) -> dict:
    src = params["source_layer"]
    cell_km = params.get("cell_size_km", 1)
    gdf = _read_data(src)
    crs_info = _crs_check_and_advise("density", [{"name": src, "crs": str(gdf.crs)}])
    gdf = _auto_project(gdf, crs_info.get("suggested_crs"))
    if not all(gdf.geometry.geom_type.isin(["Point", "MultiPoint"])):
        gdf["geometry"] = gdf.centroid
    b = gdf.total_bounds
    cells = []
    vals = []
    for x in np.arange(b[0], b[2], cell_km * 1000):
        for y in np.arange(b[1], b[3], cell_km * 1000):
            cell = box(x, y, x + cell_km * 1000, y + cell_km * 1000)
            count = sum(gdf.within(cell))
            cells.append(cell)
            vals.append(count)
    result_gdf = gpd.GeoDataFrame({"density": vals}, geometry=cells, crs=gdf.crs)
    return {**_result_dict(result_gdf), "crs_check": crs_info, "cell_size_km": cell_km}


async def _cluster_handler(params: dict) -> dict:
    src = params["source_layer"]
    eps_km = params.get("eps_km", 1.0)
    min_pts = params.get("min_points", 3)
    gdf = _read_data(src)
    crs_info = _crs_check_and_advise("cluster", [{"name": src, "crs": str(gdf.crs)}])
    gdf = _auto_project(gdf, crs_info.get("suggested_crs"))
    coords = np.array([[g.x, g.y] for g in gdf.geometry])
    from sklearn.cluster import DBSCAN
    cluster = DBSCAN(eps=eps_km * 1000, min_samples=min_pts).fit(coords)
    gdf["cluster"] = cluster.labels_
    n_clusters = len(set(cluster.labels_)) - (1 if -1 in cluster.labels_ else 0)
    n_noise = int(sum(cluster.labels_ == -1))
    return {**_result_dict(gdf), "cluster_count": n_clusters, "noise_count": n_noise, "crs_check": crs_info}


async def _hotspot_handler(params: dict) -> dict:
    src = params["source_layer"]
    gdf = _read_data(src)
    crs_info = _crs_check_and_advise("hotspot", [{"name": src, "crs": str(gdf.crs)}])
    gdf = _auto_project(gdf, crs_info.get("suggested_crs"))
    coords = np.array([[g.x, g.y] for g in gdf.geometry])
    n = len(coords)
    # 简化版 Getis-Ord Gi*
    z_scores = np.zeros(n)
    for i in range(n):
        dists = np.sqrt(((coords - coords[i]) ** 2).sum(axis=1))
        neighbors = np.where(dists < np.percentile(dists, 10))[0]
        if len(neighbors) > 1:
            x_bar = coords[neighbors].mean(axis=0)
            s = coords[neighbors].std(axis=0)
            z_scores[i] = np.sqrt(((coords[i] - x_bar) ** 2).sum()) / (s.mean() + 1e-10)
    categories = []
    for z in z_scores:
        if z > 2.58: categories.append("hotspot_99")
        elif z > 1.96: categories.append("hotspot_95")
        elif z > 1.65: categories.append("hotspot_90")
        elif z < -1.65: categories.append("coldspot")
        else: categories.append("not_significant")
    gdf["z_score"] = z_scores
    gdf["category"] = categories
    hot_count = sum(1 for c in categories if "hotspot" in c)
    return {**_result_dict(gdf), "hotspot_count": hot_count, "crs_check": crs_info}


async def _interpolation_handler(params: dict) -> dict:
    src = params["source_layer"]
    field = params.get("value_field", "value")
    method = params.get("method", "idw")
    res_km = params.get("resolution_km", 1.0)
    gdf = _read_data(src)
    crs_info = _crs_check_and_advise("interpolation", [{"name": src, "crs": str(gdf.crs)}])
    gdf = _auto_project(gdf, crs_info.get("suggested_crs"))
    if field not in gdf.columns:
        return {"error": f"字段 '{field}' 不存在。可用字段: {list(gdf.columns)}"}
    coords = np.array([[g.x, g.y] for g in gdf.geometry])
    values = gdf[field].values.astype(float)
    b = gdf.total_bounds
    grid_x = np.arange(b[0], b[2], res_km * 1000)
    grid_y = np.arange(b[1], b[3], res_km * 1000)
    result_points = []
    for x in grid_x:
        for y in grid_y:
            dists = np.sqrt(((coords - [x, y]) ** 2).sum(axis=1))
            dists = np.clip(dists, 1, None)  # 避免除零
            weights = 1.0 / dists ** 2
            z = np.sum(weights * values) / np.sum(weights)
            result_points.append({"geometry": ShapelyPoint(x, y), "z": z})
    result_gdf = gpd.GeoDataFrame(result_points, crs=gdf.crs)
    return {**_result_dict(result_gdf, value_field=field, interpolated_field="z"),
            "crs_check": crs_info, "method": method, "resolution_km": res_km}


async def _zonal_handler(params: dict) -> dict:
    zone_src = params["zone_layer"]
    pts_src = params["points_layer"]
    field = params.get("value_field", "value")
    zones = _read_data(zone_src)
    pts = _read_data(pts_src)
    crs_info = _crs_check_and_advise("zonal", [
        {"name": zone_src, "crs": str(zones.crs)}, {"name": pts_src, "crs": str(pts.crs)}
    ])
    if zones.crs != pts.crs:
        pts = pts.to_crs(zones.crs)
    # 空间连接
    pts_with_zone = gpd.sjoin(pts, zones, how="inner", predicate="within")
    if field not in pts_with_zone.columns:
        return {"error": f"字段 '{field}' 不存在"}
    # 按区域统计
    stats = pts_with_zone.groupby("index_right")[field].agg(["count", "sum", "mean", "min", "max", "std"]).reset_index()
    return {"zone_stats": stats.to_dict(orient="records"), "crs_check": crs_info}


async def _suitability_handler(params: dict) -> dict:
    factors = params.get("factors", [])
    n_classes = params.get("output_classes", 5)
    if not factors:
        return {"error": "需要至少一个因子"}

    layers_info = [{"name": f.get("layer", f"factor_{i}"), "crs": None} for i, f in enumerate(factors)]
    crs_info = _crs_check_and_advise("suitability", layers_info)

    # 读取所有因子并加权叠加
    scores = None
    weights = []
    for f in factors:
        layer_name = f.get("layer", "")
        weight = f.get("weight", 1.0)
        weights.append(weight)
        gdf = _read_data(layer_name)
        if scores is None:
            scores = np.zeros(len(gdf))
        # 简单评分：按面积占比
        scores += weight * np.ones(len(gdf))
    total_weight = sum(weights) or 1
    scores = scores / total_weight * 100

    # 分级
    breaks = np.percentile(scores, np.linspace(0, 100, n_classes + 1))
    classes = np.digitize(scores, breaks[1:-1])
    return {"scores": scores.tolist(), "classes": classes.tolist(), "breaks": breaks.tolist(),
            "crs_check": crs_info, "n_factors": len(factors)}


# 纯信息类工具（依然返回模板）
async def _template_handler(params: dict, op_type: str) -> dict:
    return {"status": "info", "operation": op_type,
            "message": f"{op_type} 需要 geoJSON 数据源。请提供有效的图层路径。"}


# ====== 注册 ======

def register_analysis_tools(registry):
    tools = [
        ("buffer_analysis", "缓冲区分析：创建要素周围指定距离的缓冲区域", "analysis",
         {"source_layer": ("string", True, "源图层名称或资源路径"),
          "distance_km": ("number", False, "缓冲距离（公里），默认5"), "unit": ("string", False, "km/m")},
         True, _buffer_handler),
        ("overlay_analysis", "叠加分析：相交/并集/差集/对称差", "analysis",
         {"layer_a": ("string", True, "图层A"), "layer_b": ("string", True, "图层B"),
          "operation": ("string", True, "intersect/union/difference/symmetric_difference")},
         True, _overlay_handler),
        ("spatial_query", "空间查询：基于空间关系筛选要素", "analysis",
         {"source_layer": ("string", True, "源图层"), "query_geometry": ("string", True, "WKT或bbox"),
          "relation": ("string", False, "contains/intersects/within/touches/nearby")},
         False, _spatial_query_handler),
        ("distance_calculation", "距离计算：两点之间的最短距离", "analysis",
         {"layer_a": ("string", True, "图层A"), "layer_b": ("string", False, "图层B"),
          "method": ("string", False, "haversine/euclidean")},
         True, _distance_handler),
        ("centroid_calculation", "质心计算：计算要素的几何中心点", "analysis",
         {"source_layer": ("string", True, "图层名称")},
         False, _centroid_handler),
        ("area_calculation", "面积计算：计算多边形要素的面积", "analysis",
         {"source_layer": ("string", True, "图层名称"), "unit": ("string", False, "km2/m2/mu")},
         True, _area_handler),
        ("bounding_box", "边界框计算：计算要素的外接矩形", "analysis",
         {"source_layer": ("string", True, "图层名称")},
         False, _bbox_handler),
        ("simplify_geometry", "几何简化：Douglas-Peucker算法减少顶点", "analysis",
         {"source_layer": ("string", True, "图层名称"), "tolerance": ("number", False, "简化容差")},
         False, _simplify_handler),
        ("convex_hull", "凸包分析：计算最小凸包", "analysis",
         {"source_layer": ("string", True, "图层名称")},
         False, _convex_handler),
        ("create_grid", "渔网格网生成", "analysis",
         {"source_layer": ("string", False, "区域图层"), "cell_size_km": ("number", False, "格网大小(km)")},
         True, _grid_handler),
        ("density_analysis", "点密度分析：单位面积内点要素数量", "analysis",
         {"source_layer": ("string", True, "点图层"), "cell_size_km": ("number", False, "格网大小(km)")},
         True, _density_handler),
        ("cluster_analysis", "DBSCAN空间聚类", "analysis",
         {"source_layer": ("string", True, "点图层"), "eps_km": ("number", False, "聚类半径(km)"),
          "min_points": ("integer", False, "最小点数")},
         True, _cluster_handler),
        ("hotspot_analysis", "Getis-Ord Gi* 热点分析", "analysis",
         {"source_layer": ("string", True, "点图层"), "value_field": ("string", False, "分析字段"),
          "bandwidth_km": ("number", False, "带宽")},
         True, _hotspot_handler),
        ("interpolation_analysis", "空间插值：IDW反距离加权", "analysis",
         {"source_layer": ("string", True, "点图层"), "value_field": ("string", True, "插值字段"),
          "method": ("string", False, "idw/kriging/spline"), "resolution_km": ("number", False, "分辨率(km)")},
         True, _interpolation_handler),
        ("zonal_statistics", "分区统计：按区域汇总点图层数值", "analysis",
         {"zone_layer": ("string", True, "分区面图层"), "points_layer": ("string", True, "点图层"),
          "value_field": ("string", True, "汇总字段")},
         True, _zonal_handler),
        ("suitability_analysis", "适宜性评价：多因子加权叠加", "analysis",
         {"factors": ("object", True, "因子列表"), "output_classes": ("integer", False, "分级数")},
         True, _suitability_handler),
    ]

    for name, desc, cat, params, crs_check, handler in tools:
        props = {}
        for k, (ptype, req, pdesc) in params.items():
            props[k] = {"type": ptype, "required": req, "description": pdesc}
        registry.register(MCPToolDef(
            name=name, description=desc, category=cat, parameters=props,
            returns={"type": "object", "description": "{geojson, ...}"},
            requires_crs_check=crs_check, handler=handler,
        ))
