const app = getApp();

Page({
  data: {
    url: app.globalData.webUrl
  },

  onLoad() {
    // 你可以根据环境切换 URL
    // 本地开发用局域网 IP，生产用 HTTPS 域名
    this.setData({
      url: app.globalData.webUrl
    });
  },

  // web-view 加载完成
  onWebviewLoad(e) {
    console.log('Web 应用加载完成', e);
  },

  // web-view 加载失败
  onWebviewError(e) {
    console.error('Web 应用加载失败', e);
    wx.showToast({
      title: '页面加载失败，请检查网络',
      icon: 'none'
    });
  }
});
