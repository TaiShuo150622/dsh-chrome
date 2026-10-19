# 发布说明 0.2.7（chrome_lease 模块拆分）

> 2026-10-19 · 扩展/provider **0.2.7** · `npm test` 35 个测试文件

## 结构

- `chrome_lease` 从 `src/tools.js` 移到 `src/tools-lease.js`：
  - `createLeaseTool({ leases, ownerOf, outputSchema, renderText, normalizeLeaseError })`；
  - 主 tool 文件只负责组装，不再包含 lease 的全部 schema/render/execute；
  - 工具名、schema、render、错误语义保持不变。
- 这是 tools 域拆分的第一步；后续按同样方式移 context/verify，再拆 read/write/tabs。

无运行时行为变化。
