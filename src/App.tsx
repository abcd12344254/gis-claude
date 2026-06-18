import React, { useCallback, useState, useEffect, useRef } from 'react';
import { Layout, Button, Tooltip, Space, Modal, Input, message, Dropdown, Drawer, FloatButton } from 'antd';
import {
  SettingOutlined,
  ClearOutlined,
  ApiOutlined,
  UserOutlined,
  LogoutOutlined,
  MenuOutlined,
  RobotOutlined,
  MenuFoldOutlined,
} from '@ant-design/icons';
import MapView from './components/MapView';
import LayerPanel from './components/LayerPanel';
import Toolbar from './components/Toolbar';
import AIAssistant from './components/AIAssistant';
import SpatialAnalysisPanel from './components/SpatialAnalysisPanel';
import QuickMapExport from './components/QuickMapExport';
import SpaceTimePanel from './components/SpaceTimePanel';
import DrawingTools from './components/DrawingTools';
import ErrorBoundary from './components/ErrorBoundary';
import AuthModal from './components/AuthModal';
import ProjectManager from './components/ProjectManager';
import LoginPage from './components/LoginPage';
import { useGISStore } from './store/useGISStore';

const { Sider, Content } = Layout;

const MOBILE_BREAKPOINT = 768;

const App: React.FC = () => {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [isMobile, setIsMobile] = useState(window.innerWidth < MOBILE_BREAKPOINT);
  const [leftDrawerOpen, setLeftDrawerOpen] = useState(false);
  const [rightDrawerOpen, setRightDrawerOpen] = useState(false);
  const { deepseekApiKey, setDeepseekApiKey, layers, setLayers, clearChat, user, logout } =
    useGISStore();

  // 监听窗口大小变化
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const handleSaveApiKey = useCallback(() => {
    setDeepseekApiKey(apiKeyInput.trim());
    setSettingsOpen(false);
    message.success('API Key 已保存');
  }, [apiKeyInput, setDeepseekApiKey]);

  const handleClearAll = useCallback(() => {
    Modal.confirm({
      title: '确认清除',
      content: '确定要清除所有数据吗？这将删除所有图层和对话记录。',
      onOk: () => {
        setLayers([]);
        clearChat();
        message.success('已清除所有数据');
      },
      okText: '确认',
      cancelText: '取消',
    });
  }, [setLayers, clearChat]);

  // 登录后触发 resize
  const prevUserRef = useRef(user);
  useEffect(() => {
    if (!prevUserRef.current && user) {
      const timer = setTimeout(() => {
        window.dispatchEvent(new Event('resize'));
      }, 150);
      return () => clearTimeout(timer);
    }
    prevUserRef.current = user;
  }, [user]);

  // ====== 左侧面板内容（桌面端 Sider / 移动端 Drawer 共用） ======
  const leftPanelContent = (
    <>
      <LayerPanel />
      <SpatialAnalysisPanel />
      <SpaceTimePanel />
      <QuickMapExport />
    </>
  );

  // ====== 右侧面板内容 ======
  const rightPanelContent = <AIAssistant />;

  // ====== 桌面端工具栏 ======
  const desktopToolbar = (
    <Space>
      <Toolbar />
      <DrawingTools />
      <ProjectManager />
      <Tooltip title="设置 API Key">
        <Button icon={<ApiOutlined />} size="small" onClick={() => {
          setApiKeyInput(deepseekApiKey);
          setSettingsOpen(true);
        }} />
      </Tooltip>
      {user ? (
        <Dropdown menu={{ items: [
          { key: 'plan', label: `套餐：${user.plan === 'pro' ? '专业版' : user.plan === 'team' ? '团队版' : '免费版'}`, disabled: true },
          { key: 'quota', label: `今日剩余：${user.quota_remaining ?? '—'} 次`, disabled: true },
          { type: 'divider' },
          { key: 'logout', label: '退出登录', icon: <LogoutOutlined />, onClick: () => { logout(); message.success('已退出登录'); } },
        ]}}>
          <Button icon={<UserOutlined />} size="small" type="text" style={{ color: '#1677ff' }}>
            {user.email}
          </Button>
        </Dropdown>
      ) : (
        <Button icon={<UserOutlined />} size="small" onClick={() => setAuthModalOpen(true)}>登录</Button>
      )}
      <Tooltip title="清除全部">
        <Button icon={<ClearOutlined />} size="small" danger onClick={handleClearAll} />
      </Tooltip>
      <Tooltip title="设置">
        <Button icon={<SettingOutlined />} size="small" onClick={() => setSettingsOpen(true)} />
      </Tooltip>
    </Space>
  );

  // ====== 移动端工具栏（精简版） ======
  const mobileToolbar = (
    <Space size={4}>
      <Toolbar />
      <DrawingTools />
      <Button icon={<ApiOutlined />} size="small" onClick={() => {
        setApiKeyInput(deepseekApiKey);
        setSettingsOpen(true);
      }} />
      {user ? (
        <Button icon={<UserOutlined />} size="small" type="text" onClick={() => {
          logout(); message.success('已退出登录');
        }} />
      ) : (
        <Button icon={<UserOutlined />} size="small" onClick={() => setAuthModalOpen(true)}>登录</Button>
      )}
    </Space>
  );

  // ====== 布局始终挂载 ======
  return (
    <>
      {!user && <LoginPage />}

      <div style={{ display: user ? 'flex' : 'none', height: '100vh', flexDirection: 'column' }}>
        <ErrorBoundary>
          <Layout style={{ height: '100vh', overflow: 'hidden' }}>

            {/* ====== 顶部 ====== */}
            <Layout.Header style={{
              height: 48, lineHeight: '48px', padding: isMobile ? '0 8px' : '0 16px',
              background: '#fff', borderBottom: '1px solid #e8e8e8',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', zIndex: 100,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {isMobile && (
                  <Button type="text" icon={<MenuFoldOutlined />} size="small"
                    onClick={() => setLeftDrawerOpen(true)} />
                )}
                <span style={{ fontSize: isMobile ? 14 : 18, fontWeight: 700, color: '#1677ff', letterSpacing: -0.5 }}>
                  🌍 GIS Claude
                </span>
                {!isMobile && <span style={{ fontSize: 12, color: '#999' }}>智能地理信息系统</span>}
              </div>
              {isMobile ? mobileToolbar : desktopToolbar}
            </Layout.Header>

            <Layout style={{ flex: 1, overflow: 'hidden' }}>
              {/* ====== 桌面端：左侧面板 ====== */}
              {!isMobile && (
                <Sider width={320} style={{ background: '#fff', borderRight: '1px solid #e8e8e8', overflow: 'auto' }}>
                  {leftPanelContent}
                </Sider>
              )}

              {/* ====== 地图区域 ====== */}
              <Content style={{ position: 'relative', overflow: 'hidden' }}>
                <MapView />
              </Content>

              {/* ====== 桌面端：右侧面板 ====== */}
              {!isMobile && (
                <Sider width={380} style={{ background: '#fff', borderLeft: '1px solid #e8e8e8', overflow: 'hidden' }}>
                  {rightPanelContent}
                </Sider>
              )}
            </Layout>

            {/* ====== 移动端：左侧抽屉（图层+分析） ====== */}
            {isMobile && (
              <Drawer
                title="🗂️ 工具面板"
                placement="left"
                width={300}
                open={leftDrawerOpen}
                onClose={() => setLeftDrawerOpen(false)}
                styles={{ body: { padding: 0 } }}
              >
                {leftPanelContent}
              </Drawer>
            )}

            {/* ====== 移动端：右侧抽屉（AI 助手） ====== */}
            {isMobile && (
              <Drawer
                title="🤖 AI 助手"
                placement="right"
                width={320}
                open={rightDrawerOpen}
                onClose={() => setRightDrawerOpen(false)}
                styles={{ body: { padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' } }}
              >
                {rightPanelContent}
              </Drawer>
            )}

            {/* ====== 设置弹窗 ====== */}
            <Modal title="设置" open={settingsOpen} onCancel={() => setSettingsOpen(false)}
              footer={null} width={isMobile ? '90%' : 480}>
              <div style={{ marginBottom: 16 }}>
                <div style={{ marginBottom: 8, fontWeight: 500 }}>DeepSeek API Key</div>
                <Input.Password placeholder="sk-..." value={apiKeyInput}
                  onChange={(e) => setApiKeyInput(e.target.value)} />
                <div style={{ marginTop: 4, fontSize: 12, color: '#999' }}>
                  在 <a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noreferrer">platform.deepseek.com</a> 获取 API Key
                </div>
              </div>
              <Button type="primary" onClick={handleSaveApiKey} block>保存</Button>
            </Modal>

            <AuthModal open={authModalOpen} onClose={() => setAuthModalOpen(false)} />
          </Layout>
        </ErrorBoundary>
      </div>

      {/* ====== 移动端浮动按钮 ====== */}
      {isMobile && user && (
        <>
          <FloatButton
            icon={<MenuOutlined />}
            style={{ left: 16, bottom: 80, zIndex: 1000 }}
            onClick={() => setLeftDrawerOpen(true)}
          />
          <FloatButton
            icon={<RobotOutlined />}
            style={{ right: 16, bottom: 80, zIndex: 1000 }}
            onClick={() => setRightDrawerOpen(true)}
          />
        </>
      )}
    </>
  );
};

export default App;
