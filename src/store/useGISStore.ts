import { create } from 'zustand';
import type { GISLayer, DrawingState, ChatMessage, MapState, AnalysisTask } from '../types';
import { isGCJ02Basemap, wgs84ToGcj02, transformGeoJSONCoords } from '../utils/coordTransform';

export interface UserInfo {
  id: number;
  email: string;
  plan: string;
  quota_remaining?: number;
  quota_daily?: number;
  quota_used_today?: number;
  is_admin?: boolean;
}

interface GISStore {
  // Map state
  mapState: MapState;
  setMapState: (state: Partial<MapState>) => void;

  // Layers
  layers: GISLayer[];
  addLayer: (layer: GISLayer) => void;
  removeLayer: (id: string) => void;
  updateLayer: (id: string, updates: Partial<GISLayer>) => void;
  toggleLayerVisibility: (id: string) => void;
  setLayers: (layers: GISLayer[]) => void;

  // Drawing
  drawing: DrawingState;
  setDrawing: (state: Partial<DrawingState>) => void;

  // Chat
  chatMessages: ChatMessage[];
  addChatMessage: (msg: ChatMessage) => void;
  updateChatMessage: (id: string, updates: Partial<ChatMessage>) => void;
  clearChat: () => void;
  isChatLoading: boolean;
  setChatLoading: (loading: boolean) => void;

  // Analysis
  analysisTasks: AnalysisTask[];
  addAnalysisTask: (task: AnalysisTask) => void;
  updateAnalysisTask: (id: string, updates: Partial<AnalysisTask>) => void;

  // Active tools
  activeTool: string | null;
  setActiveTool: (tool: string | null) => void;

  // Measurement
  measurementActive: boolean;
  setMeasurementActive: (active: boolean) => void;

  // 3D Terrain
  terrain3dEnabled: boolean;
  setTerrain3dEnabled: (enabled: boolean) => void;

  // Basemap (for coordinate system detection)
  basemapUrl: string;
  setBasemapUrl: (url: string) => void;

  // API Key
  deepseekApiKey: string;
  setDeepseekApiKey: (key: string) => void;

  // Bookmarks
  bookmarks: Bookmark[];
  saveBookmark: (name: string) => void;
  removeBookmark: (id: string) => void;

  // Auth
  authToken: string;
  user: UserInfo | null;
  setAuth: (token: string, user: UserInfo) => void;
  setUser: (partial: Partial<UserInfo>) => void;
  logout: () => void;
  isLoggedIn: () => boolean;
}

export interface Bookmark {
  id: string;
  name: string;
  center: [number, number];
  zoom: number;
  bearing: number;
  pitch: number;
  layerIds: string[];
  createdAt: number;
}

let layerCounter = 0;

export const useGISStore = create<GISStore>((set) => ({
  mapState: {
    center: [116.397428, 39.90923], // 北京
    zoom: 11,
    bearing: 0,
    pitch: 0,
    bounds: null,
  },
  setMapState: (state) =>
    set((s) => ({ mapState: { ...s.mapState, ...state } })),

  layers: [],
  addLayer: (layer) =>
    set((s) => {
      let data = layer.data;
      // 当底图为高德(GCJ-02)，OSM/上传的 WGS-84 数据自动转换以对齐底图
      if (data && isGCJ02Basemap(s.basemapUrl)) {
        data = transformGeoJSONCoords(data, wgs84ToGcj02) as typeof layer.data;
      }
      return {
        layers: [...s.layers, { ...layer, data, id: layer.id || `layer-${++layerCounter}` }],
      };
    }),
  removeLayer: (id) =>
    set((s) => ({ layers: s.layers.filter((l) => l.id !== id) })),
  updateLayer: (id, updates) =>
    set((s) => ({
      layers: s.layers.map((l) => (l.id === id ? { ...l, ...updates } : l)),
    })),
  toggleLayerVisibility: (id) =>
    set((s) => ({
      layers: s.layers.map((l) =>
        l.id === id ? { ...l, visible: !l.visible } : l
      ),
    })),
  setLayers: (layers) => set({ layers }),

  drawing: { active: false, type: null },
  setDrawing: (state) =>
    set((s) => ({ drawing: { ...s.drawing, ...state } })),

  chatMessages: [
    {
      id: 'welcome',
      role: 'assistant',
      content:
        '你好！我是 GIS Claude 智能助手 🤖\n\n我可以帮你：\n- 🗺️ **空间分析**：缓冲区分析、叠加分析、距离计算等\n- 📊 **数据查询**：属性查询、空间查询\n- 🎨 **制图建议**：配色方案、可视化方案\n- 💡 **GIS 知识问答**：坐标系、投影、空间算法等\n\n请告诉我你需要什么帮助，也可以直接在左侧面板选择空间分析工具！',
      timestamp: Date.now(),
    },
  ],
  addChatMessage: (msg) =>
    set((s) => ({ chatMessages: [...s.chatMessages, msg] })),
  updateChatMessage: (id, updates) =>
    set((s) => ({
      chatMessages: s.chatMessages.map((m) =>
        m.id === id ? { ...m, ...updates } : m
      ),
    })),
  clearChat: () =>
    set((s) => ({
      chatMessages: [s.chatMessages[0]], // keep welcome msg
    })),
  isChatLoading: false,
  setChatLoading: (loading) => set({ isChatLoading: loading }),

  analysisTasks: [],
  addAnalysisTask: (task) =>
    set((s) => ({ analysisTasks: [task, ...s.analysisTasks] })),
  updateAnalysisTask: (id, updates) =>
    set((s) => ({
      analysisTasks: s.analysisTasks.map((t) =>
        t.id === id ? { ...t, ...updates } : t
      ),
    })),

  activeTool: null,
  setActiveTool: (tool) => set({ activeTool: tool }),

  measurementActive: false,
  setMeasurementActive: (active) => set({ measurementActive: active }),

  terrain3dEnabled: false,
  setTerrain3dEnabled: (enabled) => set({ terrain3dEnabled: enabled }),

  // 默认底图 = 高德（GCJ-02）
  basemapUrl: 'https://webrd01.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
  setBasemapUrl: (url) => set({ basemapUrl: url }),

  deepseekApiKey:
    localStorage.getItem('deepseek_api_key') || '',
  setDeepseekApiKey: (key) => {
    localStorage.setItem('deepseek_api_key', key);
    set({ deepseekApiKey: key });
  },

  bookmarks: JSON.parse(localStorage.getItem('gis_bookmarks') || '[]'),
  saveBookmark: (name) =>
    set((s) => {
      const bm: Bookmark = {
        id: `bm-${Date.now()}`,
        name,
        center: s.mapState.center,
        zoom: s.mapState.zoom,
        bearing: s.mapState.bearing,
        pitch: s.mapState.pitch,
        layerIds: s.layers.filter((l) => l.visible).map((l) => l.id),
        createdAt: Date.now(),
      };
      const updated = [...s.bookmarks, bm];
      localStorage.setItem('gis_bookmarks', JSON.stringify(updated));
      return { bookmarks: updated };
    }),
  removeBookmark: (id) =>
    set((s) => {
      const updated = s.bookmarks.filter((b) => b.id !== id);
      localStorage.setItem('gis_bookmarks', JSON.stringify(updated));
      return { bookmarks: updated };
    }),

  authToken: localStorage.getItem('gis_auth_token') || '',
  user: JSON.parse(localStorage.getItem('gis_user') || 'null'),
  setAuth: (token, user) => {
    localStorage.setItem('gis_auth_token', token);
    localStorage.setItem('gis_user', JSON.stringify(user));
    set({ authToken: token, user });
  },
  setUser: (partial) =>
    set((s) => {
      const updated = s.user ? { ...s.user, ...partial } : s.user;
      if (updated) {
        localStorage.setItem('gis_user', JSON.stringify(updated));
      }
      return { user: updated };
    }),
  logout: () => {
    localStorage.removeItem('gis_auth_token');
    localStorage.removeItem('gis_user');
    set({ authToken: '', user: null });
  },
  isLoggedIn: () => {
    const token = localStorage.getItem('gis_auth_token');
    return !!token;
  },
}));
