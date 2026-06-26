import React, { useState } from 'react';
import { Modal, Form, Input, Button, Tabs, message } from 'antd';
import { MailOutlined, LockOutlined } from '@ant-design/icons';
import { useGISStore } from '../store/useGISStore';
import { API_BASE } from '../utils/api';

interface AuthModalProps {
  open: boolean;
  onClose: () => void;
}

const AuthModal: React.FC<AuthModalProps> = ({ open, onClose }) => {
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<'login' | 'register'>('login');
  const { setAuth } = useGISStore();

  const handleSubmit = async (values: { email: string; password: string }) => {
    if (loading) return;
    setLoading(true);
    const endpoint = activeTab === 'login' ? `${API_BASE}/api/auth/login` : `${API_BASE}/api/auth/register`;
    console.log(`[AuthModal] 提交 ${activeTab}:`, values.email, endpoint);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
      const data = await res.json().catch(() => ({}));
      console.log(`[AuthModal] 响应:`, res.status, data);
      if (!res.ok) {
        throw new Error(data.detail || `服务器错误 (${res.status})`);
      }
      console.log(`[AuthModal] 成功:`, data.user?.id, data.user?.email);
      setAuth(data.token, data.user);
      message.success(activeTab === 'login' ? '登录成功！' : '注册成功！');
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : '操作失败';
      console.error(`[AuthModal] 失败:`, msg);
      message.error({ content: msg, duration: 6 });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width={400}
      centered
      title="GIS Claude"
    >
      <Tabs
        activeKey={activeTab}
        onChange={(k) => setActiveTab(k as 'login' | 'register')}
        centered
        items={[
          {
            key: 'login',
            label: '登录',
            children: (
              <Form onFinish={handleSubmit} layout="vertical" style={{ marginTop: 8 }}>
                <Form.Item
                  name="email"
                  rules={[{ required: true, type: 'email', message: '请输入有效邮箱' }]}
                >
                  <Input prefix={<MailOutlined />} placeholder="邮箱" size="large" />
                </Form.Item>
                <Form.Item
                  name="password"
                  rules={[{ required: true, min: 6, message: '密码至少6位' }]}
                >
                  <Input.Password prefix={<LockOutlined />} placeholder="密码" size="large" />
                </Form.Item>
                <Button type="primary" htmlType="submit" loading={loading} block size="large">
                  登录
                </Button>
              </Form>
            ),
          },
          {
            key: 'register',
            label: '注册',
            children: (
              <Form onFinish={handleSubmit} layout="vertical" style={{ marginTop: 8 }}>
                <Form.Item
                  name="email"
                  rules={[{ required: true, type: 'email', message: '请输入有效邮箱' }]}
                >
                  <Input prefix={<MailOutlined />} placeholder="邮箱" size="large" />
                </Form.Item>
                <Form.Item
                  name="password"
                  rules={[{ required: true, min: 6, message: '密码至少6位' }]}
                >
                  <Input.Password prefix={<LockOutlined />} placeholder="密码（6位以上）" size="large" />
                </Form.Item>
                <Button type="primary" htmlType="submit" loading={loading} block size="large">
                  注册
                </Button>
              </Form>
            ),
          },
        ]}
      />
    </Modal>
  );
};

export default AuthModal;
