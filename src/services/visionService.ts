/**
 * 地图"视觉"分析服务 — 通过超详细的文字描述让 AI "看到"地图全貌。
 * 不依赖 Vision API，兼容所有文本模型，比图片分析更精准。
 */

import { chatWithDeepSeekStream } from './deepseek';

// ====== 地图截图（保留以备将来 Vision 模型使用） ======

function getMapCanvas(): HTMLCanvasElement | null {
  const canvas = document.querySelector('.maplibregl-canvas') as HTMLCanvasElement | null;
  return canvas;
}

export function captureMapScreenshot(): string | null {
  const canvas = getMapCanvas();
  if (!canvas) return null;
  const MAX_W = 800;
  const scale = Math.min(1, MAX_W / canvas.width);
  const offscreen = document.createElement('canvas');
  offscreen.width = Math.round(canvas.width * scale);
  offscreen.height = Math.round(canvas.height * scale);
  const ctx = offscreen.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, offscreen.width, offscreen.height);
  ctx.drawImage(canvas, 0, 0, offscreen.width, offscreen.height);
  return offscreen.toDataURL('image/jpeg', 0.75);
}

// ====== 文字版"视觉"分析（主力方案） ======

export interface MapSnapshot {
  center: [number, number];
  zoom: number;
  bearing: number;
  pitch: number;
  bounds: [number, number, number, number] | null;
  layers: Array<{
    name: string;
    type: string;
    color: string;
    opacity: number;
    featureCount: number;
    geomTypes: string[];
    numericFields: string[];
  }>;
  terrain3d: boolean;
}

/** 构建超详细的地图文字描述，替代视觉模型 */
export function buildDetailedMapDescription(snapshot: MapSnapshot): string {
  const parts: string[] = [];

  parts.push('## 🗺️ 当前地图全貌');
  parts.push(`- 中心: [${snapshot.center[0].toFixed(5)}, ${snapshot.center[1].toFixed(5)}]`);
  parts.push(`- 缩放: ${snapshot.zoom.toFixed(1)} | 旋转: ${snapshot.bearing}° | 俯仰: ${snapshot.pitch}°`);

  if (snapshot.bounds) {
    const [w, s, e, n] = snapshot.bounds;
    const latMid = (s + n) / 2;
    const degToKm = 111.32 * Math.cos((latMid * Math.PI) / 180);
    parts.push(`- 视野: [${w.toFixed(4)}, ${s.toFixed(4)}] ~ [${e.toFixed(4)}, ${n.toFixed(4)}]`);
    parts.push(`- 范围: ≈ ${((e - w) * degToKm).toFixed(1)}km × ${((n - s) * 111.32).toFixed(1)}km`);
  }

  parts.push(`- 底图: ${snapshot.terrain3d ? '卫星图+3D地形' : 'OSM标准地图'}`);

  parts.push(`\n## 📊 可见图层 (${snapshot.layers.length}个)`);
  if (snapshot.layers.length === 0) {
    parts.push('(当前无数据图层，仅显示底图)');
  } else {
    for (const l of snapshot.layers) {
      const geomStr = l.geomTypes.join('/');
      parts.push(`- **${l.name}**: ${geomStr}, ${l.featureCount}个要素, ${l.color}, 透明度${Math.round(l.opacity * 100)}%`);
      if (l.numericFields.length > 0 && l.numericFields.length <= 8) {
        parts.push(`  📐 数值字段: ${l.numericFields.join(', ')}`);
      }
    }
  }

  return parts.join('\n');
}

/** 分析地图：通过文字描述 + AI 实现"看图"效果 */
export async function analyzeMapWithVision(
  _imageBase64: string,  // 保留兼容性，实际不使用
  prompt: string,
  options: { apiKey?: string; authToken?: string } = {},
  onChunk?: (text: string) => void,
  onDone?: () => void,
  onError?: (err: string) => void
): Promise<void> {
  // 从 store 获取地图快照
  const storeModule = await import('../store/useGISStore');
  const state = storeModule.useGISStore.getState();
  const snapshot: MapSnapshot = {
    center: state.mapState.center,
    zoom: state.mapState.zoom,
    bearing: state.mapState.bearing,
    pitch: state.mapState.pitch,
    bounds: state.mapState.bounds,
    terrain3d: state.terrain3dEnabled,
    layers: state.layers
      .filter(l => l.visible && l.data)
      .map(l => {
        const geomTypes = [...new Set(l.data?.features?.map(f => f.geometry?.type) || [])];
        const firstProps = l.data?.features?.[0]?.properties || {};
        const numericFields = Object.entries(firstProps)
          .filter(([, v]) => typeof v === 'number')
          .map(([k]) => k)
          .slice(0, 8);
        return {
          name: l.name,
          type: l.type,
          color: l.color,
          opacity: l.opacity,
          featureCount: l.data?.features?.length || 0,
          geomTypes,
          numericFields,
        };
      }),
  };

  const mapDescription = buildDetailedMapDescription(snapshot);

  const messages = [
    { role: 'system' as const, content: '你是地图分析专家。用户给你一份地图的详细文字描述（相当于"用文字看地图"），请据此分析地图上有什么、数据特征、空间分布等。用中文回答，简洁专业。' },
    { role: 'user' as const, content: `${mapDescription}\n\n---\n\n${prompt || '请全面分析当前地图：上面有什么图层？数据分布有什么特征？有什么值得注意的？'}` },
  ];

  await chatWithDeepSeekStream(
    messages,
    options,
    onChunk,
    onDone,
    onError
  );
}

/** 构建地图视觉提示词 */
export function buildVisionPrompt(userContext?: string): string {
  const base = '请全面分析当前地图：上面有什么图层？它们的空间分布有什么特征（聚集/分散/沿道路）？有什么值得注意的异常或亮点？';
  return userContext ? `${base}\n\n用户补充：${userContext}` : base;
}
