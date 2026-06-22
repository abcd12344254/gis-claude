/**
 * 自然语言数据筛选服务
 *
 * 支持的自然语言模式：
 *   "人口大于100万"          → 数值比较
 *   "面积小于50平方公里"     → 数值比较 + 单位
 *   "名称包含武汉"           → 字符串匹配
 *   "GDP最高的5个"           → Top-N 排序
 *   "人口密度大于500"        → 数值比较
 *   "类型等于商业"           → 精确匹配
 *   "鄱阳湖"                 → 关键词搜索（所有字段）
 */

import type { FeatureCollection, Feature } from 'geojson';

export interface QueryCondition {
  field: string;           // 匹配到的字段名
  operator: 'gt' | 'lt' | 'gte' | 'lte' | 'eq' | 'contains' | 'top' | 'search';
  value: number | string;  // 比较值
  topN?: number;           // top 模式时的 N
  rawText: string;         // 原始输入文本
}

export interface QueryResult {
  type: 'query';
  result: FeatureCollection | null;
  description: string;
  matchedCondition?: QueryCondition;
  matchedField?: string;
}

/**
 * 常见数值单位的归一化
 */
const UNIT_PATTERNS: Array<{ regex: RegExp; multiplier: number }> = [
  { regex: /(\d+\.?\d*)\s*万/g, multiplier: 10000 },
  { regex: /(\d+\.?\d*)\s*亿/g, multiplier: 100000000 },
  { regex: /(\d+\.?\d*)\s*千/g, multiplier: 1000 },
  { regex: /(\d+\.?\d*)\s*百万/g, multiplier: 1000000 },
  { regex: /(\d+\.?\d*)\s*千万/g, multiplier: 10000000 },
];

/** 将中文数字表达式归一化为纯数值 */
function normalizeNumber(text: string): { normalized: string; original: string } {
  let result = text;
  for (const { regex, multiplier } of UNIT_PATTERNS) {
    result = result.replace(regex, (_, num) => String(parseFloat(num) * multiplier));
  }
  return { normalized: result, original: text };
}

/** 从自然语言中解析筛选条件 */
export function parseNLQuery(
  text: string,
  availableFields: string[]
): QueryCondition | null {
  const input = text.trim();
  if (!input || input.length < 2) return null;

  // 纯搜索词（没有比较运算符）→ 全字段关键词搜索
  const hasComparator = /大于|小于|等于|高于|低于|超过|不足|最多|最少|最大|最小|最高|最低|包含|前\d+|top\s*\d/i.test(input);
  if (!hasComparator && input.length >= 2) {
    return { field: '*', operator: 'search', value: input, rawText: input };
  }

  // Top-N 模式："GDP最高的5个" / "人口最多的10个"
  const topMatch = input.match(/(.+?)(?:最高|最大|最多|最低|最小|最少)的?\s*(?:前)?(\d+)\s*(?:个|条|项)?/);
  if (topMatch) {
    const fieldHint = topMatch[1].trim();
    const topN = parseInt(topMatch[2]);
    const field = findBestField(fieldHint, availableFields);
    if (field) {
      return { field, operator: 'top', value: topN, topN, rawText: input };
    }
  }

  // 比较模式："人口大于100万" / "面积小于50"
  const compMatch = input.match(/(.+?)(大于|小于|等于|高于|低于|超过|>=|<=|>|<|=)\s*([\d.]+)\s*(万|亿|千|百万|千万|平方公里|km²|km2|米|m|人|个)?/i);
  if (compMatch) {
    const fieldHint = compMatch[1].trim();
    const opStr = compMatch[2];
    let value = parseFloat(compMatch[3]);

    // 单位换算
    const unit = compMatch[4] || '';
    if (unit === '万') value *= 10000;
    else if (unit === '亿') value *= 100000000;
    else if (unit === '千') value *= 1000;
    else if (unit === '百万') value *= 1000000;

    const operator: QueryCondition['operator'] =
      /大于|高于|超过|>/.test(opStr) ? 'gt' :
      /小于|低于|不足|</.test(opStr) ? 'lt' :
      /等于|=/.test(opStr) ? 'eq' : 'gt';

    const field = findBestField(fieldHint, availableFields);
    if (field) {
      return { field, operator, value, rawText: input };
    }
  }

  // 包含模式："名称包含武汉"
  const containsMatch = input.match(/(.+?)\s*(?:包含|含有|有)\s*(.+)/);
  if (containsMatch) {
    const fieldHint = containsMatch[1].trim();
    const searchValue = containsMatch[2].trim();
    const field = findBestField(fieldHint, availableFields.includes('name') ? ['name'] : availableFields);
    if (field) {
      return { field, operator: 'contains', value: searchValue, rawText: input };
    }
  }

  // 回退：全字段关键词搜索
  return { field: '*', operator: 'search', value: input, rawText: input };
}

/** 从可用字段中找到最匹配的字段名 */
function findBestField(hint: string, fields: string[]): string | null {
  if (fields.length === 0) return null;

  const h = hint.toLowerCase().trim();

  // 1. 精确匹配
  const exact = fields.find(f => f.toLowerCase() === h);
  if (exact) return exact;

  // 2. 字段名包含提示词
  const contains = fields.find(f => f.toLowerCase().includes(h));
  if (contains) return contains;

  // 3. 提示词包含字段名
  const reverse = fields.find(f => h.includes(f.toLowerCase()));
  if (reverse) return reverse;

  // 4. 常见别名映射
  const aliases: Record<string, string[]> = {
    '人口': ['population', 'pop', '人口', '总人口', '人口数'],
    '面积': ['area', '面积', '总面积', '区域面积'],
    '名称': ['name', '名称', '地名', '小区名'],
    'gdp': ['gdp', '生产总值', '经济总量'],
    '密度': ['density', '密度', '人口密度'],
    '收入': ['income', '收入', '人均收入', '总收入'],
    '价格': ['price', '价格', '房价', '均价', '单价'],
    '数量': ['count', '数量', '个数', '总数'],
  };

  for (const [, aliasesList] of Object.entries(aliases)) {
    if (aliasesList.some(a => h.includes(a) || a.includes(h))) {
      for (const alias of aliasesList) {
        const match = fields.find(f => f.toLowerCase() === alias.toLowerCase());
        if (match) return match;
      }
    }
  }

  // 5. 返回第一个数值字段作为默认
  return fields[0] || null;
}

/** 执行筛选 */
export function executeQuery(
  fc: FeatureCollection,
  condition: QueryCondition
): QueryResult {
  try {
    const { field, operator, value, topN } = condition;

    // 全字段关键词搜索
    if (operator === 'search') {
      const searchStr = String(value).toLowerCase();
      const matched = fc.features.filter(f => {
        const props = f.properties || {};
        return Object.values(props).some(v =>
          String(v).toLowerCase().includes(searchStr)
        );
      });
      return {
        type: 'query',
        result: matched.length > 0 ? { type: 'FeatureCollection', features: matched } : null,
        description: matched.length > 0
          ? `🔍 关键词"${searchStr}"匹配到 ${matched.length} 个要素（共 ${fc.features.length} 个）`
          : `🔍 关键词"${searchStr}"未匹配到任何要素`,
        matchedCondition: condition,
      };
    }

    // Top-N
    if (operator === 'top') {
      const sorted = [...fc.features].sort((a, b) => {
        const av = (a.properties as any)?.[field];
        const bv = (b.properties as any)?.[field];
        if (typeof av !== 'number' || typeof bv !== 'number') return 0;
        return bv - av; // 降序
      });
      const n = topN || 5;
      const top = sorted.slice(0, n);
      return {
        type: 'query',
        result: { type: 'FeatureCollection', features: top },
        description: `🏆 "${field}"最高的 ${Math.min(n, top.length)} 个要素`,
        matchedCondition: condition,
        matchedField: field,
      };
    }

    // 数值比较
    if (['gt', 'lt', 'gte', 'lte', 'eq'].includes(operator)) {
      const numValue = typeof value === 'string' ? parseFloat(value) : value;
      const filtered = fc.features.filter(f => {
        const v = (f.properties as any)?.[field];
        if (typeof v !== 'number' || isNaN(v)) return false;
        switch (operator) {
          case 'gt': return v > numValue;
          case 'lt': return v < numValue;
          case 'gte': return v >= numValue;
          case 'lte': return v <= numValue;
          case 'eq': return Math.abs(v - numValue) < 0.001;
        }
      });

      const opLabel: Record<string, string> = {
        gt: '>', lt: '<', gte: '≥', lte: '≤', eq: '=',
      };
      const label = opLabel[operator] || operator;

      return {
        type: 'query',
        result: filtered.length > 0 ? { type: 'FeatureCollection', features: filtered } : null,
        description: filtered.length > 0
          ? `📊 "${field}" ${label} ${numValue} → ${filtered.length} 个要素（共 ${fc.features.length} 个）`
          : `📊 "${field}" ${label} ${numValue} → 无匹配要素`,
        matchedCondition: condition,
        matchedField: field,
      };
    }

    // 字符串包含
    if (operator === 'contains') {
      const strValue = String(value).toLowerCase();
      const filtered = fc.features.filter(f => {
        const v = (f.properties as any)?.[field];
        return String(v || '').toLowerCase().includes(strValue);
      });
      return {
        type: 'query',
        result: filtered.length > 0 ? { type: 'FeatureCollection', features: filtered } : null,
        description: filtered.length > 0
          ? `🔍 "${field}"包含"${strValue}" → ${filtered.length} 个要素`
          : `🔍 "${field}"包含"${strValue}" → 无匹配要素`,
        matchedCondition: condition,
        matchedField: field,
      };
    }

    return { type: 'query', result: null, description: '未知查询条件' };
  } catch (err) {
    return {
      type: 'query',
      result: null,
      description: `❌ 筛选异常: ${err instanceof Error ? err.message : '未知错误'}`,
    };
  }
}

/** 扫描图层中的可用字段 */
export function getQueryableFields(fc: FeatureCollection): string[] {
  const fieldSet = new Set<string>();
  for (const f of fc.features.slice(0, 50)) { // 只扫描前50个要素就够了
    const props = f.properties || {};
    for (const k of Object.keys(props)) {
      if (!k.startsWith('_')) fieldSet.add(k);
    }
  }
  return [...fieldSet].sort();
}
