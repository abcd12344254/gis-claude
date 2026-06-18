import React, { useState } from 'react';
import { Modal, Form, Input, Button, Tabs, message } from 'antd';
import { MailOutlined, LockOutlined } from '@ant-design/icons';
import { useGISStore } from '../store/useGISStore';

interface AuthModalProps {
  open: boolean;
  onClose: () => void;
}

const AuthModal: React.FC<AuthModalProps> = ({ open, onClose }) => {
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<'login' | 'register'>('login');
  const { setAuth } = useGISStore();

  const handleSubmit = async (values: { email: string; password: string }) => {
    setLoading(true);
    try {
      const endpoint = activeTab === 'login' ? '/api/auth/login' : '/api/auth/register';
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.detail || '请求失败');
      }
      setAuth(data.token, data.user);
      message.success(activeTab === 'login' ? '登录成功！' : '注册成功！');
      onClose();
    } catch (err) {
      message.error(err instanceof Error ? err.message : '操作失败');
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
