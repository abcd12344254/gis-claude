---
name: bracket_commands
version: "1.0"
description: Bracket Command 指令系统——AI 通过结构化指令直接操作地图
triggers:
  - 地图
  - 查询
  - 分析
  - 计算
  - 路线
  - 加载
  - 显示
  - 查看
  - 搜索
  - 查找
dependencies: []
---

## 地图操作指令系统

你必须通过以下结构化指令来操作地图。每个指令用方括号括起，独占一行。

### OSM 数据查询指令
```
[OSM:boundary:地名]          — 行政区面（Polygon）
[OSM:outline:地名]           — 行政区/要素边界线（LineString）
[OSM:feature:地名]           — 自然地物面（沙漠/山脉/平原/湖泊等）
[OSM:districts:地名]         — 查行政区下所有区县（每区不同颜色）
[OSM:poi-in:地名:类型]        — 某地内的 POI
[OSM:poi:类型]               — 当前视野内的 POI
[OSM:buildings-in:地名]       — 区域内建筑物
[OSM:roads-in:地名:类型]      — 区域内道路
[OSM:water-in:地名]           — 区域内河流湖泊
[OSM:green-in:地名]           — 区域内公园绿地
[OSM:railways-in:地名]        — 区域内铁路
```

### 空间分析指令
```
[ANALYSIS:buffer:图层名:5km]       — 缓冲区
[ANALYSIS:intersect:图层A|图层B]    — 相交
[ANALYSIS:union:图层名]            — 合并
[ANALYSIS:difference:图层A|图层B]   — 差集
[ANALYSIS:centroid:图层名]         — 中心点
[ANALYSIS:area:图层名]             — 面积
[ANALYSIS:bbox:图层名]             — 边界框
[ANALYSIS:simplify:图层名:0.01]    — 简化
[ANALYSIS:convex:图层名]           — 凸包
[ANALYSIS:grid:图层名:10]          — 格网（km）
[ANALYSIS:density:图层名]          — 点密度
[ANALYSIS:distance:图层名]         — 点距离
[ANALYSIS:classify:图层名:字段]    — 分层着色
[ANALYSIS:dbscan:图层名:1.0]      — DBSCAN聚类
[ANALYSIS:kde:图层名:1.0]         — KDE热力图
[ANALYSIS:idw:图层名:字段:0.01]   — IDW插值
[ANALYSIS:zonal:区域图层|点图层:字段] — 分区统计
```

### 路径规划
```
[ROUTE:起点:终点:driving]   — driving/walking/cycling/flying
```

### 本地文件
```
[LOCAL:邯郸区县.geojson]    — 加载本地GeoJSON
```

### 地图操作
```
[MAP:zoomTo:lng,lat,zoom]  [MAP:addMarker:lng,lat,名称]  [MAP:fitBounds:w,s,e,n]
```

### 数据筛选
```
[QUERY:图层名:筛选条件]     — 如 [QUERY:武汉市:人口大于100万]
```

### 铁律
1. 分析前必须先有数据源。如果图层不存在，先生成 OSM 指令加载数据
2. 引用图层时用核心关键词（如"武汉市"而非"武汉市行政区划"）
3. ANALYSIS 指令前必须同时生成对应的 OSM 指令
4. 路线查询时不要生成 OSM 指令
5. 用户提到任何地名，必须生成对应的 OSM 指令
6. 不要编造 GeoJSON 坐标
7. 中文地名直接用中文
