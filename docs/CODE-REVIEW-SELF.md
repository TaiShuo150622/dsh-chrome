# 结构自审（2026-10-19，0.2.2）

> 范围：`index.js`、`src/*`、`extension/`、`test/`。只做结构判断，不改行为。
> 结论：功能分层已经比早期清晰（config / bridge / backend / contexts / lease / viewer / update 都是独立模块），但仍有 4 个明显的"大文件 + 隐式策略"点。

## P0：`src/headless.js` 是 3652 行的单文件

**证据**

```text
src/headless.js   3652 行
```

里面同时有：

- Chrome 启动/退出/CDP 连接（`ensureStarted`）
- tab 生命周期与 owner 归属
- snapshot / find / text / html / wait 等页面动作
- console/network 缓冲
- login visible 流程
- screencast 帧缓存
- `visualProbeAction` 视觉验证（约 L1990）
- `tab.*` 方法分发（一个巨大 switch）

**问题**

1. 每加一个页面动作都要改同一个 switch，认知负担和冲突面都最大；
2. 测试只能整体 fake CDP，难以单独测某个动作；
3. 视觉探针、登录、screencast 与普通页面动作互相耦合，改一处容易影响另一处。

**建议（分阶段，低风险先行）**

1. 先抽纯函数/纯模块：`headless/launch.js`（参数、DevToolsActivePort 解析）、`headless/console.js`（缓冲与截断）、`headless/network.js`（performance entries 映射）；
2. 再抽 `headless/actions/*.js`，每个动作一个函数，`headless.js` 只保留 dispatch/上下文；
3. 最后拆 `headless/login.js` 和 `headless/screencast.js`；`visualProbeAction` 单独成 `headless/visual-probe.js`。

**风险**：headless 是核心路径，必须用现有 `test/headless.mjs`、`test/capture-parity.mjs` 做逐阶段回归；不要一次重写。

## P0：`src/tools.js` 是 3452 行的单 closure

**证据**

```text
src/tools.js      3452 行
chrome_status     L494
chrome_lease      L1764
chrome_verify     L1855
```

`chromeTools` 一个闭包里捕获了 11 个依赖：

```text
bridge, attachments, assets, approval, sessionContext,
userQuestions, config, contexts, leases, contextViewer, update
```

**问题**

1. 每个工具都能看到全部服务，依赖边界不可见；
2. 新工具（lease/viewer/verify/update）继续往同一个文件堆；
3. 单测必须把所有依赖 fake 一遍，且容易漏；
4. 与 `backend.js` / `operation-log.js` 组合后，调用链是：
   `wrapToolsForOperationLog(wrapToolsForBackend(chromeTools(...)))`，读代码要跳 3 层。

**建议**

1. 定义 `ToolServices`（显式对象），让工具模块只声明需要的最小服务；
2. 按域拆：`tools/read.js`、`tools/write.js`、`tools/tabs.js`、`tools/capture.js`、`tools/contexts.js`、`tools/verify.js`、`tools/lease.js`；
3. `chromeTools` 只做 `list.push(...module)` 的组装；
4. 先移出最新的、依赖少且已有独立模块的 `chrome_lease` / `chrome_context` / `chrome_verify`，再动老工具。

**风险**：tool schema/render 内联，移动时要保持字面行为；用 `tool-schemas`、`p0/p1/p2`、`sandbox-smoke` 回归。

## P1：`backend.js` 同时负责路由、"backend" 参数和 write-lease 策略

**证据**

```text
src/backend.js L155  const WRITE_TOOLS = new Set([...])
src/backend.js L186  export function wrapToolsForBackend(...)
```

`wrapToolsForBackend` 现在做三件事：加 `backend` 参数、`runWithBackend` 路由、隐式 acquire/release lease。

**问题**

- 工具名硬编码在 `WRITE_TOOLS`；新增写工具很容易忘记加入，导致 lease 漏门控；
- lease 策略与 backend 路由混在一起，测试只能通过 fake router/leases 组合。

**建议**

1. 工具定义增加显式元数据：`mutating: true` / `requiresLease: true`；wrapper 读元数据，不再维护名字集合；
2. 抽出 `src/tool-guards.js`：`withWriteLease(tool, args, exec, {leases, router, run})`；
3. `wrapToolsForBackend` 只负责 backend 参数与路由，保持单一职责。

**收益**：新增工具不会漏门控；lease 逻辑可独立测试。**风险**：需要遍历所有工具加元数据，适合机械改动 + 现有测试。

## P1：`index.js` 的 4 个 `ctx.effect` 内联 wiring

**证据**

```text
index.js L150/L179/L184/L214
```

分别注册 webServer viewer、bridge/install、tools/operation log、contexts cleanup。顺序和共享变量靠闭包阅读。

**建议**

- 抽 `src/runtime.js`（或 `src/wiring.js`）：`createRuntime({ctx, home, config})` 返回 `{contexts, leases, updateChecker, viewer, dispose}`；`apply` 只调用它并注册生命周期；
- 每个 effect 一个命名函数，减少嵌套和隐式依赖。

**收益**：启动/卸载顺序可见，provider 入口更薄；**风险**：中等，需要小心 effect 清理顺序。

## P2：`context-viewer.js` 719 行，HTTP/HTML/输入/缓存混在一起

**证据**

```text
src/context-viewer.js  719 行
```

包含 token/loopback、路由分发、HTML 模板、frame 截图缓存、input 映射、错误映射。

**建议**

1. `viewer/auth.js`：token、loopback、constant-time 比较；
2. `viewer/routes.js`：URL 解析/方法校验/HTTP 错误映射；
3. `viewer/input.js`：JSON → `tab.*` 参数映射（最值得单测）；
4. `viewer/html.js`：内联页面模板；
5. `context-viewer.js` 只做注册和依赖注入。

同时把 `liveview.js` 的 token/loopback/route 解析抽成 `src/web-auth.js`，两处复用。

## P2：`update.js` 的网络/Release 解析/Windows 安装混在一起

**证据**

```text
src/update.js 210 行
```

`#installHost` 直接做 Windows 路径、下载、SHA、替换；`check` 做 GitHub API/状态文件。

**建议**

- `update/release-source.js`：fetch + 解析/筛选 release；
- `update/state.js`：读写 update.json；
- `update/host-installer.js`：Windows host 下载/校验/原子替换；
- `UpdateChecker` 变成编排器。测试可分别注入。

## P3：其他

- `src/sidecar.js` 398 行是未接入的 spike，容易误读；要么标记 `experimental/` 并排除发布，要么删掉。
- `src/operation-log.js` 919 行：redaction/日志/包装可拆。
- 大量测试文件 >1000 行（`capture-parity`、`headless`、`sandbox-smoke`）；建议拆 fixture/场景，不减覆盖。
- 新增工具时 `WRITE_TOOLS` 是隐式契约，是当前最值得先修的"小设计债"。

## 建议顺序（收益/风险）

1. **WRITE_TOOLS 元数据化 + `tool-guards.js`**（小、低风险、立即减少漏门控）；
2. **拆出 tools 的新域模块**（先 lease/context/verify，纯移动）；
3. **`index.js` runtime 化**（启动/卸载顺序可见）；
4. **`headless.js` 分阶段抽纯模块**（launch/console/network → actions）；
5. **viewer/update 内部拆文件**（纯结构，测试已覆盖）。

> 注：不为了"看起来优雅"重写核心 headless；优先做能降低新增功能出错概率的拆分。
