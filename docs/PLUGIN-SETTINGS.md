# 插件设置设计（PLUGIN-SETTINGS）

> 状态：**MVP 已实现，未在真实 DSH 安装验证**。2026-10-19 · 分支 `feat/settings-mvp` · 基线 provider/扩展 `0.2.15`（`fd846bb`）。
>
> 范围：`dsh-desktop-chrome` provider 的用户可配置项，以及它与 DSH 插件设置页、扩展 popup、配置文件、环境变量的边界。
>
> 已落地（本地）：`src/settings.js` 字段表、`src/config-schema.js` 的 `Config`（4 个 volatile 字段）、`index.js` 导出 `Config` / 读取 `configEditor` override / 监听 `loader/volatile-update`、project 级危险键过滤、`contexts` 与 `ArtifactStore` 的实时读取；`test/settings.mjs` 覆盖 schema、合并与危险键。`npm test` 全绿。
>
> 另用本机安装的 DSH desktop runtime 0.2.1-rc.2 自带的 `@deepseek-ai/schemastery` 3.18.5 离线重建过 `Config.toJSON()` 并跑通 `volatileForm` / `resolveConfig`，但**没有**在运行中的 DSH 里安装过本分支。
>
> **未验证**：真实 DSH 安装中的 Plugins 自动页是否出现并可写、`Config.listConfigs` 的 JSON Schema 投影、profile patch 写入与 `loader/volatile-update` 的时序；`chrome_config` 仍未改。发布前按 §6.5 手工验收逐条走一遍。

## 0. 结论先行

1. **MVP 已有代码，但还没有在真实 DSH 安装里验证。** 本分支导出 `Config`（4 个 volatile 字段）并让 `apply(ctx, config)` 接收配置；真实 DSH 的 `Config/listConfigs` 是否显示 `status: "schema"`、Plugins 自动页是否出现，仍需按 §6.5 验收。provider 侧其余设置仍落在三份 JSON 配置（canonical / legacy / project）、`policy.json` 和一批环境变量里；扩展侧还有一个 `chrome.storage.local` 的侧边栏 URL。
2. **推荐路径：DSH 插件条目配置做唯一“用户设置”入口，DSH 自动设置页只放可实时生效的低风险项；危险项在 MVP 仍只走配置文件/DSH 条目 patch。** 不新建扩展设置页，不写大 UI，不复制一套设置存储。
3. **MVP 的最小闭环**是：新增 `Config` schema + `apply(ctx, config)`，让 DSH 自动生成一个只含低风险 volatile 字段的设置页（本分支先收 4 个：`browser.preset` / `browser.maxContexts` / `browser.idleTimeoutMs` / `verification.artifactRetentionRuns`）；其余选项继续由配置文件承载，用 `chrome_config` 只读工具和文档解释。若实测 DSH 自动页对该 bundle 不出现，MVP 退回“配置文件 + 文档 + `chrome_config`”，不发布半成品 UI。
4. **安全不变量不设置化**：evaluate/capture/upload/login 的硬确认、抓包不采 headers、脱敏、loopback+token、受保护 scheme、10 分钟抓包上限，这些都不做“关闭开关”。
5. **必须先修“假配置”**：`verification.screenshotFormat`、`verification.captureConsole`、`verification.captureNetwork`、`verification.maxArtifactBytes`、`browser.headless.chromeExecutable`、`browser.headless.viewport`、`browser.shared.requireLease`、`externalAgents.*`、`safety.allowedOrigins` 目前要么完全没接线，要么只在文档里存在。设置设计不能把这些包装成“已经可调”。

---

## 1. 现状盘点

### 1.1 现在到底有几个配置入口

| 入口 | 路径 | 读它的代码 | 现在的作用 | 状态 |
|---|---|---|---|---|
| 用户级“canonical”配置 | `~/.dsh/config.json` | `src/config.js:loadConfig` | `browser` / `verification` / `update` / `safety` 等 | 生效，但和 DSH 自己的 profile 配置不是一回事 |
| 旧 provider 配置 | `~/.dsh/cache/dsh-chrome/config.json` | `loadConfig`（作为最低层）**以及** `src/policy.js:readProviderConfig`（直接读） | `allowEvaluate` / 两个确认超时 | 生效；但 `loadConfig` 会把它不认识的顶层键当 unknown 警告 |
| 项目级覆盖 | `<cwd>/.dsh-chrome/config.json` | `loadConfig` | 覆盖 `browser.preset`、`maxContexts`、`verification.*` 等 | 生效，且优先级最高；没有“安全字段取更严格者”的规则 |
| DSH 插件条目配置 | `~/.dsh/profiles/<profile>/cordis.patch.yml` 中 `id: dsh-chrome` 的 `config:` | **当前没人读** | 无 | 不存在 |
| 站点策略 | `~/.dsh/cache/dsh-chrome/policy.json` | `src/policy.js:loadPolicy`，每个写动作查一次 | `origins[origin] = allow \| ask \| block` | 生效；文件只由人编辑，工具不写 |
| 扩展本地设置 | `chrome.storage.local` 的 `dshSidePanelUrl` | `extension/sidepanel.js` | 侧边栏嵌入的 DSH Web 地址 | 生效；属于扩展，不属于 provider |
| 环境变量 | `DSH_HEADLESS_*`、`DSH_CHROME_UPLOAD_ROOTS`、`DSH_OPERATION_LOG_MAX_BYTES`、`DSH_AUDIT_MAX_BYTES` 等 | `src/headless.js`、`src/tools-input.js`、`src/operation-log.js`、`src/policy.js` | 启动路径、并发、日志上限、上传白名单 | 生效；没有 GUI，没有 JSON schema |
| 运行时状态 | `update.json`、`*-token`、`artifacts/`、`profiles/` | `src/update.js`、`src/liveview.js`、`src/context-viewer.js`、`src/artifact-store.js` | 不是设置，是状态/凭据/产物 | 不应进设置 UI |

`loadConfig` 的合并顺序（`src/config.js:131-148`）：

```text
DEFAULT_CONFIG
  < ~/.dsh/cache/dsh-chrome/config.json   （legacy-user）
  < ~/.dsh/config.json                    （user）
  < <cwd>/.dsh-chrome/config.json         （project，最高）
```

`allowEvaluate` / `evaluateConfirmTimeoutMs` / `captureConfirmTimeoutMs` **不在这个合并里**：`index.js:144-150` 又单独把 `~/.dsh/cache/dsh-chrome/config.json` 读成一个 `providerConfig`，在 `index.js:218` 作为 `config()` 注入给工具。也就是说同一个文件被读了两遍，两套过滤规则。

### 1.2 字段实际使用情况（重要：不少字段是“假配置”）

| 键 | 默认值 | 实际消费者 | 真实状态 |
|---|---|---|---|
| `browser.preset` | `sandbox` | `src/contexts.js:67`（`create` 时） | ✅ 生效 |
| `browser.maxContexts` | `4` | `src/contexts.js:37,66` | ✅ 生效（构造时缓存） |
| `browser.idleTimeoutMs` | `300000` | `src/contexts.js:38,166` | ✅ 生效（构造时缓存） |
| `browser.profilesDir` | `null` | `src/contexts.js:39` | ✅ 生效 |
| `browser.headless.chromeExecutable` | `null` | 无 | ✅ 0.2.17 起接线；也可用 `DSH_HEADLESS_CHROME`/`DSH_HEADLESS_ENGINE`，优先级见 headless-browsers |
| `browser.headless.viewport` | `1440x900` | 无 | ⚠️ **未接线**；`HeadlessDriver` 的 `windowSize` 走构造参数，`index.js:69-77` 没传 |
| `browser.shared.enabled` | `false` | `index.js:228` → `wrapToolsForBackend({leaseRequired})` | ✅ 只控制“隐式写 lease”，**不等于 collab 可用** |
| `browser.shared.requireLease` | `true` | 无 | ⚠️ **未接线**，且语义误导（见 §1.4） |
| `verification.screenshotFormat` | `png` | 无 | ⚠️ **未接线** |
| `verification.captureConsole` | `true` | 无 | ⚠️ **未接线** |
| `verification.captureNetwork` | `metadata` | 无 | ⚠️ **未接线**；不要和 `chrome_capture_*` 的抓包混淆 |
| `verification.artifactDir` | `null` | `index.js:62` | ✅ 生效 |
| `verification.maxArtifactBytes` | `52428800` | 无 | ⚠️ **未接线** |
| `verification.artifactRetentionRuns` | `50` | `index.js:63` → `ArtifactStore` | ✅ 生效（构造时缓存） |
| `externalAgents.claude.preset` | `debug` | 无 | ⚠️ **未接线** |
| `externalAgents.codex.preset` | `debug` | 无 | ⚠️ **未接线** |
| `update.enabled` | `false` | `src/update.js:89-134` | ✅ 生效 |
| `update.autoInstall` | `false` | `src/update.js:169-205` | ✅ 生效（仅 Windows host exe） |
| `update.channel` | `stable` | `src/update.js:155` | ✅ 生效 |
| `update.checkIntervalHours` | `24` | `src/update.js:129` | ✅ 生效 |
| `update.repository` | `TaiShuo150622/dsh-chrome` | `src/update.js:149` | ✅ 生效 |
| `safety.allowedOrigins` | `null` | 无 | ⚠️ **未接线** |
| `allowEvaluate` | `false` | `src/tools.js:109`、`src/tools-misc.js:293` | ✅ 生效（决定工具是否注册） |
| `evaluateConfirmTimeoutMs` | `120000` | `src/tools.js:110-112` | ✅ 生效（工具构造时缓存） |
| `captureConfirmTimeoutMs` | `120000` | `src/tools.js:113-115` | ✅ 生效（工具构造时缓存） |
| `policy.json` 的 `origins` | 空（全部 follow-dsh） | `src/tools.js:281-320` | ✅ 生效，每个写动作现读 |

另外：

- `chrome_verify` 的 `options.screenshotOnFailure` / `captureConsole` / `captureNetwork` 在 schema 里存在（`src/tools-verify.js:21-27`），但 `execute` 只取了 `args.options`（`src/tools-verify.js:215`）却没使用；`verification.*` 也没有喂给它。
- `chrome_config`（`src/tools-status.js:171-195`）只读 `~/.dsh/cache/dsh-chrome/config.json`，看不到 `~/.dsh/config.json` 里的 `browser/verification/update`，也看不到 DSH 条目配置。
- `docs/CONFIG.md:3-12` 只列了三个 provider 键；`docs/CONTEXTS.md` 又展示了 `browser.headless.chromeExecutable` / `viewport`，但这两项没有接线。文档比实现“超前”。

### 1.3 不能被设置化的安全不变量

下面这些是产品边界，不建议做成“可选关闭”：

- `chrome_evaluate`：默认不注册；开启后**每次调用**都走 `ctx.userQuestions` 硬确认，不受会话 `danger-full-access` 影响；子代理 fail-closed（`src/tools-misc.js:243`、`src/tools.js:325-380`）。
- `chrome_capture_start`：**每次**硬确认，没有配置旁路；`captureConfirmTimeoutMs` 只控制等待上限（`src/tools.js:116`、`src/tools-capture.js:59`）。
- `chrome_upload` / `chrome_headless_login`：每次硬确认；上传还先过路径白名单（`src/tools-input.js:24-75`、`src/tools-login.js:13`）。
- 抓包：**不采 headers**；URL secret 参数、JSON/form secret key、Bearer/JWT/sk-/AKIA 字符串脱敏；响应 4096 / 请求 2048 字符，单 capture body 总量 8 MiB；10 分钟自动停（`src/headless-redact.js:11-16`、`src/headless.js:103`、`extension/background.js` 同源实现）。
- 操作日志：按键名脱敏、URL 去 userinfo/secret 参数、结果走 allowlist；单行 2048 bytes，默认 4 MiB 轮转（`src/operation-log.js:26-30,233-234`）。
- viewer：loopback only + token；per-context `access` capability；不暴露 CDP；输入 kind 白名单（`src/context-viewer.js:24-34,56-79`）。
- 受保护 scheme：只允许 `http(s)` / `about:blank`；`file:` / `data:` / `javascript:` / `chrome:` 拒绝（`src/tools.js:55-69`、`src/headless.js` 同层）。
- 可见 context 不参与空闲回收（`src/contexts.js:165`）。

这些不改，不是因为“做不成开关”，而是因为关掉之后是另一个安全模型。

### 1.4 已发现的问题（设置设计必须先处理）

1. **假配置误导用户**：`verification.*` 大半、`browser.headless.*`、`safety.*`、`externalAgents.*`、`shared.requireLease` 字段存在但不生效。用户改完后没有任何反馈。
2. **provider 配置双读**：`loadConfig` 把 `allowEvaluate` 当 unknown key 警告，`readProviderConfig` 又把它当合法键；两边没有共同 schema。
3. **`chrome_config` 只覆盖一小半配置**：看不到 `browser`/`verification`/`update`，也没有“这个值来自哪个文件”的信息。
4. **项目配置能放松安全**：项目级 `.dsh-chrome/config.json` 目前可以设置 `browser.shared.enabled`，未来如果加 `allowEvaluate` 也会被项目级打开。克隆一个仓库就能改变本机浏览器的审批/共享行为，不可接受。
5. **版本不匹配会整份回退**：`src/config.js:81-84` 只要任何一层 `version !== 1` 就 `return clone(DEFAULT_CONFIG)`，项目覆盖也一起丢；而 `version > 1` 没有向前兼容策略。
6. **类型校验偏松**：`merge` 只接受原始类型，`sanitize` 只对部分数字做范围检查；`update.enabled = "yes"` 会被存成字符串，最后 `Boolean(...)` 变成 true。
7. **没有变更通知**：设计时 `loadConfig` 只在 `apply` 时跑一次；`providerConfig` 也在 `index.js` 只读一次。MVP 已补 `loader/volatile-update` 重读 volatile 字段，但非 volatile 项与手工改文件仍需重载 provider；仍没有文件 `watch`。
8. **文档承诺了不存在的设置**：`docs/APPROVAL.md` 的 `approval.mode` / `balanced` / `strict` 尚未进 `config.js`；`chrome_config` 的 description 还写着 “capture confirmation mode”，但抓包确认从 0.1.76 起固定 hard。
9. **`browser.shared.requireLease` 语义反了**：名字像“是否要求 lease”，但代码只认 `browser.shared.enabled`；`shared.enabled: true` 时隐式 lease 一定启用（`src/backend.js:202`、`src/tool-guards.js:24-47`），`requireLease: false` 不会关掉它。
10. **`collab` 仍不可用**：`src/contexts.js:68-70` 对 `collab` 直接抛 `UNSUPPORTED_MODE`；`shared.enabled` 只影响 lease 门控，不要把两者混成一个“共享浏览器”开关。

---

## 2. 设计原则

1. **唯一用户设置源**：DSH 插件条目配置（profile patch 里 `dsh-chrome` 的 `config:`）是新的 canonical 用户设置。旧的 `~/.dsh/config.json` 和 `~/.dsh/cache/dsh-chrome/config.json` 作为兼容层保留一个版本周期。
2. **默认安全、危险项显式 opt-in**：所有会扩大数据外发、代码执行、审批绕过、自动更新、共享浏览器的选项默认关闭；项目级配置不能打开它们。
3. **只把真正实时的字段标成 volatile**：DSH 设置页只允许编辑 `Config` 里 `.volatile()` 的字段；非 volatile 字段需要重载 provider。不能为了让 UI 好看，把“其实要重启”的字段标成实时。
4. **不在设置里放秘密**：插件配置不应出现密码/API key/token。DSH 的 `role('secret')` 只用于未来真的需要凭据的设置；本插件目前没有。
5. **MVP 不写大 UI**：不新增扩展设置页、不新增客户端 bundle、不改 native messaging 协议。用 DSH 生成的表单 + 配置文件 + 只读诊断。
6. **文档必须说真话**：字段要么接线，要么标“尚未生效”，要么删除；不能继续让 `docs/CONTEXTS.md` 的示例看起来像已实现。
7. **设置变更可审计**：只记录键名/来源/时间，不记录值；危险项变更写 `audit.jsonl`。

---

## 3. 设置项矩阵

> 图例：**现状** ✅ 已生效 / ⚠️ 未接线 / 🆕 建议新增 / 🗑 建议删除或合并。
> **GUI**：✅ 适合 MVP 自动页（必须能实时生效）/ ⚠️ 适合未来自定义页（需 reload 或需要风险文案）/ ❌ 只走文件或环境变量。
> **目标生效**：实时 = 下一次调用即生效；provider reload = 重载插件条目（会关闭当前浏览器 context）；DSH restart = 重启应用。
>
> “GUI ✅”只说明这个字段适合自动页，不代表它已经在自动页里；MVP 自动页只放 §5.2 的 volatile 字段（本分支先 4 个）。

生效动作对照：

| 动作 | 影响 | 什么时候需要 |
|---|---|---|
| **实时** | 下一次调用读到新值；不重启 | DSH `.volatile()` 字段 |
| **provider reload** | 重载本插件条目：bridge、contexts、viewer 路由重建；当前 headless/可见 context 会关闭；扩展不重载 | 工具注册、构造时缓存、路由生命周期、update checker 等 |
| **扩展 reload** | 只重载 MV3 Service Worker/页面脚本；不影响 provider 配置 | 扩展代码/popup 改动，不是设置项 |
| **DSH restart** | 整个应用重启；native messaging manifest 重新读取 | 只有 manifest/安装路径变化才需要，普通设置不需要 |
| **Chrome restart** | 重读 native messaging manifest | 安装/浏览器路径变化，不是设置项 |

### 3.1 浏览器与 context

| 键 | 默认值 | 类型 / 范围 | 风险 | GUI | 目标生效 | 现状 |
|---|---|---|---|---|---|---|
| `browser.preset` | `sandbox` | enum `sandbox \| sandbox-persistent \| debug` | 中（`debug` 会开可见窗口） | ✅ 自动页 | 实时（只影响新 context） | ✅ 需读取 volatile |
| `browser.maxContexts` | `4` | int 1–16 | 低（资源） | ✅ 自动页 | 实时（只影响新建） | ✅ 构造时缓存，需小改 |
| `browser.idleTimeoutMs` | `300000` | int 10000–3600000 | 低 | ✅ 自动页 | 实时 | ✅ 构造时缓存，需小改 |
| `browser.profilesDir` | `null` | 绝对路径 / null | 中（写盘位置） | ❌ 文件 | provider reload | ✅ |
| `browser.headless.chromeExecutable` | `null` | 绝对路径 / null | **高**（任意可执行文件） | ❌ 文件 | provider reload | ⚠️ 未接线 |
| `browser.headless.viewport` | `1440×900` | width 200–7680，height 200–4320 | 低 | ⚠️ 未来页 | 实时（新 context）/当前需 reload | ⚠️ 未接线 |
| `browser.shared.enabled` | `false` | bool | **高**（跨会话写冲突/共享） | ❌ 危险（MVP 文件） | provider reload | ✅ 只控 lease |
| `browser.shared.leaseTtlMs` | `60000` | int 1000–900000（max 15 min） | 中 | ⚠️ 未来页（显式 lease 也用它） | provider reload | 🆕 未实现 |
| `browser.shared.requireLease` | `true` | bool | — | ❌ | — | 🗑 删除（误导，且未接线） |

> 当前 `PRESETS` 里还有 `collab`（`src/config.js:12`），但 `contexts.create` 会抛 `UNSUPPORTED_MODE`（`src/contexts.js:68-70`）。建议新 schema 的 `browser.preset` 枚举只暴露 `sandbox / sandbox-persistent / debug`，等 collab 真正实现再加。

### 3.2 验证与产物

| 键 | 默认值 | 类型 / 范围 | 风险 | GUI | 目标生效 | 现状 |
|---|---|---|---|---|---|---|
| `verification.screenshotFormat` | `png` | enum `png \| jpeg` | 低 | ✅ 自动页（接线后） | 实时 | ⚠️ 未接线 |
| `verification.captureConsole` | `true` | bool | 中（console 可能含敏感数据） | ✅ 自动页（接线后） | 实时 | ⚠️ 未接线 |
| `verification.captureNetwork` | `metadata` | enum `off \| metadata \| bodies` | 中（bodies 可能含敏感数据） | ⚠️ 未来页（接线后） | 实时 | ⚠️ 未接线 |
| `verification.artifactDir` | `null` | 绝对路径 / null | 低 | ❌ 文件 | provider reload | ✅ |
| `verification.maxArtifactBytes` | `52428800` | int 1 MiB–2 GiB | 低（磁盘） | ⚠️ 未来页（接线后） | 实时 | ⚠️ 未接线 |
| `verification.artifactRetentionRuns` | `50` | int 1–1000 | 低（磁盘） | ✅ 自动页 | 实时 | ✅ 构造时缓存，需小改 |

### 3.3 evaluate / capture

| 键 | 默认值 | 类型 / 范围 | 风险 | GUI | 目标生效 | 现状 |
|---|---|---|---|---|---|---|
| `allowEvaluate` | `false` | bool | **高**（页面内任意 JS） | ❌ 危险（MVP 文件） | provider reload（工具注册） | ✅ |
| `evaluateConfirmTimeoutMs` | `120000` | int 1000–600000 | 低 | ✅ 自动页 | 实时 | ✅ 构造时缓存，需小改 |
| `captureConfirmTimeoutMs` | `120000` | int 1000–600000 | 低 | ✅ 自动页 | 实时 | ✅ 构造时缓存，需小改 |
| `capture.storeBodiesByDefault` | `true` | bool | **中高**（body 可能含敏感数据） | ⚠️ 未来页（接线后） | 实时 | 🆕 当前是工具参数默认 true |
| `capture.confirmMode` | `hard`（固定） | 不可配置 | — | ❌ | — | ✅ 不是设置，别加 |

> `chrome_capture_*` 的“确认”与 `verification.captureNetwork` 是两件事：前者是抓包工具，后者（如果接线）只影响 `chrome_verify` 的产物。

### 3.4 viewer / 日志 / 脱敏

| 键 | 默认值 | 类型 / 范围 | 风险 | GUI | 目标生效 | 现状 |
|---|---|---|---|---|---|---|
| `viewer.enabled` | `true` | bool | 中（loopback 页面可被本机进程看到） | ⚠️ 未来页（需 reload） | provider reload（路由生命周期） | 🆕 当前总是注册 |
| `viewer.screencastIdleTimeoutMs` | `300000` | int 10000–3600000 | 低 | ✅ 自动页（接线后） | 实时 | 🆕 当前常量 5 min |
| `operationLog.enabled` | `true` | bool | 低（审计） | ⚠️ 未来页（审计项，建议不进自动页） | 实时 | 🆕 当前总是写 |
| `operationLog.maxBytes` | `4194304` | int 1 MiB–256 MiB | 低（磁盘） | ⚠️ 未来页 | 实时 | 🆕 当前只认 `DSH_OPERATION_LOG_MAX_BYTES` |
| `redaction.extraSecretKeys` | `[]` | string[]（键名，不是正则） | 中（只加不减；写错会漏脱敏） | ⚠️ 未来页（接线后） | 实时 | 🆕 当前固定 |
| `redaction.weaken` | — | 不存在 | — | ❌ | — | ✅ 永不提供 |

### 3.5 自动更新

| 键 | 默认值 | 类型 / 范围 | 风险 | GUI | 目标生效 | 现状 |
|---|---|---|---|---|---|---|
| `update.enabled` | `false` | bool | 中（会发 GitHub API 请求） | ⚠️ 未来页（可选，默认关；需 reload） | provider reload | ✅ |
| `update.channel` | `stable` | enum `stable \| preview` | 中（preview 可能不稳定） | ⚠️ 未来页 | provider reload | ✅ |
| `update.checkIntervalHours` | `24` | int 1–168 | 低 | ⚠️ 未来页 | provider reload | ✅ |
| `update.autoInstall` | `false` | bool | **高**（自动替换 host exe） | ❌ 危险（MVP 文件） | provider reload | ✅ 仅 Windows |
| `update.repository` | `TaiShuo150622/dsh-chrome` | `owner/repo` | 中（供应链） | ❌ 文件 | provider reload | ✅ |

> 这里的 update 是 **GitHub Release 检查**（provider + Windows host exe），不是扩展开发期的 `dev.json` 自动 reload。后者由 native host watcher 完成，popup 只显示状态，没有设置项；两者不要混。

### 3.6 安全 / 上传 / 站点策略

| 键 | 默认值 | 类型 / 范围 | 风险 | GUI | 目标生效 | 现状 |
|---|---|---|---|---|---|---|
| `safety.allowedOrigins` | `null` | string[] / null | 高（如果实现成“允许列表”，写错会封死） | ❌ 文件 | 实时（每次导航） | ⚠️ 未接线 |
| `policy.origins`（`policy.json`） | `{}` | map `origin -> allow \| ask \| block` | **高**（`allow` 绕过审批） | ❌ MVP；后续站点编辑器 | 实时（每个写动作现读） | ✅ |
| `upload.extraRoots` | `[]` | 绝对路径[] | **高**（文件外发） | ❌ 危险（MVP 文件） | 实时 | 🆕 当前只有 `DSH_CHROME_UPLOAD_ROOTS` |
| `externalAgents.claude.preset` | `debug` | enum | — | ❌ | — | 🗑 未接线 |
| `externalAgents.codex.preset` | `debug` | enum | — | ❌ | — | 🗑 未接线 |

> `policy.json` 的 `ask` 会覆盖 `danger-full-access` 的自动放行（`src/tools.js:312-319`）；`allow` 只跳过普通审批，upload/evaluate/capture/login 等硬敏感动作仍每次确认。

### 3.7 仅环境变量、不建议进设置页的项

| 变量 | 默认 | 作用 | 为什么不进 UI |
|---|---|---|---|
| `DSH_HEADLESS_CHROME` | 自动探测 | headless Chrome 路径 | 与 `browser.headless.chromeExecutable` 重复；先合并再谈 UI |
| `DSH_HEADLESS_CHROME_ARGS` | 空 | 追加 Chrome 启动参数 | **危险**（任意开关）；CI/实验用 |
| `DSH_HEADLESS_IDLE_MINUTES` | `5` | headless tab 空闲 | 和 `browser.idleTimeoutMs` 语义不同（tab vs context） |
| `DSH_HEADLESS_MAX_TABS` | `12` | 单 driver 最大 tab | 高级；可用配置替代后再迁移 |
| `DSH_HEADLESS_SHOT_STREAM` / `_JPEG_CROP` / `_VISUAL_PROBE` 等 | 开 | 性能实验开关 | 诊断/性能用，不是用户偏好 |
| `DSH_AUTO_POINTER` | `0` | 虚拟光标自动跟随 | 演示用 |
| `DSH_CHROME_UPLOAD_ROOTS` | 空 | 上传额外根目录 | 危险；先做成 `upload.extraRoots` 再决定 GUI |
| `DSH_AUDIT_MAX_BYTES` | 5 MiB | 审计日志轮转 | 运维项 |
| `DSH_OPERATION_LOG_MAX_BYTES` | 4 MiB | 操作日志轮转 | 由 `operationLog.maxBytes` 取代 |
| `DSH_UPDATE_STATE_HEARTBEAT_MS` | 600000 | host 更新状态心跳 | 诊断项 |

---

## 4. 建议的“可选项目”分组与默认值

先给结论：

- **默认开启 = 保持现状**：`viewer.enabled`、`operationLog.enabled`、`verification.captureConsole`、`capture.storeBodiesByDefault`（当前工具默认），以及所有硬确认/脱敏/审计不变量。
- **默认关闭 = 所有会扩大权限、数据面或网络的开关**：`allowEvaluate`、`browser.shared.enabled`、`update.enabled`、`update.autoInstall`、`upload.extraRoots`、`browser.headless.chromeExecutable`、`safety.allowedOrigins`、`redaction.extraSecretKeys`（空数组）。
- 数值/枚举项（如 `maxContexts`、`idleTimeoutMs`、`artifactRetentionRuns`）保持当前默认值，不因为“放进设置”而改变行为。

### 4.1 基础组（默认开启 / 保持现状，低风险）

> 分组按“默认值 + 风险”划分，不等于 MVP 自动页会显示；自动页只显示 §5.2 的 volatile 字段（本分支先 4 个）。下面有些项（如 `viewer.enabled`）默认开但需要 reload，因此 MVP 仍走文件/条目 patch。

| 项 | 默认 | 说明 |
|---|---|---|
| `viewer.enabled` | **开** | 保持当前行为：Host 有 `webServer` 就注册 loopback viewer；关闭后不注册路由 |
| `operationLog.enabled` | **开** | 保持当前审计能力；关闭只影响本地操作日志，不影响抓包审计 |
| `verification.captureConsole` | **开** | 接线后 `chrome_verify` 默认收集 console；可在单次调用里覆盖 |
| `verification.captureNetwork` | `metadata` | 只采 method/URL/status/timing，不采 headers；`bodies` 仅在高级显式选 |
| `capture.storeBodiesByDefault` | **开** | 保持当前 `storeBodies` 默认 true；单次调用可传 `false` 覆盖 |
| `verification.artifactRetentionRuns` | `50` | 保留最近 50 次验证产物 |
| `evaluateConfirmTimeoutMs` | `120000` | 只改等待上限，不改变“必须确认” |
| `captureConfirmTimeoutMs` | `120000` | 同上 |

> 这里的“默认开启”是**保持现状**，不是新增能力。尤其是 viewer/operationLog/capture bodies，当前没有开关，代码默认就是开着。

### 4.2 高级组（默认值不变；用户主动改才生效）

| 项 | 默认 | 说明 |
|---|---|---|
| `browser.headless.viewport` | `1440×900` | 先接线，再放进高级页；只影响新 context |
| `verification.screenshotFormat` | `png` | 先接线；`jpeg` 更小、有损 |
| `verification.maxArtifactBytes` | `50 MiB` | 先接线；超过时截断/拒绝要写清楚 |
| `operationLog.maxBytes` | `4 MiB` | 取代环境变量；轮转行为不变 |
| `redaction.extraSecretKeys` | `[]` | **只加**键名，不允许删默认规则；写错会漏脱敏，所以放高级 |
| `viewer.screencastIdleTimeoutMs` | `300000` | 无人看帧后自动停 screencast |
| `browser.shared.leaseTtlMs` | `60000` | 显式 `chrome_lease` 也用它；`shared.enabled` 只决定是否对写动作隐式加锁；最大 15 min |

### 4.3 基础可选（默认关闭，用户主动开启）

| 项 | 默认 | 说明 |
|---|---|---|
| `update.enabled` | **关** | 开启后才检查 GitHub Release；关闭时 provider 不发起更新请求。默认关是隐私/网络边界，不是功能缺陷 |
| `update.channel` | `stable` | 只有开启了 `update.enabled` 才有意义；`preview` 包含 prerelease |
| `update.checkIntervalHours` | `24` | 开启更新后每 24h 检查一次 |

### 4.4 危险组（全部默认关闭；MVP 只走文件/DSH 条目 patch）

| 项 | 默认 | 打开后的后果 | MVP 入口 |
|---|---|---|---|
| `allowEvaluate` | **关** | 页面内任意 JS；可读 cookie/localStorage、发请求；仍每次硬确认 | 配置文件 / DSH 条目 patch |
| `browser.shared.enabled` | **关** | 跨会话对同一 tab 的写动作会互相 `LEASE_HELD`；不是 collab | 配置文件 / DSH 条目 patch |
| `update.autoInstall` | **关** | Windows 自动替换 host exe；校验 SHA-256 但仍属自动执行 | 配置文件 |
| `upload.extraRoots` | `[]` | 允许从会话目录外的路径上传；每次仍硬确认，但范围扩大 | 配置文件 |
| `browser.headless.chromeExecutable` | `null` | 指定任意可执行文件作为浏览器 | 配置文件 |
| `safety.allowedOrigins` | `null` | 若实现为允许列表，配置错误会封死导航；若实现为阻断列表，错误会放开 | 先决定语义，再谈入口 |
| `policy.origins` 的 `allow` | 无条目 | 跳过该站点的普通审批；硬敏感动作仍每次确认 | `policy.json`（后续可做站点编辑器） |

**危险项的统一规则：**

1. 默认关闭；不从 unknown / legacy / project 配置自动迁移为开启。
2. 不从项目级 `.dsh-chrome/config.json` 读取；出现就忽略并 warning。
3. 变更后需要 provider reload；`chrome_config` 返回 `reloadRequired: true` 和原因。
4. 如果将来做 GUI：必须有独立的风险说明 + 二次确认（建议要求输入 `enable` 或勾选“我理解…”），不能是一个普通 switch。
5. 变更写 `audit.jsonl`：只记键名、来源、时间，不记值。

---

## 5. 设置入口设计

### 5.1 四个入口的分工

| 入口 | 能做什么 | 不能做什么 | 结论 |
|---|---|---|---|
| **DSH 插件设置页**（由 `Config` schema 自动生成） | 渲染 `.volatile()` 的安全字段；写入 profile patch；带 revision/冲突检测 | 不能编辑非 volatile 字段；不能承载危险开关的风险文案；不能写站点策略 | **MVP 只用它承载基础/高级里的实时项** |
| **DSH 原生配置编辑器 / profile patch** | 编辑 `dsh-chrome` 条目的全部字段，包括危险项 | 手写 YAML；没有风险提示；改错要重载才发现 | **MVP 的危险项入口** |
| **扩展 popup** | 状态、Reconnect、Reload、Sidebar、self-heal/dev reload 显示 | 不能读 provider 配置；没有 native RPC 写配置；容易和 DSH 设置漂移 | **不加设置表单**；最多加一行静态提示 |
| **JSON 配置文件 / 环境变量** | 兼容层；项目级安全默认；CI/运维 | 无 schema UI；容易写错；`~/.dsh/config.json` 还和其他插件共享 | **保留一个版本周期，逐步迁移** |

此外：

- `chrome_config` 是**只读诊断工具**，不是设置页；它应该展示 effective value + source + reload 状态，而不是写配置。
- `chrome_policy` 是站点策略的**只读**查询；站点策略编辑器是后续独立功能（Phase 4），不要塞进通用设置页。
- DSH 的“设置 → 内置插件”页只是**只读清单**（`dsh-client-ui-settings-plugin-inventory`）；可配置的插件页在**侧栏 Plugins**（`dsh-client-ui-plugin-manager`），两者不要混。本文说的“DSH 插件设置页”指的是后者 / 由 `Config` 自动生成的配置页。

### 5.2 MVP 推荐形态（不做大 UI）

```text
DSH Web/Desktop
  └─ 侧栏 Plugins → dsh-desktop-chrome
       └─ 自动生成的设置表单（只有 volatile 字段）
            ├─ browser.preset
            ├─ browser.maxContexts
            ├─ browser.idleTimeoutMs
            ├─ verification.artifactRetentionRuns
            ├─ evaluateConfirmTimeoutMs
            └─ captureConfirmTimeoutMs
  └─ 其他设置：profile patch / 配置文件（文档 + chrome_config 指引）
```

> 实现状态：本分支的 `Config` 只收前 4 个 volatile 字段（`browser.preset` / `browser.maxContexts` / `browser.idleTimeoutMs` / `verification.artifactRetentionRuns`）。`evaluateConfirmTimeoutMs` / `captureConfirmTimeoutMs` 仍走旧 provider 文件，未进 `Config`；`update.*` 全部非 volatile，不进自动页。

- 不新增 `extension/` 页面。
- 不新增客户端 bundle / 构建链。
- 不改 native messaging 协议。
- 如果 DSH 自动页没有出现：**不发布半成品 UI**，Phase 1 仍交付 `Config` schema（给未来用）、`chrome_config` 增强和文档；在 `docs/CONFIG.md` 明确写“当前通过配置文件”。

### 5.3 DSH 接口与写法（具体到契约）

DSH 的插件配置契约（本机 DSH 0.2.x）：

- 插件导出 `Config`（schemastery schema）和 `apply(ctx, config)`；参考 `@deepseek-ai/dsh-client-hmr` 的 `export { Config, apply, inject, name }`。
- `@deepseek-ai/dsh-settings` 的 `SettingsForms.describe()` 只把 schema 里的 **volatile 字段**投影成可编辑表单；`write()` 对非 volatile 路径直接抛 `Config field "..." is not volatile`。
- `Config` 字段用 `.volatile()` 标记；运行时会以引用对象（`{ get(), [Symbol.for('cosmokit.volatile.write')] }`）的形式出现在 `config` 里，读值要用 `.get()`；更新事件是 `loader/volatile-update`。
- `configEditor` 服务提供 `configuration()` / `entries()` / `edit()`，负责把用户层写进 profile patch；插件不应自己改 `cordis.patch.yml`。
- `settings.configure({ auto: false })` 可以让某个条目不出自动页；MVP 不用，除非自动页质量不可接受。

可参考的本机实现：`@deepseek-ai/dsh-client-hmr`（`Config` + `apply(ctx, config)`）、`@deepseek-ai/dsh-agent-default-model`（volatile 字段 + `settings.configure({ auto: false })`）、`@deepseek-ai/dsh-settings`（`SettingsForms` 的 volatile 投影/写入契约）。

建议的完整 schema 形状（只示意；本分支只实现 §5.2 的 4 个 volatile 字段，且由本地窄 schemastery 协议实现，见 `src/config-schema.js`）：

```js
import z from '@deepseek-ai/schemastery'

export const Config = z.object({
  browser: z.object({
    preset: z.union(['sandbox', 'sandbox-persistent', 'debug']).default('sandbox')
      .description('新 context 的默认隔离模式；debug 会打开独立可见窗口。').volatile(),
    maxContexts: z.natural().min(1).max(16).default(4)
      .description('同时存在的浏览器 context 上限。').volatile(),
    idleTimeoutMs: z.natural().min(10_000).max(3_600_000).default(300_000)
      .description('不可见 context 空闲回收时间（毫秒）。').volatile(),
    headless: z.object({
      chromeExecutable: z.string().description('headless Chrome 绝对路径；留空自动探测。'),
      viewport: z.object({
        width: z.natural().min(200).max(7680).default(1440),
        height: z.natural().min(200).max(4320).default(900),
      }).description('新 headless context 的视口。'),
    }),
    shared: z.object({
      enabled: z.boolean().default(false)
        .description('危险：开启跨会话隐式写 lease；不是 collab。'),
      leaseTtlMs: z.natural().min(1_000).max(900_000).default(60_000),
    }),
  }),
  verification: z.object({ /* ... */ }),
  evaluate: z.object({
    enabled: z.boolean().default(false).description('危险：注册 chrome_evaluate；每次调用仍需硬确认。'),
    confirmTimeoutMs: z.natural().min(1_000).max(600_000).default(120_000).volatile(),
  }),
  capture: z.object({
    confirmTimeoutMs: z.natural().min(1_000).max(600_000).default(120_000).volatile(),
    storeBodiesByDefault: z.boolean().default(true).volatile(),
  }),
  update: z.object({ /* ... 全部非 volatile */ }),
})
```

> 注意：`allowEvaluate` 建议保留旧名做 alias，或迁移到 `evaluate.enabled`；无论用哪个名字，它都**不能**是 volatile——工具注册发生在 `apply` 时，改它必须重载。

依赖与版本：

- `package.json` 需要声明 `@deepseek-ai/schemastery`（与 DSH 同主版本，当前 `~3.18.4`）和 `@deepseek-ai/cosmokit`（`live()`/`isVolatile()` 用）；不要让插件打包第二份 schemastery，否则 DSH 的 `Config` 识别不到。
- 不引入 `zod` 作为第二套 schema 库；DSH 设置页只认 schemastery 的 `toJSON()`。
- `Config` 里不放 `version` 字段：`version` 只属于文件兼容层（`src/config.js`），DSH 条目配置不写版本号。

读取 volatile 的 helper：

```js
import { isVolatile } from '@deepseek-ai/cosmokit'

export function live(value, fallback) {
  if (isVolatile(value)) return value.get()
  return value === undefined ? fallback : value
}

// 每次调用时读，而不是在 chromeTools() 构造时读死：
const timeoutMs = live(config?.evaluateConfirmTimeoutMs, 120_000)
```

### 5.4 为什么非 volatile 字段不能在自动页里改

DSH 的自动表单只投影 volatile 字段；这不是 UI 限制，是写入契约：

- `SettingsForms.describe()` 用 `volatileForm(schema)`，只返回 volatile 子树；
- `SettingsForms.write()` 对每个编辑路径调 `isVolatilePath()`，非 volatile 直接拒绝。

所以：

- `allowEvaluate`、`browser.shared.enabled`、`update.*`、`update.autoInstall`、`chromeExecutable`、`viewer.enabled` 这类需要重载的字段，**MVP 不进自动页**。
- 如果一定要 GUI 改它们，需要 Phase 4 的“自定义设置页 + Host Remote 服务”，由服务调用 `configEditor.edit()`，并在写之前用 `ctx.userQuestions` 做硬确认。这不是“加一个 switch”那么简单。

### 5.5 扩展 popup 的边界

popup 现在只有状态和操作（`extension/popup.js`）：Connected、Extension、Session tab、Self-heal、Dev reload、Show tab / Reconnect / Reload / Sidebar。它**没有** provider 配置。

建议：

- 保持 popup 只做状态/诊断/重连；不加 evaluate、capture、shared、update 的表单。
- 可以加一行静态文案：“Provider settings: DSH → Plugins → DSH Desktop Chrome”（如果 DSH 的入口名稳定）。
- 侧边栏 URL 的 `dshSidePanelUrl` 继续留在 `chrome.storage.local`，它是扩展本地设置，不要并入 provider `Config`。
- 不为设置新增 native messaging RPC；popup 不写 host 配置文件。

### 5.6 配置文件与 `chrome_config` 的定位

- `~/.dsh/profiles/<profile>/cordis.patch.yml`：MVP 的危险项入口；用户手动编辑。
- `~/.dsh/config.json` / `~/.dsh/cache/dsh-chrome/config.json`：兼容层；Phase 2 起每次启动 warning，提示迁移。
- `<cwd>/.dsh-chrome/config.json`：只允许安全字段；项目级不能放松安全。
- `policy.json`：站点策略，继续人编辑；`chrome_policy` 只读。
- `chrome_config`：增强为“effective config + source + reloadRequired + 文件路径 + 警告”，例子：

```json
{
  "effective": {
    "browser": { "preset": "sandbox", "maxContexts": 4 },
    "allowEvaluate": false,
    "evaluateConfirmTimeoutMs": 120000
  },
  "sources": {
    "browser.preset": "entry",
    "allowEvaluate": "default",
    "evaluateConfirmTimeoutMs": "legacy-file"
  },
  "reloadRequired": [],
  "files": {
    "entry": "~/.dsh/profiles/desktop/cordis.patch.yml",
    "user": "~/.dsh/config.json",
    "legacy": "~/.dsh/cache/dsh-chrome/config.json",
    "project": "<cwd>/.dsh-chrome/config.json",
    "policy": "~/.dsh/cache/dsh-chrome/policy.json"
  },
  "warnings": []
}
```

不要返回 secret 值；不要返回完整页面/命令历史。

---

## 6. 配置校验、迁移、文档、测试

### 6.1 校验规则

建议抽一个 `src/config-schema.js`，让 DSH `Config` 和文件 loader 共用同一份字段描述，避免“schema 说 A、loader 做 B”。

| 检查 | 规则 | 失败行为 |
|---|---|---|
| 版本 | `version` 缺省视为 1；1→2 迁移；`> CONFIG_VERSION` 保留已知字段并 warning | 不整份回退 |
| 未知键 | 文件 loader 丢弃 + warning；DSH 条目按 schema 校验并报告 | 不静默 |
| secret-shaped key | 键名匹配 `password/secret/token/api_key/credential/private_key` 直接拒绝 + warning | 不读取值 |
| 布尔 | 必须是 `true/false`；字符串 `"true"` 不再接受 | 回退默认 |
| 枚举 | preset / channel / captureNetwork / screenshotFormat 白名单 | 回退默认 |
| 整数 | 范围检查；不允许浮点/NaN | 回退默认 |
| 路径 | `profilesDir` / `artifactDir` / `chromeExecutable` 必须是绝对路径；可执行文件检查 `X_OK` | 回退默认 + warning |
| URL/repository | `owner/repo` 正则；origin 只接受 `http(s)` origin | 回退默认 |
| 项目级危险键 | 命中 `PROJECT_FORBIDDEN` 直接忽略 + warning | 不生效 |
| 冲突 | entry > project > user > legacy；同层后写覆盖 | 记录 source |

建议的 `PROJECT_FORBIDDEN`（至少）：

```text
allowEvaluate
evaluate.enabled
browser.shared.enabled
browser.shared.leaseTtlMs
browser.headless.chromeExecutable
update.autoInstall
update.repository
upload.extraRoots
safety.allowedOrigins
```

### 6.2 合并与“entry 默认值”陷阱

DSH `Config` 带 `.default()` 时，传给 `apply(ctx, config)` 的是**解析后的完整配置**，不是用户显式写的那几行。如果直接拿它去覆盖旧文件，所有默认值都会压过文件配置，兼容层就失效了。

因此 Phase 1 的合并顺序建议：

```text
DEFAULT_CONFIG
  < legacy provider file
  < user file
  < project file（仅安全字段）
  < DSH entry 的“用户 override 层”（只含显式设置的键）
```

实现上：

- 从 `ctx.get('configEditor')` 的 `configuration()` 找到本插件条目，取 `override`（用户层），不要拿 `entry.fiber.config`（已解析、含默认值）。
- 找不到 `configEditor`（老版本/测试环境）时，退化为 `config` 参数，并在 warning 里说明“entry 默认值可能覆盖文件配置”。
- 对 volatile 字段，运行中读 `.get()`；对非 volatile 字段，重载后重新走上面的合并。
- `chrome_config` 必须显示每个键的来源，避免“我改了文件但没生效”的困惑。

### 6.3 迁移

`CONFIG_VERSION` 建议从 1 升到 2，但**不强制重写用户文件**：

| 旧位置/键 | 新位置 | 处理 |
|---|---|---|
| `~/.dsh/cache/dsh-chrome/config.json` 的 `allowEvaluate` | `evaluate.enabled`（或保留 `allowEvaluate` 别名） | 继续读；启动 warning 提示迁移；不自动改文件 |
| 同上的 `evaluateConfirmTimeoutMs` | `evaluate.confirmTimeoutMs` / `evaluateConfirmTimeoutMs` | 保留别名 |
| 同上的 `captureConfirmTimeoutMs` | `capture.confirmTimeoutMs` / `captureConfirmTimeoutMs` | 保留别名 |
| `~/.dsh/config.json` 的 `browser/verification/update/safety` | DSH 条目 `config:` | 继续读一个版本；文档给 patch 片段 |
| `browser.headless.chromeExecutable` | 合并 `DSH_HEADLESS_CHROME` 后保留一个名字 | 先接线，再决定是否迁移 env |
| `browser.shared.requireLease` | 删除 | warning：“shared.enabled 已隐含 lease，此键无效” |
| `externalAgents.*` | 删除 | warning：“未实现，已忽略” |
| `safety.allowedOrigins` | 决定语义后保留或删除 | 未决定前不要写进新 schema |
| `verification.screenshotFormat` 等 | 接线或删除 | 先接线，避免迁移一个假配置 |

迁移脚本建议 `scripts/config-migrate.mjs`：

- 默认 `--dry-run`：打印当前 effective config、每个键的来源、建议的 `cordis.patch.yml` YAML 片段。
- `--write` 只写**插件自己的**文件（例如 `~/.dsh/cache/dsh-chrome/config.migrated.json`），不直接改 DSH profile patch。
- 不自动改 `cordis.patch.yml`：里面可能有注释和其他插件条目，自动重写风险高。
- 迁移前备份 `.bak-<timestamp>`；输出不包含 secret 值。

### 6.4 文档

必须改的文档：

- `docs/CONFIG.md`：从“provider config 三项”改成“设置总览 + 当前实现状态”；明确哪些键未接线。
- `docs/CONTEXTS.md`：删掉/标注 `browser.headless.chromeExecutable`、`viewport`、`verification.screenshotFormat` 等未接线示例；写明 `collab` 仍不可用。
- `docs/APPROVAL.md`：`approval.mode` / `balanced` / `strict` 目前是设计，不是 `config.js` 字段；在实现前标注“未实现”。
- `README.md`：把 V3 的“DSH 设置页”链接到本文；明确当前没有设置页。
- `docs/SECURITY.md`：加“设置边界”：危险项 MVP 只走文件；popup 不写 provider 配置；设置变更审计只记键名。
- `CHANGELOG.md`：后续实现时写清“新增/接线/删除”的键。

### 6.5 测试

> 实现状态：本分支把原设计的 `test/config-settings.mjs` 与 `test/config-schema.mjs` 合并为 `test/settings.mjs`；`browser-contexts` / `artifact-store` 的实时读取断言也并入该文件。下表保留原设计的拆分。

新增/修改：

| 测试 | 覆盖 |
|---|---|
| `test/config-settings.mjs`（新） | 默认值；四层合并；entry override 优先；project 危险键被忽略；version 1→2；未知/secret 键；类型/范围；source 映射 |
| `test/config-schema.mjs`（新） | `Config` 能被 `toJSON()`；volatile 集合与 `LIVE_PATHS` 一致；非 volatile 危险键不在 `volatileForm`；默认值与 `DEFAULT_CONFIG` 对齐 |
| `test/browser-contexts.mjs` | `maxContexts` / `idleTimeoutMs` / `preset` 的实时读取（改后新 context 生效） |
| `test/artifact-store.mjs` | `artifactRetentionRuns` 实时读取；`maxArtifactBytes`（接线后） |
| `test/update.mjs` | `enabled=false` 不发请求；channel/interval；autoInstall 平台限制 |
| `test/p2-tools.mjs` | `chrome_config` 返回 effective/source/reloadRequired；`allowEvaluate` 开关仍只影响注册 |
| `test/operation-log.mjs` | `operationLog.enabled=false` 不写；`maxBytes` 生效 |
| `test/capture-parity.mjs` | 改配置不改抓包脱敏/预算（安全不变量） |

手工验收（DSH GUI）：

1. 改 `Config` 后，`cordis_inspect_query` 的 `Config/listConfigs` 从 `absent` 变成有 schema。
2. DSH Plugins 页出现 `dsh-desktop-chrome` 的自动表单，只有预期的 volatile 字段。
3. 改 `evaluateConfirmTimeoutMs`，不重载 provider，下一次 `chrome_evaluate` 使用新超时。
4. 改 `allowEvaluate`（profile patch），重载后工具数量变化；`chrome_config` 之前返回 `reloadRequired: true`。
5. 抓包 start 仍然每次硬确认，即使 `captureConfirmTimeoutMs` 改成 1s。
6. 扩展 popup 没有任何 provider 设置表单。

---

## 7. 分阶段计划

### Phase 0：把真话说清楚（0.5 天）

- 新增本文；更新 `docs/CONFIG.md` / `docs/CONTEXTS.md` 的“未接线”标记。
- 给所有死键加启动 warning（或先从文档删除），避免用户继续被误导。
- 加 `test/config-settings.mjs` 的默认值/合并基线测试（不改变行为）。
- 验收：`npm test` 绿；文档不再声称这些键生效。

### Phase 1：Config schema + DSH 自动页 MVP（1–2 天）

> 实现状态（2026-10-19）：`Config` / `apply(ctx, config)` / entry override / volatile 更新已落地；真实 DSH 自动页与 `cordis_inspect` 尚未验收。本分支先收 4 个 volatile 字段（不含 evaluate/capture 的超时项）。

- 新增 `src/config-schema.js`：导出 `Config`（schemastery，含 volatile 标记）。Phase 1 **只**把 §5.2 列出的低风险字段标 `.volatile()`，其余字段先保持非 volatile，避免未接线项出现在自动页。
- `index.js`：`export { Config }`，`apply(ctx, config)`；从 `configEditor` 取 override 层；保留文件兼容层。
- 新增 `src/settings.js`：`live()`、`LIVE_PATHS`、`PROJECT_FORBIDDEN`、`sources`、`reloadRequired`。
- `tools.js` / `contexts.js` / `artifact-store.js`：把 volatile 基础字段改成按调用读取（或接收 getter）。
- `chrome_config`：输出 effective/sources/reloadRequired/files/warnings；保持只读。**本分支未做，仍是旧 provider 文件视图。**
- 验收（本分支未做真实 DSH 验收）：DSH 自动页出现 4 个 volatile 字段；改超时实时生效；`cordis_inspect` 的 `Config` 状态不再是 `absent`；`npm test` 绿。

### Phase 2：接线假配置（1 天）

- `browser.headless.viewport` → `HeadlessDriver` 的 `windowSize`。
- `verification.screenshotFormat` / `captureConsole` / `captureNetwork` → `chrome_verify` 的默认 options。
- `verification.maxArtifactBytes` → `ArtifactStore` 写入前/复制前限制。
- `operationLog.enabled` / `maxBytes` → `operation-log.js` 读取配置（env 作为 fallback）。
- 决定 `safety.allowedOrigins`：实现成导航 origin allowlist，或从 schema 删除。
- 删除/合并 `externalAgents.*`、`browser.shared.requireLease`。
- 验收：每个字段都有测试证明“改了就生效”；`chrome_config` 不再把未接线键列为生效。

### Phase 3：危险项策略（1 天，先不做 GUI）

- 危险项（`allowEvaluate`、`browser.shared.enabled`、`update.autoInstall`、`upload.extraRoots`、`chromeExecutable`）只允许从用户级 profile patch / 旧用户文件读取；项目级忽略。
- `chrome_config` 标记 `reloadRequired` + 风险等级 + 入口路径。
- 变更写 `audit.jsonl`（键名/来源/时间）。
- 文档给出每个危险项的风险、回滚方法、验证命令。
- 验收：项目配置无法打开危险项；重载后行为变化；审计有记录。

### Phase 4（可选，2–3 天）：小设置页 / 站点策略编辑器

只在 Phase 1–3 的真实使用证明“自动页不够用”时做：

- 一个小客户端 companion 包，注册 `plugins.bundle.config`（entry key `dsh-desktop-chrome`），用分组卡片展示基础/高级/危险；不做大导航、不做复杂状态。
- 一个 Host Remote 服务（例如 `dshChromeSettings`）负责写非 volatile 配置：内部调用 `configEditor.edit()`；危险项写入前用 `ctx.userQuestions` 硬确认；写后返回 `reloadRequired`。
- 站点策略编辑器单独设计：`policy.json` 的 origin 列表 + allow/ask/block；`allow` 必须二次确认。
- 验收：所有写路径都有硬确认；没有绕过 `settings`/`configEditor` 的私有写文件；UI 不做“静默应用”。

### Phase 5：发布与迁移（0.5 天）

- `CHANGELOG.md` 写清新增/接线/删除的键；`README.md` 链接本文；`docs/CONFIG.md` 成为唯一设置总览。
- 迁移 dry-run 脚本；旧文件 warning；一个版本后删除旧键。
- 验收：新用户只读 `docs/CONFIG.md` 能完成配置；老用户升级有 warning 和迁移指引。

---

## 8. 风险与待拍板

| # | 问题 | 推荐 | 代价 |
|---|---|---|---|
| 1 | 危险项要不要在 MVP 进 GUI？ | **不进**；文件/条目 patch | 用户要手写 YAML；但不会误点 |
| 2 | 项目级配置保留吗？ | 保留安全子集，危险键忽略 | 需要在 loader 里维护 allowlist |
| 3 | `capture.storeBodiesByDefault` 默认 true 还是 false？ | **先保持 true**（兼容当前行为） | 隐私上不是最优；下个大版再讨论默认 false |
| 4 | `safety.allowedOrigins` 实现还是删除？ | 先决定语义；实现成“允许列表”则默认 null 不限制 | 语义不清会变成假配置 |
| 5 | `verification.*` 接线还是删除？ | **接线**（用户已经以为是生效的） | 需要改 `chrome_verify` 和产物限制 |
| 6 | `viewer.enabled` 默认开还是关？ | **开**（保持现状），提供关闭 | 关闭后 sidepanel viewer 不可用 |
| 7 | 自动页对 bundle 是否稳定出现？ | Phase 1 实测；不出现就不发 UI | 可能只能交付 schema + 文档 |
| 8 | 旧 `~/.dsh/config.json` 是否继续读？ | 继续读一个版本，warning | 与其他插件共享文件的风险仍在 |
| 9 | 是否允许 GUI 改 `update.autoInstall`？ | **不允许**；只文件 | 自动替换 exe 不该是一键操作 |
| 10 | 设置变更审计放哪？ | `audit.jsonl` 新记录类型；只记键名 | 需要定义记录 schema，避免泄值 |

---

## 9. 当前明确未实现（不要当成已有）

- ✅ `Config` schema 已实现（MVP；4 个 volatile 字段）；`apply(ctx, config)` 已接收配置。
- ⏳ 真实 DSH 安装里的 Plugins 自动页与 `Config/listConfigs` 投影尚未验证；本地 `toJSON` / `volatileForm` 离线核对通过。
- ❌ 扩展 popup 没有设置表单；只有状态和操作。
- ❌ `chrome_config` 只读 provider 文件，不展示 canonical/entry/project 配置，也不写配置。
- ❌ `verification.screenshotFormat`、`captureConsole`、`captureNetwork`、`maxArtifactBytes` 没有生效。
- ❌ `browser.headless.chromeExecutable`、`browser.headless.viewport` 没有生效。
- ❌ `browser.shared.requireLease`、`externalAgents.*`、`safety.allowedOrigins` 没有生效。
- ❌ `chrome_verify` 的 `options.screenshotOnFailure` / `captureConsole` / `captureNetwork` 被解析但未使用。
- ❌ `collab` / shared-visible context 仍未实现；`browser.shared.enabled` 只控制 lease 门控。
- ❌ `approval.mode` / `balanced` / `strict` 只在 `docs/APPROVAL.md` 中，未进配置。
- ❌ 设置变更没有审计记录；没有 `config-changed` 事件。
- ❌ 没有迁移脚本；没有 `CONFIG_VERSION = 2`。
- ❌ 没有站点策略编辑器；`policy.json` 只能手写。

---

## 10. 一句话版本

**把“现在只能改文件”的选项分成三层：DSH 自动设置页只放实时、低风险的 volatile 字段（MVP 先 4 个）；高级项继续走条目 patch / 配置文件；危险项默认关闭、只允许用户级文件显式开启，且必须重载。先接线假配置，再谈 UI；MVP 不写扩展设置页，也不做大的客户端。**
