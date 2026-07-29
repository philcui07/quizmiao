// 拾知猫 - 运营商手机号认证尚未接入

exports.main = async () => ({
  ok: false,
  code: 'PROVIDER_NOT_CONFIGURED',
  error: '运营商认证尚未配置',
  fallback: true,
});
