# 浏览器侧边栏（side panel）

> 目标：在 Chrome 右侧边栏直接打开 DeepSeek Harness，边浏览网页边和 DSH 交互。
> 当前是 **v1 preview**：扩展侧边栏壳 + 可配置的 DSH Web 嵌入。

## 1. Claude / Codex 是怎么做的（调研）

- **Claude in Chrome / Cowork**：扩展自带侧边栏 UI，登录 Claude 账号；侧边栏会话与桌面/Web/移动端共享同一个 Cowork 会话；浏览器动作走扩展权限，另有审批与 prompt-injection 检查。它**不是**把 Claude 网页 iframe 进去，而是扩展自己的前端 + Anthropic 后端。[Claude Cowork in Chrome side panel](https://claude.com/blog/cowork-chrome-side-panel)
- **ChatGPT / Codex Chrome 扩展**：同样是扩展侧边栏 chat UI，和桌面端/Codex 任务联动；官方 issue 暴露了关键点：**从侧边栏新建的 Codex 任务一开始拿不到浏览器控制能力**，因为 capability 绑定在“桌面端发起的任务”上。侧边栏不能只是一个独立 UI，必须连到同一个 agent/tool host。[openai/codex#45573](https://github.com/openai/codex/issues/45573)
- **Chromex（开源，最接近我们的架构）**：MV3 侧边栏 UI + **native messaging local bridge** 连本地 Codex app-server；凭证不进扩展存储；浏览器控制走 content script，页面上有可见指示。它把“侧边栏聊天”和“浏览器控制”拆成两层：UI ↔ 本地 bridge ↔ agent，扩展只负责工具/上下文。[GENEXIS-AI/chromex](https://github.com/GENEXIS-AI/chromex)

结论：侧边栏本身只是 Chrome 的 `sidePanel` API（扩展页面），难点在 **UI 连到哪个 agent** 和 **浏览器能力怎么挂到同一个会话**。

## 2. 本插件的实现（v1 preview）

- `manifest` 增加 `sidePanel` 权限和 `side_panel.default_path = sidepanel.html`；
- 侧边栏页面：标题栏（重新加载/新标签打开/设置）+ iframe 嵌入 DSH Web；
- `chrome.storage.local` 记住 DSH Web URL；可一键检测当前打开的 DSH 标签页；
- 工具栏 popup 增加 **Sidebar** 按钮，用户点击（user gesture）调用 `chrome.sidePanel.open({windowId})`；
- 只接受 `127.0.0.1` / `localhost` / `[::1]` 的 http(s) URL，避免把任意网站嵌进侧边栏。

### 为什么 iframe 方案对 DSH Web 走不通（重要）

实测 iframe `http://127.0.0.1:50863/` 显示：

> `dsh web authentication required; reopen the URL printed by dsh web.`

查 DSH 的 `dsh-client-connection` 文档后确认这是**设计上的硬边界**，不是“补个 token 就行”：

- `dsh web` 启动时打印 `?token=...` 的 root URL；`GET /` 用它换一个 **HttpOnly + SameSite=Strict** 的签名 cookie，然后 302 到干净 URL；
- 每个 RPC/WebSocket 都要求该 cookie，且 Host/Origin fence 明确拒绝 `sec-fetch-site: cross-site`；
- Chrome 扩展侧边栏的 iframe 是 `chrome-extension://` 跨站嵌入，cookie 不会带、`sec-fetch-site` 是 cross-site → 401/403。

所以 **v1 的 iframe 只能在“本地同站页面”里工作，不能直接嵌 DSH Web**。侧边栏作为 UI 壳是可行的，但真正的 DSH 内容必须走 **native bridge**（见 §4），不是 iframe。v1 保留“在标签页打开”作为可用回退。

## 3. v1 怎么用（仅 UI 壳）

1. 安装/重载扩展（`chrome://extensions` → Reload）；
2. 点扩展图标 → **Sidebar** 打开侧边栏；它会提示配置 DSH Web 地址；
3. 目前推荐点 **↗ 在标签页打开** 使用 DSH；侧边栏内嵌 DSH Web 需要等 v2 的 bridge 实现（见 §4）。

## 4. 后续（真正的原生侧边栏 chat）

v1 是“嵌 DSH Web”。要做成像 Claude/Codex 那样原生 chat + 工具，推荐：

- 侧边栏 UI 走 `chrome.runtime` ↔ background ↔ **现有 native bridge** ↔ provider；
- provider 暴露最小 chat/stream 协议（或直接复用 DSH session API），保证侧边栏和 DSH 主会话共享上下文；
- 浏览器控制继续走现有 tools；侧边栏显示当前 tab/工具调用/审批状态；
- 这样不依赖 DSH Web 的 token，也不受 iframe/CSP/第三方 cookie 影响。

## 5. 限制

- DSH Web token 会随 `dsh web` 重启变化，需要重新粘贴；
- iframe 内无法读取跨域页面状态，侧边栏不能判断“认证失败”只能提示；
- 目前侧边栏展示的是 DSH Web 全界面，窄宽度下排版取决于 DSH Web 响应式布局；
- 原生 chat + 浏览器能力绑定是下一步，不是 v1。
