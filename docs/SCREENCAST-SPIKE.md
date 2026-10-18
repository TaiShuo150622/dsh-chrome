# F1 Spike：实时画面（screencast）可行性

> 日期：2026-10-17 · 扩展 0.1.87 / provider 0.1.87 · 工具面 40（evaluate 开启 41）
> 目标：验证 CDP `Page.startScreencast` 帧流能否被扩展→native host→provider 接住，为后续「实时画面」定方案。

## 1. 已验证的链路

```text
chrome_screencast {op:"start"}
  → extension: withDebugger + Page.startScreencast(jpeg, q=60, everyNthFrame=2)
  → Page.screencastFrame 事件 → ack + port.postMessage({type:"screencast-frame", data})
  → native host 拦截该消息 → 写 ~/.dsh/cache/dsh-chrome/screencast/latest.jpg + meta.json
chrome_screencast {op:"status"}
  → 读 latest.jpg → image attachment + frames/updatedAt
chrome_screencast {op:"stop"}
  → Page.stopScreencast + 计数
```

实测（桌面 Chrome，测试页）：

```text
chrome_screencast start quality=60 everyNthFrame=2
chrome_screencast status  → Screencast active (jpeg), frames=20  + 1280x642 JPEG
chrome_screencast stop    → frames=20 in 21426ms
meta.json: {"format":"jpg","bytes":6493,"frames":20,
            "metadata":{"deviceWidth":1440,"deviceHeight":722,"scrollOffsetY":1389.5}}
```

帧在页面有变化（滚动）时到达；静态页不会持续产帧（CDP 行为）。约 25–40ms/帧（有变化时）。

## 2. 踩到的坑（都已修）

| 现象 | 根因 | 修法 |
|---|---|---|
| start 成功但 frames=0、无文件 | 首帧在 `Page.startScreencast` promise 返回前到达，此时 `session.screencast` 还是 null → 不 ack；Chrome 未收到 ack 不再发帧 | **先设 screencast 状态再发 start** |
| 后续工具调用报 "Another debugger is already attached" | screencast 会 pin 住 debugger；`withDebugger` 的 attach 守卫只看 capture，没有看 screencast → 重新 attach 把 screencast 打断 | attach 守卫加 `!session.screencast`，复用 pinned 会话 |
| worker 重启后旧 debugger 会话成孤儿，attach 失败 | MV3 SW 被回收后 Chrome 侧 debugger 仍 attached（同一扩展） | worker 启动 `getTargets()` 清扫孤儿；attach 失败时 detach 后重试一次 |
| 帧写盘无文件 | native host 之前只转发带 id 的响应 | host 拦截 `type:"screencast-frame"` 写 latest 帧 + meta（原子 rename） |
| start 成功、frames 一直 0；viewer 停在旧帧 | Chrome 只给**可见 tab**合成帧：会话 tab 在后台（viewer 通常是另一个窗口/标签），`Page.startScreencast` 能 attach 但不产帧 | 0.1.87：start 前自动激活 tab + 恢复/聚焦窗口（见 §2.2） |

## 2.1 Viewer（方案 A）已实现

`chrome_screencast {op:"viewer"}` 返回 loopback 的实时画面 URL：

```text
http://127.0.0.1:<DSH web 端口>/dsh-chrome/live?token=<随机 token>
```

- provider 通过 Host `webServer.register` 注册 `/dsh-chrome/live`（HTML 轮询）与 `/dsh-chrome/live/frame`（最新 JPEG）；
- token 随机 48 hex，存 `~/.dsh/cache/dsh-chrome/live-token`（0600）；只接受 loopback 请求 + 正确 token；
- 页面每 300ms 拉一次帧（`cache-control: no-store`），帧来自 native host 写入的 `latest.jpg`；
- screencast 有 **10 分钟硬上限**自动停止（桌面扩展与 headless 都实现）；
- viewer 有 **5 分钟无帧请求自动停止**守卫（`src/screencast-guard.js`，只在 viewer 启用时生效）；
- 实测：HTML 200、frame `image/jpeg 1280x642 6493B`、错误 token 403、非 loopback 403；`HEAD` 返回 405（只接受 GET）。

## 2.2 后台 tab 无帧 → start 自动激活（0.1.87）

**问题**：viewer 打开后，会话 tab 通常被切到后台（用户在别的 tab/窗口看 viewer）。Chrome 的
compositor 只给可见 tab 产帧，于是 `Page.startScreencast` 表面成功（`active:true`，attach 正常），
`Page.screencastFrame` 却一帧不来：`frames=0`，host 里只有上一次的 `latest.jpg`，viewer 看起来
「卡住/旧帧」。仅靠 `Page.bringToFront` 这类 CDP 命令不够——窗口最小化/未聚焦时同样没有帧。

**修法**（`extension/background.js` `startScreencast`，扩展 0.1.87）：start 前先确保目标 tab 可见。

1. tab 不是 active：`chrome.tabs.update(tabId, {active:true})`，并把这次激活记入
   `expectedActivations`（和 `chrome_tabs {op:"focus"}` 同口径，不会被当成用户切走）。
2. tab 在**折叠的 tab 组**里（DSH 会话组默认 `collapsed:true`）：`chrome.tabGroups.update(groupId,
   {collapsed:false})`，折叠组里的 tab 同样不渲染。
3. 窗口被最小化：`chrome.windows.update(windowId, {state:"normal"})`。
4. 窗口未聚焦：`chrome.windows.update(windowId, {focused:true})`。
5. 若会话正处于 `USER_SWITCHED` pause：**不再报错**。把 tab 带到前台等价于
   `chrome_tabs {op:"focus"}` / `chrome_resume`，直接清掉 pause（`resumedFromPause:true`），
   后续动作不再被 suspend；激活失败且仍不可见时保留 pause 并在 `hint` 里说明。
6. 激活动作写入 diag：`screencast-autofocus` / `screencast-auto-resume`（`chrome_screencast
   {op:"diag"}` 可查）。

**新增返回字段**（provider 的 `outputSchema` 是 `additionalProperties:true`，扩展字段会原样透传）：

| 字段 | 位置 | 含义 |
|---|---|---|
| `activated` | start | 本次 start 是否调用了 `tabs.update({active:true})` |
| `expandedGroup` | start | 是否把折叠的会话 tab 组展开了 |
| `focusedWindow` | start | 是否调用了 `windows.update({focused:true})` |
| `restoredWindow` | start | 是否把最小化窗口恢复成 `normal` |
| `resumedFromPause` | start | 是否顺带清掉了 `USER_SWITCHED` pause |
| `visible` / `tabActive` / `windowFocused` / `windowState` | start + status | 激活后的可见性快照 |
| `tabGroupCollapsed` | start + status | tab 所在组是否折叠（`null` = 不在组里/读不到） |
| `hint` | start + status | 给调用方/前端的提示：已自动激活，或「需要可见 tab」 |
| `frameAt` | status | 最近一帧的到达时刻（epoch ms；无帧为 `null`）；`lastAt` 仍是 ISO 字符串 |
| `frameAgeMs` | status | 距最近一帧的毫秒数（无帧为 `null`）；持续变大 = 画面冻结 |

**幂等**：screencast 已 active 时再调 `start` 也会先做可见性恢复（返回 `alreadyActive:true`
并带上上述字段），所以「用户切走后画面冻结」可以直接再 start 一次恢复。

**已知限制**：

- 只能保证「active tab + 非折叠组 + 非最小化窗口」；Chrome 的遮挡检测（窗口被别的应用完全
  盖住）和 OS 挂起仍可能无帧，扩展侧探测不到，只能靠 `status.visible` / `frameAgeMs` 判断。
- viewer 页面（`src/liveview.js` 的 HTML）还没读这些字段，页面文案仍是旧的「先 start」；把
  `hint`/`visible` 渲染到 viewer 上属于 provider 侧后续改动，不在本次扩展修复的文件范围内。
- 自动激活会抢焦点：这是拿到帧的必要代价，模型调用 `op:"start"` 前应向用户说明。

**测试**：`node test/extension-logic.mjs` 覆盖后台 tab + 折叠组 + 最小化窗口下的
`tabs.update`/`tabGroups.update`/`windows.update` 断言、`USER_SWITCHED` 复位、
`visible`/`frameAt` 字段；`node test/p2-tools.mjs` 覆盖 provider 侧 start/status/stop 透传。
真机验证步骤见 §4.1。

## 3. 「实时画面」还缺什么

现在的形态是 **轮询式最新帧**（status 取一张图），不是 UI 上的实时画面。两条路：

### 方案 A：provider 自带 viewer（推荐先做）

- provider `ctx.inject(['webServer'])` 注册：
  - `GET /dsh-chrome/live?token=…` → HTML（`<img>` 每 200–500ms 拉 `/frame?token=…`，cache-busting）
  - `GET /dsh-chrome/live/frame?token=…` → 返回 latest.jpg（no-store）
- token：provider 启动时随机生成，存 `~/.dsh/cache/dsh-chrome/screencast/token`（0600），URL 带 token；viewer 有 TTL、最多 1 个活跃查看者；只允许 loopback origin（DSH web 本身只监听本机）。
- 优点：不依赖 DSH 客户端构建，一天内可完成；缺点：不是嵌入 GUI 的原生面板，用户需另开一个标签页。
- 安全：帧是用户页面内容；token 泄露 = 可看屏幕；需要 token 随机、短期、可随时 stop。

### 方案 B：DSH 客户端面板（原生但重）

- 需要 client plugin + 帧通道（host→client event / SSE），DSH 桌面端要构建客户端 bundle；适合后续产品化，不适合当前 spike。
- 估：3–5 天（含客户端构建、布局、断线重连）。

## 4. 建议

1. 方案 A viewer 已完成（见 §2.1）；后台 tab 无帧已修（见 §2.2）。
2. 剩余：帧率/CPU 测量；把 `visible`/`frameAt`/`hint` 渲染到 viewer 页面（provider 侧
   `src/liveview.js`，不在扩展修复范围内）。
3. 若要嵌入 GUI 再做客户端面板（方案 B）。

### 4.1 真机验证步骤（扩展 0.1.87，合并后跑）

1. 重建扩展包/重载扩展（chrome://extensions 或 host 自动 reload），确认版本 0.1.87，
   重启 provider 让扩展与 provider 都指向新版本。
2. 会话 tab 在前台：`chrome_screencast {op:"start"}` → 期望 `activated:false`、`hint:null`；
   滚动页面后 `status` 的 `frames` 增长、`frameAgeMs` 保持小。
3. 切到别的 tab 让会话 tab 进后台，再 `start` 一次：期望 `activated:true`、`visible:true`
   （会话组默认折叠时还会 `expandedGroup:true`；若切走期间被 pause，`resumedFromPause:true`），
   之后 `status` 继续产帧。
4. 最小化 Chrome 窗口后重复第 3 步：期望 `restoredWindow:true`、`focusedWindow:true`。
5. 证据记录：`frames=N`、`frameAt`/`frameAgeMs`、`~/.dsh/cache/dsh-chrome/screencast/meta.json`
   的 `updatedAt`/`bytes`，以及 viewer 页面是否从旧帧恢复。

## 5. 代码位置

| 位置 | 作用 |
|---|---|
| `extension/background.js` `startScreencast/stopScreencast/screencastStatus` | CDP 控制 + 帧 → native port |
| `extension/background.js` `readTabVisibility` / `makeTabVisibleForScreencast` | 可见性检查 + 自动激活 tab/展开组/恢复聚焦窗口（§2.2） |
| `extension/background.js` onEvent `Page.screencastFrame` | ack + 转发 + 计数 |
| `host/host.mjs` `materializeScreencastFrame` | latest.jpg + meta.json 原子落盘 |
| `src/tools.js` `chrome_screencast` | start/stop/status/diag，status 返回图片附件 |
| `test/extension-logic.mjs` | 帧计数/dispatch + 后台 tab 自动激活/USER_SWITCHED 复位回归 |
| `test/p2-tools.mjs` | provider start/status/stop 回归 |
