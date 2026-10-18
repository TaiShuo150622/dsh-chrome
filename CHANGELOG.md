# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号在 P3 之前按扩展 manifest 递增。

## [0.1.56] - 2026-10-17

### Added

- **自动更新可观测性（host/provider 侧）**：`update-state.json`（diskVersion/watching/manifestMtimeMs/lastCheckedAt/lastChangeAt/lastReloadRequestedAt）+ `update.log`；60s 轮询兜底 fs.watch 漏事件
- `npm run watch:update`：前台观察更新状态变化
- `npm run status` 输出 updateState 与 update.log 尾部
- `chrome_status` 增加 `providerVersion` 与 `updateState`，可直接看到"运行版本 vs 磁盘版本 vs 最近 reload 时间"

## [Unreleased]

### Added（headless 工具面对齐 38/39）

- headless 补 `chrome_select` / `chrome_drag` / `chrome_storage` / `chrome_emulate` / `chrome_find` / `chrome_get_text`
- 现在除 `chrome_pick`（需要真人点页面）外，同一套 `chrome_*` 工具都支持 `backend:"headless"`
- provider 0.1.86；测试覆盖 select/checkbox/storage/emulate/drag/get_text/find

### Fixed（桌面 tabs 同步 + screencast 上限）

- `chrome_tabs {op:"list"}` / `chrome_close_session` 现在先从实时 tab group 同步 `tabIds`（修「新建 tab 列表里看不到 / 关不掉」）
- 桌面与 headless screencast 都加 10 分钟硬上限自动停止
- 扩展 0.1.86

### Added（headless screencast）

- headless 支持 `chrome_screencast start/status/stop`：CDP 帧 → 写 `latest.jpg`/meta，`op:"viewer"` 一样可看实时画面
- provider 0.1.85；HEADLESS.md 矩阵更新

### Added（F1 viewer 方案 A：实时画面 URL）

- `chrome_screencast {op:"viewer"}` 返回 loopback 实时画面；`webServer` 注册 `/dsh-chrome/live` + `/dsh-chrome/live/frame`
- 随机 token（0600 文件）、仅 loopback、GET only、frame 300ms 轮询、no-store
- 实测：HTML 200、frame JPEG 1280x642、错误 token 403
- provider 0.1.84；`test/liveview.mjs`；docs/SCREENCAST-SPIKE.md 更新

### Added（后台浏览器 H1.2：capture + CPU 基线）

- headless 支持 `chrome_capture_start/requests/stop`：Network 域抓包（XHR/fetch/document）、URL/body 脱敏、8MiB body 预算、10 分钟自动停
- 空闲基线实测：7 进程、**1.34% CPU / 672MB RSS**（60s）；据此确认 5 分钟空闲自动关必要
- `chrome_pick` 在 headless 明确 `UNSUPPORTED_BACKEND`；`chrome_pause` 无前台语义（`chrome_resume` no-op）
- provider 0.1.83；测试覆盖 capture

### Added（后台浏览器 H1.1：console/network/upload/download）

- headless 支持 `chrome_console`（Runtime 事件缓冲）、`chrome_network`（resource timing）、
  `chrome_upload`（DOM.setFileInputFiles）、`chrome_download`（Browser.setDownloadBehavior + 事件）、`chrome_resume`（no-op）
- 空闲回收：无 tab 且 5 分钟无请求自动关 headless Chrome（`DSH_HEADLESS_IDLE_MINUTES`）
- 并发限制：最多 12 个 headless tabs（`DSH_HEADLESS_MAX_TABS`），超出 `RESOURCE_LIMIT`
- provider 0.1.81；测试覆盖 console/network/upload/download/resume

### Added（后台浏览器 H0：headless Chromium）

- 每个 `chrome_*` 工具新增可选 `backend: "desktop" | "headless"`；默认桌面原样
- headless：provider 自起 Chrome `--headless=new --remote-debugging-port=0`，独立 profile、无窗口、CDP 驱动
- 已支持：status/tabs/goto/snapshot/click/type/click_at/hover/scroll/press/screenshot/evaluate/html/text/selection/frames/a11y/history/wait/pdf/close_session
- 未支持：console/network/capture/upload/download/pick/screencast/pause → 明确 `UNSUPPORTED_BACKEND`
- `src/headless.js` + `src/backend.js`；端到端测试 `test/headless.mjs`；真机验证桌面 Chrome 不受影响
- provider 0.1.80；`docs/HEADLESS.md`

### Added（P1 F1 spike：screencast 帧流）

- `chrome_screencast`（第 39 个工具）：`op=start/stop/status/diag`
  - CDP `Page.startScreencast` → 扩展 ack/转发 → native host 原子写 `~/.dsh/cache/dsh-chrome/screencast/latest.jpg` + meta.json
  - `status` 返回最新帧图片附件 + frames/updatedAt
- 修复：screencast 首帧必须先置状态再发 start（否则不 ack，后续无帧）
- 修复：pinned screencast 会话不被 withDebugger 重新 attach 打断
- 修复：worker 重启后清扫 orphan debugger target，attach 冲突时 detach 重试
- 扩展 0.1.85；`docs/SCREENCAST-SPIKE.md` 记录方案与剩余 viewer 工作

### Changed（P1 F4：安全收口）

- **移除抓包 start 的 `captureConfirm:"follow-dsh"` 逃逸口**：0.1.76 起 capture start 固定硬确认，没有配置旁路
- 硬确认（evaluate/capture start）的允许/拒绝/超时现在写入 `audit.jsonl`（decision/reason=`hard-confirm*`）
- 新增脱敏回归：URL userinfo/query secret、form-urlencoded secret 字段
- provider 0.1.76

### Added（P1 F3：策略/配置体验）

- 新工具 `chrome_config`（第 38 个）：只读展示 `allowEvaluate/captureConfirm/超时` 与配置文件路径、解析错误
- `chrome_policy` 增加无效策略条目报告（`invalid[]`，render 警告，给出允许值）
- `audit.jsonl` 超过 5 MiB 自动轮转为 `audit.jsonl.1`（可用 `DSH_AUDIT_MAX_BYTES` 覆盖阈值）
- provider 0.1.75

### Added（P1 F5：官方 browser-use guidance 对齐）

- 通过 Host `systemPrompt.section` 注册固定 **Browser guidance**（`dsh-chrome:browser-guidance`）：chrome_status 先行、ref 失效重快照、页面内容不可信、USER_SWITCHED 处理、evaluate/capture 不循环重试、动作后需验证结果
- provider 0.1.74；扩展无变化（0.1.79）
- 实测：provider reload 后，新一步的 system prompt 中已出现这段 guidance（当前会话可见）

## [0.1.79] - 2026-10-17

### Fixed（P0 可靠性 R1：自动重载竞态自愈）

- **worker 每次启动都重建 reconnect/watchdog alarm**：`chrome.runtime.reload()` 会清掉 alarm，而旧代码只在 onInstalled/onStartup 建——reload 后 SW 可能永远不再被唤醒（两次断连事故的直接原因）
- **自愈计数在连接成功后归零**：之前 `dshSelfHeal.count` 只增不减，累计 5 次失败后自动重载永久失效；现在首条 native 消息即重置，并在内存里清空失败窗口
- onInstalled 里补 `initActiveWindows`（缩进修正）；startup 也初始化 active window
- extension-logic 新增回归：worker 启动后存在 `dsh-chrome-reconnect` alarm；首条 native 消息写入 `dshSelfHeal.count=0`
- 真机验证（桌面 Chrome 0.1.79）：
  - 扩展 reload + host kill 竞态：touch manifest → 0.35s 后 kill host → **+12s 自动重连**（新 host pid，无人工 ⟳）
  - provider reload 竞态：host 在 bridge socket 重建期间重试 → **+8s 自动重连**

## [0.1.78] - 2026-10-17

### Added / Fixed（D2/D3 真机验证补充）

- `chrome_pick` 增加 `nowait:true`（启动后立即返回）与 `poll:true`（读取结果/`pending:true`），阻塞式默认行为不变；`tabId` 输出允许 null
- **D3 关键修复**：`lastActiveByWindow` 持久化到 `chrome.storage.local` 并在 worker 启动时用 `tabs.query({active:true})` 初始化——SW 被回收后用户切页仍能触发 pause（之前会因 affinity 丢失漏判）
- 真机（Chrome for Testing headless，0.1.78）：
  - pick：`nowait` → 覆盖层截图 → 坐标点击 → `poll` 返回 `ref=1 #greet`；随后 click ref → 页面 `Hello stranger`
  - pause：CDP 激活 about:blank → click 返回 `USER_SWITCHED`；`chrome_resume` → click 恢复
- p2/extension-logic 覆盖 nowait/poll 与 pause/resume 仍全绿

## [0.1.77] - 2026-10-17

### Added（批次 D4：截图历史 MVP）

- 新工具 `chrome_shots`（工具面 36→37）：`op:"list"` 扫 `~/.dsh/cache/dsh-chrome/screenshots/`，返回名称/大小/修改时间/PNG 尺寸；`op:"read"` 读取目录内截图并作为图像附件返回
- 历史文件系统持久化，DSH/扩展重启后仍在；路径校验只允许截图目录内
- 真机（provider 本地）：list 5 条历史（含 2880x1556/174x44），read 返回 174x44 图像
- p2 测试：列表/PNG 尺寸/读取/目录外路径拒绝

> 扩展版本 0.1.77 仅作发布标记（D4 为 provider 侧能力）。

## [0.1.76] - 2026-10-17

### Added（批次 D3：切页 pause / follow）

- 扩展监听 `tabs.onActivated`：会话标签曾被激活、用户切到别的 tab 时置 `paused`（记录 pausedUrl）；回到会话标签或 `chrome_tabs {op:"focus"}` / `claim` 自动清除
- 11 个变更动作（goto/click/clickAt/type/press/scroll/select/hover/drag/upload/history）在 paused 时返回 `USER_SWITCHED`，不静默作用到其他页面；只读动作不受影响
- 新工具 `chrome_resume`（工具面 35→36）

## [0.1.75] - 2026-10-17

### Added（批次 D2：元素拾取）

- 新工具 `chrome_pick`（工具面 34→35）：进入拾取模式（覆盖层 + 高亮框 + Esc 取消），用户点击元素后返回 `ref/selector/text/tag/box`，ref 可直接用于 click/type
- 扩展 `tab.pick_start/pick_status/pick_cancel`；provider 轮询状态（默认 60s），超时 `PICK_TIMEOUT`、取消 `PICK_CANCELED`
- extension-logic 覆盖 pick 三个入口分发；p2 覆盖成功返回 ref 与 cancel 路径

> 说明：这两版在桌面 Chrome 断连期间落地（自动重载竞态），pick 的"真实用户点击"与 pause 的"真实切页"只做了单元验证，真机验证待扩展重连后补。

## [0.1.74] - 2026-10-17

### Added（批次 D1：站点信任 + 持久审批 + 审计）

- 扩展 `browser.site`：返回当前会话标签的 origin/url/title（provider guard 用）
- provider 侧 `~/.dsh/cache/dsh-chrome/policy.json`（人工编辑，工具不写）：origin → `allow` / `ask` / `block`
- `guard` 前置站点策略：`allow` 跳过普通 approval；`block` 返回 `SITE_BLOCKED` 且动作不到达扩展；`ask`/无策略保持 follow-dsh
- 审计 `~/.dsh/cache/dsh-chrome/audit.jsonl`（0600，append-only）：ts/session/tool/origin/action/decision/reason
- 新工具（工具面 32→34）：`chrome_policy`（只读有效策略）、`chrome_audit`（读最近审计）
- 真机：policy allow → chrome_goto/click 审计 `site-allow`；policy block → `SITE_BLOCKED` 且页面文本不变，审计 `site-blocked`；删除 policy 恢复默认
- p2 测试覆盖 allow/block/audit/policy 工具与 SITE_BLOCKED 不到达扩展

## [0.1.73] - 2026-10-17

### Added（批次 C2b：抓包 body + 脱敏）

- `loadingFinished` 时在 attach 期间主动拉 `Network.getResponseBody`（base64 解码、文本 MIME 判定、二进制 `<binary N chars>`、淘汰 `bodyUnavailable:'evicted'`）
- 请求体优先 `requestWillBeSent.request.postData`，缺失时 `Network.getRequestPostData`；响应 4 KiB / 请求 2 KiB 截断（读取时最多放大到 64 KiB）
- 脱敏：URL secret 参数、JSON 递归 key、form key、Bearer/sk-/JWT/AKIA 字符串；每条带 `redacted:true`；capture 总 body 预算 8 MiB，超了 `bodiesDropped++`
- `chrome_capture_start {storeBodies}`、`chrome_capture_requests {includeBodies, maxBodyChars}`；stop 前等待 in-flight body（≤2s）再 `Network.disable`
- 真机 api2.html：POST 请求体 token → `«redacted»`、响应体 token → `«redacted»`、302 跳转 + document/fetch 3 条；headers 未采集
- extension-logic：body 拉取、JSON 脱敏、上限/冻结、`Network.getResponseBody` 调用断言

## [0.1.72] - 2026-10-17

### Added（批次 C2a：HTTP 抓包 metadata）

- **chrome_capture_start / chrome_capture_stop / chrome_capture_requests**（工具面 29→32，始终注册）
- 扩展 `Network.enable` 事件路由到 `session.capture`：method/URL(redacted)/status/mimeType/resourceType/时长/fromCache，默认 resourceTypes=xhr/fetch/document，maxEntries 默认 300（丢最旧并计数）
- 硬确认：start 每次 `userQuestions.ask`（拒绝 `APPROVAL_DENIED`、超时 `APPROVAL_TIMEOUT`、子代理 `DELEGATED_CALLER`、无服务 fail-closed）；stop/requests 不弹卡
- 抓包 pin 住 debugger 会话：期间页面动作/截图/frame 动作不 detach；stop 后 `Network.disable` + 释放 pin + 冻结缓冲，仍可读
- onDetach / tab 关闭 / 10 分钟超时自动结束并记录 `endedReason`；SW 回收后 buffer 丢失报 `CAPTURE_LOST`
- headers 类事件完全不监听；URL secret 形状 query 参数脱敏 `«redacted»`（`?access_token=SECRET` 实测已脱敏）
- 真机（临时 `captureConfirm:"follow-dsh"` 配置）抓 api.html：document + fetch/data.json 两条，method/status/mimeType/duration 正确；恢复默认 hard 后 start → `confirmation timed out`
- extension-logic 新增：Network 事件入库/脱敏/上限丢弃/pin/stop 冻结/headers 不出现

> 配置：`~/.dsh/cache/dsh-chrome/config.json` 支持 `captureConfirm`（默认 `hard`；`follow-dsh` 仅为本地自动化验证的逃逸口，不改变默认姿态）与 `captureConfirmTimeoutMs`。

## [0.1.71] - 2026-10-17

### Added（批次 C1：chrome_evaluate，默认不注册）

- **chrome_evaluate**：CDP `Runtime.evaluate`（带 CDP timeout，可打断死循环）+ 序列化矩阵（unserializable/DOM/异常）
- **配置门**：`~/.dsh/cache/dsh-chrome/config.json` 的 `allowEvaluate:true` 才注册（默认 29 工具不变，启用后 30）；provider reload 生效
- **硬确认**：每次调用走 `ctx.userQuestions.ask`（不受 danger-full-access 影响）；拒绝 `APPROVAL_DENIED`、确认超时 `APPROVAL_TIMEOUT`、子代理 `DELEGATED_CALLER`；确认服务缺失 fail-closed
- index.js 注入 `userQuestions` 并同步读取 config；`evaluateConfirmTimeoutMs` 可配（默认 120s）
- 真机：临时启用配置 + 3s 确认超时 → 返回 `confirmation timed out`（APPROVAL_TIMEOUT）；恢复配置后工具面回到 29
- 单元测试：允许/拒绝/无服务/子代理四条路径 + extension tab.evaluate 分发

## [0.1.70] - 2026-10-17

### Changed（批次 C0：debugger 会话管理器）

- 所有 CDP 入口（页面动作、截图、frame 动作/快照/枚举、上传、emulate、pdf、a11y）统一走 `withDebugger()` 引用计数会话；全仓只剩 1 处 attach/detach
- 全局 `chrome.debugger.onEvent`：dialog 拦截 + Network 事件路由钩子（C2 填充）
- 全局 `onDetach` / `tabs.onRemoved`：清理会话、预留 capture 收尾；tab 关闭清 frameRegistry
- attach 失败不再被吞掉，明确 `DEBUGGER_FAILED`
- 顺带修掉 screenshot 元素框嵌套 attach/detach 隐患（元素框在会话内 `evalInTarget` 计算，screenshot 只 attach 一次）
- `evalInTarget()` 抽出一处 Runtime.evaluate 注入逻辑

### Tests

- extension-logic 新增 C0 回归：click/snapshot/frames/screenshot(ref) 各 attach=1 detach=1；`onDetach` 后下一次动作重新 attach；dialog 旧断言迁移后仍通过
- `npm test` 10 条全过

## [0.1.69] - 2026-10-17

### Added

- **批次 B5 iframe 元素截图**：`chrome_screenshot {frameRef:"f<frame>:<ref>"}`；用 CDP `DOM.getFrameOwner` + `DOM.getBoxModel` 逐层累加 frame 偏移，算不出返回 `FRAME_OFFSET_UNAVAILABLE` 而不是猜坐标
- 真机验证：跨源 iframe 内 Child button 截图 174x44，只有按钮本身
- 顺带修掉 screenshot 在内层 `callInPage(elementBox)` 的嵌套 attach/detach 隐患（元素框现在先算、再 attach 截图）

### Tests

- extension-logic 补 frameRef 回归：snapshot 建 registry → click frameRef 走 isolated world → 未知 frameRef 报 FRAME_STALE

## [0.1.68] - 2026-10-17

### Added

- **批次 B4 跨 frame 读取**：
  - `chrome_wait {until:"selector"|"text"}` 在所有 frame 的 isolated world 轮询，命中时结果带 `Frame: f<prefix> <url>`
  - `chrome_find` 跨 frame 聚合，iframe 命中带 `frameRef`（`f<prefix>:<ref>`）
  - `chrome_get_text {frames:"all"}` 把各 iframe 文本按 `[f<prefix>] <url>` 拼入输出
- 真机验证：iframe 页 wait #child-button 命中同源 frame；find "child" 返回 7 条（主 frame + 两个 iframe）；get_text frames:all 包含两个子 frame 文本
- extension-logic mock 补 `Page.getFrameTree` / `Page.createIsolatedWorld`

## [0.1.67] - 2026-10-17

### Added

- **批次 B2 iframe 快照聚合**：`chrome_snapshot` 默认枚举所有 frame，输出 `Frames (N)` 段；iframe 控件带 `frameRef`（`f<frameId前8位>:<本地ref>`），主 frame 输出保持兼容；`frames:"main"` 可退回旧行为
- **批次 B3 frame-qualified 动作**：`chrome_click` / `chrome_type` / `chrome_hover` 支持 `frameRef`，在目标 frame 的 isolated world 里执行
- 真机验证：跨源 iframe（127.0.0.1:8766）内输入 "cross frame"、点击按钮后 input value 变 "clicked"

## [0.1.65] - 2026-10-17

### Added

- **批次 B iframe spike**：`chrome_frames`（第 29 个工具）用 CDP `Page.getFrameTree` 枚举主 frame + iframe；`probe:true` 在每个 frame 的 isolated world 执行固定只读脚本（url/title/控件数），**同源与跨源 iframe 均验证成功**
- fixture：`iframe.html` + `iframe-child.html`（127.0.0.1:8766 模拟跨源）
- docs/tasks/BATCH-B.md：spike 结论 + B1–B6 实现步骤/验收/风险

## [0.1.64] - 2026-10-17

### Added

- **chrome_selection（批次 A4，工具面 28）**：读取选区文本 + 来源 URL/标题；无选区 `NO_SELECTION`；密码/支付/secret 字段 `SENSITIVE_SELECTION`
- fixture：`selection.html`；真机验证无选区报错 → 点击选中段落后返回原文 + URL

## [0.1.63] - 2026-10-17

### Added

- **chrome_html（批次 A3，工具面 27）**：读取当前页/selector 的 HTML；`value` 与 token/secret/csrf/password/session/cookie/api-key 形状属性一律打码；simplified 模式再剥 script/style/注释/内联事件与 style；支持截断
- fixture：`html-test.html`；真机验证整页与 #api 片段的脱敏输出

## [0.1.62] - 2026-10-17

### Added

- **chrome_click_at（批次 A2，工具面 26）**：按 CSS 像素视口坐标点击（左/右/中、双击），Canvas/地图/自绘控件可用；越界返回 `OUT_OF_VIEWPORT`；虚拟光标显示在点击点
- fixture：`canvas.html`；真机验证点击后 canvas 收到 `clicked at 96,41`，越界坐标被拒绝

## [0.1.61] - 2026-10-17

### Added

- **open Shadow DOM 支持（批次 A1）**：快照/查找/点击/输入/选择/hover/drag/elementBox/get_text/get_markdown/wait selector 走深层查询（`window.__dshDeep`，BFS 遍历 open shadow roots）；closed shadow root 明确不支持且不崩溃
- 深查询 helper 带版本号，扩展自动 reload 后页面里的旧 helper 会被替换
- fixture：`shadow.html`（open + closed custom elements）；真机验证 shadow 内输入/点击/get_text，ref 连续两次稳定

## [0.1.60] - 2026-10-17

### Fixed / Changed

- **会话标签组去重**：自动更新导致 groupId 失效时会按标题复用/合并重复组（此前每次 reload 后的新标签会各建一个 `DSH · <短id>` 组）；合并后同步 `tabIds`，`close_session` 不再留孤儿标签
- **可读组名**：provider 传 `ownerLabel`（会话 cwd 的 basename），组名从 `DSH · c4be1d` 变为 `DSH · <项目/目录名>`；旧组会被重命名合并
- `chrome_status` 增加 `groupCount` 与 `groups`（id/title/tabs），便于观察分组结构

## [Unreleased]

### Added

- **自动更新可观测性**：host 维护 `update-state.json`（diskVersion/watching/lastChangeAt/lastReloadRequestedAt/manifestMtimeMs）与 `update.log`；60s 轮询作为 fs.watch 的兜底
- `npm run watch:update`：前台观察更新状态变化
- `npm run status` 输出 updateState 与 update.log 尾部
- `chrome_status` 增加 `providerVersion`、`updateState`
- host 测试断言 update-state.json 写入

## [0.1.55] - 2026-10-17

### Added / Fixed

- `chrome_upload` / `chrome_select` 支持 `selector` 替代 ref（upload 用 CDP `DOM.querySelector`，结果 ref 可缺省）
- provider 心跳 `dsh.ping` 不再每次写 console（降低空闲日志开销）

## [0.1.54] - 2026-10-17

### Changed

- 静默 ping 日志；upload/select 增加 selector 入口（见 0.1.55）

## [0.1.53] - 2026-10-17

### Added

- popup **Show tab**：一键把本会话标签切到前台（`dsh-focus-tab`）
- `docs/AUTO-UPDATE.md`：开发期自动重载链路、ext.state 版本核对、发布形态与恢复手册

## [0.1.52] - 2026-10-17

### Added

- `chrome_storage`（第 25 个工具）：localStorage/sessionStorage 的 get/set/remove/clear；写入走审批，值 JSON 编码；真机 CfT 验证 set/get/all/clear

## [0.1.51] - 2026-10-17

### Added

- `chrome_drag`（第 23 个工具）：ref→ref 拖拽，派发 pointer/mouse + HTML5 drag 事件；真机 CfT 验证 "dropped"
- `chrome_emulate`（第 24 个工具）：CDP 视口覆盖（width/height/mobile），`reset:true` 恢复；真机验证 375x800 ↔ 756x413
- `chrome_pdf`（第 22 个工具，见 0.1.45）：`Page.printToPDF` 导出页面 PDF
- snapshot 选择器加入 `[draggable="true"]` / `[ondrop]` / `[ondragover]`，拖拽目标可被编号

### Fixed

- emulate reset：Chromium 在 `clearDeviceMetricsOverride` 后仍保留渲染器布局尺寸；改为 clear + **reload 当前标签** 再回读 `window.innerWidth`（`reloaded:true`）

## [0.1.45] - 2026-10-17

### Added

- `chrome_pdf`（第 22 个工具）：CDP `Page.printToPDF` 导出当前页 PDF，默认存 `~/.dsh/cache/dsh-chrome/pdfs/`，也可指定 `path`；真机 CfT 验证 68.2 KiB
- 测试：p2-tools 覆盖 pdf 写入；工具数 22

## [0.1.44] - 2026-10-17

### Fixed / Changed

- **会话映射迁移到 `chrome.storage.local`**：扩展自动 reload / popup Reload 后本会话标签仍被跟踪（真机验证：reload 后 `chrome_tabs list` 仍显示原标签）
- `chrome_get_text {format:"markdown"}` 跳过 script/style/svg 等节点，不再把内联脚本带进 markdown
- `chrome_a11y` 名称提取修正（不再出现 `[object Object]`）
- 动作 `snapshot:true` 的渲染提示（`[page snapshot attached]`）

## [0.1.39] - 2026-10-17

### Added

- `chrome_wait {until:"change"}`：轮询 delta 快照，DOM 控件变化即返回
- `chrome_click {button, clickCount}`：右键/中键、双击（dblclick/contextmenu 事件）
- `scripts/cpu-sample.mjs` + `npm run cpu:sample -- 120`：可复现的 CPU 采样

## [0.1.38] - 2026-10-17

### Added

- popup 显示 **Auto-update** 状态（on / reload pending / off，读 host 上报的磁盘版本）
- `chrome_status` 输出 `diskVersion` / `autoReload`（provider 侧已先行）
- 新测试 `test/tool-render.mjs`：用 schema 样本调用每个工具的 render，拦截渲染崩溃（npm test 10 条）

## [0.1.37] - 2026-10-17

### Added

- `chrome_network`：条目增加 `status`（Resource Timing `responseStatus`，Chrome 支持时）
- `chrome_console {filter}`：按日志文本子串过滤
- `chrome_find {regex:true}`：query 作为正则（大小写不敏感，非法正则返回 INVALID_REGEX）

## [0.1.36] - 2026-10-17

### Added

- `chrome_snapshot {mode:"delta"}`：只返回与上次快照相比新增/变化的控件（ref 稳定后才有意义），附 `changedCount`/`sameCount`/`removedRefs`
- 动作后可附带新快照：`chrome_click/type/press/scroll/hover {snapshot:true}` → 结果增加 `page` 字段（对齐 Playwright MCP 每次动作回快照的交互）
- 扩展逻辑测试覆盖 delta 与 post-action snapshot

## [0.1.35] - 2026-10-17

### Added

- `chrome_click` / `chrome_type` / `chrome_hover` 支持 `selector` 作为 `ref` 的替代（对齐 Playwright MCP 的 ref/selector 双入口）
- `chrome_screenshot {ref}`：按元素包围盒截图
- `chrome_tabs op=focus`：显式把会话标签切到前台（人工接管/演示）
- `chrome_status` 增加 `diskVersion` / `autoReload`（磁盘扩展版本与自动更新状态）

## [0.1.34] - 2026-10-17

### Added

- `chrome_a11y`：CDP `Accessibility.getFullAXTree` 的可访问性节点（role/name/value，限 200/可调）
- `chrome_get_text {format:"markdown"}`：页面正文转 markdown（标题/链接/列表/代码/引用）
- **自动更新补强**：host 在每次 native 连接建立时上报磁盘扩展版本（`ext.state`）；SW 发现与运行版本不一致会自动 reload（覆盖"host 断开期间文件已更新"场景）
- 测试：host-reconnect 断言 `ext.state` 版本、extension-logic 断言版本不一致触发 reload

## [0.1.33] - 2026-10-17

### Changed

- host 扩展目录 watcher：800ms 去抖 + 3s 冷却 + manifest JSON 有效性检查（避免批量写/删除时连续 reload 把新 host 打断）

## [0.1.32] - 2026-10-17

### Changed（CPU/资源占用优化）

- 移除 `page.js` 内容脚本（15s 唤醒）与 offscreen 文档（15s 唤醒）——provider 心跳已负责保活 SW，崩溃恢复由 alarms 负责
- provider 心跳 10s → 20s；watchdog alarm 30s → 60s；扩展 stale 阈值 30s → 45s
- 预期减少空闲期 Chrome/扩展唤醒次数，具体数值见 docs/CPU.md

## [0.1.31] - 2026-10-17

### Added

- `chrome_screenshot {fullPage:true}`：按文档尺寸截全页（CDP `captureBeyondViewport` + clip）
- `chrome_screenshot {highlight:true}`：先给当前 ref 控件叠编号框再截图，完成后移除覆盖层
- `chrome_wait` 新增 `until:selector` 与 `until:url`（轮询页面/URL，TIMEOUT fail-closed）
- 扩展逻辑测试补 wait selector/url、fullPage/highlight 用例

## [0.1.30] - 2026-10-17

### Added

- **稳定 ref**：`chrome_snapshot` 保留元素已有 `data-dsh-ref`，只有新元素递增编号；输出对新元素标 `new:true`（借鉴 browser-use/Playwright MCP 的稳定 handle）
- `chrome_snapshot {boxes:true}`：返回每个控件的视口坐标 `[x,y,w,h]`
- `chrome_find` 分配 ref 时同样使用稳定编号

### Changed

- `chrome_snapshot` 描述与输出 schema 同步（`new`/`box` 字段）

## [0.1.29] - 2026-10-17

### Fixed

- **自动重连根因**：`ensurePort()` 的 `connecting` promise 被外层赋值覆盖，导致一次成功后永远不再 `connectNative`；改为 deferred 模式，并加 vm 回归测试。CfT 真机：kill host 后 10s 自动恢复

### Added

- 重连诊断写入 `chrome.storage.local.dshDiag`（worker 被回收后仍可查）

## [0.1.26] - 2026-10-17

### Fixed

- `chrome_tabs op=claim` 路由缺失（真机暴露）：provider 以 `tab.tabs` 的 op 发送，扩展只认 list/new/close

## [0.1.25] - 2026-10-17

### Added

- 独立 watchdog alarm（30s）：无端口时主动重连；`connectNative` 抛错也计入自愈
- `npm run status`：本地诊断 bridge/host/扩展版本/日志尾部

## [0.1.24] - 2026-10-17

### Added

- popup 一键 **Reload**（`chrome.runtime.reload()`），断开恢复不必进 chrome://extensions
- popup 显示 Self-heal 自动重载次数

## [0.1.23] - 2026-10-17

### Added

- `chrome_hover`：按 ref 悬停（触发菜单/提示），带虚拟光标
- `test/extension-manifest.mjs`：manifest 引用/扩展 ID/host 名结构测试
- 发布清单、issue/PR 模板、用法示例、README 演示截图

## [0.1.22] - 2026-10-17

### Added

- `chrome_find`：页内文本查找，返回 ref/坐标/高亮
- `chrome_get_text`：读取页面正文或指定 selector 的可见文本
- `chrome_select`：下拉/复选/单选设置
- `chrome_console`：MAIN world document_start 捕获 console 与未捕获错误（120 条环形缓冲）
- `chrome_network`：Performance Resource Timing 资源列表（URL/类型/耗时/传输字节）
- `chrome_upload`：给 file input 挂本地文件（走审批，先校验文件存在）
- `chrome_download`：列出最近 Chrome 下载
- `chrome_tabs op=claim`：认领当前活动标签进会话标签组
- `chrome_screenshot {clip}`：区域截图
- `chrome_click/type/press {dialog}`：自动处理 alert/confirm/prompt（安全默认：alert 接受，confirm/prompt 取消）
- 虚拟光标：click/type/press/scroll 时在页面上显示 DSH 蓝色光标，900ms 淡出
- 开发期自动重载：host 监听 `extension/`，变更后扩展自动 reload（`dev.json` 控制）
- `chrome_tabs op=new` 默认后台打开（不抢焦点）
- CI、`docs/INSTALL.md`、`docs/TOOLS.md`（自动生成）、扩展打包脚本

### Changed

- 页面动作固定走 CDP `Runtime.evaluate`（后台/折叠标签组上 executeScript 与 content-script 消息会挂起）
- native port 由 service worker 持有；host 常驻并自动重连 provider
- 端口连续失败时扩展自愈 reload（上限 5 次）

### Fixed

- `chrome_tabs list` 在关闭会话后因 `groupId: null` 违反输出 schema
- `chrome_scroll` 平滑动画导致返回 y=0
- 扩展错误页的 `Unchecked runtime.lastError`

## [0.1.0] - 2026-10-17

### Added

- 12 个 `chrome_*` 工具：status/goto/snapshot/screenshot/click/type/press/scroll/history/tabs/wait/close_session
- 每 DSH 会话独立后台标签组，owner 隔离，不抢焦点
- follow-dsh 审批（先读会话 sandbox 模式，`danger-full-access` 直接放行；低权限走 `ctx.approval`）
- 工具层测试（p0-bridge / p0-tools / p1-tools）
- P1 真机验收记录

## [0.0.1] - 2026-10-17

### Added

- P0 技术验证：MV3 扩展 + native messaging host + UNIX socket bridge + provider 插件
- 4 个工具（status/goto/snapshot/screenshot），截图经 native host 物化
- P0 记录与安装资产自动写入
