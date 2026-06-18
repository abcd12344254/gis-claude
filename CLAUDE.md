# GIS Claude — 智能地理信息系统

## 项目概述

基于 React + MapLibre GL + DeepSeek AI 的智能 GIS 应用。支持 OSM 真实数据查询、空间分析、路径规划、时空立方体分析、AI 驱动的自然语言交互。

## 技术栈

| 层 | 技术 |
|---|------|
| 前端框架 | React 18 + TypeScript |
| 地图引擎 | MapLibre GL JS 4.5 |
| UI | Ant Design 5 + 中文 locale |
| 空间分析 | Turf.js 7 |
| 状态管理 | Zustand 4 |
| AI | DeepSeek Chat API（通过 Python 后端代理） |
| 后端 | FastAPI + uvicorn |
| 构建 | Vite 5 |

---

## 界面布局（三栏式）

```
┌──────────────────────────────────────────────────────────┐
│  顶部工具栏: 城市跳转 | 底图切换 | 缩放 | 测量 | 3D地形 │
│             绘图工具: 点/折线/多边形  |  API设置 | 清除  │
├──────────────┬───────────────────────┬────────────────────┤
│  左侧面板     │       地图区域         │   右侧 AI 助手     │
│  (320px)     │      MapLibre GL     │   (380px)         │
│              │                      │                   │
│  📂 图层管理  │                      │   💬 对话历史      │
│  · 上传GeoJSON│                      │   · 智能提示词     │
│  · 显示/隐藏  │                      │   · OSM查询卡片   │
│  · 颜色/透明度│                      │   · 分析结果卡片   │
│  · 导出/复制  │                      │   · 路径规划卡片   │
│  · 删除      │                      │                   │
│              │                      │   📝 输入框        │
│  🔬 空间分析  │                      │                   │
│  · 10种工具   │                      │                   │
│  · 手动执行   │                      │                   │
│              │                      │                   │
│  🕐 时空立方体│                      │                   │
│  · CSV上传   │                      │                   │
│  · 模拟数据   │                      │                   │
│  · 3D/热点图  │                      │                   │
│              │                      │                   │
│  ⚡ 一键成图  │                      │                   │
│  · 标题/副标题│                      │                   │
│  · 图例/比例尺│                      │                   │
│  · 指北针    │                      │                   │
│  · 5种配色   │                      │                   │
│  · 高清PNG导出│                      │                   │
└──────────────┴───────────────────────┴────────────────────┘
```

---

## 各面板功能详解

### 1. 顶部工具栏 (Toolbar + DrawingTools)

**Toolbar — 地图控制：**
| 功能 | 操作 | 说明 |
|------|------|------|
| 城市跳转 | 下拉菜单选择 | 预设 10 个主要城市，一键飞行定位 |
| 底图切换 | 下拉菜单选择 | 5 种底图：OSM / CartoDB Light / CartoDB Dark / Esri 卫星图 / Esri 地形图 |
| 放大/缩小 | 按钮 | 地图缩放 |
| 回到默认 | 按钮 | 飞回北京 (116.397, 39.909, zoom 11) |
| 测量工具 | 切换按钮 | 点击地图测量距离/面积，双击结束 |
| 3D 地形 | 切换按钮 | 切卫星图 + hillshade + terrain 3D，再按回到 2D |

**DrawingTools — 绘图：**
| 工具 | 操作 | 说明 |
|------|------|------|
| 绘制点 | 单击激活，再单击地图放置点，双击完成 | 生成 Point FeatureCollection |
| 绘制折线 | 同上 | 生成 LineString FeatureCollection |
| 绘制多边形 | 同上 | 生成 Polygon FeatureCollection |
| 取消绘制 | 再次点击已激活的工具 | 退出绘制模式 |

> 注意：绘制和测量互斥，一次只能激活一个。绘制完成的图形自动加入图层列表。

### 2. 图层管理 (LayerPanel)

左侧面板顶部。管理所有地图图层。

| 功能 | 说明 |
|------|------|
| 上传 GeoJSON | 点击上传按钮，选择 `.json` / `.geojson` 文件，自动识别要素类型（点/线/面） |
| 可见性切换 | 👁 图标切换显示/隐藏 |
| 颜色选择 | ColorPicker 修改图层颜色 |
| 透明度 | Slider 0-100% |
| 点击图层名 | 自动缩放到该图层数据范围 |
| 右键菜单 | 导出 GeoJSON、复制图层 |
| 删除 | 红色删除按钮（有确认弹窗） |
| 要素计数 | 每个图层显示包含的要素数量 |

### 3. 空间分析面板 (SpatialAnalysisPanel)

左侧面板中部。提供 10 种手动空间分析工具：

| 工具 | 需要参数 | 说明 |
|------|---------|------|
| 缓冲区 Buffer | 图层 + 半径(km) | 创建要素周围指定距离的缓冲区 |
| 相交分析 Intersect | 两个图层 | 计算两个图层的相交区域 |
| 合并分析 Union | 图层 | 合并多个多边形要素 |
| 面积计算 Area | 图层 | 计算多边形要素的面积 |
| 中心点 Centroid | 图层 | 计算要素的几何中心 |
| 边界框 BBox | 图层 | 计算要素的外接矩形 |
| 简化 Simplify | 图层 + 容差 | 简化要素几何（减少顶点） |
| 凸包 Convex Hull | 图层 | 计算点集的凸包 |
| 格网 Grid | 可选图层 + 格网大小(km) | 创建渔网格网。无图层则基于当前视野 |
| 点密度 Density | 图层 | 计算点密度分布 |

> 分析结果自动作为新图层添加到地图中。缓冲/合并/相交等操作会将源图层替换为结果图层。

### 4. 时空立方体面板 (SpaceTimePanel)

左侧面板下部。时空数据 3D 可视化分析。

**数据来源：**
- **CSV 上传**：拖拽上传，自动识别列名（lat/latitude, lng/longitude/lon, time/year/date, value/count/amount）
- **AI 模拟数据**：3 个预设场景（北京犯罪热点、武汉餐饮分布、上海房价变化）

**分析功能：**
| 功能 | 说明 |
|------|------|
| 时空立方体聚合 | 将时空点数据聚合到网格单元（可调网格大小 0.005°-0.1°） |
| 趋势分类 | 每个格网自动标注趋势：增长/减弱/稳定/振荡/新兴/消失 |
| Getis-Ord Gi* 热点分析 | 空间自相关分析，识别显著热点和冷点 |
| 年份滑块 | 选择不同年份查看数据变化 |
| 3D 立方体加载 | 按年份分层挤出（fill-extrusion），每层自动抬高 800 单位 |
| 2D 热点图加载 | 平面热点图，按热点类型着色 |
| 图例 | 自动显示趋势或热点颜色图例 |

### 5. 一键成图面板 (QuickMapExport)

左侧面板最底部。专业地图导出功能。

| 功能 | 选项 |
|------|------|
| 标题/副标题 | 自定义文本，显示在地图顶部 |
| 图例开关 | 自动从可见图层生成图例 |
| 比例尺开关 | 自动计算比例尺（nice round numbers） |
| 指北针开关 | 手绘 SVG 指北针，N 标记 |
| 配色方案 | 5 种：简洁白 / 典雅米 / 暗夜黑 / 森林绿 / 海洋蓝 |
| 分辨率 | 1x ~ 4x 超采样 |
| 导出 | 高清 PNG，自动下载 |

### 6. AI 助手 (AIAssistant)

右侧面板。DeepSeek 驱动的自然语言 GIS 交互。

**核心流程：**
```
用户输入自然语言
    ↓
DeepSeek API (含系统提示词 + 地图空间上下文)
    ↓
AI 回复含结构化指令
    ↓
前端解析指令 → 执行 → 结果加载到地图
```

**空间上下文（每次请求自动附带）：**
- 地图中心坐标 + 缩放级别
- 视野范围（WGS84 bbox + 估算 km 尺寸）
- 可见图层列表（名称 + 几何类型 + 要素数量）

**完整指令系统：**

#### OSM 数据查询指令
```
[OSM:boundary:地名]          — 行政区面（Polygon）
[OSM:outline:地名]           — 行政区/要素边界线（LineString）
[OSM:feature:地名]           — 自然地物面（沙漠/山脉/平原/湖泊等）
[OSM:districts:地名]         — 查行政区下所有区县（每区不同颜色）
[OSM:poi-in:地名:类型]        — 某地内的 POI（精准区域查询）
[OSM:poi:类型]               — 当前视野内的 POI
[OSM:buildings-in:地名]       — 区域内建筑物
[OSM:roads-in:地名:类型]      — 区域内道路（primary/secondary/...）
[OSM:water-in:地名]           — 区域内河流湖泊
[OSM:green-in:地名]           — 区域内公园绿地
[OSM:railways-in:地名]        — 区域内铁路
[OSM:railways]               — 当前视野铁路
```

#### 空间分析指令
```
[ANALYSIS:buffer:图层名:5km]        — 缓冲区（默认 5km，支持 m 后缀）
[ANALYSIS:intersect:图层A|图层B]     — 相交分析
[ANALYSIS:union:图层名]             — 合并要素
[ANALYSIS:centroid:图层名]          — 计算中心点
[ANALYSIS:area:图层名]              — 计算面积
[ANALYSIS:bbox:图层名]              — 计算边界框
[ANALYSIS:simplify:图层名:0.01]     — 简化几何
[ANALYSIS:convex:图层名]            — 凸包分析
[ANALYSIS:grid:图层名:10]           — 生成格网（km）
[ANALYSIS:density:图层名]           — 点密度分析
[ANALYSIS:distance:图层名]          — 计算点距离
```

#### 路径规划指令
```
[ROUTE:起点:终点:方式]   — 方式: driving(默认) | walking | cycling
```
- 路线通过 OSRM 引擎计算（后端代理，支持驾车/步行/骑行）
- 结果包含：路线折线 + 起终点标记 + 距离/时间 + 导航步骤
- 失败时自动回退为直线连接

#### 本地文件加载指令
```
[LOCAL:文件名]   — 加载 public/ 下的 GeoJSON 文件
```
可用本地文件：`邯郸区县.geojson`、`邯郸市.json`

#### 地图操作指令
```
[MAP:zoomTo:lng,lat,zoom]   — 飞行动画定位
[MAP:addMarker:lng,lat,名称] — 添加标记点
[MAP:fitBounds:w,s,e,n]     — 缩放到指定范围
```

#### 时空分析指令
```
[SPACETIME:simulate:场景:年份:点数]  — 生成模拟时空数据
```

**AI 提示词中的关键规则：**
- 决策树：根据用户语境选择正确指令类型（专有名词→feature，行政区→boundary，"XX的YY"→poi-in）
- 铁律1：分析前必须先有数据源。如果图层已存在→直接用，否则→先生成 OSM 指令
- 铁律2：引用图层时用核心关键词（如"铁路网"而非"武汉市铁路网"），系统自动模糊匹配
- 铁律3：ANALYSIS 指令前必须同时生成对应的 OSM 指令
- 路线查询时不生成 OSM 指令（避免地图跳动干扰路径规划）

**图层模糊匹配算法（4 级递进，在 `findLayerByName` 中）：**
1. 精确匹配（去除时间戳后缀）
2. 图层名包含 ref
3. ref 包含图层名关键词（取最长匹配）
4. 双向分词重叠度匹配（2-4 字滑动窗口，重叠≥2 即命中）

**自动补偿机制：**
当 AI 忘记生成 OSM 指令但用户输入明显是地理查询时，前端自动从用户输入提取地名，补发 `[OSM:feature:地名]` 查询。

---

## 目录结构

```
gis-claude/
├── src/
│   ├── main.tsx                  # React 入口，Antd ConfigProvider + 中文化
│   ├── App.tsx                   # 三栏布局 + 设置弹窗
│   ├── App.css
│   ├── components/
│   │   ├── MapView.tsx           # MapLibre 地图核心（图层渲染、测量、绘制、3D地形）
│   │   ├── AIAssistant.tsx       # AI 对话 + 全部指令解析执行
│   │   ├── LayerPanel.tsx        # 图层管理（上传/显隐/颜色/透明度/导出/删除）
│   │   ├── SpatialAnalysisPanel.tsx  # 手动空间分析（10 种工具）
│   │   ├── SpaceTimePanel.tsx    # 时空立方体（CSV/模拟/3D挤出/热点图）
│   │   ├── QuickMapExport.tsx    # 一键成图（标题/图例/比例尺/指北针/配色/PNG导出）
│   │   ├── Toolbar.tsx           # 顶部工具栏（城市跳转/底图切换/缩放/测量/3D）
│   │   └── DrawingTools.tsx      # 绘图工具（点/折线/多边形）
│   ├── services/
│   │   ├── spatialAnalysis.ts    # Turf.js 空间分析（buffer/intersect/union/...）
│   │   ├── osmService.ts         # OSM Nominatim + Overpass 数据服务
│   │   ├── deepseek.ts           # DeepSeek API 调用
│   │   ├── gaodeService.ts       # 高德地图服务（geocode/POI，国内数据补偿）
│   │   ├── routingService.ts     # OSRM 路径规划 + 城市感知地理编码
│   │   └── spacetimeService.ts   # 时空分析服务（CSV解析/立方体聚合/Getis-Ord Gi*）
│   ├── store/
│   │   └── useGISStore.ts        # Zustand 全局状态（地图/图层/绘制/聊天/分析/3D/API Key）
│   └── types/
│       └── index.ts              # TypeScript 类型定义
├── server/
│   ├── main.py                   # FastAPI 后端（11 组 API 端点）
│   ├── .env                      # DEEPSEEK_API_KEY / GAODE_API_KEY / HTTPS_PROXY
│   └── requirements.txt
├── public/
│   ├── 邯郸区县.geojson          # 本地行政区划数据
│   └── 邯郸市.json              # 本地综合地理数据
├── vite.config.ts                # Vite 配置（4 组代理：API/OSM/Overpass/Wikidata）
├── package.json
└── tsconfig.json
```

---

## 启动项目

```bash
cd C:/Users/刘炜航/gis-claude

# 后端 (端口 8001)
cd server && python main.py

# 前端 (端口 3000，可能自动跳到 3001)
npm run dev
```

---

## 环境配置

### server/.env
```env
DEEPSEEK_API_KEY=sk-...    # DeepSeek API Key（必填）
GAODE_API_KEY=...          # 高德地图 API Key（可选，国内地理编码更准）
HTTPS_PROXY=http://127.0.0.1:7890  # 代理（国内访问 OSM/Wikidata/OSRM 需要）
```

### 前端 API Key
在 UI 右上角点击 🔑 图标设置，保存在 localStorage。

---

## 后端 API 端点

| 路由 | 方法 | 用途 |
|------|------|------|
| `/api/health` | GET | 健康检查，返回 OSM 代理状态 |
| `/api/chat` | POST | DeepSeek 对话代理 |
| `/api/osm/nominatim/search` | GET | OSM 地理编码（地名→坐标） |
| `/api/osm/nominatim/reverse` | GET | OSM 逆地理编码（坐标→地址） |
| `/api/osm/overpass` | POST | OSM 空间查询（Overpass QL） |
| `/api/wikidata/search` | GET | Wikidata 实体搜索 |
| `/api/wikidata/entity/{id}` | GET | Wikidata 实体数据 |
| `/api/gaode/geocode` | GET | 高德地理编码（GCJ-02→WGS-84 自动转换） |
| `/api/gaode/reverse` | GET | 高德逆地理编码 |
| `/api/gaode/poi` | GET | 高德 POI 搜索 |
| `/api/osrm/route/{profile}` | GET | OSRM 路径规划（driving/walking/cycling） |
| `/api/spatial/analyze` | GET | 服务端空间分析（geopandas + shapely） |

---

## Vite 代理配置

前端 Vite 直接代理了以下 OSM/Wikidata 请求（绕过 CORS）：
- `/osm-nominatim` → `https://nominatim.openstreetmap.org`
- `/osm-overpass` → `https://overpass-api.de`
- `/wikidata-proxy` → `https://www.wikidata.org`
- `/api` → `http://localhost:8001`

注意：这些代理对国内网络无效，需要通过 `HTTPS_PROXY` 在后端走代理。

---

## 数据流与通信

### 地图事件通信（Window CustomEvent）
组件间通过 `window.dispatchEvent` 解耦通信：

| 事件名 | 方向 | 用途 |
|--------|------|------|
| `fly-to` | → MapView | 飞行定位到指定坐标+缩放 |
| `zoom-to-bounds` | → MapView | 缩放到 bbox 范围 |
| `map-zoom-in` / `map-zoom-out` | → MapView | 缩放 |
| `change-basemap` | → MapView | 切换底图 |
| `add-direct-layer` | → MapView | 添加临时图层（分析预览） |
| `toggle-3d-terrain` | → MapView | 切换 3D 地形 |

### Zustand Store（`useGISStore`）核心状态

| 状态 | 类型 | 说明 |
|------|------|------|
| `mapState` | `{center, zoom, bearing, pitch, bounds}` | 地图当前状态（moveend 时更新） |
| `layers` | `GISLayer[]` | 所有图层（含数据、颜色、可见性） |
| `drawing` | `{active, type}` | 当前绘制状态 |
| `chatMessages` | `ChatMessage[]` | AI 对话历史 |
| `deepseekApiKey` | `string` | API Key（localStorage 持久化） |
| `measurementActive` | `boolean` | 测量模式开关 |
| `terrain3dEnabled` | `boolean` | 3D 地形开关 |
| `analysisTasks` | `AnalysisTask[]` | 分析任务历史 |

---

## 已知问题及修复

1. **图层切换可见性后消失** — MapView 中 `addSource` 后直接 `addStyleLayers()`，不走异步等待
2. **缓冲区 MultiPolygon 不渲染** — Fill 层 filter 需同时匹配 Polygon 和 MultiPolygon
3. **intersect 对复杂几何失败** — 用 `turf.truncate` + `turf.simplify` + `turf.unkinkPolygon` 递进清洁重试
4. **OSM 数据含冗余标记点** — `osmToGeoJSON` 跳过面状查询结果中的孤立 tagged node
5. **GCJ-02 坐标偏移** — 高德返回的是火星坐标，后端 `main.py` 内置了 GCJ-02 → WGS-84 转换算法
6. **OSM 国内无法访问** — 需在 `server/.env` 配置 `HTTPS_PROXY`；Nominatim 超时/连接失败时给出明确的代理配置提示

---

## 环境要求

- Node.js >= 20
- Python >= 3.10
- DeepSeek API Key（在 UI 或 server/.env 配置）
- 高德 API Key（可选，用于国内 POI/地理编码）
- 代理（国内用户访问 OSM/Wikidata/OSRM 需要）
