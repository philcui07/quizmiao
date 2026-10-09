/**
 * 拾知猫 Web 运营商一键认证 adapter registry。
 * 供应商脚本只负责取得一次性 token；手机号必须由 CloudBase 服务端校验 token 后返回。
 */
const PhoneAuth = {
  _adapters: new Map(),

  registerAdapter(name, adapter) {
    const provider = String(name || '').trim();
    if (!provider || !adapter || typeof adapter.authorize !== 'function') {
      throw new Error('无效的一键认证 adapter');
    }
    this._adapters.set(provider, adapter);
  },

  getStatus() {
    const config = globalThis.QUIZMIAO_PHONE_AUTH_CONFIG || {};
    if (!config.enabled || !config.provider) {
      return { available: false, reason: '当前未配置运营商一键认证' };
    }
    if (!this._adapters.has(config.provider)) {
      return { available: false, reason: '运营商认证组件尚未加载' };
    }
    return { available: true, provider: config.provider };
  },

  async authorize() {
    const status = this.getStatus();
    if (!status.available) throw new Error(status.reason);

    const config = globalThis.QUIZMIAO_PHONE_AUTH_CONFIG;
    const result = await this._adapters.get(config.provider).authorize({
      appId: config.appId || '',
    });
    const token = String(result?.token || '').trim();
    if (!token) throw new Error('运营商未返回有效认证凭证');

    return {
      provider: config.provider,
      token,
      metadata: result?.metadata || {},
    };
  },
};
