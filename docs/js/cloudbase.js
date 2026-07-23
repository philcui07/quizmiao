/**
 * 拾知猫 v1.1.0 - CloudBase browser client.
 * User identity is resolved again inside every cloud function. The browser never
 * sends an openid/uid as an authorization credential.
 */

const CLOUDBASE_ENV_ID = 'quizmiao'; // 部署时替换为真实环境 ID

let cloudApp = null;
let cloudAuth = null;
let currentUser = null;

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
      return (await cloudAuth.hasLoginState()) !== null;
    } catch (e) {
      console.warn('[CloudBase] login state unavailable:', e.message);
      return false;
    }
  },

  async getCurrentUser({ refresh = false } = {}) {
    if (currentUser && !refresh) return currentUser;
    try {
      this.init();
      const state = await cloudAuth.getLoginState();
      if (!state) {
        currentUser = null;
        return null;
      }
      currentUser = {
        uid: state.user?.uid || state.user?.openid || '',
        phone: state.user?.phone || state.user?.phone_number || '',
        nickname: '',
      };
      const profile = await this.getProfile().catch(() => null);
      if (profile?.ok) currentUser.nickname = profile.profile?.nickname || '';
      return currentUser;
    } catch (e) {
      currentUser = null;
      return null;
    }
  },

  async sendSMSCode(phoneNumber) {
    try {
      this.init();
      const verificationInfo = await cloudAuth.getVerification({
        phone_number: '+86 ' + phoneNumber,
      });
      return { ok: true, verificationInfo };
    } catch (e) {
      return { ok: false, error: e.message || '验证码发送失败' };
    }
  },

  async loginWithSMSCode(phoneNumber, code, verificationInfo) {
    if (!verificationInfo) {
      return { ok: false, error: '请先获取验证码' };
    }
    try {
      this.init();
      await cloudAuth.signInWithSms({
        verificationInfo,
        verificationCode: code,
      });
      currentUser = await this.getCurrentUser({ refresh: true });
      if (currentUser && !currentUser.phone) currentUser.phone = phoneNumber;
      return { ok: true, user: currentUser };
    } catch (e) {
      return { ok: false, error: e.message || '登录失败' };
    }
  },

  async logout() {
    try {
      this.init();
      await cloudAuth.signOut();
      currentUser = null;
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message || '退出失败' };
    }
  },

  getNickname() {
    return currentUser?.nickname || '';
  },

  async setNickname(name) {
    const result = await this.callFunction('profile-manage', {
      action: 'update',
      nickname: name,
    });
    if (result.ok && currentUser) currentUser.nickname = result.profile.nickname;
    return result;
  },

  getShareNickname() {
    return localStorage.getItem('quizmiao_share_nickname') || '';
  },

  setShareNickname(name) {
    localStorage.setItem('quizmiao_share_nickname', name);
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
    return await this.callFunction('share-manage', { action: 'save', questions, name });
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
