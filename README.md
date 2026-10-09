# 拾知猫 QuizMiao

AI 学习练习工具：输入文本或网页链接，生成选择题，支持练习、错题、题集历史及好友分享。

本仓库的完整代码交接基线位于 `codex/cloud-handoff-2026-10-09`。请先阅读 [handoff.md](handoff.md)。既有版本分支保留原来的 Web 根目录结构。

| 目录 | 内容 |
|---|---|
| `web/docs/` | Web 静态前端、产品文档 |
| `web/cloudbase/` | Web CloudBase 云函数、部署配置 |
| `web/proxy/` | Vercel 代理；仍被当前 Miniapp 云函数调用 |
| `miniapp/miniprogram/` | 微信小程序前端 |
| `miniapp/cloudfunctions/proxy/` | 小程序云函数代理、账号、历史和分享 |
| `web/tests/`、`miniapp/tests/` | 现有回归测试 |

## 本地预览与检查

使用 Node.js 24（迁移基线实测 24.19.0）与 Python 3：

```bash
node --test web/tests/*.test.js miniapp/tests/*.test.js
python3 -m http.server 8000 --directory web/docs
```

浏览器访问 `http://localhost:8000`。真实后端联调还需 CloudBase 安全域名与云函数配置。

微信开发者工具导入 `miniapp/`；本地私有配置不提交。运行与部署细节见 [Web 部署手册](web/cloudbase/DEPLOYMENT.md) 和 [Miniapp 部署指南](miniapp/DEPLOY_GUIDE.md)。

本次迁移不构成上线验收，测试边界见交接文件。
