/**
 * 拾知猫 v1.1.0 - CloudBase browser client.
 * The phone number is the product account id. CloudBase anonymous identity is
 * used only to pass the callable-function gateway.
 */

const CLOUDBASE_ENV_ID = 'quizmiao-web-d7g9642jpcaa90745';
const ACCOUNT_PHONE_KEY = 'quizmiao_account_phone';

let cloudApp = null;
let cloudAuth = null;
let currentUser = null;

function normalizeAccountPhone(value) {
  const phone = String(value || '').trim();
  return /^1\d{10}$/.test(phone) ? phone : '';
}

function cloudBaseErrorMessage(error, fallback = '服务连接失败，请稍后重试') {
  const code = String(error?.code || error?.errorCode || '');
  const message = String(error?.message || error?.errorMessage || '');
  const detail = `${code} ${message}`.toLowerCase();

  if (/anonymous|匿名/.test(detail) && /disabled|not enabled|not open|未开启|未启用/.test(detail)) {
    return 'CloudBase 匿名登录尚未启用';
  }
  if (/domain|origin|referer|cors|illegal_domain|invalid_domain/.test(detail)) {
    return '当前网站域名尚未加入 CloudBase Web 安全域名';
  }
  if (/env|environment/.test(detail) && /not found|not exist|invalid|illegal|不存在|无效/.test(detail)) {
    return 'CloudBase 环境未开通或环境 ID 不正确';
  }
  if (/function/.test(detail) && /not found|not exist|不存在/.test(detail)) {
    return '后端云函数尚未部署';
  }
  if (/network|fetch|timeout|timed out|connection|load failed|网络|超时/.test(detail)) {
    return '无法连接 CloudBase，请检查网络后重试';
  }
  if (/permission|forbidden|unauthorized|access denied|无权限/.test(detail)) {
    return 'CloudBase 身份认证未启用或当前来源无权限';
  }
  return message || fallback;
}

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
    return Boolean(this._getAccountPhone());
  },

  async getCurrentUser({ refresh = false } = {}) {
    if (currentUser && !refresh) return currentUser;
    const phone = this._getAccountPhone();
    if (!phone) return null;

    try {
      const result = await this.getProfile();
      if (!result?.ok || !result.profile) {
        this._setAccountPhone('');
        currentUser = null;
        return null;
      }
      return this._setCurrentUser(result.profile, phone);
    } catch (_) {
      currentUser = null;
      return null;
    }
  },

  async ensureGatewayIdentity() {
    try {
      this.init();
      let state = await cloudAuth.getLoginState();
      if (!state) {
        if (typeof cloudAuth.signInAnonymously === 'function') {
          const result = await cloudAuth.signInAnonymously();
          if (result?.error) throw result.error;
        } else {
          const provider = typeof cloudAuth.anonymousAuthProvider === 'function'
            ? cloudAuth.anonymousAuthProvider()
            : null;
          if (!provider || typeof provider.signIn !== 'function') {
            throw new Error('当前 CloudBase SDK 不支持匿名安全身份');
          }
          await provider.signIn();
        }
        state = await cloudAuth.getLoginState();
      }
      if (!state) throw new Error('网关身份创建失败');
      return state;
    } catch (e) {
      throw new Error(cloudBaseErrorMessage(e, '网关身份创建失败'));
    }
  },

  async loginWithManualPhone(phoneNumber) {
    const phone = normalizeAccountPhone(phoneNumber);
    if (!phone) return { ok: false, error: '请输入正确的手机号' };

    try {
      const result = await this.callFunction('profile-manage', {
        action: 'login',
        phone,
      });
      if (!result?.ok) return result || { ok: false, error: '登录失败' };
      this._setAccountPhone(phone);
      currentUser = this._setCurrentUser(result.profile, phone);
      return currentUser
        ? { ok: true, user: currentUser }
        : { ok: false, error: '账号资料读取失败，请重试' };
    } catch (e) {
      return { ok: false, error: e.message || '登录失败' };
    }
  },

  async loginWithCarrier() {
    return { ok: false, error: '当前未配置运营商一键认证' };
  },

  async logout() {
    this._setAccountPhone('');
    currentUser = null;
    return { ok: true };
  },

  _setCurrentUser(profile, fallbackPhone = '') {
    const phone = normalizeAccountPhone(profile?.phone || fallbackPhone);
    if (!phone) return null;
    const user = {
      uid: phone,
      accountId: phone,
      phone,
      phoneVerified: false,
      nickname: String(profile?.nickname || ''),
      identityScope: 'phone',
    };
    this._setAccountPhone(phone);
    currentUser = user;
    return user;
  },

  _setAccountPhone(phone) {
    try {
      const normalized = normalizeAccountPhone(phone);
      if (normalized) localStorage.setItem(ACCOUNT_PHONE_KEY, normalized);
      else localStorage.removeItem(ACCOUNT_PHONE_KEY);
    } catch (_) {}
  },

  _getAccountPhone() {
    if (currentUser?.phone) return normalizeAccountPhone(currentUser.phone);
    try {
      return normalizeAccountPhone(localStorage.getItem(ACCOUNT_PHONE_KEY));
    } catch (_) {
      return '';
    }
  },

  getNickname() {
    return currentUser?.nickname || '';
  },

  async setNickname(name) {
    const result = await this.callFunction('profile-manage', {
      action: 'updateNickname',
      nickname: name,
    });
    if (result?.ok && currentUser) currentUser.nickname = result.profile.nickname;
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
      await this.ensureGatewayIdentity();
      const accountPhone = this._getAccountPhone();
      const payload = accountPhone && !data.accountPhone
        ? { ...data, accountPhone }
        : data;
      const result = await cloudApp.callFunction({ name, data: payload });
      return result.result;
    } catch (e) {
      console.error(`[CloudBase] callFunction ${name} error:`, e);
      throw new Error(cloudBaseErrorMessage(e, '后端服务调用失败，请稍后重试'));
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
      trackAccount: Boolean(this._getAccountPhone()),
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
