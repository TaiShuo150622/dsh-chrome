# dsh-chrome 设计文档

> 状态：**设计稿（待拍板后进入 M0）**
> 日期：2026-10-17
> 目标运行时：DeepSeek Harness Desktop **0.2.1-rc.1**（Electron，profile `desktop`） / Google Chrome **155**（macOS 先行）
> 文档性质：这是实施前的契约；工具名、配置字段、审批语义在 M0/M1 期间可小改，但架构方向以本文件为准。
> 关联：[分阶段计划](ROADMAP.md) · [审批说明](APPROVAL.md) · [M0 清单](M0.md)

---

## 0. 已拍板的决策

| # | 决策点 | 选择 | 说明 |
|---|---|---|---|
| D1 | 建法 | 自研新插件 | 不 fork；借鉴 MIT 项目设计，写明出处 |
| D2 | 连接通道 | Chrome 原生消息（native messaging） | 同 Claude in Chrome / Codex；无端口、无 token 配置 |
| D3 | 首版范围 | 核心可用 12 工具 | 读取/操作/标签/截图/审批先跑通 |
| D4 | 交付形态 | 先本地安装，后开源；**按官方规范**（已确认） | 遵守官方 provider 会话归属语义；包/文档/测试遵循官方包形态 |

「按官方来」在本设计中的具体含义（若理解有偏差请纠正）：

1. 挂载并注册官方 `@deepseek-ai/dsh-browser-use` 的 **browser-use provider**，而不是自造 browser seam；
2. 遵守官方 provider 的会话归属语义：一个 Session 独占其浏览器资源，初始化可等待、卸载先停工具再释放；
3. 包/文档/测试遵循官方包形态：TypeScript + tsdown + vitest，README 分节（Summary / Use this package / Understand the implementation / Model Experience / Known Limitations），插件元数据（locale、icon）符合 Plugin Manager 要求；
4. 工具命名不与通用命名空间（`browser_*`）冲突，使用 `chrome_*`，为未来官方合并保留空间。

---

## 1. 目标与非目标

### 目标

- 模型在 DSH 桌面端会话里，通过工具**真实操控用户当前登录的 Google Chrome**：
  读页面、点击、输入、按键、滚动、导航、开/关后台标签、截图（可回传给视觉模型）、等待页面就绪。
- 体验对齐 Claude in Chrome / Codex 的浏览器能力：保留登录态、按会话隔离、不抢焦点、危险动作先问人、登录/CAPTCHA 交还人工。
- 安装一次后稳定重连：DSH 重启、Chrome 重启、扩展 service worker 休眠都不需要用户重新配置。
- 代码可控、可维护、可开源：零私有依赖，MIT。

### 非目标（V1 明确不做）

- 反检测/隐身/绕过 bot 检测；
- 绕过 Chrome 受保护页面（`chrome://`、扩展商店）与付费墙；
- 自动处理 CAPTCHA、自动登录、读取密码；
- headless 替代方案（它解决不了「用户已登录的真实浏览器」）；
- Chrome 侧边栏聊天面板（桌面 app 就是聊天面）；
- 手机/平板浏览器。

---

## 2. 背景与现状

### 2.1 DSH 桌面端（本机实测，2026-10-17）

- app：`/Applications/DeepSeek Harness.app`，`com.deepseek.dsh`，**0.2.1-rc.1**，Electron。
- GUI 由本地 HTTP 服务提供，端口**随机**（本次 `DSH_WEB_URL=http://127.0.0.1:57053`）；不能用固定端口探测。
- profile 目录 `~/.dsh/profiles/desktop`；插件通过 `plugin_manager` 安装 bundle（当前审批策略 `ask`）。
- Host 服务面包含 `ctx.webServer`（HTTP 路由 + WebSocket upgrade）、`ctx.tools.register`、`ctx.systemPrompt`、`ctx.approval`、`ctx.attachments` 等；这些是本插件直接使用的扩展点。
- 自带 `runtime/bin/node`（Electron 以 `ELECTRON_RUN_AS_NODE=1` 运行）与 bundled pnpm —— **原生消息 host 不需要用户安装 Node**。
- 当前 Tool 列表**没有任何 `browser_*` 工具**：桌面端还没有启用任何 browser provider，这正是缺口。
- 模型路由 DeepSeek-V4.1-Flash 的 profile 已声明 `inputModalities: [text, image]`：截图回传视觉可行。

### 2.2 官方 browser-use 形态（0.2.1 线）

- 官方包 `@deepseek-ai/dsh-browser-use`（npm，0.2.1-rc.2）只是一个**独占注册表**：`ctx.browserUse.register(BrowserUseProviderName(name))`，不提供任何工具或操作接口；一个部署同时只允许一个 provider。
- 官方实验 provider 例：`@deepseek-ai/dsh-experimental-browser-use-playwright-mcp` —— provider 自己提供工具与浏览器生命周期，内部用 shared runtime 做 per-Session 串行化。
- 结论：本插件应当是**一个 browser-use provider**，自带 `chrome_*` 工具，独占注册 `chrome-extension`。

### 2.3 现有实现对照（借鉴，不 fork）

| 项目 | 可借鉴 | 不采用 |
|---|---|---|
| [omdsh-dev/dsh-browser](https://github.com/omdsh-dev/dsh-browser)（833★, MIT） | 文本快照 + 编号 ref 的页面接口；会话归属/切换语义；安全措辞 | 回环 WS + 端口探测；Chrome 侧边栏聊天面板；纯文本不截图 |
| [youbaiyun/dsh-browser-crossplatform](https://github.com/youbaiyun/dsh-browser-crossplatform)（52★, MIT） | 桌面安装/分发思路；图片通道默认关的取舍；双向兼容范围写法 | 回环 WS 架构；跟上游走 |
| [yueyexiayu/dsh-chrome](https://github.com/yueyexiayu/dsh-chrome)（MIT，个人） | 原生消息 host/launcher；后台标签 + 折叠标签组、不 bringToFront；截图→DSH 附件；`chrome_*` 命名；debugger 横幅注意事项 | 私有 vendored alpha 依赖；个人化快捷能力 |
| [dsh-builtin-browser](https://www.npmjs.com/package/dsh-builtin-browser)（npm 0.4.13） | 34 个工具的覆盖面清单；人机同页/可接管的交互 | CDP 载体、需要 patch 桌面 app 资源的做法 |
| Claude in Chrome / Codex 浏览器 | 站点级授权、登录/CAPTCHA 交还、标签组、截图与 GIF、claim 现有标签 | 我们不做 Chrome 内聊天面板 |

---

## 3. 架构总览

```
┌─ DSH Desktop (Electron, profile=desktop) ─────────────────────────────┐
│                                                                      │
│  Agent ──tools──▶ dsh-chrome provider（Host 插件, TS）                 │
│                    ├─ browserUse.register('chrome-extension')          │
│                    ├─ chrome_* 工具（ctx.tools.register）               │
│                    ├─ 系统提示词段（页面=不可信）                        │
│                    ├─ per-Session：owner / tabGroup / 串行队列 / 审批    │
│                    └─ BridgeServer（UNIX socket, 随机路径）             │
│                                   ▲ token（0600 discovery 文件）        │
└───────────────────────────────────┼──────────────────────────────────┘
                                    │
                         Native Host（Chrome 拉起, app 自带 node）
                          └─ 读 discovery → 连 socket → 纯转发 + 版本握手
                                    ▲ Chrome 原生消息（stdio，4 字节长度帧）
┌───────────────────────────────────┼──────────────────────────────────┐
│  Chrome MV3 扩展 "DSH Chrome"（manifest key 固定 ID）                 │
│   Service Worker                                                     │
│    ├─ nativeMessaging.connectNative()   ←→ host                      │
│    ├─ tabs / tabGroups                 标签创建(active:false)/分组/清理 │
│    ├─ scripting + content scripts      快照、ref、点击、输入、滚动       │
│    └─ chrome.debugger（默认不 attach）  console/network/upload/dialog   │
│   content script：编号控件、React/Vue-safe 赋值、元素可见性               │
│   popup：连接状态 / 版本 / 本会话标签组                                  │
└──────────────────────────────────────────────────────────────────────┘
```

职责边界：

- **扩展**：唯一能碰 Chrome 的部分；不保存会话业务逻辑，只执行带 `tabId` 的指令并返回结构化结果。
- **native host**：最小化转发进程；不做业务决策，只做版本握手、消息帧转换、socket 重连。
- **provider**：所有业务逻辑（会话归属、标签组、审批、快照截断、视觉开关、错误分类、工具 schema）。
- **DSH UI**：聊天、审批卡、工具结果展示；Chrome 侧不做聊天。

---

## 4. 关键设计

### 4.1 传输层：原生消息 + UNIX socket

```
Chrome SW ──connectNative(com.deepseek.dsh.chrome)──▶ Native Host 进程（stdio）
Native Host ──connect(socket) + hello{token,version}──▶ Provider BridgeServer
```

- **Chrome 侧鉴权**：Chrome 只允许 NativeMessagingHosts manifest 中 `allowed_origins` 列出的扩展 ID 调用 host —— 这是 Chrome 保证的通道；扩展 ID 用 manifest `key` 固定。
- **host ↔ DSH 侧鉴权**：provider 启动时生成随机 token，写入 `$DSH_HOME/cache/dsh-chrome/bridge-<pid>.json`（`0600`，含 socket 路径、pid、版本）；host 读取最新文件并 hello；provider 校验 token。
- **socket 路径**：`$TMPDIR/dsh-chrome-<uid>/bridge.sock`（避开 macOS UNIX socket 104 字符路径限制）。
- **帧格式**：newline-delimited JSON；`{"id","method","params"}` / `{"id","result"}` / `{"id","error"}`；事件 `{"event","params"}`（例如 `tab.updated`）。
- **重连**：
  - Chrome SW 休眠后重新 `connectNative` → Chrome 重新拉起 host → host 重新连 socket（provider 常驻监听）。
  - DSH 重启：扩展重试 connectNative；host 找不到 socket 时以明确错误退出，SW 退避重试（1s/2s/5s/10s，上限 30s）。
  - launcher 用**安装时写入的 DSH app 内 Electron-as-Node 绝对路径**，不依赖用户 shell 环境；系统 node（`/opt/homebrew/bin/node`）仅作兜底。
- 选择理由：无端口冲突/发现；不暴露 loopback 端口；Chrome 按需拉起；与 Claude/Codex 同构（本机已有两份可参照的 host manifest）。

### 4.2 Chrome 扩展

- **manifest（MV3）**：`nativeMessaging, tabs, tabGroups, scripting, storage, activeTab`；`host_permissions: ["http://*/*","https://*/*"]`；`minimum_chrome_version: 116`；`key` 固定扩展 ID。
- **`debugger` 权限**：V1 不需要。V2 的控制台/网络/上传/弹窗能力再评估：可接受「manifest 含 debugger，但仅用户显式开启高级功能后才 `attach`」，避免默认出现「正在调试」横幅。
- **content script**：`document_idle`、`all_frames: false`（V1 只做顶层文档；iframe/shadow DOM V2）。
  - 快照：可见性过滤 → 交互控件编号（`data-dsh-ref`，按 DOM 顺序稳定编号；同文档内从 1 开始，快照之间重排）→ 文本摘要 → 密码/支付字段 `••••`。
  - 操作：原生 setter + `input`/`change` 事件（React/Vue 兼容）；点击派发 pointer/mouse 序列并校验可点击性；滚动默认 viewport。
- **tab 组**：每个 DSH 会话一个组 `DSH · <session short id>`；新标签 `active:false` + `collapsed:true`；**永不调用 bringToFront/activate**（macOS 上避免抢焦点）。
- **截图**：`chrome.tabs.captureVisibleTab`（V1，不 attach debugger）；需要整页/element 截图时 V2 用 debugger。
- **popup**：Connected/版本/本会话标签数 + 「安装/重载扩展」提示；不含聊天。

### 4.3 Host 插件（bundle）

```
package.json { name: "dsh-desktop-chrome", dsh.bundle.patch: "./cordis.patch.yml", files: [...] }
cordis.patch.yml
  - insert:
      - id: dsh-chrome-browser-use     # 官方 provider 注册表；桌面 app 未内置时由本包提供（vendor 或依赖）
      - id: dsh-chrome                 # 本插件，inject: [tools, systemPrompt, browserUse?]
```

- 激活时：注册 provider 名（失败则整个插件拒绝激活并给出明确错误：已有其他 provider 占用）、注册工具、注册系统提示词段、启动 BridgeServer、写/刷新 installation 资产（native host + manifest）。
- 卸载/停用：先注销工具并拒绝新调用 → 等本会话在途请求结束 → 关 socket → 释放 provider 注册。
- 工具调用串行化：同一 Session 内串行；不同 Session 可并行（各自浏览器资源仍共享 Chrome，需要按 tab 归属隔离）。
- 配置（Schemastery，字段以 M1 定稿为准）：`enabled`、`screenshot.attach`（`auto|always|never`，默认 `auto`）、`snapshot.maxChars`、`confirmMutations`、`allowedOrigins`（默认 http/https）、`advanced.debugger`（默认 false）。

### 4.4 会话与标签归属

- Session ↔ owner 摘要（session id、cwd、创建时间）。
- 会话第一次浏览器操作时：找到/创建本会话标签组（组名唯一），之后工具默认作用于「本会话最近活动标签」。
- **不读、不列、不切用户其他标签**（V1）：`chrome_tabs.list` 只列本会话 owner 的标签。
- 用户手动切走标签：不静默跟随。后续操作若目标仍是本会话标签则继续；若用户关闭了会话标签 → `TAB_GONE`，工具提示重建。
- 会话结束/`chrome_close_session`：关闭本组标签并删组；不退出 Chrome、不影响其他会话组。
- 并发保护：同会话串行队列；`chrome_status` 可并发（只读握手）。

### 4.5 工具契约（V1，12 个）

命名空间 `chrome_`；所有工具接受可选 `tabId`（缺省为本会话当前标签）；错误码见 4.5.1。

| # | 工具 | 参数（概要） | 返回（概要） |
|---|---|---|---|
| 1 | `chrome_status` | — | connected、版本（扩展/host/协议）、会话标签组、本会话标签数 |
| 2 | `chrome_tabs` | `op: list\|new\|close`, `url?`, `tabId?` | 标签列表（id/title/url/owned）、新标签 id 或关闭结果 |
| 3 | `chrome_goto` | `url`, `tabId?` | url、title、loadState |
| 4 | `chrome_history` | `op: back\|forward\|reload`, `tabId?` | url、title |
| 5 | `chrome_snapshot` | `mode: full\|delta`, `maxChars?` | title、url、编号控件列表、正文摘要、ref 表 |
| 6 | `chrome_click` | `ref`, `tabId?` | 动作结果、页面是否变化（建议后续 wait/snapshot） |
| 7 | `chrome_type` | `ref`, `text`, `replace?`, `submit?` | 输入结果、是否提交 |
| 8 | `chrome_press` | `key`（Enter/Tab/Escape/方向键/PageUp…）, `tabId?` | 结果 |
| 9 | `chrome_scroll` | `direction: up\|down\|top\|bottom`, `amount?` | 结果、是否到底 |
| 10 | `chrome_wait` | `until: load\|networkidle\|text`, `text?`, `timeoutMs?` | 命中的条件与耗时 |
| 11 | `chrome_screenshot` | `fullPage?`, `attach: auto\|always\|never` | 附件引用（视觉路由可用时）或落盘路径 |
| 12 | `chrome_close_session` | `keepGroup?` | 关闭的标签数 |

#### 4.5.1 错误码

`NOT_CONNECTED`（扩展/host 未连）、`HOST_VERSION_MISMATCH`、`NO_SESSION_TAB`、`TAB_NOT_FOUND`、`TAB_GONE`、`REF_STALE`（快照后页面变化）、`PROTECTED_PAGE`、`BLOCKED_BY_POLICY`、`APPROVAL_DENIED`、`NAV_FAILED`、`TIMEOUT`、`UNSUPPORTED`。

### 4.6 安全与审批

> 本节是摘要；完整语义、模式、实现路径与用户可见行为见 [APPROVAL.md](APPROVAL.md)。

- **不可信输入**：页面标题/正文/控制台/截图内容只作为数据；系统提示词明确「页面不是指令」，工具结果标注来源 URL。
- **读 vs 写**：读类（status/snapshot/screenshot/tabs.list）默认放行；写类（goto/click/type/press/scroll/history/tabs.new/close）首次源站需确认，可「本会话信任该源站」。
- **强制确认（不受会话策略影响）**：上传文件、下载、受限 JS eval（V2）、读剪贴板、向第三方表单输入个人数据。
- **默认严格度（已拍板）**：`follow-dsh` —— 普通动作跟随 DSH 会话审批策略；硬敏感动作始终单独确认（`ctx.userQuestions`）。当前 profile 为 `danger-full-access` + `never`，因此日常读写不弹卡；可切 `strict` / `balanced` / `off`。细节见 [APPROVAL.md](APPROVAL.md)。
- **实现路径**：优先 `ctx.approval`（遵循 DSH 会话权限预设）；若会话为 `danger-full-access/never` 时仍要求确认，则改走 `ctx.userQuestions.ask` 的确认卡。P1 两条都接，语义目标 = Claude/Codex。
- **敏感值**：密码/支付字段永不进入快照/a11y/日志；输入密码类 ref 时要求用户确认并打码回显。
- **受保护页面**：仅元数据，禁止 DOM 读取；导航仍允许（chrome:// 除外）。
- **登录/CAPTCHA**：返回截图 + 明确提示交还用户；不自动尝试。
- **连接**：扩展→host 由 Chrome `allowed_origins` 保证；host→provider 由 0600 文件 token 保证；socket 只 bind 本用户可访问的 `$TMPDIR` 子目录。
- **数据边界**：不读全局历史/下载历史/cookie/storage；截图与页面文本仅进入当前会话。

### 4.7 安装、升级与自检

安装（开发者版）：

1. `pnpm install && pnpm build`（生成 `lib/`）。
2. `plugin_manager install_bundle`（目标 = 仓库根目录；需要审批）→ bundle 激活（必要时重启 app）。
3. 插件首次激活自动：
   - 生成 native host launcher 与 `host.mjs` 到 `$DSH_HOME/cache/dsh-chrome/host/`；
   - 写 Chrome manifest：`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.deepseek.dsh.chrome.json`；
   - 打印扩展目录路径（`<repo>/extension`）与三步安装指引；同时写 `$DSH_HOME/cache/dsh-chrome/install.md`。
4. 用户手动：`chrome://extensions` → 打开开发者模式 → 加载已解压扩展（选 `<repo>/extension`）→ **完全退出并重启 Chrome**。
5. 点扩展图标 → popup 显示 `Connected · provider vX`。

升级：`pnpm build` → 重新 `install_bundle`（替换已安装包需要重启 app，官方语义）→ 扩展卡片点「重新加载」→ 重启 Chrome（如 host manifest 有变）。插件激活时版本不一致会在 `chrome_status` 里显式报告。

自检（`chrome_status`）：扩展版本、host 版本、协议版本、socket/discovery 状态、native manifest 是否存在、当前会话标签组。

卸载：`plugin_manager remove_bundle`；插件 dispose 时尽力删除 native manifest 与 host 目录；扩展由用户在 Chrome 手动移除。

### 4.8 官方对齐（"按官方来"）

- **provider 语义**：挂载官方 `@deepseek-ai/dsh-browser-use`，注册唯一名字 `chrome-extension`；注册失败（已有 provider）时以该名字报告，不抢占。
- **依赖策略**：优先使用桌面 app 已发行的同版本线包；若 app 未内置 `dsh-browser-use`，在 M0 验证两条路：bundle 依赖安装 / vendor 10KB 源码（MIT 保留出处），二选一。
- **官方 shared runtime**：官方 Playwright provider 用的是 experimental shared runtime。M0 不引入其私有 alpha 构建（yueyexiayu 用的是 `0.2.1-alpha.4.browser-policy.1` 私有包）；若后续桌面稳定版提供公开 runtime，再对齐（会话初始化/串行化/清理顺序语义保持一致）。
- **包与文档**：TS + tsdown + vitest；README 采用官方分节；插件 locale/icon 满足 Plugin Manager 展示要求（`meta.title`/`meta.description` 中英双份 + 原始 icon）。
- **可上游性**：工具名、配置、README 的措辞保持中性，不绑定个人环境；名字不冒充官方（发布名 `dsh-desktop-chrome`，非 `@deepseek-ai/*`）。

---

## 5. 里程碑与验收

| 阶段 | 内容 | 工期 | 验收（可复现） |
|---|---|---|---|
| **M0 技术验证** | 空壳 bundle + 扩展 + native host + socket；3 个工具（status/goto/snapshot）；截图进附件 | 0.5–1 天 | `cordis_inspect_query Tool` 出现 `chrome_*`；popup Connected；`example.com` 导航+快照；会话里能看到截图图片 |
| **M1 MVP** | 12 工具 + 标签组 + 会话隔离 + 审批 + 安装器 + popup 状态 | 2–3 天 | 10 个真实场景通过；不抢焦点；DSH/Chrome 各重启一次自动恢复；审批卡在桌面 GUI 出现；并发两会话互不串 |
| **M2 对标增强** | console/network/受限 eval/上传/下载/a11y/弹窗/claim 用户标签/元素拾取 | 3–4 天 | 对照 Claude/Codex 清单逐项打勾并留证；每项有 e2e 或脚本化验收 |
| **M3 产品化** | DSH 设置页、诊断日志、Windows host、CI + Chrome for Testing e2e、商店材料 | 2–3 天 | 干净 profile 一键安装；升级/回滚演练；文档与故障排查齐备 |

测试策略：

- 单元：协议帧、discovery/token、ref 编号与失效、URL/受保护页策略、快照截断与打码、错误分类。
- 集成：假扩展客户端驱动 provider（无 Chrome）；真实 Chrome for Testing 加载扩展（Playwright persistent context）跑本地测试页。
- 手工验收（真实 Chrome）：本地应用、登录站点、表单、多标签、截图、控制台、上传、弹窗、断线重连、并发会话。
- 每条验收留命令/截图/日志；不用「我觉得能跑」。

---

## 6. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 桌面 0.2.1-rc.1 与社区按 rc.2 适配的插件有版本差 | 启动/工具注册失败 | 能力探测；M0 先验证；避免硬依赖 |
| 原生消息安装不可自动化 | 首次体验断点 | 安装器 + popup 自检 + 文档；Chrome 商店版本（V3）可免手动 |
| Chrome 升级/权限变动破坏扩展 | 功能回退 | 版本探测 + Chrome for Testing 集成测试 + 明确错误码 |
| 工具名冲突（已有 `browser_*` 插件） | 注册失败 | `chrome_*` 命名空间 + 官方单 provider 规则 |
| 桌面升级替换 app 资源 | host 路径失效 | launcher 安装时生成、激活时刷新；不 patch app |
| 快照/截图 token 成本 | 上下文膨胀 | delta、ref 复用、截断；截图 `auto` 且压缩/限尺寸 |
| 多会话并发抢 Chrome 焦点/标签 | 串台 | 每会话标签组 + owner 校验 + 同会话串行 |
| `debugger` 横幅/商店审核 | 体验与上架 | V1 不用；V2 显式开关；商店材料单独评估 |
| Windows 无 bash launcher | 平台缺口 | M3 用 `.cmd` + 打包 host；V1 只承诺 macOS |

---

## 7. 目录结构（实施后）

```
dsh-chrome/
├─ package.json                 # dsh.bundle.patch；name: dsh-desktop-chrome
├─ cordis.patch.yml             # browser-use 注册表 + 本插件行
├─ tsdown.config.ts / tsconfig.json
├─ src/
│  ├─ index.ts                  # apply(): 注册 provider/tools/prompt；启动 bridge；安装资产
│  ├─ config.ts                 # Schemastery Config
│  ├─ bridge/server.ts          # UNIX socket + token + framing
│  ├─ bridge/protocol.ts        # 帧类型、版本协商、错误码
│  ├─ session/ownership.ts      # 会话↔标签组、串行队列
│  ├─ session/approval.ts       # 审批请求与源站信任
│  ├─ tools/                    # 12 个 chrome_* 工具 + schema
│  ├─ snapshot/format.ts        # 快照文本格式、截断、打码
│  └─ install.ts                # native host/launcher/manifest 生成与自检
├─ host/
│  ├─ dsh-chrome-host            # launcher 模板（安装时填入 app node 路径）
│  └─ host.mjs                   # stdio ↔ socket 转发
├─ extension/
│  ├─ manifest.json              # key 固定 ID；MV3
│  ├─ src/background.ts          # nativeMessaging 连接、tabs/tabGroups、指令分发
│  ├─ src/content.ts             # 快照/ref/点击/输入/滚动
│  ├─ src/popup.{html,ts}        # 状态
│  └─ icons/
├─ locale/{en,zh}.json           # meta.title / meta.description
├─ icon.svg
├─ scripts/{install-dev.mjs,verify.mjs}
├─ test/{unit,integration,e2e}/
└─ docs/{DESIGN.md,M0.md}
```

---

## 8. 开放问题（M0/M1 前定稿）

1. 审批默认严格度：已定 `follow-dsh`（2026-10-17）；实现见 [APPROVAL.md](APPROVAL.md) §6。
2. 截图默认开关：`auto`（模型支持图像就回传）是否符合你的成本预期。
3. 是否 V1 就支持「认领用户当前标签」（建议 P2，避免一上来就碰用户数据）。
4. npm 发布名与仓库名：暂定 repo `dsh-chrome` / package `dsh-desktop-chrome`（已查 npm 名空闲）。
5. Windows 时间点：P1 仅 macOS，P3 视需要补 Windows（是否接受）。
6. P4 官方化的具体入口（官方仓库 / 发布流程）在 P3 结束后确认。
