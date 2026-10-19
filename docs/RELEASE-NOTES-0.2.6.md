# 发布说明 0.2.6（mutating 元数据）

> 2026-10-19 · 扩展/provider **0.2.6** · `npm test` 35 个测试文件

## 结构

- 18 个写工具定义显式声明 `mutating: true`；
- `tool-guards.isWriteTool(tool)` 优先读工具元数据，`WRITE_TOOLS` 保留为兼容/测试集合；
- 新增 `test/tool-metadata.mjs`，CI 检查写工具必须声明、读工具不能误声明；
- 自审 P0 的「WRITE_TOOLS 隐式契约」已落地第一版；下一步按域拆 `tools.js`。

无运行时行为变化。
