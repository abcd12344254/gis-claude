"""
====== 制图可视化 MCP 工具 ======

生成静态地图和统计图表图片。
使用 matplotlib + geopandas 渲染。
"""

import io, os, base64
from pathlib import Path
from mcp.registry import MCPToolDef
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import geopandas as gpd

_OUTPUT_DIR = Path(__file__).parent.parent.parent / "public" / "maps"
_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


# ====== 地图模板 ======

MAP_TEMPLATES = {
    "choropleth_map": {"name": "分级色彩专题图", "description": "按属性值着色的面状专题图"},
    "graduated_symbol_map": {"name": "分级符号专题图", "description": "按属性值调整符号大小"},
    "heatmap": {"name": "热力图", "description": "点密度可视化"},
    "point_map": {"name": "点要素地图", "description": "点状要素分布图"},
    "line_map": {"name": "线要素地图", "description": "路网、河流等线状要素"},
    "polygon_map": {"name": "面要素地图", "description": "行政区划、地块"},
    "multi_layer_map": {"name": "多图层叠加图", "description": "多个图层组合展示"},
}

CHART_TEMPLATES = {
    "bar_chart": {"name": "柱状图", "description": "分类数据对比"},
    "line_chart": {"name": "折线图", "description": "时序数据趋势"},
    "scatter_plot": {"name": "散点图", "description": "相关性分析"},
    "pie_chart": {"name": "饼图", "description": "占比分布"},
    "histogram": {"name": "直方图", "description": "数据分布"},
}

COLOR_SCHEMES = {
    "light": {"bg": "#ffffff", "text": "#333333", "accent": "#1677ff"},
    "cream": {"bg": "#faf8f5", "text": "#5d4037", "accent": "#8d6e63"},
    "dark": {"bg": "#1a1a2e", "text": "#e0e0e0", "accent": "#00d2ff"},
    "forest": {"bg": "#f1f8e9", "text": "#33691e", "accent": "#558b2f"},
    "ocean": {"bg": "#e3f2fd", "text": "#0d47a1", "accent": "#1565c0"},
}


async def _list_map_templates(params: dict) -> dict:
    return {"templates": [{"id": k, **v} for k, v in MAP_TEMPLATES.items()]}


async def _list_chart_templates(params: dict) -> dict:
    return {"templates": [{"id": k, **v} for k, v in CHART_TEMPLATES.items()]}


async def _get_template_schema(params: dict) -> dict:
    name = params.get("template_name", "")
    if name in MAP_TEMPLATES:
        return {"type": "map", **MAP_TEMPLATES[name], "parameters": {
            "title": "string", "value_field": "string (for choropleth)",
            "color_scheme": "light/cream/dark/forest/ocean",
            "output_size": {"width": 1200, "height": 800},
        }}
    if name in CHART_TEMPLATES:
        return {"type": "chart", **CHART_TEMPLATES[name], "parameters": {
            "title": "string", "x_field": "string", "y_field": "string",
            "color": "#hex", "output_size": {"width": 800, "height": 600},
        }}
    return {"error": f"未知模板: {name}", "available_maps": list(MAP_TEMPLATES.keys()),
            "available_charts": list(CHART_TEMPLATES.keys())}


async def _generate_map(params: dict) -> dict:
    """生成静态地图图片"""
    template = params.get("template", "polygon_map")
    data_path = params.get("data_source", "")
    title = params.get("title", "地图")
    value_field = params.get("value_field", "")
    color_scheme = params.get("color_scheme", "light")
    output_size = params.get("output_size", {"width": 1200, "height": 800})

    scheme = COLOR_SCHEMES.get(color_scheme, COLOR_SCHEMES["light"])

    try:
        # 读取数据
        src = Path(data_path)
        if not src.is_absolute():
            src = Path(__file__).parent.parent.parent / src
        gdf = gpd.read_file(str(src))

        fig, ax = plt.subplots(1, 1, figsize=(output_size["width"] / 100, output_size["height"] / 100))
        fig.patch.set_facecolor(scheme["bg"])
        ax.set_facecolor(scheme["bg"])

        if template == "choropleth_map" and value_field and value_field in gdf.columns:
            gdf.plot(column=value_field, cmap="YlOrRd", legend=True, ax=ax,
                     edgecolor=scheme["text"], linewidth=0.5)
        elif template == "point_map":
            gdf.plot(ax=ax, color=scheme["accent"], markersize=20, edgecolor="white")
        elif template == "line_map":
            gdf.plot(ax=ax, color=scheme["accent"], linewidth=2)
        else:
            gdf.plot(ax=ax, facecolor=scheme["accent"], edgecolor=scheme["text"],
                     linewidth=0.5, alpha=0.7)

        ax.set_title(title, fontsize=16, color=scheme["text"], fontweight="bold")
        ax.axis("off")
        plt.tight_layout()

        # 保存为 PNG
        out_path = _OUTPUT_DIR / f"map_{hash(title) % 100000}.png"
        fig.savefig(str(out_path), dpi=100, bbox_inches="tight", facecolor=scheme["bg"])
        plt.close(fig)

        # 返回 base64 和文件路径
        buf = io.BytesIO()
        fig.savefig(buf, format="png", dpi=100, bbox_inches="tight")
        buf.seek(0)
        img_b64 = base64.b64encode(buf.read()).decode()

        return {"status": "ok", "output_path": str(out_path),
                "image_base64": img_b64[:200] + "...",  # 截断，不传输完整大图
                "template": template, "title": title}

    except Exception as e:
        return {"status": "error", "message": str(e)}


async def _generate_chart(params: dict) -> dict:
    """生成统计图表"""
    template = params.get("template", "bar_chart")
    title = params.get("title", "图表")
    x_field = params.get("x_field", "x")
    y_field = params.get("y_field", "y")
    data_path = params.get("data_source", "")
    color = params.get("color", "#1677ff")
    output_size = params.get("output_size", {"width": 800, "height": 600})

    try:
        fig, ax = plt.subplots(1, 1, figsize=(output_size["width"] / 100, output_size["height"] / 100))

        if data_path:
            import pandas as pd
            src = Path(data_path)
            if not src.is_absolute():
                src = Path(__file__).parent.parent.parent / src
            if src.suffix == ".csv":
                df = pd.read_csv(str(src))
            else:
                gdf = gpd.read_file(str(src))
                df = gdf.drop(columns=["geometry"]) if "geometry" in gdf.columns else gdf

            if x_field in df.columns and y_field in df.columns:
                if template == "bar_chart":
                    ax.bar(df[x_field], df[y_field], color=color)
                elif template == "line_chart":
                    ax.plot(df[x_field], df[y_field], color=color, marker="o")
                elif template == "scatter_plot":
                    ax.scatter(df[x_field], df[y_field], c=color, alpha=0.6)
                elif template == "pie_chart":
                    ax.pie(df[y_field], labels=df[x_field], autopct="%1.1f%%")
                elif template == "histogram":
                    ax.hist(df[y_field], bins=20, color=color, alpha=0.7)
        else:
            # 无数据时生成示例
            ax.text(0.5, 0.5, "请提供数据源", ha="center", va="center", transform=ax.transAxes,
                    fontsize=14, color="#999")

        ax.set_title(title, fontsize=14, fontweight="bold")
        if template != "pie_chart":
            ax.set_xlabel(x_field)
            ax.set_ylabel(y_field)
        plt.tight_layout()

        out_path = _OUTPUT_DIR / f"chart_{hash(title) % 100000}.png"
        fig.savefig(str(out_path), dpi=100, bbox_inches="tight")
        plt.close(fig)

        return {"status": "ok", "output_path": str(out_path), "template": template, "title": title}

    except Exception as e:
        return {"status": "error", "message": str(e)}


def register_cartography_tools(registry):
    registry.register(MCPToolDef(
        name="list_map_templates", description="列出可用的静态地图模板",
        category="cartography", parameters={}, returns={"type": "object"}, handler=_list_map_templates))
    registry.register(MCPToolDef(
        name="list_chart_templates", description="列出可用的统计图表模板",
        category="cartography", parameters={}, returns={"type": "object"}, handler=_list_chart_templates))
    registry.register(MCPToolDef(
        name="get_template_schema", description="获取模板的参数格式说明",
        category="cartography",
        parameters={"template_name": {"type": "string", "required": True, "description": "模板名称"}},
        returns={"type": "object"}, handler=_get_template_schema))
    registry.register(MCPToolDef(
        name="generate_map", description="生成静态地图图片(PNG)",
        category="cartography",
        parameters={
            "template": {"type": "string", "required": True, "description": "地图模板名称"},
            "data_source": {"type": "string", "required": True, "description": "GeoJSON数据路径"},
            "title": {"type": "string", "required": False, "description": "地图标题"},
            "value_field": {"type": "string", "required": False, "description": "分级字段"},
            "color_scheme": {"type": "string", "required": False, "description": "配色方案"},
            "output_size": {"type": "object", "required": False, "description": "{width, height}"},
        }, returns={"type": "object"}, handler=_generate_map))
    registry.register(MCPToolDef(
        name="generate_chart", description="生成统计图表图片(PNG)",
        category="cartography",
        parameters={
            "template": {"type": "string", "required": True, "description": "图表模板名称"},
            "data_source": {"type": "string", "required": True, "description": "数据路径(CSV/GeoJSON)"},
            "title": {"type": "string", "required": False, "description": "图表标题"},
            "x_field": {"type": "string", "required": True, "description": "X轴字段"},
            "y_field": {"type": "string", "required": True, "description": "Y轴字段"},
            "color": {"type": "string", "required": False, "description": "颜色(#hex)"},
            "output_size": {"type": "object", "required": False, "description": "{width, height}"},
        }, returns={"type": "object"}, handler=_generate_chart))
