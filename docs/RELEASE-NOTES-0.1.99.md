# 发布说明 0.1.99（shared-visible 写租约门控）

> 2026-10-19 · 扩展/provider **0.1.99** · `npm test` 32 个测试文件

## 新增

- **Windows native host 自动注册**：真实 Windows 上 provider 安装时自动执行 `reg add` 写 HKCU；失败时才打印手动命令。修复 Windows 测试者常见的 `Specified native messaging host not found`（0.1.93 包仍需手动注册）。

- `browser.shared.enabled=true` 时，`wrapToolsForBackend` 为写动作提供隐式 write lease：
  - 取 active tab（`tab.tabs`）→ `BrowserLeaseManager.acquire({tabId, owner, mode:"write"})` → 执行 → `release`
  - 另一个 DSH 会话同时写同一 tab 会得到 `LEASE_HELD`
  - 读工具不受影响
- 默认 `shared.enabled=false`，桌面/headless 现有行为不变
- 新增 `test/lease-gate.mjs`：串行写、读不阻塞、跨会话冲突、默认关闭

## 仍待完成

- `collab` / shared context 尚未创建；shared 模式目前复用用户桌面 Chrome（需 config 开启）
- 没有自动心跳定时器；长动作靠调用期间持有 lease
- `chrome_evaluate`/`storage` 等写类工具已纳入门控；导航后 tab 关闭的 `releaseTab` 还未接
