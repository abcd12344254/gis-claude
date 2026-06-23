/**
 * 坐标系转换工具
 * WGS-84（国际标准）↔ GCJ-02（火星坐标，高德/国内地图使用）
 * 算法移植自 server/main.py gcj02_to_wgs84，双向转换
 */

const PI = Math.PI;
const A = 6378245.0;
const EE = 0.00669342162296594323;

function transformLat(x: number, y: number): number {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(y * PI) + 40.0 * Math.sin((y / 3.0) * PI)) * 2.0) / 3.0;
  ret += ((160.0 * Math.sin((y / 12.0) * PI) + 320.0 * Math.sin((y * PI) / 30.0)) * 2.0) / 3.0;
  return ret;
}

function transformLng(x: number, y: number): number {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(x * PI) + 40.0 * Math.sin((x / 3.0) * PI)) * 2.0) / 3.0;
  ret += ((150.0 * Math.sin((x / 12.0) * PI) + 300.0 * Math.sin((x / 30.0) * PI)) * 2.0) / 3.0;
  return ret;
}

function delta(lng: number, lat: number): [number, number] {
  const dlat = transformLat(lng - 105.0, lat - 35.0);
  const dlng = transformLng(lng - 105.0, lat - 35.0);
  const radlat = (lat / 180.0) * PI;
  let magic = Math.sin(radlat);
  magic = 1 - EE * magic * magic;
  const sqrtmagic = Math.sqrt(magic);
  const dlatFinal = (dlat * 180.0) / (((A * (1 - EE)) / (magic * sqrtmagic)) * PI);
  const dlngFinal = (dlng * 180.0) / ((A / sqrtmagic) * Math.cos(radlat) * PI);
  return [dlngFinal, dlatFinal];
}

/** WGS-84 → GCJ-02（国际标准 → 火星坐标） */
export function wgs84ToGcj02(lng: number, lat: number): [number, number] {
  if (lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271) {
    // 不在中国大陆范围，不转换
    return [lng, lat];
  }
  const [dlng, dlat] = delta(lng, lat);
  return [lng + dlng, lat + dlat];
}

/** GCJ-02 → WGS-84（火星坐标 → 国际标准） */
export function gcj02ToWgs84(lng: number, lat: number): [number, number] {
  if (lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271) {
    return [lng, lat];
  }
  const [dlng, dlat] = delta(lng, lat);
  return [lng - dlng, lat - dlat];
}

/** 判断当前底图 URL 是否为 GCJ-02 坐标系 */
export function isGCJ02Basemap(url: string): boolean {
  return url.includes('autonavi.com');
}

/**
 * 深度转换 GeoJSON 中所有坐标
 * 原地修改（clones first）
 */
export function transformGeoJSONCoords(
  geojson: any,
  transform: (lng: number, lat: number) => [number, number]
): any {
  if (!geojson) return geojson;

  function walk(coords: any): any {
    if (typeof coords[0] === 'number') {
      // 这是一个坐标点 [lng, lat] 或 [lng, lat, alt]
      const [lng, lat] = transform(coords[0], coords[1]);
      const result = [lng, lat];
      if (coords.length > 2) result.push(coords[2]); // 保留海拔
      return result;
    }
    // 递归处理每一层
    return coords.map((item: any) => walk(item));
  }

  const cloned = JSON.parse(JSON.stringify(geojson));

  if (cloned.type === 'FeatureCollection' && Array.isArray(cloned.features)) {
    for (const f of cloned.features) {
      if (f.geometry && f.geometry.coordinates) {
        f.geometry.coordinates = walk(f.geometry.coordinates);
      }
    }
  } else if (cloned.geometry && cloned.geometry.coordinates) {
    cloned.geometry.coordinates = walk(cloned.geometry.coordinates);
  }

  return cloned;
}
