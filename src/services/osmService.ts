/**
 * OpenStreetMap 数据服务
 * 通过 Nominatim (地理编码) + Overpass API (空间查询) 获取真实地理数据
 * 免费、无需 API Key
 */
import { gaodeGeocode, gaodePOISearch } from './gaodeService';
import type { FeatureCollection, Feature, Polygon, MultiPolygon, Point } from 'geojson';
import { flattenCoords, getFCBbox } from '../utils/geo';

// 使用 Python 后端代理 OSM API（解决 CORS + 国内网络问题）
// Python httpx 支持 HTTPS_PROXY 环境变量翻墙
const NOMINATIM_URL = '/api/osm/nominatim';
const OVERPASS_URL = '/api/osm/overpass';

/** 查询结果 */
export interface OSMQueryResult {
  type: 'boundary' | 'poi' | 'building' | 'road' | 'water' | 'green' | 'custom' | 'outline';
  label: string;
  geojson: FeatureCollection | null;
  description: string;
  error?: string;
}

// ====== Nominatim 地理编码 ======

interface NominatimResult {
  place_id: number;
  osm_type: string;
  osm_id: number;
  lat: string;
  lon: string;
  display_name: string;
  boundingbox: [string, string, string, string]; // [south, north, west, east]
  type: string;
  class: string;
  importance: number;
  geojson?: {
    type: string;
    coordinates: unknown;
  };
  extratags?: Record<string, string>; // wikidata, wikipedia, etc.
}

/**
 * 地名 → 坐标查询
 */
export async function geocodeSearch(query: string): Promise<NominatimResult[]> {
  const params = new URLSearchParams({
    q: query,
    format: 'jsonv2',
    limit: '5',
    addressdetails: '1',
    polygon_geojson: '1',
    extratags: '1',
    'accept-language': 'zh',
  });

  // 通过 Python 后端代理（解决 CORS 和国内网络问题）
  const response = await fetch(`${NOMINATIM_URL}/search?${params}`);

  if (!response.ok) {
    throw new Error(`Nominatim 查询失败: ${response.status}`);
  }

  return response.json();
}

// ====== Overpass API 空间查询 ======

/**
 * 执行 Overpass QL 查询
 */
export async function overpassQuery(query: string, retryOnTimeout = true): Promise<FeatureCollection> {
  const doFetch = async () => {
    const response = await fetch(`${OVERPASS_URL}?data=${encodeURIComponent(query)}`, {
      method: 'POST',
    });
    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`Overpass 查询失败 (${response.status}): ${errText}`);
    }
    return response.json();
  };

  try {
    const data = await doFetch();
    return osmToGeoJSON(data);
  } catch (err) {
    // 504 超时自动重试一次（Overpass 冷查询慢但热缓存快）
    const is504 = err instanceof Error &&
      (err.message.includes('504') || err.message.includes('Timeout'));
    if (retryOnTimeout && is504) {
      console.log('[Overpass] 首次查询超时，等待 3 秒后重试（通常第二次命中缓存）...');
      await new Promise(resolve => setTimeout(resolve, 3000));
      const data = await doFetch();
      return osmToGeoJSON(data);
    }
    throw err;
  }
}

/**
 * 用 Overpass 查询简写语法
 */
export async function overpassQueryShort(query: string): Promise<FeatureCollection> {
  const fullQuery = `[out:json][timeout:25];\n${query}\nout body;\n>;\nout skel qt;`;

  const response = await fetch(`${OVERPASS_URL}?data=${encodeURIComponent(fullQuery)}`, {
    method: 'POST',
  });

  if (!response.ok) {
    throw new Error(`Overpass 查询失败: ${response.status}`);
  }

  const data = await response.json();
  return osmToGeoJSON(data);
}

// ====== 预置查询模板 ======

/**
 * 查询行政区边界（自动选合适的 admin_level）
 * 中国: admin_level=4省 5市 6区县 8乡镇 10村
 */
export async function queryBoundary(
  placeName: string
): Promise<OSMQueryResult> {
  try {
    // 1. 先地理编码
    const geoResults = await geocodeSearch(placeName);
    if (geoResults.length === 0) {
      return {
        type: 'boundary',
        label: placeName,
        geojson: null,
        description: `未找到"${placeName}"的位置信息`,
        error: 'NOT_FOUND',
      };
    }

    const best = geoResults[0];
    const [s, n, w, e] = best.boundingbox.map(Number);

    // 2. 根据类型推断 admin_level
    let adminLevel = 8; // 默认区县级
    if (best.type === 'administrative') {
      if (best.osm_type === 'relation') {
        const areaDeg = (e - w) * (n - s);
        if (areaDeg > 30) adminLevel = 2;    // 国家
        else if (areaDeg > 3) adminLevel = 4;  // 省/自治区（台湾≈7, 海南≈3.5）
        else if (areaDeg > 0.5) adminLevel = 5; // 地级市
        else if (areaDeg > 0.05) adminLevel = 6; // 区县
        else if (areaDeg > 0.005) adminLevel = 8; // 乡镇
        else adminLevel = 10; // 村
      }
    }

    // 3. 查询边界
    const geojson = await queryBoundaryByAdminLevel(placeName, adminLevel, best);

    const typeLabels: Record<number, string> = {
      2: '国家', 3: '地区', 4: '省/直辖市', 5: '地级市', 6: '区/县', 8: '乡镇/街道', 10: '村/社区',
    };

    return {
      type: 'boundary',
      label: `${placeName} (${typeLabels[adminLevel] || `admin_level=${adminLevel}`})`,
      geojson,
      description: `✓ 已找到"${best.display_name}"的边界数据`,
    };
  } catch (err) {
    return {
      type: 'boundary',
      label: placeName,
      geojson: null,
      description: '查询失败',
      error: err instanceof Error ? err.message : '未知错误',
    };
  }
}

// ====== 带超时的 fetch ======

function fetchWithTimeout(url: string, timeoutMs: number = 8000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

// ====== 自然地理要素类型推断 ======

/** 根据 Nominatim 结果推断要素的中文类型标签 */
// 非地理类型的 Nominatim 结果（公司/商铺/住宅等），应跳过
// 注意：amenity（大学/医院/图书馆等）和 tourism（景点）是有效的 GIS 查询目标，已从排除列表移除
const NON_GEO_CATEGORIES = new Set([
  'landuse', 'building', 'office', 'shop', 'craft',
]);
const NON_GEO_TYPES = new Set([
  'industrial', 'commercial', 'office', 'retail', 'house', 'apartments',
  'hotel', 'restaurant', 'cafe', 'supermarket', 'warehouse',
]);

/** 判断 Nominatim 结果是否像真实的地理要素（而非公司/建筑等） */
function isRealGeoFeature(r: NominatimResult): boolean {
  // 高 importance 的结果通常是真正的地理要素
  if (r.importance > 0.3) return true;
  // 类别是地理类
  if (!NON_GEO_CATEGORIES.has(r.class || '') && !NON_GEO_TYPES.has(r.type)) return true;
  // OSM relation/way 且有有效名称 → 可能是地理要素
  if ((r.osm_type === 'relation' || r.osm_type === 'way') && r.importance > 0.15) return true;
  return false;
}

function inferFeatureLabel(r: NominatimResult): string {
  const t = r.type;
  const cls = r.class || '';
  if (t === 'administrative') return '行政区';
  if (t === 'desert' || cls === 'desert') return '沙漠';
  if (t === 'mountain_range' || cls === 'mountain_range' || t === 'mountain' || cls === 'mountain') return '山脉';
  if (t === 'plateau' || cls === 'plateau') return '高原';
  if (t === 'plain' || cls === 'plain') return '平原';
  if (t === 'basin' || cls === 'basin') return '盆地';
  if (t === 'valley' || cls === 'valley') return '河谷';
  if (t === 'lake' || cls === 'lake') return '湖泊';
  if (t === 'water' || cls === 'water' || cls === 'waterway') return '水域';
  if (t === 'sea' || cls === 'sea') return '海洋';
  if (t === 'river' || cls === 'river') return '河流';
  if (t === 'forest' || cls === 'forest' || cls === 'wood' || t === 'wood') return '林地';
  if (t === 'park' || cls === 'park') return '公园';
  if (t === 'island' || cls === 'island') return '岛屿';
  if (t === 'peninsula' || cls === 'peninsula') return '半岛';
  if (t === 'bay' || cls === 'bay') return '海湾';
  if (t === 'glacier' || cls === 'glacier') return '冰川';
  if (t === 'wetland' || cls === 'wetland') return '湿地';
  if (t === 'reef' || cls === 'reef') return '礁石';
  if (t === 'natural' || cls === 'natural') return '自然地物';
  if (t === 'region' || cls === 'region') return '区域';
  return '地理要素';
}

/**
 * 通用地理要素查询（多级回退引擎）
 *
 * 策略1: Nominatim → OSM ID → Overpass (最快，适用于有明确 OSM 要素的)
 * 策略2: Overpass 直接名称搜索（适用于 Nominatim 只返回点的大面积自然地物）
 * 策略3: Nominatim bbox → Overpass 区域内名称+标签搜索
 * 策略4: 返回 bbox 近似区域（最终回退）
 */
export async function queryFeature(
  placeName: string
): Promise<OSMQueryResult> {
  // 全局 30 秒超时：超时直接返回快速近似结果
  const TIMEOUT_MS = 30000;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<OSMQueryResult>((resolve) => {
    timeoutId = setTimeout(() => {
      resolve({
        type: 'custom',
        label: placeName,
        geojson: null,
        description: `⏱ 查询超时。"${placeName}"可能数据量过大或网络较慢，请尝试更具体的地名`,
        error: 'TIMEOUT',
      });
    }, TIMEOUT_MS);
  });

  const queryPromise = (async (): Promise<OSMQueryResult> => {
  // ====== 策略1: Nominatim + OSM ID (遍历所有结果，跳过非地理要素) ======
  try {
    const geoResults = await geocodeSearch(placeName);
    if (geoResults.length === 0) {
      return {
        type: 'custom', label: placeName, geojson: null,
        description: `未找到"${placeName}"的位置信息，请尝试更具体的地名`,
        error: 'NOT_FOUND',
      };
    }

    // 分离地理要素和非地理要素（公司/建筑等）
    const geoFeatures = geoResults.filter(isRealGeoFeature);
    const bestGeo = geoFeatures.length > 0 ? geoFeatures[0] : null;
    // 总是保留第一个 Nominatim 结果用于 bbox/label 回退
    const best = bestGeo || geoResults[0];
    const [s, n, w, e] = best.boundingbox.map(Number);
    const typeLabel = inferFeatureLabel(best);

    // 策略1: 用 OSM ID 精确查询 — 先用 bestGeo，回退到 best（含 amenity POI）
    const queryTarget = bestGeo || best;
    if (queryTarget.osm_type === 'relation' && queryTarget.osm_id) {
      try {
        const query = `[out:json][timeout:25];
rel(${queryTarget.osm_id});
out geom;`;
        const geojson = await overpassQuery(query);
        if (geojson.features.length > 0) {
          return {
            type: 'custom',
            label: `${queryTarget.display_name} (${typeLabel})`,
            geojson,
            description: `✓ 已找到"${queryTarget.display_name}"的${typeLabel}数据 (${geojson.features.length}个要素)`,
          };
        }
      } catch { /* ID查失败，继续 */ }
    }

    if (queryTarget.osm_type === 'way' && queryTarget.osm_id) {
      try {
        const query = `[out:json][timeout:25];
way(${queryTarget.osm_id});
out geom;`;
        const geojson = await overpassQuery(query);
        if (geojson.features.length > 0) {
          return {
            type: 'custom',
            label: `${queryTarget.display_name} (${typeLabel})`,
            geojson,
            description: `✓ 已找到"${queryTarget.display_name}"的${typeLabel}数据`,
          };
        }
      } catch { /* ID查失败 */ }
    }

    // node 类型（大学、医院等 POI 常以 node 存在）：查询节点 + 关联的 way/rel
    if (queryTarget.osm_type === 'node' && queryTarget.osm_id) {
      try {
        const nodeQuery = `[out:json][timeout:25];
node(${queryTarget.osm_id});
out body;`;
        const nodeResult = await overpassQuery(nodeQuery);
        if (nodeResult.features.length > 0) {
          return {
            type: 'custom',
            label: `${queryTarget.display_name} (${typeLabel})`,
            geojson: nodeResult,
            description: `✓ 已找到"${queryTarget.display_name}"的位置标记 (${nodeResult.features.length}个要素)`,
          };
        }
      } catch { /* node查失败 */ }
    }

    // ====== 策略2: Overpass 直接名称+Wikidata搜索 ======
    // 很多自然地物没有专用 relation，但有 wikidata/wikipedia 标签
    try {
      const escapedName = placeName.replace(/['"\\]/g, '');
      // 搜索名称匹配或 wikidata 标签匹配
      const nameQuery = `[out:json][timeout:25];
(
  rel["name"="${escapedName}"];
  rel["name:zh"="${escapedName}"];
  rel["alt_name"="${escapedName}"];
  rel["alt_name:zh"="${escapedName}"];
  rel["name:en"="${escapedName}"];
  rel["official_name"="${escapedName}"];
  rel["int_name"="${escapedName}"];
  way["name"="${escapedName}"];
  way["name:zh"="${escapedName}"];
  way["name:en"="${escapedName}"];
);
out geom;`;

      const nameResult = await overpassQuery(nameQuery);
      if (nameResult.features.length > 0) {
        return {
          type: 'custom',
          label: `${placeName} (${typeLabel})`,
          geojson: nameResult,
          description: `✓ 通过名称匹配找到"${placeName}"的${typeLabel}数据 (${nameResult.features.length}个要素)`,
        };
      }
    } catch { /* 策略2失败 */ }

    // ====== 策略2b: 扩大 bbox 后做 Overpass 区域搜索 ======
    try {
      const padLng = Math.max((e - w) * 0.5, 2); // 至少扩2度（大区域）
      const padLat = Math.max((n - s) * 0.5, 2);
      const expandedBbox = [
        Math.max(-180, w - padLng), Math.max(-90, s - padLat),
        Math.min(180, e + padLng),  Math.min(90, n + padLat),
      ];
      const [sw, ss, se, sn] = expandedBbox;

      const escapedName = placeName.replace(/['"\\]/g, '');
      const areaQuery = `[out:json][timeout:25];
(
  rel["name"="${escapedName}"](${ss},${sw},${sn},${se});
  rel["name:zh"="${escapedName}"](${ss},${sw},${sn},${se});
  rel["name:en"="${escapedName}"](${ss},${sw},${sn},${se});
  way["name"="${escapedName}"](${ss},${sw},${sn},${se});
  way["name:zh"="${escapedName}"](${ss},${sw},${sn},${se});
);
out geom;`;

      const areaResult = await overpassQuery(areaQuery);
      if (areaResult.features.length > 0) {
        return {
          type: 'custom',
          label: `${placeName} (${typeLabel})`,
          geojson: areaResult,
          description: `✓ 在"${best.display_name}"周边找到 ${areaResult.features.length} 个匹配要素`,
        };
      }
    } catch { /* 策略2b失败 */ }

    // ====== 策略2c: 模糊名称搜索（拆分关键词） ======
    // 例如"华北平原"可能存为 "华北" + "平原" 的组合
    try {
      // 提取核心地名（去掉后缀如"平原""山脉""沙漠""高原"等）
      const suffixPattern = /(平原|高原|盆地|沙漠|山脉|丘陵|草原|沼泽|戈壁|森林|湖泊|海洋|海湾|半岛|岛屿|冰川|湿地|绿洲)$/;
      const coreName = placeName.replace(suffixPattern, '').trim();
      if (coreName.length >= 2 && coreName !== placeName) {
        const fuzzyQuery = `[out:json][timeout:25];
(
  rel["name"~"${coreName}"];
  rel["name:zh"~"${coreName}"];
);
out geom;`;

        const fuzzyResult = await overpassQuery(fuzzyQuery);
        if (fuzzyResult.features.length > 0 && fuzzyResult.features.length <= 50) {
          return {
            type: 'custom',
            label: `${placeName} (${typeLabel})`,
            geojson: fuzzyResult,
            description: `✓ 通过核心词"${coreName}"搜索到 ${fuzzyResult.features.length} 个要素，可能是"${placeName}"的组成部分`,
          };
        }
      }
    } catch { /* 策略2c失败 */ }

    // ====== 策略2d: Wikidata 搜索 API (按名称查找实体ID) → OSM ======
    // 很多大型自然地物（华北平原、东北平原等）在OSM中仅为点，
    // 但 Wikidata 中有完整实体，可通过 wikidata=* 标签关联到 OSM relation
    try {
      const wdSearchUrl = `/api/wikidata/search?q=${encodeURIComponent(placeName)}&language=zh&limit=3`;
      const wdSearchResp = await fetchWithTimeout(wdSearchUrl, 8000);
      if (wdSearchResp.ok) {
        const wdSearchData = await wdSearchResp.json();
        const entities = wdSearchData.search || [];
        for (const entity of entities) {
          const qid = entity.id; // e.g., "Q2421217"
          // 用 Wikidata ID 反向搜 OSM
          try {
            const osmWdQuery = `[out:json][timeout:25];
(
  rel["wikidata"="${qid}"];
  way["wikidata"="${qid}"];
);
out geom;`;
            const osmWdResult = await overpassQuery(osmWdQuery);
            if (osmWdResult.features.length > 0) {
              return {
                type: 'custom',
                label: `${entity.label || placeName} (${entity.description || typeLabel})`,
                geojson: osmWdResult,
                description: `✓ 通过Wikidata(${qid})找到精确${typeLabel}数据 (${osmWdResult.features.length}个要素)`,
              };
            }
          } catch { /* 这个实体无OSM几何，试下一个 */ }
        }
      }
    } catch { /* Wikidata搜索不可用或网络不通 */ }

    // ====== 策略2e: Wikidata 搜索 → Wikidata 坐标 → 点标记 ======
    try {
      const wdSearchUrl2 = `/api/wikidata/search?q=${encodeURIComponent(placeName)}&language=zh&limit=1`;
      const wdSearchResp2 = await fetchWithTimeout(wdSearchUrl2, 8000);
      if (wdSearchResp2.ok) {
        const wdSearchData2 = await wdSearchResp2.json();
        const topEntity = wdSearchData2.search?.[0];
        if (topEntity) {
          const wdEntityUrl = `/api/wikidata/entity/${topEntity.id}`;
          const wdEntityResp = await fetchWithTimeout(wdEntityUrl, 8000);
          if (wdEntityResp.ok) {
            const wdEntityData = await wdEntityResp.json();
            const entity = wdEntityData.entities?.[topEntity.id];
            const p625 = entity?.claims?.P625;
            if (p625 && p625.length > 0) {
              const val = p625[0].mainsnak?.datavalue?.value;
              if (val?.latitude != null) {
                const wdPoint: FeatureCollection = {
                  type: 'FeatureCollection',
                  features: [{
                    type: 'Feature',
                    geometry: { type: 'Point', coordinates: [val.longitude, val.latitude] },
                    properties: {
                      name: topEntity.label || placeName,
                      description: topEntity.description || '',
                      source: 'wikidata',
                      wikidata: topEntity.id,
                    },
                  }],
                };
                return {
                  type: 'custom',
                  label: `${topEntity.label || placeName} (${typeLabel}·Wikidata)`,
                  geojson: wdPoint,
                  description: `⚠️ 从Wikidata获取到"${topEntity.label || placeName}"(${topEntity.id})坐标点。${topEntity.description || ''}。OSM中无面状几何数据`,
                };
              }
            }
          }
        }
      }
    } catch { /* Wikidata不可用 */ }

    // ====== 策略3: Nominatim extratags Wikidata → OSM ======
    // 很多自然地物有 wikidata 标签，但 OSM 中的关系可能用 wikidata=* 标记
    const wikidataId = best.extratags?.wikidata;
    if (wikidataId) {
      try {
        const wdQuery = `[out:json][timeout:25];
(
  rel["wikidata"="${wikidataId}"];
  way["wikidata"="${wikidataId}"];
);
out geom;`;
        const wdResult = await overpassQuery(wdQuery);
        if (wdResult.features.length > 0) {
          return {
            type: 'custom',
            label: `${placeName} (${typeLabel})`,
            geojson: wdResult,
            description: `✓ 通过Wikidata(${wikidataId})找到"${placeName}"的精确${typeLabel}数据 (${wdResult.features.length}个要素)`,
          };
        }
      } catch { /* 策略3失败 */ }

      // ====== 策略3b: Wikidata API 直接获取坐标 ======
      try {
        const wdApiUrl = `/api/wikidata/entity/${wikidataId}`;
        const wdResp = await fetchWithTimeout(wdApiUrl, 8000);
        if (wdResp.ok) {
          const wdData = await wdResp.json();
          const entity = wdData.entities?.[wikidataId];
          if (entity?.claims?.P625) {
            // P625 = 坐标位置 (coordinate location)
            const coords = entity.claims.P625.map((c: any) => ({
              lat: c.mainsnak?.datavalue?.value?.latitude,
              lon: c.mainsnak?.datavalue?.value?.longitude,
            })).filter((c: any) => c.lat != null);

            if (coords.length > 0) {
              const wdPoint: FeatureCollection = {
                type: 'FeatureCollection',
                features: [{
                  type: 'Feature',
                  geometry: { type: 'Point', coordinates: [coords[0].lon, coords[0].lat] },
                  properties: { name: placeName, source: 'wikidata', wikidata: wikidataId },
                }],
              };
              return {
                type: 'custom',
                label: `${placeName} (${typeLabel}·Wikidata)`,
                geojson: wdPoint,
                description: `⚠️ 已从Wikidata获取"${placeName}"坐标点，OSM中无对应面状几何`,
              };
            }
          }
        }
      } catch { /* 策略3b失败 */ }
    }

    // ====== 策略3c: Wikipedia 标题 → OSM ======
    // Nominatim 有时返回 wikipedia=lang:Title 格式
    const wikipediaTag = best.extratags?.wikipedia;
    if (wikipediaTag) {
      try {
        // wikipedia tag 格式: "zh:华北平原" 或 "en:North China Plain"
        const wpTitle = wikipediaTag.includes(':')
          ? wikipediaTag.split(':').slice(1).join(':')
          : wikipediaTag;
        const wpQuery = `[out:json][timeout:25];
(
  rel["wikipedia"="${wikipediaTag}"];
  rel["name"]="${wpTitle}"];
  way["wikipedia"="${wikipediaTag}"];
);
out geom;`;
        const wpResult = await overpassQuery(wpQuery);
        if (wpResult.features.length > 0) {
          return {
            type: 'custom',
            label: `${placeName} (${typeLabel})`,
            geojson: wpResult,
            description: `✓ 通过Wikipedia标签找到"${placeName}"的${typeLabel}数据 (${wpResult.features.length}个要素)`,
          };
        }
      } catch { /* 策略3c失败 */ }
    }

    // ====== 策略3d: Wikidata 直查（不依赖 Nominatim extratags） ======
    // 针对中国大学/医院等 POI：Nominatim 可能不返回 extratags.wikidata
    // 但 Wikidata 本身有很好的实体覆盖，直接用名称搜索
    try {
      const wdSearchUrl = `/api/wikidata/search?q=${encodeURIComponent(placeName)}&language=zh&limit=3`;
      const wdResp = await fetchWithTimeout(wdSearchUrl, 8000);
      if (wdResp.ok) {
        const wdData = await wdResp.json();
        const entities = wdData.search || [];
        for (const entity of entities) {
          const entityUrl = `/api/wikidata/entity/${entity.id}`;
          try {
            const entResp = await fetchWithTimeout(entityUrl, 8000);
            if (!entResp.ok) continue;
            const entData = await entResp.json();
            const ent = entData.entities?.[entity.id];
            if (!ent) continue;
            // 优先用 P625 坐标
            const p625 = ent.claims?.P625;
            if (p625 && p625[0]?.mainsnak?.datavalue?.value?.latitude != null) {
              const val = p625[0].mainsnak.datavalue.value;
              return {
                type: 'custom',
                label: `${entity.label || placeName} (${entity.description || 'POI'}·Wikidata)`,
                geojson: { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [val.longitude, val.latitude] }, properties: { name: entity.label || placeName, source: 'wikidata', wikidata: entity.id } }] },
                description: `✓ 从Wikidata获取"${entity.label || placeName}"坐标${entity.description ? ` (${entity.description})` : ''}`,
              };
            }
          } catch { /* 单个实体失败，试下一个 */ }
        }
      }
    } catch { /* Wikidata直查不可用 */ }

    // ====== 策略4: 智能近似区域 ======
    // 根据要素类型和 Nominatim 数据构造有意义的近似范围
    const bboxWidth = e - w;
    const bboxHeight = n - s;
    const isPointBbox = bboxWidth < 0.01 && bboxHeight < 0.01;

    let approxW = w, approxS = s, approxE = e, approxN = n;

    if (isPointBbox) {
      // Nominatim 只返回了一个点（很多大面积自然地物如此）
      // 根据要素重要性和类型推断合理范围
      const centerLng = parseFloat(best.lon);
      const centerLat = parseFloat(best.lat);

      // 重要自然区域：按重要性扩展（importance 0.3-0.7 是常见区间）
      // 省级行政区 importance ≈ 0.6-0.7，市级 ≈ 0.5-0.6，地标 ≈ 0.3-0.5
      const expansionDeg = best.importance > 0.5 ? 3.0 :
                           best.importance > 0.4 ? 1.5 :
                           best.importance > 0.3 ? 0.8 : 0.3;
      approxW = centerLng - expansionDeg;
      approxE = centerLng + expansionDeg;
      approxS = centerLat - expansionDeg * 0.7; // 纬度方向略窄
      approxN = centerLat + expansionDeg * 0.7;
    }

    const bboxPolygon: FeatureCollection = {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          coordinates: [[
            [approxW, approxS], [approxE, approxS],
            [approxE, approxN], [approxW, approxN],
            [approxW, approxS],
          ]],
        },
        properties: {
          name: placeName,
          display_name: best.display_name,
          type: 'approximate_bbox',
          note: isPointBbox ? 'OSM中该要素仅为点标记，范围根据位置和重要性估算' : '范围取自Nominatim地理编码结果',
        },
      }],
    };

    return {
      type: 'custom',
      label: `${best.display_name} (${typeLabel}·近似)`,
      geojson: bboxPolygon,
      description: isPointBbox
        ? `⚠️ "${placeName}"在OpenStreetMap中仅有位置标记，无精确边界。显示为基于位置估算的大致范围，仅供参考`
        : `⚠️ "${placeName}"未找到精确几何数据，显示命名位置的大致范围`,
    };

  } catch (err) {
    return {
      type: 'custom', label: placeName, geojson: null,
      description: '查询失败，请检查网络或尝试用其他名称查询',
      error: err instanceof Error ? err.message : '未知错误',
    };
  }
  })(); // async IIFE end

  const result = await Promise.race([queryPromise, timeoutPromise]);
  clearTimeout(timeoutId);
  return result;
}

/**
 * 按名称+admin_level 查边界
 */
async function queryBoundaryByAdminLevel(
  name: string,
  adminLevel: number,
  nominatimResult: NominatimResult
): Promise<FeatureCollection> {
  // 策略1：用 OSM relation ID 精确查询（大区域给更长的超时）
  if (nominatimResult.osm_type === 'relation' && nominatimResult.osm_id) {
    const [s, n, w, e] = nominatimResult.boundingbox.map(Number);
    const areaDeg = (e - w) * (n - s);
    const timeout = areaDeg > 5 ? 90 : areaDeg > 1 ? 45 : 25;
    const query = `[out:json][timeout:${timeout}];
rel(${nominatimResult.osm_id});
out geom;`;

    try {
      const result = await overpassQuery(query);
      if (result.features.length > 0) return result;
    } catch {
      // ID 查询失败，继续回退
    }
  }

  // 策略2：按名称 + admin_level 模糊匹配
  const escapedName = name.replace(/['"\\]/g, '');
  const tryQuery = async (level: number): Promise<FeatureCollection> => {
    const query = `[out:json][timeout:30];
(
  rel["name"~"${escapedName}"]["boundary"="administrative"]["admin_level"="${level}"];
  rel["name:zh"~"${escapedName}"]["boundary"="administrative"]["admin_level"="${level}"];
);
out geom;`;
    return overpassQuery(query);
  };

  let result = await tryQuery(adminLevel);
  if (result.features.length > 0) return result;

  // 查不到时，向上一级尝试（如市→省）
  if (adminLevel > 2) {
    result = await tryQuery(adminLevel - 1);
    if (result.features.length > 0) return result;
  }
  // 向下一级尝试
  result = await tryQuery(adminLevel + 1);
  return result;
}

/**
 * 查询区域内的 POI
 */
export async function queryPOIsInArea(
  bbox: [number, number, number, number], // [w, s, e, n]
  amenity?: string
): Promise<OSMQueryResult> {
  const [w, s, e, n] = bbox;
  const amenityFilter = amenity
    ? `["amenity"="${amenity}"]`
    : `["amenity"]`;

  const query = `[out:json][timeout:25];
(
  node${amenityFilter}(${s},${w},${n},${e});
  way${amenityFilter}(${s},${w},${n},${e});
  rel${amenityFilter}(${s},${w},${n},${e});
);
out body;
>;
out skel qt;`;

  try {
    const geojson = await overpassQuery(query);
    return {
      type: 'poi',
      label: amenity ? `${amenity} (POI)` : 'POI 兴趣点',
      geojson,
      description: `找到 ${geojson.features.length} 个${amenity || 'POI'}兴趣点`,
    };
  } catch (err) {
    return {
      type: 'poi',
      label: 'POI',
      geojson: null,
      description: '查询失败',
      error: err instanceof Error ? err.message : '未知错误',
    };
  }
}

/**
 * 查询区域内的建筑物
 */
export async function queryBuildings(
  bbox: [number, number, number, number]
): Promise<OSMQueryResult> {
  const [w, s, e, n] = bbox;
  const query = `[out:json][timeout:25];
(
  way["building"](${s},${w},${n},${e});
  rel["building"](${s},${w},${n},${e});
);
out body;
>;
out skel qt;`;

  try {
    const geojson = await overpassQuery(query);
    return {
      type: 'building',
      label: '建筑物',
      geojson,
      description: `找到 ${geojson.features.length} 个建筑物`,
    };
  } catch (err) {
    return {
      type: 'building',
      label: '建筑物',
      geojson: null,
      description: '查询失败',
      error: err instanceof Error ? err.message : '未知错误',
    };
  }
}

/**
 * 查询水系（河流 + 湖泊 + 水库等）
 *
 * OSM 中水系分三类：
 *   - 河道线: waterway=river/stream/canal/drain/ditch
 *   - 河道面: waterway=riverbank (旧) / natural=water + water=river (新)
 *   - 水  体: natural=water + water=lake/pond/reservoir/basin/...
 *   - 多  边: type=multipolygon + natural=water
 */
export async function queryWaterways(
  bbox: [number, number, number, number]
): Promise<OSMQueryResult> {
  const [w, s, e, n] = bbox;
  const bboxWidth = e - w;
  const bboxHeight = n - s;
  const isLargeArea = bboxWidth > 3 || bboxHeight > 3;
  const timeout = isLargeArea ? 90 : 25;
  const outputFormat = isLargeArea ? 'out geom;' : 'out body;\n>;\nout skel qt;';

  const query = `[out:json][timeout:${timeout}];
(
  way["waterway"](${s},${w},${n},${e});
  rel["waterway"](${s},${w},${n},${e});
  way["waterway"="riverbank"](${s},${w},${n},${e});
  way["natural"="water"](${s},${w},${n},${e});
  way["water"](${s},${w},${n},${e});
  rel["natural"="water"](${s},${w},${n},${e});
  rel["water"](${s},${w},${n},${e});
  rel["type"="multipolygon"]["natural"="water"](${s},${w},${n},${e});
);
${outputFormat}`;

  try {
    const geojson = await overpassQuery(query);
    return {
      type: 'water',
      label: '水系',
      geojson,
      description: `找到 ${geojson.features.length} 个水系要素`,
    };
  } catch (err) {
    return {
      type: 'water',
      label: '水系',
      geojson: null,
      description: '查询失败',
      error: err instanceof Error ? err.message : '未知错误',
    };
  }
}

/**
 * 查询主要道路
 */
export async function queryRoads(
  bbox: [number, number, number, number],
  roadType: string = 'primary'
): Promise<OSMQueryResult> {
  const [w, s, e, n] = bbox;
  const query = `[out:json][timeout:25];
(
  way["highway"="${roadType}"](${s},${w},${n},${e});
);
out body;
>;
out skel qt;`;

  try {
    const geojson = await overpassQuery(query);
    return {
      type: 'road',
      label: `${roadType} 道路`,
      geojson,
      description: `找到 ${geojson.features.length} 条${roadType}道路`,
    };
  } catch (err) {
    return {
      type: 'road',
      label: '道路',
      geojson: null,
      description: '查询失败',
      error: err instanceof Error ? err.message : '未知错误',
    };
  }
}

/**
 * 查询铁路网
 *
 * OSM 铁路标签体系：
 *   - railway=rail          干线铁路
 *   - railway=subway        地铁
 *   - railway=light_rail    轻轨
 *   - railway=tram          有轨电车
 *   - railway=narrow_gauge  窄轨铁路
 *   - railway=disused       废弃铁路（可选查询）
 *   - railway=construction  在建铁路
 *
 * 大区域（省级）自动只查干线铁路，避免数据量过大导致超时
 */
export async function queryRailways(
  bbox: [number, number, number, number]
): Promise<OSMQueryResult> {
  const [w, s, e, n] = bbox;
  const bboxWidth = e - w;
  const bboxHeight = n - s;

  // 大区域（省/国家级别，>3度）只查干线铁路，避免超时
  const isLargeArea = bboxWidth > 3 || bboxHeight > 3;

  let filterClause: string;
  let labelSuffix: string;
  if (isLargeArea) {
    // 只查干线铁路（rail + narrow_gauge），排除地铁/轻轨/有轨电车/废弃/在建
    filterClause = `["railway"~"^(rail|narrow_gauge)$"]`;
    labelSuffix = '（干线）';
  } else {
    // 小区域查所有类型铁路
    filterClause = `["railway"]`;
    labelSuffix = '';
  }

  // 大区域用更长超时 + out geom（比 out body;>;out skel qt 快得多）
  const timeout = isLargeArea ? 90 : 30;
  const outputFormat = isLargeArea ? 'out geom;' : 'out body;\n>;\nout skel qt;';

  const query = `[out:json][timeout:${timeout}];
(
  way${filterClause}(${s},${w},${n},${e});
  rel${filterClause}(${s},${w},${n},${e});
);
${outputFormat}`;

  try {
    const geojson = await overpassQuery(query);
    return {
      type: 'custom',
      label: `铁路网${labelSuffix}`,
      geojson,
      description: `找到 ${geojson.features.length} 条铁路线路${labelSuffix}`,
    };
  } catch (err) {
    return {
      type: 'custom',
      label: '铁路网',
      geojson: null,
      description: '查询失败',
      error: err instanceof Error ? err.message : '未知错误',
    };
  }
}

/**
 * 查询绿地/公园
 */
export async function queryGreenSpace(
  bbox: [number, number, number, number]
): Promise<OSMQueryResult> {
  const [w, s, e, n] = bbox;
  const query = `[out:json][timeout:25];
(
  way["leisure"="park"](${s},${w},${n},${e});
  rel["leisure"="park"](${s},${w},${n},${e});
  way["landuse"="grass"](${s},${w},${n},${e});
  way["landuse"="forest"](${s},${w},${n},${e});
  way["natural"="wood"](${s},${w},${n},${e});
);
out body;
>;
out skel qt;`;

  try {
    const geojson = await overpassQuery(query);
    return {
      type: 'green',
      label: '绿地/公园',
      geojson,
      description: `找到 ${geojson.features.length} 个绿地/公园`,
    };
  } catch (err) {
    return {
      type: 'green',
      label: '绿地',
      geojson: null,
      description: '查询失败',
      error: err instanceof Error ? err.message : '未知错误',
    };
  }
}

/**
 * 执行自定义 Overpass 查询
 */
export async function queryCustom(query: string): Promise<OSMQueryResult> {
  try {
    const geojson = await overpassQueryShort(query);
    return {
      type: 'custom',
      label: '自定义查询',
      geojson,
      description: `查询返回 ${geojson.features.length} 个要素`,
    };
  } catch (err) {
    return {
      type: 'custom',
      label: '自定义查询',
      geojson: null,
      description: '查询失败',
      error: err instanceof Error ? err.message : '未知错误',
    };
  }
}

// ====== OSM JSON → GeoJSON 转换 ======

interface OSMNode {
  type: 'node';
  id: number;
  lat: number;
  lon: number;
  tags?: Record<string, string>;
}

interface OSMWay {
  type: 'way';
  id: number;
  nodes: number[];
  tags?: Record<string, string>;
}

interface OSMRelation {
  type: 'relation';
  id: number;
  members: { type: string; ref: number; role: string; geometry?: { lat: number; lon: number }[] }[];
  tags?: Record<string, string>;
}

interface OSMResponse {
  elements: (OSMNode | OSMWay | OSMRelation)[];
}

/** 解析 Overpass member geometry 数组 → [lng, lat] 坐标对 */
function memberGeomToCoords(geom: { lat: number; lon: number }[]): [number, number][] {
  return geom.map((p) => [p.lon, p.lat] as [number, number]);
}

function osmToGeoJSON(data: OSMResponse): FeatureCollection {
  const nodeMap = new Map<number, [number, number]>();
  const features: Feature[] = [];

  // First pass: collect node coordinates
  for (const el of data.elements) {
    if (el.type === 'node') {
      nodeMap.set(el.id, [el.lon, el.lat]);
    }
  }

  // Check if response has any relation/way that will produce polygon/line geometry
  // (if so, standalone tagged nodes are usually redundant admin_centre markers)
  const hasAreaFeatures = data.elements.some(
    el => (el.type === 'relation' || el.type === 'way')
  );

  // Second pass: convert ways → LineString/Polygon, relations → Polygon/MultiPolygon
  for (const el of data.elements) {
    if (el.type === 'node') {
      // Skip standalone tagged nodes when response contains area features
      // (these are typically admin_centre/label nodes inside a boundary polygon)
      if (hasAreaFeatures) continue;

      // Single nodes with tags → Point (only when no area data exists)
      if (el.tags && Object.keys(el.tags).length > 0) {
        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [el.lon, el.lat] },
          properties: { ...el.tags, osm_id: el.id, osm_type: 'node' },
        });
      }
    } else if (el.type === 'way') {
      // Try member geometry first (from out geom), fall back to node refs
      const wayWithGeom = el as OSMWay & { geometry?: { lat: number; lon: number }[] };
      let coords: [number, number][];

      if (wayWithGeom.geometry && wayWithGeom.geometry.length >= 2) {
        coords = memberGeomToCoords(wayWithGeom.geometry);
      } else {
        coords = el.nodes
          .map((nid) => nodeMap.get(nid))
          .filter(Boolean) as [number, number][];
      }

      if (coords.length < 2) continue;

      // Check if it's a closed polygon or open line
      const isClosed =
        Math.abs(coords[0][0] - coords[coords.length - 1][0]) < 1e-9 &&
        Math.abs(coords[0][1] - coords[coords.length - 1][1]) < 1e-9;

      const geometry = isClosed
        ? { type: 'Polygon' as const, coordinates: [coords] }
        : { type: 'LineString' as const, coordinates: coords };

      features.push({
        type: 'Feature',
        geometry,
        properties: {
          ...(el.tags || {}),
          osm_id: el.id,
          osm_type: 'way',
        },
      });
    } else if (el.type === 'relation') {
      // ===== 处理 relation 的 member 内联几何数据 =====
      const membersWithGeom = el.members.filter(
        (m) => m.geometry && m.geometry.length >= 2
      );

      if (membersWithGeom.length > 0) {
        const outerSegments: [number, number][][] = [];
        const innerSegments: [number, number][][] = [];

        for (const m of membersWithGeom) {
          const coords = memberGeomToCoords(m.geometry!);
          if (m.role === 'inner') {
            innerSegments.push(coords);
          } else {
            outerSegments.push(coords);
          }
        }

        if (outerSegments.length > 0) {
          // 核心修复：将碎片 way 段拼接成连续环
          // 每个 outer way 只是边界的一段，需要首尾相连拼接起来
          let outerRings = stitchSegmentsIntoRings(outerSegments);
          let innerRings = stitchSegmentsIntoRings(innerSegments);
          // 安全回退：拼接失败则每段独立作为环
          if (outerRings.length === 0 && outerSegments.length > 0) {
            outerRings = outerSegments;
          }
          if (innerRings.length === 0 && innerSegments.length > 0) {
            innerRings = innerSegments;
          }

          // 简化大型几何体（>500点），减少浏览器渲染压力
          const simplifiedOuter = outerRings.map((ring) =>
            ring.length > 500 ? simplifyRing(ring, 0.0001) : ring
          );
          const simplifiedInner = innerRings.map((ring) =>
            ring.length > 500 ? simplifyRing(ring, 0.0001) : ring
          );

          if (simplifiedOuter.length > 0) {
            if (simplifiedOuter.length === 1 && simplifiedInner.length === 0) {
              features.push({
                type: 'Feature',
                geometry: { type: 'Polygon', coordinates: [simplifiedOuter[0]] },
                properties: { ...(el.tags || {}), osm_id: el.id, osm_type: 'relation' },
              });
            } else {
              // MultiPolygon：每个 outer ring 独立成为一个 polygon
              const multiCoords: [number, number][][][] = simplifiedOuter.map((outer) => {
                // 找被这个 outer 包含的 inner rings
                const relatedInner = simplifiedInner.filter((inner) =>
                  pointInRing(inner[0], outer)
                );
                return [outer, ...relatedInner];
              });

              features.push({
                type: 'Feature',
                geometry:
                  multiCoords.length === 1
                    ? { type: 'Polygon', coordinates: multiCoords[0] }
                    : { type: 'MultiPolygon', coordinates: multiCoords },
                properties: { ...(el.tags || {}), osm_id: el.id, osm_type: 'relation' },
              });
            }
          }
        }
      }
    }
  }

  // Also check for top-level pre-computed geometry on elements (out geom on ways/nodes directly)
  for (const el of data.elements) {
    if ((el as any).geometry && (el as any).geometry.type) {
      const geomEl = el as any;
      // Avoid duplicating relations already processed above
      const alreadyProcessed = el.type === 'relation' && el.members.some((m: any) => m.geometry);
      if (!alreadyProcessed) {
        features.push({
          type: 'Feature',
          geometry: geomEl.geometry,
          properties: {
            ...(geomEl.tags || {}),
            osm_id: geomEl.id,
            osm_type: geomEl.type,
          },
        });
      }
    }
  }

  return {
    type: 'FeatureCollection',
    features,
  };
}

// ====== Way 段拼接：将碎片 way 拼接成连续多边形环 ======

const STITCH_TOLERANCE = 1e-5; // 端点匹配容差（约 1 米，覆盖浮点精度误差）

/** 将一堆无序的 way 段拼接成连续的闭合环 */
function stitchSegmentsIntoRings(segments: [number, number][][]): [number, number][][] {
  if (segments.length === 0) return [];
  if (segments.length === 1) {
    // 单段，检查是否闭合
    const s = segments[0];
    const closed = Math.abs(s[0][0] - s[s.length - 1][0]) < STITCH_TOLERANCE &&
                   Math.abs(s[0][1] - s[s.length - 1][1]) < STITCH_TOLERANCE;
    return closed ? [[...s]] : [s];
  }

  const rings: [number, number][][] = [];
  const used = new Set<number>();
  const remaining = segments.map((s, i) => ({ seg: s, idx: i }));

  while (used.size < segments.length) {
    // 找第一个未使用的段作为种子
    let seedIdx = remaining.findIndex((r) => !used.has(r.idx));
    if (seedIdx === -1) break;

    const ring: [number, number][] = [...remaining[seedIdx].seg];
    used.add(remaining[seedIdx].idx);

    // 向前延伸
    let extended = true;
    while (extended) {
      extended = false;
      const tail = ring[ring.length - 1];
      for (const r of remaining) {
        if (used.has(r.idx)) continue;
        const head = r.seg[0];
        const rtail = r.seg[r.seg.length - 1];

        if (dist(tail, head) < STITCH_TOLERANCE) {
          // tail → head：正向拼接
          ring.push(...r.seg.slice(1));
          used.add(r.idx);
          extended = true;
          break;
        } else if (dist(tail, rtail) < STITCH_TOLERANCE) {
          // tail → rtail：反向拼接
          ring.push(...r.seg.slice().reverse().slice(1));
          used.add(r.idx);
          extended = true;
          break;
        }
      }
    }

    // 向后延伸
    extended = true;
    while (extended) {
      extended = false;
      const head = ring[0];
      for (const r of remaining) {
        if (used.has(r.idx)) continue;
        const rhead = r.seg[0];
        const rtail = r.seg[r.seg.length - 1];

        if (dist(head, rtail) < STITCH_TOLERANCE) {
          // head ← rtail：正向接前面
          ring.unshift(...r.seg.slice(0, -1));
          used.add(r.idx);
          extended = true;
          break;
        } else if (dist(head, rhead) < STITCH_TOLERANCE) {
          // head ← rhead：反向接前面
          ring.unshift(...r.seg.slice().reverse().slice(0, -1));
          used.add(r.idx);
          extended = true;
          break;
        }
      }
    }

    // GeoJSON Polygon 规范要求首尾坐标完全相同
    // 如果未闭合，补充闭合点
    if (ring.length >= 3 &&
        dist(ring[0], ring[ring.length - 1]) > STITCH_TOLERANCE) {
      ring.push([...ring[0]]); // 补充闭合点
    }
    // 确保顺时针（outer ring 应为顺时针）
    if (ringArea(ring) < 0) {
      ring.reverse();
    }

    rings.push(ring);
  }

  return rings;
}

function dist(a: [number, number], b: [number, number]): number {
  const dx = a[0] - b[0], dy = a[1] - b[1];
  return Math.sqrt(dx * dx + dy * dy);
}

/** 计算环面积（正=顺时针，负=逆时针） */
function ringArea(ring: [number, number][]): number {
  let area = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    area += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  }
  return area / 2;
}

/** Douglas-Peucker 简化（迭代版，避免递归栈溢出） */
function simplifyRing(ring: [number, number][], tolerance: number): [number, number][] {
  if (ring.length <= 2) return ring;

  const result: [number, number][] = [];
  // 使用显式栈代替递归
  const stack: [number, number][] = [[0, ring.length - 1]];
  const keep = new Set<number>();
  keep.add(0);
  keep.add(ring.length - 1);

  while (stack.length > 0) {
    const [start, end] = stack.pop()!;
    if (end - start <= 1) continue;

    let maxDist = 0;
    let maxIdx = start;

    for (let i = start + 1; i < end; i++) {
      const d = perpendicularDist(ring[i], ring[start], ring[end]);
      if (d > maxDist) { maxDist = d; maxIdx = i; }
    }

    if (maxDist > tolerance) {
      keep.add(maxIdx);
      stack.push([start, maxIdx]);
      stack.push([maxIdx, end]);
    }
  }

  const sortedKept = [...keep].sort((a, b) => a - b);
  for (const idx of sortedKept) {
    result.push(ring[idx]);
  }
  return result;
}

function perpendicularDist(pt: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  if (dx === 0 && dy === 0) return dist(pt, a);
  const t = ((pt[0] - a[0]) * dx + (pt[1] - a[1]) * dy) / (dx * dx + dy * dy);
  const clamped = Math.max(0, Math.min(1, t));
  const projX = a[0] + clamped * dx, projY = a[1] + clamped * dy;
  return dist(pt, [projX, projY]);
}

/** 判断点是否在多边形环内（射线法） */
function pointInRing(pt: [number, number], ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if (
      yi > pt[1] !== yj > pt[1] &&
      pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi
    ) {
      inside = !inside;
    }
  }
  return inside;
}

// ====== 命令解析 ======

// ====== 先定边界再查 POI：解决跨区域查询不准确问题 ======

/**
 * 先地理编码地名获取边界，再在该边界内查询 POI
 * 这是解决"查武汉的大学却查出外省大学"的核心方案
 */
export async function queryPOIsInPlaceName(
  placeName: string,
  amenity?: string
): Promise<OSMQueryResult> {
  try {
    // 1. 先地理编码地名获取精确边界
    const geoResults = await geocodeSearch(placeName);
    if (geoResults.length === 0) {
      return {
        type: 'poi',
        label: amenity ? `${amenity} (${placeName})` : `POI (${placeName})`,
        geojson: null,
        description: `未找到"${placeName}"的位置信息`,
        error: 'NOT_FOUND',
      };
    }

    const best = geoResults[0];
    const [s, n, w, e] = best.boundingbox.map(Number);

    // 2. 在该地边界内查询 POI
    const result = await queryPOIsInArea(
      [w, s, e, n],
      amenity || undefined
    );

    return {
      ...result,
      label: amenity
        ? `${amenity} (${best.display_name})`
        : `POI (${best.display_name})`,
      description: `在"${best.display_name}"范围内找到 ${result.geojson?.features?.length || 0} 个${amenity || 'POI'}`,
    };
  } catch (err) {
    return {
      type: 'poi',
      label: `POI (${placeName})`,
      geojson: null,
      description: '查询失败',
      error: err instanceof Error ? err.message : '未知错误',
    };
  }
}

/**
 * 先地理编码地名获取边界，再在该边界内查询建筑物
 */
export async function queryBuildingsInPlaceName(
  placeName: string
): Promise<OSMQueryResult> {
  try {
    const geoResults = await geocodeSearch(placeName);
    if (geoResults.length === 0) {
      return { type: 'building', label: `建筑物 (${placeName})`, geojson: null, description: `未找到"${placeName}"`, error: 'NOT_FOUND' };
    }
    const best = geoResults[0];
    const [s, n, w, e] = best.boundingbox.map(Number);
    const result = await queryBuildings([w, s, e, n]);
    return { ...result, label: `建筑物 (${best.display_name})`, description: `在"${best.display_name}"范围内找到 ${result.geojson?.features?.length || 0} 个建筑物` };
  } catch (err) {
    return { type: 'building', label: `建筑物 (${placeName})`, geojson: null, description: '查询失败', error: err instanceof Error ? err.message : '未知错误' };
  }
}


/**
 * 查询某行政区的所有下级区县（如"北京市"→东城、西城、朝阳……）
 *
 * 逻辑：
 * 1. 先 geocode 地名获取 bbox
 * 2. Overpass 查 admin_level=父级 的关系（如北京市=level5）
 * 3. 转 area 后查其内部所有 admin_level=子级 的关系（区县=level6）
 * 4. 为每个区县分配不同颜色
 */
export async function queryDistricts(
  placeName: string
): Promise<OSMQueryResult> {
  try {
    // 1. 地理编码
    const geoResults = await geocodeSearch(placeName);
    if (geoResults.length === 0) {
      return {
        type: 'boundary', label: placeName, geojson: null,
        description: `未找到"${placeName}"`, error: 'NOT_FOUND',
      };
    }

    const best = geoResults[0];
    const [s, n, w, e] = best.boundingbox.map(Number);

    // 2. 推断行政级别
    let parentLevel = 5; // 默认地级市
    const areaDeg = (e - w) * (n - s);
    if (areaDeg > 10) parentLevel = 4; // 省
    else if (areaDeg > 1) parentLevel = 5; // 市
    else if (areaDeg > 0.1) parentLevel = 6; // 区县
    else parentLevel = 8; // 乡镇

    const childLevel = parentLevel + 1;

    // 3. Overpass 查询：先用名称+级别找到父区域，转 area，再查子级
    const escapedName = placeName.replace(/['"\\]/g, '');
    const query = `[out:json][timeout:30];
rel["name"~"${escapedName}"]["boundary"="administrative"]["admin_level"="${parentLevel}"];
map_to_area -> .parent;
rel["boundary"="administrative"]["admin_level"="${childLevel}"](area.parent);
out geom;`;

    const geojson = await overpassQuery(query);

    if (geojson.features.length === 0) {
      // 回退：直接用 bbox 查该区域内所有子级行政区
      const bboxQuery = `[out:json][timeout:30];
rel["boundary"="administrative"]["admin_level"="${childLevel}"](${s},${w},${n},${e});
out geom;`;
      const bboxResult = await overpassQuery(bboxQuery);
      if (bboxResult.features.length === 0) {
        return {
          type: 'boundary', label: placeName, geojson: null,
          description: `未找到"${placeName}"的下级行政区数据`,
          error: 'NO_DISTRICTS',
        };
      }
      // 为每个区县分配不同颜色
      return colorizeDistricts(bboxResult, placeName);
    }

    return colorizeDistricts(geojson, placeName);
  } catch (err) {
    return {
      type: 'boundary', label: placeName, geojson: null,
      description: '查询区县失败',
      error: err instanceof Error ? err.message : '未知错误',
    };
  }
}

/** 为每个区县分配不同颜色 */
function colorizeDistricts(fc: FeatureCollection, parentName: string): OSMQueryResult {
  const palette = [
    '#1677ff', '#52c41a', '#fa8c16', '#f5222d', '#722ed1',
    '#13c2c2', '#eb2f96', '#faad14', '#2f54eb', '#a0d911',
    '#f759ab', '#5b8c00', '#08979c', '#c41d7f', '#d4380d',
    '#1d39c4', '#389e0d', '#d46b08', '#cf1322', '#7cb305',
  ];

  const coloredFeatures = fc.features.map((f, i) => {
    const color = palette[i % palette.length];
    const name = (f.properties as any)?.name || (f.properties as any)?.['name:zh'] || `区县${i + 1}`;
    return {
      ...f,
      properties: {
        ...(f.properties as Record<string, unknown> || {}),
        _districtColor: color,
        _districtName: name,
      },
    };
  });

  return {
    type: 'boundary',
    label: `${parentName}各区县 (${coloredFeatures.length}个)`,
    geojson: { type: 'FeatureCollection', features: coloredFeatures },
    description: `✅ 已查询"${parentName}"的 ${coloredFeatures.length} 个区县，每个区县使用不同颜色`,
  };
}

// ====== 命令解析与执行（支持精确区域查询） ======

/**
 * 解析 AI 回复中的 OSM 查询指令
 * 格式:
 *   [OSM:boundary:地名]            — 查询行政区边界
 *   [OSM:poi:类型]                 — 当前视野内查询 POI（旧行为）
 *   [OSM:poi-in:地名:类型]         — 先定位地名边界，再在该边界内查 POI（精确！）
 *   [OSM:buildings-in:地名]        — 先定位地名边界，再查该区域内建筑物
 *   [OSM:buildings]               — 当前视野内查询建筑物
 *   [OSM:roads:类型]              — 当前视野内查询道路
 *   [OSM:roads-in:地名:类型]       — 先定位地名边界，再查该区域内道路
 *   [OSM:water-in:地名]            — 先定位地名边界，再查水系
 *   [OSM:water]                   — 当前视野内查询水系
 *   [OSM:green-in:地名]            — 先定位地名边界，再查绿地
 *   [OSM:green]                   — 当前视野内查询绿地
 *   [OSM:custom:overpassQL]       — 自定义 Overpass 查询
 *
 * 重要规则：凡是用户指定了地点+内容的查询（如"武汉的大学"），必须用 *-in 格式！
 */
export interface OSMCommand {
  action: 'boundary' | 'outline' | 'feature' | 'districts' | 'poi' | 'poi-in' | 'buildings' | 'buildings-in' | 'roads' | 'roads-in' | 'water' | 'water-in' | 'green' | 'green-in' | 'railways' | 'railways-in' | 'custom';
  params: string;    // raw params string
  placeContext?: string; // 如果命令是由前一个 boundary 的结果驱动的，这里存放地点名
}

/** OSM 英文标签 → 高德中文关键词 */
function osmTagToChinese(tag: string): string {
  const MAP: Record<string, string> = {
    'restaurant': '餐厅', 'cafe': '咖啡厅', 'bar': '酒吧', 'pub': '酒吧',
    'fast_food': '快餐', 'food_court': '美食广场',
    'hospital': '医院', 'clinic': '诊所', 'pharmacy': '药店',
    'school': '学校', 'university': '大学', 'college': '学院',
    'library': '图书馆', 'kindergarten': '幼儿园',
    'bank': '银行', 'atm': 'ATM',
    'hotel': '酒店', 'hostel': '青年旅舍', 'motel': '汽车旅馆',
    'supermarket': '超市', 'mall': '商场', 'marketplace': '市场',
    'parking': '停车场', 'park': '公园',
    'police': '派出所', 'fire_station': '消防站', 'post_office': '邮局',
    'museum': '博物馆', 'theatre': '剧院', 'cinema': '电影院',
    'gym': '健身房', 'stadium': '体育场', 'swimming_pool': '游泳池',
    'toilets': '厕所', 'fuel': '加油站', 'bus_station': '公交站',
    'train_station': '火车站', 'subway_station': '地铁站', 'airport': '机场',
    'place_of_worship': '寺庙', 'church': '教堂', 'mosque': '清真寺',
    'tourist': '景点', 'attraction': '景点', 'viewpoint': '观景台',
    'charging_station': '充电站', 'car_rental': '租车',
    'convenience': '便利店', 'laundry': '洗衣店', 'hairdresser': '理发店',
    'bicycle_rental': '共享单车', 'bicycle_parking': '自行车停放',
  };
  const lower = tag.toLowerCase();
  return MAP[lower] || tag;
}

export function parseOSMCommands(text: string): OSMCommand[] {
  const commands: OSMCommand[] = [];

  // 匹配 *-in 格式（精确区域查询），格式: [OSM:poi-in:地名:类型] 或 [OSM:water-in:地名] 或 [OSM:railways-in:地名]
  // params 包含 "地名[:子类型]"
  const inRegex = /\[OSM:(poi-in|buildings-in|roads-in|water-in|green-in|railways-in):([^\]]+)\]/g;
  let match: RegExpExecArray | null;
  while ((match = inRegex.exec(text)) !== null) {
    const action = match[1] as OSMCommand['action'];
    const params = match[2];
    commands.push({ action, params });
  }

  // 匹配普通格式
  const regex = /\[OSM:(boundary|outline|feature|districts|poi|buildings|roads|water|green|railways|custom)(?::([^\]]*))?\]/g;
  while ((match = regex.exec(text)) !== null) {
    const action = match[1] as OSMCommand['action'];
    const params = match[2] || '';
    // 避免重复匹配已经在 *-in 中处理过的
    if (!['poi-in', 'buildings-in', 'roads-in', 'water-in', 'green-in', 'railways-in'].includes(action)) {
      commands.push({ action, params });
    }
  }

  return commands;
}

/**
 * 执行 OSM 命令
 *
 * @param cmd           解析出的命令
 * @param currentBounds 当前地图视野 [west, south, east, north]
 * @param overrideBounds 可选：从上一个 boundary 命令获取的精确 bbox，优先于 currentBounds
 */
export async function executeOSMCommand(
  cmd: OSMCommand,
  currentBounds: [number, number, number, number] | null,
  overrideBounds?: [number, number, number, number] | null
): Promise<{ result: OSMQueryResult; bbox?: [number, number, number, number] | null }> {
  // 如果有 overrideBounds（来自前一个 boundary 命令），优先使用
  const bbox = overrideBounds || currentBounds;
  const [w, s, e, n] = bbox || [0, 0, 0, 0];

  let result: OSMQueryResult;
  let resultBbox: [number, number, number, number] | null = null;

  switch (cmd.action) {
    case 'boundary': {
      // 高德 + OSM 并行查询：高德快但可能只有点，OSM 有面状边界
      const gaodeFirst = await gaodeGeocode(cmd.params);
      const gaodeHasPolygon = gaodeFirst.geojson
        ? gaodeFirst.geojson.features.some((f: any) => f.geometry?.type === 'Polygon' || f.geometry?.type === 'MultiPolygon')
        : false;

      if (gaodeHasPolygon) {
        // 高德返回面状数据，直接用
        result = { type: 'boundary', label: gaodeFirst.label, geojson: gaodeFirst.geojson!, description: gaodeFirst.description };
      } else {
        // 高德只有点或无结果 → 并行取 OSM（面状自然地理/行政区）
        const osmResult = await queryBoundary(cmd.params);
        const osmOk = osmResult.geojson && osmResult.geojson.features.length > 0;
        if (osmOk) {
          result = osmResult;
        } else if (gaodeFirst.geojson && gaodeFirst.geojson.features.length > 0) {
          // OSM 失败，退而求其次用高德的点
          result = { type: 'boundary', label: gaodeFirst.label, geojson: gaodeFirst.geojson, description: `⚠️ 仅坐标定位（未找到面状边界），可尝试缩小范围` };
        } else {
          // 都失败
          result = await queryFeature(cmd.params);
        }
      }
      if (result.geojson) {
        resultBbox = getFCBbox(result.geojson);
      }
      break;
    }

    // ====== 下级行政区查询（北京市→所有区县） ======
    case 'districts': {
      result = await queryDistricts(cmd.params);
      if (result.geojson) {
        resultBbox = getFCBbox(result.geojson);
      }
      break;
    }

    // ====== 通用地理要素（沙漠/山脉/湖泊/大学等） ======
    case 'feature': {
      const gaodeFirst = await gaodeGeocode(cmd.params);
      const gaodeHasPolygon = gaodeFirst.geojson
        ? gaodeFirst.geojson.features.some((f: any) => f.geometry?.type === 'Polygon' || f.geometry?.type === 'MultiPolygon')
        : false;

      if (gaodeHasPolygon) {
        result = { type: 'custom', label: gaodeFirst.label, geojson: gaodeFirst.geojson!, description: gaodeFirst.description };
      } else if (gaodeFirst.geojson && gaodeFirst.geojson.features.length > 0) {
        // 高德有点但无面 → 先试 OSM 拿面，失败再用高德的点
        const osmResult = await queryFeature(cmd.params);
        if (osmResult.geojson && osmResult.geojson.features.length > 0) {
          result = osmResult;
        } else {
          result = { type: 'custom', label: gaodeFirst.label, geojson: gaodeFirst.geojson, description: `⚠️ 仅坐标定位：${gaodeFirst.description}` };
        }
      } else {
        result = await queryFeature(cmd.params);
      }
      if (result.geojson) {
        resultBbox = getFCBbox(result.geojson);
      }
      break;
    }

    // ====== 线状边界（仅轮廓，不填充）—— 自动适配行政区+自然地物 ======
    case 'outline': {
      let geoResult: OSMQueryResult;
      const gaodeFirst = await gaodeGeocode(cmd.params);
      const gaodeHasPolygon = gaodeFirst.geojson
        ? gaodeFirst.geojson.features.some((f: any) => f.geometry?.type === 'Polygon' || f.geometry?.type === 'MultiPolygon')
        : false;

      if (gaodeHasPolygon) {
        geoResult = { type: 'outline', label: gaodeFirst.label, geojson: gaodeFirst.geojson!, description: gaodeFirst.description };
      } else if (gaodeFirst.geojson && gaodeFirst.geojson.features.length > 0) {
        // 高德有点无面 → 尝试 OSM 拿面
        const osmResult = await queryBoundary(cmd.params);
        if (osmResult.geojson && osmResult.geojson.features.length > 0) {
          geoResult = osmResult;
        } else {
          geoResult = { type: 'outline', label: gaodeFirst.label, geojson: gaodeFirst.geojson, description: `⚠️ 仅坐标，无法绘制轮廓` };
        }
      } else {
        geoResult = await queryBoundary(cmd.params);
        if (!geoResult.geojson || geoResult.geojson.features.length === 0) {
          geoResult = await queryFeature(cmd.params);
        }
      }
      if (geoResult.geojson && geoResult.geojson.features.length > 0) {
        resultBbox = getFCBbox(geoResult.geojson);
        geoResult.geojson = convertPolygonToOutline(geoResult.geojson);
        geoResult.description = geoResult.description.replace('边界数据', '边界轮廓线');
      }
      result = geoResult;
      break;
    }

    // ====== 精确区域查询（先定边界再查内容） ======
    case 'poi-in': {
      // params 格式: "地名:类型"  或  "地名"（查所有 POI）
      const colonIdx = cmd.params.lastIndexOf(':');
      const placeName = colonIdx >= 0 ? cmd.params.substring(0, colonIdx) : cmd.params;
      const amenity = colonIdx >= 0 ? cmd.params.substring(colonIdx + 1) : undefined;
      // 高德优先：OSM 标签 → 中文关键词转换
      const zhKeyword = amenity ? osmTagToChinese(amenity) : undefined;
      const gaodePOI = await gaodePOISearch(zhKeyword || amenity || '', placeName, 20);
      if (gaodePOI.geojson && gaodePOI.geojson.features.length > 0) {
        result = { type: 'poi', label: gaodePOI.label, geojson: gaodePOI.geojson, description: gaodePOI.description };
      } else {
        result = await queryPOIsInPlaceName(placeName, amenity);
      }
      break;
    }

    case 'buildings-in': {
      result = await queryBuildingsInPlaceName(cmd.params);
      break;
    }

    case 'roads-in': {
      // params 格式: "地名:道路类型"
      const colonIdx = cmd.params.lastIndexOf(':');
      const placeName = colonIdx >= 0 ? cmd.params.substring(0, colonIdx) : cmd.params;
      const roadType = colonIdx >= 0 ? cmd.params.substring(colonIdx + 1) : 'primary';
      result = await queryRoadsInPlaceName(placeName, roadType);
      break;
    }

    case 'railways-in': {
      result = await queryRailwaysInPlaceName(cmd.params);
      break;
    }

    case 'water-in': {
      // 先 geocode 地名，再查水系
      const geoResults = await geocodeSearch(cmd.params);
      if (geoResults.length === 0) {
        result = { type: 'water', label: `水系 (${cmd.params})`, geojson: null, description: `未找到"${cmd.params}"`, error: 'NOT_FOUND' };
      } else {
        const best = geoResults[0];
        const [sr, nr, wr, er] = best.boundingbox.map(Number);
        result = await queryWaterways([wr, sr, er, nr]);
        result.label = `水系 (${best.display_name})`;
        result.description = `在"${best.display_name}"范围内找到 ${result.geojson?.features?.length || 0} 个水系要素`;
      }
      break;
    }

    case 'green-in': {
      const geoResults = await geocodeSearch(cmd.params);
      if (geoResults.length === 0) {
        result = { type: 'green', label: `绿地 (${cmd.params})`, geojson: null, description: `未找到"${cmd.params}"`, error: 'NOT_FOUND' };
      } else {
        const best = geoResults[0];
        const [sr, nr, wr, er] = best.boundingbox.map(Number);
        result = await queryGreenSpace([wr, sr, er, nr]);
        result.label = `绿地 (${best.display_name})`;
        result.description = `在"${best.display_name}"范围内找到 ${result.geojson?.features?.length || 0} 个绿地/公园`;
      }
      break;
    }

    // ====== 视野范围内查询（保留旧行为） ======
    case 'poi': {
      const zhKeyword = cmd.params ? osmTagToChinese(cmd.params) : undefined;
      const gaodePOI = await gaodePOISearch(zhKeyword || cmd.params || '', undefined, 20);
      if (gaodePOI.geojson && gaodePOI.geojson.features.length > 0) {
        result = { type: 'poi', label: gaodePOI.label, geojson: gaodePOI.geojson, description: gaodePOI.description };
      } else if (!bbox) {
        result = { type: 'poi', label: 'POI', geojson: null, description: '无当前视野', error: 'NO_BOUNDS' };
      } else {
        result = await queryPOIsInArea(bbox, cmd.params || undefined);
      }
      break;
    }

    case 'buildings': {
      if (!bbox) {
        result = { type: 'building', label: '建筑物', geojson: null, description: '无当前视野', error: 'NO_BOUNDS' };
      } else {
        result = await queryBuildings(bbox);
      }
      break;
    }

    case 'roads': {
      if (!bbox) {
        result = { type: 'road', label: '道路', geojson: null, description: '无当前视野', error: 'NO_BOUNDS' };
      } else {
        result = await queryRoads(bbox, cmd.params || 'primary');
      }
      break;
    }

    case 'railways': {
      if (!bbox) {
        result = { type: 'custom', label: '铁路', geojson: null, description: '无当前视野', error: 'NO_BOUNDS' };
      } else {
        result = await queryRailways(bbox);
      }
      break;
    }

    case 'water': {
      if (!bbox) {
        result = { type: 'water', label: '水系', geojson: null, description: '无当前视野', error: 'NO_BOUNDS' };
      } else {
        result = await queryWaterways(bbox);
      }
      break;
    }

    case 'green': {
      if (!bbox) {
        result = { type: 'green', label: '绿地', geojson: null, description: '无当前视野', error: 'NO_BOUNDS' };
      } else {
        result = await queryGreenSpace(bbox);
      }
      break;
    }

    case 'custom':
      result = await queryCustom(cmd.params);
      break;

    default:
      result = { type: 'custom', label: '未知', geojson: null, description: '未知命令', error: 'UNKNOWN' };
  }

  return { result, bbox: resultBbox };
}

// ====== 辅助：从 FeatureCollection 提取 bbox ======

/**
 * 将 Polygon/MultiPolygon FeatureCollection 转换为仅轮廓的 LineString/MultiLineString
 * 用于语义区分："边界"→ 线，"行政区"→ 面
 */
function convertPolygonToOutline(fc: FeatureCollection): FeatureCollection {
  const outlineFeatures: Feature[] = [];

  for (const f of fc.features) {
    const geom = f.geometry;
    if (geom.type === 'Polygon') {
      // 每个环变为一条 LineString
      for (const ring of geom.coordinates) {
        outlineFeatures.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: ring },
          properties: { ...f.properties },
        });
      }
    } else if (geom.type === 'MultiPolygon') {
      for (const poly of geom.coordinates) {
        for (const ring of poly) {
          outlineFeatures.push({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: ring },
            properties: { ...f.properties },
          });
        }
      }
    } else if (geom.type === 'LineString' || geom.type === 'MultiLineString') {
      // 本身已经是线，直接保留
      outlineFeatures.push(f);
    } else if (geom.type === 'Point' || geom.type === 'MultiPoint') {
      outlineFeatures.push(f);
    }
  }

  return { type: 'FeatureCollection', features: outlineFeatures };
}

/**
 * 先地理编码地名获取边界，再在该边界内查询道路
 */
async function queryRoadsInPlaceName(
  placeName: string,
  roadType: string
): Promise<OSMQueryResult> {
  try {
    const geoResults = await geocodeSearch(placeName);
    if (geoResults.length === 0) {
      return { type: 'road', label: `道路 (${placeName})`, geojson: null, description: `未找到"${placeName}"`, error: 'NOT_FOUND' };
    }
    const best = geoResults[0];
    const [s, n, w, e] = best.boundingbox.map(Number);
    const result = await queryRoads([w, s, e, n], roadType);
    return { ...result, label: `${roadType}道路 (${best.display_name})`, description: `在"${best.display_name}"范围内找到 ${result.geojson?.features?.length || 0} 条${roadType}道路` };
  } catch (err) {
    return { type: 'road', label: `道路 (${placeName})`, geojson: null, description: '查询失败', error: err instanceof Error ? err.message : '未知错误' };
  }
}

/**
 * 先地理编码地名获取边界，再在该边界内查询铁路
 */
export async function queryRailwaysInPlaceName(
  placeName: string
): Promise<OSMQueryResult> {
  try {
    const geoResults = await geocodeSearch(placeName);
    if (geoResults.length === 0) {
      return { type: 'custom', label: `铁路 (${placeName})`, geojson: null, description: `未找到"${placeName}"`, error: 'NOT_FOUND' };
    }
    const best = geoResults[0];
    const [s, n, w, e] = best.boundingbox.map(Number);
    const result = await queryRailways([w, s, e, n]);
    return { ...result, label: `铁路网 (${best.display_name})`, description: `在"${best.display_name}"范围内找到 ${result.geojson?.features?.length || 0} 条铁路线路` };
  } catch (err) {
    return { type: 'custom', label: `铁路 (${placeName})`, geojson: null, description: '查询失败', error: err instanceof Error ? err.message : '未知错误' };
  }
}
