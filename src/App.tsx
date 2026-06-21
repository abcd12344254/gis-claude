import React, { useCallback, useState, useEffect, useRef } from 'react';
import { Layout, Button, Tooltip, Space, Modal, Input, message, Dropdown, Drawer, FloatButton, Tabs, ConfigProvider } from 'antd';
import {
  SettingOutlined,
  ClearOutlined,
  ApiOutlined,
  UserOutlined,
  LogoutOutlined,
  MenuOutlined,
  RobotOutlined,
  MenuFoldOutlined,
  MoreOutlined,
  CrownOutlined,
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
import AdminPanel from './components/AdminPanel';
import RechargeModal from './components/RechargeModal';
import LoginPage from './components/LoginPage';
import { useGISStore } from './store/useGISStore';
import { useIsMobile } from './hooks/useIsMobile';

const { Sider, Content } = Layout;

const App: React.FC = () => {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const isMobile = useIsMobile();
  const [leftDrawerOpen, setLeftDrawerOpen] = useState(false);
  const [rightDrawerOpen, setRightDrawerOpen] = useState(false);
  const [adminPanelOpen, setAdminPanelOpen] = useState(false);
  const [rechargeModalOpen, setRechargeModalOpen] = useState(false);
  const { deepseekApiKey, setDeepseekApiKey, layers, setLayers, clearChat, user, logout } =
    useGISStore();

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

  // 登录后触发 resize，多级延迟确保移动端 display:none→flex 后地图正确渲染
  const prevUserRef = useRef(user);
  useEffect(() => {
    if (!prevUserRef.current && user) {
      [100, 300, 600].forEach(ms => {
        setTimeout(() => window.dispatchEvent(new Event('resize')), ms);
      });
    }
    prevUserRef.current = user;
  }, [user]);

  // ====== 左侧面板内容 ======
  const leftPanelContent = isMobile ? (
    <Tabs
      defaultActiveKey="layers"
      size="small"
      destroyInactiveTabPane={false}
      tabBarStyle={{ padding: '0 8px', marginBottom: 0 }}
      items={[
        { key: 'layers', label: '图层', children: <LayerPanel /> },
        { key: 'analysis', label: '分析', children: <SpatialAnalysisPanel /> },
        { key: 'spacetime', label: '时空', children: <SpaceTimePanel /> },
        { key: 'export', label: '导出', children: <QuickMapExport /> },
      ]}
    />
  ) : (
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
      {user?.is_admin && (
        <Tooltip title="管理员后台">
          <Button icon={<UserOutlined />} size="small" type="dashed" onClick={() => setAdminPanelOpen(true)}>管理</Button>
        </Tooltip>
      )}
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
          { key: 'recharge', label: '💰 充值 / 升级', icon: <CrownOutlined />, onClick: () => setRechargeModalOpen(true) },
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

  // ====== 移动端工具栏（精简：图标+更多溢出） ======
  const overflowItems: any[] = [
    { key: 'apikey', label: 'API 设置', icon: <ApiOutlined />, onClick: () => { setApiKeyInput(deepseekApiKey); setSettingsOpen(true); } },
    { key: 'clear', label: '清除全部', icon: <ClearOutlined />, danger: true, onClick: handleClearAll },
    { key: 'settings', label: '设置', icon: <SettingOutlined />, onClick: () => setSettingsOpen(true) },
  ];
  if (user?.is_admin) {
    overflowItems.unshift({ key: 'admin', label: '管理员后台', icon: <UserOutlined />, onClick: () => setAdminPanelOpen(true) });
  }
  if (user) {
    overflowItems.unshift(
      { key: 'plan', label: `套餐：${user.plan === 'pro' ? '专业版' : user.plan === 'team' ? '团队版' : '免费版'}`, disabled: true },
      { key: 'quota', label: `今日剩余：${user.quota_remaining ?? '—'} 次`, disabled: true },
      { key: 'recharge', label: '💰 充值 / 升级', icon: <CrownOutlined />, onClick: () => setRechargeModalOpen(true) },
      { key: 'logout', label: '退出登录', icon: <LogoutOutlined />, onClick: () => { logout(); message.success('已退出登录'); } },
      { type: 'divider' as const },
    );
  }

  const mobileToolbar = (
    <Space size={2}>
      <Toolbar />
      <DrawingTools />
      {!user && <Button icon={<UserOutlined />} size="small" onClick={() => setAuthModalOpen(true)} />}
      <Dropdown menu={{ items: overflowItems }} trigger={['click']}>
        <Button icon={<MoreOutlined />} size="small" />
      </Dropdown>
    </Space>
  );

  // ====== 移动端触控目标增强 ConfigProvider ======
  const mobileTheme = {
    token: {
      controlHeight: 44,
      controlHeightSM: 36,
      borderRadius: 10,
    },
  };

  // ====== 布局始终挂载 ======
  const layoutContent = (
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

      {/* ====== 移动端：左侧抽屉（图层+分析+时空+导出） ====== */}
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

      {/* ====== 移动端：底部抽屉（AI 助手） ====== */}
      {isMobile && (
        <Drawer
          title="🤖 AI 助手"
          placement="bottom"
          height="70vh"
          open={rightDrawerOpen}
          onClose={() => setRightDrawerOpen(false)}
          className="mobile-ai-drawer"
          styles={{
            body: { padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' },
            header: { padding: '12px 16px', borderBottom: '1px solid #e8e8e8' },
          }}
          closable
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
      <RechargeModal open={rechargeModalOpen} onClose={() => setRechargeModalOpen(false)} isMobile={isMobile} />
      <AdminPanel open={adminPanelOpen} onClose={() => setAdminPanelOpen(false)} />
    </Layout>
  );

  return (
    <>
      {!user && <LoginPage />}

      <div style={{ display: user ? 'flex' : 'none', height: '100vh', flexDirection: 'column' }}>
        <ErrorBoundary>
          {isMobile ? (
            <ConfigProvider theme={mobileTheme}>
              {layoutContent}
            </ConfigProvider>
          ) : layoutContent}
        </ErrorBoundary>
      </div>

      {/* ====== 移动端浮动按钮 ====== */}
      {isMobile && user && (
        <>
          <FloatButton
            icon={<MenuOutlined />}
            style={{ left: 16, bottom: 104, zIndex: 1000 }}
            onClick={() => setLeftDrawerOpen(true)}
          />
          <FloatButton
            icon={<RobotOutlined />}
            shape="circle"
            type="primary"
            badge={{ dot: true }}
            description="AI助手"
            className="ai-float-btn"
            style={{ right: 16, bottom: 104, zIndex: 1000 }}
            onClick={() => setRightDrawerOpen(true)}
          />
        </>
      )}
    </>
  );
};

export default App;
