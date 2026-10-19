# 发布说明 0.1.96（验证 artifacts 保留）

> 2026-10-19 · 扩展/provider **0.1.96** · `npm test` 29 个测试文件

## 新增/修正

- `chrome_verify` 的 JSON report 和截图改为写入**全局 artifacts 目录**：
  `~/.dsh/cache/dsh-chrome/artifacts/verify-<runId>/`
  不再依赖 ephemeral context profile，context 关闭后仍保留。
- `BrowserContextManager` 增加 artifact run 目录和保留策略；默认保留最近 **50** 次，可用 `verification.artifactRetentionRuns` 调整。
- `chrome_verify` 每次运行都产出 artifacts（成功也有），失败时额外保留截图。

## 测试

- `test/browser-contexts.mjs` 增加 artifact 保留/prune 覆盖；
- `test/chrome-verify.mjs` 覆盖成功/失败 artifacts；
- `npm test` 29 个文件；公开仓库 CI 绿。
