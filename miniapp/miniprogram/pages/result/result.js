const app = getApp();

Page({
  data: {
    score: 0, total: 0, pct: 0, wrong: []
  },

  async onLoad() {
    const g = app.globalData;
    const total = g.pool ? g.pool.length : 0;
    const score = g.score || 0;
    const pct = total > 0 ? Math.round(score / total * 100) : 0;
    this.setData({
      score, total, pct,
      wrong: g.wrong || []
    });
    await this.saveAttempt();
  },

  async saveAttempt() {
    const g = app.globalData;
    if (g.attemptSaved || !g.attemptId) return;
    g.attemptSaved = true;
    const payload = {
      attemptId: g.attemptId,
      score: g.score || 0,
      total: g.pool ? g.pool.length : 0,
      wrongAnswers: g.wrong || []
    };
    try {
      let pending = null;
      if (g.quizSource === 'shared' && g.shareId) {
        pending = app.callProxy('shareResultSave', Object.assign({
          shareId: g.shareId,
          participantName: g.participantName || ''
        }, payload));
      } else if (g.historyId && app.globalData.user) {
        pending = app.callProxy('historyAttemptAdd', Object.assign({ historyId: g.historyId }, payload));
      }
      if (pending) {
        g.historySyncPromise = pending;
        try {
          await pending;
        } finally {
          if (g.historySyncPromise === pending) g.historySyncPromise = null;
        }
      }
    } catch (e) {
      g.attemptSaved = false;
      console.warn('保存练习记录失败:', e.message);
    }
  },

  retry() {
    const g = app.globalData;
    g.pool = [...(g.questions || [])].sort(() => Math.random() - 0.5);
    g.idx = 0; g.score = 0; g.wrong = [];
    g.attemptId = app.createId('attempt');
    g.attemptSaved = false;
    wx.redirectTo({ url: '/pages/practice/practice' });
  },

  goConfirm() {
    wx.navigateBack({ delta: 2 });
  },

  goHome() {
    wx.navigateBack({ delta: 3 });
  }
});
