# 发布说明 0.2.10（批量结构重构 + 隔离修复）

> 2026-10-19 · 扩展/provider **0.2.10** · `npm test` 38 个测试文件

本批用循环子智能体逐项拆分（Q4–Q12），每项全量测试后提交/推送；最后由 Lead 复跑全量测试并统一 bump。

## 安全/边界

- **owner-aware context API**：`getOwned` / `closeOwned` / `driverForOwned`；
  `chrome_context close` 与 `chrome_verify` 不再能跨 session 关闭/操作别人的 context；
- **viewer per-context access capability**：`view/frame/input` 在全局 token 之外再校验绑定 context 的 access，降低 contextId 泄露风险；
- **chrome_verify 明确 headless-only**：不再注入/忽略通用 `backend` 参数。

## 结构

- `tools-lease.js`、`tools-context.js`、`tools-verify.js`、`tools-login.js`；
- headless：
  - `headless-png.js`（PNG/JPEG 编解码）；
  - `headless-launch.js`（启动参数/DevToolsActivePort）；
  - `headless-redact.js`（脱敏/body 预算）；
  - `headless-events.js`（console/network CDP 事件）；
- `runtime.js`（viewer/liveview 注册与清理）；
- `artifact-store.js`（artifact run/保留策略，从 context manager 移出）；
- `mutating` 元数据成为运行时唯一来源，`tool-metadata` 改为真实工具定义校验；
- 新增测试：`headless-launch`、`runtime`、`artifact-store` 等。

## 测试

- Lead 最终全量 `npm test`：**exit 0**，38 个测试文件；
- 每项拆分由子智能体单独全量测试并推送，队列 Q4–Q12 全部勾选；
- 公开仓库 CI 触发。
