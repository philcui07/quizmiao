const app = getApp();

Page({
  data: {
    pageReady: false,
    user: null,
    phoneDisplay: '',
    avatarText: '拾',
    loginPhone: '',
    loginError: '',
    loggingIn: false,
    nicknameModalVisible: false,
    nicknameInput: '',
    nicknameSaving: false
  },

  async onShow() {
    this.setData({ pageReady: false });
    const user = await app.refreshUser(true);
    this.setData({
      pageReady: true,
      user,
      phoneDisplay: user ? app.maskPhone(user.phone) : '',
      avatarText: user ? String(user.nickname || '拾').slice(0, 1) : '拾',
      loginError: ''
    });
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
      this.setData({
        user: result.profile,
        phoneDisplay: app.maskPhone(result.profile.phone),
        avatarText: String(result.profile.nickname || '拾').slice(0, 1),
        loginPhone: '',
        loginError: ''
      });
      wx.showToast({ title: result.registered ? '注册成功' : '登录成功', icon: 'success' });
    } catch (err) {
      this.setData({ loginError: err.message || '登录失败' });
    } finally {
      this.setData({ loggingIn: false });
    }
  },

  openNicknameModal() {
    if (!this.data.user) return;
    this.setData({ nicknameModalVisible: true, nicknameInput: this.data.user.nickname || '' });
  },

  closeNicknameModal() {
    if (!this.data.nicknameSaving) this.setData({ nicknameModalVisible: false });
  },

  onNicknameInput(e) {
    this.setData({ nicknameInput: e.detail.value });
  },

  async saveNickname() {
    const nickname = String(this.data.nicknameInput || '').trim();
    if (!nickname) {
      wx.showToast({ title: '请输入昵称', icon: 'none' });
      return;
    }
    this.setData({ nicknameSaving: true });
    try {
      const result = await app.callProxy('profileUpdateNickname', { nickname });
      if (!result || !result.ok || !result.profile) throw new Error(result && result.error ? result.error : '昵称保存失败');
      app.globalData.user = result.profile;
      if (wx.setStorageSync) wx.setStorageSync('shizhimao_profile_cache', result.profile);
      this.setData({ user: result.profile, avatarText: nickname.slice(0, 1), nicknameModalVisible: false });
      wx.showToast({ title: '昵称已保存', icon: 'success' });
    } catch (err) {
      wx.showToast({ title: err.message || '昵称保存失败', icon: 'none' });
    } finally {
      this.setData({ nicknameSaving: false });
    }
  },

  logout() {
    app.logout();
    this.setData({ user: null, phoneDisplay: '', avatarText: '拾', loginPhone: '', loginError: '' });
    wx.showToast({ title: '已退出登录', icon: 'none' });
  }
});
