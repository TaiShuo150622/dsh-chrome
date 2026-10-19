# 发布说明 0.1.91（虚拟鼠标 / 页面标注）

> 2026-10-18 · 扩展 **0.1.91** / provider **0.1.91** / 工具面 42（+evaluate 43）/ `npm test` 23 个测试文件

## 新增

- **`chrome_pointer`**：常驻虚拟鼠标（默认标签 DSH），可钉元素/坐标、移动、隐藏、点击波纹；截图可见，snapshot 不把标签当正文。
- **`chrome_annotate`**：文本/元素高亮、元素框、圆圈、箭头（可带文字）、说明气泡/序号、列出、清除/按 id 清除。
- 零依赖 overlay 层（`extension/overlay.js`）：扩展以 MAIN world content script 注入；headless backend 读取同一文件注入；扩展重载后的旧页面会自动补注入。
- 标注跟随滚动/resize 重绘；刷新页面清空。

## 测试

- `test/overlay.mjs`（真实 headless Chrome）：pointer 截图可见、highlight/box/circle/arrow/label/list/clear、snapshot 排除 overlay。
- `test/sandbox-smoke.mjs` 覆盖两个新工具（82 checks / 43 tools）。
- 全量 `npm test` 23 个测试文件；CI 绿。

## 已知限制

- 只覆盖主 frame；iframe/closed shadow root 内元素不可直接标注。
- 文本定位取第一次出现，动态页面建议用 ref/selector。
- 页面全屏/极端 z-index 时 overlay 可能被遮挡。
