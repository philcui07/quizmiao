# 拾知猫 v1.1.0 CloudBase 部署手册

本手册对应 Web `v1.1.0-dev`。业务后端全部运行在腾讯云 CloudBase，Vercel 不再承担出题、抓取、账号、历史或分享请求。

## 1. 权限分工

必须由账号所有者完成：

- 腾讯云账号实名认证；
- 短信签名、模板涉及的主体证明和审核确认；
- 套餐购买、充值、资源续费和费用审批；
- 首次登录、扫码、MFA 或高风险操作确认；
- 绑定正式域名时的域名所有权及备案相关操作。

可以由 Codex 在你已登录的控制台会话中代操作：

- 创建和配置 CloudBase 环境；
- 创建集合、索引和安全规则；
- 创建、上传和更新云函数；
- 配置非敏感环境 ID、函数超时和环境变量名称；
- 配置 Web 安全域名、测试账号和日志查询；
- 执行联调、部署检查和故障排查。

DeepSeek 或腾讯云密钥不要粘贴到聊天或提交到 Git。可以在控制台环境变量表单中由你直接填入，Codex负责其余字段。

## 2. 创建 CloudBase 环境

1. 登录腾讯云控制台，进入“云开发 CloudBase”。
2. 新建按量计费环境，区域选择主要用户所在区域；中国大陆用户优先选择上海或广州。
3. 记录环境 ID。环境名称可以是 `quizmiao`，但前端需要的是控制台生成的完整环境 ID。
4. 在 `docs/js/cloudbase.js` 中把 `CLOUDBASE_ENV_ID` 替换为完整环境 ID。
5. 在 Web 安全配置中加入正式域名和本地联调域名；正式域名预计为 `philcui07.github.io`。
6. 开启日志、监控和费用告警。

## 3. 开通 Web 手机号登录

1. 在 CloudBase 的身份认证/登录方式中启用“短信验证码”或“手机号验证码”。
2. 按控制台提示完成短信服务主体、签名和验证码模板审核。
3. 验证码模板只包含登录用途，不混用营销文案。
4. 设置验证码有效期、60 秒重发间隔、单手机号/单 IP/单设备频率限制和每日上限。
5. 将 GitHub Pages 正式域名加入认证安全域名或回调域名。
6. 用非管理员测试手机号完成发送、错误验证码、正确登录、刷新保持会话和退出测试。

当前 Web 使用 CloudBase SDK 的 `getVerification` 和 `signInWithSms` 流程。实际部署前应在控制台推荐的 SDK 版本上做一次真机验证；如果腾讯云控制台给出的示例参数发生变化，以控制台当前示例为准并同步更新代码。

## 4. 创建数据库集合

依次创建：

- `users`
- `quiz_history`
- `quiz_attempts`
- `shares`
- `share_results`

所有集合的客户端权限设置为“禁止读、禁止写”。Web 只能调用云函数，云函数使用服务端 SDK 访问数据库。

创建以下复合索引，排序字段按降序：

| 集合 | 索引字段 |
|---|---|
| `users` | `owner_id` |
| `quiz_history` | `owner_id`, `created_at` |
| `quiz_attempts` | `owner_id`, `history_id`, `created_at` |
| `quiz_attempts` | `owner_id`, `attempt_id` |
| `shares` | `owner_id`, `created_at` |
| `share_results` | `share_id`, `sharer_id`, `created_at` |
| `share_results` | `share_id`, `attempt_id` |

如果控制台提示查询缺少索引，按报错给出的字段顺序补建，不要把集合改成公开读写来绕过错误。

## 5. 部署云函数

从 `cloudbase/functions/` 部署：

| 函数 | 超时 | 说明 |
|---|---:|---|
| `quiz-generate` | 60 秒 | 需要 DeepSeek 环境变量 |
| `page-fetch` | 15 秒 | 需要公网访问能力 |
| `profile-manage` | 10 秒 | 账号昵称 |
| `history-manage` | 10 秒 | 题集和练习记录 |
| `share-manage` | 10 秒 | 分享管理 |
| `share-result` | 10 秒 | 好友答题记录 |

每个函数选择“云端安装依赖”或等价选项。包含 `@cloudbase/node-sdk` 的函数会按各自 `package.json` 安装依赖。

为 `quiz-generate` 配置：

```text
DEEPSEEK_API_KEY=<在控制台填写，不进入 Git>
DEEPSEEK_MODEL=deepseek-v4-flash
```

部署后逐个调用健康测试。日志中不得输出手机号、验证码、API Key 或完整认证上下文。

## 6. 前端 SDK 与发布

1. 使用 CloudBase 控制台当前推荐的 Web SDK CDN 地址和稳定版本。
2. 确认 `docs/index.html` 的 SDK 脚本先于 `store.js`、`cloudbase.js` 和 `app.js` 加载。
3. 修改 SDK、JS 或 CSS 后同步递增静态资源查询参数，避免 GitHub Pages/微信浏览器缓存旧代码。
4. 在本地静态服务器验证后提交 `v1.1.0-dev`。
5. 合并到 `main` 后，现有 GitHub Pages workflow 会发布 `docs/`。

## 7. 上线前验收

账号：

- 正常发送验证码，60 秒内不能重复发送；
- 错误验证码不能登录；
- 登录刷新后会话仍在；
- 昵称可跨设备读取；
- 退出后历史入口隐藏。

题集历史：

- 一次出题只创建一条题集；
- 删除确认页题目后，历史题集同步；
- 同一题集练习两次显示两条成绩；
- 刷新或重复渲染结果页不会重复写入。

分享：

- 分享名称正确展示；
- 第一次打开可填昵称或跳过；
- 同一浏览器再次打开其他分享不再弹窗；
- 分享人可查看每次好友成绩和错题；
- 24 小时后链接拒绝加载，但账号历史仍可查看既有结果。

安全与费用：

- 未登录调用账号历史函数返回“请先登录”；
- 修改请求体中的用户 ID 不能越权；
- 网页抓取拒绝 `localhost`、内网 IP 和非标准端口；
- 设置短信、CloudBase 和 DeepSeek 的日/月预算告警；
- 设置短信异常峰值告警和紧急停发策略。

## 8. Miniapp 后续工作

Web 验收后再进入 Miniapp `v1.1.0-dev`。Miniapp 复用相同集合和业务云函数，但登录改为：

1. 用户点击微信手机号快速验证按钮；
2. 小程序取得动态 `code`；
3. 专用 CloudBase 云函数调用微信接口换取手机号；
4. 服务端把微信身份与手机号绑定到统一账号；
5. 小程序端不接触会话密钥和解密密钥。

