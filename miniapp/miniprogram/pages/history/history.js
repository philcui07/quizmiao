const app = getApp();

Page({
  data: {
    pageReady: false,
    user: null,
    loginModalVisible: false,
    loginPhone: '',
    loginError: '',
    loggingIn: false,
    tab: 'quizzes',
    loading: false,
    error: '',
    quizzes: [],
    shares: [],
    hasQuizzes: false,
    hasShares: false
  },

  async onLoad() {
    if (wx.hideShareMenu) wx.hideShareMenu();
    this._initializePromise = this.initialize();
    await this._initializePromise;
  },

  async onShow() {
    if (!this._initializePromise) this._initializePromise = this.initialize();
    await this._initializePromise;
    if (this._hasShown && this.data.user) await this.loadLists({ silent: true });
    this._hasShown = true;
  },

  async initialize() {
    const user = await app.refreshUser(false);
    if (!user) {
      this.setData({ pageReady: true, user: null, error: '' });
      this.openLoginModal();
      return;
    }
    await waitForPendingSync();
    const cached = readHistoryCache(user.phone);
    const hasCachedOverview = cached && Array.isArray(cached.quizzes) && Array.isArray(cached.shares);
    if (hasCachedOverview) {
      this.setData({
        pageReady: true,
        user,
        quizzes: cached.quizzes || [],
        shares: cached.shares || [],
        hasQuizzes: Boolean(cached.quizzes && cached.quizzes.length),
        hasShares: Boolean(cached.shares && cached.shares.length),
        error: ''
      });
      this.loadLists({ silent: true });
      return;
    }
    try {
      const lists = await this.fetchLists();
      this.setData({
        pageReady: true,
        user,
        quizzes: lists.quizzes,
        shares: lists.shares,
        hasQuizzes: lists.quizzes.length > 0,
        hasShares: lists.shares.length > 0,
        error: ''
      });
      writeHistoryCache(user.phone, lists);
    } catch (err) {
      this.setData({ pageReady: true, user, error: err.message || '加载失败' });
    }
  },

  openLoginModal() {
    this.setData({ loginModalVisible: true, loginPhone: '', loginError: '' });
  },

  closeLoginModal() {
    if (!this.data.loggingIn) this.setData({ loginModalVisible: false, loginError: '' });
  },

  onLoginPhoneInput(e) {
    this.setData({ loginPhone: String(e.detail.value || '').replace(/\D/g, '').slice(0, 11), loginError: '' });
  },

  async submitPhoneLogin() {
    const phone = String(this.data.loginPhone || '').trim();
    if (!/^1\d{10}$/.test(phone)) {
      this.setData({ loginError: '请输入以 1 开头的 11 位手机号' });
      return;
    }
    this.setData({ loggingIn: true });
    try {
      const result = await app.loginWithPhone(phone);
      this.setData({ pageReady: true, user: result.profile, loginModalVisible: false, loginError: '' });
      wx.showToast({ title: result.registered ? '注册成功' : '登录成功', icon: 'success' });
      await this.loadLists();
    } catch (err) {
      this.setData({ loginError: err.message || '登录失败' });
    } finally {
      this.setData({ loggingIn: false });
    }
  },

  switchTab(e) {
    const tab = e.currentTarget.dataset.tab;
    if (tab === this.data.tab) return;
    this.setData({ tab, error: '' });
  },

  async fetchLists() {
    const result = await app.callProxy('historyOverview', { pageSize: 50 });
    if (!result || !result.ok) throw new Error(result && result.error ? result.error : '加载失败');
    return {
      quizzes: formatList(result.quizzes, 'quizzes'),
      shares: formatList(result.shares, 'shares')
    };
  },

  async loadLists(options) {
    if (!this.data.user) return;
    const silent = options && options.silent;
    if (!silent) this.setData({ loading: true, error: '' });
    try {
      const lists = await this.fetchLists();
      const update = {};
      if (!sameList(this.data.quizzes, lists.quizzes)) update.quizzes = lists.quizzes;
      if (!sameList(this.data.shares, lists.shares)) update.shares = lists.shares;
      update.hasQuizzes = lists.quizzes.length > 0;
      update.hasShares = lists.shares.length > 0;
      if (Object.keys(update).length) this.setData(update);
      writeHistoryCache(this.data.user.phone, lists);
    } catch (err) {
      if (!silent || (!this.data.quizzes.length && !this.data.shares.length)) {
        this.setData({ error: err.message || '加载失败' });
      }
    } finally {
      if (!silent) this.setData({ loading: false });
    }
  },

  async openQuiz(e) {
    wx.navigateTo({ url: '/pages/history-detail/history-detail?type=quiz&id=' + encodeURIComponent(e.currentTarget.dataset.id) });
  },

  async openShare(e) {
    wx.navigateTo({ url: '/pages/history-detail/history-detail?type=share&id=' + encodeURIComponent(e.currentTarget.dataset.id) });
  }
});

function formatList(list, tab) {
  return (list || []).map(item => Object.assign({}, item, {
      dateText: formatDate(item.createdAt),
      expired: Boolean(item.expiresAt && Date.now() >= Number(item.expiresAt)),
      scoreText: tab === 'quizzes' && item.lastAttempt ? item.lastAttempt.score + '/' + item.lastAttempt.total : '暂无练习'
    }));
}

function formatDate(value) {
  const date = new Date(Number(value) || 0);
  if (!value || Number.isNaN(date.getTime())) return '';
  const pad = number => String(number).padStart(2, '0');
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
}

async function waitForPendingSync() {
  const pending = app.globalData.historySyncPromise;
  if (!pending || typeof pending.then !== 'function') return;
  try {
    await pending;
  } catch (_) {
    // The list request below remains the source of truth and reports its own error.
  }
}

function historyCacheKey(phone) {
  return 'shizhimao_history_cache_' + String(phone || '');
}

function readHistoryCache(phone) {
  if (!phone || !wx.getStorageSync) return null;
  const value = wx.getStorageSync(historyCacheKey(phone));
  return value && typeof value === 'object' ? value : null;
}

function writeHistoryCache(phone, lists) {
  if (!phone || !wx.setStorageSync) return;
  wx.setStorageSync(historyCacheKey(phone), {
    quizzes: lists.quizzes || [],
    shares: lists.shares || [],
    updatedAt: Date.now()
  });
}

function sameList(left, right) {
  return JSON.stringify(left || []) === JSON.stringify(right || []);
}
