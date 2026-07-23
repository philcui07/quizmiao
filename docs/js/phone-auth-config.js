/**
 * Web 运营商一键认证部署配置。
 *
 * 默认关闭：普通浏览器不能直接读取 SIM 手机号。选定认证供应商后，
 * 由供应商接入脚本注册同名 adapter，再把 enabled 改为 true。
 */
globalThis.QUIZMIAO_PHONE_AUTH_CONFIG = Object.freeze({
  enabled: false,
  provider: '',
  appId: '',
});
