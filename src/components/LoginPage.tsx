import React, { useState, useCallback } from 'react';
import { Button, Form, Input, message, Tabs, Steps, Modal } from 'antd';
import {
  MailOutlined,
  LockOutlined,
  GlobalOutlined,
  ThunderboltOutlined,
  PictureOutlined,
  RobotOutlined,
  EnvironmentOutlined,
  SafetyCertificateOutlined,
  ArrowLeftOutlined,
} from '@ant-design/icons';
import { useGISStore } from '../store/useGISStore';

const LoginPage: React.FC = () => {
  const [loading, setLoading] = useState(false);
  const [sendingCode, setSendingCode] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [activeTab, setActiveTab] = useState<'login' | 'register'>('login');
  const [registerStep, setRegisterStep] = useState<1 | 2>(1);
  const [registerEmail, setRegisterEmail] = useState('');
  const [registerPassword, setRegisterPassword] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [devCode, setDevCode] = useState('');
  const [devCodeModal, setDevCodeModal] = useState(false);
  const { setAuth } = useGISStore();
  const [form] = Form.useForm();

  const startCountdown = useCallback(() => {
    setCountdown(60);
    const timer = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }, []);

  const handleSendCode = async (emailOverride?: string) => {
    const email = (emailOverride || registerEmail).trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      message.warning('请先输入正确的邮箱地址');
      return;
    }
    if (!emailOverride && !registerEmail) {
      setRegisterEmail(email);
    }
    setSendingCode(true);
    try {
      const res = await fetch('/api/auth/send-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (data.success) {
        setCodeSent(true);
        startCountdown();
        // 如果后端返回了验证码（开发模式/未配SMTP），弹窗显示
        if (data.code) {
          setDevCode(data.code);
          setDevCodeModal(true);
        } else {
          message.success('验证码已发送，请检查邮箱');
        }
      } else {
        message.warning(data.message || '发送失败');
      }
    } catch {
      message.error('网络异常，请重试');
    } finally {
      setSendingCode(false);
    }
  };

  const handleVerifyAndRegister = async (values: { code: string }) => {
    setLoading(true);
    try {
      const verifyRes = await fetch('/api/auth/verify-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: registerEmail, code: values.code }),
      });
      if (!verifyRes.ok) {
        const err = await verifyRes.json();
        throw new Error(err.detail || '验证失败');
      }

      const regRes = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: registerEmail, password: registerPassword }),
      });
      const data = await regRes.json();
      if (!regRes.ok) throw new Error(data.detail || '注册失败');

      setAuth(data.token, data.user);
      message.success('注册成功！欢迎使用 GIS Claude');
    } catch (err) {
      message.error(err instanceof Error ? err.message : '注册失败');
    } finally {
      setLoading(false);
    }
  };

  const handleLogin = async (values: { email: string; password: string }) => {
    setLoading(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || '登录失败');
      setAuth(data.token, data.user);
      message.success('欢迎回来！');
    } catch (err) {
      message.error(err instanceof Error ? err.message : '登录失败');
    } finally {
      setLoading(false);
    }
  };

  const switchToRegister = () => {
    setActiveTab('register');
    setRegisterStep(1);
    setRegisterEmail('');
    setRegisterPassword('');
    setCodeSent(false);
    setCountdown(0);
    form.resetFields();
  };

  const switchToLogin = () => {
    setActiveTab('login');
    setRegisterStep(1);
    form.resetFields();
  };

  return (
    <>
      <div style={{ height: '100vh', display: 'flex', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' }}>
        {/* ====== 左侧品牌区 ====== */}
        <div className="login-brand-panel" style={{
          flex: 1, background: 'linear-gradient(135deg, #0f1b35 0%, #1a3a5c 40%, #1677ff 100%)',
          display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center',
          padding: '60px 80px', position: 'relative', overflow: 'hidden',
        }}>
          <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
            backgroundImage: 'radial-gradient(circle, rgba(255,255,255,0.06) 1px, transparent 1px)',
            backgroundSize: '40px 40px', opacity: 0.5 }} />
          <div style={{ position: 'absolute', top: '20%', left: '-100px', width: 400, height: 400, borderRadius: '50%', background: 'radial-gradient(circle, rgba(22,119,255,0.4), transparent 70%)', filter: 'blur(60px)' }} />
          <div style={{ position: 'absolute', bottom: '10%', right: '-80px', width: 350, height: 350, borderRadius: '50%', background: 'radial-gradient(circle, rgba(82,196,26,0.3), transparent 70%)', filter: 'blur(60px)' }} />

          <div style={{ position: 'relative', zIndex: 1, maxWidth: 520 }}>
            <div style={{ marginBottom: 48 }}>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
                <GlobalOutlined style={{ fontSize: 36, color: '#fff', filter: 'drop-shadow(0 0 12px rgba(255,255,255,0.3))' }} />
                <span style={{ fontSize: 34, fontWeight: 800, color: '#fff', letterSpacing: -1 }}>GIS Claude</span>
              </div>
              <p style={{ fontSize: 17, color: 'rgba(255,255,255,0.7)', lineHeight: 1.8, margin: 0 }}>用自然语言驱动专业 GIS 分析</p>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              {[
                { icon: <RobotOutlined />, title: 'AI 自然语言交互', desc: '输入"分析洪山区500米内的医院分布"，秒出结果' },
                { icon: <ThunderboltOutlined />, title: '10 种空间分析引擎', desc: '缓冲区 · 相交分析 · 时空立方体 · Getis-Ord Gi* 热点分析' },
                { icon: <PictureOutlined />, title: '一键专业成图', desc: '标题 · 图例 · 比例尺 · 指北针 · 5 种配色 · 4K 高清导出' },
                { icon: <EnvironmentOutlined />, title: 'OSM + 高德实时数据', desc: '行政区边界 · 道路 · 水系 · 绿地 · 铁路 · 建筑 · POI 全覆盖' },
              ].map((item, i) => (
                <div key={i} style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
                  <div style={{ width: 38, height: 38, borderRadius: 10, background: 'rgba(255,255,255,0.12)', backdropFilter: 'blur(10px)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, color: '#fff', flexShrink: 0 }}>{item.icon}</div>
                  <div>
                    <div style={{ fontSize: 15, fontWeight: 600, color: '#fff', marginBottom: 2 }}>{item.title}</div>
                    <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.55)', lineHeight: 1.6 }}>{item.desc}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ====== 右侧表单区 ====== */}
        <div style={{ width: 480, display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '60px 56px', background: '#fff' }}>
          <div style={{ marginBottom: 32 }}>
            <h1 style={{ fontSize: 26, fontWeight: 700, margin: '0 0 6px', color: '#1a1a2e' }}>
              {activeTab === 'login' ? '欢迎回来' : registerStep === 1 ? '创建账号' : '验证邮箱'}
            </h1>
            <p style={{ fontSize: 14, color: '#999', margin: 0 }}>
              {activeTab === 'login' ? '登录以继续使用 GIS Claude' : registerStep === 1 ? '注册即可免费体验' : `验证码已发送至 ${registerEmail}`}
            </p>
          </div>

          {/* ====== 登录表单 ====== */}
          {activeTab === 'login' && (
            <>
              <Tabs activeKey="login" centered style={{ marginBottom: 8 }} items={[
                { key: 'login', label: '登录' },
                { key: 'register', label: <a onClick={switchToRegister}>注册</a> },
              ]} />
              <Form onFinish={handleLogin} layout="vertical" size="large">
                <Form.Item name="email" rules={[{ required: true, message: '请输入邮箱' }, { type: 'email', message: '邮箱格式不正确' }]}>
                  <Input prefix={<MailOutlined style={{ color: '#bfbfbf' }} />} placeholder="邮箱地址" style={{ borderRadius: 8, height: 46 }} />
                </Form.Item>
                <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }, { min: 6, message: '密码至少 6 位' }]}>
                  <Input.Password prefix={<LockOutlined style={{ color: '#bfbfbf' }} />} placeholder="密码" style={{ borderRadius: 8, height: 46 }} />
                </Form.Item>
                <Form.Item style={{ marginBottom: 12 }}>
                  <Button type="primary" htmlType="submit" loading={loading} block style={{ height: 46, borderRadius: 8, fontSize: 16, fontWeight: 600, background: 'linear-gradient(135deg, #1677ff, #0958d9)', border: 'none', boxShadow: '0 4px 14px rgba(22,119,255,0.35)' }}>登录</Button>
                </Form.Item>
              </Form>
            </>
          )}

          {/* ====== 注册 Step 1 ====== */}
          {activeTab === 'register' && registerStep === 1 && (
            <>
              <Tabs activeKey="register" centered style={{ marginBottom: 8 }} items={[
                { key: 'login', label: <a onClick={switchToLogin}>登录</a> },
                { key: 'register', label: '注册' },
              ]} />
              <Steps current={0} size="small" style={{ marginBottom: 24 }} items={[{ title: '填写信息' }, { title: '验证邮箱' }]} />
              <Form layout="vertical" size="large" onFinish={(values) => {
                setRegisterEmail(values.email);
                setRegisterPassword(values.password);
                setRegisterStep(2);
                handleSendCode(values.email);
              }}>
                <Form.Item name="email" rules={[{ required: true, message: '请输入邮箱' }, { type: 'email', message: '邮箱格式不正确' }]}>
                  <Input prefix={<MailOutlined style={{ color: '#bfbfbf' }} />} placeholder="邮箱地址" style={{ borderRadius: 8, height: 46 }} />
                </Form.Item>
                <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }, { min: 6, message: '密码至少 6 位' }]}>
                  <Input.Password prefix={<LockOutlined style={{ color: '#bfbfbf' }} />} placeholder="密码（6 位以上）" style={{ borderRadius: 8, height: 46 }} />
                </Form.Item>
                <Form.Item style={{ marginBottom: 12 }}>
                  <Button type="primary" htmlType="submit" block style={{ height: 46, borderRadius: 8, fontSize: 16, fontWeight: 600, background: 'linear-gradient(135deg, #1677ff, #0958d9)', border: 'none', boxShadow: '0 4px 14px rgba(22,119,255,0.35)' }}>下一步 · 验证邮箱</Button>
                </Form.Item>
              </Form>
            </>
          )}

          {/* ====== 注册 Step 2 ====== */}
          {activeTab === 'register' && registerStep === 2 && (
            <>
              <Steps current={1} size="small" style={{ marginBottom: 24, marginTop: 48 }} items={[{ title: '填写信息' }, { title: '验证邮箱' }]} />
              <Form form={form} onFinish={handleVerifyAndRegister} layout="vertical" size="large">
                <Form.Item name="code" rules={[{ required: true, message: '请输入验证码' }, { len: 6, message: '验证码为 6 位数字' }]}>
                  <Input prefix={<SafetyCertificateOutlined style={{ color: '#1677ff' }} />} placeholder="输入 6 位验证码"
                    style={{ borderRadius: 8, height: 46, textAlign: 'center', letterSpacing: 4, fontSize: 20 }} maxLength={6} autoFocus />
                </Form.Item>
                <Form.Item style={{ marginBottom: 12 }}>
                  <Button type="primary" htmlType="submit" loading={loading} block style={{ height: 46, borderRadius: 8, fontSize: 16, fontWeight: 600, background: 'linear-gradient(135deg, #1677ff, #0958d9)', border: 'none', boxShadow: '0 4px 14px rgba(22,119,255,0.35)' }}>完成注册</Button>
                </Form.Item>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Button type="link" icon={<ArrowLeftOutlined />} onClick={() => { setRegisterStep(1); setCodeSent(false); setCountdown(0); }}
                    style={{ padding: 0, color: '#999' }}>返回修改</Button>
                  <Button type="link" onClick={() => handleSendCode()} loading={sendingCode} disabled={countdown > 0} style={{ color: '#1677ff' }}>
                    {countdown > 0 ? `${countdown}s 后重发` : '重新发送验证码'}
                  </Button>
                </div>
              </Form>
            </>
          )}

          <p style={{ textAlign: 'center', fontSize: 12, color: '#ccc', marginTop: 24 }}>注册即表示同意服务条款 · 我们不会泄露您的信息</p>
        </div>
      </div>

      {/* ====== 验证码弹窗（开发模式） ====== */}
      <Modal title="📧 邮箱验证码" open={devCodeModal} onOk={() => setDevCodeModal(false)}
        onCancel={() => setDevCodeModal(false)}
        okText="我知道了" cancelButtonProps={{ style: { display: 'none' } }}
        width={360} centered>
        <div style={{ textAlign: 'center', padding: '16px 0' }}>
          <p style={{ color: '#999', marginBottom: 16 }}>未配置邮件服务，验证码如下</p>
          <div style={{ fontSize: 42, fontWeight: 800, letterSpacing: 10, color: '#1677ff', fontFamily: 'monospace', background: '#f0f5ff', borderRadius: 8, padding: '16px 8px', marginBottom: 12 }}>
            {devCode}
          </div>
          <p style={{ color: '#999', fontSize: 12 }}>有效期 5 分钟，请勿泄露</p>
        </div>
      </Modal>
    </>
  );
};

export default LoginPage;
