/**
 * ====== GIS 命令引擎 ======
 *
 * 从 AIAssistant.tsx 提取的所有命令解析与执行逻辑。
 * 函数使用 useGISStore.getState() 获取 store 状态，不依赖 React hooks。
 *
 * 包含：
 * - 空间上下文构建
 * - 所有 Bracket Command 的解析（OSM/ANALYSIS/ROUTE/LOCAL/QUERY/HAZARD/MAP/SPACETIME）
 * - 所有命令的执行逻辑
 * - 图层模糊匹配（findLayerByName）
 * - 幻觉过滤 + 自动补偿 + 安全网
 * - AI 回复后处理
 */

import { useGISStore } from '../store/useGISStore';
import {
  parseOSMCommands, executeOSMCommand,
  queryFeature, queryBoundary, queryWaterways, queryRoads,
  queryGreenSpace, queryBuildings, queryRailways,
  geocodeSearch,
} from './osmService';
import type { OSMCommand, OSMQueryResult } from './osmService';
import {
  bufferAnalysis,
  calculateArea,
  calculateCentroid,
  calculateBBox,
  simplifyFeatures,
  convexHullAnalysis,
  intersectAnalysis,
  unionAnalysis,
  differenceAnalysis,
  calculateDistance,
  measureDistance,
  createGrid,
  pointDensityAnalysis,
  clusterDBSCAN,
  kernelDensityEstimation,
  interpolateIDW,
  zonalStatistics,
} from './spatialAnalysis';
import { applyClassification, COLOR_RAMPS, findNumericFields } from './classification';
import { getFCBounds } from '../utils/geo';
import { planRoute, getRouteBounds } from './routingService';
import type { RouteResult, TravelMode } from './routingService';
import { gaodeGeocode } from './gaodeService';
import {
  queryEarthquakes,
  sampleElevationGrid,
  generateElevationPoints,
  generateElevationLabels,
  queryWeather,
  generateContours,
} from './hazardService';
import { parseNLQuery, executeQuery as execQuery, getQueryableFields } from './nlQuery';
import type { FeatureCollection, Feature, Polygon, MultiPolygon } from 'geojson';

// ====== 系统提示词 ======

export const GEOJSON_INSTRUCTION = `
## 地图交互能力 —— 指令参考

你是 GIS 助手，能通过指令直接操作地图。请严格遵守以下规则。

### 决策树：根据用户语境选择正确的指令

**第1步：判断用户在问什么类型的地理事物？**
├─ ⚠️ 专有名词（XX大学、XX学院、XX公司、XX医院...）→ 用 [OSM:feature:全名]  精确查该实体！
│   ├─ "武汉大学" → [OSM:feature:武汉大学]   ← 专有名词！不是"武汉的大学"！
│   ├─ "中国地质大学" → [OSM:feature:中国地质大学]
│   ├─ "清华大学" → [OSM:feature:清华大学]
│   └─ "XX大学"/"XX学院"/"XX中学"/"XX医院" 只要没有"的"字就是专有名词！
├─ 行政区（省、市、区、县、乡、村，地名含"区/市/县/省"） → 用 [OSM:boundary:地名] 或 [OSM:outline:地名]
├─ 自然地物（沙漠、山脉、高原、平原、盆地、湖泊、河流、森林、冰川、湿地、岛屿、半岛、海湾） → 用 [OSM:feature:地名] 或 [OSM:outline:地名]
│   ⚠️ 歧义消解：单名可能同时是湖泊和行政区时，默认查自然地物！
│   ├─ "西湖" → [OSM:feature:杭州西湖]  ← 是杭州的湖！不是南昌西湖区！
│   ├─ "太湖" → [OSM:feature:太湖]       ← 是湖！不是太湖县！
│   ├─ "黄山" → [OSM:feature:黄山]       ← 是山！不是黄山市！
│   ├─ "巢湖" → [OSM:feature:巢湖]       ← 是湖！不是巢湖市！
│   └─ 用户输入不含"区/市/县"字样 → 绝不将其识别为行政区！
├─ "XX地方的YY"（有"的"字，如"武汉的大学"） → 用 [OSM:poi-in:地名:类型]
└─ "附近的XX"（没有地名） → 用普通指令在当前视野查

**第2步：用户想要什么几何类型？**
├─ "边界/轮廓/边界线/轮廓线/范围线/界限" → 线状（outline → LineString）
├─ "区域/范围/面积/覆盖/标出来/显示/查看" → 面状（boundary/feature → Polygon）
└─ 只说"查XX"/"XX在哪里" → 默认面状（Polygon）

**第3步：生成对应指令**
\`\`\`
[OSM:outline:地名]     — 轮廓线（LineString）— 用户要"边界"时用
[OSM:boundary:地名]    — 行政区面（Polygon）— 仅用于行政区
[OSM:districts:地名]   — 查该行政区下所有区县，每个区县自动分配不同颜色！
[OSM:feature:地名]     — 自然/任意要素面（Polygon）— 沙漠/山脉/平原/湖泊等
[OSM:poi-in:地名:类型] — 某地内的POI — 如 [OSM:poi-in:武汉市:university]
[OSM:buildings-in:地名]  [OSM:roads-in:地名:类型]  [OSM:water-in:地名]  [OSM:green-in:地名]  [OSM:railways-in:地名]  [OSM:railways]
\`\`\`

### 关键示例（请严格参考！）

| 用户说 | 正确的指令 | 原因 |
|--------|-----------|------|
| "武汉市边界" | [OSM:outline:武汉市] | "边界"→线状 |
| "显示武汉行政区" | [OSM:boundary:武汉市] | "行政区"→面状 |
| "北京的轮廓" | [OSM:outline:北京市] | "轮廓"→线状 |
| "北京的范围" | [OSM:boundary:北京市] | "范围"→面状 |
| "塔克拉玛干沙漠" | [OSM:feature:塔克拉玛干沙漠] | 沙漠→自然地物→面状 |
| "塔克拉玛干沙漠边界" | [OSM:outline:塔克拉玛干沙漠] | "边界"→线状 |
| "华北平原的范围" | [OSM:feature:华北平原] | 平原→自然地物→面状 |
| "东北平原边界" | [OSM:outline:东北平原] | "边界"→线状 |
| "青藏高原" | [OSM:feature:青藏高原] | 高原→自然地物→面状 |
| "四川盆地" | [OSM:feature:四川盆地] | 盆地→自然地物→面状 |
| "天山山脉" | [OSM:feature:天山山脉] | 山脉→自然地物→面状 |
| "青海湖" | [OSM:feature:青海湖] | 湖泊→自然地物→面状 |
| "西湖" | [OSM:feature:杭州西湖] | ⚠️ 湖泊不是南昌西湖区！ |
| "太湖" | [OSM:feature:太湖] | 湖泊不是太湖县 |
| "黄山" | [OSM:feature:黄山] | 山脉不是黄山市 |
| "武汉大学" | [OSM:feature:武汉大学] | 专有名词→精确查 |
| "中国地质大学" | [OSM:feature:中国地质大学] | 专有名词→精确查 |
| "清华大学" | [OSM:feature:清华大学] | 专有名词→精确查 |
| "武汉的大学" | [OSM:poi-in:武汉市:university] | 地名+"的"+内容→范围查 |
| "附近的餐厅" | [OSM:poi:restaurant] | 没地名→视野查 |
| "对北京市做10km缓冲区" | [OSM:boundary:北京市]\\n[ANALYSIS:buffer:北京市:10km] | 先查数据→再分析 |
| "计算武汉的面积" | [OSM:boundary:武汉市]\\n[ANALYSIS:area:武汉市] | 先查数据→再分析 |
| "南京3公里缓冲区" | [OSM:boundary:南京市]\\n[ANALYSIS:buffer:南京市:3km] | 先查数据→再分析 |
| "北京市各区县" / "北京有哪些区" | [OSM:districts:北京市] | 每个区县不同颜色！ |
| "邯郸的河流" / "武汉的水系" | [OSM:water-in:邯郸市] | 查该区域内的河流、湖泊 |
| "北京的铁路" / "上海铁路网" | [OSM:railways-in:北京市] | 查该区域内的铁路线 |
| "天津道路和铁路" | [OSM:roads-in:天津市:primary]\\n[OSM:railways-in:天津市] | 道路和铁路分别查 |

### ⚠️ 铁律1：分析前必须先有数据源！
当系统告诉你当前已有图层时，**直接用这些图层的名字做分析，不要再生成 OSM 指令！**
只有当用户要分析的区域/主题还没有对应图层时，才需要 [OSM:...] 来先加载数据。

### 🔑 铁律2：引用已有图层时用核心关键词！
图层名格式通常是 "类型 (地理位置)"，如 "铁路网 (河北省邯郸市)"、"武汉市 (地级市)"。
在 [ANALYSIS:...] 中引用时，**只用核心关键词**：
  · "铁路网" — ✅ 而非 "武汉市铁路网" 或 "铁路数据"
  · "武汉市" — ✅ 而非 "武汉行政区" 或 "武汉市边界"
  · 系统会自动模糊匹配，核心关键词就能命中！

### ⚠️ 铁律3：分析指令前必须先有数据！
当你生成 [ANALYSIS:...] 指令时，**必须同时生成 [OSM:...] 指令来查询该地的数据**！
**例外：如果空间上下文中已有该数据的图层，直接引用，不需要重新查 OSM！**
没有OSM指令→系统不知道你要分析哪个图层→必然失败！

### 视野范围查询
\`\`\`
[OSM:poi:类型]  [OSM:buildings]  [OSM:roads:类型]  [OSM:water]  [OSM:green]  [OSM:railways]
\`\`\`

### 空间分析指令（对已有图层执行GIS分析）
\`\`\`
[ANALYSIS:buffer:图层名:5km]       — 缓冲区分析（默认5km）
[ANALYSIS:intersect:图层A|图层B]    — 相交分析
[ANALYSIS:union:图层名]            — 合并要素
[ANALYSIS:difference:图层A|图层B]   — 差集分析（A减B）
[ANALYSIS:centroid:图层名]         — 计算中心点
[ANALYSIS:area:图层名]             — 计算面积
[ANALYSIS:bbox:图层名]             — 计算边界框
[ANALYSIS:simplify:图层名:0.01]    — 简化几何
[ANALYSIS:convex:图层名]           — 凸包分析
[ANALYSIS:grid:图层名:10]          — 生成格网（km）
[ANALYSIS:density:图层名]          — 点密度分析
[ANALYSIS:distance:图层名]         — 计算点距离
[ANALYSIS:classify:图层名:字段]    — 分层着色（按数值字段分级。⚠️ 字段名必须来自上方[当前地图状态]中该图层的"数值字段"列表！字段不存在会失败）
[ANALYSIS:dbscan:图层名:1.0]      — DBSCAN 点聚类（eps=1km, minPts=3。点图层使用）
[ANALYSIS:kde:图层名:1.0]         — 核密度估计（带宽1km，生成热力格网。点图层使用）
[ANALYSIS:idw:图层名:字段:0.01]   — IDW空间插值（对数值字段做反距离加权插值。点图层使用）
[ANALYSIS:zonal:区域图层|点图层:字段] — 分区统计（统计每个区域内点的数值字段：计数/求和/均值/最大/最小/标准差）
\`\`\`

### 数据筛选指令
\`\`\`
[QUERY:图层名:自然语言条件]       — 从图层中筛选要素
\`\`\`
支持的自然语言条件：
  ·"人口大于100万" / "面积小于50"  — 数值比较（自动匹配字段）
  ·"名称包含武汉"                   — 字符串包含
  ·"GDP最高的5个"                   — Top-N 排序
  ·"鄱阳湖"                         — 全字段关键词搜索
筛选结果会作为新图层（粉色）加载。字段名自动模糊匹配。

⚠️ 图层名用模糊匹配（如"武汉市"可匹配"武汉市(地级市)_14:30:25"）
   半径默认单位是 km，支持 m 后缀（如 500m）
   dbscan/kde/idw 只对点图层有效；zonal 需要双图层（面+点）
   分析结果会自动加载为新图层！

### 本地文件加载指令
\`\`\`
[LOCAL:文件名]                      — 加载本地GeoJSON/JSON文件到地图
\`\`\`
可用本地文件：
  · 邯郸区县.geojson — 邯郸市区县级行政区划数据
  · 邯郸市.json — 邯郸市综合地理数据

当用户提到"邯郸"、"邯郸市"、"邯郸区县"、"本地数据"等关键词时，
优先使用 [LOCAL:...] 指令加载本地文件，而不是去 OSM 查询！

### 路径规划指令
\`\`\`
[ROUTE:起点:终点:方式]              — 规划从起点到终点的路径
\`\`\`
出行方式: driving(驾车/默认) | walking(步行) | cycling(骑行)
示例:
  · [ROUTE:北京市天安门:北京市颐和园:driving]  — 驾车从天安门到颐和园
  · [ROUTE:邯郸市政府:丛台公园:walking]       — 步行从市政府到丛台公园
  · [ROUTE:武汉大学:华中科技大学:cycling]     — 骑行从武大到华科
  · [ROUTE:上海虹桥站:上海浦东机场]           — 默认驾车（可省略:driving）

当用户说"从A到B"、"A到B怎么走"、"规划从A到B的路线"、"去XX的路线"时，
生成 [ROUTE:A:B:方式] 指令。根据语境判断出行方式：
  · "开车/驾车/自驾" → driving
  · "步行/走路/走过去" → walking
  · "骑行/骑车/自行车" → cycling
  · "飞/飞行/坐飞机/飞到" → flying
  · 没有明确方式 → 默认 driving

🚫 **重要：路线查询时不要生成 OSM/ANALYSIS/MAP 指令！**
  [ROUTE:...] 指令会自动处理地理编码、路线计算、地图缩放的完整流程。
  同时生成 [OSM:...] 指令会导致地图跳动，干扰路线规划的坐标定位。
  用户说"从南阳到武汉" → 只生成 [ROUTE:南阳市:武汉市:driving]，不生成 [OSM:boundary:...]。

⚠️ **城市上下文规则**：路线规划的地名必须包含城市信息！
  · 如果用户说"从武汉大学到中国地质大学"→ 要写成 [ROUTE:武汉大学:中国地质大学(武汉):driving]
  · 如果地图视野在邯郸但用户提到了其他城市的地名 → 在地名后括号注明城市
  · 从起点地名中提取城市提示词（如"武汉大学"→"武汉"），给没有城市信息的终点补上
  · 例如：地图在邯郸，"从武汉大学到光谷广场" → [ROUTE:武汉大学:武汉光谷广场:driving]
  · 如果起点和终点都没有城市信息，且地图视野不在相关城市 → 询问用户

### 地图操作
[MAP:zoomTo:lng,lat,zoom]  [MAP:addMarker:lng,lat,名称]  [MAP:fitBounds:w,s,e,n]  [MAP:clearLayers]
- zoomTo: 飞到指定坐标和缩放级别
- addMarker: 在地图上添加标记点
- fitBounds: 缩放到指定范围 (西,南,东,北)
- clearLayers: 清空所有图层（用户说"清空图层"/"删除所有数据"/"清除地图"时使用）

### 时空分析指令
\`\`\`
[SPACETIME:simulate:场景:年份:点数]   — 生成模拟时空数据进行立方体分析
\`\`\`
当用户提到"时空分析"、"时空立方体"、"热点分析"、"空间分布随时间变化"等时，
告知用户：可以在左侧面板"时空立方体"中上传 CSV 数据，或使用模拟数据按钮。

### 灾害数据指令（地震、地形）
\`\`\`
[HAZARD:earthquake:4.0]   — 查询当前视野 M≥4.0 地震（近90天）
[HAZARD:earthquake]       — 查询当前视野 M≥3.0 地震
[HAZARD:elevation:100]    — 生成当前视野等高线（等高距 100m，需先开3D地形）
[HAZARD:elevation]        — 生成当前视野等高线（默认等高距 100m）
[HAZARD:dem:天津市]        — 生成指定地区的DEM数据（自动定位+3D+等高线+极值）
[HAZARD:dem:武汉市:50]     — 生成指定地区DEM数据（等高距 50m）
[HAZARD:weather]          — 查询当前视野实时气象+7天预报
\`\`\`
当用户提到"地震"、"地震带"、"最近地震"、"地质灾害"时，生成 earthquake 指令。
当用户提到"等高线"、"地形"、"海拔"、"高程"时，是当前视野则生成 elevation 指令。
当用户指定了具体地区如"生成天津市DEM"、"武汉市DEM数据"、"北京地形"时，生成 dem 指令（自动定位该地区+开启3D+生成等高线）。先开3D地形。
当用户提到"天气"、"气温"、"下雨"、"刮风"、"降雨"时，生成 weather 指令。

### ⚠️ 绝对规则 —— 违反将导致查询失败！

1. **只要用户提到任何地名（无论是否有"区域/边界"等修饰词），你必须生成对应的 [OSM:...] 指令！**
   - "查塔克拉玛干沙漠" → [OSM:feature:塔克拉玛干沙漠]
   - "塔克拉玛干沙漠" → [OSM:feature:塔克拉玛干沙漠]
   - "武汉" → [OSM:boundary:武汉市]
   - 即使用户只说了一个地名，没有任何修饰词，也必须生成指令！

2. 永远不要自己编造 GeoJSON 坐标！交给 OSM 指令查询

3. 每个 [OSM:...] 指令独占一行，放在回复的开头或结尾

4. 中文地名直接用中文，不需要翻译成英文

5. 宁可多生成指令，也不要遗漏。系统会自动忽略无效指令。
`;

export const SYSTEM_PROMPT = `你是 GIS Claude，专业的地理信息系统智能助手，具备真实地图数据查询能力。

你精通：空间分析、GIS理论、坐标系与投影、PostGIS、Turf.js、MapLibre GL JS、GeoPandas、制图与可视化。

你非常擅长理解中文地理语境：
- "边界/轮廓" = 线 → outline
- "区域/范围/面积" = 面 → boundary/feature
- 自然地理术语：平原、高原、盆地、沙漠、山脉、湖泊、河流、森林、冰川、湿地、岛屿、半岛、海湾 → 用 feature

${GEOJSON_INSTRUCTION}

请用中文回答。回答要专业、准确、实用。关键是：涉及真实地理数据时，用 [OSM:...] 指令查询，不要凭空编造坐标。`;

export const QUICK_PROMPTS = [
  { icon: '🗺️', label: '查行政区边界', prompt: '帮我查询北京市海淀区的行政边界' },
  { icon: '🍽️', label: '查周边餐厅', prompt: '查询当前地图视野内有哪些餐厅' },
  { icon: '🏫', label: '查武汉的大学', prompt: '查找武汉市的大学' },
  { icon: '🏗️', label: '查北京的建筑物', prompt: '查询北京市朝阳区的建筑物分布' },
  { icon: '💧', label: '查杭州水系', prompt: '查询杭州市的河流和湖泊' },
  { icon: '🌳', label: '查上海公园', prompt: '查询上海市的公园和绿地' },
];

// ====== Helpers ======

/** 中文地理要素后缀词 */
const GEO_SUFFIXES = [
  '沙漠', '平原', '高原', '盆地', '山脉', '丘陵', '草原', '沼泽', '戈壁',
  '湖泊', '海洋', '河流', '森林', '冰川', '湿地', '绿洲', '岛屿', '半岛', '海湾', '河谷', '礁石',
  '省', '市', '区', '县', '乡', '镇', '村',
  '行政区', '自治区', '特别行政区',
];

/** 常见的地理查询触发词 */
const GEO_QUERY_TRIGGERS = [
  ...GEO_SUFFIXES,
  '边界', '轮廓', '范围', '区域', '面积', '覆盖', '位置', '在哪里', '在哪里',
  '查看', '显示', '标出', '画出', '找', '查', '查询', '搜索',
];

/** 从用户输入中智能提取地名 */
export function extractPlaceNameFromInput(input: string): string | null {
  let cleaned = input
    .replace(/^(请|帮我|给我|我想|我要|来|查一下|查一查|查询一下|搜索一下|找一下)[\s,，]*/, '')
    .replace(/[\s,，]*(在哪里|在哪|的位置|的边界|的轮廓|的范围|的区域|的覆盖|的行政边界)[\s?？]*$/, '')
    .replace(/[\s,，]*(显示|标出|画出|查看)[\s,，]*/, '')
    .trim();

  for (const suffix of GEO_SUFFIXES) {
    if (cleaned.endsWith(suffix) && cleaned.length > suffix.length) {
      return cleaned;
    }
  }

  for (const suffix of GEO_SUFFIXES) {
    const idx = cleaned.indexOf(suffix);
    if (idx > 0) {
      return cleaned.substring(0, idx + suffix.length);
    }
  }

  const hasGeoIntent = GEO_QUERY_TRIGGERS.some(t => input.includes(t));
  if (hasGeoIntent && cleaned.length >= 2) {
    return cleaned;
  }

  return null;
}

/** 判断用户输入是否看起来像地理查询 */
export function looksLikeGeoQuery(input: string): boolean {
  return GEO_QUERY_TRIGGERS.some(t => input.includes(t)) ||
         GEO_SUFFIXES.some(s => input.includes(s));
}

// ====== GeoJSON 提取 & MAP 指令 ======

export function extractGeoJSONBlocks(text: string): { geojson: FeatureCollection; raw: string }[] {
  const results: { geojson: FeatureCollection; raw: string }[] = [];
  const regex = /```(?:geojson|json)\s*\n([\s\S]*?)\n```/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed.type === 'FeatureCollection' && Array.isArray(parsed.features)) {
        results.push({ geojson: parsed as FeatureCollection, raw: match[1] });
      } else if (parsed.type === 'Feature') {
        results.push({
          geojson: { type: 'FeatureCollection', features: [parsed] },
          raw: match[1],
        });
      }
    } catch { /* skip invalid */ }
  }
  return results;
}

export function extractMapActions(text: string): { action: string; params: string }[] {
  const actions: { action: string; params: string }[] = [];
  const regex = /\[MAP:(\w+):([^\]]+)\]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    actions.push({ action: match[1], params: match[2] });
  }
  return actions;
}

// ====== 字符串分词 & 图层模糊匹配 ======

/** 将字符串切为 n~m 字长滑动窗口片段 */
export function tokenize(s: string, minLen: number, maxLen: number): string[] {
  const tokens: string[] = [];
  for (let len = minLen; len <= maxLen; len++) {
    for (let i = 0; i <= s.length - len; i++) {
      tokens.push(s.slice(i, i + len));
    }
  }
  return tokens;
}

/**
 * 4 级递进模糊匹配图层名：
 * 1. 精确匹配（去除时间戳后缀）
 * 2. 图层名包含 ref
 * 3. ref 包含图层名关键词（取最长匹配）
 * 4. 双向分词重叠度匹配（2-4 字滑动窗口，重叠 ≥2 即命中）
 */
export function findLayerByName(layerRef: string): string | null {
  const { layers } = useGISStore.getState();
  const ref = layerRef.trim().toLowerCase();
  if (!ref) return null;

  // 1. 精确匹配
  for (const l of layers) {
    const cleanName = l.name.toLowerCase().replace(/_\d{2}:\d{2}:\d{2}$/, '');
    if (cleanName === ref) return l.id;
  }

  // 2. 图层名包含 ref
  for (const l of layers) {
    const cleanName = l.name.toLowerCase().replace(/_\d{2}:\d{2}:\d{2}$/, '');
    if (cleanName.includes(ref)) return l.id;
  }

  // 3. ref 包含图层名关键词（取最长匹配）
  let bestMatch: { id: string; len: number } | null = null;
  for (const l of layers) {
    const cleanName = l.name.toLowerCase().replace(/_\d{2}:\d{2}:\d{2}$/, '').replace(/[（(][^)）]*[)）]/g, '').trim();
    if (cleanName.length >= 2 && ref.includes(cleanName)) {
      if (!bestMatch || cleanName.length > bestMatch.len) {
        bestMatch = { id: l.id, len: cleanName.length };
      }
    }
  }
  if (bestMatch) return bestMatch.id;

  // 4. 双向分词匹配
  const refTokens = tokenize(ref, 2, 4);
  let bestTokenMatch: { id: string; score: number } | null = null;
  for (const l of layers) {
    const cleanName = l.name.toLowerCase().replace(/_\d{2}:\d{2}:\d{2}$/, '');
    const nameNoParen = cleanName.replace(/[（(][^)）]*[)）]/g, '').trim();
    const nameTokens = tokenize(nameNoParen, 2, 4);
    const parenMatch = cleanName.match(/[（(]([^)）]+)[)）]/);
    const parenTokens = parenMatch ? tokenize(parenMatch[1], 2, 4) : [];
    const allNameTokens = [...new Set([...nameTokens, ...parenTokens])];
    const overlap = allNameTokens.filter(t => refTokens.includes(t)).length;
    if (overlap >= 2 && (!bestTokenMatch || overlap > bestTokenMatch.score)) {
      bestTokenMatch = { id: l.id, score: overlap };
    }
  }
  if (bestTokenMatch) return bestTokenMatch.id;

  return null;
}

/** 从复合名称中提取地点+类别 */
export function parseCompoundLayerRef(ref: string): { place: string; category: string } | null {
  const patterns: { keywords: string[]; category: string }[] = [
    { keywords: ['铁路', '铁路网', '铁道', '高铁', '地铁', '轨道交通'], category: 'railway' },
    { keywords: ['水系', '河流', '湖泊', '水域', '水道', '水网', '水库', '河道'], category: 'water' },
    { keywords: ['道路', '公路', '路网', '街道', '高速', '主干道'], category: 'road' },
    { keywords: ['绿地', '公园', '森林', '林地', '绿化'], category: 'green' },
    { keywords: ['建筑', '建筑物', '房屋', '楼宇'], category: 'building' },
  ];
  for (const { keywords, category } of patterns) {
    for (const kw of keywords) {
      if (ref.endsWith(kw)) {
        const place = ref.slice(0, -kw.length);
        if (place.length >= 2) return { place, category };
      }
      if (ref.startsWith(kw)) {
        const place = ref.slice(kw.length);
        if (place.length >= 2) return { place, category };
      }
    }
  }
  return null;
}

// ====== ANALYSIS 指令 ======

export interface AnalysisCommand {
  operation: string;
  layerRef: string;
  secondLayerRef?: string;
  param?: number | string;
}

export function parseAnalysisCommands(text: string): AnalysisCommand[] {
  const cmds: AnalysisCommand[] = [];
  const regex = /\[ANALYSIS:(\w+):([^\]:]+)(?::([^\]]*))?\]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const operation = match[1];
    const layerPart = match[2];
    const paramStr = match[3];
    const layers = layerPart.split('|').map(s => s.trim());
    const cmd: AnalysisCommand = {
      operation,
      layerRef: layers[0],
      secondLayerRef: layers.length > 1 ? layers[1] : undefined,
    };
    if (paramStr) {
      const numMatch = paramStr.match(/^([\d.]+)\s*(km|公里|千米|m|米|度)?$/i);
      if (numMatch) {
        let val = parseFloat(numMatch[1]);
        if (numMatch[2] === 'm' || numMatch[2] === '米') val /= 1000;
        cmd.param = val;
      } else {
        cmd.param = paramStr;
      }
    }
    cmds.push(cmd);
  }
  return cmds;
}

export async function executeAnalysisCommand(
  cmd: AnalysisCommand
): Promise<{ description: string; geojson: FeatureCollection | null }> {
  const store = useGISStore.getState();
  const { layers, addLayer, removeLayer } = store;
  const visibleLayers = layers.filter(l => l.visible && l.data);

  const needsPolygon = ['buffer', 'convex', 'simplify', 'area', 'union', 'difference'].includes(cmd.operation);

  let layerId = findLayerByName(cmd.layerRef);

  let layerTypeOk = false;
  if (layerId) {
    const existing = store.layers.find(l => l.id === layerId);
    if (existing) {
      const isPolygonLayer = existing.type === 'polygon' || existing.type === 'geojson';
      const hasPolygonFeatures = existing.data?.features?.some(
        f => f.geometry?.type === 'Polygon' || f.geometry?.type === 'MultiPolygon'
      );
      layerTypeOk = !needsPolygon || isPolygonLayer || !!hasPolygonFeatures;
    }
  }

  const looksLikePlaceName = /[一-龥]{2,}/.test(cmd.layerRef);
  let autoFetchedData: FeatureCollection | null = null;
  let autoFetchedSecondData: FeatureCollection | null = null;

  const fetchOSMForLayer = async (ref: string): Promise<FeatureCollection | null> => {
    const compound = parseCompoundLayerRef(ref);
    if (compound) {
      try {
        const geoResults = await geocodeSearch(compound.place);
        if (geoResults.length > 0) {
          const best = geoResults[0];
          const [s, n, w, e] = best.boundingbox.map(Number);
          let qr: OSMQueryResult | null = null;
          switch (compound.category) {
            case 'railway': qr = await queryRailways([w, s, e, n]); break;
            case 'water':   qr = await queryWaterways([w, s, e, n]); break;
            case 'road':    qr = await queryRoads([w, s, e, n], 'primary'); break;
            case 'green':   qr = await queryGreenSpace([w, s, e, n]); break;
            case 'building':qr = await queryBuildings([w, s, e, n]); break;
          }
          if (qr?.geojson && qr.geojson.features.length > 0) return qr.geojson;
        }
      } catch { /* fall through */ }
    }

    const isAdmin = /[省市区县乡镇村]$/.test(ref);
    if (isAdmin) {
      const qr = await queryBoundary(ref);
      if (qr.geojson && qr.geojson.features.length > 0) return qr.geojson;
      return null;
    }
    const qr = await queryFeature(ref);
    if (!qr.geojson || qr.geojson.features.length === 0) {
      const fb = await queryFeature(ref);
      if (fb.geojson && fb.geojson.features.length > 0) return fb.geojson;
      return null;
    }
    return qr.geojson;
  };

  if ((!layerId || !layerTypeOk) && looksLikePlaceName && cmd.operation !== 'grid') {
    autoFetchedData = await fetchOSMForLayer(cmd.layerRef);
  }

  if (cmd.secondLayerRef && (cmd.operation === 'intersect' || cmd.operation === 'difference')) {
    const secondLooksLikePlace = /[一-龥]{2,}/.test(cmd.secondLayerRef);
    const secondLayerId = findLayerByName(cmd.secondLayerRef);
    if (!secondLayerId && secondLooksLikePlace) {
      autoFetchedSecondData = await fetchOSMForLayer(cmd.secondLayerRef);
    }
  }

  if (!layerId && !autoFetchedData && cmd.operation !== 'grid') {
    const available = visibleLayers.map(l => `"${l.name}"`).join(', ') || '无';
    return {
      description: `❌ 未找到图层"${cmd.layerRef}"。可用图层: ${available}`,
      geojson: null,
    };
  }

  const currentLayers = useGISStore.getState().layers;
  const layer = layerId ? currentLayers.find(l => l.id === layerId) : null;
  const fc = layer?.data || autoFetchedData;
  const sourceName = layer?.name || cmd.layerRef;
  const sourceColor = layer?.color || '#1677ff';

  try {
    switch (cmd.operation) {
      case 'buffer': {
        if (!fc) throw new Error('图层无数据');
        const radius = Number(cmd.param) || 5;
        const r = await bufferAnalysis(fc, radius);
        if (r.result) {
          addLayer({
            id: '', name: `${sourceName}_缓冲区${radius}km`, type: 'geojson', visible: true,
            color: '#ff4d4f', opacity: 0.4, data: JSON.parse(JSON.stringify(r.result)) as FeatureCollection, sourceId: '', layerId: '', createdAt: Date.now(),
          });
        }
        return { description: r.description, geojson: r.result as FeatureCollection | null };
      }

      case 'intersect': {
        const secondId = cmd.secondLayerRef ? findLayerByName(cmd.secondLayerRef) : null;
        const layer2 = secondId ? layers.find(l => l.id === secondId) : null;
        const fc2 = layer2?.data || autoFetchedSecondData;
        if (!fc || !fc2) {
          return { description: `❌ 相交分析需要两个图层。请先通过对话加载相关区域数据`, geojson: null };
        }
        const r = intersectAnalysis(fc, fc2);
        const secondName = layer2?.name || cmd.secondLayerRef || '图层2';
        if (r.result) {
          addLayer({
            id: '', name: `${sourceName}_∩_${secondName}`, type: 'geojson', visible: true,
            color: '#fa8c16', opacity: 0.5, data: r.result as FeatureCollection, sourceId: '', layerId: '', createdAt: Date.now(),
          });
        }
        return { description: r.description, geojson: r.result as FeatureCollection | null };
      }

      case 'union': {
        if (!fc) throw new Error('图层无数据');
        const r = unionAnalysis(fc);
        if (r.result) {
          addLayer({
            id: '', name: `${sourceName}_合并`, type: 'geojson', visible: true,
            color: '#52c41a', opacity: 0.4, data: r.result as FeatureCollection, sourceId: '', layerId: '', createdAt: Date.now(),
          });
        }
        return { description: r.description, geojson: r.result as FeatureCollection | null };
      }

      case 'difference': {
        const secondId = cmd.secondLayerRef ? findLayerByName(cmd.secondLayerRef) : null;
        const layer2 = secondId ? layers.find(l => l.id === secondId) : null;
        const fc2 = layer2?.data || autoFetchedSecondData;
        if (!fc || !fc2) {
          return { description: `❌ 差集分析需要两个图层（A - B）`, geojson: null };
        }
        const r = differenceAnalysis(fc, fc2);
        const secondName = layer2?.name || cmd.secondLayerRef || '图层B';
        if (r.result) {
          addLayer({
            id: '', name: `${sourceName}_减_${secondName}`, type: 'geojson', visible: true,
            color: '#eb2f96', opacity: 0.45, data: r.result as FeatureCollection, sourceId: '', layerId: '', createdAt: Date.now(),
          });
        }
        return { description: r.description, geojson: r.result as FeatureCollection | null };
      }

      case 'centroid': {
        if (!fc) throw new Error('图层无数据');
        const r = calculateCentroid(fc);
        if (r.result) {
          addLayer({
            id: '', name: `${sourceName}_中心点`, type: 'point', visible: true,
            color: '#f5222d', opacity: 0.9, data: r.result as FeatureCollection, sourceId: '', layerId: '', createdAt: Date.now(),
          });
        }
        return { description: r.description, geojson: r.result as FeatureCollection | null };
      }

      case 'area': {
        if (!fc || !fc.features[0]) throw new Error('图层无要素');
        const r = calculateArea(fc.features[0] as Feature<Polygon | MultiPolygon>);
        return { description: r.description, geojson: null };
      }

      case 'bbox': {
        if (!fc) throw new Error('图层无数据');
        const r = calculateBBox(fc);
        if (r.result) {
          addLayer({
            id: '', name: `${sourceName}_边界框`, type: 'geojson', visible: true,
            color: '#722ed1', opacity: 0.3, data: r.result as FeatureCollection, sourceId: '', layerId: '', createdAt: Date.now(),
          });
          if (layerId) removeLayer(layerId);
        }
        return { description: r.description, geojson: r.result as FeatureCollection | null };
      }

      case 'simplify': {
        if (!fc) throw new Error('图层无数据');
        const tolerance = Number(cmd.param) || 0.01;
        const r = simplifyFeatures(fc, tolerance);
        if (r.result) {
          addLayer({
            id: '', name: `${sourceName}_简化_${tolerance}`, type: 'geojson', visible: true,
            color: sourceColor, opacity: 0.6, data: r.result as FeatureCollection, sourceId: '', layerId: '', createdAt: Date.now(),
          });
        }
        return { description: r.description, geojson: r.result as FeatureCollection | null };
      }

      case 'convex': {
        if (!fc) throw new Error('图层无数据');
        const r = convexHullAnalysis(fc);
        if (r.result) {
          addLayer({
            id: '', name: `${sourceName}_凸包`, type: 'geojson', visible: true,
            color: '#eb2f96', opacity: 0.3, data: r.result as FeatureCollection, sourceId: '', layerId: '', createdAt: Date.now(),
          });
          if (layerId) removeLayer(layerId);
        }
        return { description: r.description, geojson: r.result as FeatureCollection | null };
      }

      case 'grid': {
        let bbox: [number, number, number, number];
        if (fc) {
          const fb = getFCBounds(fc);
          if (!fb) throw new Error('无法确定图层范围');
          bbox = [fb[0][0], fb[0][1], fb[1][0], fb[1][1]];
        } else {
          const ms = useGISStore.getState().mapState;
          if (!ms.bounds) throw new Error('无地图视野');
          bbox = ms.bounds;
        }
        const cellSize = Number(cmd.param) || 1;
        const r = createGrid(bbox, cellSize);
        if (r.result) {
          addLayer({
            id: '', name: `格网_${cellSize}km`, type: 'geojson', visible: true,
            color: '#13c2c2', opacity: 0.3, data: r.result as FeatureCollection, sourceId: '', layerId: '', createdAt: Date.now(),
          });
        }
        return { description: r.description, geojson: r.result as FeatureCollection | null };
      }

      case 'density': {
        if (!fc) throw new Error('图层无数据');
        const r = pointDensityAnalysis(fc);
        if (r.result) {
          addLayer({
            id: '', name: `${sourceName}_点密度`, type: 'geojson', visible: true,
            color: '#faad14', opacity: 0.5, data: r.result as FeatureCollection, sourceId: '', layerId: '', createdAt: Date.now(),
          });
          if (layerId) removeLayer(layerId);
        }
        return { description: r.description, geojson: r.result as FeatureCollection | null };
      }

      case 'distance': {
        if (!fc) throw new Error('图层无数据');
        const pts = fc.features.filter(f => f.geometry?.type === 'Point');
        if (pts.length < 2) throw new Error('需要至少2个点要素');
        const coords = pts.map(p => (p.geometry as any).coordinates as [number, number]);
        const r = measureDistance(coords);
        return { description: `📏 距离: ${r.value.toFixed(2)} ${r.unit}`, geojson: null };
      }

      case 'classify': {
        if (!fc) throw new Error('图层无数据');
        const paramStr = typeof cmd.param === 'string' ? cmd.param : '';
        if (!paramStr) throw new Error('请指定要分级的数值字段，如 [ANALYSIS:classify:图层名:admin_level]');
        const parts = paramStr.split(':');
        const field = parts[0]?.trim();
        if (!field) throw new Error('请指定要分级的数值字段');
        const rampKey = parts[1]?.trim() || '';
        const ramp = COLOR_RAMPS[rampKey] ? rampKey : 'blues';
        const { geojson, result } = applyClassification(fc, field, ramp);
        if (result.error) {
          return { description: `❌ 分层着色失败：${result.error}`, geojson: null };
        }
        if (layerId) {
          useGISStore.getState().updateLayer(layerId, { data: geojson });
        }
        const legendText = result.legend.map(l => `${l.range}`).join(' | ');
        return {
          description: `🎨 分层着色完成：按 **${field}** 分为 ${result.breaks.length} 级\n\n${legendText}`,
          geojson,
        };
      }

      case 'dbscan': {
        if (!fc) throw new Error('图层无数据');
        const eps = typeof cmd.param === 'number' ? cmd.param : 1;
        const minPts = cmd.secondLayerRef ? parseInt(cmd.secondLayerRef) : 3;
        const r = clusterDBSCAN(fc, eps, minPts);
        if (r.result) {
          addLayer({
            id: '', name: `${sourceName}_DBSCAN`, type: 'geojson', visible: true,
            color: sourceColor, opacity: 0.8, data: r.result as FeatureCollection, sourceId: '', layerId: '', createdAt: Date.now(),
          });
        }
        return { description: r.description, geojson: r.result as FeatureCollection | null };
      }

      case 'kde': {
        if (!fc) throw new Error('图层无数据');
        const bandwidth = typeof cmd.param === 'number' ? cmd.param : 1;
        const r = kernelDensityEstimation(fc, bandwidth);
        if (r.result) {
          addLayer({
            id: '', name: `${sourceName}_KDE热力图`, type: 'geojson', visible: true,
            color: '#ff4d4f', opacity: 0.6, data: r.result as FeatureCollection, sourceId: '', layerId: '', createdAt: Date.now(),
          });
        }
        return { description: r.description, geojson: r.result as FeatureCollection | null };
      }

      case 'idw': {
        if (!fc) throw new Error('图层无数据');
        const field = typeof cmd.param === 'string' ? cmd.param : '';
        if (!field) return { description: '❌ IDW 需要指定数值字段。用法: [ANALYSIS:idw:图层名:字段]', geojson: null };
        const r = interpolateIDW(fc, field);
        if (r.result) {
          addLayer({
            id: '', name: `${sourceName}_IDW(${field})`, type: 'geojson', visible: true,
            color: '#722ed1', opacity: 0.6, data: r.result as FeatureCollection, sourceId: '', layerId: '', createdAt: Date.now(),
          });
        }
        return { description: r.description, geojson: r.result as FeatureCollection | null };
      }

      case 'zonal': {
        if (!fc) throw new Error('区域图层无数据');
        const pointLayerId = cmd.secondLayerRef ? findLayerByName(cmd.secondLayerRef) : null;
        if (!pointLayerId) return { description: '❌ 分区统计需要第二个图层（点数据）。用法: [ANALYSIS:zonal:区域图层|点图层:字段]', geojson: null };
        const pointLayer = currentLayers.find(l => l.id === pointLayerId);
        if (!pointLayer?.data) return { description: `❌ 未找到点数据图层"${cmd.secondLayerRef}"`, geojson: null };
        const field = typeof cmd.param === 'string' ? cmd.param : '';
        if (!field) return { description: '❌ 分区统计需要指定数值字段。用法: [ANALYSIS:zonal:区域图层|点图层:population]', geojson: null };
        const r = zonalStatistics(fc, pointLayer.data, field);
        if (r.result) {
          addLayer({
            id: '', name: `${sourceName}_分区统计(${field})`, type: 'geojson', visible: true,
            color: sourceColor, opacity: 0.5, data: r.result as FeatureCollection, sourceId: '', layerId: '', createdAt: Date.now(),
          });
        }
        return { description: r.description, geojson: r.result as FeatureCollection | null };
      }

      default:
        return { description: `❌ 未知分析操作: ${cmd.operation}`, geojson: null };
    }
  } catch (err) {
    return {
      description: `❌ 分析失败: ${err instanceof Error ? err.message : '未知错误'}`,
      geojson: null,
    };
  }
}

// ====== LOCAL 文件加载 ======

export function parseLocalFileCommands(text: string): string[] {
  const files: string[] = [];
  const regex = /\[LOCAL:([^\]]+)\]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    files.push(match[1].trim());
  }
  return files;
}

export async function executeLocalFileCommand(
  filename: string
): Promise<{ description: string; geojson: FeatureCollection | null }> {
  try {
    const url = `/${encodeURIComponent(filename)}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      return { description: `❌ 文件 "${filename}" 不存在或无法访问 (HTTP ${resp.status})`, geojson: null };
    }
    const data = await resp.json();

    let fc: FeatureCollection;
    if (data.type === 'FeatureCollection') {
      fc = data as FeatureCollection;
    } else if (data.type === 'Feature') {
      fc = { type: 'FeatureCollection', features: [data as Feature] };
    } else if (data.features && Array.isArray(data.features)) {
      fc = { type: 'FeatureCollection', features: data.features };
    } else {
      return { description: `❌ 文件 "${filename}" 不是有效的 GeoJSON 格式`, geojson: null };
    }

    const { addLayer } = useGISStore.getState();
    const colors = ['#1677ff', '#52c41a', '#fa8c16', '#f5222d', '#722ed1', '#13c2c2'];
    addLayer({
      id: '',
      name: filename.replace(/\.(geojson|json)$/i, ''),
      type: 'geojson',
      visible: true,
      color: colors[Math.floor(Math.random() * colors.length)],
      opacity: 0.6,
      data: fc,
      sourceId: '',
      layerId: '',
      createdAt: Date.now(),
    });

    const types = new Set(fc.features.map(f => f.geometry?.type).filter(Boolean));
    return {
      description: `✅ 已加载本地文件 "${filename}"：${fc.features.length} 个要素（${[...types].join(', ')}）`,
      geojson: fc,
    };
  } catch (err) {
    return {
      description: `❌ 加载本地文件失败: ${err instanceof Error ? err.message : '格式错误'}`,
      geojson: null,
    };
  }
}

// ====== ROUTE 路径规划 ======

export interface RouteCommand {
  from: string;
  to: string;
  mode: TravelMode;
}

export function parseRouteCommands(text: string): RouteCommand[] {
  const cmds: RouteCommand[] = [];
  const regex = /\[ROUTE:([^:]+):([^:\]]+)(?::([^\]]*))?\]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const from = match[1].trim();
    const to = match[2].trim();
    const modeStr = (match[3] || 'driving').trim().toLowerCase();
    const mode: TravelMode =
      modeStr === 'walking' || modeStr === '步行' ? 'walking'
      : modeStr === 'cycling' || modeStr === '骑行' || modeStr === 'bicycle' ? 'cycling'
      : modeStr === 'flying' || modeStr === '飞行' || modeStr === 'fly' ? 'flying'
      : 'driving';
    cmds.push({ from, to, mode });
  }
  return cmds;
}

export async function executeRouteCommand(
  cmd: RouteCommand
): Promise<{ description: string; geojson: FeatureCollection | null; routeResult: RouteResult | null }> {
  const mapCenter = useGISStore.getState().mapState.center;
  const result = await planRoute(cmd.from, cmd.to, cmd.mode, mapCenter as [number, number]);

  if (!result.success || !result.geojson) {
    return { description: `❌ ${result.error || '路径规划失败'}`, geojson: null, routeResult: null };
  }

  const { addLayer } = useGISStore.getState();
  const modeColors: Record<string, string> = {
    driving: '#1677ff',
    walking: '#52c41a',
    cycling: '#fa8c16',
    flying: '#e040fb',
  };

  addLayer({
    id: '',
    name: `${cmd.from} → ${cmd.to}`,
    type: 'geojson',
    visible: true,
    color: modeColors[cmd.mode] || '#1677ff',
    opacity: 0.85,
    data: result.geojson,
    sourceId: '',
    layerId: '',
    createdAt: Date.now(),
  });

  const bounds = getRouteBounds(result.geojson);
  if (bounds) {
    const startMarker: FeatureCollection = {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: { type: 'Point', coordinates: result.geojson.features[0]?.geometry?.type === 'LineString'
          ? (result.geojson.features[0].geometry as any).coordinates[0]
          : bounds[0] },
        properties: { name: `起点: ${cmd.from}`, type: 'start' },
      }],
    };
    const endMarker: FeatureCollection = {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: { type: 'Point', coordinates: result.geojson.features[0]?.geometry?.type === 'LineString'
          ? (result.geojson.features[0].geometry as any).coordinates[(result.geojson.features[0].geometry as any).coordinates.length - 1]
          : bounds[1] },
        properties: { name: `终点: ${cmd.to}`, type: 'end' },
      }],
    };

    addLayer({
      id: '', name: `起点: ${cmd.from}`, type: 'point', visible: true,
      color: '#52c41a', opacity: 0.9, data: startMarker,
      sourceId: '', layerId: '', createdAt: Date.now(),
    });
    addLayer({
      id: '', name: `终点: ${cmd.to}`, type: 'point', visible: true,
      color: '#f5222d', opacity: 0.9, data: endMarker,
      sourceId: '', layerId: '', createdAt: Date.now(),
    });
  }

  return { description: result.description, geojson: result.geojson, routeResult: result };
}

// ====== QUERY 自然语言筛选 ======

export interface QueryCommand {
  layerRef: string;
  condition: string;
}

export function parseQueryCommands(text: string): QueryCommand[] {
  const cmds: QueryCommand[] = [];
  const regex = /\[QUERY:([^:]+):([^\]]+)\]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    cmds.push({ layerRef: match[1].trim(), condition: match[2].trim() });
  }
  return cmds;
}

export async function executeQueryCommand(
  cmd: QueryCommand
): Promise<{ description: string; geojson: FeatureCollection | null }> {
  const store = useGISStore.getState();
  const layerId = findLayerByName(cmd.layerRef);
  if (!layerId) {
    const available = store.layers.filter(l => l.visible && l.data).map(l => `"${l.name}"`).join(', ') || '无';
    return { description: `❌ 未找到图层"${cmd.layerRef}"。可用: ${available}`, geojson: null };
  }

  const layer = store.layers.find(l => l.id === layerId);
  if (!layer?.data) return { description: `❌ 图层"${layer?.name || cmd.layerRef}"无数据`, geojson: null };

  const fields = getQueryableFields(layer.data);
  const condition = parseNLQuery(cmd.condition, fields);
  if (!condition) {
    return { description: `❌ 无法理解筛选条件"${cmd.condition}"。可用字段: ${fields.slice(0, 8).join(', ')}`, geojson: null };
  }

  const result = execQuery(layer.data, condition);

  if (result.result && result.result.features.length > 0) {
    store.addLayer({
      id: '', name: `${layer.name}_筛选:${cmd.condition}`, type: 'geojson', visible: true,
      color: '#eb2f96', opacity: 0.8, data: result.result, sourceId: '', layerId: '', createdAt: Date.now(),
    });
  }

  return { description: result.description, geojson: result.result };
}

// ====== HAZARD 灾害数据 ======

export interface HazardCommand {
  type: 'earthquake' | 'elevation' | 'dem' | 'weather';
  param?: string;
}

export function parseHazardCommands(text: string): HazardCommand[] {
  const cmds: HazardCommand[] = [];
  const regex = /\[HAZARD:(\w+)(?::([^\]]*))?\]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const type = match[1] as HazardCommand['type'];
    cmds.push({ type, param: match[2] || undefined });
  }
  return cmds;
}

export async function executeHazardCommand(cmd: HazardCommand): Promise<{
  description: string;
  geojson: FeatureCollection | null;
}> {
  const store = useGISStore.getState();
  const bounds = store.mapState.bounds;
  if (!bounds) return { description: '⚠️ 地图尚未加载', geojson: null };

  switch (cmd.type) {
    case 'earthquake': {
      const minMag = cmd.param ? parseFloat(cmd.param) : 3.0;
      const result = await queryEarthquakes({
        bbox: [bounds[0], bounds[1], bounds[2], bounds[3]],
        minMagnitude: isNaN(minMag) ? 3.0 : minMag,
        days: 90,
      });
      if (result.geojson) {
        const { addLayer } = store;
        addLayer({
          id: '', name: `地震数据_M≥${isNaN(minMag) ? 3.0 : minMag}`,
          type: 'geojson', visible: true,
          color: '#ff6d00', opacity: 0.8,
          data: result.geojson,
          sourceId: '', layerId: '', createdAt: Date.now(),
        });
      }
      return { description: result.description, geojson: result.geojson };
    }
    case 'elevation': {
      if (!store.terrain3dEnabled) {
        window.dispatchEvent(new CustomEvent('toggle-3d-terrain', { detail: { enabled: true } }));
        await new Promise(r => setTimeout(r, 3000));
        if (!useGISStore.getState().terrain3dEnabled) {
          return { description: '⚠️ 3D地形开启失败，请手动点击顶部工具栏的3D按钮', geojson: null };
        }
      }
      return new Promise((resolve) => {
        const handler = (e: Event) => {
          window.removeEventListener('elevation-grid-result', handler);
          const grid = (e as CustomEvent).detail as { lng: number; lat: number; elevation: number | null }[] | null;
          if (!grid || grid.length === 0) {
            resolve({ description: '⚠️ 高程采样失败，请确认3D地形已加载完成', geojson: null });
            return;
          }
          const contourInterval = Number(cmd.param) || 100;
          const contours = generateContours(grid, contourInterval);
          const labels = generateElevationLabels(grid);
          const { addLayer } = store;

          if (contours && contours.features.length > 0) {
            addLayer({
              id: '', name: `等高线 ${contourInterval}m`,
              type: 'geojson', visible: true,
              color: '#8B4513', opacity: 0.7,
              data: contours,
              sourceId: '', layerId: '', createdAt: Date.now(),
            });
          }

          if (labels) {
            addLayer({
              id: '', name: `高程极值点`,
              type: 'point', visible: true,
              color: '#ff0000', opacity: 1,
              data: labels,
              sourceId: '', layerId: '', createdAt: Date.now(),
            });
          }

          const elevs = grid.filter(p => p.elevation != null).map(p => p.elevation!) as number[];
          const min = Math.round(Math.min(...elevs));
          const max = Math.round(Math.max(...elevs));
          const contourCount = contours?.features?.length || 0;
          resolve({
            description: `🏔️ 等高线完成：${contourCount} 条等高线 (间距${contourInterval}m)，海拔 ${min}m ~ ${max}m`,
            geojson: contours || labels,
          });
        };
        window.addEventListener('elevation-grid-result', handler);
        window.dispatchEvent(new CustomEvent('query-elevation-grid', { detail: { resolution: 40 } }));
        setTimeout(() => {
          window.removeEventListener('elevation-grid-result', handler);
          resolve({ description: '⚠️ 高程采样超时，请确认3D地形已加载', geojson: null });
        }, 5000);
      });
    }
    case 'dem': {
      const demParam = cmd.param || '';
      const colonIdx = demParam.lastIndexOf(':');
      const placeName = colonIdx >= 0 ? demParam.substring(0, colonIdx) : demParam;
      const demInterval = colonIdx >= 0 ? Number(demParam.substring(colonIdx + 1)) : 100;

      if (!placeName) {
        return { description: '❌ 请指定地区名称，如"天津市"、"武汉市"', geojson: null };
      }

      const gaode = await gaodeGeocode(placeName);
      if (!gaode.geojson || gaode.geojson.features.length === 0) {
        return { description: `❌ 未找到"${placeName}"的地理位置，请确认地名是否正确`, geojson: null };
      }
      const geom: any = gaode.geojson.features[0].geometry;
      const coords = geom?.coordinates as [number, number] | undefined;
      if (!coords || coords.length < 2) {
        return { description: `❌ 无法解析"${placeName}"的坐标`, geojson: null };
      }

      const targetZoom = 11;
      store.setMapState({ center: coords, zoom: targetZoom });
      window.dispatchEvent(new CustomEvent('fly-to', { detail: { center: coords, zoom: targetZoom } }));

      await new Promise(r => setTimeout(r, 1500));

      if (!useGISStore.getState().terrain3dEnabled) {
        window.dispatchEvent(new CustomEvent('toggle-3d-terrain', { detail: { enabled: true } }));
        await new Promise(r => setTimeout(r, 4000));
        if (!useGISStore.getState().terrain3dEnabled) {
          return { description: '⚠️ 3D地形开启失败，请手动点击顶部工具栏的3D按钮后重试', geojson: null };
        }
      }

      const demBounds: [number, number, number, number] =
        bounds && bounds[2] - bounds[0] > 0
          ? [bounds[0], bounds[1], bounds[2], bounds[3]]
          : [coords[0] - 0.5, coords[1] - 0.3, coords[0] + 0.5, coords[1] + 0.3];

      return new Promise((resolve) => {
        const handler = (e: Event) => {
          window.removeEventListener('elevation-grid-result', handler);
          const grid = (e as CustomEvent).detail as { lng: number; lat: number; elevation: number | null }[] | null;
          if (!grid || grid.length === 0) {
            resolve({ description: '⚠️ DEM高程采样失败，请确认3D地形已加载', geojson: null });
            return;
          }
          const contours = generateContours(grid, demInterval);
          const labels = generateElevationLabels(grid);
          const { addLayer } = useGISStore.getState();

          if (contours && contours.features.length > 0) {
            addLayer({
              id: '', name: `${placeName}等高线 ${demInterval}m`,
              type: 'geojson', visible: true,
              color: '#8B4513', opacity: 0.7,
              data: contours,
              sourceId: '', layerId: '', createdAt: Date.now(),
            });
          }
          if (labels) {
            addLayer({
              id: '', name: `${placeName}极值点`,
              type: 'point', visible: true,
              color: '#ff0000', opacity: 1,
              data: labels,
              sourceId: '', layerId: '', createdAt: Date.now(),
            });
          }

          const elevs = grid.filter(p => p.elevation != null).map(p => p.elevation!) as number[];
          const min = Math.round(Math.min(...elevs));
          const max = Math.round(Math.max(...elevs));
          const contourCount = contours?.features?.length || 0;

          // 组装 DEM GeoJSON 并下载
          const demFeatures: any[] = [];
          if (contours) demFeatures.push(...contours.features);
          if (labels) demFeatures.push(...labels.features.map(f => ({ ...f, properties: { ...f.properties, _type: 'peak_or_valley' } })));
          grid.filter(p => p.elevation != null).forEach(p => {
            demFeatures.push({
              type: 'Feature',
              geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
              properties: { elevation: Math.round(p.elevation!), _type: 'sample' },
            });
          });

          const demGeoJSON = {
            type: 'FeatureCollection',
            properties: {
              name: `${placeName} DEM数据`,
              interval: demInterval,
              elevationRange: [min, max],
              generated: new Date().toISOString(),
            },
            features: demFeatures,
          };

          const blob = new Blob([JSON.stringify(demGeoJSON, null, 2)], { type: 'application/geo+json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `${placeName}_DEM_${demInterval}m.geojson`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);

          resolve({
            description: `🏔️ ${placeName} DEM数据完成：${contourCount} 条等高线 (间距${demInterval}m)，海拔 ${min}m ~ ${max}m\n📥 GeoJSON 已自动下载到本地`,
            geojson: contours || labels,
          });
        };
        window.addEventListener('elevation-grid-result', handler);
        window.dispatchEvent(new CustomEvent('query-elevation-grid', { detail: { resolution: 40 } }));
        setTimeout(() => {
          window.removeEventListener('elevation-grid-result', handler);
          resolve({ description: '⚠️ DEM采样超时，请确认3D地形已加载', geojson: null });
        }, 8000);
      });
    }
    case 'weather': {
      const center = store.mapState.center;
      const lat = center[1];
      const lng = center[0];
      const result = await queryWeather(lat, lng);
      return { description: result.description, geojson: null };
    }
    default:
      return { description: `⚠️ 未知灾害查询类型: ${cmd.type}`, geojson: null };
  }
}

// ====== OSM 命令执行包装器 ======

export async function executeOSMCommandWrapper(
  cmd: ReturnType<typeof parseOSMCommands>[0],
  cmdKey: string
): Promise<{ osmResult: { label?: string; geojson?: FeatureCollection | null; description?: string; error?: string } | null }> {
  const store = useGISStore.getState();
  try {
    const { result, bbox } = await executeOSMCommand(cmd, store.mapState.bounds);
    if (result.geojson && result.geojson.features.length > 0) {
      const colors = ['#1677ff', '#52c41a', '#fa8c16', '#f5222d', '#722ed1', '#13c2c2'];
      store.addLayer({
        id: '', name: `${result.label}_${new Date().toLocaleTimeString()}`, type: 'geojson', visible: true,
        color: colors[Math.floor(Math.random() * colors.length)], opacity: 0.6,
        data: result.geojson, sourceId: '', layerId: '', createdAt: Date.now(),
      });
    }
    return {
      osmResult: { label: result.label, geojson: result.geojson, description: result.description, error: (result as any).error }
    };
  } catch (err) {
    return {
      osmResult: { label: cmd.params, geojson: null, description: '查询异常', error: err instanceof Error ? err.message : '未知错误' }
    };
  }
}

// ====== 空间上下文构建 ======

export function buildSpatialContext(
  mapState: { center: [number, number]; zoom: number; bounds: [number, number, number, number] | null },
  layers: Array<{ name: string; visible: boolean; data?: FeatureCollection | null; type?: string }>
): string {
  const parts: string[] = [];
  parts.push(`地图中心: [${mapState.center[0].toFixed(6)}, ${mapState.center[1].toFixed(6)}]`);
  parts.push(`缩放级别: ${mapState.zoom.toFixed(1)}`);

  if (mapState.bounds) {
    const [w, s, e, n] = mapState.bounds;
    parts.push(`视野范围(WGS84): [${w.toFixed(6)}, ${s.toFixed(6)}] 到 [${e.toFixed(6)}, ${n.toFixed(6)}]`);
    const latMid = (s + n) / 2;
    const degToKm = 111.32 * Math.cos((latMid * Math.PI) / 180);
    parts.push(`视野约 ${((e - w) * degToKm).toFixed(1)}km × ${((n - s) * 111.32).toFixed(1)}km`);
  }

  const visibleLayers = layers.filter((l) => l.visible && l.data);
  if (visibleLayers.length > 0) {
    parts.push(`可见图层 (共${visibleLayers.length}个):`);
    for (const l of visibleLayers) {
      const geomTypes = new Set(l.data?.features?.map(f => f.geometry?.type) || []);
      const geomStr = [...geomTypes].join(',') || '无';
      const numFields = l.data ? findNumericFields(l.data) : [];
      const hasPoints = geomTypes.has('Point') || geomTypes.has('MultiPoint');
      const hasLines = geomTypes.has('LineString') || geomTypes.has('MultiLineString');
      const hasPolys = geomTypes.has('Polygon') || geomTypes.has('MultiPolygon');
      const fieldInfo = numFields.length > 0
        ? ` | 📐数值字段: ${numFields.join(', ')}`
        : ' | ⚠️无数值字段（不可做zonal/density/idw）';
      const canDo = [];
      if (hasPoints) canDo.push('density/kde/dbscan/idw');
      if (hasPolys) canDo.push('buffer/area/intersect');
      if (hasLines) canDo.push('buffer/simplify');
      const canStr = canDo.length > 0 ? ` | ✅可分析: ${canDo.join(',')}` : '';
      parts.push(`  · "${l.name}" — ${geomStr} (${l.data?.features?.length || 0}个)${fieldInfo}${canStr}`);
    }
  }

  return parts.join('\n');
}
