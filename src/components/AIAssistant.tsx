import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  Input,
  Button,
  Typography,
  Space,
  Avatar,
  Tag,
  Spin,
  message,
  Empty,
  Tooltip,
  Card,
  Divider,
} from 'antd';
import {
  SendOutlined,
  RobotOutlined,
  ClearOutlined,
  ThunderboltOutlined,
  CopyOutlined,
  EnvironmentOutlined,
  AimOutlined,
  LoadingOutlined,
  PlusSquareOutlined,
  DownloadOutlined,
  DatabaseOutlined,
  GlobalOutlined,
} from '@ant-design/icons';
import { useGISStore } from '../store/useGISStore';
import { chatWithDeepSeekProxy, chatWithDeepSeekStream } from '../services/deepseek';
import {
  parseOSMCommands, executeOSMCommand,
  queryFeature, queryBoundary, queryWaterways, queryRoads,
  queryGreenSpace, queryBuildings, queryRailways, queryRailwaysInPlaceName,
  geocodeSearch,
} from '../services/osmService';
import type { OSMCommand, OSMQueryResult } from '../services/osmService';
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
  measureArea,
  createGrid,
  pointDensityAnalysis,
} from '../services/spatialAnalysis';
import { applyClassification, COLOR_RAMPS, findNumericFields } from '../services/classification';
import type { ChatMessage } from '../types';
import type { FeatureCollection, Feature, Polygon, MultiPolygon } from 'geojson';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { planRoute, getRouteBounds } from '../services/routingService';
import type { RouteResult, TravelMode } from '../services/routingService';
import { flattenCoords, getFCBounds } from '../utils/geo';

const { Text } = Typography;

// ====== 系统提示词 ======

const GEOJSON_INSTRUCTION = `
## 地图交互能力 —— 指令参考

你是 GIS 助手，能通过指令直接操作地图。请严格遵守以下规则。

### 决策树：根据用户语境选择正确的指令

**第1步：判断用户在问什么类型的地理事物？**
├─ ⚠️ 专有名词（XX大学、XX学院、XX公司、XX医院...）→ 用 [OSM:feature:全名]  精确查该实体！
│   ├─ "武汉大学" → [OSM:feature:武汉大学]   ← 专有名词！不是"武汉的大学"！
│   ├─ "中国地质大学" → [OSM:feature:中国地质大学]
│   ├─ "清华大学" → [OSM:feature:清华大学]
│   └─ "XX大学"/"XX学院"/"XX中学"/"XX医院" 只要没有"的"字就是专有名词！
├─ 行政区（省、市、区、县、乡、村） → 用 [OSM:boundary:地名] 或 [OSM:outline:地名]
├─ 自然地物（沙漠、山脉、高原、平原、盆地、湖泊、河流、森林、冰川、湿地、岛屿、半岛、海湾） → 用 [OSM:feature:地名] 或 [OSM:outline:地名]
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
| "武汉大学" | [OSM:feature:武汉大学] | 专有名词→精确查 |
| "中国地质大学" | [OSM:feature:中国地质大学] | 专有名词→精确查 |
| "清华大学" | [OSM:feature:清华大学] | 专有名词→精确查 |
| "武汉的大学" | [OSM:poi-in:武汉市:university] | 地名+"的"+内容→范围查 |
| "附近的餐厅" | [OSM:poi:restaurant] | 没地名→视野查 |
| "对北京市做10km缓冲区" | [OSM:boundary:北京市]\n[ANALYSIS:buffer:北京市:10km] | 先查数据→再分析 |
| "计算武汉的面积" | [OSM:boundary:武汉市]\n[ANALYSIS:area:武汉市] | 先查数据→再分析 |
| "南京3公里缓冲区" | [OSM:boundary:南京市]\n[ANALYSIS:buffer:南京市:3km] | 先查数据→再分析 |
| "北京市各区县" / "北京有哪些区" | [OSM:districts:北京市] | 每个区县不同颜色！ |
| "邯郸的河流" / "武汉的水系" | [OSM:water-in:邯郸市] | 查该区域内的河流、湖泊 |
| "北京的铁路" / "上海铁路网" | [OSM:railways-in:北京市] | 查该区域内的铁路线 |
| "天津道路和铁路" | [OSM:roads-in:天津市:primary]\n[OSM:railways-in:天津市] | 道路和铁路分别查 |

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
\`\`\`

⚠️ 图层名用模糊匹配（如"武汉市"可匹配"武汉市(地级市)_14:30:25"）
   半径默认单位是 km，支持 m 后缀（如 500m）
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
[MAP:zoomTo:lng,lat,zoom]  [MAP:addMarker:lng,lat,名称]  [MAP:fitBounds:w,s,e,n]

### 时空分析指令
\`\`\`
[SPACETIME:simulate:场景:年份:点数]   — 生成模拟时空数据进行立方体分析
\`\`\`
当用户提到"时空分析"、"时空立方体"、"热点分析"、"空间分布随时间变化"等时，
告知用户：可以在左侧面板"时空立方体"中上传 CSV 数据，或使用模拟数据按钮。

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

const SYSTEM_PROMPT = `你是 GIS Claude，专业的地理信息系统智能助手，具备真实地图数据查询能力。

你精通：空间分析、GIS理论、坐标系与投影、PostGIS、Turf.js、MapLibre GL JS、GeoPandas、制图与可视化。

你非常擅长理解中文地理语境：
- "边界/轮廓" = 线 → outline
- "区域/范围/面积" = 面 → boundary/feature
- 自然地理术语：平原、高原、盆地、沙漠、山脉、湖泊、河流、森林、冰川、湿地、岛屿、半岛、海湾 → 用 feature

${GEOJSON_INSTRUCTION}

请用中文回答。回答要专业、准确、实用。关键是：涉及真实地理数据时，用 [OSM:...] 指令查询，不要凭空编造坐标。`;

// ====== 快速提示词 ======

const QUICK_PROMPTS = [
  { icon: '🗺️', label: '查行政区边界', prompt: '帮我查询北京市海淀区的行政边界' },
  { icon: '🍽️', label: '查周边餐厅', prompt: '查询当前地图视野内有哪些餐厅' },
  { icon: '🏫', label: '查武汉的大学', prompt: '查找武汉市的大学' },
  { icon: '🏗️', label: '查北京的建筑物', prompt: '查询北京市朝阳区的建筑物分布' },
  { icon: '💧', label: '查杭州水系', prompt: '查询杭州市的河流和湖泊' },
  { icon: '🌳', label: '查上海公园', prompt: '查询上海市的公园和绿地' },
];

// ====== Helpers ======

// 中文地理要素后缀词（用于从用户输入中提取地名）
const GEO_SUFFIXES = [
  '沙漠', '平原', '高原', '盆地', '山脉', '丘陵', '草原', '沼泽', '戈壁',
  '湖泊', '海洋', '河流', '森林', '冰川', '湿地', '绿洲', '岛屿', '半岛', '海湾', '河谷', '礁石',
  '省', '市', '区', '县', '乡', '镇', '村',
  '行政区', '自治区', '特别行政区',
];

// 常见的地理查询触发词
const GEO_QUERY_TRIGGERS = [
  ...GEO_SUFFIXES,
  '边界', '轮廓', '范围', '区域', '面积', '覆盖', '位置', '在哪里', '在哪里',
  '查看', '显示', '标出', '画出', '找', '查', '查询', '搜索',
];

/** 从用户输入中智能提取地名（用于 AI 忘记生成指令时自动补偿） */
function extractPlaceNameFromInput(input: string): string | null {
  // 去除常见的问句前缀
  let cleaned = input
    .replace(/^(请|帮我|给我|我想|我要|来|查一下|查一查|查询一下|搜索一下|找一下)[\s,，]*/, '')
    .replace(/[\s,，]*(在哪里|在哪|的位置|的边界|的轮廓|的范围|的区域|的覆盖|的行政边界)[\s?？]*$/, '')
    .replace(/[\s,，]*(显示|标出|画出|查看)[\s,，]*/, '')
    .trim();

  // 如果清理后的文本以地理要素后缀结尾，这就是一个完整地名
  for (const suffix of GEO_SUFFIXES) {
    if (cleaned.endsWith(suffix) && cleaned.length > suffix.length) {
      return cleaned;
    }
  }

  // 如果清理后的文本包含地理后缀，提取"名称+后缀"组合
  for (const suffix of GEO_SUFFIXES) {
    const idx = cleaned.indexOf(suffix);
    if (idx > 0) {
      // 找到后缀前面的部分作为地名
      return cleaned.substring(0, idx + suffix.length);
    }
  }

  // 纯地名（无后缀）：如"武汉"、"北京"
  // 检查是否包含地理查询触发词
  const hasGeoIntent = GEO_QUERY_TRIGGERS.some(t => input.includes(t));
  if (hasGeoIntent && cleaned.length >= 2) {
    return cleaned;
  }

  return null;
}

/** 判断用户输入是否看起来像地理查询 */
function looksLikeGeoQuery(input: string): boolean {
  return GEO_QUERY_TRIGGERS.some(t => input.includes(t)) ||
         GEO_SUFFIXES.some(s => input.includes(s));
}

function extractGeoJSONBlocks(text: string): { geojson: FeatureCollection; raw: string }[] {
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

function extractMapActions(text: string): { action: string; params: string }[] {
  const actions: { action: string; params: string }[] = [];
  const regex = /\[MAP:(\w+):([^\]]+)\]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    actions.push({ action: match[1], params: match[2] });
  }
  return actions;
}

// ====== ANALYSIS 指令解析与执行 ======

interface AnalysisCommand {
  operation: string;
  layerRef: string;
  secondLayerRef?: string;
  param?: number | string;  // 数值参数(半径) 或 字符串参数(字段名)
}

/** 解析 [ANALYSIS:operation:layerName:param] 指令 */
function parseAnalysisCommands(text: string): AnalysisCommand[] {
  const cmds: AnalysisCommand[] = [];
  const regex = /\[ANALYSIS:(\w+):([^\]:]+)(?::([^\]]*))?\]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const operation = match[1];
    const layerPart = match[2];
    const paramStr = match[3];

    // 检查是否为双图层操作
    const layers = layerPart.split('|').map(s => s.trim());
    const cmd: AnalysisCommand = {
      operation,
      layerRef: layers[0],
      secondLayerRef: layers.length > 1 ? layers[1] : undefined,
    };

    // 解析参数：优先数字（带单位），否则保留为字符串
    if (paramStr) {
      const numMatch = paramStr.match(/^([\d.]+)\s*(km|公里|千米|m|米|度)?$/i);
      if (numMatch) {
        let val = parseFloat(numMatch[1]);
        if (numMatch[2] === 'm' || numMatch[2] === '米') val /= 1000;
        cmd.param = val;
      } else {
        cmd.param = paramStr; // 字符串参数（如 classify 的字段名）
      }
    }

    cmds.push(cmd);
  }
  return cmds;
}

/** 模糊匹配图层名（按精确度排序，返回最佳匹配） */
function findLayerByName(layerRef: string): string | null {
  const { layers } = useGISStore.getState();
  const ref = layerRef.trim().toLowerCase();
  if (!ref) return null;

  // 1. 精确匹配（去除时间戳后缀后比较）
  for (const l of layers) {
    const cleanName = l.name.toLowerCase().replace(/_\d{2}:\d{2}:\d{2}$/, '');
    if (cleanName === ref) return l.id;
  }

  // 2. 图层名精确包含 ref（如 "武汉市(地级市)" 包含 "武汉"）
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

  // 4. 双向分词匹配：拆成 2-4 字片段，检查重叠度
  //    例如 ref="武汉市铁路网" → tokens=["武汉","汉市","武汉市","市铁","铁路","路网","铁路网"...]
  //    图层名 "铁路网 (武汉市, 湖北省)" → keywords=["铁路网","武汉市","湖北","湖北省"]
  const refTokens = tokenize(ref, 2, 4);
  let bestTokenMatch: { id: string; score: number } | null = null;
  for (const l of layers) {
    const cleanName = l.name.toLowerCase().replace(/_\d{2}:\d{2}:\d{2}$/, '');
    // 从图层名提取关键词（去括号内容也保留，分开匹配；trim 去括号前后的空格）
    const nameNoParen = cleanName.replace(/[（(][^)）]*[)）]/g, '').trim();
    const nameTokens = tokenize(nameNoParen, 2, 4);
    // 也提取括号内的内容作为关键词
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

/** 将字符串切为 n~m 字长的滑动窗口片段 */
function tokenize(s: string, minLen: number, maxLen: number): string[] {
  const tokens: string[] = [];
  for (let len = minLen; len <= maxLen; len++) {
    for (let i = 0; i <= s.length - len; i++) {
      tokens.push(s.slice(i, i + len));
    }
  }
  return tokens;
}

/** 执行单个 ANALYSIS 指令 */
async function executeAnalysisCommand(
  cmd: AnalysisCommand
): Promise<{ description: string; geojson: FeatureCollection | null }> {
  const store = useGISStore.getState();
  const { layers, addLayer, removeLayer } = store;
  const visibleLayers = layers.filter(l => l.visible && l.data);

  // 需要面状数据的操作
  const needsPolygon = ['buffer', 'convex', 'simplify', 'area', 'union', 'difference'].includes(cmd.operation);

  let layerId = findLayerByName(cmd.layerRef);

  // 检查已有图层类型是否合适（例：buffer需要面，但图层是点→不合适）
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

  // 自动补偿：图层不存在时尝试从 OSM 查询
  // 数据直接注入后续分析，不添加为独立图层（避免产生多余中间图层）
  const looksLikePlaceName = /[一-龥]{2,}/.test(cmd.layerRef);
  let autoFetchedData: FeatureCollection | null = null;
  let autoFetchedSecondData: FeatureCollection | null = null; // 双图层操作(如intersect)的第二个图层

  const fetchOSMForLayer = async (ref: string): Promise<FeatureCollection | null> => {
    // 尝试从复合名称中拆解地点+类型（如"武汉市铁路网"→地点"武汉市", 类型"铁路"）
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
      } catch { /* 复合查询失败，继续回退 */ }
    }

    // 回退：当作普通地名/要素查询
    const isAdmin = /[省市区县乡镇村]$/.test(ref);
    if (isAdmin) {
      // 行政区划：只用 boundary 查询，不回退到 feature（会查到不相干的 POI）
      const qr = await queryBoundary(ref);
      if (qr.geojson && qr.geojson.features.length > 0) return qr.geojson;
      return null;
    }
    const qr = await queryFeature(ref);
    if (!qr.geojson || qr.geojson.features.length === 0) {
      // 非行政区但可能是自然地物，尝试不同查询方式
      const fb = await queryFeature(ref);
      if (fb.geojson && fb.geojson.features.length > 0) return fb.geojson;
      return null;
    }
    return qr.geojson;
  };

  /** 从复合名称中提取地点+类别，如"武汉市铁路网"→{place:"武汉市", category:"railway"} */
  function parseCompoundLayerRef(ref: string): { place: string; category: string } | null {
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

  if ((!layerId || !layerTypeOk) && looksLikePlaceName && cmd.operation !== 'grid') {
    autoFetchedData = await fetchOSMForLayer(cmd.layerRef);
  }

  // 双图层操作：第二个图层也需要补偿
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

  // 重新从 store 获取最新 state（优先用已有图层，回退到自动获取的数据）
  const currentLayers = useGISStore.getState().layers;
  const layer = layerId ? currentLayers.find(l => l.id === layerId) : null;
  const fc = layer?.data || autoFetchedData;
  const sourceName = layer?.name || cmd.layerRef;
  const sourceColor = layer?.color || '#1677ff';

  try {
    switch (cmd.operation) {
      case 'buffer': {
        if (!fc) throw new Error('图层无数据');
        const radius = Number(cmd.param) || 5; // 默认 5km
        const r = await bufferAnalysis(fc, radius);
        if (r.result) {
          addLayer({
            id: '', name: `${sourceName}_缓冲区${radius}km`, type: 'geojson', visible: true,
            color: '#ff4d4f', opacity: 0.4, data: JSON.parse(JSON.stringify(r.result)) as FeatureCollection, sourceId: '', layerId: '', createdAt: Date.now(),
          });
          // 保留原图层，让用户同时看到源数据和缓冲区
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
          // 保留两个源图层，叠加相交结果供对比
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
          // 保留原图层，叠加合并结果供对比
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
          // 保留源图层，叠加差集结果供对比
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
        // 格网：基于图层bbox或手动指定参数
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
        const cellSize = Number(cmd.param) || 1; // 默认 1km
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
        const rampName = COLOR_RAMPS[ramp]?.name || ramp;
        if (layerId) {
          useGISStore.getState().updateLayer(layerId, { data: geojson });
        }
        const legendText = result.legend.map(l => `${l.range}`).join(' | ');
        return {
          description: `🎨 分层着色完成：按 **${field}** 分为 ${result.breaks.length} 级（${rampName}）\n\n${legendText}`,
          geojson,
        };
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

// ====== LOCAL 文件加载指令 ======

/** 解析 [LOCAL:文件名] 指令 */
function parseLocalFileCommands(text: string): string[] {
  const files: string[] = [];
  const regex = /\[LOCAL:([^\]]+)\]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    files.push(match[1].trim());
  }
  return files;
}

/** 加载本地 GeoJSON/JSON 文件 */
async function executeLocalFileCommand(
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

// ====== ROUTE 路径规划指令 ======

interface RouteCommand {
  from: string;
  to: string;
  mode: TravelMode;
}

/** 解析 [ROUTE:起点:终点:方式] 指令 */
function parseRouteCommands(text: string): RouteCommand[] {
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

/** 执行路径规划并加载到地图 */
async function executeRouteCommand(
  cmd: RouteCommand
): Promise<{ description: string; geojson: FeatureCollection | null; routeResult: RouteResult | null }> {
  // 传入当前地图中心，帮助地理编码限定搜索范围
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

  // 同时添加起终点标记
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

// ====== Component ======

const AIAssistant: React.FC = () => {
  const {
    chatMessages,
    addChatMessage,
    isChatLoading,
    setChatLoading,
    deepseekApiKey,
    authToken,
    user,
    layers,
    mapState,
  } = useGISStore();

  const [inputValue, setInputValue] = useState('');
  const [osmLoading, setOsmLoading] = useState<Record<string, boolean>>({});
  const [osmResults, setOsmResults] = useState<Record<string, OSMQueryResult>>({});
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages, osmResults, osmLoading]);

  const buildSpatialContext = useCallback((): string => {
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
        const numFields = l.data ? findNumericFields(l.data) : [];
        const fieldInfo = numFields.length > 0 ? ` | 数值字段: ${numFields.join(', ')}` : '';
        parts.push(`  · "${l.name}" — 类型:${l.type} | 几何:${[...geomTypes].join(',') || '无'} | ${l.data?.features?.length || 0}个要素${fieldInfo}`);
      }
    }

    return parts.join('\n');
  }, [mapState, layers]);

  /** 执行单个 OSM 命令，可选传入前一个 boundary 命令产出的精确 bbox */
  const runOSMCommand = useCallback(
    async (
      cmd: OSMCommand,
      cmdKey: string,
      overrideBounds?: [number, number, number, number] | null
    ): Promise<[number, number, number, number] | null> => {
      setOsmLoading((prev) => ({ ...prev, [cmdKey]: true }));
      try {
        const { result, bbox } = await executeOSMCommand(cmd, mapState.bounds, overrideBounds);
        setOsmResults((prev) => ({ ...prev, [cmdKey]: result }));

        // 自动加载成功的结果到地图
        if (result.geojson && result.geojson.features.length > 0) {
          const { addLayer } = useGISStore.getState();
          const colors = ['#1677ff', '#52c41a', '#fa8c16', '#f5222d', '#722ed1', '#13c2c2'];
          addLayer({
            id: '',
            name: `${result.label}_${new Date().toLocaleTimeString()}`,
            type: 'geojson',
            visible: true,
            color: colors[Math.floor(Math.random() * colors.length)],
            opacity: 0.6,
            data: result.geojson,
            sourceId: '',
            layerId: '',
            createdAt: Date.now(),
          });
          message.success(`✅ ${result.description}`);
        } else {
          message.warning(result.error ? `查询失败: ${result.error}` : result.description);
        }

        // 返回 boundary 命令产出的精确 bbox，供后续命令链接使用
        return bbox ?? null;
      } catch (err) {
        setOsmResults((prev) => ({
          ...prev,
          [cmdKey]: {
            type: 'custom',
            label: '错误',
            geojson: null,
            description: '查询异常',
            error: err instanceof Error ? err.message : '未知错误',
          },
        }));
        return null;
      } finally {
        setOsmLoading((prev) => ({ ...prev, [cmdKey]: false }));
      }
    },
    [mapState.bounds]
  );

  const executeMapAction = useCallback((action: { action: string; params: string }) => {
    switch (action.action) {
      case 'zoomTo': {
        const [lng, lat, zoom] = action.params.split(',').map(Number);
        if (!isNaN(lng) && !isNaN(lat)) {
          window.dispatchEvent(
            new CustomEvent('fly-to', {
              detail: { center: [lng, lat], zoom: zoom || 14 },
            })
          );
          message.success(`📍 已飞往 [${lng.toFixed(4)}, ${lat.toFixed(4)}]`);
        }
        break;
      }
      case 'addMarker': {
        const parts = action.params.split(',');
        const lng = parseFloat(parts[0]);
        const lat = parseFloat(parts[1]);
        const label = parts.slice(2).join(',') || '标记点';
        if (!isNaN(lng) && !isNaN(lat)) {
          const { addLayer } = useGISStore.getState();
          addLayer({
            id: '',
            name: label,
            type: 'point',
            visible: true,
            color: '#f5222d',
            opacity: 0.9,
            data: {
              type: 'FeatureCollection',
              features: [
                { type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: { name: label } },
              ],
            },
            sourceId: '', layerId: '', createdAt: Date.now(),
          });
          message.success(`📍 已标记: ${label}`);
        }
        break;
      }
      case 'fitBounds': {
        const [w, s, e, n] = action.params.split(',').map(Number);
        if (!isNaN(w) && !isNaN(s) && !isNaN(e) && !isNaN(n)) {
          window.dispatchEvent(
            new CustomEvent('zoom-to-bounds', { detail: [[w, s], [e, n]] })
          );
          message.success('🔍 已缩放到指定范围');
        }
        break;
      }
    }
  }, []);

  const handleSend = useCallback(async () => {
    const text = inputValue.trim();
    if (!text || isChatLoading) return;

    if (!user) {
      message.warning('请先登录（右上角登录按钮）');
      return;
    }

    const spatialContext = buildSpatialContext();

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: text,
      timestamp: Date.now(),
      spatialContext: {
        center: mapState.center,
        zoom: mapState.zoom,
        layers: layers.filter((l) => l.visible).map((l) => l.name),
      },
    };
    addChatMessage(userMsg);
    setInputValue('');
    setChatLoading(true);

    try {
      const history = chatMessages
        .slice(-10)
        .filter((m) => m.id !== 'welcome')
        .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

      const enrichedContent = `[当前地图状态]
${spatialContext}

[用户问题]
${text}`;

      const fullMessages = [
        { role: 'system' as const, content: SYSTEM_PROMPT },
        ...history,
        { role: 'user' as const, content: enrichedContent },
      ];

      // 流式输出：先插入占位消息，逐字更新
      const msgId = `assistant-${Date.now()}`;
      const placeholderMsg: ChatMessage = {
        id: msgId,
        role: 'assistant',
        content: '⏳ 思考中...',
        timestamp: Date.now(),
      };
      addChatMessage(placeholderMsg);

      let fullReply = '';
      await chatWithDeepSeekStream(
        fullMessages,
        { apiKey: deepseekApiKey, authToken },
        (chunk) => {
          fullReply += chunk;
          useGISStore.getState().updateChatMessage(msgId, { content: fullReply });
        },
        () => {
          useGISStore.getState().updateChatMessage(msgId, { content: fullReply || '(无回复)' });
        },
        (err) => {
          useGISStore.getState().updateChatMessage(msgId, { content: `❌ 请求失败：${err}` });
        }
      );

      if (!fullReply) {
        setChatLoading(false);
        return;
      }

      // ============================================
      // 🔄 执行顺序：ROUTE → LOCAL → OSM → ANALYSIS → MAP
      // ROUTE 最先执行，避免 OSM 边界查询跳动地图干扰路线规划
      // ============================================

      // 1️⃣ 解析并执行 ROUTE 路径规划指令（最先，不被 OSM 跳图干扰）
      const routeCommands = parseRouteCommands(fullReply);
      if (routeCommands.length > 0) {
        for (let i = 0; i < routeCommands.length; i++) {
          const rCmd = routeCommands[i];
          const routeResult = await executeRouteCommand(rCmd);
          addChatMessage({
            id: `route-${Date.now()}-${i}`,
            role: 'assistant',
            content: `🧭 **路径规划**: ${routeResult.description}`,
            timestamp: Date.now(),
            routeData: routeResult.routeResult,
          } as ChatMessage);
          if (routeResult.geojson) {
            const fcBbox = getFCBounds(routeResult.geojson);
            if (fcBbox) {
              setTimeout(() => {
                const routeBounds = getRouteBounds(routeResult.geojson!);
                if (routeBounds) {
                  window.dispatchEvent(new CustomEvent('zoom-to-bounds', { detail: routeBounds }));
                }
              }, 400);
            }
          }
        }
      }

      // 提前解析，用于流程控制
      const analysisCommands = parseAnalysisCommands(fullReply);
      const hasAnalysis = analysisCommands.length > 0;
      const localFiles = parseLocalFileCommands(fullReply);
      const hasLocalData = localFiles.length > 0;

      // 2️⃣ 顺序执行 OSM 命令
      let osmCommands: OSMCommand[] = [];
      if (routeCommands.length === 0) {
        osmCommands = parseOSMCommands(fullReply);

        // 🔒 安全网1：AI 忘记生成 OSM 指令时自动补偿
        if (osmCommands.length === 0 && looksLikeGeoQuery(text) && !hasLocalData) {
          const autoPlace = extractPlaceNameFromInput(text);
          if (autoPlace) {
            const wantsOutline = /边界|轮廓|边界线|轮廓线/.test(text);
            const wantsAnalysis = /缓冲|buffer|相交|合并|差集|叠加/.test(text);
            const isAdmin = /[省市区县乡镇村]$/.test(autoPlace);
            const action = wantsOutline ? 'outline'
              : (wantsAnalysis || isAdmin) ? 'boundary'
              : 'feature';
            osmCommands = [{ action: action as 'boundary' | 'outline' | 'feature', params: autoPlace }];
          }
        }
      }

      // 🔒 安全网2：分析指令引用了不存在的图层 → 自动补 OSM 数据源
      // 例：AI 只生成 [ANALYSIS:buffer:上海市:5km] 忘了 [OSM:boundary:上海市]
      if (hasAnalysis) {
        for (const aCmd of analysisCommands) {
          if (aCmd.operation === 'grid') continue; // grid 不需要源图层
          const ref = aCmd.layerRef;
          if (!ref) continue;
          // 检查是否已有 OSM/LOCAL 会提供数据
          const coveredByOSM = osmCommands.some(c => c.params === ref);
          const coveredByLocal = localFiles.some(f => {
            const base = f.replace(/\.(geo)?json$/i, '');
            return base === ref || ref.includes(base) || base.includes(ref);
          });
          if (!coveredByOSM && !coveredByLocal) {
            const isAdmin = /[省市区县乡镇村]$/.test(ref);
            osmCommands.push({ action: isAdmin ? 'boundary' : 'feature', params: ref });
          }
        }
      }

      // 分析模式：过滤掉 poi/buildings/roads 等非面查询
      const isAnalysisRequest = /缓冲|buffer|相交|intersect|合并|union|差集|difference|分析|叠加/.test(text);
      if (isAnalysisRequest && osmCommands.length > 0) {
        const ALLOWED_IN_ANALYSIS = new Set(['boundary', 'outline', 'feature', 'districts']);
        osmCommands = osmCommands.filter(cmd => ALLOWED_IN_ANALYSIS.has(cmd.action));
      }

      // 执行 OSM 命令
      if (osmCommands.length > 0) {
        let chainedBbox: [number, number, number, number] | null = null;
        for (let i = 0; i < osmCommands.length; i++) {
          const cmd = osmCommands[i];
          const cmdKey = `${msgId}-osm-${i}`;
          const newBbox = await runOSMCommand(cmd, cmdKey, chainedBbox);
          if (cmd.action === 'boundary' && newBbox) {
            chainedBbox = newBbox;
          }
          // 纯搜索（无分析）：缩放至查询结果
          if (!hasAnalysis) {
            const s = useGISStore.getState();
            const lastLayer = s.layers[s.layers.length - 1];
            if (lastLayer?.data) {
              const bbox = getFCBounds(lastLayer.data);
              if (bbox) {
                setTimeout(() => {
                  window.dispatchEvent(new CustomEvent('zoom-to-bounds', { detail: bbox }));
                }, 400);
              }
            }
          }
        }
      }

      // 3️⃣ 执行 LOCAL 本地文件加载
      if (localFiles.length > 0) {
        for (let i = 0; i < localFiles.length; i++) {
          const filename = localFiles[i];
          const result = await executeLocalFileCommand(filename);
          addChatMessage({
            id: `local-${Date.now()}-${i}`,
            role: 'assistant',
            content: `📂 **本地文件**: ${result.description}`,
            timestamp: Date.now(),
          });
          // 缩放至本地文件（有分析时跳过，分析结果缩放会接管）
          if (result.geojson && !hasAnalysis) {
            const fcBbox = getFCBounds(result.geojson);
            if (fcBbox) {
              setTimeout(() => {
                window.dispatchEvent(new CustomEvent('zoom-to-bounds', { detail: fcBbox }));
              }, 300);
            }
          }
        }
      }

      // 4️⃣ 执行 ANALYSIS 空间分析指令
      if (analysisCommands.length > 0) {
        for (let i = 0; i < analysisCommands.length; i++) {
          const aCmd = analysisCommands[i];
          const result = await executeAnalysisCommand(aCmd);
          addChatMessage({
            id: `analysis-${Date.now()}-${i}`,
            role: 'assistant',
            content: `🔬 **空间分析结果**: ${result.description}`,
            timestamp: Date.now(),
          });
          // 缩放到分析结果
          if (result.geojson) {
            const resultBbox = getFCBounds(result.geojson);
            if (resultBbox) {
              setTimeout(() => {
                window.dispatchEvent(new CustomEvent('zoom-to-bounds', { detail: resultBbox }));
              }, 500);
            }
          }
        }
      }

      // 解析并执行地图操作
      const mapActions = extractMapActions(fullReply);
      if (osmCommands.length === 0 && analysisCommands.length === 0 && mapActions.length === 1 && mapActions[0].action === 'zoomTo') {
        setTimeout(() => executeMapAction(mapActions[0]), 500);
      }
    } catch (err) {
      addChatMessage({
        id: `error-${Date.now()}`,
        role: 'assistant',
        content: `❌ **错误**: ${err instanceof Error ? err.message : '请求失败'}`,
        timestamp: Date.now(),
      });
    } finally {
      setChatLoading(false);
    }
  }, [
    inputValue, isChatLoading, deepseekApiKey, mapState, layers,
    chatMessages, addChatMessage, setChatLoading, setInputValue,
    buildSpatialContext, runOSMCommand, executeMapAction,
  ]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  const handleQuickPrompt = useCallback((prompt: string) => {
    setInputValue(prompt);
    setTimeout(() => {
      const textarea = document.querySelector('.chat-input-area textarea') as HTMLTextAreaElement;
      if (textarea) textarea.focus();
    }, 100);
  }, []);

  const handleCopy = useCallback((text: string) => {
    navigator.clipboard.writeText(text);
    message.success('已复制');
  }, []);

  const handleClear = useCallback(() => {
    useGISStore.getState().clearChat();
    setOsmResults({});
    setOsmLoading({});
    message.success('对话已清除');
  }, []);

  // ====== Render ======

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ padding: '12px 16px', borderBottom: '1px solid #e8e8e8', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Space>
          <Avatar icon={<RobotOutlined />} style={{ background: '#1677ff' }} size="small" />
          <Text strong style={{ fontSize: 14 }}>GIS 智能助手</Text>
          <Tag color="green" style={{ fontSize: 10 }}>DeepSeek</Tag>
          <Tag color="blue" style={{ fontSize: 10 }}>OSM数据</Tag>
        </Space>
        <Space size="small">
          <Tooltip title="清除对话"><Button type="text" size="small" icon={<ClearOutlined />} onClick={handleClear} /></Tooltip>
        </Space>
      </div>

      {/* Messages */}
      <div style={{ flex: 1, overflow: 'auto', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {chatMessages.map((msg) => {
          const geoJSONBlocks = msg.role === 'assistant' ? extractGeoJSONBlocks(msg.content) : [];
          const mapActions = msg.role === 'assistant' ? extractMapActions(msg.content) : [];
          const osmCommands = msg.role === 'assistant' ? parseOSMCommands(msg.content) : [];

          return (
            <div key={msg.id} className="chat-message-enter" style={{ display: 'flex', flexDirection: 'column', alignItems: msg.role === 'user' ? 'flex-end' : 'flex-start' }}>
              {/* 消息气泡 */}
              <div
                style={{
                  maxWidth: '92%', padding: '10px 14px', borderRadius: 12,
                  background: msg.role === 'user' ? '#1677ff' : msg.content.startsWith('❌') ? '#fff2f0' : '#f5f5f5',
                  color: msg.role === 'user' ? '#fff' : msg.content.startsWith('❌') ? '#cf1322' : '#333',
                  fontSize: 13, lineHeight: 1.7,
                }}
              >
                {msg.role === 'assistant' ? (
                  <div className="markdown-content">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                  </div>
                ) : (
                  <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{msg.content}</div>
                )}

                {msg.role === 'assistant' && !msg.content.startsWith('❌') && (
                  <div style={{ marginTop: 6, textAlign: 'right' }}>
                    <Button type="text" size="small" icon={<CopyOutlined />} style={{ fontSize: 11, color: '#999' }} onClick={() => handleCopy(msg.content)} />
                  </div>
                )}
              </div>

              {/* OSM 命令执行结果 */}
              {osmCommands.map((cmd, i) => {
                const cmdKey = `${msg.id}-osm-${i}`;
                const loading = osmLoading[cmdKey];
                const result = osmResults[cmdKey];
                const isInFormat = cmd.action.endsWith('-in');

                return (
                  <Card
                    key={cmdKey}
                    size="small"
                    style={{
                      marginTop: 8, maxWidth: '92%',
                      background: loading ? '#fffbe6' : result?.geojson ? '#f6ffed' : '#fff2f0',
                      border: `1px solid ${loading ? '#ffe58f' : result?.geojson ? '#b7eb8f' : '#ffccc7'}`,
                      borderRadius: 8,
                    }}
                    title={
                      <Space size="small">
                        {loading ? <Spin size="small" /> : result?.geojson ? <DatabaseOutlined style={{ color: '#52c41a' }} /> : <GlobalOutlined />}
                        <Text strong style={{ fontSize: 12, color: loading ? '#ad6800' : result?.geojson ? '#52c41a' : '#cf1322' }}>
                          {loading ? `正在从 OpenStreetMap 查询...` : result?.description || 'OSM 查询'}
                        </Text>
                        {isInFormat && <Tag color="green" style={{ fontSize: 9 }}>精准区域</Tag>}
                      </Space>
                    }
                  >
                    {loading ? (
                      <Text type="secondary" style={{ fontSize: 11 }}>
                        🌀 正在查询 {cmd.action === 'boundary' ? `"${cmd.params}"的边界` : `${cmd.action} 数据`}，请稍候...（数据来自 OpenStreetMap）
                      </Text>
                    ) : result?.geojson ? (
                      <div>
                        <Text type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>
                          ✅ {result.geojson.features.length} 个要素已自动加载到地图
                        </Text>
                      </div>
                    ) : (
                      <Text type="secondary" style={{ fontSize: 11, color: '#cf1322' }}>
                        ❌ {result?.error || '查询无结果'}
                      </Text>
                    )}
                  </Card>
                );
              })}

              {/* 地图操作按钮 */}
              {mapActions.length > 0 && (
                <div style={{ marginTop: 8, maxWidth: '92%' }}>
                  {mapActions.map((action, i) => (
                    <Button
                      key={i} size="small" type="primary" ghost
                      icon={action.action === 'zoomTo' ? <AimOutlined /> : action.action === 'addMarker' ? <EnvironmentOutlined /> : <AimOutlined />}
                      onClick={() => executeMapAction(action)}
                      style={{ marginBottom: 4, borderRadius: 16, fontSize: 12 }}
                    >
                      {action.action === 'zoomTo' ? `📌 飞往 ${action.params}` : action.action === 'addMarker' ? `📍 标记点` : `🗺️ ${action.action}`}
                    </Button>
                  ))}
                </div>
              )}

              {/* 路径规划结果卡片 */}
              {msg.routeData && (
                <Card
                  size="small"
                  style={{
                    marginTop: 8, maxWidth: '92%',
                    background: '#f0fdf4', border: '1px solid #86efac',
                    borderRadius: 8,
                  }}
                  title={
                    <Space size="small">
                      <span style={{ fontSize: 16 }}>🧭</span>
                      <Text strong style={{ fontSize: 12, color: '#166534' }}>路径规划</Text>
                    </Space>
                  }
                >
                  <div style={{ fontSize: 12, lineHeight: 1.8 }}>
                    <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
                      <Tag color="green">🟢 {msg.routeData.startName.split(',').slice(0, 2).join(',')}</Tag>
                      <span style={{ color: '#999' }}>→</span>
                      <Tag color="red">🔴 {msg.routeData.endName.split(',').slice(0, 2).join(',')}</Tag>
                    </div>
                    <div style={{ display: 'flex', gap: 16, marginBottom: 4 }}>
                      <Text style={{ fontSize: 13, fontWeight: 600, color: '#1677ff' }}>
                        📏 {msg.routeData.distance < 1000
                          ? `${Math.round(msg.routeData.distance)}m`
                          : `${(msg.routeData.distance / 1000).toFixed(1)}km`}
                      </Text>
                      <Text style={{ fontSize: 13, fontWeight: 600, color: '#52c41a' }}>
                        ⏱ {msg.routeData.duration < 60
                          ? `${Math.round(msg.routeData.duration)}秒`
                          : msg.routeData.duration < 3600
                            ? `${Math.round(msg.routeData.duration / 60)}分钟`
                            : `${Math.floor(msg.routeData.duration / 3600)}h${Math.round((msg.routeData.duration % 3600) / 60)}min`}
                      </Text>
                    </div>
                    {msg.routeData.steps.length > 0 && (
                      <details style={{ marginTop: 4 }}>
                        <summary style={{ cursor: 'pointer', color: '#1677ff', fontSize: 12 }}>
                          📋 导航步骤 ({msg.routeData.steps.length} 个转向)
                        </summary>
                        <div style={{ maxHeight: 180, overflow: 'auto', marginTop: 4, fontSize: 11 }}>
                          {msg.routeData.steps.filter(s => s.instruction).map((step, si) => (
                            <div key={si} style={{
                              padding: '3px 6px', marginBottom: 2,
                              background: si % 2 === 0 ? '#fff' : '#f9fafb',
                              borderRadius: 4,
                            }}>
                              <Text type="secondary">{si + 1}. </Text>
                              {step.instruction}
                              {step.name && <Text type="secondary"> ({step.name})</Text>}
                              <Text type="secondary" style={{ marginLeft: 8 }}>
                                {step.distance < 1000
                                  ? `${Math.round(step.distance)}m`
                                  : `${(step.distance / 1000).toFixed(1)}km`}
                              </Text>
                            </div>
                          ))}
                        </div>
                      </details>
                    )}
                  </div>
                </Card>
              )}

              {/* AI生成的 GeoJSON（仅模拟数据） */}
              {geoJSONBlocks.map((block, i) => (
                <Card
                  key={i} size="small"
                  style={{ marginTop: 8, maxWidth: '92%', background: '#f0f5ff', border: '1px solid #d6e4ff', borderRadius: 8 }}
                  title={<Text strong style={{ fontSize: 12, color: '#1677ff' }}>🤖 AI生成 GeoJSON ({block.geojson.features.length}要素)</Text>}
                  extra={<Button size="small" type="text" icon={<DownloadOutlined />} onClick={() => {
                    const json = JSON.stringify(block.geojson, null, 2);
                    const blob = new Blob([json], { type: 'application/geo+json' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a'); a.href = url; a.download = 'ai-generated.geojson'; a.click();
                    URL.revokeObjectURL(url);
                  }} />}
                >
                  <Text type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 8 }}>
                    ⚠️ 这是AI模拟数据，非真实地理数据。真实数据请用OSM指令查询
                  </Text>
                  <Button
                    type="primary" icon={<PlusSquareOutlined />} size="small" block
                    onClick={() => {
                      const { addLayer } = useGISStore.getState();
                      const colors = ['#1677ff', '#52c41a', '#fa8c16', '#f5222d', '#722ed1'];
                      addLayer({
                        id: '', name: `AI模拟_${new Date().toLocaleTimeString()}`, type: 'geojson', visible: true,
                        color: colors[Math.floor(Math.random() * colors.length)], opacity: 0.7,
                        data: block.geojson, sourceId: '', layerId: '', createdAt: Date.now(),
                      });
                      message.success(`已加载 ${block.geojson.features.length} 个模拟要素`);
                    }}
                  >加载AI数据到地图</Button>
                </Card>
              ))}

              {/* 空间上下文 */}
              {msg.spatialContext && msg.role === 'user' && (
                <Text type="secondary" style={{ fontSize: 10, marginTop: 2 }}>
                  📍 {msg.spatialContext.center[0].toFixed(3)}, {msg.spatialContext.center[1].toFixed(3)} | z{msg.spatialContext.zoom.toFixed(0)}
                  {msg.spatialContext.layers.length > 0 && ` | ${msg.spatialContext.layers.join(', ')}`}
                </Text>
              )}

              <Text type="secondary" style={{ fontSize: 10, marginTop: 2, padding: '0 4px' }}>
                {new Date(msg.timestamp).toLocaleTimeString()}
              </Text>
            </div>
          );
        })}

        {isChatLoading && (
          <div style={{ textAlign: 'center', padding: 12 }}>
            <Space><Spin indicator={<LoadingOutlined style={{ fontSize: 20 }} spin />} /><Text type="secondary" style={{ fontSize: 12 }}>AI 思考中...</Text></Space>
          </div>
        )}

        {chatMessages.length <= 1 && !isChatLoading && (
          <div style={{ marginTop: 8 }}>
            <Text type="secondary" style={{ fontSize: 12, marginBottom: 8, display: 'block' }}>
              💡 试试这些（OSM真实数据）：
            </Text>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {QUICK_PROMPTS.map((qp) => (
                <Tag
                  key={qp.label}
                  style={{ cursor: 'pointer', padding: '4px 10px', borderRadius: 16, fontSize: 12, border: '1px dashed #d9d9d9', background: '#fafafa' }}
                  onClick={() => handleQuickPrompt(qp.prompt)}
                >
                  {qp.icon} {qp.label}
                </Tag>
              ))}
            </div>
            <Divider style={{ margin: '12px 0' }} />
            <div style={{ padding: '8px 12px', background: '#e6f4ff', borderRadius: 8, border: '1px solid #91caff' }}>
              <Text style={{ fontSize: 11, color: '#1677ff' }}>
                💡 提示：AI 会通过 <Tag color="blue" style={{ fontSize: 10 }}>[OSM:指令]</Tag> 查询 OpenStreetMap 真实数据。
                说"查找武汉的大学"时，AI 会自动使用 <Tag color="green" style={{ fontSize: 10 }}>[OSM:poi-in:...]</Tag> 精准区域查询，确保只在武汉范围内查找。
              </Text>
            </div>
          </div>
        )}

        <div ref={chatEndRef} />
      </div>

      {/* Input */}
      <div style={{ padding: '12px 16px', borderTop: '1px solid #e8e8e8', background: '#fafafa' }}>
        {!user && (
          <div style={{ padding: '6px 12px', marginBottom: 8, background: '#fffbe6', border: '1px solid #ffe58f', borderRadius: 6, fontSize: 12, color: '#ad6800' }}>
            ⚠️ 请先登录后使用 AI 助手（右上角登录按钮）
          </div>
        )}
        <div className="chat-input-area" style={{ display: 'flex', gap: 8 }}>
          <Input.TextArea
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={user ? '输入GIS问题，如"查找武汉市的大学"...' : '请先登录后使用 AI 助手'}
            autoSize={{ minRows: 1, maxRows: 4 }}
            disabled={!user}
            style={{ flex: 1, borderRadius: 8 }}
          />
          <Button type="primary" icon={<SendOutlined />} onClick={handleSend} loading={isChatLoading} disabled={!inputValue.trim() || !user} style={{ borderRadius: 8, height: 'auto' }}>
            发送
          </Button>
        </div>
      </div>
    </div>
  );
};

export default AIAssistant;
