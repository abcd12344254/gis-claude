/**
 * ====== Agentic 自主多步分析循环 ======
 *
 * 从 AIAssistant.tsx 提取的 Agentic 循环逻辑。
 * AI 看到工具执行结果后，自主决定是否继续分析（最多 4 轮）。
 */
import { useGISStore } from '../store/useGISStore';
import { chatWithDeepSeekProxy, chatWithDeepSeekStream } from './deepseek';
import { formatToolResultsForAI, buildFeedbackUserContent, FEEDBACK_SYSTEM_PROMPT, collectToolResults } from './toolFeedback';
import type { ToolResult } from './toolFeedback';
import type { ChatMessage } from '../types';
import type { FeatureCollection } from 'geojson';
import {
  parseAnalysisCommands,
  parseQueryCommands,
  parseRouteCommands,
  executeAnalysisCommand,
  executeQueryCommand,
  executeOSMCommandWrapper,
  buildSpatialContext as buildSpatialContextStatic,
} from './commandEngine';
import { parseOSMCommands } from './osmService';

/** 检测是否在微信内置浏览器中运行 */
function isWeChatWebView(): boolean {
  const ua = navigator.userAgent.toLowerCase();
  return ua.includes('micromessenger') && ua.includes('miniprogram');
}

const AGENTIC_ROUND_LIMIT = 4;

interface AgenticLoopContext {
  osmExecutionResults: Array<{ key: string; label?: string; geojson?: FeatureCollection | null; description?: string; error?: string }>;
  msgId: string;
}

/** Agentic 多轮分析主循环 — AI 看到结果后自主决定是否继续分析 */
async function runAgenticLoop(
  userRequest: string,
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>,
  previousToolResults: ToolResult[],
  preExecMsgCount: number,
  apiKey: string,
  authToken: string,
  loopCtx: AgenticLoopContext,
  round: number = 1
): Promise<void> {
  if (round > AGENTIC_ROUND_LIMIT) return;
  if (previousToolResults.length === 0 && round > 1) return;

  const feedbackText = formatToolResultsForAI(previousToolResults);
  const store = useGISStore.getState();
  const spatialContext = buildSpatialContextStatic(store.mapState, store.layers);
  const feedbackUserContent = buildFeedbackUserContent(userRequest, feedbackText, spatialContext);

  const systemPrompt = round === 1
    ? FEEDBACK_SYSTEM_PROMPT
    : `你是 GIS Claude 的自主分析引擎。你正在进行多步地理空间分析。

你已经执行了前 ${round} 步分析操作。现在你收到了最新的工具执行结果。

⚠️ 关键判断：
- 如果分析已经完整（数据齐全、结论清晰）→ 用自然语言做最终总结，不要再生成指令
- 如果还需要补充数据或进一步分析 → 继续生成 [OSM:...] 或 [ANALYSIS:...] 指令
- 最多再执行 1-2 步，不要无限循环

请在回复末尾明确标注 [DONE] 如果你认为分析已经完成。`;

  const feedbackMessages = [
    { role: 'system' as const, content: systemPrompt },
    ...conversationHistory,
    { role: 'user' as const, content: feedbackUserContent },
  ];

  const feedbackId = `agentic-r${round}-${Date.now()}`;
  const placeholderMsg: ChatMessage = {
    id: feedbackId,
    role: 'assistant',
    content: round === 1 ? '⏳ 正在分析结果...' : `⏳ 第 ${round} 轮分析中...`,
    timestamp: Date.now(),
  };
  store.addChatMessage(placeholderMsg);

  let reply = '';
  try {
    if (isWeChatWebView()) {
      reply = await chatWithDeepSeekProxy(feedbackMessages, { apiKey, authToken });
      const finalReply = reply || '(无回复)';
      store.updateChatMessage(feedbackId, { content: finalReply });
      continueAgenticLoop(userRequest, conversationHistory, reply, preExecMsgCount, apiKey, authToken, loopCtx, round);
    } else {
      await chatWithDeepSeekStream(
        feedbackMessages,
        { apiKey, authToken },
        (chunk) => { reply += chunk; store.updateChatMessage(feedbackId, { content: reply }); },
        () => {
          const finalReply = reply || '(无回复)';
          store.updateChatMessage(feedbackId, { content: finalReply });
          continueAgenticLoop(userRequest, conversationHistory, reply, preExecMsgCount, apiKey, authToken, loopCtx, round);
        },
        (err) => { store.updateChatMessage(feedbackId, { content: `⚠️ 分析失败：${err}` }); }
      );
    }
  } catch {
    store.updateChatMessage(feedbackId, { content: '' });
  }
}

/** 解析本轮 AI 回复中的新指令，执行它们，然后递归调用 runAgenticLoop */
async function continueAgenticLoop(
  userRequest: string,
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>,
  reply: string,
  preExecMsgCount: number,
  apiKey: string,
  authToken: string,
  loopCtx: AgenticLoopContext,
  previousRound: number
): Promise<void> {
  if (reply.includes('[DONE]')) return;

  const newOsmCommands = parseOSMCommands(reply);
  const newAnalysisCommands = parseAnalysisCommands(reply);
  const newQueryCommands = parseQueryCommands(reply);
  const newRouteCommands = parseRouteCommands(reply);

  const hasNewCommands = newOsmCommands.length > 0 || newAnalysisCommands.length > 0
    || newQueryCommands.length > 0 || newRouteCommands.length > 0;

  if (!hasNewCommands) return;

  const preCount = useGISStore.getState().chatMessages.length;
  const osmExecResults: Array<{ key: string; label?: string; geojson?: FeatureCollection | null; description?: string; error?: string }> = [];

  for (let i = 0; i < newOsmCommands.length; i++) {
    const cmd = newOsmCommands[i];
    const cmdKey = `agentic-osm-${Date.now()}-${i}`;
    try {
      const { osmResult } = await executeOSMCommandWrapper(cmd, cmdKey);
      if (osmResult) {
        osmExecResults.push({ key: cmdKey, label: osmResult.label, geojson: osmResult.geojson, description: osmResult.description, error: osmResult.error });
      }
    } catch { /* single command failure shouldn't stop the loop */ }
  }

  for (let i = 0; i < newAnalysisCommands.length; i++) {
    const aCmd = newAnalysisCommands[i];
    try {
      const result = await executeAnalysisCommand(aCmd);
      useGISStore.getState().addChatMessage({
        id: `agentic-analysis-${Date.now()}-${i}`,
        role: 'assistant',
        content: `🔬 **空间分析**: ${result.description}`,
        timestamp: Date.now(),
      });
    } catch { /* continue */ }
  }

  for (let i = 0; i < newQueryCommands.length; i++) {
    const qCmd = newQueryCommands[i];
    try {
      const result = await executeQueryCommand(qCmd);
      useGISStore.getState().addChatMessage({
        id: `agentic-query-${Date.now()}-${i}`,
        role: 'assistant',
        content: `🔍 **数据筛选**: ${result.description}`,
        timestamp: Date.now(),
      });
    } catch { /* continue */ }
  }

  const newMessages = useGISStore.getState().chatMessages.slice(preCount);
  const osmResultsRecord: Record<string, { label?: string; geojson?: FeatureCollection | null; description?: string; error?: string }> = {};
  for (const r of osmExecResults) {
    osmResultsRecord[r.key] = { label: r.label, geojson: r.geojson, description: r.description, error: r.error };
  }
  const newToolResults = collectToolResults(newMessages, osmResultsRecord);

  const updatedHistory = [
    ...conversationHistory,
    { role: 'assistant' as const, content: reply },
  ];

  if (newToolResults.length > 0) {
    await runAgenticLoop(userRequest, updatedHistory, newToolResults, preCount, apiKey, authToken, loopCtx, previousRound + 1);
  }
}

export { runAgenticLoop, AGENTIC_ROUND_LIMIT };
export type { AgenticLoopContext };
