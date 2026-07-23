/**
 * 拾知猫 v1.1.0 - CloudBase browser client.
 * User identity is resolved again inside every cloud function. The browser never
 * sends an openid/uid as an authorization credential.
 */

const CLOUDBASE_ENV_ID = 'quizmiao'; // 部署时替换为真实环境 ID

let cloudApp = null;
let cloudAuth = null;
let currentUser = null;
const ACCOUNT_ACTIVE_KEY = 'quizmiao_account_active';

const CB = {
  init() {
    if (cloudApp) return cloudApp;
    if (!globalThis.cloudbase) {
      throw new Error('CloudBase SDK 加载失败，请检查网络或 SDK 地址');
    }
    cloudApp = cloudbase.init({ env: CLOUDBASE_ENV_ID });
    cloudAuth = cloudApp.auth({ persistence: 'local' });
    return cloudApp;
  },

  async isLoggedIn() {
    try {
      this.init();
      return this._isAccountActive() && (await cloudAuth.hasLoginState()) !== null;
    } catch (e) {
      console.warn('[CloudBase] login state unavailable:', e.message);
      return false;
    }
  },

  async getCurrentUser({ refresh = false } = {}) {
    if (currentUser && !refresh) return currentUser;
    try {
      this.init();
      if (!this._isAccountActive()) return null;
      const state = await cloudAuth.getLoginState();
      if (!state) {
        currentUser = null;
        return null;
      }
      const profileResult = await this.getProfile();
      const profile = profileResult?.profile;
      if (!profileResult?.ok || !profile?.onboarded) {
        currentUser = null;
        return null;
      }
      currentUser = {
        uid: state.user?.uid || state.user?.openid || '',
        phone: profile.phone || '',
        phoneVerified: Boolean(profile.phoneVerified),
        nickname: profile.nickname || '',
        identityScope: profile.phoneVerified ? 'verified-phone' : 'device',
      };
      return currentUser;
    } catch (e) {
      currentUser = null;
      return null;
    }
  },

  async ensureDeviceIdentity() {
    try {
      this.init();
      let state = await cloudAuth.getLoginState();
      if (!state) {
        if (typeof cloudAuth.signInAnonymously !== 'function') {
          throw new Error('当前 CloudBase SDK 不支持匿名安全身份');
        }
        await cloudAuth.signInAnonymously();
        state = await cloudAuth.getLoginState();
      }
      if (!state) throw new Error('设备身份创建失败');
      return state;
    } catch (e) {
      throw new Error(e.message || '设备身份创建失败');
    }
  },

  async loginWithManualPhone(phoneNumber) {
    try {
      await this.ensureDeviceIdentity();
      const result = await this.callFunction('profile-manage', {
        action: 'updatePhone',
        phone: phoneNumber,
      });
      if (!result?.ok) return result || { ok: false, error: '登录失败' };
      this._setAccountActive(true);
      currentUser = await this.getCurrentUser({ refresh: true });
      if (!currentUser) {
        this._setAccountActive(false);
        return { ok: false, error: '账号资料读取失败，请重试' };
      }
      return { ok: true, user: currentUser };
    } catch (e) {
      return { ok: false, error: e.message || '登录失败' };
    }
  },

  async loginWithCarrier(authorization) {
    try {
      await this.ensureDeviceIdentity();
      const result = await this.callFunction('phone-auth', {
        action: 'verify',
        provider: authorization?.provider,
        token: authorization?.token,
        metadata: authorization?.metadata || {},
      });
      if (!result?.ok) return result || { ok: false, error: '一键认证失败' };
      this._setAccountActive(true);
      currentUser = await this.getCurrentUser({ refresh: true });
      if (!currentUser) {
        this._setAccountActive(false);
        return { ok: false, error: '认证成功但账号资料读取失败，请重试' };
      }
      return { ok: true, user: currentUser };
    } catch (e) {
      return { ok: false, error: e.message || '一键认证失败' };
    }
  },

  async logout() {
    // 保留 CloudBase 匿名安全身份，确保用户在同一设备重新进入后仍能找回自己的数据。
    this._setAccountActive(false);
    currentUser = null;
    return { ok: true };
  },

  _isAccountActive() {
    try {
      return localStorage.getItem(ACCOUNT_ACTIVE_KEY) === '1';
    } catch (_) {
      return false;
    }
  },

  _setAccountActive(active) {
    try {
      if (active) localStorage.setItem(ACCOUNT_ACTIVE_KEY, '1');
      else localStorage.removeItem(ACCOUNT_ACTIVE_KEY);
    } catch (_) {}
  },

  getNickname() {
    return currentUser?.nickname || '';
  },

  async setNickname(name) {
    const result = await this.callFunction('profile-manage', {
      action: 'updateNickname',
      nickname: name,
    });
    if (result.ok && currentUser) currentUser.nickname = result.profile.nickname;
    return result;
  },

  getShareNickname() {
    try {
      return localStorage.getItem('quizmiao_share_nickname') || '';
    } catch (_) {
      return '';
    }
  },

  setShareNickname(name) {
    try {
      localStorage.setItem('quizmiao_share_nickname', name);
    } catch (_) {}
  },

  async callFunction(name, data = {}) {
    this.init();
    try {
      const result = await cloudApp.callFunction({ name, data });
      return result.result;
    } catch (e) {
      console.error(`[CloudBase] callFunction ${name} error:`, e);
      throw e;
    }
  },

  async getProfile() {
    return await this.callFunction('profile-manage', { action: 'get' });
  },

  async generateQuestions(content, count) {
    return await this.callFunction('quiz-generate', { action: 'generate', content, count });
  },

  async fetchPage(url) {
    return await this.callFunction('page-fetch', { url });
  },

  async saveShare(questions, name) {
    return await this.callFunction('share-manage', {
      action: 'save',
      questions,
      name,
      trackAccount: this._isAccountActive(),
    });
  },

  async getShare(id) {
    return await this.callFunction('share-manage', { action: 'get', id });
  },

  async listMyShares(page = 1) {
    return await this.callFunction('share-manage', { action: 'list', page });
  },

  async createQuizHistory(data) {
    return await this.callFunction('history-manage', { action: 'create', ...data });
  },

  async updateQuizHistory(id, questions) {
    return await this.callFunction('history-manage', {
      action: 'updateQuestions',
      id,
      questions,
    });
  },

  async addHistoryAttempt(data) {
    return await this.callFunction('history-manage', { action: 'addAttempt', ...data });
  },

  async listHistory(page = 1) {
    return await this.callFunction('history-manage', { action: 'list', page });
  },

  async getHistoryDetail(id) {
    return await this.callFunction('history-manage', { action: 'detail', id });
  },

  async saveShareResult(data) {
    return await this.callFunction('share-result', { action: 'save', ...data });
  },

  async listShareResults(shareId) {
    return await this.callFunction('share-result', { action: 'list', shareId });
  },
};
