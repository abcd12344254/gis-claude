---
name: interactive_viz
version: "1.0"
description: 交互式可视化 JSON 输出——前端动态渲染地图与图表
triggers:
  - 交互地图
  - 动态可视化
  - 探索数据
  - Web展示
  - 在线地图
dependencies: []
---

## 交互式可视化

### 模式说明

交互式可视化通过 JSON 文本输出可视化配置，前端系统解析并动态渲染。
支持缩放、平移、图层控制、要素点击等交互操作。

### JSON 输出格式

#### 点图层

```json
{
  "layer_id": "points_001",
  "layer_name": "兴趣点分布",
  "layer_type": "point",
  "visible": true,
  "opacity": 1.0,
  "data": { "source": "resource_handle", "geometry_type": "Point" },
  "style": {
    "marker_type": "circle|icon|symbol",
    "size": 8,
    "color": "#e74c3c",
    "color_field": "attribute_name",
    "stroke_color": "#ffffff",
    "stroke_width": 1,
    "label_field": "name"
  },
  "popup": { "enabled": true, "fields": ["name", "category"], "title_field": "name" }
}
```

#### 线图层

```json
{
  "layer_id": "lines_001",
  "layer_type": "line",
  "style": {
    "line_type": "solid|dashed|dotted",
    "width": 2,
    "color": "#3498db"
  }
}
```

#### 面图层

```json
{
  "layer_id": "polygons_001",
  "layer_type": "polygon",
  "style": {
    "fill_color": "#2ecc71",
    "fill_opacity": 0.6,
    "stroke_color": "#ffffff",
    "stroke_width": 1,
    "classification": {
      "field": "population",
      "method": "quantile",
      "num_classes": 5,
      "color_scheme": "YlOrRd"
    }
  }
}
```

### 可视化模式选择

| 用户需求 | 推荐模式 | 说明 |
|----------|----------|------|
| 生成报告配图 | 制图模板 | 输出静态图片 |
| 数据统计分析 | 制图模板 | 输出图表图片 |
| 数据探索分析 | 交互式 | 支持缩放筛选 |
| Web 应用展示 | 交互式 | 前端动态渲染 |
| 多图层对比 | 交互式 | 图层控制开关 |
| 快速生成 | 制图模板 | 模板高效生成 |
