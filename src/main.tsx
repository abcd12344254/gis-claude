import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConfigProvider, theme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import App from './App';
import './App.css';

// ====== 微信兼容 polyfills ======
// 微信内置浏览器版本较老，缺少 ES2022+ API
if (!(Object as any).hasOwn) {
  (Object as any).hasOwn = (obj: object, prop: string) =>
    Object.prototype.hasOwnProperty.call(obj, prop);
}

// ====== 微信调试：捕获全局错误并显示在页面上 ======
if (navigator.userAgent.includes('MicroMessenger')) {
  const errorBox = document.createElement('div');
  errorBox.id = '__wx_error_log__';
  errorBox.style.cssText =
    'position:fixed;bottom:0;left:0;right:0;max-height:40vh;overflow:auto;' +
    'background:#fff2f0;border-top:3px solid #ff4d4f;padding:10px 14px;' +
    'font-size:11px;font-family:monospace;z-index:99999;color:#cf1322;display:none';
  document.body.appendChild(errorBox);

  const showError = (msg: string) => {
    errorBox.style.display = 'block';
    errorBox.innerHTML += `<div style="margin:2px 0;border-bottom:1px solid #ffccc7;padding-bottom:2px">${msg}</div>`;
  };

  window.addEventListener('error', (e) => {
    showError(`🛑 ${e.message}  @ ${e.filename}:${e.lineno}`);
  });
  window.addEventListener('unhandledrejection', (e) => {
    showError(`🔥 Promise: ${e.reason?.message || String(e.reason)}`);
  });
  // 页面加载成功后隐藏（无报错时不可见）
  setTimeout(() => {
    if (errorBox.innerHTML === '') errorBox.style.display = 'none';
  }, 3000);
  console.log('[WX] 微信环境检测已启用，错误将显示在页面底部');
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: theme.defaultAlgorithm,
        token: {
          colorPrimary: '#1677ff',
          borderRadius: 8,
        },
      }}
    >
      <App />
    </ConfigProvider>
  </React.StrictMode>
);
