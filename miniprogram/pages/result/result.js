const app = getApp();

Page({
  data: {
    score: 0, total: 0, pct: 0, wrong: []
  },

  onLoad() {
    const g = app.globalData;
    const total = g.pool ? g.pool.length : 0;
    const score = g.score || 0;
    const pct = total > 0 ? Math.round(score / total * 100) : 0;
    this.setData({
      score, total, pct,
      wrong: g.wrong || []
    });
  },

  retry() {
    const g = app.globalData;
    g.pool = [...(g.questions || [])].sort(() => Math.random() - 0.5);
    g.idx = 0; g.score = 0; g.wrong = [];
    wx.redirectTo({ url: '/pages/practice/practice' });
  },

  goConfirm() {
    wx.navigateBack({ delta: 2 });
  },

  goHome() {
    wx.navigateBack({ delta: 3 });
  }
});
