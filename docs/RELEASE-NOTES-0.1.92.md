# 发布说明 0.1.92（自动跟随 / iframe / 标注持久化）

> 2026-10-18 · 扩展/provider **0.1.92** · 工具面 42（+evaluate 43） · `npm test` 23 个测试文件

## 新增

- **虚拟鼠标自动跟随**：`chrome_pointer {op:"auto", enabled}`。桌面扩展默认开启，click/type/hover 自动移动 overlay 指针；headless 默认关闭，需显式开启或 `DSH_AUTO_POINTER=1`。
- **iframe 标注**：`chrome_annotate {..., frame:true}` / `chrome_pointer {op:"show", frame:true}` 会在所有 frame 中查找目标；扩展走 `scripting.executeScript allFrames`，headless 走 `Page.createIsolatedWorld`；返回 `frameId/frameUrl`。
- **持久化/导出**：标注自动写 `sessionStorage`（按 URL），页面刷新/overlay 重注入后自动恢复；新增 `chrome_annotate {op:"export"}` 返回 `{url,count,annotations,json}`，`{op:"restore"}` 手动恢复，`{op:"clear"}` 清持久化。
- **修正**：目标不存在时标注返回 `TARGET_NOT_FOUND`，不再静默添加空标注。

## 测试

- `test/overlay.mjs` 覆盖 auto click、iframe frameId、reload restore、export JSON。
- sandbox 82 checks / 43 tools；全量 `npm test` 23 个文件。
- 私有仓库 CI 绿。

## 限制

- 自动跟随目前覆盖 click/type/hover；drag/select/press/scroll 还没有。
- iframe 内标注被 iframe 视口裁剪，跨 iframe 箭头不会越界。
- sessionStorage 持久化只在同一 tab 的同一 URL 有效；跨 tab/会话需要 export。
