# 多浏览器 / 多沙盒实例：现状、设计与分阶段计划

> 2026-10-19 · 基线：provider/扩展 **0.2.13**，仓库提交 `a126271` · 本文主体是只读调查与设计稿；文末「headless 多引擎候选 MVP」附录记录后续已落地的解析/选择 MVP（主体行为判断仍以 `a126271` 为基线）。
> 调查期间仓库有并行会话的未提交改动（`src/headless.js` 的截图/screencast 拆分）；本文行为判断以 `a126271` 为基线，行号可能随重构漂移，以文件/符号名为准。
>
> **一句话结论**：同引擎的“每个 DSH agent 一个 headless context”已经真实落地，但仍只到**串行可用**；并发创建、崩溃恢复、登录接管、资源预算还没做完。多引擎目前有 **安装路径表 + headless 可执行文件候选解析（MVP）**，但没有运行时按 context 调度；桌面扩展后端还被**单 socket bridge** 挡着。Safari 不是 Chromium，不能复用现有 CDP/扩展链路，应单独立项 spike。

本文把三件容易混在一起的事分开讨论：

| 说法 | 实际含义 | 当前状态 |
|---|---|---|
| 多实例（同引擎） | 一个 provider 内多个 context，各自独立 Chrome 进程/profile | 已落地基础；并发/生命周期有缺口 |
| 多引擎 | Chrome / Edge / Brave / Chromium 可被选择、可同时存在 | 安装路径表 + headless 候选解析（MVP）；运行时调度与桌面多引擎未做 |
| Safari | Safari Web Extension，独立产品线 | 只有可行性文档，无实现 |

---

## 0. 先对齐名词

| 名词 | 含义 | 代码位置 |
|---|---|---|
| **engine** | 浏览器引擎/品牌：`chrome` / `edge` / `brave` / `chromium`（Safari 另算） | `src/platform.js` 的 `BROWSER_IDS`、`BROWSERS` |
| **backend** | 控制通道：`desktop`（MV3 扩展 + native messaging）或 `headless`（本地 CDP） | `src/backend.js` 的 `BACKENDS`、`BackendRouter` |
| **context** | 一个浏览器实例 + 一个 profile + 一个 owner 的隔离单元 | `src/contexts.js` 的 `BrowserContextManager` |
| **preset** | context 的隔离/可见性预设：`sandbox` / `sandbox-persistent` / `debug` / `collab` | `src/config.js` 的 `PRESETS`、`presetToMode()` |
| **owner** | context 的归属者；工具层取 `exec.agent.id`，缺省为 `default` | `src/tools.js` 的 `ownerOf()` |
| **session / agent** | DSH 会话或子代理；一个 DSH 会话里可以有多个 agent，因此可能有多个 context | DSH 运行时 |

**边界先说清**：

- context 不是 VM/容器，也不是 OS 级安全沙箱。所有 context 以同一个 OS 用户运行；隔离来自独立的 `--user-data-dir`、独立 Chrome 进程和 provider 侧的 owner 检查。
- “per-session”在代码里实际是 **per-agent-id**。子代理有独立 agent id，会各自拿到 context；默认上限是全局的，不是每会话的。
- “多实例”在本文指**同一个 provider 进程内**的多个 context。多个 DSH/provider 进程同时跑同一个 `DSH_HOME` 目前没有协调机制（见 §4.5）。

---

## 1. 同引擎多实例：当前实现到哪一步

### 1.1 调用链

```text
chrome_* { backend: "headless" }
  → wrapToolsForBackend()                      src/backend.js
  → BackendRouter.call()（AsyncLocalStorage 带 backend）  src/backend.js
  → HeadlessContextRouter.request(method, params)        src/headless-contexts.js
  → BrowserContextManager.activeFor(owner) / create()    src/contexts.js
  → HeadlessDriver.request(method, params)               src/headless.js
  → 独立 Chrome 进程（--headless=new 或可见窗口） + CDP
```

另外三条独立入口：

```text
chrome_context {op:create|list|current|use|close|viewer}
  → createContextTool()                        src/tools-context.js
  → BrowserContextManager                      src/contexts.js
  → contextViewer.urlFor(contextId)            src/context-viewer.js

chrome_verify {steps...}
  → createVerifyTool()                         src/tools-verify.js
  → BrowserContextManager + ArtifactStore      src/contexts.js + src/artifact-store.js

chrome_headless_login {op:start|show|status|finish}
  → createLoginTool()                          src/tools-login.js
  → bridge.headless.loginStart/showVisible...  ← 当前接线有缺口，见 §1.10
```

`BackendRouter` 用 `AsyncLocalStorage` 保存 backend 选择，异步工具执行期间不会串；`chrome_verify` 被列为 `HEADLESS_ONLY_TOOLS`，不会加 `backend` 参数（`src/backend.js:34`）。

### 1.2 `BrowserContextManager` 的模型

`src/contexts.js:26` 起，核心状态：

| 字段/方法 | 作用 |
|---|---|
| `contexts: Map<contextId, ctx>` | 所有 context |
| `activeByOwner: Map<owner, contextId>` | 每个 owner 当前 active 的 context |
| `create({owner, preset, profileName, cwd})` | 校验上限/preset/profile 名；建 profile 目录；`await createDriver()`；登记 |
| `close(contextId, {keepProfile})` | 先从 map 删除，再 `driver.close()`；ephemeral profile 删除；named profile 保留 |
| `closeOwned(contextId, owner)` | owner 不匹配返回 `false`，不泄露 context 是否存在 |
| `getOwned/listFor/driverForOwned/setActive` | owner-aware 读/切换 |
| `reapIdle()` | 关闭超过 `idleTimeoutMs` 且非 visible 的 context |
| `stats()` | `{active, max, sessions}`；**不按 owner 过滤** |

创建语义（`src/contexts.js:65`）：

1. `contexts.size >= maxContexts` → `CONTEXT_LIMIT`；
2. `presetToMode(preset || config.browser.preset)`；`collab` 直接 `UNSUPPORTED_MODE`；
3. named preset 生成/清洗 `profileId`；同名 profile 已在 map 中 → `PROFILE_IN_USE`；
4. 先 `mkdirSync(profileDir, 0700)`，再 `await createDriver(...)`；
5. 登记 context，并把该 owner 的 active 指向它。

每个 context 的 driver 由 `index.js:65-78` 的 `createDriver` 创建：

```js
createDriver: async ({ profileDir, visible }) =>
  new HeadlessDriver({
    home, logger, profileDir,
    screenshotDir: path.join(profileDir, 'screenshots'),
    downloadDir: path.join(profileDir, 'downloads'),
    visible: visible === true,
  })
```

因此每个 context 有独立的 `profileDir`、`screenshots`、`downloads`；但 `screencast` 目录不是 per-context（见 §1.10）。

### 1.3 预设：哪些是真的

| preset | isolation | visible | 当前行为 | 状态 |
|---|---|---|---|---|
| `sandbox` | ephemeral | 否 | 独立临时 profile；关闭/空闲回收时删除 | ✅ 已落地 |
| `sandbox-persistent` | named | 否 | 命名 profile；关闭后保留，可再次用同名 profile | ✅ 已落地 |
| `debug` | named | 是 | 独立 profile + 可见 Chrome 窗口；context manager 不回收它，但 driver 自身的 idle timer 仍可能关窗口（见 C17） | ✅ 代码路径已落地；真机窗口未自动化验证 |
| `collab` | shared | 是 | `create()` 返回 `UNSUPPORTED_MODE` | ❌ 未实现 |

`presetToMode()` 在 `src/config.js:150`。注意 `chrome_context` 的 schema 仍列出 `collab`（`src/tools-context.js:19`），但创建时会被 manager 拒绝；不要让模型以为它能用。

**一个容易误读的点**：`chrome_context {op:"create"}` 省略 `preset` 时，用的是 `config.browser.preset`，不是硬编码 `sandbox`（`src/contexts.js:67`）。如果用户把 `~/.dsh/config.json` 的 `browser.preset` 设为 `debug`，那么 `backend:"headless"` 的懒创建也会得到**可见窗口**，且该 context 不会被空闲回收。文档 `docs/CONTEXTS.md` 里“默认 sandbox”的说法只在默认配置下成立。

### 1.4 `HeadlessContextRouter`

`src/headless-contexts.js:6`：

```js
async request(method, params = {}) {
  const owner = params?.owner || 'default'
  let ctx = this.manager.activeFor(owner)
  if (!ctx) ctx = await this.manager.create({ owner })
  this.manager.touch(ctx.contextId)
  const driver = this.manager.driverFor(ctx.contextId)
  const result = await driver.request(method, params)
  ...
}
```

关键事实：

- 按 `owner` 找 active context；没有就**懒创建**，用配置默认 preset；
- 同一 owner 的后续请求复用 active context；
- `connected` 的定义是 `manager.stats().active > 0`，**不是**“已有浏览器进程/CDP 连接”；
- `close()` 关闭全部 context；
- 没有 `loginStart`、`showVisible`、`loginProfile` 等登录窗口接口（见 §1.10）。

### 1.5 `HeadlessDriver` 与每个 context 的 Chrome

`src/headless.js` 的 `HeadlessDriver`。每个 context 一个 driver，首次请求时 `ensureStarted()`：

- 非 visible：`--headless=new --no-startup-window --remote-debugging-port=0 --user-data-dir=<profileDir>`；
- visible：`--new-window`，不加 `--headless=new`，带 `about:blank`；
- 启动参数集中在 `buildLaunchArgs()`（`src/headless-launch.js:20`），用 `DevToolsActivePort` 握手；
- 每个 driver 有独立 tabs/owners/console/capture 状态；`MAX_TABS` 默认 12（`DSH_HEADLESS_MAX_TABS` 可调），超出 `RESOURCE_LIMIT`；
- 浏览器进程退出时只把 `this.cdp = null; this.chrome = null`（`ensureStarted()` 的 `child.on('exit')` 处理器），**不清 tabs/owners/bySession**；
- 下一次请求会 `ensureStarted()`，可能重新拉起进程；但已有 tab 的 `sessionId` 是旧的，后续 `ensureTab()` 会拿到 stale tab，CDP 调用失败。

visible 模式：`presetToMode('debug').visible === true`，`index.js` 把 `visible:true` 传给 driver；`BrowserContextManager.reapIdle()` 对 `ctx.visible` 直接 `continue`，所以 **context manager 层**不会回收它。但 `HeadlessDriver` 自己另有一个 idle timer：`tabs.size === 0` 时按 `DSH_HEADLESS_IDLE_MINUTES`（默认 5 分钟）关闭浏览器。**这个 timer 没有判断 `visible`**；而可见窗口的初始 `about:blank` 不是通过 `Target.createTarget` 建的，不计入 `driver.tabs`。因此一个没有任何工具 tab 的 `debug` context，在窗口打开约 5 分钟后会被 driver 自己关掉——这与“visible 只由用户显式 close”的文档描述不一致（C17）。另外 `chrome_context {op:"create", preset:"debug"}` 本身只是构造 driver，**不 spawn Chrome**；窗口要等第一次 `backend:"headless"` 请求才出现。

### 1.6 工具面：现在能做什么

`chrome_context`（`src/tools-context.js`）：

| op | 行为 | owner 检查 |
|---|---|---|
| `create` | 为当前 owner 建 context；可传 `preset`、`profile` | 使用当前 owner |
| `list` | 列出当前 owner 的 context | `listFor(owner)` |
| `current` | 当前 active context | `activeFor(owner)` |
| `use` | 切换当前 owner 的 active context | `setActive(owner, id)` |
| `close` | 关闭指定 context | `closeOwned(id, owner)` |
| `viewer` | 返回当前 active context 的 viewer URL | 使用当前 active |

`chrome_context` 标记 `mutating:false, stateful:true`，不参与写业务 lease 门控（`src/tools-context.js:8-12`）。

`chrome_verify`（`src/tools-verify.js`）：

- 有 `contextId`：`contexts.getOwned(contextId, owner)`，不是自己的返回 `CONTEXT_NOT_FOUND`；
- 无 `contextId`：使用 `activeFor(owner)`；没有 active 时**硬编码** `create({owner, preset:'sandbox'})`；
- 产物写到全局 `ArtifactStore`（`~/.dsh/cache/dsh-chrome/artifacts/verify-<runId>/`），context 关闭后仍保留；
- 默认保留最近 50 次（`verification.artifactRetentionRuns`），每次运行后 `pruneArtifacts()`。

`chrome_context {op:"viewer"}`（`src/context-viewer.js`）：

- 返回当前 active context 的 loopback URL；依赖 Host `webServer`，不可用时工具返回 `VIEWER_UNAVAILABLE`；
- 路由：`/dsh-chrome/context/:id/view|frame|input`；
- 全局 `context-viewer-token`（0600）+ 每个 context 的随机 `access` capability；
- 只接受 loopback；CSP 限制为内联资源；无 CDP 暴露；
- 输入只支持 click / type / key / scroll / navigate / history；
- frame 是截图轮询（约 330ms / 3fps），不是实时视频；
- 使用 context 的 owner 去操作同一个 driver（`callDriver()` 注入 `owner`），因此 viewer 看到/操作的是该 context 的 active tab；
- **没有**按 DSH 会话复核 owner：拿到 URL 的人就能操作该 context（URL 本身是 bearer capability）。

### 1.7 配置：哪些字段真的生效

配置文件优先级（`src/config.js:131`）：旧 `~/.dsh/cache/dsh-chrome/config.json` → `~/.dsh/config.json` → `<cwd>/.dsh-chrome/config.json`（后者覆盖前者）。provider 启动时加载一次；改配置需要重载 provider，只影响新 context。

| 配置 | 默认 | 是否生效 | 说明 |
|---|---|---|---|
| `browser.preset` | `sandbox` | ✅ | 懒创建/省略 preset 时使用 |
| `browser.maxContexts` | 4（clamp 1–16） | ✅ | 全局上限，非每 owner |
| `browser.idleTimeoutMs` | 300000（clamp 10s–1h） | ✅ | 非 visible context 的回收阈值 |
| `browser.profilesDir` | `$DSH_HOME/cache/dsh-chrome/profiles` | ✅ | 所有 context profile 的根 |
| `browser.headless.chromeExecutable` | null | ✅ | 传给每个 `HeadlessDriver`；`DSH_HEADLESS_CHROME` 覆盖它（`src/headless-browsers.js` 解析，`test/headless-browsers.mjs` 覆盖） |
| `browser.engine` | null | ✅ | `chrome/chromium/edge/brave`；`DSH_HEADLESS_ENGINE` 覆盖它；显式 engine 不存在时报 `HEADLESS_EXECUTABLE_NOT_FOUND`，不回退 |
| `browser.headless.viewport` | 1440×900 | ❌ | `index.js` 没有把 viewport 传给 driver；实际用 `HeadlessDriver` 默认值 |
| `browser.shared.enabled` | false | ⚠️ | 只控制写工具是否走隐式 lease 门控；不启用 `collab` |
| `verification.artifactDir` | `$DSH_HOME/cache/dsh-chrome/artifacts` | ✅ | `ArtifactStore` 根 |
| `verification.artifactRetentionRuns` | 50 | ✅ | verify 运行目录保留数 |
| `verification.maxArtifactBytes` | 50MB | ❌ | 声明并校验，但代码中没有执行体积裁剪 |
| `externalAgents.claude/codex.preset` | `debug` | ❌ | 只被加载/校验，未被任何运行时读取 |

### 1.8 隔离与 owner 边界（当前真实语义）

- **profile 隔离**：独立 `--user-data-dir`，不导入用户日常 Chrome cookie；登录态只能通过一次性登录窗口写入（登录工具当前接线有问题）。
- **owner 隔离**：context 的 `getOwned/listFor/closeOwned/driverForOwned/setActive` 都做 owner 检查；跨 owner 的 `contextId` 返回 `null`/`false`/`CONTEXT_NOT_FOUND`，不泄露存在性。
- **tab 隔离**：每个 driver 自己的 `owners`/`tabs` map；`ensureTab(owner, tabId)` 只查该 owner 的 tab；跨 owner tabId 返回 `TAB_NOT_FOUND`。
- **viewer**：不走 owner 检查，走 per-context `access` capability；这是有意的“URL 即权限”，不是 owner 绕过。
- **磁盘**：profiles 目录 `0700`；viewer token 文件 `0600`；但 profile 名称清洗允许 `.`/`..`（见 §1.10），且没有磁盘配额。

### 1.9 本次跑过的测试

以下命令在本次调查中通过（未跑全量 38 个测试）：

```bash
node test/browser-contexts.mjs        # 配置/管理器/空闲/owner/preset
node test/headless-contexts.mjs       # fake driver 下的 router 复用与 owner 隔离
node test/context-viewer.mjs          # token/loopback/access/frame/input/CSP
node test/artifact-store.mjs          # artifacts 保留
node test/chrome-verify.mjs           # 验证步骤/产物
node test/headless-login.mjs          # driver 层登录窗口生命周期
node test/install-platform.mjs        # 4 浏览器 × 3 平台的路径表
```

结果：全部 PASS。`test/headless-contexts.mjs` 用的是 fake driver，不是真实 Chrome；`test/browser-contexts.mjs` 的并发/上限也都是串行断言。真实多 context 的并发、崩溃、可见窗口没有被这些测试覆盖。

### 1.10 已确认的缺口（含本次探针）

以下是 **代码/实测** 确认的缺口，不是推测：

| # | 缺口 | 证据 | 影响 |
|---|---|---|---|
| C1 | 并发创建会超过 `maxContexts` | 探针：`max=2`，4 个并发 `create` 全部成功，最终 `active=4` | 资源上限形同虚设 |
| C2 | 同一 owner 的并发请求会创建两个 context | 探针：两个并发 `HeadlessContextRouter.request(owner:"same")`，最终 `active=2` | 同一会话的 tab/状态分裂 |
| C3 | 同名 `sandbox-persistent` 并发创建会同时成功 | 探针：两个并发 `profileName:"same"` 都返回 ok，两个 context 共用同一 profileDir | profile 被两个 Chrome 同时写 |
| C4 | `chrome_headless_login` 在 provider 路径上不可用 | `src/tools-login.js:47` 取 `bridge.headless`，但 `index.js` 传入的 `bridge` 是 `BackendRouter`，其 `headless` 是 `HeadlessContextRouter`；后者没有 `loginStart`/`loginProfile`。探针：`typeof router.headless.loginStart === "undefined"` | 工具直接返回 `UNSUPPORTED_BACKEND`，文档仍宣称可用 |
| C5 | 浏览器崩溃后 tab 状态不重建 | `ensureStarted()` 的 exit 处理器只清 `cdp/chrome`；`ensureStarted()` 重新拉起后，`tabs/bySession/owners` 仍是旧 sessionId | 下一次带 tab 的请求报 CDP 错误/stale tab；无 `CONTEXT_CRASHED` 状态 |
| C6 | 空闲回收不区分 in-flight / viewer 活动 | `reapIdle()` 只看 `lastUsedAt`；context-viewer 直接调 `driver.request()`，不经过 `HeadlessContextRouter.touch()`；`chrome_verify` 也直接调 driver | 正在被 viewer 观看或正在跑长 verify 的 context 可能在半途被关闭；有打开 tab 的 context 也会被回收 |
| C7 | `createDriver` 失败会留下临时 profile | 探针：`create` 抛 `launch failed` 后，`contexts=0`，profiles 下仍有 `ephemeral-<uuid>` 目录 | 反复失败会积累垃圾目录 |
| C8 | profile 名称可逃出 profiles 根 | `safeName()` 允许 `.`/`..`；探针：`profileName:".."` 得到 `profileDir=$DSH_HOME/cache/dsh-chrome` | 路径安全/误用风险 |
| C9 | screencast 帧目录是全局共享的 | `HeadlessDriver` 的 `screencastDir = $DSH_HOME/cache/dsh-chrome/screencast`，不随 context；`tools-screencast` 也读全局 `latest.jpg`/`meta.json` | 两个 context 同时 screencast 会互相覆盖；owner 检查只能阻止读，不能阻止覆盖 |
| C10 | `chrome_shots` 不扫描 per-context 截图目录 | `src/tools-media.js:27` 只扫描 `cache/dsh-chrome/screenshots` 与 `cache/dsh-chrome/headless/screenshots`；实际 headless 截图在 `profileDir/screenshots` | 多 context 后截图历史看不到这些文件 |
| C11 | `chrome_status` 的 headless profile 路径是错的 | `BackendRouter.headlessInfo()` 固定返回 `${home}/cache/dsh-chrome/headless/profile`（`src/backend.js:127`），但真实 profile 是 `profiles/<id>` | 排障信息误导 |
| C12 | `headlessInfo().running` 只表示“有 context” | `HeadlessContextRouter.connected` 是 `stats().active > 0`，不检查 `driver.cdp` | context 已建但浏览器未启动时也会显示 running |
| C13 | `chrome_verify` 可能跑在 visible context 上 | 无 `contextId` 时用 `activeFor(owner)`；若 active 是 `debug`，不会拒绝 | 与“只跑 headless、不开可见窗口”的描述矛盾 |
| C14 | `maxArtifactBytes` 未执行 | 只出现在 `src/config.js` 校验；全仓无读取 | 大产物可能撑爆磁盘 |
| C15 | named profile 无回收策略 | `close()` 对 `ctx.ephemeral === false` 不删除；没有 GC/配额 | 长期使用磁盘增长 |
| C16 | 关闭没有超时 | `HeadlessDriver.close()` 里 `await cdp.send('Browser.close')`，`Cdp.send()` 没有 timeout；`BrowserContextManager.close()` 先删 map 再 await | 浏览器无响应时 provider 卸载可能卡住；进程可能残留 |
| C17 | visible context 会被 driver 自身 idle 关闭 | `HeadlessDriver.startIdleTimer()` 不判断 `visible`，只看 `tabs.size === 0`；可见窗口的初始 `about:blank` 不计入 `driver.tabs` | 用户没操作/没开工具 tab 时，debug 窗口约 5 分钟后自己消失，和“显式 close”语义矛盾 |

还有两个**静态**风险，未做探针但代码路径明确：

- `create()` 在 `await createDriver()` 之前只检查了 `contexts.size`，没有 pending 计数，这是 C1/C2 的根因；
- `src/headless.js` 的 `attachTab()` 先 `Target.createTarget`，再检查 `MAX_TABS`；超限时已经创建了 target，会泄漏一个 target。

### 1.11 现有文档与代码的漂移

这不是本文重点，但会影响“已做/未做”的判断：

| 文档 | 说法 | 当前代码 |
|---|---|---|
| `docs/CONTEXTS.md` §3 | `sandbox` 是默认 | 默认取 `config.browser.preset`，可被配置成 `debug` |
| `docs/CONTEXTS.md` §6 | “`chrome_verify` artifacts 全局保留” | 对；但由 `ArtifactStore` 负责，不再由 `BrowserContextManager` 负责 |
| `docs/BROWSER-ROADMAP.md` | I2 visible 还在“后续” | 0.1.97 起已落地 `debug` |
| `docs/HEADLESS.md` §2 | profile 固定 `.../headless/profile` | 现在是 per-context `profiles/<profileId>`；固定路径只适用于旧单 driver 时代 |
| `docs/RELEASE-NOTES-0.1.96.md` | `BrowserContextManager` 增加 artifact run/prune | 现在拆到 `ArtifactStore`；manager 只负责 profile |
| `docs/LEASES.md` §7 | `index.js` 尚未传入 lease manager | `index.js:60` 构造 `leases` 并传入；`browser.shared.enabled` 时 `withWriteLease` 已门控 mutating 工具。文档其余“未接入全部写动作”的判断仍需单独核对 |
| `README.md` / `docs/TOOLS.md` | 工具数、headless 能力描述 | 以 `npm test` 的 45/46 计数和实际 `SUPPORTED` 集合为准；不要拿旧数字做验收 |

### 1.12 现状结论：可以依赖什么

**可以依赖（已实现且测试过）**：

- 顺序创建多个 context，每个独立 profile；关闭 ephemeral 会删 profile；
- 同一 owner 复用 active context；不同 owner 拿不同 context（fake driver 测试）；
- owner-aware 的 list/current/use/close/verify 边界；
- 非 visible context 的空闲回收（串行场景）；
- `sandbox-persistent` 顺序复用同名 profile；`debug` 走 visible 启动参数；
- `chrome_verify` 在已有/新建 sandbox context 上跑步骤并落 artifacts；
- context viewer 的 loopback + token + per-context access + 截图/输入；
- 4 浏览器 × 3 平台的安装路径表（仅路径/manifest，不代表真机支持）。

**不能依赖（未实现或只到半成品）**：

- “`maxContexts` 在任何并发下都成立”；
- “同一 owner 的并发请求只有一个 context”；
- “浏览器崩溃后 context 自动恢复”；
- “visible context 只由用户显式 close”（driver idle 仍可能关窗口，C17）；
- “`chrome_headless_login` 在当前 provider 上可用”；
- “每个 context 的 screencast 独立”；
- “`chrome_shots` 能看到所有 context 的截图”；
- “`chrome_status` 能准确报告每个 context 的 profile/引擎/进程状态”；
- “配置里的 `chromeExecutable`/`viewport`/`maxArtifactBytes` 生效”；
- “Edge/Brave/Chromium 可以被 headless 选择”；
- “多个浏览器可以同时连桌面后端”；
- “Safari 支持”。

---

## 2. 同引擎多实例：目标设计与缺口修补

### 2.1 不变量（先定，再写代码）

1. **一个 context = 一个浏览器进程 + 一个 profile 目录 + 一个 owner**；除非显式 `collab`，不共享 profile。
2. **`maxContexts` 是硬上限**：包括 `creating` 中的 context；并发创建不能超过。
3. **同一 owner 同时只有一个 `creating`**：并发 `backend:"headless"` 调用必须复用同一个创建中的 context。
4. **同一 named profile 同时只能被一个 context 使用**：包括创建中。
5. **visible context 只由用户显式 `close`**；hidden context 才参与 idle 回收。
6. **崩溃是显式状态**：不能把 stale tab 当成正常 tab 继续用。
7. **viewer 活动算活动**：被 viewer 观看的 context 不应被空闲回收。
8. **任何 close 有上限**：不能让 provider 卸载无限等待。

### 2.2 并发创建：slot 预留 + owner 互斥

建议把 `create()` 改成“先预留，再 await”：

```js
// 伪代码，落在 src/contexts.js
async create({ owner, preset, profileName, engine }) {
  if (this.contexts.size + this.pending >= this.maxContexts) {
    throw new ContextError('CONTEXT_LIMIT', ...)
  }
  const existing = this.creatingByOwner.get(owner)
  if (existing) return existing              // 同一 owner 复用创建中的 promise

  // profile 名在主线程同步预留，避免两个 create 同时通过检查
  const profileId = this.#reserveProfile(profileName, owner)
  const contextId = randomUUID()
  this.pending += 1
  const promise = (async () => {
    const profileDir = path.join(this.profilesRoot, profileId)
    fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 })
    try {
      const driver = await this.createDriver({ ... })
      const ctx = { ..., state: 'active' }
      this.contexts.set(contextId, ctx)
      this.activeByOwner.set(owner, contextId)
      return this.#view(ctx)
    } catch (error) {
      // 失败回滚：若 driver 已创建先 close；删 ephemeral profile；释放 profile 预留
      throw error
    } finally {
      this.pending -= 1
      this.creatingByOwner.delete(owner)
      this.#releaseProfile(profileId)
    }
  })()
  this.creatingByOwner.set(owner, promise)
  return promise
}
```

要点：

- `pending` 计入上限，保证 `maxContexts` 硬约束；
- `creatingByOwner` 让同一 owner 的并发请求只产生一个 context；
- `reservedProfiles: Set` 让同名 named profile 的并发创建返回 `PROFILE_IN_USE`；
- 失败路径必须删除 ephemeral profile、释放预留、清 `creatingByOwner`；
- 如果产品上希望“并发请求排队而不是失败”，加 `wait:true`/队列，但默认保持 fail-fast（与现有 `CONTEXT_LIMIT` 语义一致）。

验收对应的探针必须从“4 个并发全成功”变成“2 成功、2 个 `CONTEXT_LIMIT`”，且 `profiles/` 下没有孤儿目录。

### 2.3 生命周期状态与 in-flight

建议给 ctx 增加：

```js
state: 'creating' | 'active' | 'closing' | 'crashed'
inflight: 0
lastUsedAt: number
lastError: { code, message, at } | null
```

- `HeadlessContextRouter.request()`：在 `driver.request()` 前后 `beginRequest/endRequest`；`touch()` 在开始时更新，结束时也更新；
- `reapIdle()`：跳过 `state !== 'active'`、`inflight > 0`、`visible` 的 context；
- `close()`：先把 `state = 'closing'`，拒绝新请求（`CONTEXT_CLOSING`），等待 `inflight === 0` 或超时，再 `driver.close()`；`driver.close()` 用 `Promise.race([close, timeout(5s)])`，超时后 `SIGKILL` 进程树；
- `closeAll()` 并行关闭并带总超时，避免 provider 卸载被一个 hung CDP 拖住。

### 2.4 崩溃恢复

`HeadlessDriver` 需要把进程退出事件暴露给 manager：

```js
new HeadlessDriver({ ..., onExit: (code) => manager.markCrashed(contextId, code) })
```

`markCrashed`：

- `state = 'crashed'`，记录 `lastError`；
- 清掉该 driver 的 `tabs/bySession/owners`（或整体重建 driver 对象）；
- **不要**让下一次请求拿 stale tab；
- 语义二选一（建议默认 A，配置可切 B）：
  - **A. 显式失败**：`request` 返回 `CONTEXT_CRASHED`（`retryable:true`），提供 `chrome_context {op:"restart", contextId}`；由 agent/人决定是否重开；
  - **B. 懒重启**：下一次请求用同一 profile 重新 `ensureStarted()`，清空 tab 状态，返回 `restarted:true` 元数据；如果之前有 URL，可选恢复到 `about:blank` 或最后 URL，但不恢复 tabId/ref。

无论 A/B，验收都要求：崩溃一个 context 不影响其他 context；不会出现 stale sessionId 的 `TAB_NOT_FOUND`/`HEADLESS_CDP_FAILED` 穿透；`chrome_context list` 能看到 `crashed`。

### 2.5 idle：两套回收要统一语义

当前有两套：

1. **context manager**：`idleTimeoutMs`（默认 5 分钟），只看 `lastUsedAt`，非 visible 就关，**不管有没有 tab**；
2. **HeadlessDriver**：`DSH_HEADLESS_IDLE_MINUTES`（默认 5 分钟），只在 `tabs.size === 0` 时关浏览器。

建议：

- 明确“context 空闲”指“没有 in-flight 且超过阈值”，而不是“没有 tab”；如果要保留“有 tab 的 sandbox 不回收”，必须把 tab 数纳入判断并写进文档；
- viewer/frame、`chrome_verify`、`chrome_context use` 都应算活动（至少 `touch`）；
- 保留 driver 自身的 idle timer 作为兜底，但让它与 manager 的语义一致，避免一个 5 分钟关 context、另一个 5 分钟关进程的竞态；
- visible 必须跳过两者，直到显式 close；当前 context manager 已跳过，driver timer 还没有（C17）。

### 2.6 登录（`chrome_headless_login`）要么接上，要么下线

当前工具在 provider 路径不可用（C4）。两个方案：

**方案 A（推荐，工作量小）**：把登录挂到 active context 上：

- `createLoginTool` 不再取 `bridge.headless`，而是注入 `contexts` + `ownerOf`；
- `chrome_headless_login` 增加可选 `contextId`；无则 `activeFor(owner)`，没有 active 返回 `NO_ACTIVE_CONTEXT`；
- 取 `contexts.driverForOwned(contextId, owner)`，调用 driver 的 `loginStart/showVisible/loginStatus/loginFinish`；
- context 进入 `login-open` 状态，期间该 context 的 headless 请求返回 `HEADLESS_LOGIN_OPEN`；
- `chrome_context close` 时先 `loginFinish()`，再关 driver。

**方案 B（如果近期不做）**：从工具注册中移除 `chrome_headless_login`，同步删文档中的能力声明；不要留一个“文档说能用、实际返回 UNSUPPORTED_BACKEND”的工具。

无论哪个方案，都要补 `test`：hosted 路径（有 manager）而不是只测 driver 方法。

### 2.7 viewer 与 per-context 管理

- `chrome_context {op:"viewer"}` 增加可选 `contextId`：不传仍是 active，传了就 `getOwned` + `urlFor`；这样多 context 时可以分别取 URL；
- viewer 的 frame/input 活动调用 `manager.touch(contextId)`（或通过 router），避免被 idle 回收（C6）；
- viewer 的 access 是 per-context bearer；文档明确“不要把 viewer URL 写进日志/截图/模型上下文”；
- provider reload 后 access map 清空，旧 URL 403；token 文件保留，新 `urlFor` 重新发 access。这是当前行为，应写进测试与文档。

### 2.8 可观测性

`chrome_status` 的 headless 块建议改为：

```json
{
  "supported": true,
  "engines": ["chrome"],
  "contexts": {
    "active": 2,
    "max": 4,
    "items": [
      { "contextId": "...", "owner": "...", "preset": "sandbox", "state": "active",
        "engine": "chrome", "pid": 1234, "visible": false, "lastUsedAt": 0 }
    ]
  }
}
```

至少修掉 C11/C12：不要再返回固定 legacy profile 路径；`running` 要区分“有 context”和“浏览器 CDP 已连接”。

### 2.9 这一阶段的验收标准

| # | 验收项 | 通过条件 |
|---|---|---|
| A1 | 并发上限 | `maxContexts=2`，16 个并发 create，恰好 2 个成功、14 个 `CONTEXT_LIMIT`；`stats().active === 2` |
| A2 | 同 owner 去重 | 同一 owner 两个并发 `backend:"headless"` 请求，只创建 1 个 context，两个请求命中同一 contextId |
| A3 | named profile 互斥 | 两个并发同名 `sandbox-persistent`，一个成功、一个 `PROFILE_IN_USE`；只有一个 profileDir |
| A4 | 创建失败回滚 | `createDriver` 抛错后 `active===0`，profiles 下无新增目录 |
| A5 | 崩溃隔离 | kill context A 的 Chrome；B 仍可服务；A 返回 `CONTEXT_CRASHED`（或 `restarted:true`），无 stale tabId 穿透 |
| A6 | idle 安全 | 长请求/正在被 viewer 看的 context 不被回收；空闲且无 in-flight 的 hidden context 按阈值回收；visible 不被回收 |
| A7 | close 有界 | `closeAll()` 在 5s 内返回；无 Chrome 子进程残留（`ps` 检查） |
| A8 | 登录/ viewer | `chrome_headless_login` 在 provider 路径可用，或工具已移除；`chrome_context viewer contextId` 可对任意 owned context 发 URL |
| A9 | 产物隔离 | 两个 context 的 screenshots/downloads/screencast 不互相覆盖；`chrome_shots` 能列出 per-context 截图；`maxArtifactBytes` 生效 |
| A10 | 文档一致 | `docs/CONTEXTS.md`、`docs/BROWSER-ROADMAP.md`、`docs/HEADLESS.md`、`docs/LEASES.md` 与本阶段代码对齐 |

---

## 3. 多引擎：现在有什么、缺什么

### 3.1 现状矩阵

| 层 | Chrome | Edge | Brave | Chromium | Safari |
|---|---|---|---|---|---|
| 安装路径表（mac/linux/win） | ✅ | ✅ | ✅ | ✅ | ❌ |
| native manifest 写入 | ✅ mac/linux/win | ✅ 路径表；真机未验证 | ✅ 路径表；真机未验证 | ✅ 路径表；真机未验证 | ❌ |
| 扩展代码复用 MV3 | ✅ | ✅（理论同源） | ✅（理论同源） | ✅（理论同源） | ❌ 需 Safari Web Extension |
| 桌面后端运行时同时连接 | 单浏览器 | 单浏览器 | 单浏览器 | 单浏览器 | — |
| headless 可执行文件候选解析 | ✅ 候选表（MVP） | ✅ 候选表（MVP） | ✅ 候选表（MVP） | ✅ 候选表（MVP） | ❌ |
| headless 运行时调度/选择 | ❌ | ❌ | ❌ | ❌ | ❌ |
| Windows headless | ❌（仅候选解析） | ❌（仅候选解析） | ❌（仅候选解析） | ❌（仅候选解析） | — |
| 真机验证 | macOS 本机 | ❌ | ❌ | ❌ | ❌ |

### 3.2 具体卡点

1. **桌面 bridge 是单 socket**：`BridgeServer.#accept()` 在新连接到来时会 `destroy` 旧 socket（`src/bridge.js:90-95`）。Chrome 和 Edge 各自拉起 native host 时，第二个连接会把第一个踢掉。因此“同时连两个浏览器”不是配置问题，是架构问题。
2. **安装器一次只装一个浏览器**：`ensureInstallAssets({ browser = process.env.DSH_CHROME_BROWSER || 'chrome' })`（`src/install.js:316-320`）每次只写一个浏览器的 manifest/注册表。没有“给所有已安装浏览器都装”的循环，也没有运行时浏览器选择。
3. **headless 候选已表驱动（MVP），但没有 per-context engine**：`src/headless-browsers.js` 复用 `browserPaths().executableCandidates`，覆盖 Chrome/Chromium/Edge/Brave × mac/linux/win，并解析 `DSH_HEADLESS_ENGINE`、config `browser.engine` / `browser.headless.chromeExecutable`、`DSH_HEADLESS_CHROME`；仍缺 `chrome_context create {engine}`、`chrome_status` 的 engine 字段和真机启动验证。
4. **`headlessSupported()` 在 provider 启动时一次性判定**：没有 Chrome/Chromium 时 `headless = null`；之后装了浏览器也不会自动恢复，需要重载 provider。
5. **没有引擎身份**：`BridgeServer` 的 hello 只带 `hostVersion`，`chrome_status` 不报告 engine；`chrome_*` 工具没有 `engine` 参数；没有 `chrome_browsers` 工具（`docs/ROADMAP.md` 只把它列为 P3 设想）。
6. **`browser.headless.chromeExecutable` 已接线但仍为全局**：显式路径/引擎不存在时报 `HEADLESS_EXECUTABLE_NOT_FOUND`，不会静默回退；但解析结果属于 provider 级配置，不是 per-context engine，也没有 `chrome_status` 的 engine/实际路径字段。

### 3.3 设计目标

把“引擎”做成和“backend”“preset”正交的维度：

```text
engine ∈ {chrome, edge, brave, chromium}        （Safari 另线）
backend ∈ {desktop, headless}
preset ∈ {sandbox, sandbox-persistent, debug}  （collab 未实现）
context = engine × preset × profile × owner
```

建议的边界：

- **engine 是 context 的创建属性，创建后不可变**；切换引擎 = 新建 context；
- **显式 engine 不存在时失败**，错误码 `ENGINE_NOT_FOUND`，错误里列出候选路径；不要静默换成 Chrome；
- **`engine:"auto"`** 才允许按固定优先级探测（建议 `chrome → chromium → edge → brave`），并在 context view/status 里记录实际 engine；
- 全局 `maxContexts` 继续限制总数；是否加 `maxContextsPerEngine` 由实测决定，先不加；
- 每个 context 的 profile 目录仍按 contextId/profileId 隔离，与 engine 无关。

### 3.4 headless 多引擎（优先做）

> 状态（2026-10-19）：可执行文件候选解析/选择 MVP 已落地（见文末附录与 `src/headless-browsers.js`）；下面的 per-context engine 透传、`availableEngines()`、`chrome_status` engine 字段和真机矩阵仍未做。

建议新增 `src/engines.js`（名字可改，关键是单一职责）：

```js
export const ENGINE_IDS = ['chrome', 'edge', 'brave', 'chromium']

// 复用 src/platform.js 的 BROWSERS/browserPaths；补 PATH 查找与可执行校验
export function engineCandidates(engine, platform = process.platform, opts = {}) // -> string[]
export function detectEngine(engine, platform, opts = {}) // -> { engine, executable, source } | null
export function availableEngines(platform, opts = {}) // -> [{ engine, executable }]

// HeadlessDriver 新增可选参数
new HeadlessDriver({ engine: 'edge', executable: '/.../msedge', ... })
```

实现要点：

- `browserPaths(engine, platform).executableCandidates` 给出候选；Linux 的裸命令名（`google-chrome`）要按 `PATH` 解析，不能用 `fs.existsSync('google-chrome')`；找到后校验 `X_OK`；
- Windows 使用表里的 `%PROGRAMFILES%` 展开结果，注意空格路径；`spawn` 直接传数组参数，不要再拼 shell 字符串；
- `HeadlessDriver` 不再调用模块级 `chromeExecutable()`，改为构造参数优先，回退到 `DSH_HEADLESS_CHROME`；`buildLaunchArgs()` 保持同一套 Chromium 参数（Edge/Brave 也是 Chromium）；
- `headlessSupported()` 改为 `availableEngines()`；`index.js` 在启动时探测；如果之后安装新浏览器，提供 `chrome_status`/重载提示，不要假装自动恢复；
- `BrowserContextManager.create({ engine })` 存 `engine`；`chrome_context create` 加 `engine` 枚举；`chrome_context list/current` 输出 engine；
- 配置建议 `browser.engine`（默认 `chrome` 或 `auto`；推荐默认 `chrome`，保持现有行为，`auto` 需显式开启）；
- `chrome_verify` 若 active context 的 engine 不是 Chrome，不应拒绝（都是 CDP），但要能在报告里记录 engine；
- 错误码：`ENGINE_NOT_FOUND`（显式 engine 不可用）、`ENGINE_UNSUPPORTED`（探测到但不是 Chromium/CDP，如误指 Safari）、`HEADLESS_LAUNCH_FAILED`（已有）。

**headless 多引擎验收**：

| # | 验收项 | 通过条件 |
|---|---|---|
| B1 | 显式 engine | `browser.engine=edge` 且 Edge 已安装时，context 的进程路径指向 Edge；`chrome_status` 记录实际 `browserVersion`；profile 仍独立 |
| B2 | 不可用失败 | 显式 engine 未安装 → `ENGINE_NOT_FOUND`，错误里列出候选路径，不静默换 Chrome |
| B3 | auto 语义 | `engine:"auto"` 按文档优先级选择，context/status 记录实际 engine；没有可用引擎时明确失败 |
| B4 | 现有 Chrome 无回归 | 默认配置下现有 Chrome 路径/启动参数/工具行为不变；现有测试全绿 |
| B5 | 真机矩阵 | macOS Chrome/Chromium/Edge/Brave（已安装的）、Linux Chrome/Chromium、Windows Chrome/Edge 至少各跑一次核心工具冒烟 |
| B6 | 状态/错误可观测 | `chrome_status` 报可用引擎与实际 engine；错误码稳定，不把“未安装”伪装成 `UNSUPPORTED_BACKEND` |

**Edge/Brave 的差异不要假设为零**：同一份 MV3 扩展 API 大体同源，但 `debugger` 行为、sidePanel、默认启动参数、首启页面、企业策略都可能不同。headless 层至少要在真机跑 `goto/snapshot/click/type/screenshot/console/network` 冒烟，不能只看路径存在。

### 3.5 桌面多引擎（后做，成本高）

如果要求“用户开着 Chrome，同时也能让 Edge 的扩展连上”，需要改 bridge：

```text
当前：
  Chrome native host ─┐
                      ├─ BridgeServer.socket（单 socket，后到踢先到）
  Edge native host ───┘

目标：
  BridgeServer
    ├─ client(chrome, hostVersion, extensionVersion) → socket
    ├─ client(edge, ...) → socket
    └─ call(method, params, { engine }) → 选对应 client
```

需要一起改：

1. **连接注册表**：`BridgeServer` 从 `this.socket` 单值改成 `Map<clientId, client>`；hello 带 `engine`/`extensionVersion`；每个 client 独立 pending/心跳；断线只影响该 client。
2. **引擎身份来源**：扩展可以在 hello 里上报自己是什么浏览器（例如基于 UA/`chrome.runtime` 可得的信息）；native host 也可以由 per-browser launcher 注入 `engine` 环境变量。两者选一个作为权威，另一个做校验。
3. **安装器**：`ensureInstallAssets` 支持 `browsers: [...]` 或“探测所有已安装浏览器”，每个 browser 写自己的 manifest/注册表；Windows 共享 manifest 文件但注册表键各自写；mac/Linux 各目录各写。
4. **路由/选择**：新增 `chrome_browsers` 工具（list/use/status），按 owner 记住选中的 engine；`backend:"desktop"` 默认用 owner 的选中引擎，未选时用唯一已连接引擎或 `chrome`。不建议给所有 `chrome_*` 加 `engine` 参数（schema 体积和模型选择成本都会上升）。
5. **tabId 命名空间**：不同引擎的 tabId 会碰撞。要么限制“一个会话同时只用一个引擎”（切换即作废旧 tabId），要么把 tabId 变成 `engine:tabId` 复合值；前者简单，推荐先做前者。
6. **安全/重连**：bridge token 仍可共享；每个 client 独立握手/独立 pending；provider 重启后所有 client 重连；`chrome_status` 显示每个引擎的 connected/version/lastSeen。

这条线的验收必须包含：

- Chrome + Edge 同时连接，list 能看到两个；操作一个不影响另一个；
- 关掉一个浏览器，另一个仍可调用；重开后能重连；
- 同一会话切换 engine 后旧 tabId 被明确拒绝（`TAB_NOT_FOUND` 或 `ENGINE_MISMATCH`）；
- Windows 注册表/路径含空格/非管理员；mac/Linux 双浏览器目录；
- 商店/权限差异（Edge Add-ons、Brave 扩展页）有文档。

### 3.6 Safari：不是“多引擎”的一支

Safari 不是 Chromium：

- 不能加载 Chrome MV3 扩展，需要 Safari Web Extension（Xcode 工程 + Apple 签名/App Store）；
- 没有 `chrome.debugger`/CDP 同级控制；页面控制主要靠 content script + `browser.scripting`/`tabs`，能力受限；
- 不能复用 `HeadlessDriver`、`BackendRouter` 的 headless 路径、Chrome native messaging 安装器；
- 分发必须走 App Store，审核/隐私声明是硬成本；
- macOS 与 iOS 的 Safari 扩展 API/权限不同。

因此 Safari 应作为**独立产品线 spike**，不放进“多引擎调度”的同一阶段（spike 计划见 §6.4）。

---

## 4. 资源与生命周期

### 4.1 现有旋钮

| 旋钮 | 默认 | 作用 | 现状 |
|---|---|---|---|
| `browser.maxContexts` | 4（1–16） | 全局 context 上限 | 串行 + 并发均有效（pending 预留，C1 已修） |
| `browser.maxTabs` | 12（1–64） | 每个 headless 浏览器的 tab 上限 | ✅ M4：canonical 设置，volatile，传给 HeadlessDriver；超限 `RESOURCE_LIMIT`，关 tab 释放 |
| `browser.idleTimeoutMs` | 300000（10s–1h） | hidden context 空闲回收 | 只看 `lastUsedAt`；不管 tab/in-flight/viewer（C6） |
| `browser.profilesDir` | `$DSH_HOME/cache/dsh-chrome/profiles` | profile 根 | 可用；无配额/GC |
| `DSH_HEADLESS_IDLE_MINUTES` | 5 | driver 在无 tab 时关浏览器 | 与 context 回收是两套 |
| `DSH_HEADLESS_MAX_TABS` | 12 | 每个 driver 的 tab 上限 | 已由 `browser.maxTabs` 取代；仅在该设置仍为默认值时兜底 |
| `verification.artifactRetentionRuns` | 50 | verify 运行目录保留 | 生效（仅 verify） |
| `verification.maxArtifactBytes` | 50MB | 产物体积上限 | 未执行（C14） |

### 4.2 实测基线（本机，2026-10-19）

**两个真实 sandbox context（无 tab，`browser.status` 后 2.5s）**：

| context | 进程数 | RSS 求和 | 启动 |
|---|---|---|---|
| A | 7 | 770 MB | 两个 context 合计约 4.0s |
| B | 7 | 730 MB | 同上 |

RSS 求和会重复计算共享页；`docs/HEADLESS.md` §4.1 对**单个** headless 空闲的基线是 **5 进程 / 449MB RSS / footprint 151MB**，活跃压测约 **1.1GB RSS**。因此：

- 默认 `maxContexts=4` 在最坏情况下是 **4 个完整 Chrome**，不是“4 个 tab”；
- 按单 context 空闲 footprint ~150MB 估算，4 个约 600MB；按 RSS 求和会看到 ~3GB；活跃时可能到数 GB；
- 当前没有内存压力检测/排队/驱逐，达到 `maxContexts` 直接报错；
- `maxContexts` 上限 16，允许配置出非常高的资源占用；
- **CPU 同样会叠加**：`docs/HEADLESS.md` §4.1 的活跃压测里单个 context 约 **63–71% CPU**（截图占大头）；4 个 context 同时活跃可以把参考机器打满，而当前没有 CPU 准入/限流。

具体数值会随 Chrome 版本、页面、macOS/Linux 不同；验收时应重新测量，不要引用本文数字作为承诺。

### 4.3 目标预算与准入

建议在实现前定一个“资源预算”，否则 `maxContexts` 只是拍脑袋：

1. **参考机器**：至少 16GB RAM；记录 OS/Chrome 版本。
2. **单 context 空闲预算**：目标 footprint ≤ 250MB（当前 ~150MB，留余量）；活跃单 context RSS ≤ 1.5GB。
3. **默认上限**：`maxContexts=4` 的 4 个空闲 context footprint 目标 ≤ 1GB；如果实测超，优先降到 2 或引入 per-owner 上限。
4. **准入**：达到上限返回 `CONTEXT_LIMIT`，不静默驱逐；后续可选“回收最久未用的 active context”策略，但必须是显式配置。
5. **公平性**：至少加 per-owner 上限（建议 1–2），防止一个 agent/子代理占满所有 slot；全局上限仍保留。
6. **观测**：`chrome_status` 输出 context 数、engine、pid、state；不要输出敏感页面内容。进程级 RSS 可以只写日志，不进模型上下文。

### 4.4 profile 与产物生命周期

| 对象 | 位置 | 关闭时 | 现状风险 |
|---|---|---|---|
| ephemeral profile | `profiles/ephemeral-<uuid>` | 删除 | 创建失败会残留（C7） |
| named profile | `profiles/<name>` | 保留 | 无 GC/配额（C15）；名称可 `..`（C8） |
| headless screenshot | `<profileDir>/screenshots` | ephemeral 随 profile 删除；named 保留 | `chrome_shots` 不扫描 per-context（C10） |
| download | `<profileDir>/downloads` | 同上 | 无清理 |
| verify artifact | `artifacts/verify-<runId>` | 保留最近 N 次 | `maxArtifactBytes` 未执行（C14） |
| screencast | `$DSH_HOME/cache/dsh-chrome/screencast` | 保留最新帧 | 多 context 共享覆盖（C9） |
| viewer token | `$DSH_HOME/cache/dsh-chrome/context-viewer-token` | 保留 | 0600；provider reload 后 access 失效 |

建议：

- 把 screencast 目录改成 `<profileDir>/screencast`，或文件名带 contextId；`tools-screencast` 按 context 解析；
- `chrome_shots` 扫描当前 manager 的所有 `profileDir/screenshots`，或把 headless 截图统一写到 `screenshots/<contextId>/`；
- `maxArtifactBytes` 在 `ArtifactStore` 写入/复制时执行，超限截断或拒绝并返回明确错误；
- named profile 增加 `browser.profileRetention`（数量/天数）或至少提供 `chrome_context {op:"delete-profile"}` 的显式删除；不要自动删用户登录态；
- profile 名称做严格校验：正则 `^[A-Za-z0-9][A-Za-z0-9._-]*$`，显式拒绝 `.`/`..`/空。

### 4.5 多进程/多 DSH 实例边界

当前所有状态都在**一个 provider 进程**内：

- `BridgeServer` 的 `bridge.sock`/`bridge.json` 在 `$DSH_HOME/cache/dsh-chrome/` 下是固定路径；两个 provider 进程同时跑会互相 unlink/覆盖，第二个连接会踢掉第一个；
- `BrowserContextManager` 的 `contexts`/`activeByOwner` 只在内存，不跨进程；
- `artifacts`、`screencast`、`shot-owners.json` 是共享目录但没有跨进程锁；
- 多进程同时创建 context 时 profile UUID 通常不冲突，但无法互相 list/close/viewer。

结论：**多 provider 进程不在当前支持范围**。如果要支持，需要文件锁 + 每进程独立 socket + 中央 registry（或明确每个 DSH 实例用独立 `DSH_HOME`）。本文建议先写进限制，不要声称“多实例”包含多进程。

---

## 5. 测试矩阵

### 5.1 现有覆盖

| 维度 | 现有测试 | 覆盖 | 缺口 |
|---|---|---|---|
| 配置/preset | `test/browser-contexts.mjs` | 默认/项目覆盖/secret/未知字段/preset 映射 | 配置默认 `debug` 时的懒创建 |
| 管理器生命周期 | `test/browser-contexts.mjs` | 顺序上限、profile 复用、idle、owner、debug flag、collab 拒绝 | 并发创建、崩溃、close 超时、create 失败回滚 |
| router | `test/headless-contexts.mjs` | fake driver 下同 owner 复用、不同 owner 隔离 | 真实 driver、同 owner 并发、崩溃重连 |
| viewer | `test/context-viewer.mjs` | token/loopback/access/CSP/frame/input/404/单 context | 多 context、provider reload 后 access、viewer 活动是否算 idle |
| verify/artifacts | `test/chrome-verify.mjs`、`test/artifact-store.mjs` | 步骤/产物/保留 | visible context、体积上限、真实多 context |
| 平台路径 | `test/install-platform.mjs` | 4×3 路径/manifest 文案（fake fs） | 真机 Edge/Brave、Windows headless |
| 真实 headless | `test/headless.mjs`、`test/sandbox-smoke.mjs` | 单 driver 的真 Chrome | 多 context 并发、真实隔离 |
| 登录 | `test/headless-login.mjs` | driver 方法（fake spawn） | provider 接线（当前 C4） |
| lease | `test/lease.mjs`、`test/lease-gate.mjs` | lease 语义/写门控 | 与 collab context 的整合（未实现） |

### 5.2 需要补的矩阵

| 用例 | 类型 | 断言 | 阶段 |
|---|---|---|---|
| 并发 create 不超上限 | unit | N 并发，成功数 = max；无孤儿 profile | A |
| 同 owner 并发去重 | unit | 只 1 个 context；两个请求同 contextId | A |
| named profile 并发互斥 | unit | 1 成功 1 `PROFILE_IN_USE` | A |
| createDriver 失败回滚 | unit | active=0；无 profile 残留 | A |
| 真实 2 context 隔离 | integration | 不同 pid/profile；cookie/localStorage 不串；关 A 不影响 B | A |
| kill 一个 context 的 Chrome | integration | B 正常；A `CONTEXT_CRASHED`/`restarted`；无 stale tab | A |
| idle vs in-flight/viewer | unit + integration | 长请求/观看中不回收；空闲回收；visible 不回收 | A |
| closeAll 有界 | integration | 5s 内返回；无残留 Chrome 进程 | A |
| visible debug 真窗口 | manual/integration | 窗口出现、工具可操作、不参与 idle、显式 close 关闭 | A |
| viewer 多 context | unit + integration | 两个 URL 各自可用；错 access 403；close 后 404；reload 后旧 URL 403 | A |
| 登录 provider 接线 | integration | `chrome_headless_login` 在 active context 上工作；打开期间 headless 请求被拒 | A |
| screencast 隔离 | integration | 两个 context 同时 start，帧文件/status 不串 | A |
| artifacts 体积/保留 | unit | 超 `maxArtifactBytes` 拒绝/截断；N+1 次 prune | A |
| headless engine 探测 | unit | 4 engine × 3 platform 的候选/路径/PATH | B |
| Edge/Brave/Chromium 真机冒烟 | manual | 每个已安装引擎跑核心工具 | B |
| Windows headless | manual | Chrome/Edge 路径、空格、启动、截图 | B |
| 双浏览器桌面同时连接 | integration | Chrome+Edge 同时 list/操作/断线重连 | C |
| 单浏览器断开不影响另一个 | integration | kill 一个 host，另一个仍可调用 | C |
| engine 切换后旧 tabId | unit | `TAB_NOT_FOUND`/`ENGINE_MISMATCH` | C |
| Safari spike | manual | 读/点击/输入/授权/限制清单 | D |

### 5.3 测试原则

- **不要只用 fake driver 证明“多实例”**：真实的独立进程、profile 目录、cookie 隔离必须用真 Chrome 跑至少 2 个 context；
- **并发测试要可控地延迟 `createDriver`**（例如 30ms），否则单线程同步路径会掩盖竞态；
- **崩溃测试要真正 kill 进程**，不要只 mock `driver.request` 抛错；
- **owner 边界要同时测“看不到”和“不能操作”**，且错误码/文案不泄露 context 是否存在；
- **多引擎测试要在目标 OS 上跑**，路径表单测不能替代 Edge/Brave/Windows 真机。

---

## 6. 分阶段计划

| 阶段 | 内容 | 依赖 | 估算 | 退出条件 |
|---|---|---|---|---|
| **0. 当前基线** | 同引擎 per-agent context、viewer、verify、artifacts | — | 已完成 | 本文 §1 的“可以依赖”清单 |
| **A. 同引擎硬化** | 并发/生命周期/崩溃/登录/产物隔离/文档 | 无 | 2–3 人日 | §2.9 A1–A10 |
| **B. headless 多引擎** | engine 探测/选择/状态；Edge/Brave/Chromium/Windows | A（建议） | 3–5 人日 | §3.4 B1–B6 + 真机矩阵 |
| **C. 桌面多引擎** | bridge 多 client、安装多浏览器、`chrome_browsers` | B 的 engine 模型 | 5–8 人日 | §3.5 验收 |
| **D. Safari spike** | Safari Web Extension 可行性，不做产品化 | 无（可并行） | 2–3 人日 | capability 矩阵 + go/no-go |
| **E. 多 provider 进程** | 文件锁/独立 socket/中央 registry | A/C | 未排期 | 明确支持范围后再做 |

### 6.1 阶段 A（先做，性价比最高）

1. 修 `BrowserContextManager.create()` 的 slot 预留、owner 互斥、profile 预留、失败回滚（§2.2）；
2. 加 lifecycle state/in-flight/close 超时/崩溃状态（§2.3–2.4）；
3. 统一 idle 语义，viewer/verify 活动算活动（§2.5）；
4. 接上或下线 `chrome_headless_login`（§2.6）；
5. `chrome_context viewer` 支持 `contextId`；viewer 活动 `touch`（§2.7）；
6. per-context screencast、`chrome_shots` 扫描、`maxArtifactBytes`、profile 名校验（§4.4）；
7. 修 `headlessInfo` 的 profile/running 误报；补 `chrome_status` context 摘要（§2.8）；
8. 更新 `docs/CONTEXTS.md`、`docs/BROWSER-ROADMAP.md`、`docs/HEADLESS.md`、`docs/LEASES.md` 的漂移（§1.11）。

**不要在这一阶段做**：多引擎调度、bridge 多 client、Safari。先把“一个引擎的多个 context”做可靠。

### 6.2 阶段 B（headless 多引擎）

> 状态（2026-10-19）：第 1 项的候选解析/选择 MVP 已落地（`src/headless-browsers.js` + `test/headless-browsers.mjs`）；其余（per-context engine、`availableEngines()`、状态字段、真机矩阵）未做。

1. `src/engines.js` + `browserPaths()` 复用 + PATH/X_OK/Windows 候选；
2. `HeadlessDriver` 接受 `engine/executable`；`headlessSupported()` → `availableEngines()`；
3. `BrowserContextManager.create({engine})`、`chrome_context create {engine}`、配置 `browser.engine`；
4. `chrome_status` 报 engine/候选/实际路径（路径可只写日志，避免把用户目录塞进模型上下文）；
5. 真机矩阵：macOS Chrome/Chromium/Edge/Brave（已安装的）、Linux 至少 Chrome/Chromium、Windows 至少 Chrome/Edge；
6. 明确 `auto` 优先级和“显式 engine 不静默回退”。

**退出条件**：显式 `engine` 不可用时返回 `ENGINE_NOT_FOUND`；可用时核心工具在目标引擎上通过；现有 Chrome 行为无回归。

### 6.3 阶段 C（桌面多引擎）

只有阶段 B 的 engine 模型稳定后再做。核心是 `BridgeServer` 多 client 和安装器多浏览器；工作量明显大于 B，且真机矩阵/商店/权限问题多。可以先交付“同一时间只连一个浏览器，但可配置/枚举”的小版本，再决定是否做“同时连接”。

### 6.4 阶段 D（Safari spike）

- 2–3 人日：Xcode Safari Web Extension + 最小 content script，验证读 URL/title/文本、点击、输入、用户授权、native messaging（可选）；
- 产出 capability 矩阵（能/不能/需要签名/需要 App Store）；
- 结论只有“继续/不继续”，不在 spike 里承诺 `chrome_*` 工具面一致；
- 如果继续，单独立项（文档估计 6–12 人日起步，不含审核）。

### 6.5 并行建议

- A 与 D 可并行（Safari 不依赖 A）；
- B 最好在 A 之后，避免在并发/生命周期不稳的 manager 上叠 engine 维度；
- C 在 B 之后；如果近期只需要“后台多引擎”，可以先不做 C。

---

## 7. 已做 / 未做清单（明确版）

### 7.1 已做

| 能力 | 证据/位置 | 备注 |
|---|---|---|
| per-agent headless context 懒创建 | `src/headless-contexts.js`；`test/headless-contexts.mjs` | fake driver 测试；真实单 context 在 `docs/HEADLESS.md` |
| 独立 profile / screenshots / downloads | `index.js:65-78`；`test/browser-contexts.mjs` | per context |
| `sandbox` / `sandbox-persistent` / `debug` | `src/config.js:150`；`test/browser-contexts.mjs` | `debug` 真机窗口未自动化 |
| `collab` 拒绝 | `src/contexts.js:68-70` | `UNSUPPORTED_MODE` |
| 顺序 `maxContexts` / `PROFILE_IN_USE` | `test/browser-contexts.mjs` | 并发不成立（C1/C3） |
| 非 visible idle 回收 | `test/browser-contexts.mjs` | 有 tab 也会回收；viewer 不算活动（C6） |
| owner-aware API | `test/browser-contexts.mjs`、`test/headless-contexts.mjs` | 跨 owner 不泄露存在性 |
| `chrome_context` create/list/current/use/close/viewer | `src/tools-context.js` | viewer 只对 active |
| `chrome_verify` + 全局 artifacts | `src/tools-verify.js`、`test/chrome-verify.mjs` | 可能跑 visible context（C13） |
| context viewer | `src/context-viewer.js`、`test/context-viewer.mjs` | token + per-context access + loopback |
| 4×3 安装路径表 | `src/platform.js`、`test/install-platform.mjs` | 仅路径/manifest；真机未验证 |
| headless 可执行文件候选解析（4×3） | `src/headless-browsers.js`、`test/headless-browsers.mjs` | MVP；只解析/选择，未启动真机 |
| Windows native host 注册表/打包 | `src/install.js`、`docs/WINDOWS-HOST.md` | 与多引擎无关 |
| lease 基础/写门控 | `src/lease.js`、`src/tool-guards.js`、`test/lease.mjs` | `collab` 未接入 |

### 7.2 未做

| 能力 | 当前实际行为 |
|---|---|
| 并发 `maxContexts` 硬约束 | 可超（C1） |
| 同 owner 并发去重 | 可创建两个（C2） |
| named profile 并发互斥 | 可两个 context 共用（C3） |
| 崩溃恢复/`CONTEXT_CRASHED` | 只重拉进程，tab 状态不重建（C5） |
| `chrome_headless_login` 在 provider 路径可用 | 返回 `UNSUPPORTED_BACKEND`（C4） |
| per-context screencast | 全局目录，互相覆盖（C9） |
| `chrome_shots` 看到 per-context 截图 | 只扫旧目录（C10） |
| 准确 status | profile 路径固定旧值；running 只看 context 数（C11/C12） |
| `maxArtifactBytes` | 未执行（C14） |
| named profile 回收 | 无（C15） |
| close 超时 | 无（C16） |
| visible 不被 driver idle 关闭 | driver timer 不判断 visible；初始窗口不计 tab（C17） |
| headless Edge/Brave/Chromium 选择 | 候选解析/全局显式选择已实现（MVP）；无 per-context engine、无 status engine 字段 |
| headless Windows | 候选路径已表驱动解析；未真机启动 |
| 桌面多浏览器同时连接 | bridge 单 socket，后到踢先到 |
| `chrome_browsers` | 不存在 |
| 跨 provider 进程协调 | 不存在 |
| Safari 支持 | 只有 `docs/SAFARI-SPIKE.md` |

### 7.3 不要声称的能力

在对外文档/Release Notes/模型提示里，以下说法目前不成立：

- “支持多浏览器”（除非明确写“安装路径表支持，运行时暂不支持多引擎”）；
- “Chrome/Edge/Brave 可同时连接”；
- “context 并发安全/上限严格”；
- “浏览器崩溃会自动恢复”；
- “`chrome_headless_login` 可用”；
- “每个 context 的 screencast/截图历史独立”；
- “Safari 支持”；
- “多个 DSH 实例共享 context”。

---

## 8. 风险登记

| # | 风险 | 证据 | 影响 | 缓解 | 阶段 |
|---|---|---|---|---|---|
| R1 | 并发创建超上限，资源被打爆 | C1 探针 | 高：4 个变 N 个 Chrome | slot/pending + 测试 | A |
| R2 | 同 owner 双 context，tab 状态分裂 | C2 探针 | 高：同一会话操作两个浏览器 | owner creating map | A |
| R3 | named profile 双写 | C3 探针 | 高：profile 损坏/登录态丢失 | profile 预留 | A |
| R4 | 崩溃后 stale tab | C5 | 中高：请求不可预测失败 | 崩溃状态 + 清 tab + 重拉 | A |
| R5 | 登录工具不可用但文档宣称可用 | C4 探针 | 中：功能失信 | 接线或下线 | A |
| R6 | viewer/长 verify 被 idle 回收 | C6 | 中：观看/验证中断 | in-flight + touch | A |
| R7 | 单 bridge socket 挡多引擎 | `src/bridge.js:90-95` | 高：桌面多引擎无法做 | 多 client registry | C |
| R8 | 每个 context 一个 Chrome，内存高 | §4.2 实测 | 高：默认 4 个可达数 GB | 预算/默认值/准入/文档 | A |
| R9 | profile 名 `..` 逃逸 | C8 探针 | 中：写错目录 | 严格校验 | A |
| R10 | screencast 全局覆盖 | C9 | 中：多 context 画面串 | per-context 目录 | A |
| R11 | `chrome_shots` 看不到截图 | C10 | 低中：历史缺失 | 扫描 profile 目录 | A |
| R12 | `chrome_status` 误报 | C11/C12 | 中：排障被误导 | 修 headlessInfo | A |
| R13 | close 卡住/进程残留 | C16 | 中：provider 卸载慢 | close 超时 + SIGKILL | A |
| R14 | Edge/Brave 只是路径表，真机未验 | `docs/EDGE.md`、`test/install-platform.mjs` | 中：宣称支持但不可用 | 真机矩阵 | B |
| R15 | headless Windows 只解析未验证 | 候选表已含 Windows；无真机启动 | 中：Windows 只能桌面 | 真机矩阵 | B |
| R16 | `headlessSupported` 启动时固定 | `index.js:85` | 低中：装浏览器后要重载 | 重新探测/提示 | B |
| R17 | Safari 成本被低估 | `docs/SAFARI-SPIKE.md` | 高：App Store/签名/API 限制 | 先 spike，不承诺 | D |
| R18 | 多 provider 进程冲突 | `bridge.sock`/`bridge.json` 固定 | 中：同一 DSH_HOME 双开 | 文档限制/文件锁 | E |
| R19 | viewer URL 是 bearer capability | `src/context-viewer.js` | 中：URL 泄露即可操作 | 不写日志/文档警示/可选短期 token | A |
| R20 | 文档漂移导致误判 | §1.11 | 中：验收口径不一致 | 阶段 A 同步文档 | A |
| R21 | debug 窗口被 driver idle 关闭 | C17 | 中：用户看到窗口自己消失 | driver timer 跳过 visible；初始窗口计数或禁用 | A |

---

## 9. 需要拍板的开放问题

1. **`maxContexts` 默认值**：保持 4，还是按实测降到 2/3？是否加 per-owner 上限（建议 1–2）？
2. **engine 选择**：默认 `chrome` 还是 `auto`？`auto` 的优先级是否接受 `chrome → chromium → edge → brave`？显式 engine 不可用时是否允许静默回退（建议不允许）？
3. **桌面多引擎的优先级**：近期是否真的需要“Chrome + Edge 同时连接”？如果只需要后台多引擎，阶段 C 可以不做。
4. **Safari**：spike 预算 2–3 人日是否批准？spike 后是否接受“只做读页面 + 基础点击”的最小能力？
5. **登录工具**：接到 active context（方案 A），还是近期下线（方案 B）？
6. **viewer 跨 owner**：当前“拿到 URL 即可操作”是否接受？如果不接受，需要把 viewer 访问绑定到 DSH 会话（需要 Host 侧身份，不只是 per-context access）。
7. **多 provider 进程**：是否需要支持？如果不需要，写进“明确不支持”；如果需要，先设计文件锁/独立 socket，不要在当前单 socket 上硬叠。

---

## 10. 复现与证据

### 10.1 测试命令

```bash
cd /Users/taishuo/projects/dsh-chrome
node test/browser-contexts.mjs
node test/headless-contexts.mjs
node test/context-viewer.mjs
node test/artifact-store.mjs
node test/chrome-verify.mjs
node test/headless-login.mjs
node test/install-platform.mjs
```

本次结果：全部 PASS。全量 `npm test` 未在本次运行；以仓库 CI/README 的 38 个测试文件为准。

### 10.2 本次探针（2026-10-19）

| 探针 | 输入 | 结果 |
|---|---|---|
| 登录接线 | `new HeadlessContextRouter({manager}).loginStart` | `undefined` |
| 并发上限 | `maxContexts=2`，4 个并发 `create` | 4 个 ok；`active=4` |
| 同 owner 并发 | 2 个并发 `router.request(owner:"same")` | `active=2` |
| named 并发 | 2 个并发 `profileName:"same"` | 2 个 ok；两个 context 同 profileId |
| profile 名逃逸 | `profileName:".."` | `profileDir=$DSH_HOME/cache/dsh-chrome` |
| 创建失败 | `createDriver` 抛错 | `active=0`；profiles 下残留 ephemeral 目录 |
| 两 context 基线 | 2 个真实 sandbox，无 tab | 各 7 进程；RSS 770/730MB；启动约 4.0s |

探针使用临时 `DSH_HOME`/temp 目录，未触碰真实用户 profile；代码未改动。

---

## 11. 附：建议的接口变更清单（按阶段）

| 文件 | 阶段 | 变更 |
|---|---|---|
| `src/contexts.js` | A | pending/owner mutex/profile reserve；state/inflight；crash；close timeout；profile 名校验；per-owner 上限（可选） |
| `src/headless-contexts.js` | A | `beginRequest/endRequest`；engine 透传；crash 错误码 |
| `src/headless.js` | A/B | `onExit`；`engine/executable` 参数；清 stale tab；close timeout；`availableEngines()` |
| `src/headless-launch.js` | B | 保持参数表；如需 engine 差异，用显式分支，不要塞隐式全局 |
| `src/config.js` | A/B | 接 `headless.chromeExecutable`/`viewport`；`browser.engine`；`maxArtifactBytes` 执行；`externalAgents` 删除或使用 |
| `src/tools-context.js` | A/B | `viewer contextId`；`engine`；`restart`（可选） |
| `src/tools-login.js` | A | 改注入 `contexts`/`ownerOf`，或移除工具 |
| `src/context-viewer.js` | A | viewer 活动 touch；可选 owner 校验；多 context URL |
| `src/tools-verify.js` | A | 拒绝 visible context（或明确允许）；engine 写报告 |
| `src/tools-media.js` | A | `chrome_shots` 扫描 per-context |
| `src/tools-screencast.js` | A | per-context screencast 路径/状态 |
| `src/backend.js` | A/C | `headlessInfo` 修 profile/running；桌面 engine 路由 |
| `src/bridge.js` | C | 多 client registry；hello engine；独立 pending/心跳 |
| `src/install.js` | C | 多浏览器安装循环；per-engine launcher 环境 |
| `src/platform.js` | B | 作为 engine 候选的唯一来源；补 PATH/X_OK 辅助（或放 `engines.js`） |
| `src/engines.js`（新增） | B | engine 探测/选择/状态 |

---

**最后一句**：本文的目标不是把现状说得悲观，而是把“已落地的基础”和“还不能承诺的能力”分开。阶段 A 的收益最大：它不需要新引擎，只修并发/生命周期/登录/产物隔离，就能让“多沙盒实例”从 demo 变成可依赖的能力；多引擎和 Safari 应该在其后按阶段推进。


## 附：0.2.15 已修（Q34）

- `BrowserContextManager.create` 增加 pending 预留，`maxContexts` 并发不超限；
- 同一 owner 并发 create 复用进行中 context；
- named profile 并发创建原子拒绝 `PROFILE_IN_USE`；失败回滚 profile/槽位/预留；
- `chrome_headless_login` 接到 active context 的 driver（无 active → `NO_ACTIVE_CONTEXT`）；
- 新增 16 并发/同 owner 去重/profile 互斥/失败回滚测试。

多引擎（Edge/Brave/Windows 桌面）与 Safari 仍未实现，仍按本文 B/C/D 阶段。

## 附：headless 多引擎候选 MVP（2026-10-19，`feat/multi-engine`）

**已实现（只到可执行文件解析/选择）**

- `src/headless-browsers.js`：复用 `src/platform.js` 的 4 浏览器 × 3 平台候选表，解析 Chrome / Chromium / Microsoft Edge（`msedge`）/ Brave；Linux 裸命令名按 `PATH` 查找，Windows 路径由 `%PROGRAMFILES%` 等变量展开，mac/win 均为表内绝对路径。
- 选择来源：`DSH_HEADLESS_ENGINE=chrome|chromium|edge|brave`、`DSH_HEADLESS_CHROME`（显式路径）、config `browser.engine` / `browser.headless.chromeExecutable`；环境变量覆盖 config。
- 显式指定但不存在时报 `HEADLESS_EXECUTABLE_NOT_FOUND`（错误里列出候选路径），未知引擎报 `HEADLESS_ENGINE_UNKNOWN`；**不会**静默回退到 Chrome。
- 未指定时保持旧行为：Chrome → Chromium；两者都不存在时返回 null（`headlessSupported()` 为 false）。
- 解析结果接到 `HeadlessDriver`（含交互登录窗口），provider 启动时一次性判定；测试 `test/headless-browsers.mjs` 已接入 `npm test`。

**未做**

- 未启动真实 Edge/Brave/Chromium 或 Windows 浏览器做冒烟；本阶段只做解析/选择。
- 没有 per-context engine（`chrome_context create {engine}`）、`availableEngines()`、`chrome_status` 的 engine/实际路径字段；engine 目前是 provider 级配置。
- 桌面多引擎（bridge 多 client、安装器多浏览器、`chrome_browsers`）仍按 §3.5 / 阶段 C，未做。
- Safari 未做（阶段 D）。
