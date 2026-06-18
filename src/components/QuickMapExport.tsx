/**
 * 一键成图 —— 快速导出专业地图
 * 自动生成标题、图例、比例尺、指北针，导出高清 PNG
 */
import React, { useState, useCallback, useMemo } from 'react';
import {
  Button, Input, Switch, Typography,
  Space, message, Tag, Slider, Tooltip,
} from 'antd';
import {
  DownloadOutlined, ThunderboltOutlined,
} from '@ant-design/icons';
import { useGISStore } from '../store/useGISStore';

const { Text } = Typography;

// ====== 预设配色方案 ======

const COLOR_SCHEMES: Record<string, { bg: string; title: string; border: string; name: string }> = {
  light:  { bg: '#ffffff', title: '#1a1a1a', border: '#d9d9d9', name: '简洁白' },
  cream:  { bg: '#fefdf7', title: '#3d3929', border: '#d4c9a8', name: '典雅米' },
  dark:   { bg: '#2c2c2c', title: '#f0f0f0', border: '#555555', name: '暗夜黑' },
  forest: { bg: '#f5f9f4', title: '#1a3a1a', border: '#8bab8b', name: '森林绿' },
  ocean:  { bg: '#f4f7fb', title: '#1a2a4a', border: '#8b9bb8', name: '海洋蓝' },
};

// ====== 指北针 SVG ======

function drawNorthArrow(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, size: number,
  rotation: number
) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate((rotation * Math.PI) / 180);

  // Shadow
  ctx.shadowColor = 'rgba(0,0,0,0.15)';
  ctx.shadowBlur = 4;
  ctx.shadowOffsetX = 2;
  ctx.shadowOffsetY = 2;

  // Top half (red / 北)
  ctx.fillStyle = '#e03131';
  ctx.beginPath();
  ctx.moveTo(0, -size);
  ctx.lineTo(-size * 0.5, 0);
  ctx.lineTo(0, -size * 0.15);
  ctx.fill();

  // Bottom half (dark / 南)
  ctx.fillStyle = '#333333';
  ctx.beginPath();
  ctx.moveTo(0, -size * 0.15);
  ctx.lineTo(size * 0.5, 0);
  ctx.lineTo(0, size * 0.7);
  ctx.fill();

  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;

  // N label
  ctx.fillStyle = '#e03131';
  ctx.font = `bold ${size * 0.35}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText('N', 0, -size - size * 0.25);

  ctx.restore();
}

// ====== 比例尺 ======

function drawScaleBar(
  ctx: CanvasRenderingContext2D,
  x: number, y: number,
  metersPerPixel: number,
  maxWidth: number
) {
  // Choose a nice round number for the scale bar
  const targetMeters = metersPerPixel * maxWidth;
  const niceScale = niceRound(targetMeters);
  const barWidth = niceScale / metersPerPixel;
  const barHeight = 8;

  const formatDistance = (m: number) => {
    if (m >= 1000) return `${(m / 1000).toFixed(1)} km`;
    return `${Math.round(m)} m`;
  };

  // Bar
  ctx.fillStyle = '#333';
  ctx.fillRect(x, y, barWidth, barHeight);
  // Alternating blocks
  ctx.fillStyle = '#fff';
  ctx.fillRect(x + barWidth * 0.5, y, barWidth * 0.25, barHeight);
  ctx.fillRect(x + barWidth * 0.75, y, barWidth * 0.25, barHeight);

  // Label
  ctx.fillStyle = '#333';
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(formatDistance(niceScale), x + barWidth / 2, y - 6);
}

/** Pick a "nice" round number for the scale bar */
function niceRound(meters: number): number {
  const powers = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000];
  const target = meters * 0.6; // want bar to be ~60% of max width
  for (const p of powers) {
    if (p >= target) return p;
  }
  return powers[powers.length - 1];
}

// ====== Component ======

const QuickMapExport: React.FC = () => {
  const { layers, mapState } = useGISStore();

  const [titleText, setTitleText] = useState('');
  const [subtitle, setSubtitle] = useState('');
  const [showLegend, setShowLegend] = useState(true);
  const [showScaleBar, setShowScaleBar] = useState(true);
  const [showNorthArrow, setShowNorthArrow] = useState(true);
  const [colorScheme, setColorScheme] = useState('light');
  const [resolution, setResolution] = useState(2); // 2x
  const [exporting, setExporting] = useState(false);

  const visibleLayers = useMemo(
    () => layers.filter((l) => l.visible),
    [layers]
  );

  const scheme = COLOR_SCHEMES[colorScheme] || COLOR_SCHEMES.light;

  // 计算每像素对应的米数（用于比例尺）
  const metersPerPixel = useMemo(() => {
    const lat = mapState.center[1];
    const zoom = mapState.zoom;
    return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom);
  }, [mapState.center, mapState.zoom]);

  const handleExport = useCallback(async () => {
    setExporting(true);
    try {
      // 1. 获取地图画布
      const mapCanvas = document.querySelector('.maplibregl-canvas') as HTMLCanvasElement;
      if (!mapCanvas) {
        message.error('未找到地图画布，请先加载地图');
        setExporting(false);
        return;
      }

      const mapW = mapCanvas.width;
      const mapH = mapCanvas.height;
      const scale = resolution;

      // 2. 布局计算
      const marginTop = 80;     // 标题区
      const marginBottom = 60;  // 比例尺 + 图例区
      const marginLeft = 40;
      const marginRight = 40;
      const titleAreaHeight = titleText ? marginTop : 20;

      const canvasW = (mapW + marginLeft + marginRight) * scale;
      const canvasH = (mapH + titleAreaHeight + marginBottom) * scale;

      const offscreen = document.createElement('canvas');
      offscreen.width = canvasW;
      offscreen.height = canvasH;
      const ctx = offscreen.getContext('2d')!;

      // 3. 背景
      ctx.fillStyle = scheme.bg;
      ctx.fillRect(0, 0, canvasW, canvasH);

      // 4. 边框
      const borderPadding = 8 * scale;
      ctx.strokeStyle = scheme.border;
      ctx.lineWidth = 2 * scale;
      ctx.strokeRect(borderPadding, borderPadding, canvasW - 2 * borderPadding, canvasH - 2 * borderPadding);

      // 5. 绘制地图
      const mapX = marginLeft * scale;
      const mapY = titleAreaHeight * scale;
      const mapDrawW = mapW * scale;
      const mapDrawH = mapH * scale;

      // 地图边框
      ctx.strokeStyle = '#999';
      ctx.lineWidth = 1 * scale;
      ctx.strokeRect(mapX - 1, mapY - 1, mapDrawW + 2, mapDrawH + 2);

      ctx.drawImage(mapCanvas, mapX, mapY, mapDrawW, mapDrawH);

      // 6. 标题
      if (titleText) {
        ctx.fillStyle = scheme.title;
        ctx.font = `bold ${20 * scale}px "Microsoft YaHei", sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText(titleText, canvasW / 2, (marginTop * 0.45) * scale);

        if (subtitle) {
          ctx.fillStyle = '#888';
          ctx.font = `${12 * scale}px "Microsoft YaHei", sans-serif`;
          ctx.fillText(subtitle, canvasW / 2, (marginTop * 0.45 + 22) * scale);
        }
      }

      // 7. 指北针
      if (showNorthArrow) {
        const arrowSize = Math.min(mapW, mapH) * 0.06 * scale;
        const arrowX = mapX + mapDrawW - arrowSize * 2 - 10 * scale;
        const arrowY = mapY + arrowSize * 2 + 10 * scale;
        drawNorthArrow(ctx, arrowX, arrowY, arrowSize, -mapState.bearing);
      }

      // 8. 比例尺
      if (showScaleBar) {
        const scaleY = mapY + mapDrawH + 30 * scale;
        const scaleMaxW = mapDrawW * 0.35;
        drawScaleBar(ctx, mapX, scaleY, metersPerPixel / scale, scaleMaxW);
      }

      // 9. 图例
      if (showLegend && visibleLayers.length > 0) {
        const legendX = mapX + mapDrawW - 180 * scale;
        const legendY = mapY + mapDrawH - (visibleLayers.length * 28 + 30) * scale;

        // 图例背景
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.strokeStyle = '#d9d9d9';
        ctx.lineWidth = 1 * scale;
        const legendW = 170 * scale;
        const legendH = (visibleLayers.length * 28 + 20) * scale;
        ctx.beginPath();
        ctx.roundRect(legendX, legendY, legendW, legendH, 6 * scale);
        ctx.fill();
        ctx.stroke();

        // 图例标题
        ctx.fillStyle = '#333';
        ctx.font = `bold ${11 * scale}px sans-serif`;
        ctx.textAlign = 'left';
        ctx.fillText('图例', legendX + 12 * scale, legendY + 18 * scale);

        // 图例项
        visibleLayers.forEach((layer, i) => {
          const iy = legendY + (i * 28 + 36) * scale;
          // Color swatch
          ctx.fillStyle = layer.color || '#1677ff';
          ctx.fillRect(legendX + 12 * scale, iy - 8 * scale, 16 * scale, 12 * scale);
          ctx.strokeStyle = '#ccc';
          ctx.lineWidth = 0.5 * scale;
          ctx.strokeRect(legendX + 12 * scale, iy - 8 * scale, 16 * scale, 12 * scale);
          // Name
          ctx.fillStyle = '#333';
          ctx.font = `${10 * scale}px sans-serif`;
          const name = layer.name.length > 14 ? layer.name.slice(0, 13) + '...' : layer.name;
          ctx.fillText(name, legendX + 36 * scale, iy);
        });
      }

      // 10. 导出
      offscreen.toBlob((blob) => {
        if (!blob) {
          message.error('导出失败');
          setExporting(false);
          return;
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const filename = titleText
          ? `${titleText.replace(/[\\/:*?"<>|]/g, '')}.png`
          : `GIS地图_${new Date().toLocaleDateString()}.png`;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        message.success(`✅ 地图已导出: ${filename} (${canvasW}×${canvasH}px)`);
        setExporting(false);
      }, 'image/png');
    } catch (err) {
      message.error(`导出失败: ${err instanceof Error ? err.message : '未知错误'}`);
      setExporting(false);
    }
  }, [titleText, subtitle, showLegend, showScaleBar, showNorthArrow, colorScheme, resolution, visibleLayers, mapState, metersPerPixel, scheme]);

  return (
    <div style={{
      borderTop: '2px solid #fa8c16',
      background: '#fff',
      padding: '12px 16px',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <Space size="small">
          <ThunderboltOutlined style={{ color: '#fa8c16', fontSize: 16 }} />
          <Text strong style={{ fontSize: 14, color: '#333' }}>一键成图</Text>
          <Tag color="orange" style={{ fontSize: 10, lineHeight: '16px' }}>NEW</Tag>
        </Space>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {/* 标题 */}
        <Input
          size="small"
          placeholder="地图标题，如：邯郸市区县分布图"
          value={titleText}
          onChange={(e) => setTitleText(e.target.value)}
        />
        <Input
          size="small"
          placeholder="副标题（可选）"
          value={subtitle}
          onChange={(e) => setSubtitle(e.target.value)}
        />

        {/* 装饰元素开关 */}
        <div style={{ display: 'flex', gap: 12 }}>
          <Space size="small">
            <Switch size="small" checked={showLegend} onChange={setShowLegend} />
            <Text style={{ fontSize: 11 }}>图例</Text>
          </Space>
          <Space size="small">
            <Switch size="small" checked={showScaleBar} onChange={setShowScaleBar} />
            <Text style={{ fontSize: 11 }}>比例尺</Text>
          </Space>
          <Space size="small">
            <Switch size="small" checked={showNorthArrow} onChange={setShowNorthArrow} />
            <Text style={{ fontSize: 11 }}>指北针</Text>
          </Space>
        </div>

        {/* 配色 + 分辨率 一行 */}
        <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
          <div>
            <Text style={{ fontSize: 10, color: '#999' }}>配色</Text>
            <div style={{ display: 'flex', gap: 4, marginTop: 2 }}>
              {Object.entries(COLOR_SCHEMES).map(([key, s]) => (
                <Tooltip key={key} title={s.name}>
                  <div
                    onClick={() => setColorScheme(key)}
                    style={{
                      width: 22, height: 22, borderRadius: '50%',
                      background: s.bg,
                      border: `2px solid ${key === colorScheme ? '#1677ff' : s.border}`,
                      cursor: 'pointer',
                      boxShadow: key === colorScheme ? '0 0 0 2px rgba(22,119,255,0.3)' : 'none',
                    }}
                  />
                </Tooltip>
              ))}
            </div>
          </div>
          <div style={{ flex: 1 }}>
            <Text style={{ fontSize: 10, color: '#999' }}>分辨率: {resolution}x</Text>
            <Slider
              min={1} max={4} step={1}
              value={resolution}
              onChange={setResolution}
              style={{ margin: 0 }}
            />
          </div>
        </div>

        {/* 导出按钮 */}
        <Button
          type="primary"
          icon={exporting ? undefined : <DownloadOutlined />}
          loading={exporting}
          onClick={handleExport}
          block
          style={{
            height: 40,
            background: 'linear-gradient(135deg, #fa8c16, #fa541c)',
            border: 'none',
            fontWeight: 700,
            fontSize: 14,
          }}
        >
          {exporting ? '正在生成...' : '⚡ 一键生成地图'}
        </Button>
      </div>
    </div>
  );
};

export default QuickMapExport;
