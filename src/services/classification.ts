/**
 * 分层着色（Choropleth）服务
 *
 * 支持：
 *   - 分位数法（Quantile）—— 每类等量要素
 *   - 等距法（Equal Interval）—— 每类等值区间
 *   - 内建 6 套色带
 */
import type { FeatureCollection } from 'geojson';

export type ClassifyMethod = 'quantile' | 'equalInterval';

export const COLOR_RAMPS: Record<string, { name: string; colors: string[] }> = {
  blues:    { name: '渐变蓝', colors: ['#deebf7', '#c6dbef', '#9ecae1', '#6baed6', '#3182bd'] },
  greens:   { name: '渐变绿', colors: ['#e5f5e0', '#c7e9c0', '#a1d99b', '#74c476', '#31a354'] },
  reds:     { name: '渐变红', colors: ['#fee5d9', '#fcbba1', '#fc9272', '#fb6a4a', '#de2d26'] },
  oranges:  { name: '渐变橙', colors: ['#feedde', '#fdbe85', '#fd8d3c', '#e6550d', '#a63603'] },
  purples:  { name: '渐变紫', colors: ['#efedf5', '#dadaeb', '#bcbddc', '#9e9ac8', '#756bb1'] },
  redGreen: { name: '红绿对比', colors: ['#d73027', '#fc8d59', '#ffffbf', '#91bf60', '#1a9850'] },
};

export interface ClassifyResult {
  field: string;
  method: ClassifyMethod;
  breaks: number[];
  rampName: string;
  legend: { range: string; color: string }[];
  error?: string;
}

/**
 * 对 FeatureCollection 按指定数值字段进行分层着色
 *
 * 为每个 feature 的 properties 注入：
 *   _classifyColor — 该要素的分层颜色
 *   _classifyValue — 该字段的原始值
 *   _classifyLabel — 可读的分级标签（如 "120–350 人/km²"）
 *
 * @returns 修改后的 FeatureCollection + 分级元信息
 */
export function applyClassification(
  fc: FeatureCollection,
  field: string,
  rampKey: string = 'blues',
  method: ClassifyMethod = 'quantile'
): { geojson: FeatureCollection; result: ClassifyResult } {
  const ramp = COLOR_RAMPS[rampKey]?.colors || COLOR_RAMPS.blues.colors;
  const nClasses = ramp.length;

  // 1. 收集所有要素的数值
  const values: { idx: number; value: number }[] = [];
  fc.features.forEach((f, i) => {
    const v = (f.properties as any)?.[field];
    if (v != null && typeof v === 'number' && !isNaN(v)) {
      values.push({ idx: i, value: v });
    }
  });

  if (values.length === 0) {
    const available = findNumericFields(fc);
    return {
      geojson: fc,
      result: {
        field, method, breaks: [], rampName: rampKey,
        legend: [],
        error: available.length > 0
          ? `字段"${field}"不存在或无数值。可用字段: ${available.join(', ')}`
          : `该图层没有可分级数值字段`,
      },
    };
  }

  // 2. 计算分级断点
  const sorted = values.map((v) => v.value).sort((a, b) => a - b);
  const breaks = method === 'quantile'
    ? computeQuantileBreaks(sorted, nClasses)
    : computeEqualIntervalBreaks(sorted, nClasses);

  // 3. 为每个要素分配颜色
  const classIndex = (v: number): number => {
    for (let i = 0; i < breaks.length; i++) {
      if (v <= breaks[i]) return i;
    }
    return breaks.length - 1;
  };

  const features = fc.features.map((f, i) => {
    const v = (f.properties as any)?.[field];
    const num = (v != null && typeof v === 'number' && !isNaN(v)) ? v : null;
    const ci = num != null ? classIndex(num) : -1;
    return {
      ...f,
      properties: {
        ...(f.properties as any),
        _classifyColor: ci >= 0 ? ramp[ci] : null,
        _classifyValue: num,
        _classifyIndex: ci,
      },
    };
  });

  // 4. 生成图例
  const legend = breaks.map((brk, i) => {
    const lo = i === 0 ? sorted[0] : breaks[i - 1];
    const hi = brk;
    const fmt = (n: number) => {
      if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
      if (n >= 10000) return (n / 10000).toFixed(1) + '万';
      if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
      return Number.isInteger(n) ? String(n) : n.toFixed(1);
    };
    return { range: `${fmt(lo)} – ${fmt(hi)}`, color: ramp[i] };
  });

  return {
    geojson: { type: 'FeatureCollection', features },
    result: { field, method, breaks, rampName: rampKey, legend },
  };
}

/**
 * 分位数断点：每类包含约等量要素
 */
function computeQuantileBreaks(sorted: number[], nClasses: number): number[] {
  const breaks: number[] = [];
  const n = sorted.length;
  for (let i = 1; i < nClasses; i++) {
    const idx = Math.floor((i / nClasses) * n);
    breaks.push(sorted[Math.min(idx, n - 1)]);
  }
  return breaks;
}

/**
 * 等距断点：值范围均匀分割
 */
function computeEqualIntervalBreaks(sorted: number[], nClasses: number): number[] {
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const step = (max - min) / nClasses;
  const breaks: number[] = [];
  for (let i = 1; i < nClasses; i++) {
    breaks.push(min + step * i);
  }
  return breaks;
}

/**
 * 扫描 FeatureCollection 的所有数值字段
 * @returns 字段名列表（排除内部 _ 开头字段和 name/osm_id 等标识字段）
 */
export function findNumericFields(fc: FeatureCollection): string[] {
  const skip = new Set(['osm_id', 'osm_type', '@id', 'name', 'name:zh', 'name:en']);
  const fieldCounts = new Map<string, number>();
  const fieldTotal = new Map<string, number>();

  for (const f of fc.features) {
    const props = (f.properties || {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(props)) {
      if (k.startsWith('_') || skip.has(k)) continue;
      fieldTotal.set(k, (fieldTotal.get(k) || 0) + 1);
      if (typeof v === 'number' && !isNaN(v)) {
        fieldCounts.set(k, (fieldCounts.get(k) || 0) + 1);
      }
    }
  }

  // 只返回至少有 2 个数值的字段（单个值无法分级）
  return [...fieldCounts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => k);
}
