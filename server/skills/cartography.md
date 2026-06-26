---
name: cartography
version: "1.0"
description: 制图模板可视化——静态地图与统计图表自动生成
triggers:
  - 生成地图
  - 制作图表
  - 制图
  - 可视化
  - 专题图
  - 柱状图
  - 折线图
  - 散点图
  - 饼图
  - 统计图
dependencies:
  - list_map_templates
  - list_chart_templates
  - get_template_schema
  - generate_map
  - generate_chart
---

## 制图模板可视化

### 静态地图模板

| 模板名称 | 适用场景 | 说明 |
|----------|----------|------|
| `choropleth_map` | 分级色彩专题图 | 按属性值着色的面状专题图 |
| `graduated_symbol_map` | 分级符号专题图 | 按属性值调整符号大小 |
| `heatmap` | 热力图 | 点密度可视化 |
| `point_map` | 点要素地图 | 点状要素分布图 |
| `line_map` | 线要素地图 | 路网、河流等线状要素 |
| `polygon_map` | 面要素地图 | 行政区划、地块 |
| `multi_layer_map` | 多图层叠加图 | 多个图层组合展示 |

### 统计图表模板

| 模板名称 | 适用场景 | 说明 |
|----------|----------|------|
| `bar_chart` | 柱状图 | 分类数据对比 |
| `line_chart` | 折线图 | 时序数据趋势 |
| `scatter_plot` | 散点图 | 相关性分析 |
| `pie_chart` | 饼图 | 占比分布 |
| `histogram` | 直方图 | 数据分布 |
| `box_plot` | 箱线图 | 数据分布特征 |

### 制图流程

1. 分析用户需求 → 确定可视化类型与模板
2. 调用 `get_template_schema` 获取模板参数格式
3. 构建配置 JSON（填充数据源与参数）
4. 调用 `generate_map` 或 `generate_chart` 生成图片
5. 返回图片文件路径
