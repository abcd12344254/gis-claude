import React, { useRef, useEffect, useCallback, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import * as turf from '@turf/turf';
import { useGISStore } from '../store/useGISStore';
import type { FeatureCollection, LineString, Point } from 'geojson';
import { measureDistance, measureArea } from '../services/spatialAnalysis';
import { sampleElevationGrid } from '../services/hazardService';

const TERRAIN_DEM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const DEFAULT_TILE_URL = 'https://webrd01.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}';

const MAP_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    'osm-tiles': {
      type: 'raster',
      tiles: [DEFAULT_TILE_URL],
      tileSize: 256,
      attribution: '&copy; 高德地图 AutoNavi',
    },
    'terrain-dem': {
      type: 'raster-dem',
      tiles: [TERRAIN_DEM_URL],
      tileSize: 256,
      encoding: 'terrarium',
      maxzoom: 15,
    },
  },
  layers: [
    {
      id: 'osm-tiles-layer',
      type: 'raster',
      source: 'osm-tiles',
      minzoom: 0,
      maxzoom: 19,
    },
    {
      id: 'hillshade-layer',
      type: 'hillshade',
      source: 'terrain-dem',
      paint: {
        'hillshade-shadow-color': '#334',
        'hillshade-accent-color': '#eed',
        'hillshade-exaggeration': 0.4,
      },
      layout: { visibility: 'none' },
    },
  ],
};

const LAYER_COLORS = [
  '#1677ff', '#52c41a', '#fa8c16', '#f5222d', '#722ed1',
  '#13c2c2', '#eb2f96', '#faad14', '#2f54eb', '#a0d911',
];

const MapView: React.FC = () => {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const drawRef = useRef<maplibregl.Map | null>(null);
  const prevBasemapUrl = useRef<string>(DEFAULT_TILE_URL);
  // 追踪已渲染图层元信息，用于判断是否需要全量重建 vs 仅 toggle visibility
  const renderedLayersMeta = useRef<Map<string, string>>(new Map());

  const {
    mapState,
    setMapState,
    layers,
    drawing,
    activeTool,
    measurementActive,
    setMeasurementActive,
    addLayer,
    terrain3dEnabled,
  } = useGISStore();

  const [measurePoints, setMeasurePoints] = useState<[number, number][]>([]);
  const [drawPoints, setDrawPoints] = useState<[number, number][]>([]);

  // Initialize map
  useEffect(() => {
    if (!mapContainer.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: mapContainer.current,
      style: MAP_STYLE,
      center: mapState.center,
      zoom: mapState.zoom,
      bearing: mapState.bearing,
      pitch: mapState.pitch,
      attributionControl: false,
      preserveDrawingBuffer: true, // 允许导出地图为图片
    });

    map.addControl(new maplibregl.NavigationControl(), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    map.addControl(
      new maplibregl.AttributionControl({ compact: true }),
      'bottom-right'
    );

    map.on('moveend', () => {
      const center = map.getCenter();
      const bounds = map.getBounds();
      setMapState({
        center: [center.lng, center.lat],
        zoom: map.getZoom(),
        bearing: map.getBearing(),
        pitch: map.getPitch(),
        bounds: [
          bounds.getWest(),
          bounds.getSouth(),
          bounds.getEast(),
          bounds.getNorth(),
        ],
      });
    });

    mapRef.current = map;
    drawRef.current = map;

    // 修复：登录后切换布局时容器尺寸可能尚未确定，通过 ResizeObserver 自动调整
    const resizeObserver = new ResizeObserver(() => {
      map.resize();
    });
    resizeObserver.observe(mapContainer.current);
    // 再等一帧确保 flex 布局已稳定
    requestAnimationFrame(() => map.resize());
    // 监听 window resize（MapLibre 默认不监听）
    const handleWindowResize = () => map.resize();
    window.addEventListener('resize', handleWindowResize);

    return () => {
      window.removeEventListener('resize', handleWindowResize);
      resizeObserver.disconnect();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Handle toolbar events
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const handleFlyTo = (e: Event) => {
      const { center, zoom } = (e as CustomEvent).detail;
      map.flyTo({ center, zoom, duration: 1500 });
    };

    const handleZoomIn = () => map.zoomIn();
    const handleZoomOut = () => map.zoomOut();

    const handleZoomToBounds = (e: Event) => {
      const bounds = (e as CustomEvent).detail;
      map.fitBounds(bounds, { padding: 50, duration: 1000 });
    };

    const handleChangeBasemap = (e: Event) => {
      const bm = (e as CustomEvent).detail;
      prevBasemapUrl.current = bm.url;
      useGISStore.getState().setBasemapUrl(bm.url);
      const sourceId = 'osm-tiles';
      const source = map.getSource(sourceId) as maplibregl.RasterTileSource;
      if (source) {
        source.setTiles([bm.url]);
      }
    };

    const handleToggle3DTerrain = (e: Event) => {
      const { enabled } = (e as CustomEvent).detail;
      const source = map.getSource('osm-tiles') as maplibregl.RasterTileSource;

      if (enabled) {
        // 开启 3D：切卫星图 + 显示 hillshade + terrain + 倾斜
        if (source) {
          source.setTiles(['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}']);
        }
        useGISStore.getState().setBasemapUrl('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}');
        if (map.getLayer('hillshade-layer')) {
          map.setLayoutProperty('hillshade-layer', 'visibility', 'visible');
        }
        map.setTerrain({ source: 'terrain-dem', exaggeration: 1.5 });
        map.flyTo({ pitch: 55, duration: 1200 });
        useGISStore.getState().setTerrain3dEnabled(true);
      } else {
        // 关闭 3D：恢复原底图 + 隐藏 hillshade + 移除 terrain + 归平
        if (source) {
          source.setTiles([prevBasemapUrl.current]);
        }
        useGISStore.getState().setBasemapUrl(prevBasemapUrl.current);
        if (map.getLayer('hillshade-layer')) {
          map.setLayoutProperty('hillshade-layer', 'visibility', 'none');
        }
        map.setTerrain(null);
        map.flyTo({ pitch: 0, duration: 800 });
        useGISStore.getState().setTerrain3dEnabled(false);
      }
    };

    const handleAddDirectLayer = (e: Event) => {
      const { id, geojson, color, opacity } = (e as CustomEvent).detail;
      const sourceId = `direct-${id}`;
      const fillId = `direct-fill-${id}`;
      const lineId = `direct-line-${id}`;

      [fillId, lineId].forEach(lid => { if (map.getLayer(lid)) map.removeLayer(lid); });
      if (map.getSource(sourceId)) map.removeSource(sourceId);

      map.addSource(sourceId, { type: 'geojson', data: geojson });

      map.addLayer({
        id: fillId, type: 'fill', source: sourceId,
        filter: ['any', ['==', ['geometry-type'], 'Polygon'], ['==', ['geometry-type'], 'MultiPolygon']],
        paint: { 'fill-color': color || '#ff0000', 'fill-opacity': opacity || 0.35 },
      });
      map.addLayer({
        id: lineId, type: 'line', source: sourceId,
        filter: ['any', ['==', ['geometry-type'], 'LineString'], ['==', ['geometry-type'], 'MultiLineString']],
        paint: { 'line-color': color || '#ff0000', 'line-width': 3 },
      });
    };

    window.addEventListener('fly-to', handleFlyTo);
    window.addEventListener('map-zoom-in', handleZoomIn);
    window.addEventListener('map-zoom-out', handleZoomOut);
    window.addEventListener('zoom-to-bounds', handleZoomToBounds);
    window.addEventListener('change-basemap', handleChangeBasemap);
    window.addEventListener('add-direct-layer', handleAddDirectLayer);
    window.addEventListener('toggle-3d-terrain', handleToggle3DTerrain);

    // 响应 AI 助手的等高线生成请求
    const handleQueryElevationGrid = (e: Event) => {
      const { resolution } = (e as CustomEvent).detail || { resolution: 25 };
      const b = map.getBounds();
      const bbox: [number, number, number, number] = [
        b.getWest(), b.getSouth(), b.getEast(), b.getNorth(),
      ];
      const grid = sampleElevationGrid(map, bbox, resolution || 25);
      if (grid === null) {
        // terrain 未就绪，等待 sourcedata 后重试
        const retry = () => {
          const g = sampleElevationGrid(map, bbox, resolution || 25);
          if (g !== null) {
            window.dispatchEvent(new CustomEvent('elevation-grid-result', { detail: g }));
            map.off('sourcedata', retry);
          }
        };
        map.on('sourcedata', retry);
        // 超时兜底
        setTimeout(() => {
          map.off('sourcedata', retry);
          window.dispatchEvent(new CustomEvent('elevation-grid-result', { detail: [] }));
        }, 8000);
        return;
      }
      window.dispatchEvent(new CustomEvent('elevation-grid-result', { detail: grid }));
    };
    window.addEventListener('query-elevation-grid', handleQueryElevationGrid);

    return () => {
      window.removeEventListener('fly-to', handleFlyTo);
      window.removeEventListener('map-zoom-in', handleZoomIn);
      window.removeEventListener('map-zoom-out', handleZoomOut);
      window.removeEventListener('zoom-to-bounds', handleZoomToBounds);
      window.removeEventListener('change-basemap', handleChangeBasemap);
      window.removeEventListener('add-direct-layer', handleAddDirectLayer);
      window.removeEventListener('toggle-3d-terrain', handleToggle3DTerrain);
      window.removeEventListener('query-elevation-grid', handleQueryElevationGrid);
    };
  }, []);

  // Update layers on map — 智能 diff：仅 visibility 变化时 toggle layout 而非重建 source
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const getMetaKey = (layer: typeof layers[0]): string => {
      if (!layer.data) return '';
      const firstFeature = layer.data.features?.[0];
      const hasExtrusion = firstFeature?.properties?._extrusionHeight != null ? '1' : '0';
      return `${layer.data.features?.length ?? 0}|${layer.color ?? ''}|${layer.opacity ?? 0.7}|${layer.type}|${hasExtrusion}`;
    };

    // Wait for map to be ready
    const updateLayers = () => {
      const prev = renderedLayersMeta.current;
      const currentIds = new Set(layers.map(l => l.id));

      // ——— 第一遍：清理已不存在于 store 中的孤儿 source/layer ———
      for (const [id] of prev) {
        if (!currentIds.has(id)) {
          const sourceId = `source-${id}`;
          ['fill', 'line', 'circle'].forEach(prefix => {
            const lid = `${prefix}-${id}`;
            if (map.getLayer(lid)) map.removeLayer(lid);
          });
          if (map.getSource(sourceId)) map.removeSource(sourceId);
          prev.delete(id);
        }
      }

      // 额外安全清理：遍历 map 上残留的 style layer / source
      const allMapLayerIds = map.getStyle()?.layers?.map((l: any) => l.id) || [];
      for (const lid of allMapLayerIds) {
        if ((lid.startsWith('fill-') || lid.startsWith('line-') || lid.startsWith('circle-')) && !currentIds.has(lid.replace(/^(fill|line|circle)-/, ''))) {
          if (map.getLayer(lid)) map.removeLayer(lid);
        }
      }
      const allMapSourceIds = Object.keys((map as any).style?.sourceCaches || {});
      for (const sid of allMapSourceIds) {
        if (sid.startsWith('source-') && !currentIds.has(sid.replace('source-', ''))) {
          if (map.getSource(sid)) map.removeSource(sid);
        }
      }

      // ——— 第二遍：处理每个图层 ———
      layers.forEach((layer, index) => {
        const sourceId = `source-${layer.id}`;
        const fillLayerId = `fill-${layer.id}`;
        const lineLayerId = `line-${layer.id}`;
        const circleLayerId = `circle-${layer.id}`;

        // 无数据的图层：清理后跳过
        if (!layer.data) {
          if (prev.has(layer.id)) {
            [fillLayerId, lineLayerId, circleLayerId].forEach(id => {
              if (map.getLayer(id)) map.removeLayer(id);
            });
            if (map.getSource(sourceId)) map.removeSource(sourceId);
            prev.delete(layer.id);
          }
          return;
        }

        const newMeta = getMetaKey(layer);
        const oldMeta = prev.get(layer.id);
        const dataChanged = oldMeta !== newMeta;

        // — 仅 visibility 变化：toggle layout 属性，不重建 source —
        if (!dataChanged) {
          const visibility = layer.visible ? 'visible' : 'none';
          [fillLayerId, lineLayerId, circleLayerId].forEach(id => {
            if (map.getLayer(id)) {
              try { map.setLayoutProperty(id, 'visibility', visibility); } catch {}
            }
          });
          return;
        }

        // — 数据变化：完整重建 —
        prev.set(layer.id, newMeta);

        // 先移除旧 layers/sources
        [fillLayerId, lineLayerId, circleLayerId].forEach(id => {
          if (map.getLayer(id)) map.removeLayer(id);
        });
        if (map.getSource(sourceId)) map.removeSource(sourceId);

        if (!layer.visible) return;

        // 添加 source
        map.addSource(sourceId, { type: 'geojson', data: layer.data });

        const color = layer.color || LAYER_COLORS[index % LAYER_COLORS.length];
        const opacity = layer.opacity ?? 0.7;

        // 构建样式 layers
        const addStyleLayers = () => {
          const firstFeature = layer.data?.features?.[0];
          const isHazard = firstFeature?.properties?._hazardType;
          if (layer.type === 'polygon' || layer.type === 'geojson') {
            const isExtrusion = firstFeature?.properties?._extrusionHeight != null;

            if (isExtrusion) {
              map.addLayer({
                id: fillLayerId, type: 'fill-extrusion', source: sourceId,
                filter: ['any', ['==', ['geometry-type'], 'Polygon'], ['==', ['geometry-type'], 'MultiPolygon']],
                paint: {
                  'fill-extrusion-color': ['case',
                    ['has', '_classifyColor'], ['get', '_classifyColor'],
                    ['has', '_districtColor'], ['get', '_districtColor'],
                    color] as any,
                  'fill-extrusion-opacity': opacity,
                  'fill-extrusion-height': ['get', '_extrusionHeight'] as any,
                  'fill-extrusion-base': ['case', ['has', '_baseHeight'], ['get', '_baseHeight'], 0] as any,
                },
              });
            } else {
              map.addLayer({
                id: fillLayerId, type: 'fill', source: sourceId,
                filter: ['any', ['==', ['geometry-type'], 'Polygon'], ['==', ['geometry-type'], 'MultiPolygon']],
                paint: {
                  'fill-color': ['case',
                    ['has', '_classifyColor'], ['get', '_classifyColor'],
                    ['has', '_districtColor'], ['get', '_districtColor'],
                    color] as any,
                  'fill-opacity': opacity,
                  'fill-outline-color': ['case',
                    ['has', '_classifyColor'], ['get', '_classifyColor'],
                    ['has', '_districtColor'], ['get', '_districtColor'],
                    color] as any,
                },
              });
            }
          }
          if (layer.type === 'line' || layer.type === 'geojson') {
            map.addLayer({
              id: lineLayerId, type: 'line', source: sourceId,
              filter: ['any', ['==', ['geometry-type'], 'LineString'], ['==', ['geometry-type'], 'MultiLineString']],
              paint: { 'line-color': color, 'line-width': 2, 'line-opacity': opacity },
            });
          }
          if (layer.type === 'point' || layer.type === 'geojson') {
            map.addLayer({
              id: circleLayerId, type: 'circle', source: sourceId,
              filter: ['any', ['==', ['geometry-type'], 'Point'], ['==', ['geometry-type'], 'MultiPoint']],
              paint: {
                'circle-color': isHazard ? (['get', '_magColor'] as any) : color,
                'circle-radius': isHazard ? (['get', '_radius'] as any) : 6,
                'circle-opacity': opacity,
                'circle-stroke-width': isHazard ? 0 : 2,
                'circle-stroke-color': isHazard ? 'transparent' : '#fff',
              },
            });
          }
          map.on('click', fillLayerId, (e) => {
            if (e.features?.[0]) {
              const f = e.features[0];
              const props = (f.properties || {}) as Record<string, unknown>;

              const EXACT_NOISE = new Set([
                'osm_id', 'osm_type', 'source', 'source:ref', 'created_by',
                'attribution', 'note', 'note:zh', 'fixme', 'FIXME',
                '@id', '@relations', 'changeset', 'timestamp',
                'uid', 'user', 'version',
              ]);

              const shouldShow = (k: string): boolean => {
                if (k.startsWith('_')) return false;
                if (EXACT_NOISE.has(k)) return false;
                if (/^(alt_name|old_name|short_name|loc_name|int_name|nat_name|reg_name|official_name|sorting_name)(:\w+)?$/.test(k)) return false;
                if (/^name:/.test(k) && k !== 'name:zh' && k !== 'name:en') return false;
                if (k === 'name' && props['name:zh']) return false;
                return true;
              };

              const allEntries = Object.entries(props).filter(([k]) => shouldShow(k));

              const PRIORITY_ORDER = [
                'admin_level', 'boundary', 'type', 'place',
                'highway', 'railway', 'waterway', 'natural', 'landuse',
                'building', 'amenity', 'leisure', 'tourism', 'aeroway', 'power',
                'population', 'area', 'length', 'width', 'height', 'ele',
                'name:zh', 'name:en',
                'addr:city', 'addr:district', 'addr:street', 'addr:housenumber',
                'ref', 'website', 'phone', 'opening_hours', 'operator',
                'wikidata', 'wikipedia', 'surface', 'lanes', 'maxspeed',
              ];
              const priorityMap = new Map(PRIORITY_ORDER.map((k, i) => [k, i]));
              allEntries.sort((a, b) => {
                const pa = priorityMap.get(a[0]) ?? 999;
                const pb = priorityMap.get(b[0]) ?? 999;
                return pa - pb || a[0].localeCompare(b[0]);
              });

              const TAG_LABELS: Record<string, string> = {
                'admin_level': '行政级别', 'boundary': '边界类型', 'place': '地点类型',
                'highway': '道路类型', 'railway': '铁路类型', 'waterway': '水系类型',
                'natural': '自然地物', 'landuse': '用地类型', 'building': '建筑类型',
                'amenity': '设施类型', 'leisure': '休闲类型', 'tourism': '旅游类型',
                'aeroway': '航空类型', 'power': '电力类型',
                'population': '人口', 'area': '面积', 'length': '长度',
                'width': '宽度', 'height': '高度', 'ele': '海拔',
                'name:zh': '中文名', 'name:en': '英文名',
                'addr:city': '城市', 'addr:district': '区县', 'addr:street': '街道',
                'addr:housenumber': '门牌号', 'addr:postcode': '邮编',
                'ref': '编号', 'website': '网站', 'phone': '电话',
                'opening_hours': '营业时间', 'operator': '运营方',
                'wikidata': '维基数据', 'wikipedia': '维基百科',
                'surface': '路面', 'lanes': '车道数', 'maxspeed': '限速',
                'wheelchair': '无障碍', 'public_transport': '公共交通',
              };

              const visible = allEntries.slice(0, 24);
              const hidden = allEntries.length - visible.length;
              const copyId = `copy-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

              const rows = visible
                .map(([k, v]) => {
                  const label = TAG_LABELS[k] || k;
                  const val =
                    v === null || v === undefined
                      ? '<span style="color:#999">—</span>'
                      : typeof v === 'number'
                      ? k === 'area' ? `${(v as number).toLocaleString()} m²`
                      : k === 'population' ? (v as number).toLocaleString()
                      : v.toLocaleString()
                      : String(v).length > 100
                      ? String(v).slice(0, 100) + '…'
                      : String(v);
                  return `<tr><td style="padding:2px 8px 2px 0;font-weight:600;white-space:nowrap;vertical-align:top;font-size:11px;color:#555">${label}</td><td style="padding:2px 0;font-size:11px;word-break:break-all">${val}</td></tr>`;
                })
                .join('');

              const moreNote = hidden > 0
                ? `<div style="font-size:10px;color:#999;margin-top:4px;text-align:center">还有 ${hidden} 个字段未显示</div>`
                : '';

              const displayName = props['name:zh'] || props.name || layer.name;

              const html = `
                <div style="min-width:200px;max-width:320px;max-height:340px;overflow-y:auto">
                  <div style="font-weight:700;font-size:13px;margin-bottom:6px;color:#1677ff">
                    📍 ${displayName}
                  </div>
                  <table style="width:100%;border-collapse:collapse">${rows}</table>
                  ${moreNote}
                  <div style="margin-top:8px;text-align:right">
                    <button id="${copyId}" style="font-size:10px;padding:2px 8px;cursor:pointer;border:1px solid #d9d9d9;border-radius:4px;background:#fff">📋 复制全部</button>
                  </div>
                </div>`;

              const popup = new maplibregl.Popup({ maxWidth: '340' }).setLngLat(e.lngLat).setHTML(html);

              popup.on('open', () => {
                setTimeout(() => {
                  const btn = document.getElementById(copyId);
                  if (btn) {
                    btn.onclick = () => {
                      navigator.clipboard.writeText(allEntries.map(([k, v]) => k + ': ' + v).join('\n'));
                    };
                  }
                }, 50);
              });
              popup.addTo(map);
            }
          });
        };

        // 等待 source 就绪后再添加样式层，避免连续添加图层时
        // MapLibre 内部时序错乱导致"图层不显示需手动切换可见性"的问题
        if (map.isSourceLoaded(sourceId)) {
          addStyleLayers();
        } else {
          const onSourceReady = (e: maplibregl.MapSourceDataEvent) => {
            if (e.sourceId === sourceId && e.isSourceLoaded) {
              map.off('sourcedata', onSourceReady);
              addStyleLayers();
            }
          };
          map.on('sourcedata', onSourceReady);
          // 安全兜底：200ms 后如果还没加载就强制添加
          setTimeout(() => {
            map.off('sourcedata', onSourceReady);
            if (!map.getLayer(fillLayerId) && !map.getLayer(lineLayerId)) {
              addStyleLayers();
            }
          }, 200);
        }
      });

      // 强制触发重绘，确保新增/修改的图层立即显示
      map.triggerRepaint();
    };

    if (map.loaded()) {
      // 延迟到下一帧执行，避免在 MapLibre 渲染周期中修改样式导致图层"隐形"
      // （不触发绘制但需点击图层管理才会显示）
      requestAnimationFrame(() => updateLayers());
    } else {
      map.once('load', updateLayers);
    }
  }, [layers]);

  // Handle measurement
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const handleMeasureClick = (e: maplibregl.MapMouseEvent) => {
      if (!measurementActive) return;

      const point: [number, number] = [e.lngLat.lng, e.lngLat.lat];
      const newPoints = [...measurePoints, point];
      setMeasurePoints(newPoints);

      // Remove old measurement layers
      ['measure-line', 'measure-points', 'measure-label'].forEach((id) => {
        if (map.getLayer(id)) map.removeLayer(id);
      });
      ['measure-line', 'measure-points', 'measure-label'].forEach((id) => {
        if (map.getSource(id)) map.removeSource(id);
      });

      if (newPoints.length >= 2) {
        // Draw measurement line
        const result = measureDistance(newPoints);
        const displayValue =
          result.value >= 1
            ? `${result.value.toFixed(2)} km`
            : `${(result.value * 1000).toFixed(0)} m`;

        // For area measurement (>2 points), show both
        if (newPoints.length >= 3) {
          const areaResult = measureArea(newPoints);
          const areaDisplay =
            areaResult.value >= 1_000_000
              ? `${(areaResult.value / 1_000_000).toFixed(2)} km²`
              : `${areaResult.value.toFixed(0)} m²`;

          map.addSource('measure-line', {
            type: 'geojson',
            data: {
              type: 'Feature',
              geometry: {
                type: 'Polygon',
                coordinates: [
                  [
                    ...newPoints,
                    newPoints[0],
                  ],
                ],
              },
              properties: {},
            },
          });

          map.addLayer({
            id: 'measure-line',
            type: 'fill',
            source: 'measure-line',
            paint: {
              'fill-color': '#1677ff',
              'fill-opacity': 0.2,
            },
          });

          // Add outline
          map.addSource('measure-outline', {
            type: 'geojson',
            data: {
              type: 'Feature',
              geometry: {
                type: 'LineString',
                coordinates: [...newPoints, newPoints[0]],
              },
              properties: {},
            },
          });

          map.addLayer({
            id: 'measure-outline',
            type: 'line',
            source: 'measure-outline',
            paint: {
              'line-color': '#1677ff',
              'line-width': 2,
              'line-dasharray': [3, 2],
            },
          });

          // Label
          const center = newPoints.reduce(
            (acc, p) => [acc[0] + p[0], acc[1] + p[1]],
            [0, 0]
          );
          center[0] /= newPoints.length;
          center[1] /= newPoints.length;

          new maplibregl.Popup({ closeButton: false, className: 'measurement-label' })
            .setLngLat([center[0], center[1]])
            .setHTML(`距离: ${displayValue}<br/>面积: ${areaDisplay}`)
            .addTo(map);

        } else {
          // Just distance line
          map.addSource('measure-line', {
            type: 'geojson',
            data: {
              type: 'Feature',
              geometry: { type: 'LineString', coordinates: newPoints },
              properties: {},
            },
          });

          map.addLayer({
            id: 'measure-line',
            type: 'line',
            source: 'measure-line',
            paint: {
              'line-color': '#1677ff',
              'line-width': 3,
              'line-dasharray': [4, 2],
            },
          });

          const mid = newPoints[newPoints.length - 1];
          new maplibregl.Popup({ closeButton: false, className: 'measurement-label' })
            .setLngLat(mid)
            .setHTML(displayValue)
            .addTo(map);
        }
      }

      // Draw points
      map.addSource('measure-points', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: newPoints.map((p) => ({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: p },
            properties: {},
          })),
        },
      });

      map.addLayer({
        id: 'measure-points',
        type: 'circle',
        source: 'measure-points',
        paint: {
          'circle-radius': 5,
          'circle-color': '#1677ff',
          'circle-stroke-width': 2,
          'circle-stroke-color': '#fff',
        },
      });
    };

    const handleMeasureDblClick = () => {
      if (measurementActive) {
        setMeasurementActive(false);
        setMeasurePoints([]);
      }
    };

    if (measurementActive) {
      map.getCanvas().style.cursor = 'crosshair';
      map.on('click', handleMeasureClick);
      map.on('dblclick', handleMeasureDblClick);
    } else {
      map.getCanvas().style.cursor = '';
      map.off('click', handleMeasureClick);
      map.off('dblclick', handleMeasureDblClick);

      // Clean up measurement layers
      ['measure-line', 'measure-points', 'measure-label', 'measure-outline'].forEach((id) => {
        if (map.getLayer(id)) map.removeLayer(id);
        if (map.getSource(id)) map.removeSource(id);
      });
    }

    return () => {
      map.off('click', handleMeasureClick);
      map.off('dblclick', handleMeasureDblClick);
    };
  }, [measurementActive, measurePoints, setMeasurementActive]);

  // Handle drawing
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const handleDrawClick = (e: maplibregl.MapMouseEvent) => {
      if (!drawing.active || !drawing.type) return;

      const point: [number, number] = [e.lngLat.lng, e.lngLat.lat];
      const newPoints = [...drawPoints, point];
      setDrawPoints(newPoints);
    };

    const handleDrawDblClick = () => {
      if (!drawing.active || !drawing.type) return;

      if (drawPoints.length >= 2) {
        let geojson: FeatureCollection;

        if (drawing.type === 'Point') {
          geojson = {
            type: 'FeatureCollection',
            features: drawPoints.map((p) => ({
              type: 'Feature',
              geometry: { type: 'Point', coordinates: p },
              properties: {},
            })),
          };
        } else if (drawing.type === 'LineString') {
          geojson = {
            type: 'FeatureCollection',
            features: [
              {
                type: 'Feature',
                geometry: { type: 'LineString', coordinates: drawPoints },
                properties: {},
              },
            ],
          };
        } else {
          geojson = {
            type: 'FeatureCollection',
            features: [
              {
                type: 'Feature',
                geometry: { type: 'Polygon', coordinates: [[...drawPoints, drawPoints[0]]] },
                properties: {},
              },
            ],
          };
        }

        addLayer({
          id: '',
          name: `绘制_${drawing.type}_${new Date().toLocaleTimeString()}`,
          type:
            drawing.type === 'Point'
              ? 'point'
              : drawing.type === 'LineString'
              ? 'line'
              : 'polygon',
          visible: true,
          color: LAYER_COLORS[Math.floor(Math.random() * LAYER_COLORS.length)],
          opacity: 0.7,
          data: geojson,
          sourceId: '',
          layerId: '',
          createdAt: Date.now(),
        });
      }

      // Reset
      useGISStore.getState().setDrawing({ active: false, type: null });
      setDrawPoints([]);

      // Clean up draw layers
      ['draw-preview-line', 'draw-preview-points'].forEach((id) => {
        if (map.getLayer(id)) map.removeLayer(id);
        if (map.getSource(id)) map.removeSource(id);
      });
    };

    if (drawing.active) {
      map.getCanvas().style.cursor = 'crosshair';
      map.on('click', handleDrawClick);
      map.on('dblclick', handleDrawDblClick);

      // Update preview
      if (drawPoints.length >= 2) {
        ['draw-preview-line', 'draw-preview-points'].forEach((id) => {
          if (map.getLayer(id)) map.removeLayer(id);
          if (map.getSource(id)) map.removeSource(id);
        });

        map.addSource('draw-preview-line', {
          type: 'geojson',
          data: {
            type: 'Feature',
            geometry: {
              type: 'LineString',
              coordinates: drawPoints,
            },
            properties: {},
          },
        });

        map.addLayer({
          id: 'draw-preview-line',
          type: 'line',
          source: 'draw-preview-line',
          paint: {
            'line-color': '#ff4d4f',
            'line-width': 2,
            'line-dasharray': [4, 3],
          },
        });

        map.addSource('draw-preview-points', {
          type: 'geojson',
          data: {
            type: 'FeatureCollection',
            features: drawPoints.map((p) => ({
              type: 'Feature',
              geometry: { type: 'Point', coordinates: p },
              properties: {},
            })),
          },
        });

        map.addLayer({
          id: 'draw-preview-points',
          type: 'circle',
          source: 'draw-preview-points',
          paint: {
            'circle-radius': 5,
            'circle-color': '#ff4d4f',
            'circle-stroke-width': 2,
            'circle-stroke-color': '#fff',
          },
        });
      }
    } else {
      map.getCanvas().style.cursor = '';
      map.off('click', handleDrawClick);
      map.off('dblclick', handleDrawDblClick);
    }

    return () => {
      map.off('click', handleDrawClick);
      map.off('dblclick', handleDrawDblClick);
    };
  }, [drawing.active, drawing.type, drawPoints, addLayer]);

  // ====== 路线动画 ======
  const animMarkerRef = useRef<maplibregl.Marker | null>(null);
  const animFrameRef = useRef<number>(0);
  const [routeAnimating, setRouteAnimating] = useState(false);
  const [routeAnimLabel, setRouteAnimLabel] = useState('');
  const [speedLevel, setSpeedLevel] = useState(4); // 1-7 档，默认4=2×
  const speedRef = useRef(4);
  const routeAnimDataRef = useRef<{
    coords: [number, number][];
    mode: string;
    totalLen: number;
    startTime: number;
    baseTraveled: number;
    map: maplibregl.Map;
  } | null>(null);

  const SPEED_MULTIPLIERS = [0.3, 0.6, 1, 2, 4, 8, 16]; // 对应 1-7 档

  // 出行方式对应图标
  const MODE_ICONS: Record<string, string> = {
    walking: '🚶',
    cycling: '🚴',
    driving: '🚗',
    flying: '✈️',
  };

  const MODE_SPEEDS: Record<string, number> = {
    walking: 80,
    cycling: 180,
    driving: 500,
    flying: 3000,
  };

  const camBtnS: React.CSSProperties = {
    width: 30, height: 28, background: 'transparent', color: '#fff',
    border: 'none', cursor: 'pointer', fontSize: 14,
    textAlign: 'center', borderRadius: 4, lineHeight: '28px',
  };

  // 检测路线图层并推断出行方式
  const detectRouteLayer = useCallback(() => {
    const routeLayer = layers.find(l =>
      l.visible && l.data && (l.name.includes('→') || l.name.includes('路线'))
    );
    if (!routeLayer || !routeLayer.data) return null;
    const lineFeat = routeLayer.data!.features.find(
      f => f.geometry?.type === 'LineString'
    );
    if (!lineFeat) return null;
    const coords = (lineFeat.geometry as LineString).coordinates as [number, number][];
    if (coords.length < 2) return null;

    // 推断出行方式
    let mode = 'driving';
    const name = routeLayer.name.toLowerCase();
    const color = (routeLayer.color || '').toLowerCase();
    if (name.includes('飞行') || name.includes('fly') || color === '#e040fb') mode = 'flying';
    else if (name.includes('步行') || name.includes('walk') || color === '#52c41a') mode = 'walking';
    else if (name.includes('骑行') || name.includes('自行车') || name.includes('cycling') || color === '#fa8c16') mode = 'cycling';

    return { coords, mode, name: routeLayer.name };
  }, [layers]);

  // 启动动画
  const startRouteAnim = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;

    const route = detectRouteLayer();
    if (!route) return;

    const icon = MODE_ICONS[route.mode] || '🚗';
    setRouteAnimLabel(`${icon} ${route.name}`);

    // 飞行模式：自动开启 3D 地形 + 倾斜视角
    if (route.mode === 'flying') {
      const source = map.getSource('osm-tiles') as maplibregl.RasterTileSource;
      if (source) {
        source.setTiles(['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}']);
      }
      if (map.getLayer('hillshade-layer')) {
        map.setLayoutProperty('hillshade-layer', 'visibility', 'visible');
      }
      try { map.setTerrain({ source: 'terrain-dem', exaggeration: 1.5 }); } catch {}
      map.flyTo({ pitch: 60, duration: 1500 });
      useGISStore.getState().setTerrain3dEnabled(true);
    }

    // 清理旧动画
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    if (animMarkerRef.current) animMarkerRef.current.remove();

    // 创建动画标记
    const el = document.createElement('div');
    el.style.cssText = `
      font-size: 28px;
      filter: drop-shadow(0 2px 4px rgba(0,0,0,0.4));
      transform: translate(-50%, -100%);
      transition: none;
      pointer-events: none;
      z-index: 999;
    `;
    el.textContent = icon;

    const marker = new maplibregl.Marker({ element: el, anchor: 'bottom' })
      .setLngLat(route.coords[0])
      .addTo(map);
    animMarkerRef.current = marker;

    const totalLen = turf.length(turf.lineString(route.coords), { units: 'meters' });
    const speed = MODE_SPEEDS[route.mode] || 80;

    const startTime = performance.now();

    routeAnimDataRef.current = {
      coords: route.coords,
      mode: route.mode,
      totalLen,
      startTime,
      baseTraveled: 0,
      map,
    };

    setRouteAnimating(true);
    setSpeedLevel(4); // 默认 2×
    speedRef.current = 4;

    const animate = (now: number) => {
      const data = routeAnimDataRef.current;
      if (!data) return;

      const elapsed = (now - data.startTime) / 1000;
      const mult = SPEED_MULTIPLIERS[speedRef.current - 1] || 1;
      const traveled = Math.min(elapsed * speed * mult, data.totalLen * 1.02);

      const line = turf.lineString(data.coords);
      const dist = Math.min(traveled / 1000, data.totalLen / 1000);
      try {
        const pt = turf.along(line, dist, { units: 'kilometers' });
        const lngLat: [number, number] = [
          (pt.geometry as Point).coordinates[0],
          (pt.geometry as Point).coordinates[1],
        ];
        marker.setLngLat(lngLat);
        map.easeTo({ center: lngLat, duration: 300 });
      } catch { /* 超出路径 */ }

      if (traveled >= data.totalLen) {
        setRouteAnimating(false);
        routeAnimDataRef.current = null;
        return;
      }

      animFrameRef.current = requestAnimationFrame(animate);
    };

    animFrameRef.current = requestAnimationFrame(animate);
  }, [detectRouteLayer]);

  // 调整速度：重设 startTime 使当前位置不变
  const changeSpeed = useCallback((delta: number) => {
    const newLevel = Math.max(1, Math.min(7, speedRef.current + delta));
    const oldMult = SPEED_MULTIPLIERS[speedRef.current - 1] || 1;
    const newMult = SPEED_MULTIPLIERS[newLevel - 1] || 1;
    speedRef.current = newLevel;
    setSpeedLevel(newLevel);
    const data = routeAnimDataRef.current;
    if (data) {
      const now = performance.now();
      const elapsed = (now - data.startTime) / 1000;
      const traveled = elapsed * (MODE_SPEEDS[data.mode] || 80) * oldMult;
      // 反推新的 startTime，保持已走过的距离不变
      data.startTime = now - (traveled / ((MODE_SPEEDS[data.mode] || 80) * newMult)) * 1000;
    }
  }, []);

  // 停止动画
  const stopRouteAnim = useCallback(() => {
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    if (animMarkerRef.current) {
      animMarkerRef.current.remove();
      animMarkerRef.current = null;
    }
    routeAnimDataRef.current = null;
    setRouteAnimating(false);
    setRouteAnimLabel('');
  }, []);

  // 路线图层变化时自动检测
  const routeLayer = layers.find(l => l.visible && l.data && l.name.includes('→'));
  const hasRoute = !!routeLayer;

  // 飞行路线图层出现时自动开启 3D 地形
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const isFlyingRoute = layers.some(l =>
      l.visible && l.data && l.name.includes('→') && l.color === '#e040fb'
    );
    if (isFlyingRoute) {
      const source = map.getSource('osm-tiles') as maplibregl.RasterTileSource;
      if (source) {
        source.setTiles(['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}']);
      }
      if (map.getLayer('hillshade-layer')) {
        map.setLayoutProperty('hillshade-layer', 'visibility', 'visible');
      }
      try { map.setTerrain({ source: 'terrain-dem', exaggeration: 1.5 }); } catch {}
      map.flyTo({ pitch: 60, duration: 1500 });
      useGISStore.getState().setTerrain3dEnabled(true);
    }
  }, [layers]);

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <div
        ref={mapContainer}
        style={{
          width: '100%',
          height: '100%',
          cursor: drawing.active || measurementActive ? 'crosshair' : undefined,
        }}
      />

      {/* ====== 路线动画控制条 ====== */}
      {hasRoute && (
        <div style={{
          position: 'absolute', bottom: 20, left: '50%', transform: 'translateX(-50%)',
          background: 'rgba(0,0,0,0.8)', backdropFilter: 'blur(8px)',
          borderRadius: 20, padding: '7px 18px',
          display: 'flex', alignItems: 'center', gap: 12,
          border: '1px solid rgba(255,255,255,0.15)',
          boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
          zIndex: 900,
          fontFamily: '-apple-system,BlinkMacSystemFont,sans-serif',
        }}>
          {!routeAnimating ? (
            <>
              <span style={{ color: '#fff', fontSize: 13, fontWeight: 600 }}>
                🧭 路线已生成
              </span>
              <button
                onClick={startRouteAnim}
                style={{
                  background: 'linear-gradient(135deg, #1677ff, #0958d9)',
                  color: '#fff', border: 'none', borderRadius: 14,
                  padding: '5px 16px', cursor: 'pointer',
                  fontSize: 13, fontWeight: 600,
                  boxShadow: '0 2px 8px rgba(22,119,255,0.4)',
                }}
              >
                ▶ 播放动画
              </button>
            </>
          ) : (
            <>
              <span style={{ color: '#00e676', fontSize: 13, marginRight: 4 }}>{routeAnimLabel}</span>
              <button onClick={() => changeSpeed(-1)}
                disabled={speedLevel <= 1}
                style={{
                  background: speedLevel <= 1 ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.12)',
                  color: speedLevel <= 1 ? '#666' : '#fff',
                  border: 'none', borderRadius: 10, width: 26, height: 26,
                  cursor: speedLevel <= 1 ? 'default' : 'pointer',
                  fontSize: 14, fontWeight: 700, lineHeight: '26px', textAlign: 'center',
                }}
              >−</button>
              <span style={{ color: '#ffab00', fontSize: 12, fontWeight: 700, minWidth: 32, textAlign: 'center' }}>
                {speedLevel === 4 ? '2×' : speedLevel === 5 ? '4×' : speedLevel === 6 ? '8×' : speedLevel === 7 ? '16×' : speedLevel === 3 ? '1×' : speedLevel === 2 ? '0.6×' : '0.3×'}
              </span>
              <button onClick={() => changeSpeed(1)}
                disabled={speedLevel >= 7}
                style={{
                  background: speedLevel >= 7 ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.12)',
                  color: speedLevel >= 7 ? '#666' : '#fff',
                  border: 'none', borderRadius: 10, width: 26, height: 26,
                  cursor: speedLevel >= 7 ? 'default' : 'pointer',
                  fontSize: 14, fontWeight: 700, lineHeight: '26px', textAlign: 'center',
                }}
              >+</button>
              <button
                onClick={stopRouteAnim}
                style={{
                  background: 'rgba(255,255,255,0.15)',
                  color: '#fff', border: '1px solid rgba(255,255,255,0.25)',
                  borderRadius: 14, padding: '4px 12px', cursor: 'pointer',
                  fontSize: 12, fontWeight: 600,
                }}
              >
                ⏹
              </button>
            </>
          )}
        </div>
      )}

      {/* ====== 3D 视角控制 ====== */}
      {terrain3dEnabled && (
        <div style={{
          position: 'absolute', right: 12, top: 100,
          display: 'flex', flexDirection: 'column', gap: 4,
          background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(6px)',
          borderRadius: 8, padding: 6,
          border: '1px solid rgba(255,255,255,0.12)',
          boxShadow: '0 2px 12px rgba(0,0,0,0.3)',
          zIndex: 800,
        }}>
          <button onClick={() => {
            const m = mapRef.current;
            if (m) m.easeTo({ pitch: Math.min(80, (m.getPitch() || 0) + 15), duration: 400 });
          }} title="俯角+" style={camBtnS}>🔽</button>
          <button onClick={() => {
            const m = mapRef.current;
            if (m) m.easeTo({ pitch: Math.max(0, (m.getPitch() || 0) - 15), duration: 400 });
          }} title="俯角−" style={camBtnS}>🔼</button>
          <button onClick={() => {
            const m = mapRef.current;
            if (m) m.easeTo({ bearing: ((m.getBearing() || 0) - 30 + 360) % 360, duration: 400 });
          }} title="左转" style={camBtnS}>↺</button>
          <button onClick={() => {
            const m = mapRef.current;
            if (m) m.easeTo({ bearing: ((m.getBearing() || 0) + 30) % 360, duration: 400 });
          }} title="右转" style={camBtnS}>↻</button>
          <button onClick={() => {
            const m = mapRef.current;
            if (m) m.easeTo({ pitch: 0, bearing: 0, duration: 600 });
          }} title="重置视角" style={{ ...camBtnS, borderTop: '1px solid rgba(255,255,255,0.12)', marginTop: 2, paddingTop: 6 }}>🏠</button>
        </div>
      )}
    </div>
  );
};

export default MapView;
