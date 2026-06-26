import React, { useState, useEffect, useCallback } from 'react';
import { Button, Modal, Input, List, message, Popconfirm, Space, Typography, Tag } from 'antd';
import {
  SaveOutlined,
  FolderOpenOutlined,
  PlusOutlined,
  DeleteOutlined,
} from '@ant-design/icons';
import { useGISStore } from '../store/useGISStore';
import { API_BASE } from '../utils/api';

const { Text } = Typography;

interface ProjectList {
  id: number;
  name: string;
  map_state: string;
  updated_at: string;
}

const ProjectManager: React.FC = () => {
  const { authToken, user, layers, mapState, chatMessages, setLayers, addLayer, addChatMessage, setMapState } = useGISStore();
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [loadModalOpen, setLoadModalOpen] = useState(false);
  const [projectName, setProjectName] = useState('');
  const [projects, setProjects] = useState<ProjectList[]>([]);
  const [loading, setLoading] = useState(false);

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${authToken}`,
  };

  const fetchProjects = useCallback(async () => {
    if (!authToken) return;
    try {
      const res = await fetch(`${API_BASE}/api/projects`, { headers });
      if (res.ok) setProjects(await res.json());
    } catch {}
  }, [authToken]);

  useEffect(() => {
    if (loadModalOpen) fetchProjects();
  }, [loadModalOpen, fetchProjects]);

  const handleSave = async () => {
    if (!projectName.trim()) return;
    setLoading(true);
    try {
      // Create project
      const res = await fetch(`${API_BASE}/api/projects`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: projectName.trim(),
          map_state: { center: mapState.center, zoom: mapState.zoom, bearing: mapState.bearing, pitch: mapState.pitch },
        }),
      });
      if (!res.ok) throw new Error('保存失败');
      const proj = await res.json();

      // Save layers
      const layersData = layers.map(l => ({
        name: l.name,
        type: l.type,
        data: l.data,
        color: l.color,
        opacity: l.opacity,
        visible: l.visible,
      }));

      await fetch(`/api/projects/${proj.id}/layers`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ layers: layersData }),
      });

      message.success('项目已保存！');
      setSaveModalOpen(false);
      setProjectName('');
    } catch (err) {
      message.error('保存失败: ' + (err instanceof Error ? err.message : ''));
    } finally {
      setLoading(false);
    }
  };

  const handleLoad = async (projectId: number) => {
    setLoading(true);
    try {
      // Load project
      const res = await fetch(`/api/projects/${projectId}`, { headers });
      if (!res.ok) throw new Error('加载失败');
      const proj = await res.json();

      // Load layers
      const layersRes = await fetch(`/api/projects/${projectId}/layers`, { headers });
      const savedLayers = await layersRes.json();

      // Apply map state
      if (proj.map_state) {
        const ms = typeof proj.map_state === 'string' ? JSON.parse(proj.map_state) : proj.map_state;
        if (ms.center) {
          window.dispatchEvent(new CustomEvent('fly-to', {
            detail: { center: ms.center, zoom: ms.zoom || 11 },
          }));
        }
      }

      // Apply layers
      setLayers([]);
      if (Array.isArray(savedLayers)) {
        for (const layer of savedLayers) {
          addLayer({
            id: '',
            name: layer.name,
            type: layer.type || 'geojson',
            visible: layer.visible !== false,
            color: layer.color || '#1677ff',
            opacity: layer.opacity || 0.7,
            data: layer.data,
            sourceId: '',
            layerId: '',
            createdAt: Date.now(),
          });
        }
      }

      message.success(`已加载项目「${proj.name}」`);
      setLoadModalOpen(false);
    } catch (err) {
      message.error('加载失败: ' + (err instanceof Error ? err.message : ''));
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (projectId: number) => {
    try {
      const res = await fetch(`/api/projects/${projectId}`, { method: 'DELETE', headers });
      if (res.ok) {
        message.success('已删除');
        fetchProjects();
      }
    } catch {
      message.error('删除失败');
    }
  };

  if (!user) return null;

  return (
    <>
      <Button icon={<SaveOutlined />} size="small" onClick={() => setSaveModalOpen(true)}>
        保存
      </Button>
      <Button icon={<FolderOpenOutlined />} size="small" onClick={() => { setLoadModalOpen(true); fetchProjects(); }}>
        加载
      </Button>

      {/* Save Modal */}
      <Modal
        title="保存项目"
        open={saveModalOpen}
        onCancel={() => setSaveModalOpen(false)}
        onOk={handleSave}
        confirmLoading={loading}
        okText="保存"
        cancelText="取消"
      >
        <Input
          placeholder="项目名称，如「洪山区医院分析」"
          value={projectName}
          onChange={e => setProjectName(e.target.value)}
          onPressEnter={handleSave}
        />
        <Text type="secondary" style={{ display: 'block', marginTop: 8, fontSize: 12 }}>
          将保存当前所有图层和地图视图
        </Text>
      </Modal>

      {/* Load Modal */}
      <Modal
        title="加载项目"
        open={loadModalOpen}
        onCancel={() => setLoadModalOpen(false)}
        footer={null}
        width={480}
      >
        {projects.length === 0 ? (
          <Text type="secondary">暂无保存的项目</Text>
        ) : (
          <List
            dataSource={projects}
            renderItem={p => (
              <List.Item
                actions={[
                  <Button key="load" type="link" onClick={() => handleLoad(p.id)} loading={loading}>
                    加载
                  </Button>,
                  <Popconfirm key="del" title="确认删除？" onConfirm={() => handleDelete(p.id)}>
                    <Button type="link" danger icon={<DeleteOutlined />} />
                  </Popconfirm>,
                ]}
              >
                <List.Item.Meta
                  title={p.name}
                  description={
                    <Text type="secondary" style={{ fontSize: 11 }}>
                      {new Date(p.updated_at).toLocaleString('zh-CN')}
                    </Text>
                  }
                />
              </List.Item>
            )}
          />
        )}
      </Modal>
    </>
  );
};

export default ProjectManager;
