# 拾知猫 Web

当前开发版本：`v1.1.0-dev`

## 目录

- `docs/`：GitHub Pages 静态前端与产品文档。
- `cloudbase/`：CloudBase 配置、云函数和部署手册。
- `tests/`：无需外部依赖的前端状态测试。
- `proxy/`：冻结的 v1.0.1 Vercel 迁移参考，不属于 v1.1.0 运行链路。

## 本地检查

```bash
node --test tests/frontend-state.test.js
find docs cloudbase -name '*.js' -not -path '*/node_modules/*' -exec node --check {} \;
```

静态页面从 `docs/` 启动本地 HTTP 服务后访问。账号、运营商认证、历史和分享联调需要按 `cloudbase/DEPLOYMENT.md` 配置 CloudBase 环境。

## 版本规则

- `v1.0.1` 已冻结，不再修改。
- 当前功能提交到 `v1.1.0-dev`。
- Web 完成验收后再进入 Miniapp `v1.1.0-dev` 开发。
