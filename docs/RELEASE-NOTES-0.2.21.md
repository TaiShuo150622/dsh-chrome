# 发布说明 0.2.21（鲸鱼尾巴 cursor）

> 2026-10-19 · 扩展/provider **0.2.21**

## 视觉反馈

- 页面虚拟 cursor 从通用箭头改为 **DSH 鲸鱼/鱼形 logo**（使用 DSH 品牌图形，带白色描边）；
- 保留动作标签（`DSH · click/type/hover/scroll`）、点击波纹、移动动画；
- 桌面扩展默认自动跟随；可见 debug 窗口默认显示；隐藏 sandbox 可用 `DSH_AUTO_POINTER=1` / `chrome_pointer auto`；
- overlay v2 重新注入；旧页面刷新一次即可看到新 cursor；
- 仍是 `pointer-events:none` 页面 overlay，不拦截交互、不进入页面文本快照。

## 测试

- `test/overlay.mjs`、`test/extension-page-actions.mjs` 通过；
- 已在真实 Chrome 上用 example.com 手动验证 cursor 显示并隐藏。
