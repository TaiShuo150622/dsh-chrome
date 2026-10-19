# 发布说明 0.1.98（shared lease 基础 / I3.1）

> 2026-10-19 · 扩展/provider **0.1.98** · 工具面 **45（+evaluate 46）** · `npm test` 30 个测试文件

## 新增

- **DSH 右侧边栏 viewer 原型**：`chrome_context {op:"viewer"}` 返回 per-context viewer URL（截图轮询 + click/type/key/scroll/navigate），可在 DSH 右侧边栏 Browser tab 使用；无需 DSH client plugin。

- **`src/lease.js` / `BrowserLeaseManager`**：provider 内存态的 tab lease，支持 `acquire/renew/release/list/status/heartbeat/takeover/releaseTab`；
  - write 独占、read 可共享；
  - TTL 过期自动失效（默认 60s，上限 15min）；
  - 心跳续租；
  - 用户只能通过显式 `takeover(tabId,{by:"user"})` 撤销现有 agent lease；
  - 不持久化，provider 重启即清空。
- **`chrome_lease` 工具**（第 45 个默认工具）：`op=acquire/renew/release/list/status/takeover`，owner 用 `ownerOf(exec)`；`renew` 不带 `leaseId` 时对该会话所有 lease 做心跳续租。没有 lease manager 时返回 `LEASES_UNAVAILABLE`。
- **`test/lease.mjs`**：并发单写者、read 共享、TTL、renew、heartbeat、release、`releaseTab`、takeover、错误码、工具映射与 unavailable 路径。
- **`docs/LEASES.md`**：语义、错误码、当前边界和下一步接入点。

## 明确未完成

- **lease 尚未接入所有 `chrome_*` 写动作**：当前只有显式调用 `chrome_lease` 才产生/检查 lease；click/type/goto 等写工具还不会自动 acquire/release。不要把这版当成完整的 shared-visible/collab 控制。
- `chrome_context preset:"collab"` 仍返回 `UNSUPPORTED_MODE`；`src/contexts.js` / `index.js` 本批未改，避免与主仓并行改动冲突。
- 没有持久化、跨 provider 同步、内置心跳定时器；tab 关闭/导航的 `releaseTab` 事件接线待做。
- 用户 takeover 只撤销现有 lease，尚未在动作门控里形成「用户占用期间禁止 agent 写」的硬阻断。

## 兼容性

- 默认工具数 44 → 45；开启 `allowEvaluate` 后 45 → 46。
- 未传入 lease manager 的调用方保持旧行为（不会因为新增工具而改变原有写动作）。
- 扩展 manifest 与 package 版本同步为 0.1.98。
