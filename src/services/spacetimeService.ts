/**
 * 时空分析服务
 * - CSV 解析
 * - 模拟数据生成
 * - 时空立方体聚合
 * - 冷热点 Getis-Ord Gi* 分析
 */

// ====== 类型 ======

export interface SpaceTimePoint {
  lat: number;
  lng: number;
  time: number;    // 年份
  value: number;   // 数值（如犯罪数、病例数）
  category?: string;
}

export interface SpaceTimeBin {
  id: string;
  center: [number, number]; // [lng, lat]
  polygon: [number, number][][];
  values: Record<number, number>; // year → aggregated value
  totalValue: number;
  trend: 'increasing' | 'decreasing' | 'stable' | 'oscillating' | 'new' | 'disappearing';
  giZScore?: number;  // Getis-Ord Gi* Z-score
  giPValue?: number;
  hotspotType?: string; // 新兴/加剧/减弱/持续/振荡/分散/历史/无显著
}

export interface SpaceTimeCube {
  bins: SpaceTimeBin[];
  years: number[];
  extent: {
    west: number; east: number; south: number; north: number;
  };
  totalPoints: number;
}

// ====== CSV 解析 ======

export interface CSVParseResult {
  points: SpaceTimePoint[];
  errors: string[];
  columns: string[];
}

/**
 * 解析 CSV 文本为时空点数组
 * 期望列: lat/latitude, lng/longitude/lon, time/year/date, value/count/amount
 */
export function parseCSV(csvText: string): CSVParseResult {
  const lines = csvText.trim().split('\n');
  if (lines.length < 2) return { points: [], errors: ['CSV 至少需要标题行 + 1 行数据'], columns: [] };

  const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/"/g, ''));
  const errors: string[] = [];
  const points: SpaceTimePoint[] = [];

  // 自动检测列名
  const latIdx = headers.findIndex(h => h === 'lat' || h === 'latitude' || h === '纬度');
  const lngIdx = headers.findIndex(h => h === 'lng' || h === 'lon' || h === 'longitude' || h === '经度');
  const timeIdx = headers.findIndex(h => h === 'time' || h === 'year' || h === 'date' || h === '时间' || h === '年份');
  const valIdx = headers.findIndex(h => h === 'value' || h === 'count' || h === 'amount' || h === '值' || h === '数量');

  if (latIdx < 0) errors.push('缺纬度列 (lat/latitude)');
  if (lngIdx < 0) errors.push('缺经度列 (lng/lon/longitude)');
  if (timeIdx < 0) errors.push('缺时间列 (time/year)');
  if (valIdx < 0) errors.push('缺数值列 (value/count)，将默认设为 1');

  // 解析数据行
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.trim().replace(/"/g, ''));
    if (cols.length < headers.length) continue;

    const lat = parseFloat(cols[latIdx]);
    const lng = parseFloat(cols[lngIdx]);
    const time = parseInt(cols[timeIdx]);
    const value = valIdx >= 0 ? parseFloat(cols[valIdx]) : 1;

    if (isNaN(lat) || isNaN(lng) || isNaN(time)) {
      errors.push(`第${i + 1}行数据格式错误，已跳过`);
      continue;
    }

    if (isNaN(value) || value < 0) {
      errors.push(`第${i + 1}行数值无效，已跳过`);
      continue;
    }

    points.push({ lat, lng, time, value });
  }

  return { points, errors, columns: headers };
}

// ====== 模拟数据生成 ======

/**
 * 在指定区域内生成模拟时空点数据
 */
export function simulateSpaceTimePoints(
  bounds: { west: number; east: number; south: number; north: number },
  startYear: number,
  endYear: number,
  totalPoints: number,
  hotspotCenter?: [number, number] // 热点中心（模拟聚集效应）
): SpaceTimePoint[] {
  const points: SpaceTimePoint[] = [];
  const center = hotspotCenter || [
    (bounds.west + bounds.east) / 2,
    (bounds.south + bounds.north) / 2,
  ];

  const years = endYear - startYear + 1;
  const perYear = Math.floor(totalPoints / years);

  for (let y = startYear; y <= endYear; y++) {
    // 每年逐渐增加点数量（模拟增长趋势）
    const yearFactor = 0.7 + (0.3 * (y - startYear)) / (years - 1);
    const yearPoints = Math.floor(perYear * yearFactor);

    for (let i = 0; i < yearPoints; i++) {
      // 热点周围用高斯分布，其余均匀分布
      const isHotspot = Math.random() < 0.3;
      const spreadDeg = isHotspot ? 0.05 : 0.5;

      const lng = center[0] + (Math.random() - 0.5) * spreadDeg * 2;
      const lat = center[1] + (Math.random() - 0.5) * spreadDeg * 2;

      // 值随时间增长（模拟热点加剧）
      const baseValue = isHotspot ? 5 + Math.random() * 10 : 1 + Math.random() * 3;
      const value = baseValue * (0.8 + (0.4 * (y - startYear)) / years);

      points.push({ lat, lng, time: y, value: Math.round(value * 10) / 10, category: isHotspot ? 'hotspot' : 'normal' });
    }
  }

  return points;
}

// ====== 时空立方体聚合 ======

/**
 * 将时空点聚合为时空立方体（六边形或矩形网格 bin）
 */
export function buildSpaceTimeCube(
  points: SpaceTimePoint[],
  gridSize: number = 0.02 // 度，约 2km
): SpaceTimeCube {
  const years = [...new Set(points.map(p => p.time))].sort();
  const yearSet = new Set(years);

  // 计算空间范围
  let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity;
  for (const p of points) {
    if (p.lng < west) west = p.lng;
    if (p.lng > east) east = p.lng;
    if (p.lat < south) south = p.lat;
    if (p.lat > north) north = p.lat;
  }

  // 稍微扩展边界
  const margin = gridSize;
  west -= margin; east += margin; south -= margin; north += margin;

  // 网格聚合
  type BinKey = string;
  const binMap = new Map<BinKey, {
    values: Record<number, number>;
    points: SpaceTimePoint[];
    lngIdx: number;
    latIdx: number;
  }>();

  for (const p of points) {
    const lngIdx = Math.floor((p.lng - west) / gridSize);
    const latIdx = Math.floor((p.lat - south) / gridSize);
    const key = `${lngIdx},${latIdx}`;

    let bin = binMap.get(key);
    if (!bin) {
      bin = { values: {}, points: [], lngIdx, latIdx };
      binMap.set(key, bin);
    }
    bin.points.push(p);
    bin.values[p.time] = (bin.values[p.time] || 0) + p.value;
  }

  // 分析趋势
  const bins: SpaceTimeBin[] = [];
  for (const [key, bin] of binMap) {
    const centerLng = west + (bin.lngIdx + 0.5) * gridSize;
    const centerLat = south + (bin.latIdx + 0.5) * gridSize;

    // 构建格网 polygon
    const x = west + bin.lngIdx * gridSize;
    const y = south + bin.latIdx * gridSize;
    const polygon: [number, number][][] = [[
      [x, y],
      [x + gridSize, y],
      [x + gridSize, y + gridSize],
      [x, y + gridSize],
      [x, y],
    ]];

    // 填充缺失年份
    const values: Record<number, number> = {};
    for (const yr of years) {
      values[yr] = bin.values[yr] || 0;
    }

    const totalValue = Object.values(values).reduce((a, b) => a + b, 0);
    const trend = classifyTrend(values, years);

    bins.push({
      id: key,
      center: [centerLng, centerLat],
      polygon,
      values,
      totalValue,
      trend,
    });
  }

  return { bins, years, extent: { west, east, south, north }, totalPoints: points.length };
}

/** 分类趋势 */
function classifyTrend(
  values: Record<number, number>,
  years: number[]
): SpaceTimeBin['trend'] {
  const vals = years.map(y => values[y] || 0);
  const nonZeroVals = vals.filter(v => v > 0);

  if (nonZeroVals.length === 0) return 'disappearing';

  // 只在最后一年出现 → 新兴
  if (vals.slice(0, -1).every(v => v === 0) && vals[vals.length - 1] > 0) {
    return 'new';
  }

  // 只在早期出现，后来消失 → disappearing
  if (vals.slice(0, -1).some(v => v > 0) && vals[vals.length - 1] === 0) {
    return 'disappearing';
  }

  // 简单线性趋势
  const n = vals.length;
  const meanX = (n - 1) / 2;
  const meanY = vals.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - meanX) * (vals[i] - meanY);
    den += (i - meanX) ** 2;
  }

  if (den === 0) return 'stable';
  const slope = num / den;
  // 归一化斜率
  const normSlope = meanY > 0 ? slope / meanY : 0;

  if (normSlope > 0.1) return 'increasing';
  if (normSlope < -0.1) return 'decreasing';

  // 判断是否振荡
  let oscillations = 0;
  for (let i = 1; i < n - 1; i++) {
    if ((vals[i] - vals[i - 1]) * (vals[i + 1] - vals[i]) < 0) oscillations++;
  }
  if (oscillations >= 2) return 'oscillating';

  return 'stable';
}

// ====== Getis-Ord Gi* 热点分析 ======

/**
 * Getis-Ord Gi* 统计
 * 返回每个 bin 的 Z-score，正值=热点，负值=冷点
 */
export function getisOrdGi(
  bins: SpaceTimeBin[],
  year: number,
  distanceBand: number = 0.1 // 约 10km
): void {
  // 提取该年份所有非零值 bins
  const activeBins = bins.filter(b => b.values[year] > 0);
  if (activeBins.length < 3) return;

  const n = activeBins.length;

  // 构建空间权重矩阵（基于距离）
  const weights: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = haversineDist(activeBins[i].center, activeBins[j].center);
      if (d < distanceBand) {
        weights[i][j] = 1;
        weights[j][i] = 1;
      }
    }
  }

  // 计算 Gi*
  const values = activeBins.map(b => b.values[year]);
  const meanX = values.reduce((a, v) => a + v, 0) / n;
  const stdX = Math.sqrt(values.reduce((s, v) => s + (v - meanX) ** 2, 0) / n);

  if (stdX === 0) return;

  for (let i = 0; i < n; i++) {
    const wi = weights[i].reduce((a, w) => a + w, 0);
    if (wi === 0) continue;

    let sumWX = 0;
    for (let j = 0; j < n; j++) {
      sumWX += weights[i][j] * values[j];
    }

    const s1i = weights[i].reduce((a, w) => a + w ** 2, 0);
    const num = sumWX - wi * meanX;
    const den = stdX * Math.sqrt((n * wi - wi ** 2) / (n - 1));
    const zScore = den > 0 ? num / den : 0;

    // 将 Z-score 写回原始 bin
    const origBin = bins.find(b => b.id === activeBins[i].id);
    if (origBin && Math.abs(zScore) > 0.5) {
      origBin.giZScore = zScore;
      origBin.giPValue = 2 * (1 - normalCDF(Math.abs(zScore)));
      origBin.hotspotType = classifyHotspot(zScore, origBin.trend);
    }
  }
}

function classifyHotspot(zScore: number, trend: SpaceTimeBin['trend']): string {
  if (Math.abs(zScore) < 1.65) return '无显著';

  const isHot = zScore > 0;
  if (isHot) {
    if (trend === 'new' || trend === 'increasing') return '新兴热点';
    if (trend === 'stable') return '持续热点';
    if (trend === 'decreasing') return '减弱热点';
    if (trend === 'oscillating') return '振荡热点';
    return '热点';
  } else {
    return '冷点';
  }
}

function normalCDF(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

function haversineDist(a: [number, number], b: [number, number]): number {
  const R = 6371;
  const dLat = ((b[1] - a[1]) * Math.PI) / 180;
  const dLon = ((b[0] - a[0]) * Math.PI) / 180;
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const aVal = sinDLat * sinDLat + Math.cos((a[1] * Math.PI) / 180) * Math.cos((b[1] * Math.PI) / 180) * sinDLon * sinDLon;
  return 2 * R * Math.atan2(Math.sqrt(aVal), Math.sqrt(1 - aVal));
}

// ====== 热点颜色映射 ======

export const HOTSPOT_COLORS: Record<string, string> = {
  '新兴热点': '#e03131',
  '持续热点': '#f08c00',
  '减弱热点': '#fab005',
  '振荡热点': '#74b816',
  '冷点': '#339af0',
  '热点': '#ff6b6b',
  '无显著': '#adb5bd',
};

export const TREND_COLORS: Record<string, string> = {
  increasing: '#e03131',
  decreasing: '#339af0',
  stable: '#74b816',
  oscillating: '#fab005',
  new: '#f06595',
  disappearing: '#adb5bd',
};
