# 平台 bridge / host / 可执行文件审计（E-01）

> 2026-10-19 · 分支 `feat/team-platform`（base `3014180`）
> 范围：`src/bridge.js`、`host/host.mjs`、`src/install.js`、`src/platform.js`、
> `scripts/build-windows-host.mjs`、`tests/platform/`。**未改** headless 核心状态机、
> 工具语义、extension background。
> 契约来源（主仓 `docs/`，本 worktree 基线尚未包含前两份）：`CONTRACTS.md` §1/§6、
> `LIFECYCLE.md`、[WINDOWS-HOST.md](WINDOWS-HOST.md)、[INSTALL-PLATFORM.md](INSTALL-PLATFORM.md)。

## 0. 结论摘要

| 项 | 状态 |
|---|---|
| POSIX socket ↔ Windows named pipe 抽象 | ✅ 代码路径成立；macOS 真跑，Windows 仅静态/CI exe，无真机 |
| hello / hello-ok 协议版本协商 | ✅ 已实现，双向校验，缺失/未知/字符串版本均拒绝 |
| 不兼容稳定错误码 | ✅ `PROTOCOL_VERSION_MISMATCH`（hello-error 帧） |
| 协议不匹配重试 | ✅ 有界：默认 3 次后暂停，`bridge.json` token 变化才恢复 |
| 安装 → 连接 → 一次工具调用 → 退出清理 | ✅ macOS 真跑（`tests/platform/smoke.mjs`） |
| host 版本 | ✅ 构建/安装注入，不再硬编码 `0.0.1` |
| Chrome 可执行文件发现 / 配置优先级 | ✅ headless 已有实现；本审计补文档与缺口清单 |
| Windows / Linux / Edge / Brave 真机 | ❌ 仍是缺口（见 §5） |

## 1. 传输：POSIX socket vs Windows named pipe

### 1.1 路径选择

`src/bridge.js` 的 `bridgeSocketPath()`：

| 平台 | 路径 | 说明 |
|---|---|---|
| macOS / Linux | `<DSH_HOME>/cache/dsh-chrome/bridge.sock` | UNIX domain socket；启动时先删旧 socket，再 `listen`，成功后 `chmod 0600` |
| Windows | `\\.\pipe\dsh-chrome-<sha256(home 小写)前16位>-<pid>` | 命名管道；不含文件系统路径，因此不需要删除；PID 避免崩溃残留的 provider 碰撞 |

host **不自己拼路径**：它读 `bridge.json` 的 `socketPath` 并 `net.connect()`，所以同一份
`host/host.mjs` 在三个平台走同一条代码路径（Windows 只是路径值不同）。Windows 上
`BridgeServer.stop()` 只删 `bridge.json`，不去 `unlink` 管道文件（也没有文件可删）。

### 1.2 审计发现与处理

- **发现**：`BridgeServer` 用宿主 `path.join` 拼 `dir`/`bridge.json`；在 macOS 上以
  `platform:'win32'` 做跨平台测试时，诊断字符串会混用 `/` 与 `\`。已改为目标平台的
  `path.win32` / `path.posix`（`src/bridge.js` 构造函数）。
- **发现**：`bridge.json` 的 `mode: 0o600` 只在文件新建时生效；旧版本留下的 0644
  discovery（含 token）不会被收紧。已在写完后显式 `chmod 0600`（POSIX）。
- **发现**：`server.listen()` 成功后如果写 `bridge.json` 失败（磁盘满、路径被目录占用），
  原实现会留下已绑定的 socket 和 `server` 句柄。已加失败回滚：关闭 server、删除 socket、
  `server` 归零后重新抛错（LIFECYCLE §不变量 6）。
- **Windows 管道 ACL**：Node 的命名管道使用当前用户默认安全描述符；provider 与 host 同用户，
  未额外收紧 ACL（需要原生 API，超出本线）。discovery 文件在用户 profile 下，依赖 profile
  ACL；token 仍是 32 字节随机值，且每次 provider 启动重新生成。
- **套接字路径长度**：macOS UNIX socket 路径上限约 104 字节。测试使用短临时目录前缀；
  真实 `~/.dsh` 路径通常远低于上限，但超长 `DSH_HOME` 会在 `listen` 时报 `EINVAL`，
  属于已知平台限制（不新增兼容层）。

### 1.3 握手与版本协商

线上格式仍是 JSON lines；首帧固定为 `hello`：

```json
{"type":"hello","token":"<32-byte hex>","hostVersion":"0.2.21","protocol":1}
```

provider 校验顺序：**token 先于版本**（错误 token 不泄露版本信息），然后：

- `protocol` 必须是整数且 ∈ `SUPPORTED_PROTOCOL_VERSIONS`（当前 `[1]`）；
- 成功：`{"type":"hello-ok","protocol":1,"hostProtocol":1}`；
- 失败：`{"type":"hello-error","code":"PROTOCOL_VERSION_MISMATCH","message":"...","expected":1,"received":<原值>}`，
  随后关闭连接。**不静默降级，也不接受字符串 `"1"`。**
- `hello` 缺 `protocol` 视为不兼容（`received:null`）。这符合 CONTRACTS §1
  “hello/hello-ok 必须带版本”；测试夹具 `test/bridge-ingress.mjs` 已同步补上 `protocol:1`。

host 侧同样校验：

- `hello-ok.protocol` 必须等于 `HOST_PROTOCOL`；
- `hello-error` 的 `code` 被原样记入 `host.log`；
- `bridge.json` 里若有 `protocol` 且与 host 不一致，host 在连接前就报
  `PROTOCOL_VERSION_MISMATCH`（少一次无意义连接）。

`PROTOCOL_VERSION` / `HOST_PROTOCOL` 现在由测试
`tests/platform/protocol.mjs` 解析源码比对，防止两边漂移。

## 2. host manifest / 权限 / 启动

### 2.1 安装产物（POSIX，macOS/Linux 共用）

| 产物 | 位置 | 权限 | 审计结论 |
|---|---|---|---|
| native manifest | `<browser>/NativeMessagingHosts/com.deepseek.dsh.chrome.json` | 0644 | Chrome 需要可读；`path` 为绝对路径，指向 launcher |
| launcher | `<DSH_HOME>/cache/dsh-chrome/host/dsh-chrome-host` | 0755 | `#!/bin/sh`，三种回退：DSH Electron → 安装时捕获的 node → PATH node |
| host 源码副本 | 同目录 `host.mjs` | 源文件权限 | 与 SEA 共用同一份 host 源码 |
| discovery | 同 cache 的 `bridge.json` | 0600（显式 chmod） | 含 token；与 socket 同目录 0700 |
| INSTALL.md / dev.json | 同 cache | 0600 | 不含页面内容/凭据 |

- native manifest 的 `allowed_origins` 由 extension manifest 的 `key` 推导，固定扩展 ID；
- launcher 在安装时注入 `DSH_CHROME_HOST_VERSION`（版本取自 extension manifest，测试
  `test/version-consistency.mjs` 保证它与 `package.json` 一致）。原因：安装后的 `host.mjs`
  在 cache 目录里，旁边没有 `package.json`，SEA 的 data: URL 也读不到文件；不注入就会退回
  `0.0.0-unknown`，chrome_status 会再次报告一个不存在的版本。

### 2.2 安装产物（Windows）

| 产物 | 位置 | 权限/注册 | 审计结论 |
|---|---|---|---|
| manifest | `{DSH_HOME}\cache\dsh-chrome\native-messaging-hosts\com.deepseek.dsh.chrome.json` | 目录 0700（Windows ACL 继承） | 浏览器通过注册表找到它 |
| SEA host | `{DSH_HOME}\cache\dsh-chrome\host\dsh-chrome-host.exe` | 用户 profile | 找不到 exe 时回退 `.cmd` 并 warn；`.cmd` 预期不可用 |
| 注册表 | `HKCU\Software\<vendor>\<Browser>\NativeMessagingHosts\com.deepseek.dsh.chrome` | 当前用户，无需管理员 | **真 win32 上自动 `reg add`**；失败会打印手动命令；假 Windows 测试不碰真实注册表 |

> 代码与旧文档的偏差已修正：`docs/INSTALL-PLATFORM.md` 之前写“只打印注册表命令”，
> 而 `src/install.js` 自 0.1.99 起在真实 Windows 上会自动写入 HKCU。现在的行为是
> “真机自动写 + 失败/非 Windows 打印手动命令”。

SEA 构建（`scripts/build-windows-host.mjs`）：

- `makeSeaEntry({ hostVersion })` 在 CJS bootstrap 里注入
  `process.env.DSH_CHROME_HOST_VERSION = "<package version>"`，再动态 import 内嵌
  `host.mjs`；这是 CONTRACTS §6 “HOST_VERSION 由构建注入”的落点；
- `packageVersion(root)` 读 `package.json`；`--dry-run` / `--json` 会显示 `host version`；
- `useCodeCache:false`、CJS main、asset 方案不变（见 WINDOWS-HOST.md）。

### 2.3 启动与退出

- Chrome 启动 host 时，host 可以比 provider 先起来：`connectBridge()` 读不到
  `bridge.json` 就按指数退避重试（500ms → 5s 上限），进程不退出；provider 重启后
  host 会重新读 discovery 并重连（`test/host-reconnect.mjs` 覆盖）。
- `stdin` EOF（Chrome 关闭 native port）→ 清理 timer/watcher/socket → exit 0；
- `SIGTERM`/`SIGINT` 同样走 `shutdown(0)`；
- 正常退出后 provider 的 `BridgeServer.stop()` 删 `bridge.sock` + `bridge.json`
  （Windows 只删 `bridge.json`），并 fail 掉 pending 调用（`NOT_CONNECTED`）。

## 3. Chrome 可执行文件发现 / 配置优先级

### 3.1 两个 backend 不是一件事

| backend | 怎么找到浏览器 | 本审计结论 |
|---|---|---|
| `desktop`（MV3 + native messaging） | **不启动 Chrome**，扩展在用户正在用的浏览器里；安装器只决定把 manifest 装给哪个浏览器（`DSH_CHROME_BROWSER`） | 无“可执行文件发现”需求；运行时也没有多浏览器连接 |
| `headless`（CDP） | `src/headless-browsers.js` 用 `src/platform.js` 的候选表解析并校验可执行文件 | 已有实现；本审计补文档、列出缺口 |

因此“Chrome 可执行文件发现”只对 headless 生效；`DSH_CHROME_BROWSER` **不是** headless
的 engine 选择器（release notes 0.2.18 已拆分）。

### 3.2 headless 选择优先级（高 → 低）

1. 显式二进制：`DSH_HEADLESS_CHROME`（env）→ config `browser.headless.chromeExecutable`；
2. 显式引擎：`DSH_HEADLESS_ENGINE`（env）→ config `browser.engine`；
3. 默认：Chrome → Chromium（只有这条路径允许回退；两者都没有时 `headlessSupported()` 为 false）。

规则：

- **显式选择永不静默回退**：指定 Edge 但没装 → `HEADLESS_EXECUTABLE_NOT_FOUND`，
  错误里带候选路径；未知引擎 → `HEADLESS_ENGINE_UNKNOWN`；
- 显式二进制比显式引擎优先（二进制是精确路径）；两者同时给出时，引擎字段只作为
  元数据，不校验二进制是否真属于该引擎（**已知缺口**，见 §5）；
- 候选来自 `BROWSERS` 表，按平台展开 `~` / `%VAR%` / `{dshHome}`；Linux 裸命令名
  按 `PATH` 查找，mac/Windows 用表内绝对路径；
- 结果传给 `HeadlessDriver`（含交互登录窗口），provider 启动时一次性判定；
  `chrome_status` 目前不暴露 engine/实际路径（**缺口**）。

### 3.3 配置层

- 配置优先级：`~/.dsh/cache/dsh-chrome/config.json` → `~/.dsh/config.json` →
  `<cwd>/.dsh-chrome/config.json`（后者覆盖前者）→ DSH plugin entry（最高，仅安全字段）；
- 环境变量覆盖 config；config 未知/非法值会告警并落回默认；
- **未接**：`browser.engine` 的 per-context 透传（`chrome_context create {engine}`）、
  `chrome_status` 的 engine 字段、`DSH_CHROME_BROWSER` 运行时选择；
- 显式 `browser.headless.chromeExecutable` 里的 `~` 不会被展开（只有平台表候选展开
  `~`），属于已知缺口；请写绝对路径或用 `DSH_HEADLESS_CHROME` + 自己展开。

## 4. 失败重试不能无限起 host / Chrome

审计“谁会 spawn 谁”：

| 动作 | 谁触发 | 是否自动重试 | 结论 |
|---|---|---|---|
| provider 写安装资产 | `createBridgeRuntime.start()`，provider 启动一次 | 否 | 失败只记日志/状态，重载 provider 才重试 |
| provider 起 bridge | 同上，一次 | 否 | `BridgeServer` 没有重试循环 |
| Chrome 起 host | Chrome（native messaging） | 由浏览器决定；host 自己只在同一个进程内重连 bridge | host 不会 spawn 自己，也不会 spawn Chrome |
| host 连 provider | host 启动/断线 | 是，500ms→5s 指数退避，**普通断线可无限** | 不 spawn 新进程；provider 不在时这是必要行为 |
| 协议不兼容 | host 与 provider | **有界**：默认 3 次后暂停；`bridge.json` token 变化才恢复 | 不会每 5s 永久重试一个不可能成功的握手 |
| headless 起 Chrome | 首次工具调用 / `ensureStarted()` | 同 driver 的并发启动合并成一个 `startPromise`；失败不自动重试 | 下一次工具调用才会再试；无后台重试循环 |
| 工具调用本身 | 模型/工具层 | 由调用方决定 | 本线不改工具语义 |

扩展侧（只审计，未改 `extension/background.js`）：`ensurePort()` 在需要时调用
`chrome.runtime.connectNative`；`onDisconnect` 里不立即重连，而是创建 0.2 分钟的一次性
alarm，另有 1 分钟周期 alarm。也就是说 Chrome 最多约每分钟拉起一次新 host——这是浏览器
侧行为，provider 无法直接限制。本线的配合点是：**协议不匹配时 host 不退出**，只暂停到
`bridge.json` 变化；这样 Chrome 不会因为版本不兼容而反复拉起新 host。若 host 因其他
`fail()` 路径退出，仍可能被扩展 alarm 重新拉起（已知边界，不在本线修改范围）。

协议不匹配的恢复语义：

- host 在 `host.log` 写 `protocol mismatch (...) [PROTOCOL_VERSION_MISMATCH] attempt N/M`；
- 达到上限写 `protocol negotiation failed repeatedly; reconnect paused until bridge.json changes`，
  并只保留一个低频 discovery 轮询 timer（默认 5s，`DSH_HOST_MISMATCH_POLL_MS` 可调）；
- provider 升级/重启后生成新 token → host 允许一次新的协商；
- 该路径**不会**启动新的 host 或 Chrome 进程。

可调环境变量（测试/排障）：

| 变量 | 默认 | 作用 |
|---|---|---|
| `DSH_HOST_RETRY_BASE_MS` | 500 | 普通重连初始退避 |
| `DSH_HOST_RETRY_MAX_MS` | 5000 | 普通重连退避上限 |
| `DSH_HOST_MAX_PROTOCOL_MISMATCHES` | 3 | 协议不匹配最多尝试次数 |
| `DSH_HOST_MISMATCH_POLL_MS` | = retry max | 暂停后检查 `bridge.json` 变化的间隔 |

## 5. 验证矩阵与缺口

| 平台/浏览器 | 安装路径表 | manifest/launcher | host↔bridge 真跑 | 一次工具调用 | 退出清理 | 真 Chrome native messaging |
|---|---|---|---|---|---|---|
| macOS Chrome | ✅ 测试 | ✅ 测试 | ✅ `tests/platform/smoke.mjs` | ✅ | ✅ | ❌ 需人装扩展（日常 INSTALL.md） |
| macOS Edge/Brave/Chromium | ✅ 表 | ⚠️ 仅路径写入，未真装 | — | — | — | ❌ |
| Linux Chrome | ✅ 表 | ✅ 临时 home 写文件 | ✅ 同一 POSIX 逻辑（未在本机跑） | 同左 | 同左 | ❌ 真机/CI 缺 |
| Linux Edge/Brave/Chromium | ✅ 表 | ⚠️ 仅写文件 | — | — | — | ❌ |
| Windows Chrome | ✅ 表 | ✅ 静态 + CI 构建 exe | ❌ 命名管道未真机 | ❌ | ❌ | ❌ |
| Windows Edge/Brave/Chromium | ✅ 表 | ⚠️ 注册表键按文档 | ❌ | ❌ | ❌ | ❌ |

已跑（macOS）：

```bash
CI=1 node tests/platform/protocol.mjs
CI=1 node tests/platform/smoke.mjs
CI=1 node test/p0-bridge.mjs
CI=1 node test/bridge-auth.mjs
CI=1 node test/bridge-windows.mjs
CI=1 node test/bridge-ingress.mjs
CI=1 node test/host-reconnect.mjs
CI=1 node test/host-pending.mjs
CI=1 node test/install-platform.mjs
CI=1 node test/platform-windows-host.mjs
```

Windows 缺口（需要一台真 Windows 或 windows-latest 上的扩展测试）：

1. 命名管道 `\\.\pipe\...` 下 provider/host 实际连通（当前只有路径单测）；
2. `dsh-chrome-host.exe` 被 Chrome `CreateProcess` 拉起、stdin/stdout 句柄与 EOF 行为；
3. HKCU 注册表 → manifest → exe 的整链；SmartScreen/杀软/路径含空格/arm64；
4. 多浏览器（Edge/Brave/Chromium）注册表键与扩展加载；
5. `reg add` 失败/无权限时的手动指引是否足够。

Linux 缺口：

1. 真实 Chrome/Chromium 读取 `~/.config/<browser>/NativeMessagingHosts/` 并拉起 POSIX
   launcher 的端到端链路；
2. 无桌面会话/无 `$HOME` 写权限/Flatpak/Snap 浏览器的路径差异；
3. `google-chrome` / `chromium` 在 `PATH` 中的实际解析（已有纯函数测试，无真机）。

其他已知缺口：

- 显式 `executable` 与 `engine` 同时给出时不做一致性校验；
- headless 候选表缺 Snap/Flatpak 常见路径（`/snap/bin/chromium` 等），未真机验证前不贸然加；
- 桌面 backend 仍是单 socket / 单浏览器；多浏览器同时连接未做；
- `chrome_status` 不显示实际 headless engine/可执行文件路径。

## 6. 测试入口

```bash
# 协议版本协商 + 有界重试 + 构建注入（无需 Chrome）
node tests/platform/protocol.mjs

# 安装 → 连接 → 一次工具调用 → 退出清理（macOS/Linux POSIX；Windows 显式 SKIP）
node tests/platform/smoke.mjs
```

两个脚本都只写临时 `DSH_HOME`/临时 home，不碰真实 `~/.dsh`、不启动真实 Chrome。
`npm test` 仍由集成分支统一接入（`package.json` 属 CONTRACTS §7 的集成文件，本线不改）。
