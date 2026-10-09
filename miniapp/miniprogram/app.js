App({
  globalData: {
    questions: null,
    pool: null,
    idx: 0,
    score: 0,
    wrong: [],
    pendingContent: null,
    pendingCount: null,
    user: null,
    userReady: false,
    historyId: '',
    quizSource: 'self',
    shareId: '',
    attemptId: '',
    attemptSaved: false
  },

  onLaunch() {
    if (!wx.cloud) {
      console.error('请使用 2.2.3 或以上的基础库以使用云能力')
    } else {
      wx.cloud.init({
        env: 'cloud1-d1gmbknrs35a73b49',
        traceUser: true
      });
      const phone = String(wx.getStorageSync('shizhimao_account_phone') || '');
      const cached = wx.getStorageSync('shizhimao_profile_cache');
      if (phone && cached && cached.phone === phone) this.globalData.user = cached;
      this.refreshUser();
    }
  },

  callProxy(action, data, timeout) {
    const accountPhone = this.globalData.user && this.globalData.user.phone
      ? this.globalData.user.phone
      : String(wx.getStorageSync('shizhimao_account_phone') || '');
    return new Promise((resolve, reject) => {
      wx.cloud.callFunction({
        name: 'proxy',
        data: Object.assign({ action, accountPhone }, data || {}),
        timeout: timeout || 60000,
        success(res) {
          if (res.result !== undefined && res.result !== null) resolve(res.result);
          else reject(new Error('云函数返回空结果'));
        },
        fail(err) {
          reject(new Error(err.errMsg || '云函数调用失败'));
        }
      });
    });
  },

  async refreshUser(force) {
    if (!force && this.globalData.userReady) return this.globalData.user;
    if (this._userRefreshPromise) return this._userRefreshPromise;
    const accountPhone = String(wx.getStorageSync('shizhimao_account_phone') || '');
    if (!accountPhone) {
      this.globalData.user = null;
      this.globalData.userReady = true;
      return null;
    }
    this._userRefreshPromise = (async () => {
      try {
        const result = await this.callProxy('profileGet');
        if (result && result.ok && result.profile) {
          this.globalData.user = result.profile;
          wx.setStorageSync('shizhimao_profile_cache', result.profile);
        }
      } catch (_) {
        // 网络异常时保留已验证的本地资料，避免页面退回默认状态。
      }
      this.globalData.userReady = true;
      return this.globalData.user;
    })();
    try {
      return await this._userRefreshPromise;
    } finally {
      this._userRefreshPromise = null;
    }
  },

  async loginWithPhone(phone) {
    const normalized = String(phone || '').trim();
    if (!/^1\d{10}$/.test(normalized)) throw new Error('请输入以 1 开头的 11 位手机号');
    const result = await this.callProxy('profileLogin', { accountPhone: normalized });
    if (!result || !result.ok || !result.profile) {
      throw new Error(result && result.error ? result.error : '手机号登录失败');
    }
    wx.setStorageSync('shizhimao_account_phone', normalized);
    wx.setStorageSync('shizhimao_profile_cache', result.profile);
    this.globalData.user = result.profile;
    this.globalData.userReady = true;
    return {
      profile: result.profile,
      registered: result.registered === true
    };
  },

  getPrivacySetting() {
    return new Promise(resolve => {
      if (!wx.getPrivacySetting) {
        resolve({ needAuthorization: false, privacyContractName: '' });
        return;
      }
      wx.getPrivacySetting({
        success(result) {
          const contractName = String(result.privacyContractName || '拾知猫小程序隐私保护指引')
            .replace(/^《+|》+$/g, '');
          resolve({
            needAuthorization: result.needAuthorization === true,
            privacyContractName: contractName
          });
        },
        fail() {
          resolve({ needAuthorization: true, privacyContractName: '拾知猫小程序隐私保护指引' });
        }
      });
    });
  },

  phoneAuthorizationError(detail) {
    const message = String(detail && detail.errMsg || '');
    const code = String(detail && (detail.errCode || detail.errno || detail.code) || '');
    console.warn('[手机号快捷验证失败]', { errMsg: message, errCode: code });
    if (/deny|cancel/i.test(message)) return '你已取消手机号授权，无法完成注册登录';
    if (/privacy/i.test(message)) return '请先阅读并同意隐私保护指引';
    if (/develop|simulator|工具/i.test(message)) return '开发工具无法完成手机号验证，请使用真机预览或真机调试';
    if (/permission|not supported|not support|scope/i.test(message)) {
      return '手机号快捷验证不可用，请检查小程序主体认证和接口权限，并使用中国大陆实名微信在真机重试';
    }
    return '未获得微信手机号授权，请重新点击登录';
  },

  logout() {
    wx.removeStorageSync('shizhimao_account_phone');
    wx.removeStorageSync('shizhimao_profile_cache');
    this.globalData.user = null;
    this.globalData.userReady = true;
  },

  maskPhone(phone) {
    return String(phone || '').replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2');
  },

  createId(prefix) {
    return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 12);
  }
});
