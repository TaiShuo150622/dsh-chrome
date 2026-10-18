# F1 Spike：实时画面（screencast）可行性

> 日期：2026-10-17 · 扩展 0.1.85 / provider 0.1.79 · 工具面 39（evaluate 开启 40）
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

## 2.1 Viewer（方案 A）已实现

`chrome_screencast {op:"viewer"}` 返回 loopback 的实时画面 URL：

```text
http://127.0.0.1:<DSH web 端口>/dsh-chrome/live?token=<随机 token>
```

- provider 通过 Host `webServer.register` 注册 `/dsh-chrome/live`（HTML 轮询）与 `/dsh-chrome/live/frame`（最新 JPEG）；
- token 随机 48 hex，存 `~/.dsh/cache/dsh-chrome/live-token`（0600）；只接受 loopback 请求 + 正确 token；
- 页面每 300ms 拉一次帧（`cache-control: no-store`），帧来自 native host 写入的 `latest.jpg`；
- 实测：HTML 200、frame `image/jpeg 1280x642 6493B`、错误 token 403、非 loopback 403；`HEAD` 返回 405（只接受 GET）。

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

1. 方案 A viewer 已完成（见 §2.1）；剩余：自动停止（默认 5 分钟无查看者 / 10 分钟硬上限）与帧率/CPU 测量。
2. 若要嵌入 GUI 再做客户端面板（方案 B）。

## 5. 代码位置

| 位置 | 作用 |
|---|---|
| `extension/background.js` `startScreencast/stopScreencast/screencastStatus` | CDP 控制 + 帧 → native port |
| `extension/background.js` onEvent `Page.screencastFrame` | ack + 转发 + 计数 |
| `host/host.mjs` `materializeScreencastFrame` | latest.jpg + meta.json 原子落盘 |
| `src/tools.js` `chrome_screencast` | start/stop/status/diag，status 返回图片附件 |
| `test/extension-logic.mjs` | 帧计数/dispatch 回归 |
| `test/p2-tools.mjs` | provider start/status/stop 回归 |
