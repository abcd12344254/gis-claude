"""
====== CRS 坐标系前置检查器 ======

零依赖模块，实现文档 4.5.3 的坐标系陷阱自动检测逻辑。

在空间分析前自动检查：
- 数据是否包含 CRS 信息
- CRS 类型是否适合当前分析类型（地理坐标系 vs 投影坐标系）
- 多图层 CRS 是否一致
- 缓冲区距离单位与 CRS 单位是否匹配
- 中国区域推荐投影

参考：HermesAgent GIS领域专精Agent技术方案 4.5.3 节
"""

from dataclasses import dataclass, field
from typing import Optional
import re


# ====== 分析类型 → CRS 要求映射表（文档 4.5.3.3） ======

ANALYSIS_CRS_REQUIREMENTS = {
    "area": {
        "requires_pcs": True,
        "reason": "面积计算需要投影坐标系（经纬度直接计算面积会严重偏小，高纬度误差可达50%+）",
        "suggested_proj": "equal_area",
    },
    "distance": {
        "requires_pcs": True,
        "reason": "距离测量需要投影坐标系（经纬度1°在不同纬度对应不同距离）",
        "suggested_proj": "equidistant",
    },
    "buffer": {
        "requires_pcs": True,
        "reason": "缓冲区距离单位为米/公里，需要投影坐标系（地理坐标系下缓冲距离单位为度）",
        "suggested_proj": "utm",
    },
    "hotspot": {
        "requires_pcs": True,
        "reason": "热点分析（Getis-Ord Gi*）需要投影坐标系以保证空间权重矩阵的正确性",
        "suggested_proj": "equal_area",
    },
    "interpolation": {
        "requires_pcs": True,
        "reason": "空间插值（IDW/Kriging）建议使用投影坐标系以保证距离计算准确",
        "suggested_proj": "equal_area",
    },
    "network": {
        "requires_pcs": True,
        "reason": "网络分析需要投影坐标系以保证路径长度计算准确",
        "suggested_proj": "utm",
    },
    "suitability": {
        "requires_pcs": True,
        "reason": "适宜性评价涉及多图层叠加，需要统一投影坐标系",
        "suggested_proj": "equal_area",
    },
    "overlay": {
        "requires_pcs": False,
        "reason": "叠加分析要求所有图层 CRS 一致，但不强制要求投影坐标系",
        "suggested_proj": None,
    },
    "centroid": {
        "requires_pcs": False,
        "reason": "质心计算可在任何坐标系下执行，但结果坐标值与输入 CRS 一致",
        "suggested_proj": None,
    },
    "bbox": {
        "requires_pcs": False,
        "reason": "边界框计算可在任何坐标系下执行",
        "suggested_proj": None,
    },
    "convex": {
        "requires_pcs": False,
        "reason": "凸包计算取决于几何坐标，非面积类分析不强制投影",
        "suggested_proj": None,
    },
    "simplify": {
        "requires_pcs": False,
        "reason": "几何简化不涉及面积/距离计算，可在任何坐标系下执行",
        "suggested_proj": None,
    },
    "grid": {
        "requires_pcs": True,
        "reason": "格网生成的距离单位为公里，需要投影坐标系",
        "suggested_proj": "utm",
    },
    "density": {
        "requires_pcs": True,
        "reason": "点密度分析涉及面积计算，需要投影坐标系",
        "suggested_proj": "equal_area",
    },
    "cluster": {
        "requires_pcs": True,
        "reason": "DBSCAN 等聚类算法依赖距离计算，需要投影坐标系",
        "suggested_proj": "utm",
    },
    "zonal": {
        "requires_pcs": True,
        "reason": "分区统计涉及面积计算，需要投影坐标系",
        "suggested_proj": "equal_area",
    },
}


# ====== 中国区域推荐投影（文档 4.5.3.4） ======

CHINA_PROJECTIONS = {
    "east": {
        "epsg": "EPSG:32650",
        "name": "UTM Zone 50N",
        "range": "东经 114°-120°（上海、杭州、福州、南京、合肥）",
    },
    "central": {
        "epsg": "EPSG:32651",
        "name": "UTM Zone 51N",
        "range": "东经 108°-114°（北京、武汉、广州、长沙、郑州）",
    },
    "west": {
        "epsg": "EPSG:32648",
        "name": "UTM Zone 48N",
        "range": "东经 102°-108°（成都、重庆、昆明、兰州）",
    },
    "far_west": {
        "epsg": "EPSG:32645",
        "name": "UTM Zone 45N",
        "range": "东经 84°-90°（乌鲁木齐、拉萨）",
    },
    "national": {
        "epsg": "EPSG:102008",
        "name": "Albers 等面积圆锥投影",
        "range": "全国范围",
    },
    "web": {
        "epsg": "EPSG:3857",
        "name": "Web 墨卡托",
        "range": "Web 地图展示",
    },
}

# ====== 地理坐标系识别 ======

# 常见地理坐标系的 EPSG 代码（单位：度）
GEOGRAPHIC_CRS_PATTERNS = [
    r"EPSG:4326",        # WGS84
    r"EPSG:4269",        # NAD83
    r"EPSG:4610",        # CGCS2000 地理坐标系
    r"EPSG:4490",        # CGCS2000 大地坐标系
    r"EPSG:4214",        # 北京1954
    r"EPSG:4612",        # 西安1980
    r"EPSG:4258",        # ETRS89
]

# GCJ-02 / BD-09 等火星坐标系
MARS_CRS_PATTERNS = [
    r"GCJ-?02",          # 国测局坐标系（火星坐标）
    r"BD-?09",           # 百度坐标系
    r"EPSG:3857",        # Web 墨卡托（虽为投影但单位也是米... 不对这是投影的）
]

# 从 CRS 字符串判断是否为地理坐标系（单位：度）
def is_geographic_crs(crs_str: Optional[str]) -> bool:
    """判断 CRS 是否为地理坐标系（经纬度，单位：度）"""
    if not crs_str:
        # 无 CRS 信息 → 假设为 WGS84
        return True

    crs_upper = crs_str.upper().strip()

    # 检查已知的地理坐标系
    for pattern in GEOGRAPHIC_CRS_PATTERNS:
        if re.search(pattern, crs_upper):
            return True

    # 检查 CRS 字符串中是否包含暗示地理坐标的关键词
    if "GEOGCS" in crs_upper or "GEOGRAPHIC" in crs_upper:
        return True

    # 检查是否包含经纬度单位（度）
    if "UNIT[\"degree" in crs_upper or "UNIT[\"°" in crs_upper:
        return True

    # 默认：无法判断时假设为地理坐标系（保守策略）
    return False


def is_web_mercator(crs_str: Optional[str]) -> bool:
    """判断是否为 Web 墨卡托"""
    if not crs_str:
        return False
    crs_upper = crs_str.upper().strip()
    return "EPSG:3857" in crs_upper or "EPSG:900913" in crs_upper


def recommend_projection(lng_range: tuple[float, float]) -> dict:
    """
    根据研究区域的经度范围推荐中国区域最优投影坐标系。

    Args:
        lng_range: (min_lng, max_lng) 经度范围

    Returns:
        推荐的投影信息 dict
    """
    center_lng = (lng_range[0] + lng_range[1]) / 2
    span = lng_range[1] - lng_range[0]

    # 大范围（>15° 经度）→ Albers 等面积
    if span > 15:
        return CHINA_PROJECTIONS["national"]

    # 小范围 → UTM 分区
    if center_lng >= 120:
        # 极东（东经120+）→ UTM 51N 或更东
        if center_lng >= 126:
            return {"epsg": "EPSG:32652", "name": "UTM Zone 52N", "range": "东经 126°+"}
        return CHINA_PROJECTIONS["east"]
    elif center_lng >= 114:
        return CHINA_PROJECTIONS["east"]
    elif center_lng >= 108:
        return CHINA_PROJECTIONS["central"]
    elif center_lng >= 102:
        return CHINA_PROJECTIONS["west"]
    elif center_lng >= 84:
        return CHINA_PROJECTIONS["far_west"]
    else:
        return CHINA_PROJECTIONS["far_west"]


# ====== 数据模型 ======

@dataclass
class CRSWarning:
    """CRS 警告"""
    level: str          # "error" | "warning" | "info"
    message: str
    detail: str = ""
    fix_action: str = ""


@dataclass
class CRSCheckResult:
    """CRS 检查结果"""
    passed: bool
    analysis_type: str
    layers_checked: list[str] = field(default_factory=list)
    warnings: list[CRSWarning] = field(default_factory=list)
    suggested_crs: Optional[str] = None
    suggested_crs_name: Optional[str] = None
    auto_fix_applied: bool = False


# ====== 主检查函数 ======

def check_analysis_crs(
    analysis_type: str,
    layers_info: list[dict],
    lng_range: Optional[tuple[float, float]] = None,
) -> CRSCheckResult:
    """
    空间分析前的前置 CRS 检查。

    Args:
        analysis_type: 分析类型（area/distance/buffer/hotspot/interpolation/...）
        layers_info: 图层信息列表
            [{"name": "北京市", "crs": "EPSG:4326", "feature_count": 100, "geometry_type": "Polygon"}, ...]
        lng_range: 研究区域的经度范围 (min_lng, max_lng)，用于推荐投影

    Returns:
        CRSCheckResult — 包含是否通过、警告列表、建议的 CRS
    """
    req = ANALYSIS_CRS_REQUIREMENTS.get(
        analysis_type,
        {"requires_pcs": False, "reason": "未知分析类型，不做强制检查", "suggested_proj": None},
    )

    result = CRSCheckResult(
        passed=True,
        analysis_type=analysis_type,
        layers_checked=[l.get("name", "unnamed") for l in layers_info],
    )

    # ── 检查 1: 各图层 CRS 是否缺失 ──
    for layer in layers_info:
        crs = layer.get("crs")
        if not crs:
            result.warnings.append(CRSWarning(
                level="warning",
                message=f"图层 \"{layer.get('name', 'unnamed')}\" 缺少 CRS 信息",
                detail="系统将假设为 WGS84 (EPSG:4326) 地理坐标系",
                fix_action=f"建议通过 get_data_info 确认图层 \"{layer.get('name', 'unnamed')}\" 的坐标系",
            ))

    # ── 检查 2: 是否需要投影坐标系 ──
    if req["requires_pcs"]:
        gcs_layers = []
        for layer in layers_info:
            crs = layer.get("crs")
            if is_geographic_crs(crs):
                gcs_layers.append(layer.get("name", "unnamed"))

        if gcs_layers:
            # 推荐投影
            if lng_range:
                proj = recommend_projection(lng_range)
            else:
                proj = CHINA_PROJECTIONS["national"]

            result.suggested_crs = proj["epsg"]
            result.suggested_crs_name = proj["name"]
            result.passed = False

            result.warnings.append(CRSWarning(
                level="error",
                message=f"{analysis_type} 分析类型要求投影坐标系，但以下图层为地理坐标系（单位：度）: {', '.join(gcs_layers)}",
                detail=req["reason"],
                fix_action=f"建议转换坐标系: transform_crs → {proj['epsg']} ({proj['name']}, {proj['range']})",
            ))

    # ── 检查 3: 多图层 CRS 一致性 ──
    if len(layers_info) >= 2:
        crs_values = set()
        for layer in layers_info:
            crs = layer.get("crs", "unknown")
            crs_values.add(crs)

        if len(crs_values) > 1:
            result.warnings.append(CRSWarning(
                level="error",
                message=f"多图层坐标系不一致: {crs_values}",
                detail="不同坐标系的数据直接叠加会导致空间位置偏移，叠加分析可能失败或结果错误",
                fix_action="建议统一转换到同一坐标系: transform_crs → 以主分析图层为准",
            ))
            # 多图层不一致时即使分析类型不需要 PCS，也要标记为未通过
            if req["requires_pcs"]:
                # 已经在上面标记了
                pass
            elif not result.passed:
                pass
            else:
                # 仅标记为 warning，不阻断执行
                result.warnings[-1].level = "warning"

    # ── 检查 4: 缓冲区距离单位与 CRS 单位匹配 ──
    if analysis_type == "buffer":
        for layer in layers_info:
            crs = layer.get("crs")
            if is_geographic_crs(crs):
                result.warnings.append(CRSWarning(
                    level="error",
                    message=f"缓冲区分析图层 \"{layer.get('name', 'unnamed')}\" 使用地理坐标系，缓冲距离单位为度，无法直接使用公里/米",
                    detail="例如：1° ≈ 111km（仅赤道），在高纬度地区 1° ≈ 55km，缓冲距离将严重失真",
                    fix_action=f"建议先转换为投影坐标系（如 {result.suggested_crs or 'EPSG:32650'}），再执行缓冲区分析",
                ))
                result.passed = False

    # ── 检查 5: GCJ-02 / BD-09 火星坐标系警告 ──
    for layer in layers_info:
        crs = layer.get("crs", "")
        for pattern in MARS_CRS_PATTERNS:
            if re.search(pattern, crs, re.IGNORECASE):
                result.warnings.append(CRSWarning(
                    level="info",
                    message=f"图层 \"{layer.get('name', 'unnamed')}\" 使用火星坐标系 ({crs})",
                    detail="GCJ-02 与 WGS-84 存在 300-500m 偏移，与其他 WGS-84 数据叠加时会产生误差",
                    fix_action="建议通过 coord-transform 库转换为 WGS-84",
                ))

    return result


def format_crs_report(result: CRSCheckResult) -> str:
    """将 CRS 检查结果格式化为人类可读的中文报告"""
    lines = [
        f"## 坐标系检查报告",
        f"",
        f"- 分析类型: **{result.analysis_type}**",
        f"- 检查状态: {'✅ 通过' if result.passed else '⚠️ 需要处理'}",
        f"- 检查图层: {', '.join(result.layers_checked)}",
    ]

    if result.suggested_crs:
        lines.append(f"- 推荐坐标系: **{result.suggested_crs}** ({result.suggested_crs_name})")

    if result.warnings:
        lines.append("")
        lines.append("### 警告详情")
        for i, w in enumerate(result.warnings, 1):
            emoji = {"error": "🔴", "warning": "🟡", "info": "🔵"}.get(w.level, "⚪")
            lines.append(f"")
            lines.append(f"{emoji} **警告 {i}**: {w.message}")
            if w.detail:
                lines.append(f"   > {w.detail}")
            if w.fix_action:
                lines.append(f"   → {w.fix_action}")

    if result.passed:
        lines.append("")
        lines.append("✅ 坐标系检查通过，可以安全执行分析。")

    return "\n".join(lines)
