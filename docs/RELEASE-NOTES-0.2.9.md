# 发布说明 0.2.9（chrome_verify 模块拆分）

> 2026-10-19 · 扩展/provider **0.2.9** · `npm test` 35 个测试文件

## 结构

- `chrome_verify` 从 `src/tools.js` 移到 `src/tools-verify.js`：
  - `createVerifyTool({ contexts, ownerOf, fsp, path, randomUUID, outputSchema, renderText })`；
  - 步骤解释、断言、artifact 保存独立；
  - 工具 schema/render/执行语义保持不变。
- 至此 lease / context / verify 三个新工具都已从主 tools 文件移出。

无运行时行为变化。
