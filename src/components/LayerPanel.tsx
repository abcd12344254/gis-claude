import React, { useCallback, useRef } from 'react';
import {
  List,
  Button,
  Space,
  Typography,
  ColorPicker,
  Slider,
  Tag,
  Upload,
  message,
  Popconfirm,
  Empty,
  Dropdown,
  Tooltip,
} from 'antd';
import type { MenuProps } from 'antd';
import {
  EyeOutlined,
  EyeInvisibleOutlined,
  DeleteOutlined,
  UploadOutlined,
  MoreOutlined,
  PlusOutlined,
  DownloadOutlined,
  CopyOutlined,
} from '@ant-design/icons';
import { useGISStore } from '../store/useGISStore';
import { useIsMobile } from '../hooks/useIsMobile';
import type { FeatureCollection } from 'geojson';
import { getFCBounds } from '../utils/geo';

const { Text } = Typography;

const GEOMETRY_ICONS: Record<string, string> = {
  point: '📍',
  line: '📏',
  polygon: '🔷',
  geojson: '🗂️',
  raster: '🖼️',
};

const LayerPanel: React.FC = () => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { layers, toggleLayerVisibility, removeLayer, updateLayer, addLayer } =
    useGISStore();

  const isMobile = useIsMobile();

  const handleFileUpload = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      const isCSV = file.name.endsWith('.csv');

      const reader = new FileReader();
      reader.onload = (evt) => {
        try {
          const text = evt.target?.result as string;

          if (isCSV) {
            // Parse CSV → GeoJSON Point FeatureCollection
            const data = parseCSVToPoints(text);
            if (data.features.length === 0) {
              message.error('CSV 未解析到有效数据，需包含 lat/lng 列');
              return;
            }

            const colors = ['#1677ff', '#52c41a', '#fa8c16', '#f5222d', '#722ed1'];
            addLayer({
              id: '',
              name: file.name.replace(/\.csv$/i, ''),
              type: 'point',
              visible: true,
              color: colors[Math.floor(Math.random() * colors.length)],
              opacity: 0.8,
              data,
              sourceId: '',
              layerId: '',
              createdAt: Date.now(),
            });
            message.success(`已导入 "${file.name}" (${data.features.length} 个点位)`);
          } else {
            // Parse GeoJSON
            const data = JSON.parse(text) as FeatureCollection;
            if (!data.type || !data.features) {
              message.error('无效的 GeoJSON 文件');
              return;
            }

            const types = new Set(data.features.map((f) => f.geometry?.type));
            let layerType: 'point' | 'line' | 'polygon' | 'geojson' = 'geojson';
            if (types.size === 1) {
              const t = [...types][0];
              if (t === 'Point' || t === 'MultiPoint') layerType = 'point';
              else if (t === 'LineString' || t === 'MultiLineString') layerType = 'line';
              else if (t === 'Polygon' || t === 'MultiPolygon') layerType = 'polygon';
            }

            const colors = ['#1677ff', '#52c41a', '#fa8c16', '#f5222d', '#722ed1'];
            addLayer({
              id: '',
              name: file.name.replace(/\.(geo)?json$/i, ''),
              type: layerType,
              visible: true,
              color: colors[Math.floor(Math.random() * colors.length)],
              opacity: 0.7,
              data,
              sourceId: '',
              layerId: '',
              createdAt: Date.now(),
            });
            message.success(`已加载 "${file.name}" (${data.features.length} 个要素)`);
          }
        } catch {
          message.error('文件解析失败，请检查格式');
        }
      };
      reader.readAsText(file);

      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    },
    [addLayer]
  );

  const handleExportLayer = useCallback(
    (layerId: string) => {
      const layer = layers.find((l) => l.id === layerId);
      if (!layer?.data) return;

      const json = JSON.stringify(layer.data, null, 2);
      const blob = new Blob([json], { type: 'application/geo+json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${layer.name}.geojson`;
      a.click();
      URL.revokeObjectURL(url);
    },
    [layers]
  );

  const handleDuplicateLayer = useCallback(
    (layerId: string) => {
      const layer = layers.find((l) => l.id === layerId);
      if (!layer) return;

      addLayer({
        ...layer,
        id: '',
        name: `${layer.name}_副本`,
        createdAt: Date.now(),
      });
    },
    [layers, addLayer]
  );

  const contextMenuItems = useCallback(
    (layerId: string): MenuProps['items'] => [
      {
        key: 'export',
        icon: <DownloadOutlined />,
        label: '导出 GeoJSON',
        onClick: () => handleExportLayer(layerId),
      },
      {
        key: 'duplicate',
        icon: <CopyOutlined />,
        label: '复制图层',
        onClick: () => handleDuplicateLayer(layerId),
      },
    ],
    [handleExportLayer, handleDuplicateLayer]
  );

  const zoomToLayer = useCallback(
    (layerId: string) => {
      const layer = layers.find((l) => l.id === layerId);
      if (!layer?.data) return;

      // Find map instance and fly to bounds
      const mapEl = document.querySelector('.maplibregl-map');
      if (mapEl) {
        // Dispatch custom event for map bounds update
        const bbox = getFCBounds(layer.data);
        if (bbox) {
          window.dispatchEvent(
            new CustomEvent('zoom-to-bounds', { detail: bbox })
          );
        }
      }
    },
    [layers]
  );

  return (
    <div
      style={{
        padding: '12px',
        borderBottom: '1px solid #e8e8e8',
        flexShrink: 0,
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 12,
        }}
      >
        <Text strong style={{ fontSize: 14 }}>
          🗂️ 图层管理
        </Text>
        <Space size="small">
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,.geojson,.csv"
            style={{ display: 'none' }}
            onChange={handleFileUpload}
          />
          <Tooltip title="加载 GeoJSON 或 CSV 点位">
            <Button
              size={isMobile ? 'middle' : 'small'}
              icon={<UploadOutlined />}
              onClick={() => fileInputRef.current?.click()}
            />
          </Tooltip>
        </Space>
      </div>

      {layers.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="暂无图层，请加载数据"
          style={{ marginTop: 24 }}
        />
      ) : (
        <List
          size="small"
          dataSource={layers}
          renderItem={(layer) => (
            <List.Item
              className="layer-item"
              style={{
                padding: isMobile ? '10px 8px' : '8px',
                cursor: 'pointer',
                borderRadius: 6,
              }}
              onClick={() => zoomToLayer(layer.id)}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  width: '100%',
                  gap: 8,
                }}
              >
                {/* Visibility toggle */}
                <Button
                  type="text"
                  size={isMobile ? 'middle' : 'small'}
                  icon={
                    layer.visible ? (
                      <EyeOutlined />
                    ) : (
                      <EyeInvisibleOutlined style={{ color: '#999' }} />
                    )
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleLayerVisibility(layer.id);
                  }}
                />

                {/* Type icon + name */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span>{GEOMETRY_ICONS[layer.type] || '📦'}</span>
                    <Text
                      ellipsis
                      style={{
                        fontSize: 12,
                        textDecoration: layer.visible ? 'none' : 'line-through',
                        color: layer.visible ? '#000' : '#999',
                      }}
                    >
                      {layer.name}
                    </Text>
                  </div>
                  {layer.data && (
                    <Text
                      type="secondary"
                      style={{ fontSize: 10, marginLeft: 22 }}
                    >
                      {layer.data.features?.length || 0} 要素
                    </Text>
                  )}
                </div>

                {/* Color picker */}
                <div onClick={(e) => e.stopPropagation()}>
                  <ColorPicker
                    size={isMobile ? 'middle' : 'small'}
                    value={layer.color}
                    onChange={(color) =>
                      updateLayer(layer.id, { color: color.toHexString() })
                    }
                  />
                </div>

                {/* Opacity slider */}
                <div style={{ width: isMobile ? 60 : 40 }} onClick={(e) => e.stopPropagation()}>
                  <Slider
                    min={0}
                    max={1}
                    step={0.1}
                    value={layer.opacity}
                    onChange={(val) =>
                      updateLayer(layer.id, { opacity: val })
                    }
                    tooltip={{ formatter: (v) => `${(v! * 100).toFixed(0)}%` }}
                    style={{ margin: 0 }}
                  />
                </div>

                {/* Context menu */}
                <Dropdown menu={{ items: contextMenuItems(layer.id) }}>
                  <Button
                    type="text"
                    size={isMobile ? 'middle' : 'small'}
                    icon={<MoreOutlined />}
                    onClick={(e) => e.stopPropagation()}
                  />
                </Dropdown>

                {/* Delete */}
                <Popconfirm
                  title="确认删除此图层？"
                  onConfirm={(e) => {
                    e?.stopPropagation();
                    removeLayer(layer.id);
                  }}
                  onCancel={(e) => e?.stopPropagation()}
                  okText="删除"
                  cancelText="取消"
                >
                  <Button
                    type="text"
                    size={isMobile ? 'middle' : 'small'}
                    danger
                    icon={<DeleteOutlined />}
                    onClick={(e) => e.stopPropagation()}
                  />
                </Popconfirm>
              </div>
            </List.Item>
          )}
        />
      )}

    </div>
  );
};

import type { Geometry, Point, MultiPoint, LineString, MultiLineString, Polygon, MultiPolygon } from 'geojson';

/** 简易 CSV 解析 → GeoJSON Point FeatureCollection */
function parseCSVToPoints(csvText: string): FeatureCollection {
  const lines = csvText.trim().split('\n');
  if (lines.length < 2) return { type: 'FeatureCollection', features: [] };

  const headers = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
  const latIdx = headers.findIndex((h) => /^(lat|latitude|纬度|y)$/i.test(h));
  const lngIdx = headers.findIndex((h) => /^(lng|lon|longitude|lng|long|经度|x)$/i.test(h));
  const nameIdx = headers.findIndex((h) => /^(name|名称|label|title)$/i.test(h));

  if (latIdx < 0 || lngIdx < 0) return { type: 'FeatureCollection', features: [] };

  const features = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
    const lat = parseFloat(cols[latIdx]);
    const lng = parseFloat(cols[lngIdx]);
    if (isNaN(lat) || isNaN(lng)) continue;

    const props: Record<string, unknown> = {};
    if (nameIdx >= 0 && cols[nameIdx]) props.name = cols[nameIdx];
    // 保留其他列作为属性
    headers.forEach((h, idx) => {
      if (idx !== latIdx && idx !== lngIdx && cols[idx] !== undefined) {
        const num = parseFloat(cols[idx]);
        props[h] = isNaN(num) ? cols[idx] : num;
      }
    });

    features.push({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [lng, lat] },
      properties: props,
    });
  }

  return { type: 'FeatureCollection', features };
}

export default LayerPanel;
