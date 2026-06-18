/**
 * 通用地理工具函数
 * 项目中所有地方使用同一份实现，避免重复定义
 */
import type { FeatureCollection } from 'geojson';

/**
 * 递归展开嵌套坐标数组为 [lng, lat] 对列表
 */
export function flattenCoords(coords: unknown): [number, number][] {
  if (!Array.isArray(coords)) return [];
  if (typeof coords[0] === 'number') {
    return [[coords[0] as number, coords[1] as number]];
  }
  return (coords as unknown[]).flatMap((c) => flattenCoords(c));
}

/**
 * 从 FeatureCollection 提取边界框（嵌套格式）
 * @returns [[west, south], [east, north]] 或 null
 */
export function getFCBounds(
  fc: FeatureCollection
): [[number, number], [number, number]] | null {
  let minLng = Infinity,
    minLat = Infinity,
    maxLng = -Infinity,
    maxLat = -Infinity;

  for (const f of fc.features) {
    const geom = f.geometry as { coordinates?: unknown };
    for (const [lng, lat] of flattenCoords(geom.coordinates)) {
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  }

  return minLng !== Infinity
    ? [
        [minLng, minLat],
        [maxLng, maxLat],
      ]
    : null;
}

/**
 * 从 FeatureCollection 提取边界框（平铺格式）
 * @returns [west, south, east, north] 或 null
 */
export function getFCBbox(
  fc: FeatureCollection
): [number, number, number, number] | null {
  const bounds = getFCBounds(fc);
  if (!bounds) return null;
  return [bounds[0][0], bounds[0][1], bounds[1][0], bounds[1][1]];
}
