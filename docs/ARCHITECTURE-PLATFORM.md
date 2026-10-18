# 平台扩展架构（Windows / Linux / Edge / Brave / Firefox / 云）

> 2026-10-17 · 基线：provider 0.1.87 / 扩展 0.1.86 / 40 工具
> 目标：给"扩平台"留出结构性空间，而不是把 macOS Chrome 的假设复制到每个平台。

## 0. 现状（要保留的资产）

```
DSH provider (index.js)
  ├─ BackendRouter (src/backend.js)         ← 已存在：backend 选择 + AsyncLocalStorage
  │    ├─ desktop: BridgeServer + native host + MV3 extension
  │    └─ headless: HeadlessDriver (CDP, 本地 Chromium)
  ├─ chrome_* 工具（src/tools.js，40 个）    ← 工具语义层，不应知道平台细节
  ├─ liveview / screencast-guard / policy  ← 与 backend 解耦
  └─ install（macOS native host manifest）
```

已经具备的三个抽象：**工具语义层**、**backend 路由**、**两套 backend 实现**。扩平台要做的不是重写工具，而是把"平台/浏览器/传输"拆成可替换的实现。

## 1. 目标抽象

```
Tool layer (chrome_*)
   │  request(method, params)   ← 统一方法契约（tab.* / browser.*）
   ▼
Backend registry
   ├─ desktop-extension backend     (本地 Chrome / Edge / Brave)
   ├─ headless backend              (本地 Chromium, 现有)
   ├─ remote-cloud backend          (Browserbase/Steel/自建 VM；未来)
   └─ firefox-extension backend     (未来)
   │
   ▼
Transport registry（按平台）
   ├─ native-messaging (macOS/Linux/Windows)
   ├─ CDP websocket (headless/remote)
   └─ cloud API (remote)
```

### 1.1 统一 backend 接口（建议落文件）

新增 `src/backends/contract.js`（类型 + 文档，不引第三方运行时依赖）：

```js
export const BACKEND_CAPABILITIES = {
  frames: 'frames',      // iframe 深读
  shadow: 'shadow',      // open shadow DOM
  capture: 'capture',    // Network 抓包
  upload: 'upload',
  download: 'download',
  pick: 'pick',          // 需要真人点击
  screencast: 'screencast',
  tabs: 'tabs',          // 多标签/分组
  pause: 'pause',        // USER_SWITCHED 语义
}

// 每个 backend 暴露：
// name, platform, capabilities:Set, status(), request(method,params), dispose()
```

工具层在调用前查 `capabilities`，缺能力返回 `UNSUPPORTED_BACKEND`（headless pick 已是此模式），不要每个工具写 if。

### 1.2 浏览器/平台描述

新增 `src/browsers.js`（配置目录、native manifest 路径、可执行文件名、扩展能力）：

```js
export const BROWSERS = {
  chrome:  { mac: {...}, linux: {...}, win: {...} },
  edge:    { ... },
  brave:   { ... },
  chromium:{ ... },
}
```

现在的 `src/install.js` 把 macOS Chrome 路径硬编码在流程里；扩平台时改为查表 + 一个 `installHost(browser, platform)`。

### 1.3 native messaging 跨平台

| 平台 | manifest 位置/注册 |
|---|---|
| macOS | `~/Library/Application Support/<Browser>/NativeMessagingHosts/<name>.json`（已有） |
| Linux | `~/.config/<browser>/NativeMessagingHosts/<name>.json` |
| Windows | 注册表 `HKCU\Software\<Browser>\NativeMessagingHosts\<name>` 指向 manifest JSON |

host 启动器：macOS/Linux 用 shell wrapper；Windows 用 `.cmd` 或 PowerShell，或让 manifest 的 `path` 指向一个跨平台 launcher（Node 脚本 + 系统 node 路径）。**host.mjs 本身已经是跨平台的**，主要工作在注册与路径。

### 1.4 扩展侧平台差异

- Chrome/Edge/Brave 共用 MV3 扩展，基本零改动；native host manifest 按浏览器目录各写一份；
- Firefox MV3：`browser.*` API 差异（native messaging、background、tabs），需要独立分支/适配层；建议先做 capability 探测 + 最小工具面，不追 40 工具；
- 商店分发：每个浏览器一套打包/隐私说明，CI 出多个 artifact。

## 2. 落地顺序（建议）

1. **抽 contract + capabilities**（0.5 天）：不改行为，只加接口与测试；
2. **install 查表化 + Linux/Win manifest**（2–3 天）：host 先跑起来；
3. **Edge/Brave**（2–3 天）：多写几份 manifest + browser 选择；
4. **商店分发**（2–3 天）：打包/隐私/版本流程；
5. **Firefox 调研**（2 天）：评估是否值得；
6. **remote backend**（后续）：工具层不变，新增实现即可。

## 3. 测试矩阵

| 层 | macOS Chrome | Linux Chrome | Windows Chrome | Edge | headless |
|---|---|---|---|---|---|
| 单元/工具 | 现有 15 套件 | CI ubuntu | CI windows | 同 Chrome | 现有 |
| native host 注册 | 真机 | CI | CI | 真机 | — |
| 工具 e2e | 真机 suite | CI 可选 | CI 可选 | 真机 | headless suite |
| 商店包 | — | — | — | — | — |

先保证：**工具层测试与 backend 无关**（现有 fixture 已如此），平台差异只在 install/transport/backend 层。

## 4. 风险与边界

- 不使用"把用户 Chrome 藏后台"的方案（平台扩展仍走可见浏览器；后台用 headless/云）；
- Windows native messaging 的注册表/权限与杀软误报是主要风险，需要真机验证；
- Firefox 的 native messaging 与 MV3 生命周期差异最大，先调研再承诺；
- 商店审核（debugger/webNavigation）需要提前准备 justification，不要等到最后。

## 5. 本次并行工作的落点

- capture 一致性（test/capture-parity.mjs + docs/CAPTURE-PARITY.md）：确保两套 backend 语义不漂移，扩平台时新 backend 可按同一套语义测试；
- headless 性能（src/headless.js + bench）：remote/云 backend 同样受截图/帧成本影响；
- viewer 自动停真机验证（docs/records/...）：与 backend 无关的行为，扩平台后应复用；
- 本文件：下一轮扩平台的路线图；BACKLOG 里 P1 平台化条目按 §2 拆卡。
