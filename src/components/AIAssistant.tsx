import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  Input,
  Button,
  Typography,
  Space,
  Avatar,
  Tag,
  Spin,
  message,
  Empty,
  Tooltip,
  Card,
  Divider,
} from 'antd';
import {
  SendOutlined,
  RobotOutlined,
  ClearOutlined,
  ThunderboltOutlined,
  CopyOutlined,
  EnvironmentOutlined,
  AimOutlined,
  LoadingOutlined,
  PlusSquareOutlined,
  DownloadOutlined,
  DatabaseOutlined,
  GlobalOutlined,
  CameraOutlined,
} from '@ant-design/icons';
import { useGISStore } from '../store/useGISStore';
import { useIsMobile } from '../hooks/useIsMobile';
import { chatWithDeepSeekProxy, chatWithDeepSeekStream } from '../services/deepseek';
import { chatWithAgentStream } from '../services/agentService';
import {
  parseOSMCommands, executeOSMCommand,
  queryFeature, queryBoundary, queryWaterways, queryRoads,
  queryGreenSpace, queryBuildings, queryRailways, queryRailwaysInPlaceName,
  geocodeSearch,
} from '../services/osmService';
import type { OSMCommand, OSMQueryResult } from '../services/osmService';
import { gaodeGeocode } from '../services/gaodeService';
import {
  bufferAnalysis,
  calculateArea,
  calculateCentroid,
  calculateBBox,
  simplifyFeatures,
  convexHullAnalysis,
  intersectAnalysis,
  unionAnalysis,
  differenceAnalysis,
  calculateDistance,
  measureDistance,
  measureArea,
  createGrid,
  pointDensityAnalysis,
  clusterDBSCAN,
  kernelDensityEstimation,
  interpolateIDW,
  zonalStatistics,
} from '../services/spatialAnalysis';
import { applyClassification, COLOR_RAMPS, findNumericFields } from '../services/classification';
import type { ChatMessage } from '../types';
import type { FeatureCollection, Feature, Polygon, MultiPolygon } from 'geojson';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { planRoute, getRouteBounds } from '../services/routingService';
import type { RouteResult, TravelMode } from '../services/routingService';
import { queryEarthquakes, sampleElevationGrid, generateElevationPoints, generateElevationLabels, queryWeather, generateContours } from '../services/hazardService';
import { flattenCoords, getFCBounds } from '../utils/geo';
import { collectToolResults, formatToolResultsForAI, buildFeedbackUserContent, extractSuggestedActions, FEEDBACK_SYSTEM_PROMPT } from '../services/toolFeedback';
import type { ToolResult } from '../services/toolFeedback';
import { captureMapScreenshot, analyzeMapWithVision, buildVisionPrompt } from '../services/visionService';
import { parseNLQuery, executeQuery, getQueryableFields } from '../services/nlQuery';
import {
  detectCommandMode,
  convertSlashToBracket,
  getHelpText,
} from '../services/commandRouter';
import type { CommandMode } from '../services/commandRouter';
import { API_BASE } from '../utils/api';

// ====== 命令引擎（从 AIAssistant 提取的纯逻辑） ======
import {
  SYSTEM_PROMPT,
  GEOJSON_INSTRUCTION,
  QUICK_PROMPTS,
  extractPlaceNameFromInput,
  looksLikeGeoQuery,
  extractGeoJSONBlocks,
  extractMapActions,
  tokenize,
  findLayerByName,
  parseCompoundLayerRef,
  parseAnalysisCommands,
  executeAnalysisCommand,
  parseLocalFileCommands,
  executeLocalFileCommand,
  parseRouteCommands,
  executeRouteCommand,
  parseQueryCommands,
  executeQueryCommand,
  parseHazardCommands,
  executeHazardCommand,
  executeOSMCommandWrapper,
  buildSpatialContext as buildSpatialContextStatic,
} from '../services/commandEngine';
import type { AnalysisCommand, RouteCommand, QueryCommand, HazardCommand } from '../services/commandEngine';
import { runAgenticLoop } from '../services/agentLoop';

const { Text } = Typography;

// ====== 微信环境检测 ======

/** 检测是否在微信内置浏览器（小程序 web-view）中运行 */
function isWeChatWebView(): boolean {
  const ua = navigator.userAgent.toLowerCase();
  // 微信浏览器 UA 包含 MicroMessenger，但小程序 web-view 还包含 miniProgram
  return ua.includes('micromessenger') && ua.includes('miniprogram');
}

// ====== (命令引擎已提取到 src/services/commandEngine.ts) ======

// ====== Component ======

const AIAssistant: React.FC = () => {
  const {
    chatMessages,
    addChatMessage,
    isChatLoading,
    setChatLoading,
    deepseekApiKey,
    authToken,
    user,
    layers,
    mapState,
  } = useGISStore();

  const isMobile = useIsMobile();

  const [inputValue, setInputValue] = useState('');
  const [osmLoading, setOsmLoading] = useState<Record<string, boolean>>({});
  const [osmResults, setOsmResults] = useState<Record<string, OSMQueryResult>>({});
  const [inputCommandMode, setInputCommandMode] = useState<CommandMode>('pass-through');
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages, osmResults, osmLoading]);

  const buildSpatialContext = useCallback((): string => {
    const parts: string[] = [];
    parts.push(`地图中心: [${mapState.center[0].toFixed(6)}, ${mapState.center[1].toFixed(6)}]`);
    parts.push(`缩放级别: ${mapState.zoom.toFixed(1)}`);

    if (mapState.bounds) {
      const [w, s, e, n] = mapState.bounds;
      parts.push(`视野范围(WGS84): [${w.toFixed(6)}, ${s.toFixed(6)}] 到 [${e.toFixed(6)}, ${n.toFixed(6)}]`);
      const latMid = (s + n) / 2;
      const degToKm = 111.32 * Math.cos((latMid * Math.PI) / 180);
      parts.push(`视野约 ${((e - w) * degToKm).toFixed(1)}km × ${((n - s) * 111.32).toFixed(1)}km`);
    }

    const visibleLayers = layers.filter((l) => l.visible && l.data);
    if (visibleLayers.length > 0) {
      parts.push(`可见图层 (共${visibleLayers.length}个):`);
      for (const l of visibleLayers) {
        const geomTypes = new Set(l.data?.features?.map(f => f.geometry?.type) || []);
        const geomStr = [...geomTypes].join(',') || '无';
        const numFields = l.data ? findNumericFields(l.data) : [];
        const hasPoints = geomTypes.has('Point') || geomTypes.has('MultiPoint');
        const hasLines = geomTypes.has('LineString') || geomTypes.has('MultiLineString');
        const hasPolys = geomTypes.has('Polygon') || geomTypes.has('MultiPolygon');
        const fieldInfo = numFields.length > 0
          ? ` | 📐数值字段: ${numFields.join(', ')}`
          : ' | ⚠️无数值字段（不可做zonal/density/idw）';
        const canDo = [];
        if (hasPoints) canDo.push('density/kde/dbscan/idw');
        if (hasPolys) canDo.push('buffer/area/intersect');
        if (hasLines) canDo.push('buffer/simplify');
        const canStr = canDo.length > 0 ? ` | ✅可分析: ${canDo.join(',')}` : '';
        parts.push(`  · "${l.name}" — ${geomStr} (${l.data?.features?.length || 0}个)${fieldInfo}${canStr}`);
      }
    }

    return parts.join('\n');
  }, [mapState, layers]);

  /** 执行单个 OSM 命令，返回 { bbox, osmResult } */
  const runOSMCommand = useCallback(
    async (
      cmd: OSMCommand,
      cmdKey: string,
      overrideBounds?: [number, number, number, number] | null
    ): Promise<{ bbox: [number, number, number, number] | null; osmResult: OSMQueryResult | null }> => {
      setOsmLoading((prev) => ({ ...prev, [cmdKey]: true }));
      try {
        const { result, bbox } = await executeOSMCommand(cmd, mapState.bounds, overrideBounds);
        setOsmResults((prev) => ({ ...prev, [cmdKey]: result }));

        // 自动加载成功的结果到地图
        if (result.geojson && result.geojson.features.length > 0) {
          const { addLayer } = useGISStore.getState();
          const colors = ['#1677ff', '#52c41a', '#fa8c16', '#f5222d', '#722ed1', '#13c2c2'];
          addLayer({
            id: '',
            name: `${result.label}_${new Date().toLocaleTimeString()}`,
            type: 'geojson',
            visible: true,
            color: colors[Math.floor(Math.random() * colors.length)],
            opacity: 0.6,
            data: result.geojson,
            sourceId: '',
            layerId: '',
            createdAt: Date.now(),
          });
          message.success(`✅ ${result.description}`);
        } else {
          message.warning(result.error ? `查询失败: ${result.error}` : result.description);
        }

        // 返回 boundary 命令产出的精确 bbox + OSM 结果
        return { bbox: bbox ?? null, osmResult: result };
      } catch (err) {
        const errResult: OSMQueryResult = {
          type: 'custom',
          label: '错误',
          geojson: null,
          description: '查询异常',
          error: err instanceof Error ? err.message : '未知错误',
        };
        setOsmResults((prev) => ({
          ...prev,
          [cmdKey]: errResult,
        }));
        return { bbox: null, osmResult: errResult };
      } finally {
        setOsmLoading((prev) => ({ ...prev, [cmdKey]: false }));
      }
    },
    [mapState.bounds]
  );

  const executeMapAction = useCallback((action: { action: string; params: string }) => {
    switch (action.action) {
      case 'zoomTo': {
        const [lng, lat, zoom] = action.params.split(',').map(Number);
        if (!isNaN(lng) && !isNaN(lat)) {
          window.dispatchEvent(
            new CustomEvent('fly-to', {
              detail: { center: [lng, lat], zoom: zoom || 14 },
            })
          );
          message.success(`📍 已飞往 [${lng.toFixed(4)}, ${lat.toFixed(4)}]`);
        }
        break;
      }
      case 'addMarker': {
        const parts = action.params.split(',');
        const lng = parseFloat(parts[0]);
        const lat = parseFloat(parts[1]);
        const label = parts.slice(2).join(',') || '标记点';
        if (!isNaN(lng) && !isNaN(lat)) {
          const { addLayer } = useGISStore.getState();
          addLayer({
            id: '',
            name: label,
            type: 'point',
            visible: true,
            color: '#f5222d',
            opacity: 0.9,
            data: {
              type: 'FeatureCollection',
              features: [
                { type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: { name: label } },
              ],
            },
            sourceId: '', layerId: '', createdAt: Date.now(),
          });
          message.success(`📍 已标记: ${label}`);
        }
        break;
      }
      case 'fitBounds': {
        const [w, s, e, n] = action.params.split(',').map(Number);
        if (!isNaN(w) && !isNaN(s) && !isNaN(e) && !isNaN(n)) {
          window.dispatchEvent(
            new CustomEvent('zoom-to-bounds', { detail: [[w, s], [e, n]] })
          );
          message.success('🔍 已缩放到指定范围');
        }
        break;
      }
      case 'clearLayers': {
        const store = useGISStore.getState();
        const count = store.layers.length;
        store.setLayers([]);
        message.success(`🗑️ 已清空 ${count} 个图层`);
        break;
      }
    }
  }, []);

  /** 截图发给 AI 分析 */
  const handleVisionAnalyze = useCallback(async () => {
    if (isChatLoading || !user) return;

    const screenshot = captureMapScreenshot();
    if (!screenshot) {
      message.error('无法截取地图，请确认地图已加载');
      return;
    }

    const prompt = buildVisionPrompt(inputValue.trim() || undefined);
    setInputValue('');
    setChatLoading(true);

    const msgId = `assistant-vision-${Date.now()}`;
    const placeholderMsg: ChatMessage = {
      id: msgId,
      role: 'assistant',
      content: '📸 正在分析地图截图...',
      timestamp: Date.now(),
    };
    addChatMessage(placeholderMsg);

    let fullReply = '';
    await analyzeMapWithVision(
      screenshot,
      prompt,
      { apiKey: deepseekApiKey, authToken },
      (chunk) => {
        fullReply += chunk;
        useGISStore.getState().updateChatMessage(msgId, { content: fullReply });
      },
      () => {
        const finalContent = fullReply || 'AI 未返回视觉分析结果';
        useGISStore.getState().updateChatMessage(msgId, { content: finalContent });
      },
      (err) => {
        useGISStore.getState().updateChatMessage(msgId, { content: `📸 视觉分析失败：${err}` });
      }
    );

    setChatLoading(false);
  }, [isChatLoading, user, inputValue, authToken, addChatMessage, setChatLoading, setInputValue]);

  const handleSend = useCallback(async () => {
    const text = inputValue.trim();
    if (!text || isChatLoading) return;

    if (!user) {
      message.warning('请先登录（右上角登录按钮）');
      return;
    }

    // ============================================
    // ⚡ 直接命令路由器：检测结构化指令，跳过 DeepSeek
    // ============================================
    const detection = detectCommandMode(text);

    // /help → 直接显示帮助
    if (text.startsWith('/help') || text === '/h') {
      addChatMessage({
        id: `user-${Date.now()}`,
        role: 'user',
        content: '/help',
        timestamp: Date.now(),
      });
      addChatMessage({
        id: `assistant-help-${Date.now()}`,
        role: 'assistant',
        content: getHelpText(),
        timestamp: Date.now(),
      });
      setInputValue('');
      return;
    }

    if (detection.mode === 'direct') {
      // ===== 直接执行路径（跳过 DeepSeek） =====
      const commandText = text.startsWith('/')
        ? convertSlashToBracket(text)
        : text;

      const userMsg: ChatMessage = {
        id: `user-${Date.now()}`,
        role: 'user',
        content: text.startsWith('/')
          ? `⚡ ${text}\n\n> *直接命令模式 — 跳过 AI*`
          : `⚡ ${text}\n\n> *结构化指令 — 跳过 AI*`,
        timestamp: Date.now(),
        spatialContext: {
          center: mapState.center,
          zoom: mapState.zoom,
          layers: layers.filter((l) => l.visible).map((l) => l.name),
        },
      };
      addChatMessage(userMsg);
      setInputValue('');
      setChatLoading(true);

      try {
        // 1️⃣ ROUTE 路径规划（最先执行，避免地图跳动干扰）
        const routeCommands = parseRouteCommands(commandText);
        if (routeCommands.length > 0) {
          for (let i = 0; i < routeCommands.length; i++) {
            const rCmd = routeCommands[i];
            const routeResult = await executeRouteCommand(rCmd);
            addChatMessage({
              id: `route-${Date.now()}-${i}`,
              role: 'assistant',
              content: `🧭 **路径规划**: ${routeResult.description}`,
              timestamp: Date.now(),
              routeData: routeResult.routeResult,
            } as ChatMessage);
            if (routeResult.geojson) {
              const fcBbox = getFCBounds(routeResult.geojson);
              if (fcBbox) {
                setTimeout(() => {
                  const routeBounds = getRouteBounds(routeResult.geojson!);
                  if (routeBounds) {
                    window.dispatchEvent(new CustomEvent('zoom-to-bounds', { detail: routeBounds }));
                  }
                }, 400);
              }
            }
          }
        }

        // 提前解析用于流程控制
        const analysisCommands = parseAnalysisCommands(commandText);
        const hasAnalysis = analysisCommands.length > 0;
        const localFiles = parseLocalFileCommands(commandText);

        // 2️⃣ OSM 命令（用户直接输入，无需幻觉过滤）
        let osmCommands: OSMCommand[] = [];
        if (routeCommands.length === 0) {
          osmCommands = parseOSMCommands(commandText);
        }

        // 安全网：分析指令引用了图层但没有对应 OSM → 自动补
        if (hasAnalysis && osmCommands.length === 0) {
          for (const aCmd of analysisCommands) {
            if (aCmd.operation === 'grid') continue;
            const ref = aCmd.layerRef;
            if (!ref) continue;
            const coveredByLocal = localFiles.some(f => {
              const base = f.replace(/\.(geo)?json$/i, '');
              return base === ref || ref.includes(base) || base.includes(ref);
            });
            if (!coveredByLocal) {
              const isAdmin = /[省市区县乡镇村]$/.test(ref);
              osmCommands.push({ action: isAdmin ? 'boundary' : 'feature', params: ref });
            }
          }
        }

        // 执行 OSM 命令
        if (osmCommands.length > 0) {
          let chainedBbox: [number, number, number, number] | null = null;
          for (let i = 0; i < osmCommands.length; i++) {
            const cmd = osmCommands[i];
            const cmdKey = `direct-osm-${Date.now()}-${i}`;
            const { bbox: newBbox } = await runOSMCommand(cmd, cmdKey, chainedBbox);
            if (cmd.action === 'boundary' && newBbox) {
              chainedBbox = newBbox;
            }
            if (!hasAnalysis) {
              const s = useGISStore.getState();
              const lastLayer = s.layers[s.layers.length - 1];
              if (lastLayer?.data) {
                const bbox = getFCBounds(lastLayer.data);
                if (bbox) {
                  setTimeout(() => {
                    window.dispatchEvent(new CustomEvent('zoom-to-bounds', { detail: bbox }));
                  }, 400);
                }
              }
            }
          }
        }

        // 3️⃣ LOCAL 本地文件
        if (localFiles.length > 0) {
          for (let i = 0; i < localFiles.length; i++) {
            const filename = localFiles[i];
            const result = await executeLocalFileCommand(filename);
            addChatMessage({
              id: `local-${Date.now()}-${i}`,
              role: 'assistant',
              content: `📂 **本地文件**: ${result.description}`,
              timestamp: Date.now(),
            });
            if (result.geojson && !hasAnalysis) {
              const fcBbox = getFCBounds(result.geojson);
              if (fcBbox) {
                setTimeout(() => {
                  window.dispatchEvent(new CustomEvent('zoom-to-bounds', { detail: fcBbox }));
                }, 300);
              }
            }
          }
        }

        // 4️⃣ ANALYSIS 空间分析
        if (analysisCommands.length > 0) {
          for (let i = 0; i < analysisCommands.length; i++) {
            const aCmd = analysisCommands[i];
            const result = await executeAnalysisCommand(aCmd);
            addChatMessage({
              id: `analysis-${Date.now()}-${i}`,
              role: 'assistant',
              content: `🔬 **空间分析结果**: ${result.description}`,
              timestamp: Date.now(),
            });
            if (result.geojson) {
              const resultBbox = getFCBounds(result.geojson);
              if (resultBbox) {
                setTimeout(() => {
                  window.dispatchEvent(new CustomEvent('zoom-to-bounds', { detail: resultBbox }));
                }, 500);
              }
            }
          }
        }

        // 5️⃣ QUERY 数据筛选
        const queryCommands = parseQueryCommands(commandText);
        if (queryCommands.length > 0) {
          for (let i = 0; i < queryCommands.length; i++) {
            const qCmd = queryCommands[i];
            const result = await executeQueryCommand(qCmd);
            addChatMessage({
              id: `query-${Date.now()}-${i}`,
              role: 'assistant',
              content: `🔍 **数据筛选**: ${result.description}`,
              timestamp: Date.now(),
            });
          }
        }

        // 6️⃣ HAZARD 灾害数据
        const hazardCommands = parseHazardCommands(commandText);
        if (hazardCommands.length > 0) {
          for (let i = 0; i < hazardCommands.length; i++) {
            const hCmd = hazardCommands[i];
            const result = await executeHazardCommand(hCmd);
            addChatMessage({
              id: `hazard-${Date.now()}-${i}`,
              role: 'assistant',
              content: `🌍 **灾害数据**: ${result.description}`,
              timestamp: Date.now(),
            });
            if (hCmd.type === 'earthquake' && result.geojson) {
              const geo = result.geojson;
              setTimeout(() => {
                const bbox = getFCBounds(geo);
                if (bbox) window.dispatchEvent(new CustomEvent('zoom-to-bounds', { detail: bbox }));
              }, 400);
            }
          }
        }

        // 7️⃣ MAP 地图操作
        const mapActions = extractMapActions(commandText);
        for (const action of mapActions) {
          executeMapAction(action);
        }

      } catch (err) {
        addChatMessage({
          id: `error-${Date.now()}`,
          role: 'assistant',
          content: `❌ **错误**: ${err instanceof Error ? err.message : '直接执行失败'}`,
          timestamp: Date.now(),
        });
      } finally {
        setChatLoading(false);
      }
      return; // ← 不进入 DeepSeek 路径
    }

    // ===== 以下为原有的 DeepSeek 路径（pass-through 或 mixed 模式）=====

    const spatialContext = buildSpatialContext();

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: text,
      timestamp: Date.now(),
      spatialContext: {
        center: mapState.center,
        zoom: mapState.zoom,
        layers: layers.filter((l) => l.visible).map((l) => l.name),
      },
    };
    addChatMessage(userMsg);
    setInputValue('');
    setChatLoading(true);

    try {
      // 对话历史：保留最近 20 条有效消息，过滤掉占位/反馈/系统消息
      const history = chatMessages
        .filter((m) => {
          if (m.id === 'welcome') return false;
          if (m.id.startsWith('assistant-feedback-')) return false; // 反馈轮总结 → 不占上下文
          if (m.content === '⏳ 思考中...' || m.content.startsWith('⏳ 正在分析执行结果')) return false; // 占位消息
          if (m.role === 'system') return false;
          return m.role === 'user' || m.role === 'assistant';
        })
        .slice(-20)
        .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

      // ====== Agent endpoint: Skill + MCP tools ======
      const msgId = `assistant-${Date.now()}`;
      const placeholderMsg: ChatMessage = {
        id: msgId,
        role: 'assistant',
        content: '⏳ thinking...',
        timestamp: Date.now(),
      };
      addChatMessage(placeholderMsg);

      let fullReply = '';

      const agentRequest = {
        message: text,
        map_state: {
          center: mapState.center as [number, number],
          zoom: mapState.zoom,
          bounds: mapState.bounds as [number, number, number, number] | null,
        },
        layers: layers
          .filter((l) => l.visible && l.data)
          .map((l) => ({
            id: l.id,
            name: l.name,
            type: l.type || 'geojson',
            visible: l.visible,
            feature_count: l.data?.features?.length || 0,
          })),
        history,
      };

      if (isWeChatWebView()) {
        try {
          const { chatWithAgent } = await import('../services/agentService');
          fullReply = await chatWithAgent(agentRequest, authToken);
          useGISStore.getState().updateChatMessage(msgId, { content: fullReply || '(no reply)' });
        } catch (err) {
          useGISStore.getState().updateChatMessage(msgId, {
            content: `API error: ${err instanceof Error ? err.message : 'unknown'}`,
          });
        }
      } else {
        await chatWithAgentStream(
          agentRequest,
          authToken,
          (chunk) => {
            fullReply += chunk;
            useGISStore.getState().updateChatMessage(msgId, { content: fullReply });
          },
          () => {
            useGISStore.getState().updateChatMessage(msgId, { content: fullReply || '(no reply)' });
          },
          (err) => {
            useGISStore.getState().updateChatMessage(msgId, { content: `API error: ${err}` });
          }
        );
      }

      if (!fullReply) {
        setChatLoading(false);
        return;
      }

      // 🔍 调试日志：输出 AI 原始回复，方便排查幻觉问题
      console.group('%c🤖 AI 原始回复', 'color: #1677ff; font-weight: bold');
      console.log(fullReply);
      console.groupEnd();

      // ============================================
      // 🔄 执行顺序：ROUTE → LOCAL → OSM → ANALYSIS → MAP
      // ROUTE 最先执行，避免 OSM 边界查询跳动地图干扰路线规划
      // ============================================

      // 📸 快照：记录执行前的消息数，后续收集新增消息作为工具执行结果
      const preExecMsgCount = useGISStore.getState().chatMessages.length;
      // 🗃️ 本地收集器：跟踪本轮 OSM 执行结果（避免 React 状态闭包延迟问题）
      const osmExecutionResults: Array<{ key: string; label?: string; geojson?: FeatureCollection | null; description?: string; error?: string }> = [];

      // 1️⃣ 解析并执行 ROUTE 路径规划指令（最先，不被 OSM 跳图干扰）
      const routeCommands = parseRouteCommands(fullReply);
      if (routeCommands.length > 0) {
        for (let i = 0; i < routeCommands.length; i++) {
          const rCmd = routeCommands[i];
          const routeResult = await executeRouteCommand(rCmd);
          addChatMessage({
            id: `route-${Date.now()}-${i}`,
            role: 'assistant',
            content: `🧭 **路径规划**: ${routeResult.description}`,
            timestamp: Date.now(),
            routeData: routeResult.routeResult,
          } as ChatMessage);
          if (routeResult.geojson) {
            const fcBbox = getFCBounds(routeResult.geojson);
            if (fcBbox) {
              setTimeout(() => {
                const routeBounds = getRouteBounds(routeResult.geojson!);
                if (routeBounds) {
                  window.dispatchEvent(new CustomEvent('zoom-to-bounds', { detail: routeBounds }));
                }
              }, 400);
            }
          }
        }
      }

      // 提前解析，用于流程控制
      const analysisCommands = parseAnalysisCommands(fullReply);
      const hasAnalysis = analysisCommands.length > 0;
      const localFiles = parseLocalFileCommands(fullReply);
      const hasLocalData = localFiles.length > 0;

      // 2️⃣ 顺序执行 OSM 命令
      let osmCommands: OSMCommand[] = [];
      if (routeCommands.length === 0) {
        osmCommands = parseOSMCommands(fullReply);

        // 🛡️ 幻觉过滤：移除与用户输入明显无关的 OSM 命令
        // 防止 AI 在回复中顺嘴提到其他地名时被误解析为指令
        const userTokens = new Set(tokenize(text.toLowerCase(), 2, 4));
        const spatialTokens = new Set(tokenize(
          layers.filter(l => l.visible).map(l => l.name).join(' ').toLowerCase(),
          2, 4
        ));
        const allRelevantTokens = new Set([...userTokens, ...spatialTokens]);
        const filteredOsmCommands: OSMCommand[] = [];
        for (const cmd of osmCommands) {
          const cmdTokens = tokenize(cmd.params.toLowerCase(), 2, 4);
          const hasOverlap = cmdTokens.some(t => allRelevantTokens.has(t));
          if (hasOverlap || cmd.params.length === 0) {
            filteredOsmCommands.push(cmd);
          } else {
            console.warn(`🛡️ 幻觉过滤: 跳过无关指令 [OSM:${cmd.action}:${cmd.params}]（与用户输入和当前图层无关联）`);
          }
        }
        if (filteredOsmCommands.length < osmCommands.length) {
          console.log(`🛡️ 过滤了 ${osmCommands.length - filteredOsmCommands.length} 条可能为幻觉的 OSM 指令`);
          osmCommands = filteredOsmCommands;
        }

        // 🔒 安全网1：AI 忘记生成 OSM 指令时自动补偿
        if (osmCommands.length === 0 && looksLikeGeoQuery(text) && !hasLocalData) {
          const autoPlace = extractPlaceNameFromInput(text);
          if (autoPlace) {
            const wantsOutline = /边界|轮廓|边界线|轮廓线/.test(text);
            const wantsAnalysis = /缓冲|buffer|相交|合并|差集|叠加/.test(text);
            const isAdmin = /[省市区县乡镇村]$/.test(autoPlace);
            const action = wantsOutline ? 'outline'
              : (wantsAnalysis || isAdmin) ? 'boundary'
              : 'feature';
            osmCommands = [{ action: action as 'boundary' | 'outline' | 'feature', params: autoPlace }];
          }
        }
      }

      // 🔒 安全网2：分析指令引用了不存在的图层 → 自动补 OSM 数据源
      // 例：AI 只生成 [ANALYSIS:buffer:上海市:5km] 忘了 [OSM:boundary:上海市]
      if (hasAnalysis) {
        for (const aCmd of analysisCommands) {
          if (aCmd.operation === 'grid') continue; // grid 不需要源图层
          const ref = aCmd.layerRef;
          if (!ref) continue;
          // 检查是否已有 OSM/LOCAL 会提供数据
          const coveredByOSM = osmCommands.some(c => c.params === ref);
          const coveredByLocal = localFiles.some(f => {
            const base = f.replace(/\.(geo)?json$/i, '');
            return base === ref || ref.includes(base) || base.includes(ref);
          });
          if (!coveredByOSM && !coveredByLocal) {
            const isAdmin = /[省市区县乡镇村]$/.test(ref);
            osmCommands.push({ action: isAdmin ? 'boundary' : 'feature', params: ref });
          }
        }
      }

      // 分析模式：过滤掉 poi/buildings/roads 等非面查询
      const isAnalysisRequest = /缓冲|buffer|相交|intersect|合并|union|差集|difference|分析|叠加/.test(text);
      if (isAnalysisRequest && osmCommands.length > 0) {
        const ALLOWED_IN_ANALYSIS = new Set(['boundary', 'outline', 'feature', 'districts']);
        osmCommands = osmCommands.filter(cmd => ALLOWED_IN_ANALYSIS.has(cmd.action));
      }

      // 执行 OSM 命令
      if (osmCommands.length > 0) {
        let chainedBbox: [number, number, number, number] | null = null;
        for (let i = 0; i < osmCommands.length; i++) {
          const cmd = osmCommands[i];
          const cmdKey = `${msgId}-osm-${i}`;
          const { bbox: newBbox, osmResult } = await runOSMCommand(cmd, cmdKey, chainedBbox);
          // 收集 OSM 执行结果到本地收集器
          if (osmResult) {
            osmExecutionResults.push({
              key: cmdKey,
              label: osmResult.label,
              geojson: osmResult.geojson,
              description: osmResult.description,
              error: osmResult.error,
            });
          }
          if (cmd.action === 'boundary' && newBbox) {
            chainedBbox = newBbox;
          }
          // 纯搜索（无分析）：缩放至查询结果
          if (!hasAnalysis) {
            const s = useGISStore.getState();
            const lastLayer = s.layers[s.layers.length - 1];
            if (lastLayer?.data) {
              const bbox = getFCBounds(lastLayer.data);
              if (bbox) {
                setTimeout(() => {
                  window.dispatchEvent(new CustomEvent('zoom-to-bounds', { detail: bbox }));
                }, 400);
              }
            }
          }
        }
      }

      // 3️⃣ 执行 LOCAL 本地文件加载
      if (localFiles.length > 0) {
        for (let i = 0; i < localFiles.length; i++) {
          const filename = localFiles[i];
          const result = await executeLocalFileCommand(filename);
          addChatMessage({
            id: `local-${Date.now()}-${i}`,
            role: 'assistant',
            content: `📂 **本地文件**: ${result.description}`,
            timestamp: Date.now(),
          });
          // 缩放至本地文件（有分析时跳过，分析结果缩放会接管）
          if (result.geojson && !hasAnalysis) {
            const fcBbox = getFCBounds(result.geojson);
            if (fcBbox) {
              setTimeout(() => {
                window.dispatchEvent(new CustomEvent('zoom-to-bounds', { detail: fcBbox }));
              }, 300);
            }
          }
        }
      }

      // 4️⃣ 执行 ANALYSIS 空间分析指令
      if (analysisCommands.length > 0) {
        for (let i = 0; i < analysisCommands.length; i++) {
          const aCmd = analysisCommands[i];
          const result = await executeAnalysisCommand(aCmd);
          addChatMessage({
            id: `analysis-${Date.now()}-${i}`,
            role: 'assistant',
            content: `🔬 **空间分析结果**: ${result.description}`,
            timestamp: Date.now(),
          });
          // 缩放到分析结果
          if (result.geojson) {
            const resultBbox = getFCBounds(result.geojson);
            if (resultBbox) {
              setTimeout(() => {
                window.dispatchEvent(new CustomEvent('zoom-to-bounds', { detail: resultBbox }));
              }, 500);
            }
          }
        }
      }

      // 4️⃣.5 解析并执行 QUERY 自然语言筛选指令
      const queryCommands = parseQueryCommands(fullReply);
      if (queryCommands.length > 0) {
        for (let i = 0; i < queryCommands.length; i++) {
          const qCmd = queryCommands[i];
          const result = await executeQueryCommand(qCmd);
          addChatMessage({
            id: `query-${Date.now()}-${i}`,
            role: 'assistant',
            content: `🔍 **数据筛选**: ${result.description}`,
            timestamp: Date.now(),
          });
        }
      }

      // 5️⃣ 解析并执行 HAZARD 灾害数据指令
      const hazardCommands = parseHazardCommands(fullReply);
      if (hazardCommands.length > 0) {
        for (let i = 0; i < hazardCommands.length; i++) {
          const hCmd = hazardCommands[i];
          const result = await executeHazardCommand(hCmd);
          addChatMessage({
            id: `hazard-${Date.now()}-${i}`,
            role: 'assistant',
            content: `🌍 **灾害数据**: ${result.description}`,
            timestamp: Date.now(),
          });
          // 地震数据自动缩放，等高线不缩放（覆盖当前视野）
          if (hCmd.type === 'earthquake' && result.geojson) {
            const geo = result.geojson;
            setTimeout(() => {
              const bbox = getFCBounds(geo);
              if (bbox) window.dispatchEvent(new CustomEvent('zoom-to-bounds', { detail: bbox }));
            }, 400);
          }
        }
      }

      // 解析并执行地图操作
      const mapActions = extractMapActions(fullReply);
      if (osmCommands.length === 0 && analysisCommands.length === 0 && mapActions.length === 1 && mapActions[0].action === 'zoomTo') {
        setTimeout(() => executeMapAction(mapActions[0]), 500);
      }

      // ============================================
      // 🤖 Agentic GIS — AI 自主多步分析循环
      // AI 规划链路 → 执行 → 看中间结果 → 继续 → 直到完成
      // ============================================
      const hadCommands = osmCommands.length > 0 || analysisCommands.length > 0
        || routeCommands.length > 0 || hazardCommands.length > 0 || localFiles.length > 0
        || queryCommands.length > 0;

      if (hadCommands) {
        const currentMessages = useGISStore.getState().chatMessages;
        const newMessages = currentMessages.slice(preExecMsgCount);
        const osmResultsRecord: Record<string, { label?: string; geojson?: FeatureCollection | null; description?: string; error?: string }> = {};
        for (const r of osmExecutionResults) {
          osmResultsRecord[r.key] = { label: r.label, geojson: r.geojson, description: r.description, error: r.error };
        }
        const initialToolResults = collectToolResults(newMessages, osmResultsRecord);
        const capturedAuthToken = authToken;
        const capturedApiKey = deepseekApiKey;

        // 🔥 Agentic 异步循环，不阻塞主流程
        setTimeout(async () => {
          await runAgenticLoop(
            text, history, initialToolResults, preExecMsgCount,
            capturedApiKey, capturedAuthToken,
            { osmExecutionResults, msgId }
          );
        }, 100);
      }
    } catch (err) {
      addChatMessage({
        id: `error-${Date.now()}`,
        role: 'assistant',
        content: `❌ **错误**: ${err instanceof Error ? err.message : '请求失败'}`,
        timestamp: Date.now(),
      });
    } finally {
      setChatLoading(false);
    }
  }, [
    inputValue, isChatLoading, deepseekApiKey, mapState, layers,
    chatMessages, addChatMessage, setChatLoading, setInputValue,
    buildSpatialContext, runOSMCommand, executeMapAction,
  ]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  const handleQuickPrompt = useCallback((prompt: string) => {
    setInputValue(prompt);
    setTimeout(() => {
      const textarea = document.querySelector('.chat-input-area textarea') as HTMLTextAreaElement;
      if (textarea) textarea.focus();
    }, 100);
  }, []);

  const handleCopy = useCallback((text: string) => {
    navigator.clipboard.writeText(text);
    message.success('已复制');
  }, []);

  const handleClear = useCallback(() => {
    useGISStore.getState().clearChat();
    setOsmResults({});
    setOsmLoading({});
    message.success('对话已清除');
  }, []);

  // ====== Render ======

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ padding: isMobile ? '8px 12px' : '12px 16px', borderBottom: '1px solid #e8e8e8', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Space>
          <Avatar icon={<RobotOutlined />} style={{ background: '#1677ff' }} size={isMobile ? 28 : 'small'} />
          {!isMobile && <Text strong style={{ fontSize: 14 }}>GIS 智能助手</Text>}
          <Tag color="green" style={{ fontSize: 10 }}>DeepSeek</Tag>
        </Space>
        <Button type="text" size={isMobile ? 'middle' : 'small'} icon={<ClearOutlined />} onClick={handleClear} />
      </div>

      {/* Messages */}
      <div style={{ flex: 1, overflow: 'auto', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {chatMessages.map((msg) => {
          const geoJSONBlocks = msg.role === 'assistant' ? extractGeoJSONBlocks(msg.content) : [];
          const mapActions = msg.role === 'assistant' ? extractMapActions(msg.content) : [];
          const osmCommands = msg.role === 'assistant' ? parseOSMCommands(msg.content) : [];

          return (
            <div key={msg.id} className="chat-message-enter" style={{ display: 'flex', flexDirection: 'column', alignItems: msg.role === 'user' ? 'flex-end' : 'flex-start' }}>
              {/* 消息气泡 */}
              <div
                style={{
                  maxWidth: '92%', padding: '10px 14px', borderRadius: 12,
                  background: msg.role === 'user' ? '#1677ff' : msg.content.startsWith('❌') ? '#fff2f0' : '#f5f5f5',
                  color: msg.role === 'user' ? '#fff' : msg.content.startsWith('❌') ? '#cf1322' : '#333',
                  fontSize: isMobile ? 14 : 13, lineHeight: 1.7,
                }}
              >
                {msg.role === 'assistant' ? (
                  <div className="markdown-content">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                  </div>
                ) : (
                  <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{msg.content}</div>
                )}

                {msg.role === 'assistant' && !msg.content.startsWith('❌') && (
                  <div style={{ marginTop: 6, textAlign: 'right' }}>
                    <Button type="text" size="small" icon={<CopyOutlined />} style={{ fontSize: 11, color: '#999' }} onClick={() => handleCopy(msg.content)} />
                  </div>
                )}
              </div>

              {/* OSM 命令执行结果 */}
              {osmCommands.map((cmd, i) => {
                const cmdKey = `${msg.id}-osm-${i}`;
                const loading = osmLoading[cmdKey];
                const result = osmResults[cmdKey];
                const isInFormat = cmd.action.endsWith('-in');

                return (
                  <Card
                    key={cmdKey}
                    size="small"
                    style={{
                      marginTop: 8, maxWidth: '92%',
                      background: loading ? '#fffbe6' : result?.geojson ? '#f6ffed' : '#fff2f0',
                      border: `1px solid ${loading ? '#ffe58f' : result?.geojson ? '#b7eb8f' : '#ffccc7'}`,
                      borderRadius: 8,
                    }}
                    title={
                      <Space size="small">
                        {loading ? <Spin size="small" /> : result?.geojson ? <DatabaseOutlined style={{ color: '#52c41a' }} /> : <GlobalOutlined />}
                        <Text strong style={{ fontSize: 12, color: loading ? '#ad6800' : result?.geojson ? '#52c41a' : '#cf1322' }}>
                          {loading ? `正在从 OpenStreetMap 查询...` : result?.description || 'OSM 查询'}
                        </Text>
                        {isInFormat && <Tag color="green" style={{ fontSize: 9 }}>精准区域</Tag>}
                      </Space>
                    }
                  >
                    {loading ? (
                      <Text type="secondary" style={{ fontSize: 11 }}>
                        🌀 正在查询 {cmd.action === 'boundary' ? `"${cmd.params}"的边界` : `${cmd.action} 数据`}，请稍候...（数据来自 OpenStreetMap）
                      </Text>
                    ) : result?.geojson ? (
                      <div>
                        <Text type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>
                          ✅ {result.geojson.features.length} 个要素已自动加载到地图
                        </Text>
                      </div>
                    ) : (
                      <Text type="secondary" style={{ fontSize: 11, color: '#cf1322' }}>
                        ❌ {result?.error || '查询无结果'}
                      </Text>
                    )}
                  </Card>
                );
              })}

              {/* 地图操作按钮 */}
              {mapActions.length > 0 && (
                <div style={{ marginTop: 8, maxWidth: '92%' }}>
                  {mapActions.map((action, i) => (
                    <Button
                      key={i} size="small" type="primary" ghost
                      icon={action.action === 'zoomTo' ? <AimOutlined /> : action.action === 'addMarker' ? <EnvironmentOutlined /> : <AimOutlined />}
                      onClick={() => executeMapAction(action)}
                      style={{ marginBottom: 4, borderRadius: 16, fontSize: 12 }}
                    >
                      {action.action === 'zoomTo' ? `📌 飞往 ${action.params}` : action.action === 'addMarker' ? `📍 标记点` : `🗺️ ${action.action}`}
                    </Button>
                  ))}
                </div>
              )}

              {/* 路径规划结果卡片 */}
              {msg.routeData && (
                <Card
                  size="small"
                  style={{
                    marginTop: 8, maxWidth: '92%',
                    background: '#f0fdf4', border: '1px solid #86efac',
                    borderRadius: 8,
                  }}
                  title={
                    <Space size="small">
                      <span style={{ fontSize: 16 }}>🧭</span>
                      <Text strong style={{ fontSize: 12, color: '#166534' }}>路径规划</Text>
                    </Space>
                  }
                >
                  <div style={{ fontSize: 12, lineHeight: 1.8 }}>
                    <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
                      <Tag color="green">🟢 {msg.routeData.startName.split(',').slice(0, 2).join(',')}</Tag>
                      <span style={{ color: '#999' }}>→</span>
                      <Tag color="red">🔴 {msg.routeData.endName.split(',').slice(0, 2).join(',')}</Tag>
                    </div>
                    <div style={{ display: 'flex', gap: 16, marginBottom: 4 }}>
                      <Text style={{ fontSize: 13, fontWeight: 600, color: '#1677ff' }}>
                        📏 {msg.routeData.distance < 1000
                          ? `${Math.round(msg.routeData.distance)}m`
                          : `${(msg.routeData.distance / 1000).toFixed(1)}km`}
                      </Text>
                      <Text style={{ fontSize: 13, fontWeight: 600, color: '#52c41a' }}>
                        ⏱ {msg.routeData.duration < 60
                          ? `${Math.round(msg.routeData.duration)}秒`
                          : msg.routeData.duration < 3600
                            ? `${Math.round(msg.routeData.duration / 60)}分钟`
                            : `${Math.floor(msg.routeData.duration / 3600)}h${Math.round((msg.routeData.duration % 3600) / 60)}min`}
                      </Text>
                    </div>
                    {msg.routeData.steps.length > 0 && (
                      <details style={{ marginTop: 4 }}>
                        <summary style={{ cursor: 'pointer', color: '#1677ff', fontSize: 12 }}>
                          📋 导航步骤 ({msg.routeData.steps.length} 个转向)
                        </summary>
                        <div style={{ maxHeight: 180, overflow: 'auto', marginTop: 4, fontSize: 11 }}>
                          {msg.routeData.steps.filter(s => s.instruction).map((step, si) => (
                            <div key={si} style={{
                              padding: '3px 6px', marginBottom: 2,
                              background: si % 2 === 0 ? '#fff' : '#f9fafb',
                              borderRadius: 4,
                            }}>
                              <Text type="secondary">{si + 1}. </Text>
                              {step.instruction}
                              {step.name && <Text type="secondary"> ({step.name})</Text>}
                              <Text type="secondary" style={{ marginLeft: 8 }}>
                                {step.distance < 1000
                                  ? `${Math.round(step.distance)}m`
                                  : `${(step.distance / 1000).toFixed(1)}km`}
                              </Text>
                            </div>
                          ))}
                        </div>
                      </details>
                    )}
                  </div>
                </Card>
              )}

              {/* AI生成的 GeoJSON（仅模拟数据） */}
              {geoJSONBlocks.map((block, i) => (
                <Card
                  key={i} size="small"
                  style={{ marginTop: 8, maxWidth: '92%', background: '#f0f5ff', border: '1px solid #d6e4ff', borderRadius: 8 }}
                  title={<Text strong style={{ fontSize: 12, color: '#1677ff' }}>🤖 AI生成 GeoJSON ({block.geojson.features.length}要素)</Text>}
                  extra={<Button size="small" type="text" icon={<DownloadOutlined />} onClick={() => {
                    const json = JSON.stringify(block.geojson, null, 2);
                    const blob = new Blob([json], { type: 'application/geo+json' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a'); a.href = url; a.download = 'ai-generated.geojson'; a.click();
                    URL.revokeObjectURL(url);
                  }} />}
                >
                  <Text type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 8 }}>
                    ⚠️ 这是AI模拟数据，非真实地理数据。真实数据请用OSM指令查询
                  </Text>
                  <Button
                    type="primary" icon={<PlusSquareOutlined />} size="small" block
                    onClick={() => {
                      const { addLayer } = useGISStore.getState();
                      const colors = ['#1677ff', '#52c41a', '#fa8c16', '#f5222d', '#722ed1'];
                      addLayer({
                        id: '', name: `AI模拟_${new Date().toLocaleTimeString()}`, type: 'geojson', visible: true,
                        color: colors[Math.floor(Math.random() * colors.length)], opacity: 0.7,
                        data: block.geojson, sourceId: '', layerId: '', createdAt: Date.now(),
                      });
                      message.success(`已加载 ${block.geojson.features.length} 个模拟要素`);
                    }}
                  >加载AI数据到地图</Button>
                </Card>
              ))}

              {/* 空间上下文 */}
              {msg.spatialContext && msg.role === 'user' && (
                <Text type="secondary" style={{ fontSize: 10, marginTop: 2 }}>
                  📍 {msg.spatialContext.center[0].toFixed(3)}, {msg.spatialContext.center[1].toFixed(3)} | z{msg.spatialContext.zoom.toFixed(0)}
                  {msg.spatialContext.layers.length > 0 && ` | ${msg.spatialContext.layers.join(', ')}`}
                </Text>
              )}

              <Text type="secondary" style={{ fontSize: 10, marginTop: 2, padding: '0 4px' }}>
                {new Date(msg.timestamp).toLocaleTimeString()}
              </Text>

              {/* 快捷操作芯片 — AI 回复中的建议直接点击 */}
              {msg.role === 'assistant' && !msg.content.startsWith('❌') && !msg.content.startsWith('⏳') && (
                (() => {
                  const actions = extractSuggestedActions(msg.content);
                  if (actions.length === 0) return null;
                  return (
                    <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {actions.map((action, i) => (
                        <Button
                          key={i}
                          size="small"
                          style={{
                            borderRadius: 20, fontSize: 12,
                            background: '#fff', border: '1px solid #d9d9d9',
                            color: '#1677ff', cursor: 'pointer',
                          }}
                          onClick={() => {
                            setInputValue(action);
                            // 不自动发送，让用户确认
                          }}
                          onMouseEnter={(e) => {
                            (e.target as HTMLElement).style.background = '#e6f4ff';
                            (e.target as HTMLElement).style.borderColor = '#1677ff';
                          }}
                          onMouseLeave={(e) => {
                            (e.target as HTMLElement).style.background = '#fff';
                            (e.target as HTMLElement).style.borderColor = '#d9d9d9';
                          }}
                        >
                          {action}
                        </Button>
                      ))}
                    </div>
                  );
                })()
              )}
            </div>
          );
        })}

        {isChatLoading && (
          <div style={{ textAlign: 'center', padding: 12 }}>
            <Space><Spin indicator={<LoadingOutlined style={{ fontSize: 20 }} spin />} /><Text type="secondary" style={{ fontSize: 12 }}>AI 思考中...</Text></Space>
          </div>
        )}

        {chatMessages.length <= 1 && !isChatLoading && (
          <div style={{ marginTop: 8 }}>
            <Text type="secondary" style={{ fontSize: 12, marginBottom: 8, display: 'block' }}>
              💡 试试这些（OSM真实数据）：
            </Text>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {QUICK_PROMPTS.map((qp) => (
                <Tag
                  key={qp.label}
                  style={{ cursor: 'pointer', padding: isMobile ? '8px 14px' : '4px 10px', borderRadius: 16, fontSize: isMobile ? 13 : 12, border: '1px dashed #d9d9d9', background: '#fafafa' }}
                  onClick={() => handleQuickPrompt(qp.prompt)}
                >
                  {qp.icon} {qp.label}
                </Tag>
              ))}
            </div>
            <Divider style={{ margin: '12px 0' }} />
            {/* ⚡ 直接命令功能介绍 */}
            <div style={{
              padding: '10px 14px',
              background: 'linear-gradient(135deg, #f6ffed 0%, #e6f7ff 100%)',
              borderRadius: 8,
              border: '1px solid #b7eb8f',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                <Text strong style={{ fontSize: 12, color: '#389e0d' }}>
                  <ThunderboltOutlined style={{ marginRight: 4 }} />直接命令模式 — 跳过 AI，秒级响应
                </Text>
                <Tag color="green" style={{ fontSize: 10, margin: 0, lineHeight: '16px' }}>零 Token 消耗</Tag>
              </div>
              <Text style={{ fontSize: 11, color: '#595959', lineHeight: '18px' }}>
                输入 <Text code style={{ fontSize: 10, background: '#fff', color: '#52c41a' }}>/</Text> 开头即可使用快捷命令，无需等待 AI。试试：
              </Text>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
                {[
                  { cmd: '/osm boundary 武汉', desc: '查行政区' },
                  { cmd: '/buffer 武汉 5km', desc: '缓冲区' },
                  { cmd: '/route 北京 上海', desc: '路径规划' },
                  { cmd: '/weather', desc: '天气' },
                  { cmd: '/help', desc: '全部命令' },
                ].map(({ cmd, desc }) => (
                  <Tag
                    key={cmd}
                    style={{
                      cursor: 'pointer', fontSize: 11, margin: 0,
                      background: '#fff', border: '1px solid #d9f7be',
                      color: '#389e0d', fontFamily: 'monospace',
                    }}
                    onClick={() => {
                      setInputValue(cmd.startsWith('/') ? cmd : `/${cmd}`);
                      setInputCommandMode('direct');
                    }}
                    onMouseEnter={(e) => {
                      (e.target as HTMLElement).style.background = '#52c41a';
                      (e.target as HTMLElement).style.color = '#fff';
                    }}
                    onMouseLeave={(e) => {
                      (e.target as HTMLElement).style.background = '#fff';
                      (e.target as HTMLElement).style.color = '#389e0d';
                    }}
                  >
                    <code style={{ fontSize: 10, background: 'transparent' }}>{cmd}</code>
                    <span style={{ fontSize: 10, marginLeft: 4, opacity: 0.7 }}>{desc}</span>
                  </Tag>
                ))}
              </div>
            </div>
          </div>
        )}

        <div ref={chatEndRef} />
      </div>

      {/* Input */}
      <div style={{ padding: '12px 16px', borderTop: '1px solid #e8e8e8', background: '#fafafa' }}>
        {!user && (
          <div style={{ padding: '6px 12px', marginBottom: 8, background: '#fffbe6', border: '1px solid #ffe58f', borderRadius: 6, fontSize: 12, color: '#ad6800' }}>
            ⚠️ 请先登录后使用 AI 助手（右上角登录按钮）
          </div>
        )}
        <div className="chat-input-area" style={{ display: 'flex', gap: 8 }}>
          <Input.TextArea
            value={inputValue}
            onChange={(e) => {
              const val = e.target.value;
              setInputValue(val);
              // 实时命令检测，提供视觉反馈
              setInputCommandMode(detectCommandMode(val).mode);
            }}
            onKeyDown={handleKeyDown}
            placeholder={
              user
                ? inputCommandMode === 'direct'
                  ? '⚡ 直接命令模式，按 Enter 立即执行...'
                  : '输入GIS问题，如"查找武汉市的大学"... 或 / 使用命令'
                : '请先登录后使用 AI 助手'
            }
            autoSize={{ minRows: 1, maxRows: 4 }}
            disabled={!user}
            style={{
              flex: 1,
              borderRadius: 8,
              ...(inputCommandMode === 'direct' && inputValue.trim()
                ? { borderColor: '#52c41a', boxShadow: '0 0 0 2px rgba(82,196,26,0.1)' }
                : {}),
            }}
          />
          <Tooltip title="📸 截图分析 — 截取当前地图发给 AI 做视觉分析">
            <Button
              icon={<CameraOutlined />}
              onClick={handleVisionAnalyze}
              loading={isChatLoading}
              disabled={!user}
              size={isMobile ? 'middle' : undefined}
              style={{ borderRadius: 8, minWidth: isMobile ? 48 : undefined, color: '#722ed1', borderColor: '#d3adf7' }}
            />
          </Tooltip>
          <Button type="primary" icon={<SendOutlined />} onClick={handleSend} loading={isChatLoading} disabled={!inputValue.trim() || !user} size={isMobile ? 'middle' : undefined} style={{ borderRadius: 8, minWidth: isMobile ? 48 : undefined }}>
            {isMobile ? '' : '发送'}
          </Button>
        </div>

        {/* ⚡ 直接命令模式指示器 */}
        {inputCommandMode === 'direct' && inputValue.trim() && (
          <div style={{
            marginTop: 6,
            fontSize: 11,
            color: '#52c41a',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}>
            <ThunderboltOutlined />
            <span>直接执行（跳过 AI，零延迟零 Token）</span>
            {inputValue.trim().startsWith('/') && (
              <Tag color="green" style={{ fontSize: 10, margin: 0, lineHeight: '16px' }}>斜杠命令</Tag>
            )}
            {inputValue.trim().startsWith('[') && (
              <Tag color="blue" style={{ fontSize: 10, margin: 0, lineHeight: '16px' }}>结构化指令</Tag>
            )}
          </div>
        )}

        {/* 快捷命令标签 */}
        {user && (
          <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            <Text type="secondary" style={{ fontSize: 10, lineHeight: '20px', marginRight: 2 }}>
              快捷命令：
            </Text>
            {([
              { label: '/osm', fill: '/osm boundary ' },
              { label: '/buffer', fill: '/buffer ' },
              { label: '/route', fill: '/route ' },
              { label: '/zoom', fill: '/zoom ' },
              { label: '/local', fill: '/local ' },
              { label: '/earthquake', fill: '/earthquake ' },
              { label: '/weather', fill: '/weather' },
              { label: '/clear', fill: '/clear' },
              { label: '/help', fill: '/help' },
            ]).map(({ label, fill }) => (
              <Tag
                key={label}
                style={{
                  cursor: 'pointer',
                  fontSize: 10,
                  lineHeight: '16px',
                  padding: '0 6px',
                  margin: 0,
                  borderRadius: 4,
                  border: '1px dashed #d9d9d9',
                  background: '#fafafa',
                }}
                onClick={() => {
                  setInputValue(fill);
                  setInputCommandMode('direct');
                }}
                onMouseEnter={(e) => {
                  (e.target as HTMLElement).style.background = '#f6ffed';
                  (e.target as HTMLElement).style.borderColor = '#52c41a';
                }}
                onMouseLeave={(e) => {
                  (e.target as HTMLElement).style.background = '#fafafa';
                  (e.target as HTMLElement).style.borderColor = '#d9d9d9';
                }}
              >
                {label}
              </Tag>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default AIAssistant;
