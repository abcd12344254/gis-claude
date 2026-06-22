/**
 * 工具反馈循环 — AI 执行指令后，收集结果并注入对话，
 * 让 AI 能验证、纠错、迭代，实现真正的"Claude 式"多轮工具使用。
 */

import type { FeatureCollection } from 'geojson';
import type { ChatMessage } from '../types';

// ====== 类型定义 ======

export interface ToolResult {
  toolType: 'osm' | 'analysis' | 'route' | 'hazard' | 'local' | 'spacetime';
  success: boolean;
  description: string;
  layerName?: string;
  featureCount?: number;
  error?: string;
}

export interface ToolFeedbackContext {
  results: ToolResult[];
  totalSuccess: number;
  totalFailure: number;
  newLayerNames: string[];
}

// ====== 收集工具执行结果 ======

/** 从本次对话回合新增的消息中提取工具执行结果 */
export function collectToolResults(
  newMessages: ChatMessage[],
  osmResults?: Record<string, { label?: string; geojson?: FeatureCollection | null; description?: string; error?: string }>
): ToolResult[] {
  const results: ToolResult[] = [];

  // 1. 从新增的聊天消息中提取（route/analysis/hazard/local）
  for (const msg of newMessages) {
    if (msg.id.startsWith('route-')) {
      const success = !msg.content.includes('失败') && !msg.content.includes('错误');
      results.push({
        toolType: 'route',
        success,
        description: msg.content.replace(/^\*\*路径规划\*\*:\s*/, '').replace(/^🧭\s*\*\*路径规划\*\*:\s*/, ''),
        error: success ? undefined : msg.content,
      });
    } else if (msg.id.startsWith('analysis-')) {
      const success = !msg.content.includes('失败') && !msg.content.includes('未知分析') && !msg.content.includes('未找到图层');
      results.push({
        toolType: 'analysis',
        success,
        description: msg.content.replace(/^\*\*空间分析结果\*\*:\s*/, '').replace(/^🔬\s*\*\*空间分析结果\*\*:\s*/, ''),
        error: success ? undefined : msg.content,
      });
    } else if (msg.id.startsWith('hazard-')) {
      const success = !msg.content.includes('失败');
      results.push({
        toolType: 'hazard',
        success,
        description: msg.content.replace(/^\*\*灾害数据\*\*:\s*/, '').replace(/^🌍\s*\*\*灾害数据\*\*:\s*/, ''),
        error: success ? undefined : msg.content,
      });
    } else if (msg.id.startsWith('local-')) {
      const success = !msg.content.includes('失败') && !msg.content.includes('未找到');
      results.push({
        toolType: 'local',
        success,
        description: msg.content.replace(/^\*\*本地文件\*\*:\s*/, '').replace(/^📂\s*\*\*本地文件\*\*:\s*/, ''),
        error: success ? undefined : msg.content,
      });
    }
  }

  // 2. 从 OSM 执行结果中提取
  if (osmResults) {
    for (const [key, result] of Object.entries(osmResults)) {
      if (!result || (!result.geojson && !result.error)) continue;
      const success = !!result.geojson && result.geojson.features.length > 0;
      results.push({
        toolType: 'osm',
        success,
        description: result.description || result.label || key,
        layerName: success && result.geojson ? result.label : undefined,
        featureCount: success && result.geojson ? result.geojson.features.length : undefined,
        error: !success ? (result.error || '查询无结果') : undefined,
      });
    }
  }

  return results;
}

// ====== 格式化 ======

/** 将工具执行结果格式化为 AI 可理解的简洁文本 */
export function formatToolResultsForAI(results: ToolResult[]): string {
  if (results.length === 0) return '';

  const lines: string[] = ['## 🆕 本次操作结果（刚刚执行）', ''];

  const successResults = results.filter(r => r.success);
  const failedResults = results.filter(r => !r.success);

  if (successResults.length > 0) {
    lines.push('✅ 成功：');
    for (const r of successResults) {
      const icon = {
        osm: '🗺️', analysis: '🔬', route: '🧭', hazard: '🌍', local: '📂', spacetime: '🕐',
      }[r.toolType];
      const detail = r.featureCount ? `（${r.featureCount}个要素）` : '';
      const layerInfo = r.layerName ? ` → 新图层"${r.layerName}"已加载` : '';
      lines.push(`  ${icon} [${r.toolType}] ${r.description}${detail}${layerInfo}`);
    }
  }

  if (failedResults.length > 0) {
    lines.push('');
    lines.push('❌ 失败：');
    for (const r of failedResults) {
      const icon = {
        osm: '🗺️', analysis: '🔬', route: '🧭', hazard: '🌍', local: '📂', spacetime: '🕐',
      }[r.toolType];
      lines.push(`  ${icon} [${r.toolType}] ${r.description} — 原因: ${r.error || '未知'}`);
    }
  }

  const newLayerNames = successResults
    .filter(r => r.layerName)
    .map(r => r.layerName!);

  if (newLayerNames.length > 0) {
    lines.push('');
    lines.push(`📌 本次新增图层: ${newLayerNames.join('、')}`);
  }

  return lines.join('\n');
}

/** 构建反馈消息的用户内容（清晰区分新旧图层） */
export function buildFeedbackUserContent(
  userOriginalRequest: string,
  toolResultsText: string,
  spatialContextText: string
): string {
  const lines = [
    '[用户原始请求]',
    userOriginalRequest,
    '',
    toolResultsText,
    '',
    '---',
    '',
    '## 🗺️ 地图上已有图层（含之前的操作结果，仅供参考）',
    '',
    spatialContextText || '(当前地图无可见图层)',
    '',
    '---',
    '⚠️ 重要提示：',
    '- "本次操作结果"是你刚才的指令执行后新加载的图层，需要在回复中重点说明',
    '- "地图上已有图层"是之前就存在的，只需顺带提及，不要把它们当作本次操作的结果',
    '- 如果"地图上已有图层"中有与本次请求无关的内容（如其他城市的图层），一律忽略不要提及！',
    '- 不要编造地名！所有地名必须来自上面的实际数据',
  ];
  return lines.join('\n');
}

// ====== 快捷操作建议解析 ======

/** 从 AI 回复文本中提取建议操作列表 */
export function extractSuggestedActions(text: string): string[] {
  const actions: string[] = [];

  // 匹配 "💡 试试这些操作：" 后面的列表项
  const suggestMatch = text.match(/💡\s*试试这些操作[：:]\s*\n([\s\S]*?)(?:\n\n|$)/);
  if (suggestMatch) {
    const listText = suggestMatch[1];
    const items = listText.match(/[-*]\s*(.+)/g);
    if (items) {
      for (const item of items) {
        const action = item.replace(/^[-*]\s*/, '').trim();
        if (action && action.length >= 2 && !action.startsWith('[')) {
          actions.push(action);
        }
      }
    }
  }

  // 备用：匹配以 "建议" 开头的列表
  if (actions.length === 0) {
    const altMatch = text.match(/(?:建议下一步|可以尝试|试试)[：:]\s*\n([\s\S]*?)(?:\n\n|$)/);
    if (altMatch) {
      const items = altMatch[1].match(/[-*]\s*(.+)/g);
      if (items) {
        for (const item of items) {
          const action = item.replace(/^[-*]\s*/, '').trim();
          if (action && action.length >= 2 && !action.startsWith('[')) {
            actions.push(action);
          }
        }
      }
    }
  }

  return actions.slice(0, 5); // 最多 5 个
}

// ====== 系统提示词 ======

export const FEEDBACK_SYSTEM_PROMPT = `你是 GIS Claude，专业的地理信息系统智能助手。

你刚才为用户执行了 GIS 操作（查询地图数据、空间分析、路径规划等）。现在你收到了包含三部分的消息：

1. **[用户原始请求]** — 用户最初的自然语言
2. **🆕 本次操作结果** — 你生成的指令执行后的实际结果（这是你刚刚做的，需要重点回复）
3. **🗺️ 地图上已有图层** — 地图上之前就存在的图层（仅供参考，不要把这些当作你刚才的操作结果！）

请严格回复：
1. 基于"本次操作结果"简洁总结你刚做了什么
2. 告诉用户地图上现在能看到什么
3. 如果操作成功，以如下格式给出 2-4 个具体下一步操作建议：

\`\`\`
💡 试试这些操作：
- 对武汉市做5km缓冲区
- 计算武汉市面积
- 武汉市与XX相交分析
\`\`\`

每条建议用一行 \`- 自然语言描述\`，用户可以直接点击发送，所以要用完整的自然语言。
4. 如果操作失败，解释原因并给出替代方案

⚠️ 关键规则：
- 地名必须来自"本次操作结果"或用户原始请求，不要编造！
- "地图上已有图层"是旧的 → 不要把它们说成是你刚加载的！
- 不要生成 [OSM:...]、[ANALYSIS:...] 等操作指令
- 建议必须包含具体地名和操作，如"对武汉市做5km缓冲区"而非"做缓冲区"`;
