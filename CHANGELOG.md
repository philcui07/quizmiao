# Changelog

## v1.1.0-dev - 2026-07-23

### Fixed

- 修复移动端 CloudBase SDK 临时地址返回 HTTP 418，改用腾讯官方 `static.cloudbase.net` CDN。
- Web 与部署配置改为复用现有 CloudBase 环境 `cloud1-d1gmbknrs35a73b49`，移除不可用的占位环境 ID。
- 将安全域名、环境未开通、云函数未部署和网络失败转换为可执行的连接错误提示。

### Added

- CloudBase 匿名安全身份、设备账号资料和云端昵称。
- 可配置的 Web 运营商一键认证 provider adapter 与服务端 `phone-auth` token 校验。
- 未配置或认证失败时的手动手机号回退，以及登录成功后返回历史页的路由守卫。
- 一次出题对应一个题集，题集下保存多次练习成绩和错题集。
- 分享命名、24 小时有效期和被分享人本机昵称复用。
- “我的分享”及好友答题成绩、正确率和错题集详情。
- `profile-manage`、`quiz_attempts` 集合及 CloudBase 部署手册。

### Changed

- Web 业务后端从 Vercel 迁移到 CloudBase 云函数。
- 云函数从服务端认证上下文读取账号身份，不再信任客户端用户 ID。
- 数据集合关闭客户端直读直写。
- 网页抓取增加协议、端口、DNS 和内网地址校验。
- 历史入口改为始终可见；未登录访问时先完成设备账号登录。
- 账号数据使用 canonical owner 映射，只有服务端运营商认证成功的号码支持跨设备归并。

### Security

- 手动手机号仅为未验证资料字段，绝不作为 owner ID、查询条件或数据授权凭据。
- 运营商 token 只在 CloudBase 云函数校验，号码绑定使用服务端 HMAC。
- 数据访问继续以 CloudBase 服务端认证上下文为准；输入他人手机号不能读取其历史。

### Removed

- 移除短信验证码字段、倒计时、CloudBase `getVerification` / `signInWithSms` 调用及短信购买依赖。

### Compatibility

- 保留 v1.0.1 `#q=` 长链接读取兼容。
- `proxy/` 仅作为 v1.0.1 迁移参考，不属于 v1.1.0 运行链路。

## v1.0.1 - frozen

- 基础文本/链接出题、练习、结果和 Vercel 临时分享。
- 该版本不再修改。
