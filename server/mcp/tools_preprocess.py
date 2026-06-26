"""
====== 数据预处理 MCP 工具 ======

与 HermesAgent 文档 4.3.1 节规范对齐。
封装常用数据预处理操作：格式检测、CRS 识别、字段分析等。

注：重写操作（格式转换/坐标系转换/裁剪等）需要 geopandas，
当前提供信息获取类工具，重写类工具返回操作建议。
"""

import os, json
from pathlib import Path
from mcp.registry import MCPToolDef


def _detect_file_format(path: str) -> dict:
    """检测矢量文件格式"""
    ext = Path(path).suffix.lower()
    format_map = {
        ".shp": {"format": "Shapefile", "driver": "ESRI Shapefile"},
        ".geojson": {"format": "GeoJSON", "driver": "GeoJSON"},
        ".json": {"format": "JSON", "driver": "GeoJSON"},
        ".gpkg": {"format": "GeoPackage", "driver": "GPKG"},
        ".kml": {"format": "KML", "driver": "KML"},
        ".kmz": {"format": "KMZ", "driver": "KMZ"},
        ".gml": {"format": "GML", "driver": "GML"},
        ".csv": {"format": "CSV", "driver": "CSV"},
        ".tif": {"format": "GeoTIFF", "driver": "GTiff"},
        ".tiff": {"format": "GeoTIFF", "driver": "GTiff"},
        ".img": {"format": "ERDAS IMG", "driver": "HFA"},
    }
    info = format_map.get(ext, {"format": f"未知格式 ({ext})", "driver": "unknown"})
    info["extension"] = ext
    return info


def _infer_crs_from_coords(features: list) -> str:
    """从坐标范围推断坐标系（简单启发式）"""
    if not features:
        return "unknown"

    lngs, lats = [], []
    def extract_coords(geom):
        if not geom:
            return
        t = geom.get("type", "")
        if t == "Point":
            c = geom.get("coordinates", [])
            if len(c) >= 2:
                lngs.append(c[0])
                lats.append(c[1])
        elif t in ("LineString", "MultiPoint"):
            for c in geom.get("coordinates", []):
                if len(c) >= 2:
                    lngs.append(c[0])
                    lats.append(c[1])
        elif t in ("Polygon", "MultiLineString"):
            for ring in geom.get("coordinates", []):
                for c in ring:
                    if len(c) >= 2:
                        lngs.append(c[0])
                        lats.append(c[1])

    for f in features:
        extract_coords(f.get("geometry"))

    if not lngs:
        return "unknown"

    min_lng, max_lng = min(lngs), max(lngs)
    min_lat, max_lat = min(lats), max(lats)

    # 启发式判断
    if -180 <= min_lng <= 180 and -90 <= min_lat <= 90:
        if min_lng > 0 and max_lng < 140 and min_lat > 0 and max_lat < 55:
            return "EPSG:4326 (推测: WGS84，中国区域)"
        return "EPSG:4326 (推测: WGS84)"
    elif max_lng > 180:
        return "EPSG:3857 (推测: Web墨卡托，坐标值 > 180)"
    else:
        return "unknown (坐标值超出常见范围)"


def register_preprocess_tools(registry):
    """向注册中心注册所有数据预处理 MCP 工具"""

    # ── get_data_info ──
    registry.register(MCPToolDef(
        name="get_data_info",
        description="获取 GIS 数据的元信息：格式、坐标系、几何类型、字段列表、要素数量、空间范围。在执行任何空间分析前，应先调用此工具了解数据状态。",
        category="preprocess",
        parameters={
            "source": {"type": "string", "required": True,
                       "description": "数据路径或资源句柄（文件路径/URL/资源名称）"},
        },
        returns={
            "type": "object",
            "description": "{format, crs, crs_type, geometry_types, feature_count, field_names, numeric_fields, bbox, file_size}",
        },
        requires_crs_check=False,
        examples=['{"source": "public/邯郸区县.geojson"}'],
        handler=_handle_get_data_info,
    ))

    # ── detect_crs ──
    registry.register(MCPToolDef(
        name="detect_crs",
        description="检测数据坐标系。若数据包含 CRS 元数据则直接返回；否则基于坐标值范围推断（启发式）。返回 CRS 类型（地理坐标系/投影坐标系）和单位。",
        category="preprocess",
        parameters={
            "source": {"type": "string", "required": True,
                       "description": "数据路径或资源句柄"},
        },
        returns={
            "type": "object",
            "description": "{crs, crs_type: 'geographic'|'projected'|'unknown', unit: 'degree'|'meter'|'unknown', inference_method: 'metadata'|'heuristic'}",
        },
        requires_crs_check=False,
        examples=['{"source": "public/邯郸区县.geojson"}'],
        handler=_handle_detect_crs,
    ))

    # ── list_numeric_fields ──
    registry.register(MCPToolDef(
        name="list_numeric_fields",
        description="列出数据中可用于分析的数值字段。返回字段名、示例值、值域范围。适用于分层着色、IDW插值、分区统计等需要数值字段的操作。",
        category="preprocess",
        parameters={
            "source": {"type": "string", "required": True,
                       "description": "数据路径或资源句柄"},
        },
        returns={
            "type": "object",
            "description": "{numeric_fields: [{name, sample_values, min, max, count}], total_fields}",
        },
        requires_crs_check=False,
        examples=['{"source": "public/邯郸区县.geojson"}'],
        handler=_handle_list_numeric_fields,
    ))

    # ── convert_format ──
    registry.register(MCPToolDef(
        name="convert_format",
        description="格式转换建议。当前不支持自动执行转换（需要 geopandas），返回转换所需的 Python 代码模板。",
        category="preprocess",
        parameters={
            "source": {"type": "string", "required": True, "description": "源数据路径"},
            "target_format": {"type": "string", "required": True,
                              "enum": ["geojson", "shp", "gpkg", "kml"],
                              "description": "目标格式"},
            "output_path": {"type": "string", "required": False, "description": "输出路径（可选）"},
        },
        returns={"type": "object", "description": "{suggestion, python_code_template}"},
        requires_crs_check=False,
        examples=['{"source": "data.shp", "target_format": "geojson"}'],
        handler=_handle_convert_format,
    ))

    # ── transform_crs ──
    registry.register(MCPToolDef(
        name="transform_crs",
        description="坐标系转换建议。根据分析类型和研究区域推荐最优投影坐标系，返回转换所需的 pyproj 代码模板。",
        category="preprocess",
        parameters={
            "source": {"type": "string", "required": True, "description": "源数据路径"},
            "target_crs": {"type": "string", "required": False,
                           "description": "目标 EPSG 代码（如 EPSG:32650），不填则自动推荐"},
            "analysis_type": {"type": "string", "required": False,
                              "description": "分析类型（用于自动推荐投影，如 area/distance/buffer）"},
        },
        returns={"type": "object", "description": "{recommended_crs, crs_name, reason, python_code_template}"},
        requires_crs_check=False,
        examples=['{"source": "data.geojson", "analysis_type": "area"}'],
        handler=_handle_transform_crs,
    ))


# ====== 工具处理函数 ======

async def _handle_get_data_info(params: dict) -> dict:
    source = params["source"]
    source_path = Path(source)
    if not source_path.is_absolute():
        source_path = Path(__file__).parent.parent.parent / source_path

    info = {"source": source, "exists": source_path.exists()}

    if source_path.exists():
        info["format"] = _detect_file_format(str(source_path))
        info["file_size"] = source_path.stat().st_size

        # 尝试解析 GeoJSON
        if source_path.suffix.lower() in (".geojson", ".json"):
            try:
                with open(source_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                if data.get("type") == "FeatureCollection":
                    features = data.get("features", [])
                    info["feature_count"] = len(features)
                    geo_types = set()
                    fields = set()
                    numeric_fields = set()
                    for feat in features[:500]:  # 采样前500个
                        geom = feat.get("geometry", {})
                        if geom.get("type"):
                            geo_types.add(geom["type"])
                        props = feat.get("properties", {}) or {}
                        for k, v in props.items():
                            fields.add(k)
                            if isinstance(v, (int, float)) and not isinstance(v, bool):
                                numeric_fields.add(k)
                    info["geometry_types"] = sorted(geo_types)
                    info["field_names"] = sorted(fields)
                    info["numeric_fields"] = sorted(numeric_fields)
                    if features:
                        coords_bbox = _get_geojson_bbox(features)
                        if coords_bbox:
                            info["bbox"] = coords_bbox
                    # CRS 检测
                    crs = data.get("crs", {})
                    if crs:
                        info["crs"] = str(crs.get("properties", {}).get("name", crs))
                        info["crs_type"] = "geographic" if "4326" in info["crs"] else "unknown"
                    else:
                        info["crs"] = _infer_crs_from_coords(features)
                        info["crs_type"] = "geographic" if "4326" in info["crs"] else "unknown"
                    info["crs_detection"] = "metadata" if crs else "heuristic"
            except Exception as e:
                info["parse_error"] = str(e)

    return info


def _get_geojson_bbox(features: list) -> list:
    """计算 GeoJSON 要素集合的 bbox"""
    lngs, lats = [], []
    for f in features:
        geom = f.get("geometry", {})
        coords = geom.get("coordinates", [])
        if not coords:
            continue
        t = geom.get("type", "")
        if t == "Point":
            lngs.append(coords[0]); lats.append(coords[1])
        elif t in ("LineString", "MultiPoint"):
            for c in coords:
                lngs.append(c[0]); lats.append(c[1])
        elif t in ("Polygon", "MultiLineString"):
            for ring in coords:
                for c in ring:
                    lngs.append(c[0]); lats.append(c[1])
        elif t == "MultiPolygon":
            for poly in coords:
                for ring in poly:
                    for c in ring:
                        lngs.append(c[0]); lats.append(c[1])
    if lngs and lats:
        return [min(lngs), min(lats), max(lngs), max(lats)]
    return []


async def _handle_detect_crs(params: dict) -> dict:
    info = await _handle_get_data_info(params)
    crs = info.get("crs", "unknown")
    crs_type = info.get("crs_type", "unknown")
    return {
        "crs": crs,
        "crs_type": crs_type,
        "unit": "degree" if crs_type == "geographic" else ("meter" if crs_type == "projected" else "unknown"),
        "inference_method": info.get("crs_detection", "unknown"),
    }


async def _handle_list_numeric_fields(params: dict) -> dict:
    info = await _handle_get_data_info(params)
    return {
        "numeric_fields": info.get("numeric_fields", []),
        "total_fields": len(info.get("field_names", [])),
        "field_names": info.get("field_names", []),
    }


async def _handle_convert_format(params: dict) -> dict:
    source = params["source"]
    target = params["target_format"]
    output = params.get("output_path", source.replace(Path(source).suffix, f".{target}"))

    # 生成 Python 代码模板
    driver_map = {"geojson": "GeoJSON", "shp": "ESRI Shapefile", "gpkg": "GPKG", "kml": "KML"}
    driver = driver_map.get(target, target.upper())

    template = f"""
import geopandas as gpd
gdf = gpd.read_file("{source}")
gdf.to_file("{output}", driver="{driver}")
print(f"✓ 已转换: {len(gdf)} 个要素 → {output}")
"""

    return {
        "suggestion": f"将 {source} 转换为 {target} 格式，输出到 {output}",
        "source_format": Path(source).suffix,
        "target_format": target,
        "output_path": output,
        "python_code_template": template.strip(),
        "requires_geopandas": True,
    }


async def _handle_transform_crs(params: dict) -> dict:
    source = params["source"]
    target_crs = params.get("target_crs")
    analysis_type = params.get("analysis_type", "")

    # 自动推荐投影
    from agent.crs_checker import recommend_projection
    if not target_crs and analysis_type:
        proj = recommend_projection((114, 116))  # 默认中国中部
        target_crs = target_crs or proj["epsg"]
    elif not target_crs:
        target_crs = "EPSG:32650"

    # 中国区域 CRS 名称映射
    crs_names = {
        "EPSG:32650": "UTM Zone 50N (中国东部 114°-120°)",
        "EPSG:32651": "UTM Zone 51N (中国中部 108°-114°)",
        "EPSG:32648": "UTM Zone 48N (中国西部 102°-108°)",
        "EPSG:102008": "Albers 等面积圆锥投影 (全国范围)",
        "EPSG:3857": "Web 墨卡托 (Web地图展示)",
    }

    epsg_code = target_crs.split(":")[1] if ":" in target_crs else target_crs
    out_name = source.replace(".geojson", f"_epsg{epsg_code}.geojson")
    template = f"""
import geopandas as gpd
gdf = gpd.read_file("{source}")
gdf = gdf.to_crs("{target_crs}")
gdf.to_file("{out_name}")
print(f"✓ 坐标系已转换: EPSG -> {target_crs}")
"""

    return {
        "source": source,
        "recommended_crs": target_crs,
        "crs_name": crs_names.get(target_crs, target_crs),
        "reason": f"分析类型 '{analysis_type}' 需要投影坐标系" if analysis_type else "手动指定",
        "python_code_template": template.strip(),
        "requires_geopandas": True,
    }
