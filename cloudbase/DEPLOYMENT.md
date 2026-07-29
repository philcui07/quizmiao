# 拾知猫 v1.1.0 CloudBase 部署手册

本手册对应 Web v1.1.0-dev。业务后端全部运行在腾讯云 CloudBase，Vercel 和短信验证码均不属于 v1.1.0 运行链路。

## 1. Web 手机号账号边界

普通 Chrome、Safari、Edge、Firefox 和微信内置浏览器没有标准 API 可以直接读取 SIM 手机号。

- Credential Management API 管理密码、联合身份和通行密钥等凭据，不提供 SIM 手机号读取能力：<https://developer.mozilla.org/en-US/docs/Web/API/Credential_Management_API>
- WebOTP API 只读取应用发送的短信一次性验证码，仍需要短信发送和服务端验证码校验，不能返回本机手机号：<https://developer.mozilla.org/en-US/docs/Web/API/WebOTP_API>
- Web 一键认证必须采购运营商或聚合认证产品。供应商前端 SDK 获取短期 token，CloudBase 服务端再用密钥校验 token 并换取手机号。

v1.1.0 采用最小可用账号方案：用户输入以 `1` 开头的 11 位手机号，手机号本身就是账号 ID。不发送短信、不校验号码归属、不绑定设备，也不接入运营商认证。知道某个手机号的人可以进入该账号，因此当前版本只适合产品验证，不适合保存敏感资料。

`phone-auth` 云函数保留为禁用占位，`PHONE_AUTH_PROVIDER` 必须保持 `disabled`。后续若接入短信或运营商认证，应作为独立版本重新设计认证和账号迁移，不能直接启用占位配置。

## 2. 权限分工

必须由账号所有者完成：

- 腾讯云实名认证；
- CloudBase 套餐购买、充值、续费和费用审批；
- 正式域名的备案和域名所有权验证；
- 首次登录、扫码、MFA、协议确认或高风险操作确认；
- 创建或填写 DeepSeek 等服务端密钥。

可以由 Codex 在你已登录的控制台会话中协助：

- 创建和配置 CloudBase 环境、集合、索引和安全规则；
- 上传、部署和更新云函数；
- 配置环境变量名称、函数超时、Web 安全域名和日志查询；
- 执行联调、部署检查和故障排查。

不要把 DeepSeek Key、腾讯云凭据、token、OTP 或账号密码粘贴到聊天或提交到 Git。

## 3. 创建 CloudBase 环境

1. 登录腾讯云控制台，进入云开发 CloudBase。
2. 新建按量计费环境，区域选择主要用户所在区域；中国大陆用户优先上海或广州。
3. 本项目 Web 使用独立环境 `quizmiao-web-d7g9642jpcaa90745`（上海），不修改 miniapp 环境或资源。
4. 环境 ID 是公开的路由配置，不是密钥；腾讯云 SecretId、SecretKey 和 API Key 不得写入前端或仓库。
5. 免费体验版不支持添加自定义 Web 安全域名，因此正式前端部署到环境自动配置的 CloudBase 静态托管域名；升级套餐后再按需加入 `philcui07.github.io`。
6. 在身份认证中启用匿名登录。匿名 CloudBase 身份只用于通过云函数调用网关，不是业务账号，也不决定数据归属。
7. 开启函数日志、监控和费用告警。

静态托管只部署前端，不会自动部署 CloudBase 后端。首次联调前必须在腾讯云控制台完成本节设置以及第 6、7 节，否则手机号登录、历史记录和分享均不可用。

### 3.1 移动端“服务连接失败”排查

1. `index.html` 必须从 `https://static.cloudbase.net/cloudbase-js-sdk/3.6.4/cloudbase.full.js` 加载官方 Web SDK；旧版 SDK 的匿名登录链路与当前身份认证控制台不兼容。
2. 身份认证中启用匿名登录。
3. 免费体验版使用自动安全域名 `quizmiao-web-d7g9642jpcaa90745-1257297085.tcloudbaseapp.com`；升级后如继续发布 GitHub Pages，再加入 `philcui07.github.io`，来源为 `https://philcui07.github.io`，不要填写带 `/quizmiao/` 的路径。
4. 本地调试按控制台能力加入 `localhost` 和 `127.0.0.1`；生产环境不要开放通配域名。
5. 部署第 7 节全部云函数，并确认函数区域与环境一致。
6. 浏览器错误若提示域名、环境或函数未找到，按页面给出的分类处理，不要通过开放数据库客户端读写权限绕过。

## 4. 登录身份模型

1. 前端验证手机号满足 `^1\d{10}$`。
2. 前端先用 CloudBase Web SDK 3.6.4 的 `signInAnonymously()` 建立云函数网关凭据。
3. `profile-manage` 以手机号创建或读取 `users/phone_<手机号>` 文档。
4. 前端把手机号保存在当前浏览器的 `localStorage`，后续云函数调用通过 `accountPhone` 传递账号。
5. `profile-manage`、`history-manage`、`share-manage` 和 `share-result` 都在服务端重新校验手机号格式。
6. 昵称保存在 `users`；题集、练习、分享和好友答题分别以手机号写入 `owner_id`、`sharer_id` 或 `participant_id`。
7. 换设备输入同一个手机号可以恢复昵称、历史和分享记录。

这套设计刻意不做设备绑定、短信验证、号码别名或 canonical owner。匿名 CloudBase 身份变化不会改变业务账号。当前安全边界是“持有手机号字符串即可登录”，不要在账号中保存敏感数据。

## 5. `phone-auth` 禁用要求

1. `phone-auth` 保持部署，便于前端旧调用得到明确的“未启用”结果。
2. `PHONE_AUTH_PROVIDER` 必须为 `disabled`。
3. `PHONE_AUTH_VERIFY_URL`、`PHONE_AUTH_APP_ID`、`PHONE_AUTH_VERIFY_SECRET` 和 `PHONE_HASH_SECRET` 保持为空。
4. 不启用前端运营商 adapter，不购买或调用短信/运营商认证服务。
5. 后续认证升级需另行设计服务端校验、账号迁移和旧手机号账号保护。

## 6. 创建数据库集合

依次创建：

- users
- phone_bindings（保留集合，v1.1.0 不读写）
- quiz_history
- quiz_attempts
- shares
- share_results

所有集合的客户端权限设为禁止读、禁止写。Web 只能通过云函数访问。

| 集合 | 索引字段 |
|---|---|
| quiz_history | owner_id, created_at |
| quiz_attempts | owner_id, history_id, created_at |
| quiz_attempts | owner_id, attempt_id |
| shares | owner_id, created_at |
| share_results | share_id, sharer_id, created_at |
| share_results | share_id, attempt_id |

如果控制台提示查询缺少索引，按报错字段顺序补建，不要开放集合权限绕过错误。

## 7. 部署云函数

| 函数 | 超时 | 说明 |
|---|---:|---|
| quiz-generate | 60 秒 | DeepSeek 出题 |
| page-fetch | 15 秒 | 安全抓取公开网页 |
| profile-manage | 10 秒 | 手机号账号资料 |
| phone-auth | 10 秒 | 禁用占位，不接认证供应商 |
| history-manage | 10 秒 | 题集和练习记录 |
| share-manage | 10 秒 | 分享管理 |
| share-result | 10 秒 | 好友答题记录 |

每个函数选择云端安装依赖。为 quiz-generate 配置 DEEPSEEK_API_KEY 和 DEEPSEEK_MODEL；phone-auth 按第 5 节保持禁用。日志不得输出手机号、token、API Key 或完整认证上下文。

## 8. 前端发布

1. 当前 Web 使用腾讯官方静态 CDN 上的 CloudBase SDK 3.6.4，通过 `signInAnonymously()` 获取云函数网关凭据；升级 SDK 时必须重新执行移动端登录、历史和分享回归。
2. 确认 index.html 中脚本顺序为 phone-auth-config、phone-auth、供应商 adapter、store、cloudbase、api、app。
3. 修改 SDK、JS 或 CSS 后递增静态资源查询参数。
4. 本地验证后提交 v1.1.0-dev；不要修改 miniapp。
5. 将 `docs/` 部署到 CloudBase 静态网站托管；GitHub Pages 可保留为不连接 CloudBase 的预览入口。

## 9. 上线前验收

账号与守卫：

- 登录只接受以 `1` 开头的 11 位手机号，不发送短信；
- 换设备输入同一手机号能读取相同昵称、历史和分享；
- 未登录点击历史入口先打开登录，成功后自动进入历史页；
- 退出后 UI 要求重新输入手机号，业务数据保留在该手机号账号下；
- phone-auth 保持 disabled，不启用占位配置。

题集与分享：

- 一次出题只创建一个题集，删除题目后同步更新；
- 同一题集练习两次显示两条独立成绩和错题；
- 分享名称、24 小时有效期和本机答题昵称复用正确；
- 分享人可查看好友成绩和错题，过期后既有结果仍可查看。

运维：

- 网页抓取拒绝 localhost、内网 IP 和非标准端口；
- 手机号、token 和密钥不进入日志；
- AI 和 CloudBase 设置预算告警与紧急停用策略。

## 10. Miniapp 后续工作

Web 验收后再单独设计 Miniapp。本次改动不修改 miniapp，也不假定小程序复用当前未验证手机号登录方案。
