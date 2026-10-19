# 发布说明 0.2.18（设置 MVP + bridgeError 修正）

> 2026-10-19 · 扩展/provider **0.2.18** · `npm test` 44 个测试文件

## 插件设置 MVP

- Provider 导出 DSH `Config` schema（安全字段）：
  - `browser.preset` / `maxContexts` / `idleTimeoutMs`
  - `verification.artifactRetentionRuns`
  - `update.enabled` / `autoInstall` / `checkIntervalHours`
- 优先级：默认 < legacy 文件 < 用户文件 < 项目文件 < DSH entry config；
- 项目级配置不能放宽 `browser.shared.enabled` / `allowEvaluate` 等危险项；
- 危险字段不进设置表单，默认关闭；
- 新增 `test/settings.mjs`。

## 修复（审查发现）

- **环境变量拆分**：headless 引擎使用新的 `DSH_HEADLESS_ENGINE`；`DSH_CHROME_BROWSER` 只保留为桌面 native host 安装目标，避免“为了 headless Edge 设置变量导致 Chrome 连不上”；
- 显式 headless 引擎首次启动失败时关闭新建 context，避免留下假 running context；
- `npm run status` 在 Windows 把 socket 标为 named-pipe，不再误报 missing；


- `chrome_status.bridgeError` 之前永远为 null：`chromeTools` 收到的是 `BackendRouter`，不是 `BridgeServer`；
- 现在 `router.bridgeError()` 转发 `bridge.lastError`，Windows 失败时能看到真实原因。

## A0 侧边栏说明

- `client/` 中的 A0 占位会随包被 DSH client scanner 加载；它只显示“spike/未连接浏览器 context”，不嵌 iframe、不控制浏览器；
- 真实安装包上的右栏验证仍未完成。

## 测试

- Lead 全量 `npm test` exit 0，44 个测试文件；
- 设置 MVP 在真实 DSH 安装中的 Settings 表单投影仍需安装验证（测试只覆盖本地 schema/merge）。
