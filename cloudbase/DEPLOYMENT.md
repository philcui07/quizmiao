# 拾知猫 v1.1.0 CloudBase 部署手册

本手册对应 Web v1.1.0-dev。业务后端全部运行在腾讯云 CloudBase，Vercel 和短信验证码均不属于 v1.1.0 运行链路。

## 1. Web 手机号能力边界

普通 Chrome、Safari、Edge、Firefox 和微信内置浏览器没有标准 API 可以直接读取 SIM 手机号。

- Credential Management API 管理密码、联合身份和通行密钥等凭据，不提供 SIM 手机号读取能力：<https://developer.mozilla.org/en-US/docs/Web/API/Credential_Management_API>
- WebOTP API 只读取应用发送的短信一次性验证码，仍需要短信发送和服务端验证码校验，不能返回本机手机号：<https://developer.mozilla.org/en-US/docs/Web/API/WebOTP_API>
- Web 一键认证必须采购运营商或聚合认证产品。供应商前端 SDK 获取短期 token，CloudBase 服务端再用密钥校验 token 并换取手机号。

当前仓库已经提供 provider adapter 和服务端校验边界，但默认保持 disabled。在供应商项目、域名和正式密钥配置完成前，界面会明确显示一键登录不可用并进入手动手机号回退。

## 2. 权限分工

必须由账号所有者完成：

- 腾讯云和运营商认证供应商的实名认证；
- 认证产品开通、套餐购买、充值、续费和费用审批；
- 正式域名的备案、域名所有权验证及供应商白名单审核；
- 首次登录、扫码、MFA、协议确认或高风险操作确认；
- 生成正式应用 ID、服务端密钥，并在控制台内填写密钥值。

可以由 Codex 在你已登录的控制台会话中协助：

- 创建和配置 CloudBase 环境、集合、索引和安全规则；
- 上传、部署和更新云函数；
- 配置环境变量名称、函数超时、Web 安全域名和日志查询；
- 根据最终供应商 SDK 实现具体前端 adapter 与服务端校验网关；
- 执行联调、部署检查和故障排查。

不要把供应商密钥、PHONE_HASH_SECRET、DeepSeek Key、OTP 或账号密码粘贴到聊天或提交到 Git。

## 3. 创建 CloudBase 环境

1. 登录腾讯云控制台，进入云开发 CloudBase。
2. 新建按量计费环境，区域选择主要用户所在区域；中国大陆用户优先上海或广州。
3. 记录控制台生成的完整环境 ID。
4. 在 docs/js/cloudbase.js 中替换 CLOUDBASE_ENV_ID。
5. 在 Web 安全配置中加入正式域名和本地联调域名；正式域名预计为 philcui07.github.io。
6. 在身份认证中启用匿名登录。匿名 CloudBase 身份是设备数据权限主键，不是公开访客 ID。
7. 开启函数日志、监控和费用告警。

## 4. 登录身份模型

### 4.1 手动手机号回退

1. 前端调用 CloudBase signInAnonymously 创建并持久化安全设备身份。
2. 用户手动填写手机号，profile-manage 将其保存到该设备身份的 users 资料。
3. 资料标记 phone_verified=false。
4. 历史、分享和昵称继续按 CloudBase 认证上下文中的身份读取。
5. 服务端不按手机号查询 owner，不接受客户端传入 owner ID。

因此，在另一台设备输入相同手机号不会读取原设备历史。这是预期的安全行为，不能改成“按手机号查账号”。

### 4.2 运营商一键认证

1. 供应商 SDK adapter 在浏览器中取得一次性 token，不取得可直接信任的手机号。
2. 前端把 provider、token 和受限 metadata 传给 phone-auth 云函数。
3. phone-auth 从环境变量读取服务端配置，调用 HTTPS 校验网关。
4. 只有网关明确返回 ok=true 且号码格式有效时，才写入 phone_verified=true。
5. 号码经 PHONE_HASH_SECRET 做 HMAC 后写入 phone_bindings，明文号码不作为绑定文档 ID。
6. 同一认证号码从新设备登录时解析到 canonical owner，并迁移该设备已有题集、练习和分享归属。

## 5. 运营商项目手工配置

选定供应商后，需要在其控制台完成：

1. 开通支持 Web/H5 的本机号码认证产品，确认其明确支持普通浏览器或指定 WebView。
2. 创建 Web/H5 应用，登记正式域名、回调域名和业务场景。
3. 配置移动、联通、电信支持范围，确认 Wi-Fi、双卡、境外号码和虚拟运营商的失败策略。
4. 获取前端公开 App ID；密钥只能进入服务端。
5. 按供应商 SDK 实现一个 adapter，并调用 PhoneAuth.registerAdapter(providerName, adapter)。adapter authorize 必须只返回短期 token 和必要 metadata。
6. 建立服务端 token 校验网关。当前 phone-auth 采用 custom REST v1 契约：POST JSON 输入 provider、appId、token、metadata；成功响应必须为 {"ok":true,"phone":"13800138000"}。
7. 把 docs/js/phone-auth-config.js 中 enabled 改为 true，provider 与注册名称一致，填写公开 appId。
8. 在 CloudBase phone-auth 云函数配置下列环境变量。

| 环境变量 | 必填 | 说明 |
|---|---|---|
| PHONE_AUTH_PROVIDER | 是 | provider 名称；未接入前必须为 disabled |
| PHONE_AUTH_VERIFY_URL | 是 | HTTPS 服务端 token 校验网关 |
| PHONE_AUTH_APP_ID | 是 | 供应商应用 ID |
| PHONE_AUTH_VERIFY_SECRET | 视网关而定 | phone-auth 调用网关的 Bearer 密钥 |
| PHONE_HASH_SECRET | 是 | 至少 32 字符的独立随机密钥，不得复用其他 Key |

9. 真机分别测试移动数据、Wi-Fi、三家运营商、拒绝授权、token 过期、网关超时和手动回退。
10. 配置调用频率限制、异常峰值告警、日/月预算和紧急停用开关。

## 6. 创建数据库集合

依次创建：

- users
- phone_bindings
- quiz_history
- quiz_attempts
- shares
- share_results

所有集合的客户端权限设为禁止读、禁止写。Web 只能通过云函数访问。

| 集合 | 索引字段 |
|---|---|
| users | owner_id |
| users | canonical_owner_id |
| phone_bindings | canonical_owner_id |
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
| profile-manage | 10 秒 | 设备账号资料 |
| phone-auth | 10 秒 | 运营商 token 服务端校验 |
| history-manage | 10 秒 | 题集和练习记录 |
| share-manage | 10 秒 | 分享管理 |
| share-result | 10 秒 | 好友答题记录 |

每个函数选择云端安装依赖。为 quiz-generate 配置 DEEPSEEK_API_KEY 和 DEEPSEEK_MODEL；为 phone-auth 按第 5 节配置认证变量。日志不得输出手机号、token、供应商密钥、PHONE_HASH_SECRET、API Key 或完整认证上下文。

## 8. 前端发布

1. 使用 CloudBase 控制台当前推荐的 Web SDK 稳定版本，并确认支持 signInAnonymously。
2. 确认 index.html 中脚本顺序为 phone-auth-config、phone-auth、供应商 adapter、store、cloudbase、api、app。
3. 修改 SDK、JS 或 CSS 后递增静态资源查询参数。
4. 本地验证后提交 v1.1.0-dev；不要修改 miniapp。
5. 合并到 main 后由现有 GitHub Pages workflow 发布 docs。

## 9. 上线前验收

账号与守卫：

- provider 未配置时不发送任何短信，也不调用云端短信占位接口；
- 一键认证不可用或失败时显示手动手机号输入；
- 手动手机号资料标记为未验证，换设备输入同号不能读取历史；
- 未登录点击历史入口先打开登录，成功后自动进入历史页；
- 伪造手机号、verified 标志或 owner ID 不能越权；
- 同一运营商认证号码在新设备映射到 canonical owner；
- 退出后 UI 要求重新登录，但保留安全设备凭据，确保本机重新登录仍能找回历史。

题集与分享：

- 一次出题只创建一个题集，删除题目后同步更新；
- 同一题集练习两次显示两条独立成绩和错题；
- 分享名称、24 小时有效期和本机答题昵称复用正确；
- 分享人可查看好友成绩和错题，过期后既有结果仍可查看。

运维：

- 网页抓取拒绝 localhost、内网 IP 和非标准端口；
- provider token、手机号和密钥不进入日志；
- AI、运营商认证和 CloudBase 设置预算告警与紧急停用策略。

## 10. Miniapp 后续工作

Web 验收后再进入 Miniapp v1.1.0-dev。本次改动不修改 miniapp。小程序后续使用微信手机号快速验证动态凭证，由专用 CloudBase 云函数换取手机号并接入相同 canonical owner 体系。
