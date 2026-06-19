/**
 * 灾害数据服务
 * - USGS 全球地震数据（免费）
 * - SRTM 高程/等高线（通过 MapLibre terrain DEM）
 * - Open-Meteo 气象数据（免费，无需 Key）
 */

import maplibregl from 'maplibre-gl';
import * as turf from '@turf/turf';
import type { FeatureCollection, Feature, Point, MultiLineString, LineString } from 'geojson';

const USGS_API = 'https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson';

export interface EarthquakeQuery {
  bbox: [number, number, number, number]; // [w, s, e, n]
  minMagnitude?: number;
  days?: number; // 最近 N 天
  limit?: number;
}

export interface EarthquakeResult {
  geojson: FeatureCollection | null;
  description: string;
  features: Feature[];
}

/**
 * 查询 USGS 地震数据
 * 免费 API，无需 Key
 */
export async function queryEarthquakes(params: EarthquakeQuery): Promise<EarthquakeResult> {
  const {
    bbox,
    minMagnitude = 3.0,
    days = 30,
    limit = 200,
  } = params;

  const [w, s, e, n] = bbox;

  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - days);

  const url = `${USGS_API}&starttime=${start.toISOString()}&endtime=${end.toISOString()}`
    + `&minlatitude=${s}&maxlatitude=${n}&minlongitude=${w}&maxlongitude=${e}`
    + `&minmagnitude=${minMagnitude}&limit=${limit}&orderby=magnitude`;

  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`USGS API ${resp.status}`);
    const data = await resp.json();

    if (!data.features || data.features.length === 0) {
      return {
        geojson: null,
        description: `📊 最近 ${days} 天内该区域无 M≥${minMagnitude} 地震记录`,
        features: [],
      };
    }

    // 按震级着色、按震级设置半径
    const features = data.features.map((f: any) => {
      const mag = f.properties.mag || 0;
      return {
        ...f,
        properties: {
          ...f.properties,
          _hazardType: 'earthquake',
          _magColor: mag >= 7 ? '#d50000' : mag >= 5 ? '#ff6d00' : mag >= 4 ? '#ffab00' : '#ffd600',
          _radius: mag >= 7 ? 18 : mag >= 5 ? 12 : mag >= 4 ? 8 : 5,
        },
      };
    });

    const maxEvent = features[0];
    const summaryParts: string[] = [];
    if (maxEvent) {
      const p = maxEvent.properties;
      summaryParts.push(`最强: M${p.mag} ${p.place} (${new Date(p.time).toLocaleDateString('zh-CN')})`);
    }
    summaryParts.push(`共 ${features.length} 次 M≥${minMagnitude}`);

    return {
      geojson: { type: 'FeatureCollection', features },
      description: `🌍 地震数据 (最近${days}天): ${summaryParts.join(' | ')}`,
      features,
    };
  } catch (err) {
    return {
      geojson: null,
      description: `❌ USGS 地震查询失败: ${err instanceof Error ? err.message : '未知错误'}`,
      features: [],
    };
  }
}

/**
 * 从 MapLibre terrain 获取高程（米）
 */
export function queryElevationAtPoint(
  map: maplibregl.Map | null,
  lng: number,
  lat: number
): number | null {
  if (!map) return null;
  try {
    // queryTerrainElevation 需要 terrain 已加载
    const elev = map.queryTerrainElevation?.([lng, lat]);
    return elev != null ? Math.round(elev) : null;
  } catch {
    return null;
  }
}

/**
 * 采样矩形区域内的高程网格
 * 返回 null 表示 terrain 未就绪
 */
export function sampleElevationGrid(
  map: maplibregl.Map | null,
  bbox: [number, number, number, number],
  resolution: number = 20
): { lng: number; lat: number; elevation: number | null }[] | null {
  if (!map) return null;
  // 检查 terrain source 是否有数据
  const source = map.getSource('terrain-dem') as any;
  if (!source || !map.isSourceLoaded?.('terrain-dem')) {
    return null; // terrain 未就绪
  }
  const [w, s, e, n] = bbox;
  const points: { lng: number; lat: number; elevation: number | null }[] = [];
  const lngStep = (e - w) / resolution;
  const latStep = (n - s) / resolution;

  for (let i = 0; i <= resolution; i++) {
    for (let j = 0; j <= resolution; j++) {
      const lng = w + i * lngStep;
      const lat = s + j * latStep;
      points.push({ lng, lat, elevation: queryElevationAtPoint(map, lng, lat) });
    }
  }
  return points;
}

/**
 * 100% 可靠的高程点图：每个采样点一个点，按高程着色
 * 不连线不拟合，数据说什么就是什么
 */
export function generateElevationPoints(
  grid: { lng: number; lat: number; elevation: number | null }[],
  bbox: [number, number, number, number],
  sampleEvery: number = 3  // 每 N 个点取一个（避免太密）
): FeatureCollection | null {
  const valid = grid.filter(p => p.elevation != null);
  if (valid.length === 0) return null;

  const features: Feature[] = [];
  for (let i = 0; i < valid.length; i += sampleEvery) {
    const p = valid[i];
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
      properties: {
        elevation: Math.round(p.elevation!),
        _magColor: elevationColor(p.elevation!),
        _radius: 4,
        _hazardType: 'elevation',
      },
    });
  }

  return { type: 'FeatureCollection', features };
}

/**
 * 生成高程标签：取最高点和最低点
 */
export function generateElevationLabels(
  grid: { lng: number; lat: number; elevation: number | null }[]
): FeatureCollection | null {
  const valid = grid.filter(p => p.elevation != null) as { lng: number; lat: number; elevation: number }[];
  if (valid.length === 0) return null;

  const max = valid.reduce((a, b) => a.elevation > b.elevation ? a : b);
  const min = valid.reduce((a, b) => a.elevation < b.elevation ? a : b);

  return {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', geometry: { type: 'Point', coordinates: [max.lng, max.lat] },
        properties: { name: `▲${Math.round(max.elevation)}m`, elevation: Math.round(max.elevation), _elevationLabel: 'peak' } },
      { type: 'Feature', geometry: { type: 'Point', coordinates: [min.lng, min.lat] },
        properties: { name: `▼${Math.round(min.elevation)}m`, elevation: Math.round(min.elevation), _elevationLabel: 'valley' } },
    ],
  };
}

/**
 * 从高程采样点生成等高线（turf.isolines）
 * 注意: turf.isolines 要求点阵是均匀网格，不能有空缺
 */
export function generateContours(
  grid: { lng: number; lat: number; elevation: number | null }[],
  interval: number = 100
): FeatureCollection | null {
  const valid = grid.filter(p => p.elevation != null);
  if (valid.length < 4) return null;

  // 计算等高线分级
  const elevations = valid.map(p => p.elevation!);
  const min = Math.min(...elevations);
  const max = Math.max(...elevations);
  const breaks: number[] = [];
  for (let v = Math.ceil(min / interval) * interval; v <= max; v += interval) {
    breaks.push(v);
  }
  if (breaks.length === 0) return null;

  // 去掉 null 后重建均匀网格：取非空点的最小外接矩形，重新插值
  // 为满足 turf.isolines 的均匀网格要求，从这里获取有效点的经纬度范围
  const lngs = valid.map(p => p.lng);
  const lats = valid.map(p => p.lat);
  const [w, e] = [Math.min(...lngs), Math.max(...lngs)];
  const [s, n] = [Math.min(...lats), Math.max(...lats)];

  // 用 ~20x20 的均匀网格保证 isolines 能工作
  const GRID_SIZE = 20;
  const lngStep = (e - w) / GRID_SIZE;
  const latStep = (n - s) / GRID_SIZE;

  // 用 IDW（反距离加权）插值出均匀网格
  const uniformGrid: Feature<Point>[] = [];
  for (let i = 0; i <= GRID_SIZE; i++) {
    for (let j = 0; j <= GRID_SIZE; j++) {
      const lng = w + i * lngStep;
      const lat = s + j * latStep;
      // IDW 插值：取最近的 valid 点加权平均
      let weightSum = 0;
      let elevSum = 0;
      for (const vp of valid) {
        const dx = lng - vp.lng;
        const dy = lat - vp.lat;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const weight = dist < 1e-10 ? 1e10 : 1 / (dist * dist);
        elevSum += vp.elevation! * weight;
        weightSum += weight;
      }
      const elev = weightSum > 0 ? elevSum / weightSum : 0;
      uniformGrid.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [lng, lat] },
        properties: { elevation: Math.round(elev) },
      });
    }
  }

  const points: FeatureCollection<Point> = {
    type: 'FeatureCollection',
    features: uniformGrid,
  };

  try {
    const contours = turf.isolines(points, breaks, { zProperty: 'elevation' });
    if (!contours || !contours.features?.length) return null;

    // 给每条等高线标注高程
    contours.features.forEach((f: any) => {
      if (f.properties) {
        f.properties._contourElevation = f.properties.elevation;
        f.properties.name = `${f.properties.elevation}m`;
      }
    });

    return contours;
  } catch {
    return null;
  }
}

/** 高程→颜色映射 */
export function elevationColor(elevation: number): string {
  if (elevation < 0) return '#1a5276';
  if (elevation < 100) return '#27ae60';
  if (elevation < 300) return '#82e0aa';
  if (elevation < 600) return '#f7dc6f';
  if (elevation < 1000) return '#e67e22';
  if (elevation < 2000) return '#c0392b';
  if (elevation < 3000) return '#8e44ad';
  return '#ecf0f1';
}

// ====== 气象数据（Open-Meteo 免费 API） ======

const WEATHER_API = 'https://api.open-meteo.com/v1/forecast';

export interface WeatherResult {
  description: string;
  current?: {
    temperature: number;
    windspeed: number;
    winddirection: number;
    weathercode: number;
    humidity: number;
    precipitation: number;
  };
  forecast?: {
    date: string;
    tempMax: number;
    tempMin: number;
    weathercode: number;
    precipitation: number;
  }[];
}

const WEATHER_CODES: Record<number, string> = {
  0: '☀️ 晴', 1: '🌤 大部晴', 2: '⛅ 多云', 3: '☁️ 阴',
  45: '🌫 雾', 48: '🌫 霜雾', 51: '🌧 小雨', 53: '🌧 中雨', 55: '🌧 大雨',
  61: '🌧 阵雨', 63: '🌧 中阵雨', 65: '🌧 大阵雨',
  71: '❄️ 小雪', 73: '❄️ 中雪', 75: '❄️ 大雪',
  80: '🌦 雷阵雨', 95: '⛈ 雷暴', 96: '⛈ 冰雹雷暴', 99: '⛈ 强冰雹',
};

function weatherDesc(code: number): string {
  return WEATHER_CODES[code] || `未知(${code})`;
}

/**
 * 查询实时气象（当前 + 7天预报）
 */
export async function queryWeather(lat: number, lng: number): Promise<WeatherResult> {
  try {
    const url = `${WEATHER_API}?latitude=${lat}&longitude=${lng}`
      + '&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m,precipitation'
      + '&daily=temperature_2m_max,temperature_2m_min,weather_code,precipitation_sum'
      + '&timezone=auto&forecast_days=7';

    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();

    const current = {
      temperature: data.current.temperature_2m,
      windspeed: data.current.wind_speed_10m,
      winddirection: data.current.wind_direction_10m,
      weathercode: data.current.weather_code,
      humidity: data.current.relative_humidity_2m,
      precipitation: data.current.precipitation,
    };

    const forecast = data.daily.time.map((date: string, i: number) => ({
      date,
      tempMax: data.daily.temperature_2m_max[i],
      tempMin: data.daily.temperature_2m_min[i],
      weathercode: data.daily.weather_code[i],
      precipitation: data.daily.precipitation_sum[i],
    }));

    const descParts = [
      `🌡 ${current.temperature}°C`,
      `💧 ${current.humidity}%`,
      `🌬 ${current.windspeed}km/h ${windDir(current.winddirection)}`,
      `📋 ${weatherDesc(current.weathercode)}`,
    ];

    return {
      description: `📍 当前气象: ${descParts.join(' | ')}`,
      current,
      forecast,
    };
  } catch (err) {
    return {
      description: `❌ 气象查询失败: ${err instanceof Error ? err.message : '未知错误'}`,
    };
  }
}

function windDir(deg: number): string {
  const dirs = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
  return dirs[Math.round(deg / 45) % 8];
}
