# 发布说明 0.2.20（操作鼠标/视觉反馈）

> 2026-10-19 · 扩展/provider **0.2.20**

## 浏览器操作鼠标

- 页面 overlay 的虚拟指针从“圆点”改为 **GPT/Claude 风格箭头 cursor**；
- 点击/输入/按键/滚动显示动作标签与点击波纹；
- 桌面扩展默认自动跟随（`chrome_pointer auto` 可关闭/开启）；
- 可见 debug headless 窗口默认显示；隐藏 sandbox 可通过 `DSH_AUTO_POINTER=1` 或 `chrome_pointer auto` 开启；
- overlay 版本升到 v2，旧页面会重新注入新的箭头 cursor；
- 仍是页面 overlay（`pointer-events:none`），不拦截页面交互、不进入页面文本快照。

## 范围

- 这是**浏览器页面**的视觉反馈，不是 OS 级鼠标；
- OS 级鼠标/桌面操作仍属于未来独立的 `dsh-computer-use` 插件。

## 修复

- 修复 `PAGE_ACTIONS` 中 `overlay` 被 `drawRefOverlay` 重复键覆盖的问题；虚拟指针和 ref 高亮现在分别使用 `overlay` / `overlayDraw`，避免“Pointer hidden”；
- 新增 `test/extension-page-actions.mjs` 防重复键回归。

## 测试

- `test/overlay.mjs` 通过；
- 全量测试同 0.2.19 基线。
