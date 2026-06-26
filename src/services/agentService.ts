/**
 * ====== Agent API 调用客户端 ======
 *
 * 调用后端 /api/agent/chat（Skill 增强的 System Prompt）
 * 替代直接调用 deepseek.ts 的方式，获取 Skill 增强的回复。
 *
 * 同时也支持 CRS 检查 /api/crs/check 和 Skill 列表 /api/skills。
 */

import { API_BASE } from '../utils/api';

// ====== Agent 对话 ======

export interface AgentChatRequest {
  message: string;
  map_state: {
    center: [number, number];
    zoom: number;
    bounds: [number, number, number, number] | null;
  };
  layers: Array<{
    id: string;
    name: string;
    type: string;
    visible: boolean;
    feature_count: number;
  }>;
  history: Array<{ role: string; content: string }>;
}

export async function chatWithAgent(
  request: AgentChatRequest,
  authToken: string
): Promise<string> {
  const resp = await fetch(`${API_BASE}/api/agent/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${authToken}`,
    },
    body: JSON.stringify(request),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ detail: resp.statusText }));
    throw new Error(`Agent API 错误 (${resp.status}): ${err.detail}`);
  }

  const data = await resp.json();
  const messages = data.messages || [];
  return messages.map((m: any) => m.content).join('\n');
}

/**
 * Agent SSE 流式对话。
 * 调用 /api/agent/chat/stream，解析 DeepSeek 标准 SSE 格式。
 * 格式：data: {"choices":[{"delta":{"content":"..."}}]}\n\n
 */
export async function chatWithAgentStream(
  request: AgentChatRequest,
  authToken: string,
  onChunk: (text: string) => void,
  onDone: () => void,
  onError: (msg: string) => void,
): Promise<void> {
  try {
    const resp = await fetch(`${API_BASE}/api/agent/chat/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`,
      },
      body: JSON.stringify(request),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ detail: resp.statusText }));
      onError(`Agent API 错误 (${resp.status}): ${err.detail}`);
      return;
    }

    const reader = resp.body?.getReader();
    if (!reader) {
      onError('浏览器不支持 ReadableStream');
      return;
    }

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const jsonStr = trimmed.slice(6);
        if (jsonStr === '[DONE]') continue;

        try {
          const data = JSON.parse(jsonStr);
          // 处理元数据（matched_skills）
          if (data.matched_skills) continue;
          // 处理错误
          if (data.error) {
            onError(data.error);
            return;
          }
          // 标准 DeepSeek SSE 格式
          const content = data.choices?.[0]?.delta?.content;
          if (content) onChunk(content);
        } catch {
          // 跳过非 JSON 行
        }
      }
    }

    onDone();
  } catch (err) {
    onError(err instanceof Error ? err.message : '流式请求失败');
  }
}

// ====== CRS 检查 ======

export interface CRSCheckLayer {
  name: string;
  crs?: string | null;
  feature_count?: number;
  geometry_type?: string;
}

export async function checkCRS(
  analysisType: string,
  layers: CRSCheckLayer[],
  lngRange?: [number, number]
): Promise<{
  passed: boolean;
  warnings: Array<{ level: string; message: string; detail: string; fix_action: string }>;
  suggested_crs: string | null;
  report: string;
}> {
  const body: any = { analysis_type: analysisType, layers };
  if (lngRange) {
    body.lng_min = lngRange[0];
    body.lng_max = lngRange[1];
  }

  const resp = await fetch(`${API_BASE}/api/crs/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    throw new Error(`CRS 检查失败: ${resp.status}`);
  }

  return resp.json();
}

// ====== Skill 列表 ======

export async function listSkills(): Promise<
  Array<{ name: string; version: string; description: string; triggers: string[] }>
> {
  const resp = await fetch(`${API_BASE}/api/skills`);
  if (!resp.ok) throw new Error(`获取 Skill 列表失败: ${resp.status}`);
  return resp.json();
}

export async function matchSkills(query: string): Promise<
  Array<{ name: string; description: string }>
> {
  const resp = await fetch(`${API_BASE}/api/skills/match?q=${encodeURIComponent(query)}`);
  if (!resp.ok) throw new Error(`Skill 匹配失败: ${resp.status}`);
  return resp.json();
}

// ====== 资源目录 ======

export async function listResources(keywords?: string, category?: string): Promise<any> {
  const params = new URLSearchParams();
  if (keywords) params.set('keywords', keywords);
  if (category) params.set('category', category);
  const resp = await fetch(`${API_BASE}/api/resources?${params}`);
  if (!resp.ok) throw new Error(`获取资源列表失败: ${resp.status}`);
  return resp.json();
}
