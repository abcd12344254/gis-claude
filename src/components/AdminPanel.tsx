import React, { useEffect, useState, useCallback } from 'react';
import { Table, Button, message, Typography, Card, Space, Tag, Modal } from 'antd';
import { DownloadOutlined, ReloadOutlined, UserOutlined, VerifiedOutlined, PlusOutlined } from '@ant-design/icons';
import { useGISStore } from '../store/useGISStore';

const { Text } = Typography;

interface UserRecord {
  id: number;
  email: string;
  plan: string;
  quota_daily: number;
  quota_used_today: number;
  quota_date: string;
  verified: number;
  created_at: string;
}

interface AdminStats {
  total: number;
  verified: number;
  today_new: number;
}

const planLabel: Record<string, { color: string; text: string }> = {
  free: { color: 'default', text: '免费版' },
  pro: { color: 'blue', text: '专业版' },
  team: { color: 'purple', text: '团队版' },
};

const AdminPanel: React.FC<{ open: boolean; onClose: () => void }> = ({ open, onClose }) => {
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [stats, setStats] = useState<AdminStats>({ total: 0, verified: 0, today_new: 0 });
  const [loading, setLoading] = useState(false);

  // 每次调用时直接从 store 拿最新 token，避免闭包过期
  const fetchUsers = useCallback(async () => {
    const token = useGISStore.getState().authToken;
    if (!token) {
      message.error('未登录，请重新登录');
      return;
    }
    setLoading(true);
    try {
      const resp = await fetch('/api/admin/users', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ detail: '请求失败' }));
        throw new Error(err.detail || `HTTP ${resp.status}`);
      }
      const data = await resp.json();
      setUsers(data.users || []);
      setStats(data.stats || { total: 0, verified: 0, today_new: 0 });
      message.success(`已加载 ${data.users?.length || 0} 个用户`);
    } catch (err: any) {
      message.error(err.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  // 每次打开都重新拉取
  useEffect(() => {
    if (open) {
      // 延迟 200ms 等 Modal 动画结束再请求，避免渲染冲突
      const timer = setTimeout(fetchUsers, 200);
      return () => clearTimeout(timer);
    }
  }, [open, fetchUsers]);

  const handleExportCSV = useCallback(async () => {
    const token = useGISStore.getState().authToken;
    if (!token) { message.error('未登录'); return; }
    try {
      const resp = await fetch('/api/admin/users/export', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!resp.ok) throw new Error('导出失败');
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `users_export_${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      message.success('CSV 已下载');
    } catch (err: any) {
      message.error(err.message || '导出失败');
    }
  }, []);

  const columns = [
    { title: 'ID', dataIndex: 'id', width: 50 },
    { title: '邮箱', dataIndex: 'email', ellipsis: true },
    {
      title: '套餐', dataIndex: 'plan', width: 80,
      render: (p: string) => {
        const info = planLabel[p] || { color: 'default', text: p };
        return <Tag color={info.color}>{info.text}</Tag>;
      },
    },
    {
      title: '已验证', dataIndex: 'verified', width: 70,
      render: (v: number) => v ? <Tag color="green">是</Tag> : <Tag color="orange">否</Tag>,
    },
    {
      title: '配额', width: 80,
      render: (_: any, r: UserRecord) => (
        <span>{r.quota_daily - r.quota_used_today}/{r.quota_daily}</span>
      ),
    },
    {
      title: '注册时间', dataIndex: 'created_at', width: 140,
      render: (t: string) => t?.replace('T', ' ')?.slice(0, 19) || '—',
    },
  ];

  return (
    <Modal
      title="🔐 管理员后台"
      open={open}
      onCancel={onClose}
      width="90%"
      style={{ maxWidth: 900, top: 20 }}
      footer={null}
      destroyOnClose
      key={open ? 'admin-open' : 'admin-closed'}
    >
      {/* 统计卡片 */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
        <Card size="small" style={{ flex: 1, textAlign: 'center' }}>
          <UserOutlined style={{ fontSize: 20, color: '#1677ff', marginBottom: 4 }} />
          <div><Text strong style={{ fontSize: 18 }}>{stats.total}</Text></div>
          <Text type="secondary" style={{ fontSize: 11 }}>总用户</Text>
        </Card>
        <Card size="small" style={{ flex: 1, textAlign: 'center' }}>
          <VerifiedOutlined style={{ fontSize: 20, color: '#52c41a', marginBottom: 4 }} />
          <div><Text strong style={{ fontSize: 18 }}>{stats.verified}</Text></div>
          <Text type="secondary" style={{ fontSize: 11 }}>已验证</Text>
        </Card>
        <Card size="small" style={{ flex: 1, textAlign: 'center' }}>
          <PlusOutlined style={{ fontSize: 20, color: '#fa8c16', marginBottom: 4 }} />
          <div><Text strong style={{ fontSize: 18 }}>{stats.today_new}</Text></div>
          <Text type="secondary" style={{ fontSize: 11 }}>今日新增</Text>
        </Card>
      </div>

      {/* 操作栏 */}
      <Space style={{ marginBottom: 12 }}>
        <Button icon={<ReloadOutlined />} onClick={fetchUsers} loading={loading}>刷新</Button>
        <Button icon={<DownloadOutlined />} type="primary" onClick={handleExportCSV}>导出 CSV</Button>
      </Space>

      {/* 用户表格 */}
      <Table
        dataSource={users}
        columns={columns}
        rowKey="id"
        loading={loading}
        size="small"
        pagination={{ pageSize: 20, showTotal: (t) => `共 ${t} 个用户` }}
        scroll={{ x: 600 }}
      />
    </Modal>
  );
};

export default AdminPanel;
