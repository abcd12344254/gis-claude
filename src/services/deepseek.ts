import axios from 'axios';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '';

const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';

const SYSTEM_PROMPT = `你是 GIS Claude，一个专业的地理信息系统（GIS）智能助手。你具备以下能力：

1. **空间分析专家**：你能帮助用户理解和执行各种空间分析操作，包括：
   - 缓冲区分析（Buffer）
   - 叠加分析（Intersect、Union、Difference）
   - 距离和面积计算
   - 中心点、边界框计算
   - 简化（Simplify）、凸包（Convex Hull）
   - 空间查询和邻近分析

2. **GIS 知识库**：你精通：
   - 坐标系和投影（WGS84、Web Mercator、UTM、CGCS2000等）
   - 空间数据格式（GeoJSON、Shapefile、KML、WKT等）
   - 地图渲染和可视化最佳实践
   - 空间数据库（PostGIS、SpatiaLite）
   - OGC标准（WMS、WFS、WCS）

3. **编程辅助**：你可以帮助编写：
   - Turf.js 空间分析代码
   - MapLibre GL JS 地图操作代码
   - GeoPandas/Python 空间数据处理脚本
   - SQL 空间查询语句

4. **数据建议**：根据不同分析需求，推荐合适的配色方案、分类方法、符号化方案。

请用中文回答，保持专业、简洁、实用。当用户提出空间分析需求时，主动提供具体的操作步骤或代码示例。`;

interface ChatCompletionMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export async function chatWithDeepSeek(
  messages: { role: string; content: string }[],
  apiKey: string
): Promise<string> {
  if (!apiKey) {
    throw new Error('请先在设置中配置 DeepSeek API Key');
  }

  // If first message is already system, don't prepend default system prompt
  const hasSystemMessage = messages.length > 0 && messages[0].role === 'system';

  const chatMessages: ChatCompletionMessage[] = hasSystemMessage
    ? messages.map((m) => ({
        role: m.role as 'system' | 'user' | 'assistant',
        content: m.content,
      }))
    : [
        { role: 'system', content: SYSTEM_PROMPT },
        ...messages.map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        })),
      ];

  try {
    const response = await axios.post(
      DEEPSEEK_API_URL,
      {
        model: 'deepseek-chat',
        messages: chatMessages,
        temperature: 0.7,
        max_tokens: 4096,
        stream: false,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        timeout: 60000,
      }
    );

    return response.data.choices[0].message.content;
  } catch (error: unknown) {
    if (error && typeof error === 'object' && 'response' in error) {
      const axiosError = error as { response?: { status?: number; data?: { error?: { message?: string } } } };
      if (axiosError.response?.status === 401) {
        throw new Error('API Key 无效，请检查设置');
      }
      if (axiosError.response?.status === 429) {
        throw new Error('API 请求频率超限，请稍后再试');
      }
      if (axiosError.response?.data?.error?.message) {
        throw new Error(`API 错误: ${axiosError.response.data.error.message}`);
      }
    }
    if (error instanceof Error) {
      throw new Error(`请求失败: ${error.message}`);
    }
    throw new Error('连接 DeepSeek API 失败，请检查网络');
  }
}

// Server-side proxy version (recommended for production)
// API Key 优先级: server/.env DEEPSEEK_API_KEY > 前端传入的 apiKey
export async function chatWithDeepSeekProxy(
  messages: { role: string; content: string }[],
  options?: { apiKey?: string; authToken?: string }
): Promise<string> {
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    // JWT token（用于认证和配额）优先于 API Key
    if (options?.authToken) {
      headers['Authorization'] = `Bearer ${options.authToken}`;
    } else if (options?.apiKey) {
      headers['Authorization'] = `Bearer ${options.apiKey}`;
    }
    const response = await axios.post(
      `${API_BASE}/api/chat`,
      { messages },
      { timeout: 120000, headers }
    );
    return response.data.content;
  } catch (error: unknown) {
    if (error && typeof error === 'object' && 'response' in error) {
      const axiosError = error as { response?: { data?: { detail?: string }; status?: number } };
      if (axiosError.response?.data?.detail) {
        throw new Error(axiosError.response.data.detail);
      }
      if (axiosError.response?.status === 401) {
        throw new Error('API Key 无效或登录已过期，请检查设置');
      }
      if (axiosError.response?.status === 429) {
        throw new Error('请求过于频繁或配额已用完，请稍后再试');
      }
    }
    if (error instanceof Error) {
      throw new Error(`请求失败: ${error.message}`);
    }
    throw new Error('连接服务器失败');
  }
}

// SSE 流式版本 — 实时逐字返回
export async function chatWithDeepSeekStream(
  messages: { role: string; content: string }[],
  options?: { apiKey?: string; authToken?: string },
  onChunk?: (text: string) => void,
  onDone?: () => void,
  onError?: (err: string) => void
): Promise<void> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options?.authToken) {
    headers['Authorization'] = `Bearer ${options.authToken}`;
  } else if (options?.apiKey) {
    headers['Authorization'] = `Bearer ${options.apiKey}`;
  }

  try {
    const response = await fetch(`${API_BASE}/api/chat/stream`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ messages }),
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({ detail: `HTTP ${response.status}` }));
      throw new Error(errData.detail || '请求失败');
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('浏览器不支持流式读取');

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          try {
            const parsed = JSON.parse(data);
            if (parsed.content && onChunk) {
              onChunk(parsed.content);
            }
          } catch {}
        } else if (line.startsWith('event: done')) {
          onDone?.();
          return;
        } else if (line.startsWith('event: error')) {
          // Try to extract error from next data line
          continue;
        }
      }
    }
    onDone?.();
  } catch (err) {
    onError?.(err instanceof Error ? err.message : '连接失败');
  }
}
