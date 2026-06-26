/**
 * 路径规划服务
 * 使用 OSRM (Open Source Routing Machine) 免费公测服务 + Nominatim 地理编码
 * OSRM 基于 OpenStreetMap 数据，全球覆盖
 */

import type { FeatureCollection, Feature, LineString, Point } from 'geojson';
import { flattenCoords, getFCBounds } from '../utils/geo';

// OSRM 通过 Python 后端代理（解决国内网络问题）
const API_BASE = import.meta.env.VITE_API_BASE_URL || '';
const OSRM_PROXY = `${API_BASE}/api/osrm/route`;

// Nominatim 代理（复用现有后端）
const NOMINATIM_URL = `${API_BASE}/api/osm/nominatim`;

// 高德地理编码（国内 POI 更准）
const GAODE_GEOCODE_URL = `${API_BASE}/api/gaode/geocode`;

// ====== 类型定义 ======

export type TravelMode = 'driving' | 'walking' | 'cycling' | 'flying';

export interface RouteStep {
  distance: number;       // 米
  duration: number;       // 秒
  instruction: string;    // 导航指令
  name: string;           // 路名
  maneuver?: {
    type: string;         // turn, new name, depart, arrive, etc.
    modifier?: string;    // left, right, straight, etc.
    location: [number, number];
  };
}

export interface RouteResult {
  success: boolean;
  geojson: FeatureCollection | null;
  distance: number;       // 总距离（米）
  duration: number;       // 总时间（秒）
  steps: RouteStep[];
  startName: string;
  endName: string;
  description: string;
  error?: string;
}

// ====== 地理编码 ======

interface GeocodeResult {
  display_name: string;
  lat: string;
  lon: string;
}

/**
 * 地名 → 坐标（高德 + Nominatim 双引擎）
 *
 * 核心策略：
 * 1. 从地名中提取城市关键词（如"中国地质大学(武汉)"→"武汉"）
 * 2. 获取全国结果后，综合城市匹配 + 地图中心距离双重打分
 * 3. 城市名匹配的结果大幅加分，即使地图在远处也能选中正确的城市
 *
 * @param placeName 地名（可能包含城市括号如"中国地质大学(武汉)"）
 * @param mapCenter 可选：当前地图中心 [lng, lat]
 */
async function geocode(placeName: string, mapCenter?: [number, number]): Promise<GeocodeResult | null> {
  // 从地名中提取城市提示词
  const cityHints = extractCityHints(placeName);

  // 1. 先试高德（国内 POI 更准）
  try {
    const gdParams = new URLSearchParams({ address: placeName });
    const gdResp = await fetch(`${GAODE_GEOCODE_URL}?${gdParams}`);
    if (gdResp.ok) {
      const gdData = await gdResp.json();
      if (gdData.status === '1' && gdData.geocodes?.length > 0) {
        const sorted = scoreAndSort(gdData.geocodes, mapCenter, cityHints,
          (g: any) => {
            const locStr = g.wgs84_location || g.location;
            const [lng, lat] = locStr.split(',').map(Number);
            return { coords: [lng, lat] as [number, number], city: g.city || '', district: g.district || '', address: g.formatted_address || '' };
          }
        );
        const geo = sorted[0];
        const locStr = geo.wgs84_location || geo.location;
        const [lng, lat] = locStr.split(',').map(Number);
        if (!isNaN(lng) && !isNaN(lat)) {
          return {
            display_name: geo.formatted_address || placeName,
            lat: String(lat),
            lon: String(lng),
          };
        }
      }
    }
  } catch { /* 高德失败，回退 Nominatim */ }

  // 2. 回退 Nominatim
  try {
    const params = new URLSearchParams({
      q: placeName,
      format: 'jsonv2',
      limit: '5',
      'accept-language': 'zh',
    });
    const resp = await fetch(`${NOMINATIM_URL}/search?${params}`);
    if (!resp.ok) return null;
    const results = await resp.json();
    if (results.length === 0) return null;

    const sorted = scoreAndSort(results, mapCenter, cityHints,
      (r: any) => ({
        coords: [parseFloat(r.lon), parseFloat(r.lat)] as [number, number],
        city: '',
        district: '',
        address: r.display_name || '',
      })
    );
    const best = sorted[0];
    return {
      display_name: best.display_name,
      lat: best.lat,
      lon: best.lon,
    };
  } catch {
    return null;
  }
}

// ====== 城市名提取 ======

/** 中国主要城市名列表（用于从地名中提取城市上下文） */
const CITY_NAMES = [
  '北京', '上海', '天津', '重庆',
  '石家庄', '唐山', '秦皇岛', '邯郸', '邢台', '保定', '张家口', '承德', '沧州', '廊坊', '衡水',
  '太原', '大同', '阳泉', '长治', '晋城', '朔州', '晋中', '运城', '忻州', '临汾', '吕梁',
  '呼和浩特', '包头', '乌海', '赤峰', '通辽', '鄂尔多斯', '呼伦贝尔', '巴彦淖尔', '乌兰察布',
  '沈阳', '大连', '鞍山', '抚顺', '本溪', '丹东', '锦州', '营口', '阜新', '辽阳', '盘锦', '铁岭', '朝阳', '葫芦岛',
  '长春', '吉林', '四平', '辽源', '通化', '白山', '松原', '白城', '延边',
  '哈尔滨', '齐齐哈尔', '鸡西', '鹤岗', '双鸭山', '大庆', '伊春', '佳木斯', '七台河', '牡丹江', '黑河', '绥化',
  '南京', '无锡', '徐州', '常州', '苏州', '南通', '连云港', '淮安', '盐城', '扬州', '镇江', '泰州', '宿迁',
  '杭州', '宁波', '温州', '嘉兴', '湖州', '绍兴', '金华', '衢州', '舟山', '台州', '丽水',
  '合肥', '芜湖', '蚌埠', '淮南', '马鞍山', '淮北', '铜陵', '安庆', '黄山', '滁州', '阜阳', '宿州', '六安', '亳州', '池州', '宣城',
  '福州', '厦门', '莆田', '三明', '泉州', '漳州', '南平', '龙岩', '宁德',
  '南昌', '景德镇', '萍乡', '九江', '新余', '鹰潭', '赣州', '吉安', '宜春', '抚州', '上饶',
  '济南', '青岛', '淄博', '枣庄', '东营', '烟台', '潍坊', '济宁', '泰安', '威海', '日照', '临沂', '德州', '聊城', '滨州', '菏泽',
  '郑州', '开封', '洛阳', '平顶山', '安阳', '鹤壁', '新乡', '焦作', '濮阳', '许昌', '漯河', '三门峡', '南阳', '商丘', '信阳', '周口', '驻马店',
  '武汉', '黄石', '十堰', '宜昌', '襄阳', '鄂州', '荆门', '孝感', '荆州', '黄冈', '咸宁', '随州', '恩施',
  '长沙', '株洲', '湘潭', '衡阳', '邵阳', '岳阳', '常德', '张家界', '益阳', '郴州', '永州', '怀化', '娄底', '湘西',
  '广州', '韶关', '深圳', '珠海', '汕头', '佛山', '江门', '湛江', '茂名', '肇庆', '惠州', '梅州', '汕尾', '河源', '阳江', '清远', '东莞', '中山', '潮州', '揭阳', '云浮',
  '南宁', '柳州', '桂林', '梧州', '北海', '防城港', '钦州', '贵港', '玉林', '百色', '贺州', '河池', '来宾', '崇左',
  '海口', '三亚', '三沙', '儋州',
  '成都', '自贡', '攀枝花', '泸州', '德阳', '绵阳', '广元', '遂宁', '内江', '乐山', '南充', '眉山', '宜宾', '广安', '达州', '雅安', '巴中', '资阳',
  '贵阳', '六盘水', '遵义', '安顺', '毕节', '铜仁', '黔西南', '黔东南', '黔南',
  '昆明', '曲靖', '玉溪', '保山', '昭通', '丽江', '普洱', '临沧', '楚雄', '红河', '文山', '西双版纳', '大理', '德宏', '怒江', '迪庆',
  '拉萨', '日喀则', '昌都', '林芝', '山南', '那曲', '阿里',
  '西安', '铜川', '宝鸡', '咸阳', '渭南', '延安', '汉中', '榆林', '安康', '商洛',
  '兰州', '嘉峪关', '金昌', '白银', '天水', '武威', '张掖', '平凉', '酒泉', '庆阳', '定西', '陇南', '临夏', '甘南',
  '西宁', '海东', '海北', '黄南', '海南', '果洛', '玉树', '海西',
  '银川', '石嘴山', '吴忠', '固原', '中卫',
  '乌鲁木齐', '克拉玛依', '吐鲁番', '哈密', '昌吉', '博尔塔拉', '巴音郭楞', '阿克苏', '克孜勒苏', '喀什', '和田', '伊犁', '塔城', '阿勒泰',
  '台北', '高雄', '台中', '台南', '基隆', '新竹', '嘉义',
  '香港', '澳门',
];

/** 从地名中提取城市关键词 */
function extractCityHints(placeName: string): string[] {
  const hints: string[] = [];

  // 1. 从括号中提取：中国地质大学(武汉) → "武汉"
  const bracketMatch = placeName.match(/[（(]([^)）]+)[）)]/g);
  if (bracketMatch) {
    for (const m of bracketMatch) {
      const content = m.replace(/[（(）)]/g, '');
      // 检查括号内容是否为城市名
      for (const city of CITY_NAMES) {
        if (content.includes(city)) {
          hints.push(city);
          break;
        }
      }
      // 也把原始内容加入（可能是简写）
      if (content.length >= 2 && content.length <= 6) {
        hints.push(content);
      }
    }
  }

  // 2. 从地名本身匹配城市名：武汉大学 → "武汉"，邯郸市政府 → "邯郸"
  for (const city of CITY_NAMES) {
    if (placeName.includes(city) && !hints.includes(city)) {
      hints.push(city);
    }
  }

  return hints;
}

// ====== 城市感知打分排序 ======

interface ScoredItem {
  coords: [number, number];
  city: string;
  district: string;
  address: string;
}

/**
 * 综合打分排序：
 * - 城市名匹配：+10000 分（绝对优先）
 * - 距离地图中心：每公里 -1 分
 * - 结果：城市匹配的结果总是排最前，同城再按距离排
 */
function scoreAndSort<T>(
  items: T[],
  mapCenter: [number, number] | undefined,
  cityHints: string[],
  extract: (item: T) => ScoredItem
): T[] {
  const scored = items.map((item) => {
    const info = extract(item);
    let score = 0;

    // 城市名匹配加分（最重要的信号）
    if (cityHints.length > 0) {
      for (const hint of cityHints) {
        if (info.city === hint || info.city.includes(hint) || hint.includes(info.city)) {
          score += 10000;
          break;
        }
        if (info.district === hint || info.district.includes(hint)) {
          score += 5000;
          break;
        }
        if (info.address.includes(hint)) {
          score += 3000;
          break;
        }
      }
    }

    // 距离分（仅在有 mapCenter 时生效，作为城市内的次级排序）
    if (mapCenter) {
      const [lng, lat] = info.coords;
      if (!isNaN(lng) && !isNaN(lat)) {
        const distKm = Math.sqrt((lng - mapCenter[0]) ** 2 + (lat - mapCenter[1]) ** 2) * 111;
        score -= distKm;
      }
    }

    return { item, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.item);
}

/** 按到参考点的距离升序排列 */
function sortByProximity<T>(
  items: T[],
  center: [number, number] | undefined,
  getCoords: (item: T) => [number, number]
): T[] {
  if (!center || items.length <= 1) return items;
  return [...items].sort((a, b) => {
    const [alng, alat] = getCoords(a);
    const [blng, blat] = getCoords(b);
    const da = (alng - center[0]) ** 2 + (alat - center[1]) ** 2;
    const db = (blng - center[0]) ** 2 + (blat - center[1]) ** 2;
    return da - db;
  });
}

// ====== OSRM 路径规划 ======

const MODE_PROFILES: Record<TravelMode, string> = {
  driving: 'driving',
  walking: 'walking',
  cycling: 'cycling',
  flying: 'driving', // 飞行不走 OSRM，占位
};

/** 大圆航线弧线：球面插值 + 中点强制拱起 */
function buildGreatCircleArc(from: [number, number], to: [number, number]): GeoJSON.LineString {
  const steps = 80;
  const coords: [number, number][] = [];

  const lat1 = from[1] * Math.PI / 180;
  const lon1 = from[0] * Math.PI / 180;
  const lat2 = to[1] * Math.PI / 180;
  const lon2 = to[0] * Math.PI / 180;

  // 大圆角距
  const d = 2 * Math.asin(Math.sqrt(
    Math.sin((lat2 - lat1) / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2
  ));

  // 飞行距离（km），决定拱起程度
  const distKm = d * 6371;
  // 拱起系数：距离越远拱起越大（最少也有可见弧度）
  const bowFactor = Math.max(0.05, Math.min(0.4, distKm / 8000));

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    if (d < 1e-10) {
      coords.push([from[0], from[1]]);
      continue;
    }
    // 球面插值
    const a = Math.sin((1 - t) * d) / Math.sin(d);
    const b = Math.sin(t * d) / Math.sin(d);
    const x = a * Math.cos(lat1) * Math.cos(lon1) + b * Math.cos(lat2) * Math.cos(lon2);
    const y = a * Math.cos(lat1) * Math.sin(lon1) + b * Math.cos(lat2) * Math.sin(lon2);
    const z = a * Math.sin(lat1) + b * Math.sin(lat2);
    let lat = Math.atan2(z, Math.sqrt(x * x + y * y)) * 180 / Math.PI;
    let lon = Math.atan2(y, x) * 180 / Math.PI;

    // 中点强制拱起：模拟高空航线向北弯曲
    const bow = Math.sin(t * Math.PI) * bowFactor * Math.abs(to[0] - from[0]);
    const northDir = (lat1 + lat2) / 2 > 0 ? 1 : -1; // 北半球向北拱
    lat += bow * northDir;

    coords.push([lon, lat]);
  }
  return { type: 'LineString', coordinates: coords };
}

/**
 * 计算两点之间的路径
 */
async function osrmRoute(
  from: [number, number],
  to: [number, number],
  mode: TravelMode
): Promise<{
  geojson: FeatureCollection;
  distance: number;
  duration: number;
  steps: RouteStep[];
} | null> {
  const profile = MODE_PROFILES[mode];
  const coords = `${from[0]},${from[1]};${to[0]},${to[1]}`;

  // 通过 Python 后端代理请求（解决国内网络问题）
  const params = new URLSearchParams({
    coordinates: coords,
    steps: 'true',
  });
  const url = `${OSRM_PROXY}/${profile}?${params}`;

  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;

    const data = await resp.json();
    if (!data.routes || data.routes.length === 0) return null;

    const route = data.routes[0];
    const routeGeojson: FeatureCollection = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: route.geometry as LineString,
          properties: {
            distance: route.distance,
            duration: route.duration,
            mode,
          },
        },
      ],
    };

    const steps: RouteStep[] = (route.legs?.[0]?.steps || []).map((s: any) => ({
      distance: s.distance || 0,
      duration: s.duration || 0,
      instruction: generateInstruction(s.maneuver, s.name, mode),
      name: s.name || '',
      maneuver: s.maneuver
        ? {
            type: s.maneuver.type || '',
            modifier: s.maneuver.modifier || '',
            location: s.maneuver.location || [0, 0],
          }
        : undefined,
    }));

    return {
      geojson: routeGeojson,
      distance: route.distance,
      duration: route.duration,
      steps,
    };
  } catch {
    return null;
  }
}

// ====== 公共 API ======

const MODE_LABELS: Record<TravelMode, string> = {
  driving: '驾车',
  walking: '步行',
  cycling: '骑行',
  flying: '飞行',
};

/**
 * 路径规划入口
 * @param from 起点地名或坐标
 * @param to   终点地名或坐标
 * @param mode 出行方式
 */
export async function planRoute(
  from: string,
  to: string,
  mode: TravelMode = 'driving',
  mapCenter?: [number, number]
): Promise<RouteResult> {
  try {
    // 1. 地理编码：先定位起点，再用起点的坐标帮终点定位
    //    避免「清华大学」被解析到非北京的校区（如江苏）
    const fromGeo = await geocode(from, mapCenter);
    let toGeo: GeocodeResult | null = null;

    if (fromGeo) {
      const fromCoord: [number, number] = [parseFloat(fromGeo.lon), parseFloat(fromGeo.lat)];
      // 终点地名有城市信息 → 用 mapCenter；无城市信息 → 用起点坐标作参考
      const toCityHints = extractCityHints(to);
      const toMapCenter = toCityHints.length > 0 ? mapCenter : fromCoord;
      toGeo = await geocode(to, toMapCenter);
    }

    if (!fromGeo) {
      return {
        success: false,
        geojson: null,
        distance: 0,
        duration: 0,
        steps: [],
        startName: from,
        endName: to,
        description: '',
        error: `未找到起点"${from}"的位置信息`,
      };
    }

    if (!toGeo) {
      return {
        success: false,
        geojson: null,
        distance: 0,
        duration: 0,
        steps: [],
        startName: from,
        endName: to,
        description: '',
        error: `未找到终点"${to}"的位置信息`,
      };
    }

    const fromCoord: [number, number] = [parseFloat(fromGeo.lon), parseFloat(fromGeo.lat)];
    const toCoord: [number, number] = [parseFloat(toGeo.lon), parseFloat(toGeo.lat)];

    // 2. 飞行模式：大圆航线，不走 OSRM
    if (mode === 'flying') {
      const greatCircle = buildGreatCircleArc(fromCoord, toCoord);
      const distM = haversineDistance(fromCoord, toCoord); // 米
      const distKm = distM / 1000;
      const hours = distKm / 800; // 客机约 800 km/h
      const durationMin = Math.round(hours * 60);
      return {
        success: true,
        geojson: { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: greatCircle, properties: {} }] },
        distance: Math.round(distM),
        duration: durationMin * 60,
        steps: [{
          distance: Math.round(distM),
          duration: durationMin * 60,
          instruction: `从${from}直飞${to}`,
          name: '大圆航线',
        }],
        startName: fromGeo.display_name,
        endName: toGeo.display_name,
        description: `✈️ ${from} → ${to} | 直线距离 ${distKm < 100 ? distKm.toFixed(0) + 'km' : (distKm / 1000).toFixed(1) + '千km'} | 约 ${durationMin < 60 ? durationMin + '分钟' : Math.floor(durationMin / 60) + 'h' + (durationMin % 60) + 'min'}`,
      };
    }

    // 3. OSRM 路径规划（地面交通）
    const route = await osrmRoute(fromCoord, toCoord, mode);

    if (!route) {
      // 如果 OSRM 失败，生成直线作为备选
      const straightLine: FeatureCollection = {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: {
              type: 'LineString',
              coordinates: [fromCoord, toCoord],
            },
            properties: {
              mode,
              note: '直线距离（OSRM 路径规划不可用）',
            },
          },
        ],
      };

      const directDist = haversineDistance(fromCoord, toCoord);
      return {
        success: true,
        geojson: straightLine,
        distance: directDist,
        duration: mode === 'walking' ? directDist / 1.4 : mode === 'cycling' ? directDist / 4.2 : directDist / 8.3,
        steps: [],
        startName: fromGeo.display_name,
        endName: toGeo.display_name,
        description: `⚠️ OSRM 路径规划不可用，显示直线连接。` +
          `${MODE_LABELS[mode]}直线距离约 ${formatDistance(directDist)}`,
      };
    }

    const modeLabel = MODE_LABELS[mode];
    return {
      success: true,
      geojson: route.geojson,
      distance: route.distance,
      duration: route.duration,
      steps: route.steps,
      startName: fromGeo.display_name,
      endName: toGeo.display_name,
      description:
        `✅ ${modeLabel}路径规划完成：` +
        `${formatDistance(route.distance)} · ${formatDuration(route.duration)} · ${route.steps.length} 个转向指令`,
    };
  } catch (err) {
    return {
      success: false,
      geojson: null,
      distance: 0,
      duration: 0,
      steps: [],
      startName: from,
      endName: to,
      description: '',
      error: err instanceof Error ? err.message : '路径规划失败',
    };
  }
}

// ====== 导航指令生成 ======

/** 从 OSRM maneuver 数据生成中文导航指令 */
function generateInstruction(
  maneuver: { type?: string; modifier?: string } | undefined,
  roadName: string,
  mode: TravelMode
): string {
  if (!maneuver) return roadName || '继续前行';

  const road = roadName ? `进入 ${roadName}` : '';
  const modeLabel = mode === 'walking' ? '步行' : mode === 'cycling' ? '骑行' : '';

  switch (maneuver.type) {
    case 'depart':
      return `从起点出发${road ? `，${road}` : ''}`;
    case 'arrive':
      return `到达终点`;
    case 'turn': {
      const dir = TURN_DIRECTIONS[maneuver.modifier || ''] || '转向';
      return `${dir}${road ? `，${road}` : ''}`;
    }
    case 'new name':
      return road || `继续沿路前行`;
    case 'fork': {
      const dir = FORK_DIRECTIONS[maneuver.modifier || ''] || '靠一侧';
      return `${dir}${road ? `，${road}` : ''}`;
    }
    case 'on ramp':
      return `上匝道${road ? `，${road}` : ''}`;
    case 'off ramp':
      return `下匝道${road ? `，${road}` : ''}`;
    case 'roundabout':
      return `进入环岛${road ? `，${road}` : ''}`;
    case 'exit roundabout':
      return `驶出环岛${road ? `，${road}` : ''}`;
    case 'merge':
      return `汇入主路${road ? `，${road}` : ''}`;
    case 'continue':
      return `继续直行${road ? `，沿${road}` : ''}`;
    default: {
      // 有路名就用路名
      if (roadName) return `沿 ${roadName} 前行`;
      return `${modeLabel}前行`;
    }
  }
}

const TURN_DIRECTIONS: Record<string, string> = {
  'sharp left': '向左急转',
  left: '左转',
  'slight left': '稍向左转',
  straight: '直行',
  'slight right': '稍向右转',
  right: '右转',
  'sharp right': '向右急转',
  'uturn': '掉头',
};

const FORK_DIRECTIONS: Record<string, string> = {
  'slight left': '靠左侧岔路',
  left: '走左侧出口',
  'sharp left': '走最左侧出口',
  straight: '沿中间直行',
  'slight right': '靠右侧岔路',
  right: '走右侧出口',
  'sharp right': '走最右侧出口',
};

// ====== 工具函数 ======

function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)}m`;
  return `${(meters / 1000).toFixed(1)}km`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}秒`;
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins}分钟`;
  const hours = Math.floor(mins / 60);
  const remainMins = mins % 60;
  return remainMins > 0 ? `${hours}小时${remainMins}分钟` : `${hours}小时`;
}

/**
 * Haversine 公式计算两点距离（米）
 */
function haversineDistance(a: [number, number], b: [number, number]): number {
  const R = 6371000;
  const dLat = ((b[1] - a[1]) * Math.PI) / 180;
  const dLon = ((b[0] - a[0]) * Math.PI) / 180;
  const lat1 = (a[1] * Math.PI) / 180;
  const lat2 = (b[1] * Math.PI) / 180;
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const aVal = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
  return 2 * R * Math.atan2(Math.sqrt(aVal), Math.sqrt(1 - aVal));
}

/**
 * 从 FeatureCollection 提取 bbox
 */
export function getRouteBounds(
  fc: FeatureCollection
): [[number, number], [number, number]] | null {
  return getFCBounds(fc);
}
