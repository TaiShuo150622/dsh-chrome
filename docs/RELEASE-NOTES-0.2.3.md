# 发布说明 0.2.3（tool-guards 拆分）

> 2026-10-19 · 扩展/provider **0.2.3** · `npm test` 34 个测试文件

## 结构

- 新增 `src/tool-guards.js`：`WRITE_TOOLS` / `isWriteTool` / `withWriteLease`；
- `src/backend.js` 只负责 `backend` 参数和 backend 路由，不再同时维护 lease 策略；
- 行为不变：`browser.shared.enabled=true` 时写工具仍自动 acquire/release active tab lease；默认关闭。

## 文档

- 新增 `docs/CODE-REVIEW-SELF.md`：自己审一遍后的结构问题与重构顺序；
- Codex 结构审查结果见 `docs/CODE-REVIEW-CODEX.md`（如可用）。

无运行时行为变化。
