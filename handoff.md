# QuizMiao 云端开发交接

> 交接日期：2026-10-09（Asia/Shanghai）
> 产品名：拾知猫；项目名：quizmiao

## 结论

当前本地代码包含 Web v1.1.1 和 Miniapp v1.1.0 两套实现，以及尚未提交的出题质量、账号、历史和分享改动。迁移将它们统一到 GitHub 的一个仓库，保留旧版本历史。后续必须从完整交接分支接手，不能直接从旧 `main` 开发。

云端环境与云端工作区的创建状态需要独立核实。GitHub 分支已准备并不等于已创建云端 worktree。本文件不会把代码上传、模拟测试或旧截图当作上线验收。

## 目录

1. 仓库与版本
2. 产品及架构
3. 当前实现与待验收改动
4. 环境与运行方法
5. 测试结果与证据边界
6. 云端环境及独立工作区配置
7. 接手后的优先顺序
8. 用户工作约定与部署限制

## 1. 仓库与版本

| 项目 | 值 |
|---|---|
| GitHub | https://github.com/philcui07/quizmiao |
| 完整交接分支 | `codex/cloud-handoff-2026-10-09` |
| Web 后续分支 | `codex/quizmiao-web`（从完整交接基线创建） |
| Miniapp 后续分支 | `codex/quizmiao-miniapp`（从完整交接基线创建） |
| 本地根目录 | `/Users/limx/Documents/Codex Project/quizmiao` |
| 原 Web 基线 | `v1.1.1-dev`，`886c33ecce30669f887976cb26d82f38f76752c5` |
| 原 Miniapp 基线 | `v1.1.0`，`4b56974`；原本只有本地 Git 历史 |
| 冻结版本 | `v1.0.1`，不修改 |

完整交接分支采用 `web/` + `miniapp/` 的根目录结构。原有 `main`、`v1.1.0-dev`、`v1.1.1-dev` 保留原结构与内容；旧 `main` 并不包含本次完整交接代码。

根目录的 `AGENTS.md` 保存用户开发与测试要求。原本两个本地仓库的 Git 元数据保存在 `.migration-backup/`，不上传；统一仓库的首次迁移提交保留两边历史作为父提交。

上传范围包含代码、配置、依赖清单与锁文件、测试、素材和出题质量报告。排除依赖缓存、密钥文件、`.env`、开发者工具私有配置、部署压缩包以及旧测试截图；这些仍保留在本地。小程序运行必需的 tabbar PNG/SVG 资源应全部在仓库中。

## 2. 产品及架构

用户输入文本或公开网页链接，生成四选一题目，确认后练习、查看成绩与错题，保存题集并再次练习或分享。

```text
Web 浏览器
  → web/docs/ 静态前端
  → CloudBase 匿名网关身份
  → Web 云函数：出题、网页抓取、账号、历史、分享、好友成绩
  → DeepSeek / CloudBase 数据库

微信小程序
  → miniapp/miniprogram/
  → wx.cloud.callFunction('proxy')
  → 小程序 CloudBase 云函数：账号、历史、分享、网页抓取
  → AI 出题仍调用 https://vercelapi.philcui.top 的代理接口
```

| 模块 | 入口 |
|---|---|
| Web 前端 | `web/docs/index.html`、`web/docs/js/app.js` |
| Web CloudBase 调用 | `web/docs/js/cloudbase.js`、`web/docs/js/api.js` |
| Web 出题 | `web/cloudbase/functions/quiz-generate/index.js` |
| Vercel 出题代理 | `web/proxy/api/index.js` |
| Miniapp 启动及账号 | `miniapp/miniprogram/app.js` |
| Miniapp 后端 | `miniapp/cloudfunctions/proxy/index.js` |
| 产品文档 | `web/docs/PRD.md`（部分规格已落后于代码） |

Web 云函数：`quiz-generate`、`page-fetch`、`profile-manage`、`phone-auth`、`history-manage`、`share-manage`、`share-result`。`phone-auth` 为禁用占位。

数据库使用 `users`、`quiz_history`、`quiz_attempts`、`shares`、`share_results`；Web 另保留 `phone_bindings`，当前不读写。客户端集合权限禁止直读直写。

## 3. 当前实现与待验收改动

| 领域 | 当前代码状态 | 后续重点 |
|---|---|---|
| Web 历史 | 题集详情支持重新练习、再次分享；同题集追加多次成绩 | 浏览器与真实云数据库复测保存幂等、失败后重试 |
| Web AI | 最多 16000 字符；分区候选生成、全局重复组审查、失败时精确题干去重、缓存 | 实测题数、覆盖率、延迟与语义去重 |
| Vercel AI | 当前未提交改动强化编号知识点完整切分、1.5 倍候选与有界重复组去重 | 与当前 Miniapp 调用联调；不要按“仅旧版参考”误删 |
| Miniapp AI | 最多 16000 字符；5/10/20 题；1.5 倍候选，当前云函数最多 8 批并发 | 真机测长文、缺题、重复题与超时 |
| Miniapp 账号 | 当前代码为手动手机号登录，支持昵称、退出、同手机号账号 | 旧 PRD 的微信 getPhoneNumber 方案未代表当前实现 |
| Miniapp 历史 | 我的题集/分享、详情、成绩、重新练习、缓存首屏与静默刷新 | 微信模拟器及真机验收 |
| Miniapp 分享 | 先保存分享 ID，调用微信原生分享；参与者昵称及 24 小时期限 | 双设备分享、过期、好友成绩和并发保存 |

出题质量背景见 `web/test-artifacts/english-model-quality-comparison.md`：此前线上 20 题请求约 60 秒返回 14 题，包含重复与知识覆盖偏斜；过度去重曾导致题数骤降。当前修复方向为编号知识点完整切分、30 个候选（请求 20 时）、具体分类、新场景和明确重复组证据。该文档是此前记录，不能当成本次修复后的线上测试结果。

重要文档差异：

- `web/proxy/README.md` 说该目录仅旧版参考，但当前 Miniapp 实际依赖 Vercel 代理。需同时核对两端调用再决定是否清理。
- `web/docs/PRD.md` 的 Miniapp 微信手机号授权方案与当前手动输入手机号代码不一致。
- 旧 CHANGELOG 的 canonical owner/运营商认证描述早于当前手机号直接作为账号 ID 的方案。
- 不在迁移中擅自改认证方案；当前账号不验证号码归属，知道手机号即可进入相应账号。未来升级认证需单独设计迁移。

## 4. 环境与运行方法

| 配置 | 当前值/说明 |
|---|---|
| 实测 Node | 24.19.0 |
| Web CloudBase 环境 | `quizmiao-web-d7g9642jpcaa90745` |
| Web 静态托管入口 | `https://quizmiao-web-d7g9642jpcaa90745-1257297085.tcloudbaseapp.com`（本次未核验线上版本） |
| Web SDK | CloudBase 3.6.4，`static.cloudbase.net` |
| Miniapp 环境 | `cloud1-d1gmbknrs35a73b49` |
| 小程序 AppID | 见 `miniapp/project.config.json`；环境 ID / AppID 不是密钥 |
| Miniapp 基础库 | 项目配置为 3.17.0 |
| DeepSeek 配置 | 服务端 `DEEPSEEK_API_KEY`、`DEEPSEEK_MODEL`，代码默认 `deepseek-v4-flash`；本次未验证实际线上配置 |
| 禁用认证配置 | `PHONE_AUTH_PROVIDER=disabled`，其他认证供应商占位字段为空 |

从统一仓库根目录运行：

```bash
node --test web/tests/*.test.js miniapp/tests/*.test.js
python3 -m http.server 8000 --directory web/docs
```

浏览器访问 `http://localhost:8000`。云函数联调需在 CloudBase 配置允许的本地域名并部署正确函数。纯静态预览不需要 DeepSeek Key；现有回归测试使用模拟依赖，也不需要真实服务端密钥。

要实际运行云函数，分别安装各函数目录的 package.json 依赖。微信部署使用开发者工具导入 `miniapp/`，再上传云函数并选择云端安装依赖。不要提交本地生成的私有配置。

部署手册：`web/cloudbase/DEPLOYMENT.md`、`miniapp/DEPLOY_GUIDE.md`。本次不部署、不重新采购服务、不修改线上资源。

## 5. 测试结果与证据边界

2026-10-09：现有 Node 回归测试 76 项通过、0 失败，覆盖前端状态、账号/历史/分享模拟后端、AI 并发及去重、小程序页面逻辑。它们使用模拟的 wx、云数据库和模型响应，不代表 76 项真机测试。

真实浏览器测试结果及本次迁移的完整性检查见 `migration-validation.md`。本地证据存放 `.migration-backup/validation/`，不上传旧截图和用户数据。

未重新完成的验收：

- 微信开发者工具模拟器及真机运行；旧 Miniapp 截图只作为历史证据保留在本地。
- 真实 DeepSeek 长文出题的题数、质量、覆盖与延迟。
- CloudBase 实际部署版本、登录、数据写入、分享及跨设备记录。
- 真实微信原生分享和 24 小时过期行为。

## 6. 云端环境及独立工作区配置

目标：命名为 `quizmiao` 的 Codex Cloud 环境，连接 `philcui07/quizmiao`，从完整交接分支获取代码，并分别建立 Web 与 Miniapp 工作区。

官方入口：新任务中 `Work in > Cloud > Select environment > Create environment`，或 `Settings > Codex Cloud > Environments > Create environment`。选择仓库，完成依赖和工具准备，核验测试后发布。官方说明：https://learn.chatgpt.com/docs/environments/cloud-environments

| 项目 | 设置 |
|---|---|
| 环境名称 | `quizmiao` |
| 仓库 | `philcui07/quizmiao` |
| 首次准备基线 | `codex/cloud-handoff-2026-10-09`，不要用旧 main |
| 运行工具 | Node.js 24、Python 3、真实 Chromium/Chrome 浏览器及自动化工具 |
| Web 工作分支 | `codex/quizmiao-web` |
| Miniapp 工作分支 | `codex/quizmiao-miniapp` |
| 准备阶段检查 | 76 项现有回归测试 + Web 实际浏览器冒烟检查 |
| 初始密钥 | 纯代码接手无需配置 DeepSeek Key；真实服务联调时再由用户安全提供 |

当前官方 Cloud 环境为每个新任务建立独立工作区。若实际界面提供 Git worktree 模式，则分别选择上述工作分支；若是 Cloud 隔离工作区，则分别建立 Web 与 Miniapp 任务并核实分支。不要把本机工作树冒充云端工作区。

在支持普通 Git 的云端执行环境，也可显式建立工作树：

```bash
git fetch origin
git switch codex/cloud-handoff-2026-10-09
git worktree add -b cloud-work/web ../quizmiao-web origin/codex/quizmiao-web
git worktree add -b cloud-work/miniapp ../quizmiao-miniapp origin/codex/quizmiao-miniapp
git worktree list
```

上面的路径是仓库同级目录，按平台工作目录调整；`cloud-work/*` 仅在尚不存在时创建。远端分支存在与云端 worktree 创建成功必须分别核实。

用户计划手动将本文件传到对应云端项目。接手后先核实仓库与分支，读 `AGENTS.md`，说明当前测试边界；等待用户给出具体开发需求，不自行扩大功能或执行线上部署。

## 7. 接手后的优先顺序

| 优先级 | 工作 | 验收证据 |
|---|---|---|
| P0 | 核实完整代码、资源和分支；确认云端环境及两套工作区 | Git 提交、目录、分支与工作区路径 |
| P0 | 在实际浏览器/微信环境重建运行基线 | 操作流程、截图、错误日志 |
| P1 | 按用户后续需求继续编码；若继续出题质量问题，先复现长文样本 | 5/10/20 题实测、延迟、缺题/重复与知识覆盖对照 |
| P1 | 核验账号、历史、多次练习、分享与双设备结果 | 真实服务与两端操作结果 |
| P2 | 更新落后的 PRD/代理说明及部署文档 | 文档与最终代码一致 |

## 8. 用户工作约定与部署限制

- 本地项目统一放在文稿/Codex Project；云端使用平台仓库目录。
- coding 必须测试，必须在用户实际使用环境或类似模拟器测试；只跑代码测试不能宣称验收通过。
- 先结果，再结构化细节与证据；复杂交付先给目录，优先使用图表。
- 商品来源优先淘宝、京东、拼多多；资讯来源按用户要求使用国内平台。
- 用户的最新指令优先于旧文档。避免反复试改，先定位和复现再修改。
- 密钥和真实账号数据不进入 Git 或交接文档。腾讯云实名认证、支付、扫码/MFA 和服务端密钥输入由账号所有者处理。
- 本次迁移范围是代码管理与交接，不是线上发布。
