import * as turf from '@turf/turf';
import type { FeatureCollection, Feature, Polygon, MultiPolygon, Point, LineString, MultiLineString } from 'geojson';
import type { SpatialAnalysisResult, MeasurementResult } from '../types';

/**
 * 执行缓冲区分析（支持 Polygon、MultiPolygon、LineString、Point）
 * 性能优化：对大几何体预简化以减少 turf.buffer 计算量
 */
export function bufferAnalysis(
  featureCollection: FeatureCollection,
  radius: number,
  units: 'kilometers' | 'meters' | 'miles' = 'kilometers'
): SpatialAnalysisResult {
  try {
    const BUFFERABLE_TYPES = ['Polygon', 'MultiPolygon', 'LineString', 'MultiLineString', 'Point', 'MultiPoint'];

    // 1. 只保留可缓冲的几何要素，并对复杂几何体预简化
    const validFeatures = featureCollection.features.filter(f => {
      const t = f.geometry?.type;
      return BUFFERABLE_TYPES.includes(t || '') && f.geometry;
    });

    if (validFeatures.length === 0) {
      const types = [...new Set(featureCollection.features.map(f => f.geometry?.type))];
      return { type: 'buffer', result: null, description: `❌ 无可缓冲要素(图层类型:${types.join(',')})。支持: Polygon/LineString/Point` };
    }

    // 2. 逐个Feature独立缓冲，对大几何体预简化加速
    const bufferedFeatures: Feature[] = [];
    let failedCount = 0;
    for (const f of validFeatures) {
      try {
        const geom: any = f.geometry!;
        // 对高顶点数几何体先简化，大幅加速 turf.buffer
        let coords = geom.coordinates;
        const vertexCount = countVertices(coords);
        const simplifiedGeom = vertexCount > 500
          ? turf.simplify({ type: 'Feature', geometry: geom, properties: {} } as any, { tolerance: 0.0005, highQuality: false })
          : null;
        const cleanGeom: any = simplifiedGeom?.geometry
          ? { type: simplifiedGeom.geometry.type, coordinates: simplifiedGeom.geometry.coordinates }
          : { type: geom.type, coordinates: coords };
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

    // 3. 合并多个缓冲区
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

    // 只返回多边形结果（不含多余的描边线），让 MapLibre fill-outline 自然绘制边界
    const finalResult: FeatureCollection = { type: 'FeatureCollection', features: [mergedFeature] };
    const unitLabel = units === 'kilometers' ? '公里' : units === 'meters' ? '米' : '英里';
    const warnPart = failedCount > 0 ? ` (${failedCount}个要素失败)` : '';
    return { type: 'buffer', result: finalResult, description: `✅ 缓冲区完成：半径 ${radius} ${unitLabel}，${bufferedFeatures.length}个要素${warnPart}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : '未知错误';
    return { type: 'buffer', result: null, description: `❌ 缓冲区失败：${msg}` };
  }
}

/** 递归统计坐标数组中的顶点数 */
function countVertices(coords: any): number {
  if (typeof coords[0] === 'number') return 1;
  let count = 0;
  for (const item of coords) {
    count += countVertices(item);
  }
  return count;
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
 * 如果不是点图层，自动转为面的中心点
 */
export function pointDensityAnalysis(
  fc: FeatureCollection,
  cellSize: number = 0.01,
  radius: number = 0.05
): SpatialAnalysisResult {
  // 自动转换非点要素为中心点
  let points: FeatureCollection;
  const pointFeatures = fc.features.filter(f => f.geometry?.type === 'Point' || f.geometry?.type === 'MultiPoint');
  if (pointFeatures.length === 0) {
    // 把线/面要素转为中心点
    const centroids = fc.features
      .filter(f => f.geometry && (f.geometry.type.includes('Polygon') || f.geometry.type.includes('LineString')))
      .map(f => turf.centroid(f as Feature<any>));
    if (centroids.length === 0) {
      return { type: 'density', result: null, description: `❌ 图层无可用几何要素` };
    }
    points = turf.featureCollection(centroids) as FeatureCollection;
  } else {
    points = { type: 'FeatureCollection', features: pointFeatures } as FeatureCollection;
  }

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

// ====== 高级空间分析 ======

/**
 * DBSCAN 聚类分析
 * @param eps 邻域半径（km）
 * @param minPts 最小点数（默认 3）
 */
export function clusterDBSCAN(
  fc: FeatureCollection,
  eps: number,
  minPts: number = 3
): SpatialAnalysisResult {
  try {
    const points = fc.features.filter(
      f => f.geometry?.type === 'Point' || f.geometry?.type === 'MultiPoint'
    );
    if (points.length < minPts) {
      return { type: 'dbscan', result: null, description: `❌ 点数量(${points.length})少于minPts(${minPts})` };
    }

    // 提取坐标
    const coords = points.map(f => {
      const g = f.geometry as any;
      return g.type === 'MultiPoint' ? g.coordinates[0] : g.coordinates;
    });

    // 将 eps(km) 转为经度近似值
    const latMid = coords.reduce((s, c) => s + c[1], 0) / coords.length;
    const epsDeg = eps / (111.32 * Math.cos((latMid * Math.PI) / 180));
    const epsSq = epsDeg * epsDeg;

    // 手动 DBSCAN
    const visited = new Set<number>();
    const noise = new Set<number>();
    const clusters: number[][] = [];
    let clusterId = -1;

    const regionQuery = (idx: number): number[] => {
      const [x, y] = coords[idx];
      const neighbors: number[] = [];
      for (let j = 0; j < coords.length; j++) {
        if (j === idx) continue;
        const [xj, yj] = coords[j];
        const dx = x - xj, dy = y - yj;
        if (dx * dx + dy * dy <= epsSq) neighbors.push(j);
      }
      return neighbors;
    };

    for (let i = 0; i < coords.length; i++) {
      if (visited.has(i)) continue;
      visited.add(i);
      const neighbors = regionQuery(i);
      if (neighbors.length < minPts) {
        noise.add(i);
      } else {
        clusterId++;
        const cluster: number[] = [i];
        const seeds = [...neighbors];
        while (seeds.length > 0) {
          const j = seeds.pop()!;
          if (visited.has(j)) continue;
          visited.add(j);
          const jNeighbors = regionQuery(j);
          if (jNeighbors.length >= minPts) {
            seeds.push(...jNeighbors.filter(n => !visited.has(n)));
          }
          if (!noise.has(j)) {
            cluster.push(j);
            noise.delete(j);
          }
        }
        clusters.push(cluster);
      }
    }

    // 构建结果 FeatureCollection
    const colors = ['#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4',
      '#42d4f4', '#f032e6', '#bfef45', '#fabebe', '#469990', '#e6beff'];
    const resultFeatures: Feature[] = [];
    for (let c = 0; c < clusters.length; c++) {
      for (const idx of clusters[c]) {
        resultFeatures.push({
          ...points[idx],
          properties: {
            ...(points[idx].properties as any),
            _clusterId: c,
            _clusterColor: colors[c % colors.length],
            _clusterSize: clusters[c].length,
          },
        });
      }
    }
    // 噪点
    for (const idx of noise) {
      resultFeatures.push({
        ...points[idx],
        properties: {
          ...(points[idx].properties as any),
          _clusterId: -1,
          _clusterColor: '#999999',
          _clusterSize: 0,
        },
      });
    }

    return {
      type: 'dbscan',
      result: { type: 'FeatureCollection', features: resultFeatures },
      description: `DBSCAN 聚类完成：${clusters.length} 个簇，${noise.size} 个噪点（eps=${eps}km, minPts=${minPts}）`,
    };
  } catch (err) {
    return { type: 'dbscan', result: null, description: `❌ DBSCAN 失败: ${err instanceof Error ? err.message : err}` };
  }
}

/**
 * 核密度估计 (KDE)
 * @param bandwidth 带宽（km，默认 1km）
 * @param cellSize 输出格网大小（度，默认 0.01°）
 */
export function kernelDensityEstimation(
  fc: FeatureCollection,
  bandwidth: number = 1,
  cellSize: number = 0.01
): SpatialAnalysisResult {
  try {
    const points = fc.features.filter(
      f => f.geometry?.type === 'Point' || f.geometry?.type === 'MultiPoint'
    );
    if (points.length === 0) {
      return { type: 'kde', result: null, description: '❌ 无点要素可用于 KDE 分析' };
    }

    const coords = points.map(f => {
      const g = f.geometry as any;
      return g.type === 'MultiPoint' ? g.coordinates[0] : g.coordinates;
    });

    const bbox = turf.bbox(fc as any);
    const grid = turf.squareGrid(bbox, cellSize, { units: 'degrees' });

    // 带宽(km) 转 经度近似值
    const latMid = (bbox[1] + bbox[3]) / 2;
    const bwDeg = bandwidth / (111.32 * Math.cos((latMid * Math.PI) / 180));
    const bwSq2 = 2 * bwDeg * bwDeg;

    const gridCenters = grid.features.map(cell => {
      const center = turf.centroid(cell as Feature<Polygon>);
      return (center.geometry as Point).coordinates;
    });

    // Gaussian KDE
    const densityValues = gridCenters.map(([cx, cy]) => {
      let sum = 0;
      for (const [px, py] of coords) {
        const dx = cx - px, dy = cy - py;
        const distSq = dx * dx + dy * dy;
        sum += Math.exp(-distSq / bwSq2);
      }
      return sum / (coords.length * Math.PI * bwDeg * bwDeg * 2);
    });

    const maxDensity = Math.max(...densityValues, 1e-10);

    const features = grid.features.map((cell, i) => ({
      ...cell,
      properties: {
        ...cell.properties,
        _density: densityValues[i],
        _densityNorm: densityValues[i] / maxDensity,
      },
    }));

    return {
      type: 'kde',
      result: { type: 'FeatureCollection', features },
      description: `核密度估计完成：${grid.features.length} 个格网（带宽=${bandwidth}km, 像元=${cellSize}°）`,
    };
  } catch (err) {
    return { type: 'kde', result: null, description: `❌ KDE 失败: ${err instanceof Error ? err.message : err}` };
  }
}

/**
 * 反距离权重插值 (IDW)
 * @param valueField 要插值的数值字段名
 * @param resolution 输出格网分辨率（度，默认 0.01°）
 * @param power 距离权重幂（默认 2）
 */
export function interpolateIDW(
  fc: FeatureCollection,
  valueField: string,
  resolution: number = 0.01,
  power: number = 2
): SpatialAnalysisResult {
  try {
    const points = fc.features.filter(f => {
      const g = f.geometry?.type;
      const v = (f.properties as any)?.[valueField];
      return (g === 'Point' || g === 'MultiPoint') && typeof v === 'number' && !isNaN(v);
    });
    if (points.length < 3) {
      return { type: 'idw', result: null, description: `❌ 有效数值点(${points.length})不足，至少需要3个` };
    }

    const samples = points.map(f => ({
      coord: (f.geometry as any).type === 'MultiPoint'
        ? (f.geometry as any).coordinates[0]
        : (f.geometry as any).coordinates,
      value: (f.properties as any)[valueField] as number,
    }));

    const bbox = turf.bbox(fc as any);
    const grid = turf.squareGrid(bbox, resolution, { units: 'degrees' });

    const gridCenters = grid.features.map(cell => {
      const center = turf.centroid(cell as Feature<Polygon>);
      return (center.geometry as Point).coordinates;
    });

    const interpolated = gridCenters.map(([cx, cy]) => {
      let weightSum = 0, valueSum = 0;
      for (const s of samples) {
        const dx = cx - s.coord[0], dy = cy - s.coord[1];
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 1e-10) return s.value; // 精确命中
        const w = 1 / Math.pow(dist, power);
        weightSum += w;
        valueSum += w * s.value;
      }
      return weightSum > 0 ? valueSum / weightSum : NaN;
    });

    const validValues = interpolated.filter(v => !isNaN(v));
    const minVal = Math.min(...validValues);
    const maxVal = Math.max(...validValues);

    const features = grid.features.map((cell, i) => ({
      ...cell,
      properties: {
        ...cell.properties,
        _idwValue: isNaN(interpolated[i]) ? null : interpolated[i],
        _idwNorm: isNaN(interpolated[i]) ? null
          : (interpolated[i] - minVal) / (maxVal - minVal || 1),
      },
    }));

    return {
      type: 'idw',
      result: { type: 'FeatureCollection', features },
      description: `IDW 插值完成：${grid.features.length} 个格网（字段=${valueField}, 分辨率=${resolution}°）`,
    };
  } catch (err) {
    return { type: 'idw', result: null, description: `❌ IDW 插值失败: ${err instanceof Error ? err.message : err}` };
  }
}

/**
 * 分区统计 (Zonal Statistics)
 * 对每个区域多边形，统计内部点要素的数值字段
 * @param zones 区域面图层
 * @param dataPoints 点数据图层
 * @param valueField 要统计的数值字段
 */
export function zonalStatistics(
  zones: FeatureCollection,
  dataPoints: FeatureCollection,
  valueField: string
): SpatialAnalysisResult {
  try {
    const zoneFeatures = zones.features.filter(
      f => f.geometry?.type === 'Polygon' || f.geometry?.type === 'MultiPolygon'
    );
    if (zoneFeatures.length === 0) {
      return { type: 'zonal', result: null, description: '❌ 区域图层无面状要素' };
    }

    const pointFeatures = dataPoints.features.filter(f => {
      const g = f.geometry?.type;
      const v = (f.properties as any)?.[valueField];
      return (g === 'Point' || g === 'MultiPoint') && typeof v === 'number' && !isNaN(v);
    });

    if (pointFeatures.length === 0) {
      return { type: 'zonal', result: null, description: `❌ 点图层无有效数值字段"${valueField}"` };
    }

    const enrichedZones = zoneFeatures.map(zone => {
      // 使用 turf 的 booleanPointInPolygon 检查每个点
      let count = 0;
      let sum = 0;
      let min = Infinity;
      let max = -Infinity;
      const values: number[] = [];

      for (const pt of pointFeatures) {
        try {
          if (turf.booleanPointInPolygon(pt as Feature<Point>, zone as Feature<Polygon>)) {
            const v = (pt.properties as any)[valueField];
            count++;
            sum += v;
            min = Math.min(min, v);
            max = Math.max(max, v);
            values.push(v);
          }
        } catch { /* skip invalid */ }
      }

      const mean = count > 0 ? sum / count : 0;
      const stddev = count > 1
        ? Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / count)
        : 0;

      return {
        ...zone,
        properties: {
          ...(zone.properties as any),
          _zonal_count: count,
          _zonal_sum: sum,
          _zonal_mean: mean,
          _zonal_min: count > 0 ? min : null,
          _zonal_max: count > 0 ? max : null,
          _zonal_stddev: stddev,
        },
      };
    });

    const totalPoints = enrichedZones.reduce((s, z) => s + ((z.properties as any)._zonal_count || 0), 0);
    return {
      type: 'zonal',
      result: { type: 'FeatureCollection', features: enrichedZones },
      description: `分区统计完成：${zoneFeatures.length} 个区域，共包含 ${totalPoints} 个点（字段=${valueField}）`,
    };
  } catch (err) {
    return { type: 'zonal', result: null, description: `❌ 分区统计失败: ${err instanceof Error ? err.message : err}` };
  }
}
