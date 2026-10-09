const app = getApp();

Page({
  data: {
    loading: true,
    error: '',
    detailType: 'quiz',
    detail: null,
    shareId: '',
    shareReady: false
  },

  async onLoad(options) {
    if (wx.hideShareMenu) wx.hideShareMenu();
    const type = options && options.type === 'share' ? 'share' : 'quiz';
    const id = options && options.id ? decodeURIComponent(options.id) : '';
    if (!id) {
      this.setData({ loading: false, error: '缺少记录 ID' });
      return;
    }
    await this.openDetail(type, id);
  },

  async openDetail(type, id) {
    this.setData({ loading: true, error: '', detailType: type, shareReady: false, shareId: '' });
    try {
      const action = type === 'quiz' ? 'historyDetail' : 'shareResults';
      const payload = type === 'quiz' ? { id } : { shareId: id };
      const result = await app.callProxy(action, payload);
      if (!result || !result.ok) throw new Error(result && result.error ? result.error : '加载详情失败');
      const detail = type === 'quiz' ? result.history : result.share;
      detail.questions = normalizeQuestions(detail.questions);
      const records = type === 'quiz' ? detail.attempts : result.results;
      const recordCount = (records || []).length;
      detail.records = (records || []).map((item, index) => Object.assign({}, item, {
        dateText: formatDate(item.createdAt),
        wrongCount: Number(item.wrongCount) || 0,
        scorePct: item.total ? Math.round(item.score / item.total * 100) : 0,
        titleText: type === 'share' ? item.participant : '第 ' + (recordCount - index) + ' 次练习'
      }));
      detail.dateText = formatDate(detail.createdAt);
      detail.expired = Boolean(detail.expiresAt && Date.now() >= Number(detail.expiresAt));
      this.setData({ detail, shareId: type === 'share' ? id : '' });
      wx.setNavigationBarTitle({ title: type === 'quiz' ? '练习记录' : '分享记录' });

      if (type === 'quiz') await this.prepareHistoricalShare(detail);
      else this.enableShare(id);
    } catch (err) {
      this.setData({ error: err.message || '加载详情失败' });
    } finally {
      this.setData({ loading: false });
    }
  },

  async prepareHistoricalShare(detail) {
    try {
      const result = await app.callProxy('saveQuiz', {
        questions: detail.questions,
        tags: buildTags(detail.questions),
        name: detail.title,
        historyId: detail.id,
        trackOwner: true,
        reuseExisting: true
      });
      if (result && result.ok && result.shareId) this.enableShare(result.shareId);
    } catch (err) {
      console.warn('准备历史分享失败:', err.message);
    }
  },

  enableShare(shareId) {
    this.setData({ shareId, shareReady: true });
    if (wx.showShareMenu) wx.showShareMenu({ menus: ['shareAppMessage'] });
  },

  replay() {
    const detail = this.data.detail;
    if (!detail || !detail.questions || !detail.questions.length) return;
    app.globalData.questions = detail.questions;
    app.globalData.pool = detail.questions.slice().sort(() => Math.random() - 0.5);
    app.globalData.idx = 0;
    app.globalData.score = 0;
    app.globalData.wrong = [];
    app.globalData.historyId = detail.id;
    app.globalData.quizSource = 'self';
    app.globalData.shareId = '';
    app.globalData.attemptId = app.createId('attempt');
    app.globalData.attemptSaved = false;
    wx.navigateTo({ url: '/pages/practice/practice' });
  },

  openRecord(e) {
    const item = this.data.detail.records[e.currentTarget.dataset.index];
    if (!item) return;
    wx.navigateTo({
      url: '/pages/record-detail/record-detail?type=' + this.data.detailType
        + '&id=' + encodeURIComponent(item.id)
        + '&title=' + encodeURIComponent(item.titleText)
    });
  },

  onShareAppMessage() {
    const detail = this.data.detail || {};
    const count = detail.questions ? detail.questions.length : 0;
    if (this.data.shareId) {
      const pending = app.callProxy('shareMark', { shareId: this.data.shareId })
        .catch(err => console.warn('标记分享记录失败:', err.message));
      trackHistorySync(pending);
    }
    return {
      title: '拾知猫 · ' + count + '道练习题',
      path: this.data.shareId ? '/pages/confirm/confirm?shareId=' + encodeURIComponent(this.data.shareId) : '/pages/index/index'
    };
  }
});

function buildTags(questions) {
  const counts = {};
  (questions || []).forEach(item => { counts[item.cat] = (counts[item.cat] || 0) + 1; });
  return Object.keys(counts).map(name => ({ name, count: counts[name] }));
}

function formatDate(value) {
  const date = new Date(Number(value) || 0);
  if (!value || Number.isNaN(date.getTime())) return '';
  const pad = number => String(number).padStart(2, '0');
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
}

function normalizeQuestions(questions) {
  return (questions || []).map(question => Object.assign({}, question, {
    options: (question.options || []).map(option => String(option || '').replace(/^\s*[A-D][.、:：)）]\s*/i, '').trim())
  }));
}

function trackHistorySync(promise) {
  app.globalData.historySyncPromise = promise;
  promise.finally(() => {
    if (app.globalData.historySyncPromise === promise) app.globalData.historySyncPromise = null;
  });
}
