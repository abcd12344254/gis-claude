/**
 * 时空分析面板
 * CSV 上传 / AI 模拟数据 / 时空立方体控制
 */
import React, { useState, useCallback, useRef, useMemo } from 'react';
import {
  Button, Upload, Space, Typography, message, Slider,
  Tag, Tooltip, Select, Divider, Spin, Switch,
} from 'antd';
import {
  UploadOutlined, ThunderboltOutlined, ExperimentOutlined,
  HeatMapOutlined, ApartmentOutlined, DownloadOutlined,
  InboxOutlined,
} from '@ant-design/icons';
import { useGISStore } from '../store/useGISStore';
import {
  parseCSV, simulateSpaceTimePoints, buildSpaceTimeCube,
  getisOrdGi, HOTSPOT_COLORS, TREND_COLORS,
} from '../services/spacetimeService';
import type { SpaceTimeCube } from '../services/spacetimeService';

const { Text } = Typography;
const { Dragger } = Upload;

// ====== Helpers ======

const MOCK_SCENARIOS: { label: string; bounds: Record<string, number>; center: [number, number]; start: number; end: number; count: number }[] = [
  {
    label: '北京犯罪热点 (2020-2024)',
    bounds: { west: 116.1, east: 116.7, south: 39.7, north: 40.1 },
    center: [116.4, 39.9], start: 2020, end: 2024, count: 500,
  },
  {
    label: '武汉餐饮分布 (2020-2024)',
    bounds: { west: 114.1, east: 114.5, south: 30.4, north: 30.7 },
    center: [114.35, 30.57], start: 2020, end: 2024, count: 300,
  },
  {
    label: '上海房价变化 (2019-2023)',
    bounds: { west: 121.2, east: 121.7, south: 31.0, north: 31.4 },
    center: [121.47, 31.23], start: 2019, end: 2023, count: 400,
  },
];

// ====== Component ======

const SpaceTimePanel: React.FC = () => {
  const { layers, addLayer, mapState } = useGISStore();

  const [csvPoints, setCsvPoints] = useState<number>(0);
  const [cube, setCube] = useState<SpaceTimeCube | null>(null);
  const [selectedYear, setSelectedYear] = useState<number | null>(null);
  const [analysisMode, setAnalysisMode] = useState<'trend' | 'hotspot'>('trend');
  const [loading, setLoading] = useState(false);
  const [show3D, setShow3D] = useState(false);
  const [gridSize, setGridSize] = useState(0.02);

  // 年份范围
  const years = useMemo(() => cube?.years || [], [cube]);
  const currentYear = selectedYear || years[years.length - 1] || 2024;

  // 处理 CSV 上传
  const handleCSVUpload = useCallback((file: File) => {
    setLoading(true);
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      const result = parseCSV(text);
      if (result.errors.length > 0) {
        result.errors.forEach(e => message.warning(e));
      }
      if (result.points.length === 0) {
        message.error('未解析到有效数据点，请检查 CSV 格式');
        setLoading(false);
        return;
      }

      const spaceTimeCube = buildSpaceTimeCube(result.points, gridSize);
      setCube(spaceTimeCube);
      setCsvPoints(result.points.length);
      setSelectedYear(spaceTimeCube.years[spaceTimeCube.years.length - 1]);
      message.success(`✅ 解析完成: ${result.points.length} 个数据点, ${spaceTimeCube.bins.length} 个空间单元, ${spaceTimeCube.years.length} 个年份`);

      // 自动跑热点分析
      const latestYear = spaceTimeCube.years[spaceTimeCube.years.length - 1];
      getisOrdGi(spaceTimeCube.bins, latestYear);
      setLoading(false);
    };
    reader.onerror = () => {
      message.error('文件读取失败');
      setLoading(false);
    };
    reader.readAsText(file);
    return false; // Prevent auto upload
  }, [gridSize]);

  // AI 模拟数据
  const handleSimulate = useCallback((scenarioIdx: number) => {
    setLoading(true);
    const s = MOCK_SCENARIOS[scenarioIdx];
    const points = simulateSpaceTimePoints(
      s.bounds as any, s.start, s.end, s.count, s.center
    );
    const spaceTimeCube = buildSpaceTimeCube(points, gridSize);
    setCube(spaceTimeCube);
    setCsvPoints(points.length);
    setSelectedYear(spaceTimeCube.years[spaceTimeCube.years.length - 1]);

    const latestYear = spaceTimeCube.years[spaceTimeCube.years.length - 1];
    getisOrdGi(spaceTimeCube.bins, latestYear);

    message.success(`🎲 已生成 ${s.label}: ${points.length} 个模拟数据点`);
    setLoading(false);
  }, [gridSize]);

  // 加载到地图 (3D 立方体模式)
  const handleLoadCube3D = useCallback(() => {
    if (!cube) return;

    // 移除旧时空图层
    const store = useGISStore.getState();
    const oldLayers = store.layers.filter(l => l.name.startsWith('时空立方体') || l.name.startsWith('时空热点'));
    oldLayers.forEach(l => store.removeLayer(l.id));

    // 按年份分层，每层抬高
    const yearCount = cube.years.length;
    const layerHeight = 800; // 每层高 800 "米"（视觉单位）

    cube.years.forEach((year, yi) => {
      const baseHeight = yi * layerHeight;
      const features = cube.bins
        .filter(b => b.values[year] > 0)
        .map(b => {
          const value = b.values[year];
          const color = analysisMode === 'hotspot'
            ? (HOTSPOT_COLORS[b.hotspotType || '无显著'] || '#adb5bd')
            : (TREND_COLORS[b.trend] || '#adb5bd');

          return {
            type: 'Feature' as const,
            geometry: { type: 'Polygon' as const, coordinates: b.polygon },
            properties: {
              year,
              value,
              totalValue: b.totalValue,
              trend: b.trend,
              hotspotType: b.hotspotType || '',
              giZScore: b.giZScore,
              _districtColor: color,
              _extrusionHeight: Math.max(value * 200, 50), // 数值映射为高度
              _baseHeight: baseHeight,
            },
          };
        });

      if (features.length > 0) {
        addLayer({
          id: '', name: `时空立方体_${year}年`, type: 'geojson', visible: true,
          color: '#1677ff', opacity: 0.6,
          data: { type: 'FeatureCollection', features },
          sourceId: '', layerId: '', createdAt: Date.now(),
        });
      }
    });

    // 飞到数据范围
    const { extent } = cube;
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('zoom-to-bounds', {
        detail: [[extent.west, extent.south], [extent.east, extent.north]] as any,
      }));
    }, 300);

    message.success(`✅ 时空立方体已加载: ${cube.bins.length} 个空间单元 × ${yearCount} 年`);
    setShow3D(true);
  }, [cube, analysisMode, addLayer]);

  // 加载热点图 (2D 平面)
  const handleLoadHotspot2D = useCallback(() => {
    if (!cube || !selectedYear) return;

    const store = useGISStore.getState();
    const oldLayers = store.layers.filter(l => l.name.startsWith('时空立方体') || l.name.startsWith('时空热点'));
    oldLayers.forEach(l => store.removeLayer(l.id));

    // 重新计算热点
    getisOrdGi(cube.bins, currentYear);

    const features = cube.bins
      .filter(b => b.values[currentYear] > 0)
      .map(b => ({
        type: 'Feature' as const,
        geometry: { type: 'Polygon' as const, coordinates: b.polygon },
        properties: {
          year: currentYear,
          value: b.values[currentYear],
          trend: b.trend,
          hotspotType: b.hotspotType || '无显著',
          _districtColor: HOTSPOT_COLORS[b.hotspotType || '无显著'] || '#adb5bd',
        },
      }));

    addLayer({
      id: '', name: `时空热点_${currentYear}年`, type: 'geojson', visible: true,
      color: '#e03131', opacity: 0.65,
      data: { type: 'FeatureCollection', features },
      sourceId: '', layerId: '', createdAt: Date.now(),
    });

    const { extent } = cube;
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('zoom-to-bounds', {
        detail: [[extent.west, extent.south], [extent.east, extent.north]] as any,
      }));
    }, 300);

    message.success(`✅ 热点图已加载: ${currentYear}年`);
  }, [cube, selectedYear, currentYear, addLayer]);

  return (
    <div style={{
      borderTop: '2px solid #722ed1',
      background: '#fff',
      padding: '12px 16px',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <Space size="small">
          <ApartmentOutlined style={{ color: '#722ed1', fontSize: 16 }} />
          <Text strong style={{ fontSize: 14, color: '#333' }}>时空立方体</Text>
          <Tag color="purple" style={{ fontSize: 10, lineHeight: '16px' }}>3D</Tag>
        </Space>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {/* 数据导入 */}
        {!cube ? (
          <>
            <Dragger
              accept=".csv"
              showUploadList={false}
              beforeUpload={handleCSVUpload}
              style={{ padding: '12px 0' }}
            >
              <p className="ant-upload-drag-icon"><InboxOutlined /></p>
              <p style={{ fontSize: 12, margin: 0 }}>点击或拖拽 CSV 文件</p>
              <p style={{ fontSize: 10, color: '#999' }}>列: lat, lng, time, value</p>
            </Dragger>

            <Divider style={{ margin: '4px 0', fontSize: 11 }}>或</Divider>

            <Text style={{ fontSize: 10, color: '#999' }}>AI 模拟数据</Text>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {MOCK_SCENARIOS.map((s, i) => (
                <Button
                  key={i}
                  size="small"
                  icon={<ExperimentOutlined />}
                  onClick={() => handleSimulate(i)}
                  loading={loading}
                  block
                >
                  {s.label}
                </Button>
              ))}
            </div>
          </>
        ) : (
          <>
            {/* 数据信息 */}
            <div style={{ padding: '6px 8px', background: '#f9f0ff', borderRadius: 4, border: '1px solid #d3adf7' }}>
              <Text style={{ fontSize: 11, color: '#722ed1' }}>
                📊 {csvPoints} 点 · {cube.bins.length} 单元 · {years.length} 年
              </Text>
            </div>

            {/* 年份选择 */}
            <div>
              <Text style={{ fontSize: 10, color: '#999' }}>选择年份: {currentYear}</Text>
              <Slider
                min={years[0]} max={years[years.length - 1]} step={1}
                value={currentYear}
                onChange={setSelectedYear}
                marks={Object.fromEntries(years.map(y => [y, `${y}`]))}
                style={{ margin: '4px 0' }}
              />
            </div>

            {/* 分析模式 */}
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <Text style={{ fontSize: 10, color: '#999' }}>着色:</Text>
              <Select
                size="small"
                value={analysisMode}
                onChange={setAnalysisMode}
                style={{ flex: 1 }}
                options={[
                  { value: 'trend', label: '趋势 (增/减/稳)' },
                  { value: 'hotspot', label: '冷热点 (Gi*)' },
                ]}
              />
            </div>

            {/* 网格大小 */}
            <div>
              <Text style={{ fontSize: 10, color: '#999' }}>网格: {gridSize.toFixed(3)}°</Text>
              <Slider min={0.005} max={0.1} step={0.005} value={gridSize} onChange={setGridSize} style={{ margin: 0 }} />
            </div>

            {/* 操作按钮 */}
            <Button type="primary" icon={<ApartmentOutlined />} onClick={handleLoadCube3D} block size="small"
              style={{ background: 'linear-gradient(135deg, #722ed1, #531dab)', border: 'none' }}>
              加载 3D 立方体
            </Button>
            <Button icon={<HeatMapOutlined />} onClick={handleLoadHotspot2D} block size="small">
              加载 {currentYear} 年热点图
            </Button>

            {/* 图例 */}
            <div style={{ fontSize: 10, padding: '4px 6px', background: '#fafafa', borderRadius: 4 }}>
              <Text style={{ fontSize: 10, color: '#666' }}>
                {analysisMode === 'hotspot' ? '热点类型:' : '趋势类型:'}
              </Text>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 6px', marginTop: 4 }}>
                {(analysisMode === 'hotspot'
                  ? Object.entries(HOTSPOT_COLORS)
                  : Object.entries(TREND_COLORS)
                ).map(([label, color]) => (
                  <span key={label} style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                    <span style={{ width: 10, height: 10, borderRadius: 2, background: color, display: 'inline-block' }} />
                    {label === 'increasing' ? '增长' :
                     label === 'decreasing' ? '减弱' :
                     label === 'stable' ? '稳定' :
                     label === 'oscillating' ? '振荡' :
                     label === 'new' ? '新兴' :
                     label === 'disappearing' ? '消失' : label}
                  </span>
                ))}
              </div>
            </div>

            {/* 重置 */}
            <Button size="small" type="text" onClick={() => { setCube(null); setCsvPoints(0); }} block>
              清除数据
            </Button>
          </>
        )}

        {loading && <Spin size="small"><Text style={{ fontSize: 10 }}>处理中...</Text></Spin>}
      </div>
    </div>
  );
};

export default SpaceTimePanel;
