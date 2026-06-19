import React, { useState } from 'react';
import { Button, Space, Tooltip, Dropdown, message, Modal, Input } from 'antd';
import type { MenuProps } from 'antd';
import {
  AimOutlined,
  ExpandOutlined,
  CompressOutlined,
  EnvironmentOutlined,
  GlobalOutlined,
  SearchOutlined,
  BlockOutlined,
  StarOutlined,
  StarFilled,
  DeleteOutlined,
} from '@ant-design/icons';
import { useGISStore } from '../store/useGISStore';
import { useIsMobile } from '../hooks/useIsMobile';

const CITIES: { name: string; center: [number, number]; zoom: number }[] = [
  { name: '北京', center: [116.397, 39.909], zoom: 11 },
  { name: '上海', center: [121.474, 31.23], zoom: 11 },
  { name: '广州', center: [113.264, 23.129], zoom: 11 },
  { name: '深圳', center: [114.058, 22.543], zoom: 11 },
  { name: '成都', center: [104.066, 30.573], zoom: 11 },
  { name: '杭州', center: [120.155, 30.274], zoom: 11 },
  { name: '武汉', center: [114.305, 30.593], zoom: 11 },
  { name: '西安', center: [108.94, 34.261], zoom: 11 },
  { name: '南京', center: [118.797, 32.058], zoom: 11 },
  { name: '重庆', center: [106.551, 29.563], zoom: 11 },
];

const BASE_MAPS: { name: string; url: string; attribution: string }[] = [
  {
    name: '高德地图',
    url: 'https://webrd01.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
    attribution: '© 高德地图 AutoNavi',
  },
  {
    name: '高德卫星图',
    url: 'https://webst01.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}',
    attribution: '© 高德地图 AutoNavi',
  },
  {
    name: 'OpenStreetMap',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '© OpenStreetMap',
  },
  {
    name: 'CartoDB Light',
    url: 'https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
    attribution: '© CartoDB',
  },
  {
    name: 'CartoDB Dark',
    url: 'https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
    attribution: '© CartoDB',
  },
  {
    name: 'Esri 卫星图',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: '© Esri',
  },
  {
    name: 'Esri 地形图',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
    attribution: '© Esri',
  },
];

const Toolbar: React.FC = () => {
  const {
    setMapState,
    mapState,
    measurementActive,
    setMeasurementActive,
    terrain3dEnabled,
    setTerrain3dEnabled,
    bookmarks,
    saveBookmark,
    removeBookmark,
    layers,
  } = useGISStore();

  const isMobile = useIsMobile();

  const [bmModalOpen, setBmModalOpen] = useState(false);
  const [bmName, setBmName] = useState('');

  const handleZoomIn = () => {
    window.dispatchEvent(new CustomEvent('map-zoom-in'));
  };

  const handleZoomOut = () => {
    window.dispatchEvent(new CustomEvent('map-zoom-out'));
  };

  const handleFlyTo = (center: [number, number], zoom: number) => {
    setMapState({ center, zoom });
    window.dispatchEvent(
      new CustomEvent('fly-to', { detail: { center, zoom } })
    );
  };

  const handleBaseMapChange: MenuProps['onClick'] = (e) => {
    const bm = BASE_MAPS.find((b) => b.name === e.key);
    if (bm) {
      window.dispatchEvent(
        new CustomEvent('change-basemap', { detail: bm })
      );
      message.success(`切换底图: ${bm.name}`);
    }
  };

  const cityItems: MenuProps['items'] = CITIES.map((c) => ({
    key: c.name,
    label: c.name,
    onClick: () => handleFlyTo(c.center, c.zoom),
  }));

  const baseMapItems: MenuProps['items'] = BASE_MAPS.map((b) => ({
    key: b.name,
    label: b.name,
  }));

  const handleSaveBookmark = () => {
    const name = bmName.trim() || `视图 ${new Date().toLocaleTimeString()}`;
    saveBookmark(name);
    setBmModalOpen(false);
    setBmName('');
    message.success(`已保存视图: ${name}`);
  };

  const handleRestoreBookmark = (bmId: string) => {
    const bm = bookmarks.find((b) => b.id === bmId);
    if (!bm) return;
    setMapState({ center: bm.center, zoom: bm.zoom, bearing: bm.bearing, pitch: bm.pitch });
    window.dispatchEvent(new CustomEvent('fly-to', { detail: { center: bm.center, zoom: bm.zoom } }));
    // 恢复图层可见性
    const store = useGISStore.getState();
    store.layers.forEach((l) => {
      store.updateLayer(l.id, { visible: bm.layerIds.includes(l.id) });
    });
    message.success(`已恢复视图: ${bm.name}`);
  };

  const bookmarkItems: MenuProps['items'] = bookmarks.length === 0
    ? [{ key: 'empty', label: '暂无书签', disabled: true }]
    : bookmarks.slice(-10).reverse().map((bm) => ({
        key: bm.id,
        label: (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <span>{bm.name}</span>
            <Button
              type="text"
              size="small"
              danger
              icon={<DeleteOutlined />}
              onClick={(evt) => { evt.stopPropagation(); removeBookmark(bm.id); }}
            />
          </div>
        ),
        onClick: () => handleRestoreBookmark(bm.id),
      }));

  const btnSize = isMobile ? 'middle' : 'small' as const;

  return (
    <Space size="small" wrap>
      <Dropdown menu={{ items: cityItems }}>
        <Button size={btnSize} icon={<GlobalOutlined />}>
          {isMobile ? '' : '城市'}
        </Button>
      </Dropdown>

      <Dropdown menu={{ items: baseMapItems, onClick: handleBaseMapChange }}>
        <Button size={btnSize} icon={<EnvironmentOutlined />}>
          {isMobile ? '' : '底图'}
        </Button>
      </Dropdown>

      <Tooltip title="放大">
        <Button size={btnSize} icon={<ExpandOutlined />} onClick={handleZoomIn} />
      </Tooltip>

      <Tooltip title="缩小">
        <Button size={btnSize} icon={<CompressOutlined />} onClick={handleZoomOut} />
      </Tooltip>

      <Tooltip title="回到初始视图">
        <Button
          size={btnSize}
          icon={<AimOutlined />}
          onClick={() => handleFlyTo([116.397, 39.909], 11)}
        />
      </Tooltip>

      <Tooltip title={measurementActive ? '测量中...双击结束' : '测量工具'}>
        <Button
          size={btnSize}
          icon={<SearchOutlined />}
          type={measurementActive ? 'primary' : 'default'}
          onClick={() => {
            setMeasurementActive(!measurementActive);
            if (measurementActive) {
              message.info('点击地图开始测量，双击结束');
            }
          }}
        />
      </Tooltip>

      <Tooltip title={terrain3dEnabled ? '切换2D平面视图' : '切换3D地形视图'}>
        <Button
          size={btnSize}
          icon={<BlockOutlined />}
          type={terrain3dEnabled ? 'primary' : 'default'}
          onClick={() => {
            const next = !terrain3dEnabled;
            setTerrain3dEnabled(next);
            window.dispatchEvent(
              new CustomEvent('toggle-3d-terrain', { detail: { enabled: next } })
            );
            message.info(next ? '已切换至3D地形视图' : '已切换至2D平面视图');
          }}
        />
      </Tooltip>

      <Dropdown menu={{ items: bookmarkItems }}>
        <Tooltip title="书签视图">
          <Button size={btnSize} icon={<StarOutlined />} />
        </Tooltip>
      </Dropdown>
      <Tooltip title="保存当前视图">
        <Button
          size={btnSize}
          icon={<StarFilled />}
          onClick={() => {
            setBmName('');
            setBmModalOpen(true);
          }}
        />
      </Tooltip>

      <Modal
        title="保存视图"
        open={bmModalOpen}
        onOk={handleSaveBookmark}
        onCancel={() => setBmModalOpen(false)}
        okText="保存"
        cancelText="取消"
        width={320}
      >
        <Input
          placeholder="视图名称（可选）"
          value={bmName}
          onChange={(e) => setBmName(e.target.value)}
          onPressEnter={handleSaveBookmark}
        />
        <div style={{ fontSize: 11, color: '#999', marginTop: 6 }}>
          保存: 中心坐标 · 缩放级别 · {layers.filter(l => l.visible).length} 个可见图层
        </div>
      </Modal>
    </Space>
  );
};

export default Toolbar;
