/**
 * 灾害数据服务
 * - USGS 全球地震数据（免费）
 * - SRTM 高程/等高线（通过 MapLibre terrain DEM）
 * - Open-Meteo 气象数据（免费，无需 Key）
 */

import maplibregl from 'maplibre-gl';
import type { FeatureCollection, Feature, Point } from 'geojson';

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
 * 需要地图已开启 terrain
 */
export function queryElevationAtPoint(
  map: maplibregl.Map | null,
  lng: number,
  lat: number
): number | null {
  if (!map) return null;
  try {
    const elev = map.queryTerrainElevation?.([lng, lat]);
    return elev != null ? Math.round(elev) : null;
  } catch {
    return null;
  }
}

/**
 * 采样矩形区域内的高程网格
 */
export function sampleElevationGrid(
  map: maplibregl.Map | null,
  bbox: [number, number, number, number],
  resolution: number = 20
): { lng: number; lat: number; elevation: number | null }[] {
  if (!map) return [];
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

interface ContourLine {
  elevation: number;
  coords: [number, number][];
}

/**
 * 等高线生成：采样网格后用 marching squares 提取等值线
 * @param interval 等高距（米）
 */
export function generateContours(
  grid: { lng: number; lat: number; elevation: number | null }[],
  bbox: [number, number, number, number],
  resolution: number = 40,
  interval: number = 100
): ContourLine[] {
  const [w, s, e, n] = bbox;
  const validPoints = grid.filter(p => p.elevation != null);
  if (validPoints.length < 4) return [];

  const allElevs = validPoints.map(p => p.elevation!);
  const minElev = Math.floor(Math.min(...allElevs) / interval) * interval;
  const maxElev = Math.ceil(Math.max(...allElevs) / interval) * interval;
  const contours: ContourLine[] = [];
  const cellW = (e - w) / resolution;
  const cellH = (n - s) / resolution;
  const N = resolution + 1;

  // 辅助：从 grid (1D) 获取 (col, row) 位置的高程
  // grid 按 (j*N + i) 存储，即 col=i, row=j → grid[j*N + i]
  const getElev = (col: number, row: number): number | null => {
    if (col < 0 || col >= N || row < 0 || row >= N) return null;
    return grid[row * N + col]?.elevation ?? null;
  };

  // 确认 grid 存储顺序与 sampleElevationGrid 一致 (col major: i→col, j→row)
  // sampleElevationGrid: for i=0..resolution (col) for j=0..resolution (row) push({lng,lat,elev})
  // 存储顺序: (0,0),(0,1),...,(0,N),(1,0),... → index = row*N + col ✓

  // 对每个高程等值面
  for (let elev = minElev; elev <= maxElev; elev += interval) {
    const segments: [number, number][][] = [];

    for (let i = 0; i < resolution; i++) {
      for (let j = 0; j < resolution; j++) {
        const v00 = getElev(i, j);
        const v10 = getElev(i + 1, j);
        const v11 = getElev(i + 1, j + 1);
        const v01 = getElev(i, j + 1);
        if (v00 == null || v10 == null || v11 == null || v01 == null) continue;

        const a = [v00 >= elev, v10 >= elev, v11 >= elev, v01 >= elev];
        const code = (a[0] ? 1 : 0) | (a[1] ? 2 : 0) | (a[2] ? 4 : 0) | (a[3] ? 8 : 0);
        if (code === 0 || code === 15) continue;

        const lerp = (va: number, vb: number): number => {
          if (Math.abs(vb - va) < 1) return 0.5;
          return Math.max(0, Math.min(1, (elev - va) / (vb - va)));
        };

        const cx = w + i * cellW;
        const cy = s + j * cellH;
        const rx = cx + cellW;
        const by = cy + cellH;

        // 四边交点 (top, right, bottom, left)
        const pt: Record<string, [number, number]> = {
          top:    [cx + lerp(v00, v10) * cellW, cy],
          right:  [rx, cy + lerp(v10, v11) * cellH],
          bottom: [rx - lerp(v01, v11) * cellW, by],
          left:   [cx, by - lerp(v00, v01) * cellH],
        };

        // 标准 marching squares 16 cases 线段连接表
        // a[0]=tl, a[1]=tr, a[2]=br, a[3]=bl; code = Σ bit_i
        const pairs: [string, string][] = [];
        switch (code) {
          case 0: case 15: break; // 全下/全上，无线段
          case 1: case 14: pairs.push(['left',  'top']);    break;
          case 2: case 13: pairs.push(['top',   'right']);  break;
          case 3: case 12: pairs.push(['left',  'right']);  break;
          case 4: case 11: pairs.push(['right', 'bottom']); break;
          case 5: pairs.push(['top','left'], ['bottom','right']); break;
          case 6: case 9:  pairs.push(['top',   'bottom']); break;
          case 7: case 8:  pairs.push(['left',  'bottom']); break;
          case 10: pairs.push(['top','right'], ['bottom','left']); break;
        }
        for (const [k1, k2] of pairs) {
          segments.push([pt[k1], pt[k2]]);
        }
      }
    }

    if (segments.length === 0) continue;

    // 简单合并：距离 < 两倍 cell 的视为相邻
    const threshold = Math.max(cellW, cellH) * 3;
    const dist = (a: [number, number], b: [number, number]) =>
      Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2);

    const used = new Set<number>();
    for (let si = 0; si < segments.length; si++) {
      if (used.has(si)) continue;
      const chain = [...segments[si]];
      used.add(si);
      let grown = true;
      while (grown) {
        grown = false;
        for (let sj = 0; sj < segments.length; sj++) {
          if (used.has(sj)) continue;
          if (dist(chain[chain.length - 1], segments[sj][0]) < threshold) {
            chain.push(segments[sj][1]);
            used.add(sj);
            grown = true;
          } else if (dist(chain[chain.length - 1], segments[sj][1]) < threshold) {
            chain.push(segments[sj][0]);
            used.add(sj);
            grown = true;
          } else if (dist(chain[0], segments[sj][1]) < threshold) {
            chain.unshift(segments[sj][0]);
            used.add(sj);
            grown = true;
          } else if (dist(chain[0], segments[sj][0]) < threshold) {
            chain.unshift(segments[sj][1]);
            used.add(sj);
            grown = true;
          }
        }
      }
      if (chain.length >= 2) {
        contours.push({ elevation: elev, coords: chain });
      }
    }
  }

  return contours;
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
