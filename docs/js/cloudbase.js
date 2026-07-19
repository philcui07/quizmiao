/**
 * 拾知猫 v1.1.0 — CloudBase API 模块
 * 替代 v1.0.1 的 Vercel 后端代理
 *
 * 功能：
 * - CloudBase SDK 初始化
 * - 短信验证码登录（CloudBase 内置）
 * - 用户昵称管理
 * - 云函数调用封装
 * - 分享数据管理（24h时效）
 * - 历史记录管理
 * - 分享答题记录同步
 */

// CloudBase 环境ID（部署后在 CloudBase 控制台获取，替换此处）
const CLOUDBASE_ENV_ID = 'quizmiao'; // ← 部署时替换为实际环境ID

let cloudApp = null;
let cloudAuth = null;
let currentUser = null;

const CB = {
  /* ==============================================
     CloudBase 初始化
     ============================================== */
  init() {
    if (cloudApp) return cloudApp;
    cloudApp = cloudbase.init({ env: CLOUDBASE_ENV_ID });
    cloudAuth = cloudApp.auth({ persistence: 'local' });
    return cloudApp;
  },

  /* ==============================================
     登录状态
     ============================================== */
  async isLoggedIn() {
    this.init();
    const state = await cloudAuth.hasLoginState();
    return state !== null;
  },

  async getCurrentUser() {
    if (currentUser) return currentUser;
    this.init();
    try {
      const state = await cloudAuth.getLoginState();
      if (!state) return null;
      currentUser = {
        openid: state.user?.uid || state.user?.openid || '',
        phone: state.user?.phone || '',
      };
      return currentUser;
    } catch (e) {
      return null;
    }
  },

  /* ==============================================
     短信验证码登录
     ============================================== */

  // 发送验证码
  async sendSMSCode(phoneNumber) {
    this.init();
    try {
      const verificationInfo = await cloudAuth.getVerification({
        phone_number: '+86 ' + phoneNumber,
      });
      return { ok: true, verificationInfo };
    } catch (e) {
      return { ok: false, error: e.message || '验证码发送失败' };
    }
  },

  // 验证码登录
  async loginWithSMSCode(phoneNumber, code, verificationInfo) {
    this.init();
    try {
      const loginState = await cloudAuth.signInWithSms({
        verificationInfo,
        verificationCode: code,
        phoneNum: '+86 ' + phoneNumber,
      });
      currentUser = {
        openid: loginState?.user?.uid || '',
        phone: phoneNumber,
      };
      return { ok: true, user: currentUser };
    } catch (e) {
      return { ok: false, error: e.message || '登录失败' };
    }
  },

  // 登出
  async logout() {
    this.init();
    try {
      await cloudAuth.signOut();
      currentUser = null;
      localStorage.removeItem('quizmiao_nickname');
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },

  /* ==============================================
     昵称管理（本地存储 + 可选同步到 DB）
     ============================================== */
  getNickname() {
    return localStorage.getItem('quizmiao_nickname') || '';
  },

  setNickname(name) {
    localStorage.setItem('quizmiao_nickname', name);
  },

  /* ==============================================
     被分享人昵称（跨链接复用）
     ============================================== */
  getShareNickname() {
    return localStorage.getItem('quizmiao_share_nickname') || '';
  },

  setShareNickname(name) {
    localStorage.setItem('quizmiao_share_nickname', name);
  },

  /* ==============================================
     云函数调用封装
     ============================================== */
  async callFunction(name, data) {
    this.init();
    // 注入用户信息
    const user = await this.getCurrentUser();
    const fullData = {
      ...data,
      userInfo: user ? { openid: user.openid, phone: user.phone } : null,
    };
    try {
      const result = await cloudApp.callFunction({
        name,
        data: fullData,
      });
      return result.result;
    } catch (e) {
      console.error(`[CloudBase] callFunction ${name} error:`, e);
      throw e;
    }
  },

  /* ==============================================
     业务 API
     ============================================== */

  // AI 出题
  async generateQuestions(content, count) {
    return await this.callFunction('quiz-generate', {
      action: 'generate',
      content,
      count,
    });
  },

  // 网页抓取
  async fetchPage(url) {
    return await this.callFunction('page-fetch', { url });
  },

  // 保存分享（v1.1.0: 带24h时效 + 命名）
  async saveShare(questions, name) {
    return await this.callFunction('share-manage', {
      action: 'save',
      questions,
      name,
    });
  },

  // 获取分享
  async getShare(id) {
    return await this.callFunction('share-manage', {
      action: 'get',
      id,
    });
  },

  // 列出我的分享
  async listMyShares() {
    return await this.callFunction('share-manage', {
      action: 'list',
    });
  },

  // 保存练习历史
  async saveHistory(data) {
    return await this.callFunction('history-manage', {
      action: 'save',
      ...data,
    });
  },

  // 历史列表
  async listHistory(page = 1) {
    return await this.callFunction('history-manage', {
      action: 'list',
      page,
    });
  },

  // 历史详情
  async getHistoryDetail(id) {
    return await this.callFunction('history-manage', {
      action: 'detail',
      id,
    });
  },

  // 保存分享答题结果（被分享人做完后）
  async saveShareResult(data) {
    return await this.callFunction('share-result', {
      action: 'save',
      ...data,
    });
  },

  // 查看分享的答题记录（分享人查看）
  async listShareResults(shareId) {
    return await this.callFunction('share-result', {
      action: 'list',
      shareId,
    });
  },
};
