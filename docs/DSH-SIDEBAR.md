# DSH 右侧边栏浏览器（方案 A viewer 原型）

> 状态：**已接入 `src/index.js`（0.1.98）**。`chrome_context {op:"viewer"}` 返回每个 context 的 viewer URL；在 DSH 右侧边栏现有 Browser tab 打开即可看到截图并基础操控。
> 目标：不写 DSH client plugin，利用 DSH 右侧边栏现有的 **Browser tab** 打开一个 loopback viewer 页面，看到并基础操控隔离浏览器（I1/I2 context）。

## 1. 为什么是方案 A

方案 B（原生客户端面板）需要 client plugin + host→client 帧通道 + 客户端 bundle，成本高。方案 A 复用 Host 已有的 `webServer`：

```text
DSH 右侧边栏 Browser tab
  → http://127.0.0.1:<DSH web 端口>/dsh-chrome/context/<contextId>/view?token=...
  → provider webServer 路由
  → context driver (tab.screenshot / tab.clickAt / tab.type / ...)
```

优点：不需要构建客户端、不需要改 DSH；缺点：只是一个轮询截图的网页，不是原生面板，也不是实时视频。

与 `src/liveview.js`（screencast 最新帧 viewer）的区别：liveview 看的是**一个**全局 screencast 帧流；本 viewer 按 **contextId** 选择 driver，并且带基础输入回传。

## 2. 路由与契约

`registerContextViewer({ webServer, getContext, token, logger })` 返回：

```js
{
  enabled: boolean,
  token: string | null,
  urlFor(contextId): string | null,
  dispose(): void,
}
```

注册一条 `kind:"prefix"` 路由 `/dsh-chrome/context`，在其下解析：

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/dsh-chrome/context/:id/view?token=…` | 返回内联 HTML（无外部资源） |
| GET | `/dsh-chrome/context/:id/frame?token=…` | 调 driver `tab.screenshot`，返回 JPEG/PNG 字节 |
| POST | `/dsh-chrome/context/:id/input?token=…` | JSON 输入，转成 driver `tab.*` 调用 |

`frame` 查询参数：

- `format=jpeg|png`（默认 `jpeg`）；
- `quality=1..100`（默认 `70`）；
- `meta=1`：附带 `x-dsh-context-url` / `x-dsh-context-title` / `x-dsh-context-tab` 响应头（URL-encoded），viewer 用它更新 URL 栏和标题；
- 始终返回 `x-dsh-view-width` / `x-dsh-view-height`（截图对应的 CSS 像素视口尺寸，viewer 用它换算点击坐标）。

### 2.1 输入 JSON

```jsonc
{ "kind": "click",    "x": 120, "y": 340, "clickCount": 1 }
{ "kind": "type",     "text": "hello" }              // 默认 selector: ":focus"
{ "kind": "type",     "text": "x", "selector": "#q", "replace": true, "submit": false }
{ "kind": "key",      "key": "Enter" }
{ "kind": "scroll",   "deltaY": 480 }                // >0 向下，<0 向上
{ "kind": "navigate", "url": "https://example.com" } // 仅 http(s)
{ "kind": "history",  "op": "reload|back|forward" }  // viewer 的刷新/前进/后退按钮用
```

映射（owner 固定为 `viewer`）：

| kind | driver 调用 |
|---|---|
| `click` | `tab.clickAt { x, y, clickCount }` |
| `type` | `tab.type { text, selector \| ref, replace?, submit? }` |
| `key` | `tab.press { key }` |
| `scroll` | `tab.scroll { direction, amount }` |
| `navigate` | `tab.goto { url }` |
| `history` | `tab.history { op }` |

`type` 不带 `selector`/`ref` 时固定用 `selector: ":focus"`：viewer 里先点击页面上的输入框（`tab.clickAt` 会聚焦），再发送文本。空文本只有 `replace: true` 时才允许（用于清空字段）。

`history` 是超出题目所列五种 kind 的扩展，只为把 viewer 的刷新/前进/后退按钮接到 driver 的 `tab.history`。

### 2.2 `getContext(contextId)`

由调用方注入，同步或异步均可，返回 `{ driver, owner? }`：

```js
const getContext = (contextId) => {
  const view = contexts.get(contextId)
  const driver = contexts.driverFor(contextId)
  return view && driver ? { driver, owner: view.owner } : null
}
```

- 返回 `null`（或抛 `code === 'CONTEXT_NOT_FOUND'`）→ 路由返回 **404**；
- context 存在于但无 driver → **503**；
- driver 错误码 `TAB_NOT_FOUND` / `CONTEXT_NOT_FOUND` → **404**，其余 driver 错误 → **500**（JSON 里带 `error.code`/`error.message`）；
- `owner` 字段目前只作为调用方信息保留；viewer 的 driver 调用一律 `owner: "viewer"`，不复用 agent 的 owner。

> 注意 owner 边界：`HeadlessDriver` 按 owner 分 tab。viewer 固定用 `viewer`，所以它操作的是该 context 内 `viewer` 这个 owner 的 tab；如果 agent 用另一个 owner 调 `backend:"headless"`，两者可能是同一个 context 里的不同 tab。接入时若希望 viewer 看 agent 正在操作的页面，需要让 provider 为 viewer 使用一个独立/专用 context，或让调用方在 `getContext` 里返回一个已绑定 owner 的 driver 包装。

## 3. 安全边界

- **loopback only**：检查 `req.socket.remoteAddress`，只接受 `127.0.0.1` / `::1` / `::ffff:127.0.0.1`；其他一律 403。
- **token**：所有路由都要求正确 token，比较用 `crypto.timingSafeEqual`；token 长度/字符集受限。
- token 只在两处：
  - 内存（本次注册）；
  - 文件 `~/.dsh/cache/dsh-chrome/context-viewer-token`（0600，48 hex，跨 provider 重启复用；删除该文件即可轮换）。
  - 调用方也可以显式传 `token`（仅内存，不落盘，测试用）。
- **不暴露 CDP**：没有 evaluate、没有 WS、没有任意 JS；输入 kind 是白名单。
- HTML 带 CSP（`default-src 'none'`、只允许同源 fetch / blob 图片 / 内联样式脚本）和 `referrer-policy: no-referrer`；页面无任何外部资源。
- 风险提示：拿到 URL 的本机进程/用户可以看到该 context 的页面并发送点击/输入。原型没有 TTL、没有按用户鉴权、没有速率限制。viewer 的截图轮询本身也会持续驱动截图。

## 4. 使用方式（接入后）

1. 创建一个 context，例如 `chrome_context {op:"create", preset:"debug"}`（可见窗口）或默认 `sandbox`（headless）；
2. provider 侧拿到 contextId，调用 `viewer.urlFor(contextId)`，得到：
   ```text
   http://127.0.0.1:50863/dsh-chrome/context/<contextId>/view?token=<token>
   ```
3. 在 **DSH 右侧边栏现有的 Browser tab** 里打开这个 URL（前提：该 Browser tab 允许打开 localhost / loopback 页面；不允许时退回普通 Chrome 标签页）；
4. 页面里：
   - 截图约每 330ms 拉一次（实际帧率受截图耗时限制，通常低于 3fps）；
   - 点截图 = 在对应坐标点击（按截图 CSS 尺寸换算）；
   - URL 栏回车 = `tab.goto`；
   - `← / → / ⟳` = `tab.history back/forward/reload`；
   - 文本输入框 = `tab.type`（先点页面上的输入框）；
   - `Enter / Tab / Esc / 方向键` = `tab.press`；
   - 在截图上滚轮 = `tab.scroll`（120ms 合并一次）。

## 5. 集成点（Lead 合并时接）

`src/context-viewer.js` **没有**被 `src/index.js` 引用；`src/index.js` / `src/contexts.js` / `src/tools.js` 本轮均未修改。建议在 `index.js` 现有的 liveview `ctx.effect` 里并列注册：

```js
import { registerContextViewer } from './src/context-viewer.js'

const getContextForViewer = (contextId) => {
  const view = contexts.get(contextId)
  const driver = contexts.driverFor(contextId)
  return view && driver ? { driver, owner: view.owner } : null
}

ctx.effect(() => {
  const webServer = ctx.get('webServer')
  if (!webServer) {
    logger?.warn?.('dsh-chrome: webServer is not available; viewers are disabled')
    return () => {}
  }
  registerLiveView({ webServer, home, logger })
  const contextViewer = registerContextViewer({
    webServer,
    getContext: getContextForViewer,
    logger,
  })
  return () => {
    contextViewer.dispose()
    unregisterLiveView()
  }
})
```

还需要决定（本轮未做）：

- 怎么把 `urlFor(contextId)` 暴露出去：加到 `chrome_context` 的返回字段、新工具 op，还是仅日志/调试接口；
- 是否仅对 `debug`/`sandbox-persistent`（named profile）开放 viewer；
- 是否把 `contextViewer` 的 token 与 liveview 的 token 分开（当前分开，两个文件、两个 token）。

## 6. 限制（明确不做的事）

- **不是实时视频**：轮询截图，有截图+编码+传输延迟；不做 WebSocket/SSE/帧推送。
- **每次 GET frame 都调一次 `tab.screenshot`**：headless driver 会把每张截图写到 context profile 的 `screenshots/` 下，viewer 长时间开着会积累截图文件；context 关闭/清理后随 profile 处理。
- **输入仅基础事件**：没有 hover、drag、select、上传、对话框处理、`evaluate`；`type` 聚焦语义依赖先点击；`key` 只透传 driver 支持的键。
- **没有多 viewer 协调**：同一 format/quality 的并发 frame 请求会合并成一次 driver 调用，但不做限流、队列或公平性保证。
- **URL 栏/标题依赖 `meta=1`**：`tab.tabs` 失败时 frame 仍返回，只是 URL 栏不更新。
- **依赖 DSH Browser tab 能打开 loopback**：如果侧边栏的 Browser tab 拦截 `http://127.0.0.1:*`（混合内容/策略/权限），方案 A 在该 tab 里不可用；回退是普通 Chrome 标签页。
- **不创建/不关闭 context**：`getContext` 返回 null 就是 404；viewer 不持有 context 生命周期。
- **未做版本升级**：按协调要求本轮没有改 `package.json` 的 version、`extension/manifest.json`、README、CHANGELOG、release notes；Lead 合并后统一升级。

## 7. 测试

```bash
node test/context-viewer.mjs
```

已加入 `package.json` 的 `test` 链（`node test/liveview.mjs` 之后）。覆盖：

- 注册成功 / `urlFor` / `dispose` 移除路由；
- loopback、token、方法、404（未知 context / 非法 id / 未知 action）；
- GET view 的内联 HTML、CSP、无外部资源；
- GET frame 的 JPEG/PNG 字节、`content-type`、`no-store`、CSS 尺寸头、`meta=1` 头；
- POST click/type/key/scroll/history/navigate 对应的 driver 调用与固定 owner `viewer`；
- 非法 JSON、未知 kind、非法 URL/坐标/滚动、body 过大、input 仅 POST；
- 自动生成 token 的 0600 文件与跨注册复用；
- 依赖缺失时 fail-soft（`enabled:false`）。

## 8. 文件位置

| 文件 | 作用 |
|---|---|
| `src/context-viewer.js` | viewer 路由、token/loopback、driver 输入转发、内联 HTML |
| `test/context-viewer.mjs` | fake webServer + fake driver 单元测试 |
| `docs/DSH-SIDEBAR.md` | 本文件 |
| `package.json` | `test` 链新增 `node test/context-viewer.mjs` |
