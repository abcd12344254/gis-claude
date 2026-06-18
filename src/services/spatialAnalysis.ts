import * as turf from '@turf/turf';
import type { FeatureCollection, Feature, Polygon, MultiPolygon, Point, LineString, MultiLineString } from 'geojson';
import type { SpatialAnalysisResult, MeasurementResult } from '../types';

/**
 * 执行缓冲区分析（支持 Polygon、MultiPolygon、LineString、Point）
 */
export function bufferAnalysis(
  featureCollection: FeatureCollection,
  radius: number,
  units: 'kilometers' | 'meters' | 'miles' = 'kilometers'
): SpatialAnalysisResult {
  try {
    const BUFFERABLE_TYPES = ['Polygon', 'MultiPolygon', 'LineString', 'MultiLineString', 'Point', 'MultiPoint'];

    // 1. 只保留可缓冲的几何要素
    const validFeatures = featureCollection.features.filter(f => {
      const t = f.geometry?.type;
      return BUFFERABLE_TYPES.includes(t || '') && f.geometry;
    });

    if (validFeatures.length === 0) {
      const types = [...new Set(featureCollection.features.map(f => f.geometry?.type))];
      return { type: 'buffer', result: null, description: `❌ 无可缓冲要素(图层类型:${types.join(',')})。支持: Polygon/LineString/Point` };
    }

    // 2. 逐个Feature独立缓冲（最稳定方式），然后合并
    const bufferedFeatures: Feature[] = [];
    let failedCount = 0;
    for (const f of validFeatures) {
      try {
        // 手动构建纯净Geometry，避免Turf内部类型检查报错
        const geom: any = f.geometry!;
        const cleanGeom: any = {
          type: geom.type,
          coordinates: geom.coordinates,
        };
        const cleanFeature: Feature = { type: 'Feature', geometry: cleanGeom, properties: {} };
        const result = turf.buffer(cleanFeature, radius, { units });
        if (result?.geometry) {
          bufferedFeatures.push(result);
        } else {
          failedCount++;
        }
      } catch { failedCount++; }
    }

    if (bufferedFeatures.length === 0) {
      return { type: 'buffer', result: null, description: `❌ 未能生成任何缓冲区 (${failedCount}个要素均失败)` };
    }

    // 3. 合并多个缓冲区，并附加描边线
    let mergedFeature: Feature;
    if (bufferedFeatures.length === 1) {
      mergedFeature = bufferedFeatures[0];
    } else {
      let m: any = bufferedFeatures[0];
      for (let i = 1; i < bufferedFeatures.length; i++) {
        try { m = turf.union(m, bufferedFeatures[i]) || m; } catch { /* skip */ }
      }
      mergedFeature = m;
    }

    // 从 Polygon 提取外环作为 LineString（确保线图层也能渲染）
    const outlineFeatures: Feature[] = [mergedFeature];
    const geom: any = mergedFeature.geometry;
    if (geom) {
      const rings: any[] = geom.type === 'Polygon' ? geom.coordinates : (geom.type === 'MultiPolygon' ? geom.coordinates.flat() : []);
      for (const ring of rings) {
        if (ring.length >= 2) {
          outlineFeatures.push({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: ring },
            properties: { _outline: true },
          });
        }
      }
    }

    const finalResult: FeatureCollection = { type: 'FeatureCollection', features: outlineFeatures };
    const unitLabel = units === 'kilometers' ? '公里' : units === 'meters' ? '米' : '英里';
    const warnPart = failedCount > 0 ? ` (${failedCount}个要素失败)` : '';
    return { type: 'buffer', result: finalResult, description: `✅ 缓冲区完成：半径 ${radius} ${unitLabel}，${bufferedFeatures.length}个要素${warnPart}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : '未知错误';
    return { type: 'buffer', result: null, description: `❌ 缓冲区失败：${msg}` };
  }
}

/**
 * 计算面积
 */
export function calculateArea(
  feature: Feature<Polygon | MultiPolygon>
): SpatialAnalysisResult {
  const area = turf.area(feature);
  const areaInSqKm = area / 1_000_000;
  const areaInMu = areaInSqKm * 1500; // 1 sq km = 1500 mu (亩)

  let areaStr: string;
  if (areaInSqKm >= 1) {
    areaStr = `${areaInSqKm.toFixed(2)} 平方公里 (${areaInMu.toFixed(2)} 亩)`;
  } else {
    areaStr = `${area.toFixed(2)} 平方米 (${areaInMu.toFixed(2)} 亩)`;
  }

  return {
    type: 'area',
    result: null,
    description: `面积计算结果：${areaStr}`,
  };
}

/**
 * 计算距离
 */
export function calculateDistance(
  from: Feature,
  to: Feature
): SpatialAnalysisResult {
  const distance = turf.distance(
    turf.center(from),
    turf.center(to),
    { units: 'kilometers' }
  );

  return {
    type: 'distance',
    result: null,
    description:
      distance >= 1
        ? `距离：${distance.toFixed(2)} 公里`
        : `距离：${(distance * 1000).toFixed(0)} 米`,
  };
}

/**
 * 叠加分析（支持混合几何类型）
 *
 * 策略：
 *   Polygon + Polygon   → turf.intersect 面面相交
 *   LineString + Polygon → 裁剪线到面内（clip）
 *   Point + Polygon      → 筛选面内的点
 *   其他组合             → 尝试通用相交
 */
export function intersectAnalysis(
  fc1: FeatureCollection,
  fc2: FeatureCollection
): SpatialAnalysisResult {
  const POLYGON_TYPES = ['Polygon', 'MultiPolygon'];
  const LINE_TYPES = ['LineString', 'MultiLineString'];
  const POINT_TYPES = ['Point', 'MultiPoint'];

  const types1 = [...new Set(fc1.features.map(f => f.geometry?.type).filter(Boolean))] as string[];
  const types2 = [...new Set(fc2.features.map(f => f.geometry?.type).filter(Boolean))] as string[];

  const hasPoly1 = types1.some(t => POLYGON_TYPES.includes(t));
  const hasPoly2 = types2.some(t => POLYGON_TYPES.includes(t));
  const hasLine1 = types1.some(t => LINE_TYPES.includes(t));
  const hasLine2 = types2.some(t => LINE_TYPES.includes(t));
  const hasPoint1 = types1.some(t => POINT_TYPES.includes(t));
  const hasPoint2 = types2.some(t => POINT_TYPES.includes(t));

  // ====== 策略：LineString + Polygon → 裁剪线到面内 ======
  if (hasLine1 && hasPoly2) {
    return clipLinesToPolygon(fc1, fc2);
  }
  if (hasLine2 && hasPoly1) {
    return clipLinesToPolygon(fc2, fc1);
  }

  // ====== 策略：Point + Polygon → 筛选面内的点 ======
  if (hasPoint1 && hasPoly2) {
    return filterPointsInPolygon(fc1, fc2);
  }
  if (hasPoint2 && hasPoly1) {
    return filterPointsInPolygon(fc2, fc1);
  }

  // ====== 策略：Polygon + Polygon → 面面相交（原逻辑） ======
  return polygonIntersect(fc1, fc2);
}

// ====== 线-面裁剪 ======

function clipLinesToPolygon(
  lineFC: FeatureCollection,
  polyFC: FeatureCollection
): SpatialAnalysisResult {
  const LINE_TYPES = ['LineString', 'MultiLineString'];
  const lines = lineFC.features.filter(f => LINE_TYPES.includes(f.geometry?.type || ''));

  // 合并所有 polygon 为一个用于判断
  const polys = polyFC.features.filter(
    f => ['Polygon', 'MultiPolygon'].includes(f.geometry?.type || '')
  );
  if (lines.length === 0 || polys.length === 0) {
    return {
      type: 'intersect', result: null,
      description: `❌ 线-面叠加需要至少一条线和至少一个面`,
    };
  }

  const resultLines: Feature[] = [];
  let insideCount = 0, partialCount = 0, outsideCount = 0;

  for (const line of lines) {
    for (const poly of polys) {
      try {
        // 先快速 BBox 检查
        const lb = turf.bbox(line);
        const pb = turf.bbox(poly);
        if (lb[0] > pb[2] || lb[2] < pb[0] || lb[1] > pb[3] || lb[3] < pb[1]) {
          outsideCount++;
          continue;
        }

        // 用 lineIntersect 找线与面边界的交点
        // 先把面的边界转成 LineString
        const boundary = turf.polygonToLine(poly as Feature<Polygon | MultiPolygon>);
        const crosses = turf.lineIntersect(line as any, boundary as any);

        if (crosses.features.length === 0) {
          // 线与边界无交点：要么全在里面，要么全在外面
          const midDist = turf.length(line as any) / 2;
          const midPt = turf.along(line as any, midDist);
          if (turf.booleanPointInPolygon(midPt, poly as Feature<Polygon | MultiPolygon>)) {
            resultLines.push({ ...line, properties: { ...((line as any).properties || {}), _clipped: false } });
            insideCount++;
          } else {
            outsideCount++;
          }
        } else {
          // 有交点：拆分线，保留面内的段
          const splitSegments = splitLineByPoints(
            line as Feature<LineString | MultiLineString>,
            crosses
          );
          let keptAny = false;
          for (const seg of splitSegments) {
            const segLen = turf.length(seg as any);
            if (segLen < 0.1) continue; // 跳过极短碎片（米级）
            const midDist = segLen / 2;
            const midPt = turf.along(seg as any, midDist);
            try {
              if (turf.booleanPointInPolygon(midPt, poly as Feature<Polygon | MultiPolygon>)) {
                resultLines.push({ ...seg, properties: { ...((line as any).properties || {}), _clipped: true } });
                keptAny = true;
              }
            } catch { /* 点在面判断失败，跳过此段 */ }
          }
          if (keptAny) partialCount++;
          else outsideCount++;
        }
      } catch { /* 单个要素失败，继续 */ }
    }
  }

  const total = insideCount + partialCount;
  const desc = total > 0
    ? `✅ 线-面叠加完成：${total} 条线在面内（${insideCount} 条完整包含 + ${partialCount} 条部分裁剪），${outsideCount} 条在面外`
    : `⚠️ 线-面叠加：所有 ${outsideCount} 条线都在面外或处理失败`;

  return {
    type: 'intersect',
    result: resultLines.length > 0 ? { type: 'FeatureCollection', features: resultLines } : null,
    description: desc,
  };
}

/** 用交点集合拆分一条线，返回所有线段 */
function splitLineByPoints(
  line: Feature<LineString | MultiLineString>,
  pointsFC: FeatureCollection
): Feature<LineString>[] {
  const coords = line.geometry.type === 'MultiLineString'
    ? (line.geometry as any).coordinates.flat()
    : (line.geometry as any).coordinates as [number, number][];

  // 计算每个交点在线上沿线的距离
  const totalLen = turf.length(line as any);
  const splitDists: number[] = [];
  for (const pt of pointsFC.features) {
    try {
      const snapped = turf.nearestPointOnLine(line as any, pt as any);
      const d = snapped.properties.location || 0; // 沿线的距离（公里）
      if (d > 0.001 && d < (totalLen - 0.001)) { // 排除端点附近的交点
        splitDists.push(d);
      }
    } catch {}
  }
  splitDists.sort((a, b) => a - b);

  if (splitDists.length === 0) {
    return [line as Feature<LineString>];
  }

  // 按交点距离开拆分
  const segments: Feature<LineString>[] = [];
  const allDists = [0, ...splitDists, totalLen];

  for (let i = 0; i < allDists.length - 1; i++) {
    const startDist = allDists[i];
    const endDist = allDists[i + 1];
    if (endDist - startDist < 0.0001) continue; // 跳过极短段

    try {
      const seg = turf.lineSlice(
        turf.along(line as any, startDist),
        turf.along(line as any, endDist),
        line as any
      );
      if (seg.geometry.coordinates.length >= 2) {
        segments.push(seg);
      }
    } catch {}
  }

  return segments;
}

// ====== 点-面筛选 ======

function filterPointsInPolygon(
  pointFC: FeatureCollection,
  polyFC: FeatureCollection
): SpatialAnalysisResult {
  const points = pointFC.features.filter(f =>
    ['Point', 'MultiPoint'].includes(f.geometry?.type || '')
  );
  const polys = polyFC.features.filter(f =>
    ['Polygon', 'MultiPolygon'].includes(f.geometry?.type || '')
  );

  const inside: Feature[] = [];
  for (const pt of points) {
    for (const poly of polys) {
      try {
        if (turf.booleanPointInPolygon((pt.geometry as any).coordinates, poly as any)) {
          inside.push(pt);
          break;
        }
      } catch {}
    }
  }

  return {
    type: 'intersect',
    result: inside.length > 0 ? { type: 'FeatureCollection', features: inside } : null,
    description: inside.length > 0
      ? `✅ 点-面叠加：${inside.length}/${points.length} 个点在面内`
      : `⚠️ 点-面叠加：无点在面内（共 ${points.length} 个点）`,
  };
}

// ====== 面-面相交（原逻辑） ======

function polygonIntersect(
  fc1: FeatureCollection,
  fc2: FeatureCollection
): SpatialAnalysisResult {
  const POLYGON_TYPES = ['Polygon', 'MultiPolygon'];

  const isValidPolygon = (f: Feature) =>
    POLYGON_TYPES.includes(f.geometry?.type || '') &&
    (f.geometry as any)?.coordinates?.length > 0;

  const polys1 = fc1.features.filter(isValidPolygon);
  const polys2 = fc2.features.filter(isValidPolygon);

  if (polys1.length === 0 || polys2.length === 0) {
    const types1 = [...new Set(fc1.features.map(f => f.geometry?.type))];
    const types2 = [...new Set(fc2.features.map(f => f.geometry?.type))];
    return {
      type: 'intersect',
      result: null,
      description: `❌ 相交分析需要两个图层都包含面状要素(Polygon)。图层1类型: ${types1.join(',') || '无'}，图层2类型: ${types2.join(',') || '无'}`,
    };
  }

  /**
   * 清洁几何体，使 Turf 相交算法能稳定计算：
   * 1. 截断浮点精度 → 2. 简化顶点 → 3. 修复自交
   */
  const prepareGeometry = (f: Feature, tolerance: number): Feature | null => {
    try {
      let cleaned = turf.truncate(f, { precision: 7, coordinates: 2 }) as Feature;
      if (tolerance > 0) {
        cleaned = turf.simplify(cleaned, { tolerance, highQuality: true }) as Feature;
      }
      // 修复自交多边形（自交是 Turf 相交失败的最常见原因）
      try {
        const unkinked = turf.unkinkPolygon(cleaned as Feature<Polygon | MultiPolygon>);
        if (unkinked.features.length === 1) {
          cleaned = unkinked.features[0];
        } else if (unkinked.features.length > 1) {
          // 多个碎片合回一个 Feature
          let merged: any = unkinked.features[0];
          for (let i = 1; i < unkinked.features.length; i++) {
            try { merged = turf.union(merged, unkinked.features[i] as any) || merged; } catch {}
          }
          cleaned = merged;
        }
      } catch { /* unkink 不可用则继续 */ }
      return cleaned;
    } catch {
      return null;
    }
  };

  const intersections: Feature[] = [];
  let skippedByBbox = 0;
  let bboxOverlapPairs = 0;
  let succeededAtTol: Record<number, number> = {}; // 记录在哪个容差级别成功的

  // 递进式容差（度）：0=原始, 0.00001≈1m, 0.0001≈10m, 0.001≈100m, 0.005≈500m
  const TOLERANCES = [0, 0.00001, 0.0001, 0.0005, 0.001, 0.005];

  for (const f1 of polys1) {
    for (const f2 of polys2) {
      const b1 = turf.bbox(f1);
      const b2 = turf.bbox(f2);
      if (b1[0] > b2[2] || b1[2] < b2[0] || b1[1] > b2[3] || b1[3] < b2[1]) {
        skippedByBbox++;
        continue;
      }
      bboxOverlapPairs++;

      for (const tol of TOLERANCES) {
        try {
          const p1 = tol === 0 ? f1 : prepareGeometry(f1, tol);
          const p2 = tol === 0 ? f2 : prepareGeometry(f2, tol);
          if (!p1 || !p2) continue;

          const intersection = turf.intersect(p1 as any, p2 as any);
          if (intersection && intersection.geometry) {
            intersections.push(intersection);
            succeededAtTol[tol] = (succeededAtTol[tol] || 0) + 1;
            break;
          }
        } catch { /* 当前容差失败，下一级 */ }
      }
    }
  }

  let desc: string;
  if (intersections.length > 0) {
    const tolInfo = Object.entries(succeededAtTol).map(([t, n]) => {
      const tNum = parseFloat(t);
      if (tNum === 0) return `${n}对直接成功`;
      return `${n}对需简化~${(tNum * 111000).toFixed(0)}m`;
    }).join('，');
    desc = `叠加分析：找到 ${intersections.length} 个相交区域（${tolInfo}）`;
  } else if (bboxOverlapPairs > 0) {
    desc = `叠加分析：${bboxOverlapPairs}对面要素BBox重叠但所有简化级别均相交失败。建议对两个图层分别做 simplify（容差0.001~0.01），再重试相交`;
  } else {
    desc = `叠加分析：未找到相交区域（BBox不重叠，数据确实不相交）`;
  }

  return {
    type: 'intersect',
    result: { type: 'FeatureCollection', features: intersections },
    description: desc,
  };
}

/**
 * 合并分析
 */
export function unionAnalysis(
  fc: FeatureCollection
): SpatialAnalysisResult {
  const valid = fc.features.filter(f => f.geometry);
  if (valid.length < 2) {
    return {
      type: 'union',
      result: fc,
      description: `需要至少两个有效要素才能合并（当前${valid.length}个）`,
    };
  }

  try {
    const unioned = turf.union(valid[0] as any, valid[1] as any);
    return {
      type: 'union',
      result: unioned
        ? { type: 'FeatureCollection', features: [unioned] }
        : null,
      description: '合并分析完成',
    };
  } catch (err) {
    return {
      type: 'union',
      result: null,
      description: `合并失败: ${err instanceof Error ? err.message : '未知错误'}`,
    };
  }
}

/**
 * 差集分析：从图层A中减去图层B
 */
export function differenceAnalysis(
  fc1: FeatureCollection,
  fc2: FeatureCollection
): SpatialAnalysisResult {
  const polys1 = fc1.features.filter(
    (f) => ['Polygon', 'MultiPolygon'].includes(f.geometry?.type || '')
  );
  const polys2 = fc2.features.filter(
    (f) => ['Polygon', 'MultiPolygon'].includes(f.geometry?.type || '')
  );

  if (polys1.length === 0 || polys2.length === 0) {
    const t1 = [...new Set(fc1.features.map((f) => f.geometry?.type))];
    const t2 = [...new Set(fc2.features.map((f) => f.geometry?.type))];
    return {
      type: 'difference',
      result: null,
      description: `❌ 差集分析需要两个图层都包含面状要素。图层1类型: ${t1.join(',') || '无'}，图层2类型: ${t2.join(',') || '无'}`,
    };
  }

  try {
    // 合并图层B为一个整体，再从图层A的每个要素中减去
    let mergedB: any = polys2[0];
    for (let i = 1; i < polys2.length; i++) {
      try { mergedB = turf.union(mergedB, polys2[i]) || mergedB; } catch { /* skip */ }
    }

    const results: Feature[] = [];
    let skipped = 0;
    for (const f1 of polys1) {
      try {
        const diff = turf.difference({ type: 'FeatureCollection', features: [f1, mergedB] } as any);
        if (diff && diff.geometry) {
          results.push(diff);
        } else {
          skipped++;
        }
      } catch { skipped++; }
    }

    if (results.length === 0) {
      return {
        type: 'difference',
        result: null,
        description: `⚠️ 差集完成：图层A的 ${polys1.length} 个要素全部被图层B覆盖`,
      };
    }

    return {
      type: 'difference',
      result: { type: 'FeatureCollection', features: results },
      description: `✅ 差集完成：${results.length} 个要素保留${skipped > 0 ? `（${skipped} 个被完整覆盖）` : ''}`,
    };
  } catch (err) {
    return {
      type: 'difference',
      result: null,
      description: `❌ 差集失败: ${err instanceof Error ? err.message : '未知错误'}`,
    };
  }
}

/**
 * 计算中心点
 */
export function calculateCentroid(
  fc: FeatureCollection
): SpatialAnalysisResult {
  const centroid = turf.centroid(fc);

  return {
    type: 'centroid',
    result: {
      type: 'FeatureCollection',
      features: [centroid],
    },
    description: `中心点坐标：[${centroid.geometry.coordinates[0].toFixed(6)}, ${centroid.geometry.coordinates[1].toFixed(6)}]`,
  };
}

/**
 * 计算边界框
 */
export function calculateBBox(
  fc: FeatureCollection
): SpatialAnalysisResult {
  const bbox = turf.bbox(fc);
  const bboxPolygon = turf.bboxPolygon(bbox);

  return {
    type: 'bbox',
    result: {
      type: 'FeatureCollection',
      features: [bboxPolygon],
    },
    description: `边界框：SW[${bbox[0].toFixed(6)}, ${bbox[1].toFixed(6)}] NE[${bbox[2].toFixed(6)}, ${bbox[3].toFixed(6)}]`,
  };
}

/**
 * 简化要素
 */
export function simplifyFeatures(
  fc: FeatureCollection,
  tolerance: number = 0.001
): SpatialAnalysisResult {
  const simplified = turf.simplify(fc, {
    tolerance,
    highQuality: true,
  });

  return {
    type: 'simplify',
    result: simplified as FeatureCollection,
    description: `简化完成：容差 ${tolerance}`,
  };
}

/**
 * 计算凸包
 */
export function convexHullAnalysis(
  fc: FeatureCollection
): SpatialAnalysisResult {
  const hull = turf.convex(fc);

  return {
    type: 'convex',
    result: hull
      ? { type: 'FeatureCollection', features: [hull] }
      : null,
    description: hull ? '凸包计算完成' : '无法计算凸包（需要至少3个不共线的点）',
  };
}

/**
 * 测量距离（多点线段）
 */
export function measureDistance(
  points: [number, number][]
): MeasurementResult {
  const line = turf.lineString(points);
  const length = turf.length(line, { units: 'kilometers' });

  return {
    type: 'distance',
    value: length,
    unit: length >= 1 ? 'km' : 'm',
    points,
  };
}

/**
 * 测量面积（多边形）
 */
export function measureArea(
  points: [number, number][]
): MeasurementResult {
  // Close the polygon if needed
  const closed =
    points[0][0] === points[points.length - 1][0] &&
    points[0][1] === points[points.length - 1][1]
      ? points
      : [...points, points[0]];

  const polygon = turf.polygon([closed]);
  const area = turf.area(polygon);

  return {
    type: 'area',
    value: area,
    unit: 'sqm',
    points: closed,
  };
}

/**
 * 空间查询 - 点在多边形内
 */
export function pointsWithinPolygon(
  points: FeatureCollection,
  polygon: Feature<Polygon>
): SpatialAnalysisResult {
  const ptsWithin = turf.pointsWithinPolygon(
    points as FeatureCollection<Point>,
    polygon
  );

  return {
    type: 'intersect',
    result: ptsWithin,
    description: `空间查询：${ptsWithin.features.length} 个点在多边形内`,
  };
}

/**
 * 邻近分析 - 查找最近要素
 */
export function findNearest(
  target: Feature,
  candidates: FeatureCollection,
  k: number = 3
): SpatialAnalysisResult {
  const centerPt = turf.center(target);
  const centerCoords = (centerPt.geometry as Point).coordinates;
  const nearest = turf.nearestPoint(
    centerCoords,
    candidates as FeatureCollection<Point>
  );

  return {
    type: 'distance',
    result: nearest
      ? { type: 'FeatureCollection', features: [nearest] }
      : null,
    description: nearest
      ? `最近的要素距离：${(turf.distance(turf.center(target as Feature<Point>), nearest, { units: 'kilometers' }) * 1000).toFixed(0)} 米`
      : '未找到邻近要素',
  };
}

/**
 * 创建格网（渔网）
 */
export function createGrid(
  bbox: [number, number, number, number],
  cellSide: number = 1,
  units: 'kilometers' | 'meters' | 'miles' = 'kilometers'
): SpatialAnalysisResult {
  const grid = turf.squareGrid(bbox, cellSide, { units });

  return {
    type: 'buffer',
    result: grid,
    description: `格网创建完成：${grid.features.length} 个网格单元`,
  };
}

/**
 * 点密度分析（简化版热力图数据）
 */
export function pointDensityAnalysis(
  points: FeatureCollection,
  cellSize: number = 0.01,
  radius: number = 0.05
): SpatialAnalysisResult {
  const bbox = turf.bbox(points);
  const grid = turf.squareGrid(bbox, cellSize, {
    units: 'degrees',
  });

  // Count points in each cell
  const densityFeatures = grid.features.map((cell) => {
    const ptsWithin = turf.pointsWithinPolygon(
      points as FeatureCollection<Point>,
      cell as Feature<Polygon>
    );
    return {
      ...cell,
      properties: {
        ...cell.properties,
        count: ptsWithin.features.length,
        density: ptsWithin.features.length / turf.area(cell as Feature<Polygon>),
      },
    };
  });

  return {
    type: 'buffer',
    result: {
      type: 'FeatureCollection',
      features: densityFeatures,
    },
    description: `点密度分析完成：${grid.features.length} 个格网单元`,
  };
}
