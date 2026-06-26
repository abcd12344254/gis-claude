/**
 * 高德地图 API 服务
 * 国内地理编码 + POI 搜索，OSM 无法覆盖时的补偿数据源
 */
import type { FeatureCollection } from 'geojson';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '';
const GAODE_GEOCODE_URL = `${API_BASE}/api/gaode/geocode`;
const GAODE_POI_URL = `${API_BASE}/api/gaode/poi`;

/** 高德返回的单个地理编码结果 */
interface GaodeGeocode {
  formatted_address: string;
  country: string;
  province: string;
  city: string;
  district: string;
  location: string;      // GCJ-02 "lng,lat"（与高德底图对齐）
  level: string;
}

/** 高德返回的单个 POI 结果 */
interface GaodePOI {
  id: string;
  name: string;
  type: string;
  address: string;
  location: string;       // GCJ-02（与高德底图对齐）
  pname: string;
  cityname: string;
  adname: string;
}

/**
 * 将高德结果转换为 GeoJSON FeatureCollection
 */
function gaodeToGeoJSON(
  results: { lng: number; lat: number; name: string; address?: string; source: string }[]
): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: results.map((r) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [r.lng, r.lat] },
      properties: { name: r.name, address: r.address || '', source: r.source },
    })),
  };
}

/**
 * 高德地理编码：地名 → GeoJSON
 */
export async function gaodeGeocode(
  query: string,
  city?: string,
  location?: [number, number]
): Promise<{
  geojson: FeatureCollection | null;
  label: string;
  description: string;
}> {
  try {
    const params = new URLSearchParams({ address: query });
    if (city) params.set('city', city);
    if (location) params.set('location', `${location[0]},${location[1]}`);

    const resp = await fetch(`${GAODE_GEOCODE_URL}?${params}`);
    if (!resp.ok) {
      return { geojson: null, label: query, description: `高德地理编码不可用 (${resp.status})` };
    }

    const data = await resp.json();
    if (data.status !== '1' || !data.geocodes || data.geocodes.length === 0) {
      return { geojson: null, label: query, description: `高德未找到"${query}"` };
    }

    const geocode: GaodeGeocode = data.geocodes[0];
    const [lng, lat] = geocode.location.split(',').map(Number);

    const geojson = gaodeToGeoJSON([{
      lng, lat,
      name: geocode.formatted_address || query,
      address: geocode.formatted_address,
      source: 'gaode',
    }]);

    return {
      geojson,
      label: geocode.formatted_address || query,
      description: `✓ 从高德地图找到"${geocode.formatted_address || query}"`,
    };
  } catch {
    return { geojson: null, label: query, description: '高德地理编码请求失败' };
  }
}

/**
 * 高德 POI 搜索 → GeoJSON
 */
export async function gaodePOISearch(
  keywords: string,
  city?: string,
  limit: number = 10
): Promise<{
  geojson: FeatureCollection | null;
  label: string;
  description: string;
}> {
  try {
    const params = new URLSearchParams({ keywords, offset: String(limit) });
    if (city) params.set('city', city);

    const resp = await fetch(`${GAODE_POI_URL}?${params}`);
    if (!resp.ok) {
      return { geojson: null, label: keywords, description: `高德POI搜索不可用 (${resp.status})` };
    }

    const data = await resp.json();
    if (data.status !== '1' || !data.pois || data.pois.length === 0) {
      return { geojson: null, label: keywords, description: `高德未找到"${keywords}"的POI` };
    }

    const results = (data.pois as GaodePOI[]).map((poi) => {
      const [lng, lat] = poi.location.split(',').map(Number);
      return { lng, lat, name: poi.name, address: poi.address, source: 'gaode' };
    });

    return {
      geojson: gaodeToGeoJSON(results),
      label: `${keywords} (高德POI)`,
      description: `✓ 从高德地图找到 ${results.length} 个"${keywords}"POI`,
    };
  } catch {
    return { geojson: null, label: keywords, description: '高德POI搜索请求失败' };
  }
}
