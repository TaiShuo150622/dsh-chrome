# 发布说明 0.2.8（chrome_context 模块拆分）

> 2026-10-19 · 扩展/provider **0.2.8** · `npm test` 35 个测试文件

## 结构

- `chrome_context` 从 `src/tools.js` 移到 `src/tools-context.js`：
  - `createContextTool({ contexts, contextViewer, ownerOf, outputSchema, renderText })`；
  - context 生命周期（create/use/list/current/close/viewer）有独立依赖面；
  - 工具 schema/render/错误语义保持不变。
- tools 域拆分继续：lease、context 已移出，下一步 verify/read/write/tabs。

无运行时行为变化。
