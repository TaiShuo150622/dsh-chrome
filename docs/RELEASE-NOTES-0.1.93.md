# 发布说明 0.1.93（浏览器侧边栏 v1 preview）

> 2026-10-18 · 扩展/provider **0.1.93** · 工具面 42（+evaluate 43） · `npm test` 24 个测试文件

## 新增

- `sidePanel` 权限 + `side_panel.default_path = sidepanel.html`；
- 工具栏 popup 新增 **Sidebar** 按钮（用户手势调用 `chrome.sidePanel.open`）；
- 侧边栏页面：可配置 DSH Web URL、记住设置、检测当前 DSH 标签页、重新加载、在标签页打开；
- 只接受本机 127.0.0.1/localhost 的 http(s) URL。

## 已知限制

- v1 是扩展侧边栏 UI 壳：DSH Web 使用 SameSite=Strict cookie + 拒绝 cross-site iframe，**直接 iframe DSH Web 不可行**；侧边栏目前主要提供配置/检测/在标签页打开，真正的内嵌要到 v2 native bridge；
- 还没有原生 chat 协议（下一步：侧边栏 ↔ native bridge ↔ provider，共享 DSH 会话与浏览器工具能力）；
- 调研与架构说明见 `docs/SIDEPANEL.md`。

## 测试

- `test/sidepanel.mjs` 校验 manifest/permission/页面/逻辑/按钮；
- 全量 `npm test` 24 个测试文件；CI 绿。
