/**
 * 灾害数据服务
 * - USGS 全球地震数据（免费）
 * - SRTM 高程数据（通过 MapLibre terrain）
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
 * 简化版等高线：从高程网格生成等值线（marching squares）
 * @param interval 等高距（米）
 */
export function generateContours(
  grid: { lng: number; lat: number; elevation: number | null }[],
  bbox: [number, number, number, number],
  resolution: number = 20,
  interval: number = 100
): ContourLine[] {
  const [w, s, e, n] = bbox;
  const validPoints = grid.filter(p => p.elevation != null);
  if (validPoints.length < 4) return [];

  const minElev = Math.floor(Math.min(...validPoints.map(p => p.elevation!)) / interval) * interval;
  const maxElev = Math.ceil(Math.max(...validPoints.map(p => p.elevation!)) / interval) * interval;
  const contours: ContourLine[] = [];
  const cellW = (e - w) / resolution;
  const cellH = (n - s) / resolution;

  // 对每个等值面生成轮廓线
  for (let elev = minElev; elev <= maxElev; elev += interval) {
    const lines: [number, number][][] = [];
    const visited = new Set<string>();

    // 遍历每个网格单元
    for (let i = 0; i < resolution; i++) {
      for (let j = 0; j < resolution; j++) {
        const idx = (row: number, col: number) => row * (resolution + 1) + col;
        const v = [
          grid[idx(j, i)]?.elevation,     // 左上
          grid[idx(j, i + 1)]?.elevation, // 右上
          grid[idx(j + 1, i + 1)]?.elevation, // 右下
          grid[idx(j + 1, i)]?.elevation, // 左下
        ];

        if (v.some(x => x == null)) continue;

        // marching squares 简化版：4个角点与等值面比较
        const cellX = w + i * cellW;
        const cellY = s + j * cellH;
        const above = v.map(x => x! >= elev);
        const code = (above[0] ? 1 : 0) | (above[1] ? 2 : 0) | (above[2] ? 4 : 0) | (above[3] ? 8 : 0);

        // 只有穿过等值面的单元才处理（0 和 15 表示全在内部或全在外部）
        if (code === 0 || code === 15) continue;

        // 插值找交点
        const interpolate = (a: number | null, b: number | null, ratio: number): number => {
          if (a == null || b == null || Math.abs(b - a) < 1e-6) return ratio;
          return (elev - a) / (b - a);
        };

        const segments: [number, number][][] = [];
        const cx = cellX + cellW / 2;
        const cy = cellY + cellH / 2;
        const leftX = cellX;
        const rightX = cellX + cellW;
        const topY = cellY;
        const bottomY = cellY + cellH;

        const topT = interpolate(v[0], v[1], 0);
        const rightT = interpolate(v[1], v[2], 0);
        const bottomT = interpolate(v[3], v[2], 0);
        const leftT = interpolate(v[0], v[3], 0);

        const topP: [number, number] = [leftX + topT * cellW, topY];
        const rightP: [number, number] = [rightX, topY + rightT * cellH];
        const bottomP: [number, number] = [rightX - bottomT * cellW, bottomY];
        const leftP: [number, number] = [leftX, bottomY - leftT * cellH];

        // 根据 marching squares 模式连接线段
        const pts: [number, number][] = [];
        if (above[0] !== above[1]) pts.push(topP);
        if (above[1] !== above[2]) pts.push(rightP);
        if (above[2] !== above[3]) pts.push(bottomP);
        if (above[3] !== above[0]) pts.push(leftP);

        if (pts.length >= 2) {
          lines.push([pts[0], pts[1]]);
        }
        if (pts.length === 4) {
          lines.push([pts[2], pts[3]]);
        }
      }
    }

    if (lines.length > 0) {
      // 合并相邻线段
      const merged: [number, number][] = [];
      const remaining = [...lines];
      if (remaining.length > 0) {
        merged.push(...remaining.shift()!);
        let changed = true;
        while (changed && remaining.length > 0) {
          changed = false;
          for (let k = remaining.length - 1; k >= 0; k--) {
            const seg = remaining[k];
            const last = merged[merged.length - 1];
            const first = merged[0];
            const dist = (a: [number, number], b: [number, number]) =>
              Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2);

            if (dist(last, seg[0]) < cellW * 0.1) {
              merged.push(seg[1]);
              remaining.splice(k, 1);
              changed = true;
            } else if (dist(last, seg[1]) < cellW * 0.1) {
              merged.push(seg[0]);
              remaining.splice(k, 1);
              changed = true;
            } else if (dist(first, seg[1]) < cellW * 0.1) {
              merged.unshift(seg[0]);
              remaining.splice(k, 1);
              changed = true;
            } else if (dist(first, seg[0]) < cellW * 0.1) {
              merged.unshift(seg[1]);
              remaining.splice(k, 1);
              changed = true;
            }
          }
        }
      }

      if (merged.length >= 2) {
        contours.push({ elevation: elev, coords: merged });
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
