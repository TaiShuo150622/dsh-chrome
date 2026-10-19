# CAPTURE-PARITY — capture 双后端一致性

> 测试：`node test/capture-parity.mjs`（自包含，不联网，约 3.5s）
> 分支：`feat/capture-parity` · 基线 commit `25670ca` · 对应 `docs/HEADLESS.md` §5 待办 2/3
> 验证环境：Node v24.6.0 · 系统 Chrome 155.0.8059.80 · macOS

## 0. 结论摘要

**共享语义已经对得上，API 形状与边界行为还有 17 条差异记录（合并真链路证据后 16 项独立差异）：15 项建议 Lead 修，1 项（#10 大小写）建议扩展侧对齐 headless。**

- **77 项严格一致性断言全绿。** 事件生命周期（`requestWillBeSent` / `responseReceived` /
  `loadingFinished` / `loadingFailed` / `requestServedFromCache`）、URL 脱敏（userinfo + secret query）、
  JSON/form body 脱敏、抓取期 body 截断、body 总预算、停止后冻结、owner 隔离、`NO_ACTIVE_CAPTURE`
  在两套实现上逐字节/逐字段一致。
- **17 项已记录差异**（见 §3），测试以 `DIFF` 行输出、不判失败；差异项写成「旧行为或修复后行为都接受」，
  所以 Lead 修 headless 时不用同步改测试，只要跑一遍把 §3 的表更新成实际观测即可。
- 最值得先修的三项：**`resourceTypes` 过滤在 headless 完全不生效**（image/other 也进缓冲）、
  **`maxEntries` 溢出时淘汰方向相反**（丢掉新请求）、**`capture_requests` 的 `limit` 取最早而不是最新**
  ——这三项直接决定模型看到的是哪一段流量，与扩展侧不一致时同一个 agent 在不同 backend 上结论会不同。

## 1. 测试怎么跑、测什么

```bash
cd /Users/taishuo/projects/dsh-chrome-wt/capture   # 或主检出
node test/capture-parity.mjs
# 预期最后两行：
# CAPTURE PARITY: 77 checks, 0 failure(s), 17 documented divergence(s)
# CAPTURE PARITY TEST: PASS
```

一个进程里依次跑三段：

| 段 | 机制 | 证明什么 |
|---|---|---|
| extension（vm） | 用 mock `chrome.*` 在 `node:vm` 里加载 `extension/background.js`（同 `test/extension-logic.mjs` 的 harness 思路），CDP 事件经 `chrome.debugger.onEvent` 监听器注入 | 扩展侧**真实代码路径**（生命周期、脱敏、淘汰、冻结、错误码）；不需要真 Chrome |
| headless（合成） | 真 `HeadlessDriver`（`src/headless.js`），把**同一批 CDP 事件**直接喂给 `HeadlessDriver.onNetworkEvent`；`Network.getResponseBody` 由测试桩返回固定 body | 两后端在同一事件序列上逐字段对比（这是主要的 parity 证据） |
| headless（真链路） | 真 headless Chrome + 临时 HTTP server：页面发起 document/fetch/JSON POST/form POST/超大响应/断开连接/image 请求 | 真实 CDP 管线（含 `Network.getResponseBody`）下脱敏、截断、失败记录、冻结仍成立 |

临时 Chrome profile 用 `mkdtemp`，结束即删；不占用桌面 Chrome、不依赖端口号。

## 2. 已对齐（严格断言，全绿）

| 语义 | 断言要点 |
|---|---|
| 生命周期 | 5 种 Network 事件都进缓冲；`method/url/resourceType` 小写归一；`status`、`mimeType` 一致；`loadingFinished` 的 `durationMs` 都按单调时间差计算（同输入同为 250ms） |
| 失败 | `loadingFailed` 都置 `failed=true` + `errorText`（同输入同值） |
| 缓存 | `response.fromDiskCache`、`Network.requestServedFromCache` 都置 `fromCache=true` |
| URL 脱敏 | secret 形 query（token/api_key/access_token…）→ `«redacted»`；userinfo → `https://«redacted»:«redacted»@…`；原始 secret 不出现在缓冲；普通参数（`q=1`）保留 |
| body 脱敏 | JSON 按 key 命中 secret pattern 递归替换；form-urlencoded 的 secret 字段 → `name="«redacted»"`；请求体/响应体两侧**逐字节相同** |
| 抓取期截断 | 单 body 超 4096 字符 → 前 4096 + `… <truncated>`，`bodyTruncated=true`，两侧逐字节相同（测试用 `maxBodyChars=65536` 读回原始 body，避开读时截断） |
| body 总预算 | 8 MiB 预算用尽 → `<body not captured: capture body budget exceeded>`，`bodiesDropped+1`，两侧一致 |
| 停止冻结 | `capture_stop` 后 buffer 仍可读、`active=false`、新事件不进入；不带 `captureId` 读取回退到最近一次 capture；`endedReason=stopped` |
| owner 隔离 | 拿别人的 `captureId` 读/停 → `CAPTURE_NOT_FOUND`（两侧一致） |
| 无 capture | 没有 capture 的 owner 读取 → `NO_ACTIVE_CAPTURE`（两侧一致） |
| `includeBodies:false` | 两侧都剥离 `requestBody`/`responseBody` |
| 禁止 header | 两侧 buffer 都不含 cookie/authorization 形字段 |
| 真链路（headless） | document body、JSON 响应脱敏、JSON/form POST 请求体脱敏、超大 body 截断、`net::ERR_EMPTY_RESPONSE` 失败记录、stop 后导航不再入缓冲 |

## 3. 差异表（17 项，全部由测试输出）

`类型`：**待修** = 建议 Lead 在 `src/headless.js` 对齐扩展语义；**记录** = 可接受或需产品拍板的差异。
（测试 `DIFF` 行 #17 是 #11 的真链路证据，文档合并为一行。）

| # | 项目 | 扩展侧（source of truth） | headless 侧现状 | 影响 | 类型 |
|---|------|---------------------------|-----------------|------|------|
| 1 | `capture_start` 响应字段 | `captureId, tabId, startedAt, resourceTypes, maxEntries, storeBodies, active` | 缺 `startedAt`、`resourceTypes` | 调用方拿不到开始时间/生效的过滤类型 | 待修 |
| 2 | `capture_start` 重复调用（`alreadyActive`）响应 | `captureId, tabId, startedAt, requests, alreadyActive`（无 `active`） | `captureId, tabId, active, alreadyActive`；缺 `startedAt`、`requests` | 提示"已有一个抓包在跑"时给不出进度 | 待修 |
| 3 | entry 字段集合 | 额外有 `startTime`(wall ms)、`timestamp`、`startMono`、`documentURL`、`wallTime`、`statusText`、`fromServiceWorker`、`encodedDataLength`、`responseAt`、`finishedAt`、`canceled`（另有内部字段 `bodyScheduled` 泄漏到输出，建议一并清掉） | 用 `startTimestamp` 命名；上列字段全缺；`fromCache` 只在为真时出现 | 模型回答"请求何时发生/缓存否/状态文本"时信息更少 | 待修（字段名统一为 `timestamp`） |
| 4 | `capture_stop` 响应字段 | 额外有 `tabId`、`startedAt`、`endedAt`、`bodiesDropped` | 缺这 4 个 | 下游无法据此算 wall-clock 时长/丢 body 数 | 待修 |
| 5 | `documentURL` | 记录并脱敏发起页面 URL | 不记录 | 跨页面抓包时分不清请求来自哪个文档 | 待修 |
| 6 | `capture_requests` 的 `maxBodyChars` 截断 | 超限时追加 `… <truncated>` 并置 `copy.bodyTruncated=true` | 直接 `slice(0,maxBodyChars)`，无标记、无 `bodyTruncated` | 模型无法判断 body 是否被读侧截断 | 待修 |
| 7 | `maxEntries` 溢出淘汰方向 | 丢**最旧**，保留最新（`m2,m3`） | 丢**最新**，保留最早（`m1,m2`） | 小上限下页面加载后段请求全丢，与扩展结论相反 | 待修（P1） |
| 8 | `capture_requests` `limit` 取哪一端 | `entries.slice(-limit)`：最新 N 条 | `entries.slice(0, limit)`：最早 N 条 | 同一 `limit` 两个 backend 给不同时间段 | 待修（P1） |
| 9 | `total` / `truncated` 与 `filter` 的关系 | 按**过滤后**计数（total=1、truncated=false） | 按**全部** entry 计数（total=3、truncated=true） | 带 filter/type 过滤时元信息对不上 | 待修 |
| 10 | `capture_requests` `resourceTypes` 过滤大小写 | 区分大小写（传 `['Fetch']` 匹配 0 条） | 统一小写（`['Fetch']` 匹配全部） | 同一调用参数两个 backend 结果不同；**headless 语义更合理**，建议扩展侧改小写归一 | 记录（建议对齐 headless） |
| 11 | **抓取阶段 `resourceTypes` 过滤** | 默认只抓 `xhr/fetch/document`，参数可改；image/other 不入缓冲 | 存了 `resourceTypes` 选项但**从不应用**，image/other 全进缓冲 | headless 缓冲内容和扩展默认配置不一致，与 #12 同根；真链路已抓到 `image` | 待修（P1） |
| 12 | 自定义 `resourceTypes` | `['image']` 时只保留 image | 忽略参数，fetch+image 都保留 | 用户按类型过滤的预期落空 | 待修（P1） |
| 13 | 缓存来源映射 | `fromDiskCache`/`fromPrefetchCache`/`requestServedFromCache`→`fromCache`；`fromServiceWorker` 单独字段 | `fromDiskCache`/`fromMemoryCache`/`fromServiceWorker`/`requestServedFromCache`→`fromCache`；不认 prefetch | 同一响应"是否来自缓存"结论可能相反；`fromServiceWorker` 信息被折叠 | 待修 |
| 14 | 请求体兜底 | 事件无 `postData` 时调 `Network.getRequestPostData` 再脱敏 | 只读 `requestWillBeSent.request.postData`，没有就静默丢 | 真实 Chrome 对部分 POST 省略 postData 时 headless 丢请求体 | 待修（P1） |
| 15 | `capture_start` 的 `storeBodies` | `storeBodies:false` 生效，不抓 body | 忽略参数，始终抓 body | 明确要求不抓 body 时仍抓（效率/隐私预期落空） | 待修 |
| 16 | `captureId` 不存在 | `CAPTURE_LOST`（worker 重启缓冲丢失） | `CAPTURE_NOT_FOUND`（与 owner 不匹配同码） | 调用方无法区分"重启丢失"与"不是我的/不存在" | 待修 |
| 17 | （真链路证据）默认类型下的 image/other | 默认过滤，见 #11 | 真 Chrome 页面里 image 请求被捕获 | 同 #11 | 待修 |

> `fromServiceWorker` 在扩展侧是"单独字段且不置 `fromCache`"，headless 反过来；本条已在测试里
> 用 `c2/c3/c5` 三个合成响应分别锁定。

## 4. headless 待修清单（给 Lead 的落地建议）

按"对 agent 结论的影响"排序；行号基于本分支 HEAD（`25670ca`），以函数名为准。

| 优先级 | 项 | 位置（`src/headless.js`） | 建议 |
|---|---|---|---|
| P1 | #11/#12 `resourceTypes` 不生效 | `onNetworkEvent()` 664-747 | 在 `requestWillBeSent` 分支加 `if (!capture.resourceTypes.includes(type))`；`capture_start` 响应回显 `resourceTypes`（同时消掉 #1 的一半） |
| P1 | #7 `maxEntries` 淘汰方向 | `onNetworkEvent()` 669-685 | 改成与扩展一致：满了先 `shift()` 最旧、`dropped += 1`，再插新 entry（注意 `byId` 同步删除） |
| P1 | #8/#9 `limit`/`total`/`truncated` | `tab.capture_requests` 1292-1329 | `entries.slice(-limit)`；`total = entries.length`（过滤后）、`truncated = entries.length > limit` |
| P1 | #14 请求体兜底 | `onNetworkEvent()` 707-746 | `loadingFinished` 时若 `_postDataRaw == null && hasPostData`，调 `Network.getRequestPostData` 再走 `materializeCaptureBody`（和扩展同顺序） |
| P1 | #15 `storeBodies` 被忽略 | `tab.capture_start` 1237-1269 | `storeBodies: params.storeBodies !== false`，回显真实值；`onNetworkEvent` 里已检查 `capture.storeBodies` |
| P2 | #1/#2/#4 响应字段 | `tab.capture_start` / `tab.capture_stop` | start 回显 `startedAt`(ISO)、`resourceTypes`；stop 补 `tabId/startedAt/endedAt/bodiesDropped`；alreadyActive 补 `startedAt/requests` |
| P2 | #3 entry 字段 | `onNetworkEvent()` 674-681 等 | 统一用 `timestamp`（去掉 `startTimestamp`），补 `statusText/documentURL/wallTime/finishedAt/responseAt/encodedDataLength/canceled/fromServiceWorker`；`startTime` 可用 `Date.now()` |
| P2 | #5 `documentURL` | 同上 | `entry.documentURL = redactUrl(params.documentURL)` |
| P2 | #6 读侧截断标记 | `tab.capture_requests` 1306-1317 | 超 `maxBodyChars` 时同扩展追加 `… <truncated>` 并置 `bodyTruncated` |
| P2 | #13 缓存映射 | `responseReceived` / `requestServedFromCache` 689-700 | 与扩展对齐：`fromDiskCache`/`fromPrefetchCache`/`requestServedFromCache`→`fromCache`；`fromServiceWorker` 单独字段 |
| P2 | #16 错误码 | `findCapture()` 923-936 | `captureId` 在 map 里查不到 → `CAPTURE_LOST`；查到但 owner 不符 → `CAPTURE_NOT_FOUND`（与扩展同） |
| P3 | #10 大小写归一 | `tab.capture_requests` 1300-1303 | 已小写归一（headless 更合理）；建议改**扩展侧**而不是 headless |

> 另有两处**代码审读差异**，测试未直接断言（时序不好稳定构造），修 §4 时可一并核对：
> - `capture_stop`：扩展会等 in-flight body 任务最多 2s 再 `Network.disable`；headless 立即 disable，可能丢最后几个 body。
> - `maxEntries` 非整数：扩展 `Math.trunc`，headless 不截断（`entries.length >= 2.5` 的行为是"到 3 才丢"）。

## 5. 覆盖边界 / 未覆盖

| 未覆盖项 | 原因 |
|---|---|
| 扩展侧真 Chrome（真扩展 + 真 debugger） | 测试环境不装用户扩展；扩展侧用 vm 加载真实 `background.js`，事件按 CDP 事件形状构造后注入 `debugger.onEvent`；真 CDP 管线由 headless 真链路覆盖 |
| 10 分钟自动停 / 超时 `endedReason=max-duration` | 测试不想真等 10 分钟；常量两侧相同（代码审读） |
| worker 重启后 `CAPTURE_LOST` | 只有扩展有 worker 概念；测试用"未知 captureId"间接覆盖错误码路径 |
| base64 response body | 两侧解码逻辑不同（`atob` vs `Buffer.from`），未单独构造；建议后续补一条 |
| 并发 body 抓取上限（`CAPTURE_BODY_MAX_INFLIGHT=4` / `burst`） | 需要稳定制造并发 burst；两侧逻辑相同（代码审读） |
| headless body budget 真链路 | 8 MiB 全量传输太慢；用 `capture.bodyBytes` 预置到上限来覆盖同一分支（测试内已注明） |

## 6. 维护说明

- **严格断言（77 checks）**：破坏任何一条 = 共享语义回归，退出码 1。
- **`DIFF` 行（17 项）**：informational，不判失败；方向性断言写成「旧行为或修复后行为都接受」，
  因此 Lead 修 headless 后测试仍应全绿，`DIFF` 表会显示修好后的实际值。
- 修完一项后：跑 `node test/capture-parity.mjs`，把 §3/§4 对应行删掉或改成实际状态；如果某项从
  "双向不一致"变成一致，`DIFF` 行会消失（测试输出里能直接看到）。
- 测试不并入 `npm test`（本任务只允许改 `test/capture-parity.mjs` + 本文；是否入 CI 由 Lead 决定）。
- 相关实现：`extension/background.js` `captureStart/captureStop/captureRequests/routeNetworkEvent`
  （约 1080-1495 行）；`src/headless.js` `onNetworkEvent/findCapture/capture_start/capture_stop/capture_requests`
  （约 142-747、923-936、1225-1329 行）。

## 5. 修复记录（2026-10-17）

以下差异已在 headless 侧按扩展语义修复（`src/headless.js`）：

- 抓取阶段 `resourceTypes` 过滤生效（默认 xhr/fetch/document，自定义生效）；
- `maxEntries` 溢出改为**丢最旧、保留最新**；
- `capture_requests` 的 `limit` 取最新 N 条，`total/truncated` 按过滤后计数；
- 读侧 `maxBodyChars` 截断追加 `… <truncated>` 并置 `bodyTruncated`；
- 请求体缺 `postData` 时用 `Network.getRequestPostData` 兜底；
- `storeBodies:false` 生效；
- `capture_start`/`capture_stop`/entry 补齐 `startedAt/resourceTypes/timestamp/documentURL/statusText/fromServiceWorker/encodedDataLength/responseAt/finishedAt/canceled` 等字段；
- 缓存映射修正（fromPrefetchCache 计入 fromCache，fromServiceWorker 单独字段）；
- `captureId` 不存在 → `CAPTURE_LOST`；owner 不匹配 → `CAPTURE_NOT_FOUND`。

`test/capture-parity.mjs` 保持「旧行为或修复后行为都接受」的差异断言，严格断言 77 项仍全绿；本文件 §3 的待修清单作为历史差异记录保留。

## 7. H1 桌面侧脱敏对齐（2026-10-19）

- `extension/background.js` 采用与 `src/headless-redact.js` 相同的 `CAPTURE_SECRET_PARAM`/`CAPTURE_INLINE_SECRET` 规则：`pwd`/`otp`/`cvv`/`auth` 整段键名、URL fragment（`#access_token=…`、`#password=…`）、free text / JSON 字符串里的 inline `key=value`。
- `test/capture-redact.mjs` 用哨兵值断言桌面路径的 URL/body/headers 不泄漏，并已接入 `npm test`。
- `chrome_capture_start` 工具默认 `storeBodies:false`（只记 metadata）；确认卡写明目标 tab 与 origin，body 需要显式 `storeBodies:true`。

