import React from 'react';
import { Button, Space, Tooltip, message } from 'antd';
import {
  AimOutlined,
  LineOutlined,
  BorderOutlined,
  HighlightOutlined,
} from '@ant-design/icons';
import { useGISStore } from '../store/useGISStore';

const DrawingTools: React.FC = () => {
  const { drawing, setDrawing, setActiveTool } = useGISStore();

  const handleActivateDrawing = (type: 'Point' | 'LineString' | 'Polygon') => {
    if (drawing.active && drawing.type === type) {
      // Deactivate
      setDrawing({ active: false, type: null });
      setActiveTool(null);
      message.info('绘图已取消');
    } else {
      setDrawing({ active: true, type });
      setActiveTool(`draw-${type}`);
      const typeName =
        type === 'Point' ? '点' : type === 'LineString' ? '折线' : '多边形';
      message.info(`开始绘制${typeName}，单击添加节点，双击完成`);
    }
  };

  return (
    <Space size="small">
      <Tooltip title="绘制点">
        <Button
          size="small"
          icon={<AimOutlined />}
          type={drawing.active && drawing.type === 'Point' ? 'primary' : 'default'}
          onClick={() => handleActivateDrawing('Point')}
        />
      </Tooltip>

      <Tooltip title="绘制折线">
        <Button
          size="small"
          icon={<LineOutlined />}
          type={drawing.active && drawing.type === 'LineString' ? 'primary' : 'default'}
          onClick={() => handleActivateDrawing('LineString')}
        />
      </Tooltip>

      <Tooltip title="绘制多边形">
        <Button
          size="small"
          icon={<BorderOutlined />}
          type={drawing.active && drawing.type === 'Polygon' ? 'primary' : 'default'}
          onClick={() => handleActivateDrawing('Polygon')}
        />
      </Tooltip>
    </Space>
  );
};

export default DrawingTools;
