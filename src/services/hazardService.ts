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
  resolution: number = 10
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
