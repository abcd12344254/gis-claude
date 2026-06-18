import React, { useCallback, useState } from 'react';
import {
  Button,
  Space,
  Typography,
  Select,
  InputNumber,
  Card,
  message,
  Divider,
  Collapse,
  Tag,
  Tooltip,
} from 'antd';
import {
  ThunderboltOutlined,
  RadiusSettingOutlined,
  MergeCellsOutlined,
  AimOutlined,
  CompressOutlined,
  ExpandOutlined,
  BorderOuterOutlined,
  ScissorOutlined,
  AppstoreOutlined,
  HeatMapOutlined,
} from '@ant-design/icons';
import { useGISStore } from '../store/useGISStore';
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
  createGrid,
  pointDensityAnalysis,
} from '../services/spatialAnalysis';
import type { FeatureCollection, Feature, Polygon, MultiPolygon } from 'geojson';
import { getFCBbox } from '../utils/geo';

const { Text } = Typography;

interface ToolConfig {
  key: string;
  label: string;
  icon: React.ReactNode;
  description: string;
  needRadius?: boolean;
  needLayer?: boolean;
  needTwoLayers?: boolean;
}

const ANALYSIS_TOOLS: ToolConfig[] = [
  {
    key: 'buffer',
    label: '缓冲区',
    icon: <RadiusSettingOutlined />,
    description: '创建要素周围指定距离的缓冲区',
    needRadius: true,
    needLayer: true,
  },
  {
    key: 'intersect',
    label: '相交分析',
    icon: <MergeCellsOutlined />,
    description: '计算两个图层的相交区域',
    needTwoLayers: true,
  },
  {
    key: 'union',
    label: '合并分析',
    icon: <ExpandOutlined />,
    description: '合并两个多边形要素',
    needLayer: true,
  },
  {
    key: 'difference',
    label: '差集分析',
    icon: <ScissorOutlined />,
    description: '从图层A中减去图层B（A - B）',
    needTwoLayers: true,
  },
  {
    key: 'area',
    label: '面积计算',
    icon: <AppstoreOutlined />,
    description: '计算多边形要素的面积',
    needLayer: true,
  },
  {
    key: 'centroid',
    label: '中心点',
    icon: <AimOutlined />,
    description: '计算要素的几何中心',
    needLayer: true,
  },
  {
    key: 'bbox',
    label: '边界框',
    icon: <BorderOuterOutlined />,
    description: '计算要素的外接矩形',
    needLayer: true,
  },
  {
    key: 'simplify',
    label: '简化',
    icon: <CompressOutlined />,
    description: '简化要素几何（减少顶点）',
    needRadius: true,
    needLayer: true,
  },
  {
    key: 'convex',
    label: '凸包',
    icon: <ScissorOutlined />,
    description: '计算点集的凸包',
    needLayer: true,
  },
  {
    key: 'grid',
    label: '格网',
    icon: <AppstoreOutlined />,
    description: '创建渔网格网',
    needRadius: true,
  },
  {
    key: 'density',
    label: '点密度',
    icon: <HeatMapOutlined />,
    description: '计算点密度分布',
    needLayer: true,
  },
];

const SpatialAnalysisPanel: React.FC = () => {
  const { layers, addLayer, addAnalysisTask } = useGISStore();
  const [selectedTool, setSelectedTool] = useState<string | null>(null);
  const [radius, setRadius] = useState<number>(5);
  const [selectedLayerId, setSelectedLayerId] = useState<string | null>(null);
  const [secondLayerId, setSecondLayerId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const visibleLayers = layers.filter((l) => l.visible && l.data);

  const handleRunAnalysis = useCallback(async () => {
    if (!selectedTool) {
      message.warning('请先选择分析工具');
      return;
    }

    setRunning(true);

    try {
      const tool = ANALYSIS_TOOLS.find((t) => t.key === selectedTool);
      if (!tool) return;

      // For tools needing a layer
      if (tool.needLayer && !selectedLayerId) {
        message.warning('请选择要分析的图层');
        setRunning(false);
        return;
      }

      const layer = visibleLayers.find((l) => l.id === selectedLayerId);
      if (tool.needLayer && !layer?.data) {
        message.warning('所选图层没有数据');
        setRunning(false);
        return;
      }

      let resultDescription = '';
      let resultData: FeatureCollection | null = null;

      switch (selectedTool) {
        case 'buffer': {
          const r = await bufferAnalysis(layer!.data!, radius);
          resultDescription = r.description;
          resultData = r.result as FeatureCollection | null;
          break;
        }
        case 'intersect': {
          const layer2 = visibleLayers.find((l) => l.id === secondLayerId);
          if (!layer2?.data) {
            message.warning('请选择第二个图层');
            setRunning(false);
            return;
          }
          const r = intersectAnalysis(layer!.data!, layer2.data);
          resultDescription = r.description;
          resultData = r.result as FeatureCollection | null;
          break;
        }
        case 'union': {
          const r = unionAnalysis(layer!.data!);
          resultDescription = r.description;
          resultData = r.result as FeatureCollection | null;
          break;
        }
        case 'difference': {
          const layer2 = visibleLayers.find((l) => l.id === secondLayerId);
          if (!layer2?.data) {
            message.warning('请选择第二个图层（用作减数）');
            setRunning(false);
            return;
          }
          const r = differenceAnalysis(layer!.data!, layer2.data);
          resultDescription = r.description;
          resultData = r.result as FeatureCollection | null;
          break;
        }
        case 'area': {
          const feature = layer!.data!.features[0] as Feature<Polygon | MultiPolygon>;
          if (!feature) {
            message.warning('图层没有要素');
            setRunning(false);
            return;
          }
          const r = calculateArea(feature);
          resultDescription = r.description;
          break;
        }
        case 'centroid': {
          const r = calculateCentroid(layer!.data!);
          resultDescription = r.description;
          resultData = r.result as FeatureCollection | null;
          break;
        }
        case 'bbox': {
          const r = calculateBBox(layer!.data!);
          resultDescription = r.description;
          resultData = r.result as FeatureCollection | null;
          break;
        }
        case 'simplify': {
          const r = simplifyFeatures(layer!.data!, radius);
          resultDescription = r.description;
          resultData = r.result as FeatureCollection | null;
          break;
        }
        case 'convex': {
          const r = convexHullAnalysis(layer!.data!);
          resultDescription = r.description;
          resultData = r.result as FeatureCollection | null;
          break;
        }
        case 'grid': {
          const bbox = layer?.data ? getFCBbox(layer.data) : null;
          if (!bbox) {
            message.warning('无法确定图层范围');
            setRunning(false);
            return;
          }
          const r = createGrid(bbox, radius);
          resultDescription = r.description;
          resultData = r.result as FeatureCollection | null;
          break;
        }
        case 'density': {
          const r = pointDensityAnalysis(layer!.data!);
          resultDescription = r.description;
          resultData = r.result as FeatureCollection | null;
          break;
        }
      }

      // Add result as a new layer if we have data
      if (resultData) {
        const toolLabel = ANALYSIS_TOOLS.find((t) => t.key === selectedTool)?.label || selectedTool;
        // 缓冲区用红色半透明与原图层明显区分，其他分析沿用图层颜色
        const resultColor = selectedTool === 'buffer' ? '#ff4d4f' : (layer?.color || '#1677ff');
        const resultOpacity = selectedTool === 'buffer' ? 0.4 : 0.6;

        const newLayerName = `${layer?.name || '分析'}_${toolLabel}_${new Date().toLocaleTimeString()}`;
        addLayer({
          id: '',
          name: newLayerName,
          type: 'geojson',
          visible: true,
          color: resultColor,
          opacity: resultOpacity,
          data: resultData,
          sourceId: '',
          layerId: '',
          createdAt: Date.now(),
        });
      }

      message.success(resultDescription);
    } catch (err) {
      message.error(`分析失败: ${err instanceof Error ? err.message : '未知错误'}`);
    } finally {
      setRunning(false);
    }
  }, [
    selectedTool,
    selectedLayerId,
    secondLayerId,
    radius,
    visibleLayers,
    addLayer,
  ]);

  return (
    <div
      style={{
        padding: '12px',
        flexShrink: 0,
        borderTop: '1px solid #f0f0f0',
      }}
    >
      <Text strong style={{ fontSize: 14, display: 'block', marginBottom: 12 }}>
        🔬 空间分析
      </Text>

      {/* Tool selector */}
      <div style={{ marginBottom: 8 }}>
        <Text type="secondary" style={{ fontSize: 11, marginBottom: 4, display: 'block' }}>
          分析工具
        </Text>
        <Select
          placeholder="选择分析工具..."
          style={{ width: '100%' }}
          value={selectedTool}
          onChange={setSelectedTool}
          options={ANALYSIS_TOOLS.map((t) => ({
            value: t.key,
            label: (
              <span>
                {t.icon} {t.label}
              </span>
            ),
          }))}
        />
      </div>

      {/* Tool description */}
      {selectedTool && (
        <Card
          size="small"
          style={{ marginBottom: 8, background: '#f0f5ff', border: '1px solid #d6e4ff' }}
        >
          <Text style={{ fontSize: 12 }}>
            {
              ANALYSIS_TOOLS.find((t) => t.key === selectedTool)?.description
            }
          </Text>
        </Card>
      )}

      {/* Layer selector */}
      {selectedTool &&
        ANALYSIS_TOOLS.find((t) => t.key === selectedTool)?.needLayer && (
          <div style={{ marginBottom: 8 }}>
            <Text type="secondary" style={{ fontSize: 11, marginBottom: 4, display: 'block' }}>
              选择图层
            </Text>
            <Select
              placeholder="选择要分析的图层..."
              style={{ width: '100%' }}
              value={selectedLayerId}
              onChange={setSelectedLayerId}
              options={visibleLayers.map((l) => ({
                value: l.id,
                label: l.name,
              }))}
              notFoundContent="没有可用图层"
            />
          </div>
        )}

      {/* Second layer selector (for intersect) */}
      {(selectedTool === 'intersect' || selectedTool === 'difference') && (
        <div style={{ marginBottom: 8 }}>
          <Text type="secondary" style={{ fontSize: 11, marginBottom: 4, display: 'block' }}>
            第二个图层
          </Text>
          <Select
            placeholder="选择第二个图层..."
            style={{ width: '100%' }}
            value={secondLayerId}
            onChange={setSecondLayerId}
            options={visibleLayers
              .filter((l) => l.id !== selectedLayerId)
              .map((l) => ({
                value: l.id,
                label: l.name,
              }))}
            notFoundContent="需要至少两个图层"
          />
        </div>
      )}

      {/* Radius input */}
      {selectedTool &&
        ANALYSIS_TOOLS.find((t) => t.key === selectedTool)?.needRadius && (
          <div style={{ marginBottom: 8 }}>
            <Text type="secondary" style={{ fontSize: 11, marginBottom: 4, display: 'block' }}>
              {selectedTool === 'simplify' ? '容差' : selectedTool === 'grid' ? '格网大小 (km)' : '半径 (km)'}
            </Text>
            <InputNumber
              style={{ width: '100%' }}
              value={radius}
              onChange={(v) => setRadius(v || 1)}
              min={0.001}
              step={selectedTool === 'simplify' ? 0.001 : 1}
            />
          </div>
        )}

      {/* Run button */}
      <Button
        type="primary"
        icon={<ThunderboltOutlined />}
        onClick={handleRunAnalysis}
        loading={running}
        disabled={!selectedTool}
        block
        style={{ marginTop: 4 }}
      >
        执行分析
      </Button>

      <Divider style={{ margin: '12px 0' }} />

      {/* Analysis history */}
      <Text type="secondary" style={{ fontSize: 12 }}>
        提示：分析结果将自动作为新图层添加到地图中。双击地图可结束测量/绘制操作。
      </Text>
    </div>
  );
};

export default SpatialAnalysisPanel;
