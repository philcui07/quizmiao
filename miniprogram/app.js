App({
  globalData: {
    questions: null,
    pool: null,
    idx: 0,
    score: 0,
    wrong: [],
    pendingContent: null,
    pendingCount: null
  },

  onLaunch() {
    if (!wx.cloud) {
      console.error('请使用 2.2.3 或以上的基础库以使用云能力')
    } else {
      wx.cloud.init({
        env: 'cloud1-d1gmbknrs35a73b49',
        traceUser: true
      })
    }
  }
});
