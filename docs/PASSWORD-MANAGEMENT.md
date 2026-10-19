# 密码与凭据管理（PASSWORD-MANAGEMENT）

> 状态：**设计稿；P1 安全基础 MVP 已落地（仅 `src/credentials.js` + 测试，未接工具/UI/驱动）**。当前 worktree `feat/password-p1`（base `fd846bb`，`0.2.15`，2026-10-19）。
>
> **已实现（2026-10-19）**：opaque `credentialId`、macOS Keychain 只读适配器（`security find-generic-password`，可注入 `exec`）、Windows/Linux 显式 `UNSUPPORTED_PLATFORM`、`fill()` 接口（只返回 `{filled:true}`，sink 未接 driver）、`test/credentials.mjs` 已接入 `npm test`。**仍未实现**：工具/provider 接线、真实填充、UDS/native helper、保存/删除、Windows/Linux 存储。详见文末「P1 安全基础 MVP」。
>
> **版本注意**：`0.2.14` 已包含一项与本文直接相关的修复：`src/operation-log.js` 对 `chrome_type` 的 `text` 做工具级脱敏（`TYPE_TOOLS`），`test/operation-log.mjs` 已同步。**但**这只是一条出口；`chrome_type` 的 `result.value`/render、headless selection、viewer 输入回包、`chrome_verify` steps、capture 的 `pwd/otp/cvv`/fragment 等仍未修。本文按 `0.2.14` 现状记录，不把一项修复扩展成“密码管理已安全”。
>
> 范围：本插件的密码/凭据处理、登录自动化边界、与操作系统凭据库的集成方案。本文只做现状核对和方案设计；本次任务**没有改任何代码**，作者只新增/修改了本文。文中所有“建议新增”“目标”“应”都不是已实现能力。
>
> 安全前提：本文不写任何真实密码、API key、token 或 cookie；示例只用哨兵值（如 `DSH_SENTINEL_PW_DO_NOT_USE`）。

---

## 0. 结论先行

1. **当前没有密码管理器，也没有 autofill；macOS Keychain 只读适配器仅作为 P1 安全基础 MVP 落在 `src/credentials.js`（未接工具/驱动/UI），Windows Credential Manager / Linux Secret Service 仍未实现。** 登录主要靠用户在**可见的专用 Chrome 窗口**里手动完成（`chrome_headless_login`），或者复用用户日常 Chrome 已有的登录态。插件没有“保存密码/自动填充/读取密码”的工具。
2. **当前和密码有关的只有“显示层打码”和“网络抓包脱敏”。** 快照对 `type=password`/支付字段显示 `••••`，HTML 的 `value` 属性打码，extension 的选区读取会拒绝敏感字段；抓包对 URL secret 参数、JSON/form 的 secret 键、Bearer/JWT/sk-/AKIA 形态做掩码。这些都不是密码管理，也不覆盖所有出口。
3. **最先要处理的缺口是 `chrome_type` 的明文出口。** `0.2.13` 及更早的 `args.text` 不匹配操作日志的键名脱敏规则；`0.2.14` 已提交 operation-log 对 `chrome_type.text` 的工具级脱敏（`TYPE_TOOLS`），但 `chrome_type` 的 `result.value`/render、headless 选区、viewer 输入回包、`chrome_verify` steps 等仍未修。用临时 `DSH_HOME` + 哨兵值实测：`0.2.14` 下 `operations.jsonl` 的 `args.text` 已是 `«redacted»`，`result.value` 仍会被 operation-log 的 allowlist 丢弃、但 tool result/render 仍会把它交给模型。
4. **建议的方向：OS 凭据库 + 独立 native helper + 只传“站点/用户名”不传明文。** 模型只能请求“把某站点的已保存凭据填进当前页面”，helper 在内部取密并完成填充，返回回执；provider、`host.mjs`、DSH 会话日志、`operations.jsonl`、`host.log` 都看不到明文。桌面 Chrome 的程序化填充**不作为 MVP 承诺**；headless context 的填充可以做成 helper 内部 CDP 操作。
5. **分阶段：先修日志/回显泄漏（P0），再做 macOS helper + headless 填充（P1），然后 Windows/Linux 和桌面 native host（P2），最后才是 2FA/TOTP 与 passkey 人工接管（P3）。** passkey 不可导出，不能承诺自动化。
6. **不要过度承诺：** 当前没有 helper、没有凭据工具、没有截图逐像素脱敏、没有 DSH 会话日志擦除能力、没有 CI secret scan；同用户本机进程、备份/云同步、键盘记录器、已解锁的 Keychain 都不在插件能完全防住的范围内。

---

## 1. 现状

### 1.1 抓包（capture）的脱敏在哪里

脱敏规则是 **headless 与 extension 两份同源实现**，`test/capture-parity.mjs` 要求两边行为一致；H1 之后桌面侧的键名、fragment、inline 规则已与 headless 对齐：

| 位置 | 内容 |
|---|---|
| `src/headless-redact.js` | headless 侧的 URL/body 脱敏、body 预算、截断 |
| `extension/background.js:1319-1454` | 桌面扩展侧的同一套规则（`CAPTURE_SECRET_PARAM`、`CAPTURE_INLINE_SECRET`、`redactFragment`、`redactUrl`、`maskSecretsInText`、`redactJsonValue`、`redactBodyText`、`materializeCaptureBody`） |
| `src/headless-events.js:12-17,58-163` | headless 把 CDP `Network.*` 事件映射进 capture，并调用上面的脱敏 |
| `test/capture-parity.mjs` | 两侧 URL、JSON、form、缓存 body、真实 Chrome 路径的对照测试 |
| `test/capture-redact.mjs` | 桌面路径的哨兵测试：query/fragment/JSON/form/plain 文本/headers 都不泄漏（H1） |

具体规则（以 `src/headless-redact.js` 为准）：

- **URL**：`redactUrl()` 把 URL 的 `username`/`password`（userinfo）替换为 `«redacted»`；查询参数名命中 `CAPTURE_SECRET_PARAM`（含 `pwd`/`otp`/`cvv`/`auth` 整段键名）的值替换为 `«redacted»`；fragment 里的 `key=value` 同样按键名脱敏，其余部分走 inline 规则；URL 超过 2048 字符截断（`src/headless-redact.js:26-68`）。
- **JSON body**：解析后按键名递归脱敏，键名命中 `CAPTURE_SECRET_PARAM` 的值替换；字符串值再走 `maskSecretsInText()`（`src/headless-redact.js:70-81`）。
- **form body**：`application/x-www-form-urlencoded` 按 `name=value` 拆分，键名命中规则的替换（`src/headless-redact.js:93-101`）。
- **普通文本**：替换 `Bearer ...`、`sk-...`、JWT、`AKIA...`，以及 `password=...` / `token: ...` 这类 inline `key=value` 形态（`src/headless-redact.js:28-35`）。
- **非文本 MIME**：不保留内容，只写 `<binary N chars>`（`src/headless-redact.js:109-123`）。
- **预算**：单响应 body 4096 字符、单请求 body 2048 字符、单次 capture 总 body 8 MiB；超预算写 `<body not captured: capture body budget exceeded>`（`src/headless-redact.js:13-15,109-123`）。
- **headers 根本不采集**：capture 只从 CDP `Network.*` 事件和 `Network.getResponseBody` / `Network.getRequestPostData` 取数据，不保存 `request.headers` / `response.headers`；Cookie、Authorization、Set-Cookie 不会进入 capture 缓冲（包括 `*ExtraInfo` 事件）。工具描述也明确写了这一点（`src/tools-capture.js:20-21,120-121`）。
- **启动确认**：`chrome_capture_start` 每次都走 `hardConfirmAsk`，没有配置旁路；确认卡写明目标 tab 与 origin；默认 `storeBodies: false`（只记 metadata），只有显式 `storeBodies:true` 才记录 body；10 分钟自动停（`src/tools-capture.js:15-90`、`extension/background.js:1600-1655`、`src/headless.js:1057-1115`）。
- **脱敏不是加密**：`Network.getResponseBody` 返回的原始明文先进入 Chrome/DevTools 和 driver/扩展内存，之后才被字符串替换；capture 缓冲里的 `«redacted»` 不代表原始 body 从未存在。

**H1 关闭的缺口**（Q33 已先修 headless，H1 把桌面侧对齐）：

- ~~`CAPTURE_SECRET_PARAM` 不匹配 `pwd`、`otp`、`cvv`、`auth`~~：两侧均已匹配（`auth` 只匹配整段键名，`author` 不受影响）。
- ~~`redactUrl()` 不处理 fragment~~：两侧均已按键名/inline 规则处理 `#access_token=...`、`#password=...`。
- ~~普通文本不认 `password=...`~~：两侧均已把 inline `key=value` 纳入 `maskSecretsInText()`。
- 仍存在的差异：`documentURL` 在 extension 侧会脱敏，headless 侧可能省略；`test/capture-parity.mjs:777-781` 把它记为容忍的差异。

### 1.2 登录：主要是 visible / manual

现状的登录路径只有两类：

1. **用户日常 Chrome**：用户自己已经登录；插件通过扩展操作这个浏览器，复用现有 cookie/登录态。插件不读取 Chrome 的密码库，也不导入 cookie。
2. **headless 专用 profile**：`chrome_headless_login` 打开一个**可见的专用 Chrome 窗口**，用户在窗口里手动登录；关闭窗口后 cookie 留在 headless profile，之后 `backend:"headless"` 复用。

关键实现：

| 位置 | 行为 |
|---|---|
| `src/tools-login.js:9-81` | `chrome_headless_login` 的 `start` / `show` / `status` / `finish`；`start`/`show` 每次都 `hardConfirmAsk` |
| `src/headless-login.js:11-41` | `loginStart()` 用 `--user-data-dir=<headless profile>` 打开可见 Chrome；没有 remote-debugging 参数 |
| `src/headless-login.js:43-57` | `showVisible()` 暂停当前 headless，把当前页面在可见窗口打开；记录 `resumeUrl` |
| `src/headless-login.js:69-81` | `loginFinish()` 关闭可见窗口；cookie 留在 profile |
| `src/headless.js:292-294` | 登录窗口打开期间，headless 请求返回 `HEADLESS_LOGIN_OPEN` |
| `docs/HEADLESS.md:86-111` | 文档明确：headless profile 默认不导入日常 Chrome cookie；`start`/`show` 是唯一把登录态写入 headless profile 的入口 |
| `src/headless-launch.js:20-37` | headless 启动参数：`--user-data-dir`、`--headless=new`、`--disable-sync`、`--disable-extensions`；没有 `--password-store` 覆盖 |

**没有的东西**（这是本文要补的）：

- 没有密码管理器：仓库里没有 keytar / autofill / Credential Manager / Secret Service 的 provider 集成；只有 `src/credentials.js` 的 macOS Keychain 只读适配器（P1 安全基础 MVP，未接 provider/工具）。
- 没有“向密码字段输入”的硬确认接线：`docs/APPROVAL.md:80` 明确写“密码字段仍未接入”；`docs/DESIGN.md:43` 把“自动登录、读取密码”列为 V1 非目标。
- 没有凭据工具、没有 credential helper、没有 native messaging 凭据 host。
- 没有 passkey/WebAuthn 处理，没有 TOTP/2FA 自动化。
- 插件自身没有 API key：`src/config.js:49` 的 `SECRET_KEY` 会拒绝键名像密码/secret/token/api_key/credential/private_key 的配置；`docs/PLUGIN-SETTINGS.md:117` 明确“本插件目前没有需要凭据的设置”。

### 1.3 已有的“打码”不是密码管理

| 表面 | 当前行为 | 位置 |
|---|---|---|
| 扩展快照控件 | `type=password`/`hidden`、`autocomplete` 含 `cc-`/`password`、name 含 card/otp/token/secret/cvv 的值显示为 `••••` | `extension/background.js:2971-2980` |
| headless 快照控件 | `kind` 含 password/card/secret 的值显示为 `••••` | `src/headless-page-actions.js:63-67` |
| 扩展 HTML 读取 | `value="..."` 一律替换为 `value="••••"`；名称像 token/secret/csrf/password 的属性和值也打码 | `extension/background.js:3618-3632` |
| 扩展选区 | 焦点在 password/hidden/支付/OTP/secret 字段时返回 `SENSITIVE_SELECTION` | `extension/background.js:3801-3816` |
| 抓包 | 见 §1.1 | `src/headless-redact.js`、`extension/background.js` |
| 操作日志 | 按键名脱敏、URL 去 userinfo/secret 查询、结果走 allowlist；`0.2.14` 另对 `chrome_type.text` 做工具级脱敏 | `src/operation-log.js:73-77,300-350,491-503,509-562` |
| 截图 | **不做逐像素脱敏**；密码框通常原生显示圆点，但页面点“眼睛”后截图会看到明文 | `src/tools-media.js`、`host/host.mjs:447-461` |

这些打码只覆盖“已知字段类型的显示/读取路径”，不能防止用户在普通文本框里输入密码、不能防止页面把密码写进页面正文、不能防止 `chrome_type` 的回显、也不能防止截图。

### 1.4 当前会泄露明文的路径（P0）

下面这些是**现状实测/代码可证**的问题。`0.2.14` 只修了 `chrome_type.text` 的 operation-log 一条；其余仍是现状。不要把一条修复当成全部已修。

#### 1.4.1 `chrome_type` 的 `text`：`0.2.13` 会进操作日志，`0.2.14` 已做工具级脱敏

- `0.2.13` 及更早：`chrome_type` 的参数是 `text`（`src/tools-input.js:288-320`），`execute()` 把 `text` 直接传给 `tab.type`（`src/tools-input.js:346-358`）。`src/operation-log.js:73-77` 只按键名匹配 `pass(word|wd|phrase)?`、`secret`、`token`、`api_key`、`authorization`、`cookie`、`session_id`、`csrf`、`xsrf`、`signature`、`credential`、`private_key`；**`text` 不在其中**，所以 `args.text` 会以最多 160 字符的明文写进 `~/.dsh/cache/dsh-chrome/operations.jsonl`（`src/operation-log.js:382-390`）。
- `0.2.14`（提交 `d948641`）：`src/operation-log.js:491-503` 已加入 `TYPE_TOOLS = new Set(['chrome_type'])`，在 `summarizeArgs(args, tool)` 里把 `chrome_type` 的 `text` 替换成 `«redacted»`；`test/operation-log.mjs` 的断言从“截断到 160 字符”改为“等于 `«redacted»`”。`node test/operation-log.mjs` 当前 13 项全过。
- 实测（临时 `DSH_HOME` + 哨兵值，不写真实密码）：
  - `0.2.13` 记录：`"args":{"ref":7,"text":"DSH_SENTINEL_PW_DO_NOT_USE"}`。
  - `0.2.14` 记录：`"args":{"ref":7,"text":"«redacted»"}`；`result.value` 仍被 operation-log 的 allowlist 丢弃，但 tool result 仍包含它（见 1.4.2）。
- **不要把这项修复说成“密码管理已安全”**：它只覆盖 `chrome_type` 的 operation-log args，不覆盖 result/render、DSH 会话日志、headless 选区、viewer、`chrome_verify` steps 或 capture。

#### 1.4.2 `chrome_type` 的字段值返回给模型

- 扩展的 `typeIntoRef()` 返回 `{ ok: true, value: element.value, submitted }`（`extension/background.js:3285-3337`）；`element.value` 对 `type=password` 也是明文。
- headless 的 `typePage()` 返回 `{ ok: true, value: valueAfter.slice(0, 200), ... }`（`src/headless-page-actions.js:155-214`）。
- `chrome_type` 的输出 schema 有 `value`，render 直接打印 `value now "..."`（`src/tools-input.js:321-344`）。这个工具结果会进入模型上下文，也会进入 DSH 的会话记录。
- `chrome_type` 当前没有目标字段类型检查，也没有硬确认；`guard()` 只按普通写动作处理（`src/tools-input.js:346-347`），在 `danger-full-access` 下不会额外弹卡。`docs/APPROVAL.md:80` 也确认“密码字段仍未接入”。

#### 1.4.3 `chrome_verify` 的 `type` 步骤同样带明文

- `chrome_verify` 的步骤 `{action:"type", text:"..."}` 原样传给 `driver.request('tab.type', ...)`（`src/tools-verify.js:141-143`）。
- 整个 `args.steps` 会被 `operation-log.js` 的通用参数摘要记录；`text` 不敏感，所以同样可能落盘。artifact 的 JSON report 目前不包含 steps（`src/tools-verify.js:82-94`），但操作日志会包含。`0.2.14` 的 `TYPE_TOOLS` 只覆盖 `chrome_type`，不覆盖 `chrome_verify`。

#### 1.4.4 headless 选区没有敏感字段保护

- 扩展的 `readSelection()` 会拒绝敏感字段（`extension/background.js:3801-3816`）。
- headless 的 `currentSelection()` 没有这个检查：只要焦点在 input/textarea，就直接返回 `active.value.slice(selectionStart, selectionEnd)`（`src/headless-page-actions.js:217-227`）。在 headless 页面上选中密码再调用 `chrome_selection`，明文会进入工具结果。

#### 1.4.5 viewer 的输入回包会显示明文

- viewer 的 `type` 输入调用 `driver.tab.type` 后返回 `{ value: result?.value ?? null, submitted }`（`src/viewer-input.js:62-73`）。
- viewer 页面把结果 `short(result)` 显示在状态栏（`src/viewer-html.js:123-149`）。如果用户在 viewer 里往密码框输入，明文会出现在 viewer 页面状态栏，可能被截图/肩窥；这条不经过 `operations.jsonl`，但仍然是 UI 泄漏。
- viewer 的 `chrome_screencast`/截图本身不做像素脱敏。

#### 1.4.6 抓包规则缺口

- `pwd`/`otp`/`cvv` 键名不匹配 `CAPTURE_SECRET_PARAM`，JSON/form 会保留值。
- URL fragment 不脱敏。
- 普通文本不识别 `password=...` 形态。
- 这些在 P0 应该补齐，或明确写进 capture 的“已知限制”，避免用户以为抓包已经安全到可以抓登录请求。

#### 1.4.7 DSH 会话日志是下游

DSH 会把工具调用参数/结果写进会话记录。本机实测路径形如：

```text
$DSH_HOME/sessions/<workspace>/<session-id>/session.v4.jsonl.zstd
```

它是压缩的 JSONL，不是加密文件；同用户进程、备份、云同步都可能读到。插件没有 API 去改写或删除它。**唯一可靠的治理点是在工具参数/结果进入 DSH 之前就不产生明文**。如果用户已经用 `chrome_type` 输入过密码，应该按“凭据已暴露”处理（改密、清理相关日志/会话记录、检查备份），而不是只删 `operations.jsonl`。

### 1.5 明确不存在的能力

- 没有密码管理器、密码保险库、凭据列表 UI。
- 没有 autofill（包括 Chrome 自带密码管理器的程序化调用）。
- 没有完整的 Keychain / Credential Manager / Secret Service 集成；`src/credentials.js` 只有 macOS Keychain 只读适配器（P1 安全基础 MVP，未接工具/驱动）。
- 没有 credential helper、没有 `credentials.*` 协议。
- 没有 `chrome_type` 的 `credential` 参数；没有“用已保存凭据填充”的工具。
- 没有 passkey/WebAuthn/TOTP/2FA 自动化。
- 没有截图像素级脱敏；没有“眼睛切换”检测。
- 没有 DSH 会话日志的擦除/脱敏能力。
- 没有 CI secret scan；没有凭据泄漏的自动化扫描脚本。
- 没有跨平台凭据存储实现：macOS 只有只读 MVP，Windows/Linux 只有接口占位与 `UNSUPPORTED_PLATFORM`。

---

## 2. 威胁模型

### 2.1 信任边界

```text
模型 / DSH 会话（可能离开本机，发往模型服务商）
  │  tool args / results / snapshots / screenshots
  ▼
provider 插件（本机 Node 进程，index.js + src/*）
  │  bridge.sock（0600 + 随机 token）
  ▼
host.mjs（Chrome native messaging relay）
  │  native messaging
  ▼
Chrome MV3 扩展（固定 ID）
  │  chrome.debugger / chrome.tabs
  ▼
用户的真实 Chrome（登录态、密码管理器、cookie）

另有一条本文建议的旁路（`credentials` 模块已落地，helper/UDS/driver 未实现）：

provider ── credentials.sock（0600 + token + peer UID）── credential helper（native）
                                                              │
                                                              ├─ OS 凭据库（Keychain / Credential Manager / Secret Service）
                                                              └─ headless CDP → Chrome（只有 helper 内部取密并填充）
```

信任假设：

- 操作系统用户边界有效；同用户进程之间**不是**强隔离。本文不承诺防住同用户恶意进程、root/admin、内核级键盘记录器。
- DSH 本身、模型服务商、Chrome/OS 的更新链是可信的；页面内容、控制台、网络响应、截图内容都是**不可信数据**。
- 扩展 ID 由 manifest `key` 固定；native messaging manifest 的 `allowed_origins` 只允许这个扩展（`src/install.js:380-398`）。
- 密码/凭据只应存在于 OS 凭据库和 helper 进程内存；provider、host、扩展（MVP）都不应持有明文。

### 2.2 资产

- 站点密码、passphrase。
- TOTP seed / 一次性验证码（如果未来支持）。
- passkey/WebAuthn 私钥（通常不可导出，由 OS/浏览器保管）。
- 登录后的 session cookie / token（Chrome profile 里）。
- 插件自身的 API key（当前没有；未来如果有）。
- viewer token / access capability。
- 审计与操作日志（本身不含密码，但会暴露站点、账号、时间、动作）。

### 2.3 表面逐项

| 表面 | 位置/内容 | 谁能读 | 当前控制 | 残余风险 |
|---|---|---|---|---|
| **模型上下文** | tool args/results、snapshot 文本、a11y、截图、capture body | 模型服务商、DSH 会话 | 打码、capture 脱敏、审批 | `chrome_type` 结果值；截图/页面正文；模型服务商留存 |
| **DSH 会话日志** | `$DSH_HOME/sessions/<workspace>/<session>/session.v4.jsonl.zstd` | 同用户、备份/云同步 | 无（插件不控制） | 工具参数/结果里的明文会被持久化；压缩≠加密 |
| **操作日志** | `~/.dsh/cache/dsh-chrome/operations.jsonl`，0600，4 MiB 轮转 | 同用户、备份 | 键名脱敏、URL 去 userinfo/secret、结果 allowlist、单行 2 KiB；`0.2.14` 对 `chrome_type.text` 脱敏 | `chrome_verify.steps[].text` 仍可能落盘；其他工具的自定义字段 |
| **审计日志** | `~/.dsh/cache/dsh-chrome/audit.jsonl`，0600 | 同用户 | 只记 ts/session/tool/origin/tabId/action/decision/reason | action 文本可能含路径/选择器；不应含密码 |
| **host 日志** | `~/.dsh/cache/dsh-chrome/host.log`，0600 | 同用户 | 只记事件/错误/截图路径，不记 payload | host 进程内存仍会看到 relay 的明文帧；崩溃转储可能包含 |
| **浏览器 profile** | 日常 Chrome profile；headless `~/.dsh/cache/dsh-chrome/headless/profile`；context `~/.dsh/cache/dsh-chrome/profiles/<id>` | 同用户、Chrome 自身、备份 | context profile 显式 0700（`src/contexts.js:77-78`）；ephemeral 关闭时删除（`src/contexts.js:109-115`）；默认 headless profile 由 `mkdir` 创建，权限随 umask（`src/headless.js:302-303`、`src/headless-login.js:22`） | Chrome 的 cookie/Login Data 落盘；Linux 无 keyring 时可能弱加密；备份/同步 |
| **扩展 storage** | `chrome.storage.local`：`dshSessions`、`dshDiag`、`dshActiveWindows`、`dshSelfHeal`；`chrome.storage.session`：`dshCaptureMeta`；`dshSidePanelUrl` | 能读 profile 的同用户进程 | 不存凭据；只存会话映射/诊断 | `storage.local` 是 profile 里的未加密存储（LevelDB），同 profile 可读；不要往里放 secret |
| **viewer / screencast** | `context-viewer-token`、`live-token`（0600）；`screencast/latest.jpg`；viewer HTML 内嵌 token+access | 同用户、loopback 请求者、截图观看者 | loopback only + token + per-context access + 不暴露 CDP | token 在 URL/历史里；截图是像素；viewer 输入回包显示 value |
| **截图/产物** | `~/.dsh/cache/dsh-chrome/screenshots/`、headless/profile 下的 screenshots、`artifacts/verify-*`、PDF | 同用户、备份 | 截图文件 0600、artifact 目录 0700、截图归属台账 | 无像素脱敏；密码“眼睛”切换后可见；artifact 默认保留最近 50 次 |
| **备份/云同步** | Time Machine、iCloud/Dropbox 等 | 备份服务/设备 | 无 | `.dsh` 目录可能被整体同步；本文不控制 |
| **同用户进程** | 任意本机程序 | 同用户 | OS 用户边界 | 可读日志/会话/profile；本文不承诺防住 |
| **OS 凭据库（未来）** | Keychain / Credential Manager / Secret Service | 同用户（在解锁状态下） | helper 访问控制、用户 presence | 解锁会话内同用户可请求；helper 被替换/注入则失守 |

### 2.4 非目标 / 不承诺

- 不防 root/admin、内核级恶意软件、键盘记录器、屏幕录制。
- 不防同用户恶意进程读取 `~/.dsh`、Chrome profile 或备份。
- 不防模型服务商留存/训练策略；这是 DSH/服务商的边界。
- 不做反检测、绕过 CAPTCHA、绕过付费墙。
- 不做 passkey 导出或虚拟 authenticator 登录真实账号。
- 不做远程多用户/企业级密钥托管。
- 不承诺“截图永远不含密码”：截图是像素，页面自己可以把密码显示出来。

---

## 3. 方案

### 3.1 不变量（先定死，后面所有设计都服从）

1. **模型可见的 tool args/results 永远不含明文密码。** 只出现 `origin`、`username`、`credential label`、`filled: true` 这类元数据。
2. **明文只由 helper 读取和使用，helper 的对外 API 不返回明文。** provider、`host.mjs`、extension（MVP）、`operations.jsonl`、`host.log`、DSH 会话日志都不持有明文。DOM 赋值需要把值交给页面：headless 由 helper 自己发起 loopback CDP，把值直接写进目标元素；这条传输不经过 provider/host/日志。桌面未来如果做，helper → 扩展的交接是 P2 的残余风险（见 §3.4）。
3. **静态存储只用 OS 凭据库**；没有明文 fallback 文件，没有 `.env`，没有配置文件，没有命令行参数，没有环境变量。
4. **精确 origin + profile scope**：不做通配符、不做“同站近似匹配”、不把 desktop 凭据给 headless sandbox context 用。
5. **用户在场 + 硬确认**：填充/保存/删除都要用户确认；子代理 fail closed（`DELEGATED_CALLER`）。
6. **失败关闭**：helper 不可用、凭据库锁定、origin 不匹配、有 capture 在跑、目标不是可填字段，一律报错，不降级成明文输入。
7. **不提供 `get`/`list`/`reveal` 给模型**；查看密码只能走 OS 自带 UI 或用户本地的 helper UI。
8. **passkey 不导出、不自动化**；只做人工接管。

### 3.2 组件与文件（大部分仍未实现；`src/credentials.js` 为已落地的 P1 安全基础 MVP）

| 文件/接口 | 职责 | 阶段 |
|---|---|---|
| `src/credentials.js`（新，**已实现安全基础 MVP**） | opaque credentialId；macOS Keychain 只读适配器（`security find-generic-password`，可注入 exec）；Windows/Linux 显式 `UNSUPPORTED_PLATFORM`；`fill()` 只返回 `{filled:true}`，sink 未接 driver | P1（仅模块 + 测试） |
| `src/credential-broker.js`（新） | provider 侧 helper 客户端：启动/健康检查、UDS 握手、超时、错误码映射；不实现存储 | P1 |
| `src/credential-store.js`（新，可选） | 纯接口/类型定义：`status/fill/store/forget`；测试用 fake | P1 |
| `src/tools-credentials.js`（新） | 只读 `chrome_credentials {op:"status"}`；不提供 list/get/reveal | P1 |
| `src/tools-input.js`（改） | `chrome_type` 增加 `credential` 参数；敏感字段拒绝裸 `text`；结果不再返回 `value` | P0/P1 |
| `src/headless-page-actions.js`（改） | `typePage`/`currentSelection` 增加敏感字段判断；不返回明文值 | P0 |
| `src/operation-log.js`（改） | 工具级敏感字段表：`chrome_type.text`（`0.2.14` 已有）、`chrome_verify.steps[].text` 等；结果仍走 allowlist | P0 |
| `src/headless-events.js` / `extension/background.js`（改） | capture 时发现 credential fill 正在进行 → 拒绝/暂停；补 `pwd/otp/cvv` 等键名 | P0 |
| `host/credential-helper.mjs`（新） | helper 的协议原型/测试入口；**生产实现应是 native 二进制**，避免 Node 字符串持有明文 | P1 |
| `native/macos/`（新） | Swift/ObjC + Security.framework：Keychain generic password | P1 |
| `native/windows/`（新） | C#/Rust + `CredReadW`/`CredWriteW`：Credential Manager | P2 |
| `native/linux/`（新） | C/Rust + libsecret：Secret Service | P2 |
| `src/install-credentials.js`（新）或 `src/install.js` 扩展 | 写第二个 native messaging manifest（`com.deepseek.dsh.chrome.credentials`），`allowed_origins` 固定扩展 ID | P2 |
| `scripts/leak-scan.mjs`（新） | 对哨兵值做仓库/日志泄漏扫描 | P0 |
| `test/password-management.mjs`（规划，未实现） | 凭据 schema、helper fake、负路径、日志断言 | P0/P1 |
| `test/credentials.mjs`（新，**已落地**） | fake `exec` 覆盖 macOS Keychain 成功/不存在/错误、非 macOS 不支持、opaque id、fill 不返回明文、日志不含 secret；已接入 `npm test` | P1 |

> 2026-10-19：`src/credentials.js` 已落地并接入 `npm test`；它不是 helper——没有 UDS/native 二进制、没有 provider/工具接线、没有 driver/CDP sink。本次实际测试文件是 `test/credentials.mjs`，`test/password-management.mjs` 仍是规划项。

**为什么必须是独立 helper，而不是在 provider 里直接读 Keychain：**

- provider 是模型工具的调用方，任何它读到的明文都可能进入 tool result / 日志 / 异常信息。
- 现有 `host.mjs` 是 relay，native messaging 的帧会完整经过它；如果凭据帧走这条线，host 进程内存和错误日志都有风险。
- 独立 helper 可以用平台 native 代码做内存清零、访问控制、用户 presence；Node 字符串无法可靠清零。
- 独立 helper 可以只暴露 `fill` 回执，不暴露 `get`，从接口层减少误用。

### 3.3 OS 凭据库

| 平台 | 存储 | 键 | 访问控制 | 不可用时 |
|---|---|---|---|---|
| macOS | Keychain generic password（Security.framework；`kSecClassGenericPassword`） | service `com.deepseek.dsh.chrome.credentials`；account `dsh-chrome/<scope>/<origin>/<username>` | `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`；保存/查看时可用 `SecAccessControl` 要求用户 presence；helper 代码签名 | 返回 `CREDENTIAL_STORE_UNAVAILABLE`，功能关闭 |
| Windows | Credential Manager generic credential（`CredWriteW`/`CredReadW`） | target `dsh-chrome/<scope>/<origin>/<username>` | `CRED_TYPE_GENERIC` + `CRED_PERSIST_LOCAL_MACHINE`；由 DPAPI 保护 | 返回 `CREDENTIAL_STORE_UNAVAILABLE` |
| Linux | Secret Service（libsecret；collection `dsh-chrome`） | attributes `{scope, origin, username}`；label 只放站点/用户名 | 由桌面 keyring 解锁；无 keyring 的 headless 环境直接关闭 | 返回 `CREDENTIAL_STORE_UNAVAILABLE`；**不**回退到明文文件 |

- **scope**：`desktop`（用户日常 Chrome）或 `headless:<profileId>`（某个 headless/context profile）。默认不允许跨 scope 填充；跨 scope 必须显式配置 + 用户确认，且不作为 MVP。
- **origin**：精确的 `scheme://host:port`，不含路径/查询；不做 `*.example.com` 通配。用户确认卡上显示完整 origin。
- **username**：保存时必须写；同一 origin 多个 username 时，填充必须指定 username，不能“取第一条”。
- **label**：只用于 UI 显示（如“GitHub 工作号”），不是 secret，也不作为查找键。
- **保存入口**：helper 自己弹 OS 原生安全输入（macOS `SecAccessControl`/安全输入框、Windows `CredUIPromptForCredentials` 或 helper 自带隐藏输入、Linux `pinentry`/libsecret 提示）；或用户用 Keychain Access / Windows Credential Manager / Seahorse 手动添加。**不接受**模型传来的 `secret` 字段，不接受命令行 `--password`，不接受环境变量。
- **内存**：生产 helper 用 native 字节缓冲，填充后立即清零；`host/credential-helper.mjs` 只作协议原型/测试夹具，不能作为最终存密实现（Node 字符串无法可靠清零）。

### 3.4 helper 接口

传输：

- **本地 UDS**：`~/.dsh/cache/dsh-chrome/credentials.sock`，目录 0700、socket 0600；`credentials.json`（0600）放 `{socketPath, token, pid, version}`；token 随机 32 字节，只在本机文件/内存，不写日志。helper 校验 peer UID（macOS `getpeereid`/`LOCAL_PEERCRED`，Linux `SO_PEERCRED`）和 token。
- **native messaging**（P2 桌面填充才需要）：独立 host 名 `com.deepseek.dsh.chrome.credentials`，manifest `allowed_origins` 固定扩展 ID；不要复用现有 `host.mjs` 的 relay 通道传秘密。
- 协议用 JSON lines（UDS）或 4 字节长度前缀 JSON（native messaging），与现有 host 的风格一致。

方法（**没有 `get`/`list`/`reveal`/`export`**）：

| 方法 | 调用方 | 参数 | 返回 |
|---|---|---|---|
| `credentials.status` | provider / 扩展 | `{}` | `{available, backend, locked, userPresence, version}`；不含任何账号/密码 |
| `credentials.fill` | provider（headless）/ 扩展（未来桌面） | `{scope, origin, username?, target:{tabId, frameId?, ref?, selector?}, requestId}` | `{ok, filled:true, origin, username, backend, requestId}`；**绝不返回 secret** |
| `credentials.store` | 仅 helper 本地 UI/TTY | 由 OS 原生输入取得；不接受 JSON `secret` 字段 | `{ok, created:true, origin, username}` |
| `credentials.forget` | 仅 helper 本地 UI/TTY | `{scope, origin, username}` | `{ok, removed:true}` |
| `ping` | provider | `{}` | `{ok, version}` |

`fill` 的请求示例（不含密码）：

```json
{"id":7,"method":"credentials.fill","params":{"scope":"headless:ctx-1","origin":"https://example.com","username":"alice","target":{"tabId":12,"frameId":"F1","ref":7},"requestId":"fill-7"}}
```

返回：

```json
{"id":7,"result":{"ok":true,"filled":true,"origin":"https://example.com","username":"alice","backend":"macos-keychain","requestId":"fill-7"}}
```

错误码：

| 错误码 | 含义 |
|---|---|
| `CREDENTIAL_STORE_UNAVAILABLE` | 没有可用凭据库/未解锁；功能关闭 |
| `CREDENTIAL_NOT_FOUND` | 该 scope+origin+username 没有条目 |
| `CREDENTIAL_ORIGIN_MISMATCH` | 当前页面 origin 与请求/条目不一致 |
| `CREDENTIAL_AMBIGUOUS` | 同 origin 多条且未指定 username |
| `CREDENTIAL_USER_CANCELED` | 用户取消 OS 确认 |
| `CREDENTIAL_CAPTURE_ACTIVE` | 目标 tab 正在 capture，拒绝填充 |
| `CREDENTIAL_UNSUPPORTED_TARGET` | 目标不是可填的 input/textarea，或字段已禁用/只读 |
| `CREDENTIAL_HELPER_UNAVAILABLE` | helper 未启动/握手失败/版本不匹配 |
| `CREDENTIAL_DESKTOP_UNSUPPORTED` | MVP 不支持桌面程序化填充；提示手动/autofill |
| `DELEGATED_CALLER` | 子代理会话不能做硬确认/填充；到根会话处理 |

**填充实现（headless，P1）：**

1. provider 解析当前 tab 的真实 origin（`browser.site` 或 driver 的 tab 信息），**不使用模型传入的 origin**；把 origin、target、CDP 地址交给 helper。
2. helper 只接受 loopback CDP 地址（`127.0.0.1`/`::1`，端口来自 provider 的 `DevToolsActivePort`），拒绝任意 host/路径；helper 不把 CDP 地址或 secret 写日志。
3. helper 在自己的进程内从 OS 凭据库取密；用 CDP `Runtime.callFunctionOn`（或等价的固定函数）把值写进目标元素。**不要**把 secret 拼进 JavaScript 字符串；把它作为参数传入，避免注入/转义问题。
4. helper 返回 `{filled:true}` 回执；provider 不读取值、不截图、不生成快照。
5. 填充前如目标 tab 正在 capture，直接 `CREDENTIAL_CAPTURE_ACTIVE`；填充期间暂停 screencast，填充后不要自动截图。

**桌面 Chrome（P2 才考虑）：** 扩展通过独立的 native host 向 helper 要值，扩展用原生 setter 填充。这里不可避免地会有一次 helper → 扩展进程的明文交接（DOM 赋值只能由扩展/页面侧完成）。这是本方案明确的残余风险；**MVP 不做桌面程序化填充**，桌面继续用 Chrome 自带密码管理器/手动输入。

### 3.5 填充路径与登录边界

| 场景 | MVP 行为 | 说明 |
|---|---|---|
| 用户日常 Chrome，已登录 | 直接操作，不碰密码 | 现有能力；不读 Chrome 密码库 |
| 用户日常 Chrome，未登录 | 用户在页面手动登录/用 Chrome 自带 autofill | 插件不接管；`chrome_type.credential` 返回 `CREDENTIAL_DESKTOP_UNSUPPORTED` |
| headless context，需要登录 | 优先 `chrome_headless_login {op:"show"}` 人工登录；P1 可用 helper 填充 | 人工路径始终保留；helper 填充只对 CDP 可达的 headless tab 有效 |
| 可见登录窗口（`loginStart`） | 人工输入 | 该窗口没有 remote-debugging 参数（`src/headless-login.js:23-33`），helper 无法 CDP 填充；不要为了填充去加调试端口，除非单独评审 |
| passkey/WebAuthn | 人工在可见窗口完成 | 不导出、不虚拟 authenticator |
| 2FA/TOTP | 人工输入；P3 才考虑 helper 生成 TOTP | seed 的存储风险高于密码，默认关闭 |

### 3.6 工具/接口设计

`chrome_type` 扩展（建议）：

```jsonc
{
  "ref": 7,
  "selector": "#password",          // 与 ref 二选一
  "frameRef": "F1:2",               // 可选
  "credential": {                   // 与 text 二选一
    "username": "alice",            // 同 origin 多条时必填
    "label": "工作号"               // 仅用于确认卡显示，可选
  },
  "replace": true,
  "submit": false
}
```

规则：

- `text` 与 `credential` **互斥**，且必须提供其中一个；`additionalProperties: false`。
- `credential` 只能填当前 tab 的**精确 origin**；origin 由 provider 解析，模型不能传。
- `chrome_type` 在 `credential` 模式下：
  1. `guard()` 之后，额外走 `hardConfirmAsk`（与上传/登录同一套 `ctx.userQuestions`，根会话可用，子代理 `DELEGATED_CALLER` 失败）。
  2. 确认卡写清：动作（向密码字段填入已保存凭据）、站点 origin、用户名/label、目标 tab；不显示密码。
  3. 目标 tab 有 capture → `CREDENTIAL_CAPTURE_ACTIVE`；目标不是可填字段 → `CREDENTIAL_UNSUPPORTED_TARGET`。
  4. 返回 `{ok, filled:true, origin, username, submitted?, tabId}`；**不返回 `value`**。
- 普通 `text` 模式：
  - 如果目标字段被识别为敏感（`type=password`、`autocomplete` 含 `current-password`/`new-password`/`one-time-code`、name/label 含 password/passwd/otp/cvv/card/secret 等），返回 `SENSITIVE_FIELD_REQUIRES_CREDENTIAL`，拒绝写入，并提示用 `credential` 或人工登录。
  - 识别不到的“伪装成 text 的密码框”仍可能漏；这是启发式的上限，文档要写明。
- `chrome_credentials {op:"status"}`（只读）：返回 `{available, backend, locked}`；**不返回**账号列表、用户名、alias；条目数量也建议不返回，避免枚举。
- 不新增 `chrome_credentials {op:"list"|"get"|"reveal"}`。查看密码只能走 OS 自带 UI。

普通 `chrome_type` 的结果也要改：`src/tools-input.js:321-344` 的 `value` 字段和 render 中的 `value now ...` 要去掉（至少对敏感字段）。这是 P0，不依赖 helper。

### 3.7 “密码显示眼睛”只影响 UI

- 页面自带的“眼睛”图标是页面把 `input.type` 从 `password` 改成 `text`（或 CSS 覆盖）的本地显示行为；**不是**凭据读取接口。
- 本插件不提供 `reveal`/`get` 工具，不把眼睛切换当成“用户已授权把密码给模型”。helper 也不因为眼睛切换而返回明文。
- 用户在页面手动点眼睛后，**截图/录屏会看到明文**；这是像素层面的现实，插件不做逐像素脱敏。控制手段只有：
  - 凭据填充/查看期间暂停 `chrome_screencast` 和自动截图；
  - 填充完成后让字段失焦/恢复 `type=password`；
  - 文档明确“不要在密码可见时截图/共享屏幕”。
- 如果未来做插件自己的 reveal UI，它只能是本地 UI（OS 原生输入/helper UI），不能是 model-facing tool；reveal 不进日志、不进会话、不返回 provider。

### 3.8 插件自身 API key

- **当前没有插件 API key。** 插件不调用模型 API；DSH 的模型/服务凭据属于 DSH，不由本插件读取或复制（例如 DSH 自己的 `$DSH_HOME/.credentials.yaml` 一类文件，本插件不碰）。
- 未来如果插件需要自己的 API key（例如更新服务、第三方集成）：
  - 存 OS 凭据库，service `com.deepseek.dsh.chrome.api`，account `plugin:<purpose>`；
  - 只由 helper 在调用时取用；provider 只拿 alias/回执；
  - 不写 `~/.dsh/config.json`、`~/.dsh/cache/dsh-chrome/*.json`、`.env`、环境变量、命令行参数；
  - 不写 `operations.jsonl`/`host.log`/audit；
  - `src/config.js:49` 的 secret-shaped key 拒绝规则保留，并加测试；
  - `chrome_config` 只报告“已配置/来源”，不报告值。
- 不要把“DSH 模型 API key”和“插件 API key”混为一谈；本文只约束后者。

### 3.9 脱敏矩阵

#### A. 模型/日志出口

| 数据/出口 | 当前 | 目标 | 落点 |
|---|---|---|---|
| `chrome_type.args.text` | `0.2.13` 原样进 `operations.jsonl`；`0.2.14` 已对 `chrome_type` 记 `«redacted»` | 敏感字段拒绝裸 `text`；普通 text 在操作日志中按工具级脱敏 | `src/tools-input.js:288-358`、`src/operation-log.js:73-77,491-503` |
| `chrome_type.result.value` | 原样返回/render | 删除；只返回 `filled/origin/username` | `src/tools-input.js:321-344`、`extension/background.js:3337`、`src/headless-page-actions.js:214` |
| `chrome_verify.steps[].text` | 原样进操作日志 | 工具级脱敏或禁止敏感字段 | `src/tools-verify.js:141-143`、`src/operation-log.js:491-503` |
| `operation-log.args` | 键名脱敏；`text` 不匹配；`0.2.14` 有 `chrome_type` 特例 | 增加 `SENSITIVE_ARG_FIELDS_BY_TOOL`：`chrome_type.text`、`chrome_verify.steps[].text`、`chrome_storage.value(s)`、`chrome_evaluate.expression` | `src/operation-log.js:73-77,382-390,491-503` |
| `operation-log.result` | allowlist，已丢弃 `value` | 保持；新增 `credential` 元数据只留 origin/username | `src/operation-log.js:509-562` |
| DSH 会话日志 | 下游持久化 | 源头不产生明文；历史记录按 DSH 记录管理清理 | `$DSH_HOME/sessions/.../session.v4.jsonl.zstd` |
| `audit.jsonl` | 只记元数据 | 保持；action 不含密码；credential fill 记 origin/username/decision | `src/policy.js:70-86` |
| `host.log` | 事件/错误/截图路径 | 保持不记 payload；凭据帧不走 `host.mjs` | `host/host.mjs:39-46,280-340` |
| `chrome_type` render | 打印字段值 | 不打印值；敏感模式只打印“已填充” | `src/tools-input.js:341-344` |
| viewer 输入回包 | 返回/显示 `value` | 敏感字段不返回值；状态栏只显示 `filled` | `src/viewer-input.js:62-73`、`src/viewer-html.js:123-149` |
| `chrome_config` | 只读配置 | 不返回值；secret-shaped 键拒绝 | `src/config.js:49`、`src/tools-status.js` |

#### B. capture（网络）

| 数据 | 当前 | 目标 | 落点 |
|---|---|---|---|
| URL userinfo | 脱敏 | 保持 | `src/headless-redact.js:26-40`、`extension/background.js:1311-1321` |
| URL 查询 secret | 脱敏 | 保持；补 `pwd`/`otp`/`cvv` | `src/headless-redact.js:15-16` |
| URL fragment | 不处理 | 按查询参数规则脱敏 | `src/headless-redact.js:26-40` |
| headers | 不采集 | 保持不采集 | capture 路径；`src/tools-capture.js:20-21` |
| JSON/form 键 | `pass/secret/token/api_key/...` | 补 `pwd`/`otp`/`cvv`/`auth`（用精确键/锚定正则，避免误伤 `author`） | `src/headless-redact.js:15-16,42-73` |
| 普通文本 | Bearer/sk-/JWT/AKIA | 增加 `password=...`/`pwd=...`/`otp=...` 等键值形态；无法可靠识别时提示“抓包可能含密码” | `src/headless-redact.js:18-24` |
| 非文本 body | 只占位 | 保持 | `src/headless-redact.js:81-96` |
| body 预算/截断 | 先脱敏后截断 | 保持；测试确保哨兵不被截成半段泄漏 | `src/headless-redact.js:77-96` |
| 抓包中的 credential fill | 无门控 | 目标 tab 有 capture 时拒绝 fill；fill 期间不启动 capture | `src/headless-events.js`、`extension/background.js`、`src/tools-capture.js` |

#### C. 页面读取、截图、viewer

| 数据 | 当前 | 目标 | 落点 |
|---|---|---|---|
| 快照控件值 | 密码/支付字段 `••••` | 保持；扩展识别更多 autocomplete/name | `extension/background.js:2971-2980`、`src/headless-page-actions.js:63-67` |
| HTML `value` | 打码 | 保持 | `extension/background.js:3618-3632` |
| 页面正文/a11y | 不脱敏 | 保持“页面是数据”；不要把它当凭据；敏感页面提示用户 | `chrome_get_text`/a11y 路径 |
| 选区 | 扩展拒绝敏感字段；headless 未拒绝 | headless 补 `SENSITIVE_SELECTION` | `src/headless-page-actions.js:217-227` |
| 控制台 | 原样进缓冲 | fill 期间暂停/过滤；不要把密码写进 console | `src/headless-events.js:35-49` |
| 截图/screencast | 像素，无脱敏 | 不做像素脱敏承诺；fill 期间暂停；眼睛切换后可能可见 | `src/tools-media.js`、`src/tools-screencast.js` |
| viewer token/HTML | loopback + token + access；HTML 内嵌 | 保持；token 文件 0600；不在日志打印 | `src/viewer-auth.js:47-64`、`src/viewer-html.js:72-76` |
| viewer 输入 | 明文回包/状态栏 | 敏感字段不返回 `value` | `src/viewer-input.js:62-73`、`src/viewer-html.js:123-149` |

#### D. 落盘、profile、扩展存储

| 数据 | 当前 | 目标 | 落点 |
|---|---|---|---|
| 浏览器 profile | 独立 headless profile；context profile 0700；ephemeral 删除 | 保持；不导入用户 profile；磁盘加密；named profile 显式删除；默认 headless profile 权限按 umask/父目录收紧 | `src/contexts.js:73-115`、`src/headless-launch.js:20-37` |
| Chrome cookie/Login Data | Chrome 自己管理 | 插件不读、不导出、不复制；不用 `--password-store=basic` 弱化 | `docs/DESIGN.md:248`、`src/headless-launch.js` |
| 扩展 storage | 无凭据 | 只存 opaque alias/label；不存 secret/密码/TOTP seed | `extension/background.js:25-81,290,428,1480,1607` |
| 截图/PDF/artifact | 截图 0600、artifact 目录 0700；无像素脱敏 | 保留；凭据操作不自动产生 artifact；留存可配置 | `host/host.mjs:447-461`、`src/artifact-store.js:26-50` |
| 操作/审计日志 | 0600；轮转 | 保持；P0 补工具级脱敏 | `src/operation-log.js:644-659`、`src/policy.js:70-86` |
| 备份/云同步 | 插件不控制 | 文档建议排除/加密 `$DSH_HOME`；敏感账号不要用同步目录 | 运维建议 |
| 插件 API key | 无 | OS 凭据库 + helper；不落 DSH 本地明文 | `src/config.js:49`、§3.8 |

### 3.10 审计

建议每条凭据操作写一条本地 audit（复用 `src/policy.js:appendAudit`）：

```json
{"ts":"...","session":"...","tool":"chrome_type","origin":"https://example.com","tabId":12,"action":"credential-fill","decision":"allowed","reason":"user-confirmed","username":"alice","backend":"macos-keychain"}
```

- 不记录密码、TOTP code、secret、完整 cookie。
- `action` 用固定枚举（`credential-fill`/`credential-store`/`credential-forget`），不要把选择器/页面文本拼进去。
- `username` 是账号标识，属于审计需要；如果产品认为用户名也敏感，可只记 `usernameHash`。
- 失败也要记（`CREDENTIAL_ORIGIN_MISMATCH`、`CREDENTIAL_CAPTURE_ACTIVE`、`CREDENTIAL_USER_CANCELED`），用于发现攻击尝试。
- 审计文件 0600、可轮转；不要上传遥测。

---

## 4. 登录自动化边界

### 4.1 分层

| 层 | 能力 | 允许什么 | 不允许什么 |
|---|---|---|---|
| **L0 人工/可见窗口**（当前） | 用户在 headless 专用窗口或日常 Chrome 里手动登录 | 插件只发截图/提示，等待用户完成 | 不读密码、不代填、不记录键盘 |
| **L1 浏览器 autofill** | Chrome 自带密码管理器在页面里 autofill | 用户手势触发；插件不读值 | 不调用/不读取 Chrome 密码库；不导出 cookie |
| **L2 helper 填充（headless）** | helper 从 OS 库取密，内部 CDP 填充 | 精确 origin、用户硬确认、无 capture、无截图 | 不把密码返回 provider/模型/日志；不支持可见登录窗口；不支持桌面 |
| **L3 passkey/2FA** | 人工接管；未来的 TOTP 可选 | 可见窗口完成 WebAuthn；TOTP code 由 helper 生成（默认关闭） | 不导出 passkey、不虚拟 authenticator、不自动过 SMS/push |

### 4.2 先手动/autofill，再 passkey/2FA

1. **第一步永远是人工路径可用。** `chrome_headless_login {op:"show"}` 必须保留，作为所有自动化失败时的兜底。
2. **第二步是 Chrome 自带 autofill。** 日常 Chrome 里用户自己用浏览器密码管理器；插件不接管。headless 是独立 profile，autofill 通常不可用，所以 headless 用 L0 或 L2。
3. **第三步才是 helper 填充（headless）。** 只解决“沙箱 context 里需要登录，但用户不想每次开可见窗口”的窄场景；不追求“全自动登录”。
4. **passkey/2FA 最后做，而且只做人工接管。** passkey 是 origin-bound、不可导出的；2FA 的 TOTP seed 是另一类高价值秘密，默认不存。SMS/push/security key 一律人工。
5. **绝不把密码写进配置/仓库。** 不写 `config.json`、`policy.json`、`.env`、测试 fixture、文档示例、issue/PR；保存只走 OS 原生输入 + OS 凭据库。

### 4.3 失败时的行为

- helper 不可用/锁定 → `CREDENTIAL_STORE_UNAVAILABLE`，提示用户手动登录；**不**回退到 `chrome_type.text` 让模型问用户要密码。
- origin 不匹配 → `CREDENTIAL_ORIGIN_MISMATCH`，不填充；确认卡上显示实际 origin。
- 目标字段不可填/只读 → `CREDENTIAL_UNSUPPORTED_TARGET`。
- 有 capture/screencast → 拒绝或先停；绝不边抓包边填密码。
- 用户拒绝/超时 → `CREDENTIAL_USER_CANCELED`/`APPROVAL_TIMEOUT`；不重试、不换路径。
- 子代理 → `DELEGATED_CALLER`，到根会话处理。

---

## 5. 分阶段计划

> 工作量是粗略估算：1 名熟悉本仓的工程师，不含设计评审、代码签名/公证、跨平台 CI 调试。真实值以排期为准。

| 阶段 | 内容 | 退出标准 | 估算 |
|---|---|---|---|
| **P0 现状止血**（不依赖 helper） | ① `chrome_type`/`chrome_verify` 的操作日志工具级脱敏（`chrome_type.text` `0.2.14` 已有；`chrome_verify` 未做）；② 敏感字段拒绝裸 `text`；③ `chrome_type` 不返回 `value`/不 render 值；④ headless selection 补敏感检查；⑤ viewer 输入不显示 value；⑥ capture 补 `pwd/otp/cvv`/fragment/键值文本；⑦ 新泄漏扫描测试 | 哨兵值不出现在 `operations.jsonl`/工具结果/render/viewer；`node test/operation-log.mjs`、`node test/capture-parity.mjs`、新测试全绿 | 2–3 天 |
| **P1 macOS helper + headless 填充** | ① `native/macos` Keychain helper；② UDS + token + peer UID；③ `src/credential-broker.js`；④ `chrome_type.credential` schema + 硬确认；⑤ helper 内部 CDP 填充；⑥ 审计；⑦ 测试/fake | macOS 上可保存/填充/删除；provider/日志/模型无明文；origin/scope/capture 负路径正确；helper 不可用 fail closed | 6–10 天 |
| **P2 跨平台 + 桌面 native host** | ① Windows Credential Manager helper；② Linux Secret Service helper；③ 第二个 native messaging host；④ 扩展直连 helper 的桌面填充（残余风险评审）；⑤ 安装/打包/签名 | Windows/Linux 至少只读 status + headless fill 可用；桌面填充有明确风险说明；安装文档/回滚 | 10–15 天 |
| **P3 2FA/passkey 边界** | ① TOTP seed（默认关闭）与 helper 生成 code；② passkey/WebAuthn 人工接管 UI/文档；③ 安全 key/SMS/push 提示；④ 可选用户 presence | TOTP 默认关闭；passkey 不导出；所有失败可回到人工 | 4–6 天 |

> **2026-10-19 进展**：P1 的 `src/credentials.js` 安全基础 MVP（opaque credentialId + macOS Keychain 只读 + `fill()` 接口 + `test/credentials.mjs`）已落地并接入 `npm test`；P1 其余项（native helper、UDS、provider 接线、真实 CDP 填充、审计、保存/删除）未做。

**总计**：macOS MVP（P0+P1）约 8–13 天；跨平台（P0–P2）约 22–34 天；P3 另计。**桌面 Chrome 程序化填充不在 MVP 承诺内**，P2 是否做需单独评审残余风险。

---

## 6. 测试

### 6.1 单元/契约测试

| 测试 | 覆盖 |
|---|---|
| `test/password-management.mjs`（规划，未实现） | `credential` schema 互斥；fake helper 的 `status/fill`；`fill` 不返回 secret；origin mismatch / ambiguous / unavailable / capture active / delegated caller；确认卡文案包含 origin/username |
| `test/credentials.mjs`（新，**已落地**） | fake `exec` 覆盖 macOS Keychain 成功/不存在/错误、非 macOS 不支持、opaque id、`fill()` 只返回 `{filled:true}`、日志/错误/结果不含哨兵；已接入 `npm test` |
| `test/operation-log.mjs`（扩） | `chrome_type` 的 `text` 哨兵不落盘（`0.2.14` 已改）；`chrome_verify` steps 的 `text` 不落盘（待加）；`chrome_storage` 敏感键；`credential` 只留 origin/username；结果无 `value` |
| `test/capture-parity.mjs`（扩） | `pwd/otp/cvv` JSON/form；URL fragment；`password=...` 文本；两侧一致；哨兵不出现 |
| `test/headless.mjs`（扩） | headless selection 对密码字段返回 `SENSITIVE_SELECTION`；`typePage` 不返回敏感值 |
| `test/extension-logic.mjs`（扩） | 扩展 `typeIntoRef` 对敏感字段拒绝/不返回值；快照打码保持 |
| `test/context-viewer.mjs`（扩） | viewer type 敏感字段不回 `value`；状态栏不显示 |
| `test/tool-schemas.mjs`（扩） | `chrome_type.credential` schema；`text`/`credential` 互斥；`additionalProperties:false` |

测试全部使用**假凭据库/fake helper**和哨兵值；不依赖真实 Keychain。macOS 集成测试用 `DSH_CREDENTIAL_INTEGRATION=1` 显式开启，条目名带 `dsh-chrome-test-` 前缀，测试后删除；CI 默认不跑。

### 6.2 日志断言

一次测试流程结束后读取并断言：

- `~/.dsh/cache/dsh-chrome/operations.jsonl`：不含哨兵；`chrome_type` 记录里 `text` 为 `«redacted»`（`0.2.14`）或不存在；`credential` 记录只有 origin/username。
- `~/.dsh/cache/dsh-chrome/audit.jsonl`：不含哨兵；有 `credential-fill` 的 denied/allowed 记录。
- `~/.dsh/cache/dsh-chrome/host.log`：不含哨兵；没有 payload/密码。
- 工具 render 输出：不含哨兵；不出现 `value now`。
- 文件权限：`operations.jsonl`/`audit.jsonl`/`host.log` 0600；`credentials.sock` 0600；token 文件 0600；目录 0700。
- DSH 会话日志：单元测试无法直接控制；断言“工具结果不含哨兵”即可覆盖新写入。已有历史会话记录需要人工/DSH 记录管理清理。

### 6.3 泄漏扫描

新增 `scripts/leak-scan.mjs`：

- 输入哨兵（环境变量或参数，例如 `DSH_LEAK_SENTINEL`），扫描仓库文本文件和 `$DSH_HOME/cache/dsh-chrome` 下的文本日志；跳过二进制（截图/PNG/PDF）并在报告里注明。
- 命中即非零退出，打印 `file:line`（不打印值本身）。
- 只用于测试哨兵，不扫描真实密码；不要把它做成“上传日志”的工具。
- CI 建议增加 `gitleaks`/`trufflehog` 类的 secret scan（当前 `.github/workflows/ci.yml` 没有）；这是仓库级防线，不替代运行时脱敏。

### 6.4 手工验收

1. 在临时 `DSH_HOME` 里跑 `chrome_type {text:"DSH_SENTINEL_PW_DO_NOT_USE"}`，确认 `operations.jsonl`、render、会话结果都没有哨兵（P0 后）。
2. 在 headless 页面的密码框上选中文本，调用 `chrome_selection`，确认返回 `SENSITIVE_SELECTION`（P0 后）。
3. 在 viewer 里向密码框输入，确认状态栏不回显明文（P0 后）。
4. macOS：保存一个测试凭据到 Keychain（测试 service），用 `chrome_type.credential` 填 headless 表单；确认 provider 日志、`operations.jsonl`、`host.log` 无明文；确认 origin 不匹配时拒绝；确认 capture 活跃时拒绝。
5. 拔掉/锁定 Keychain 或停掉 helper，确认返回 `CREDENTIAL_STORE_UNAVAILABLE`，且不会退回明文输入。
6. 子代理会话调用 `credential` 填充，确认 `DELEGATED_CALLER` 失败。
7. 截图/眼睛切换：确认文档写明“截图可能看到明文”，且 fill 期间不会自动截图。

> 以上 4–6 是 helper/provider 接线后的验收项，当前未接。本次 MVP 的验收是 `node test/credentials.mjs`（fake exec，不碰真实 Keychain）。

### 6.5 命令

```bash
node test/password-management.mjs
node test/credentials.mjs
node test/operation-log.mjs
node test/capture-parity.mjs
node test/headless.mjs
node test/context-viewer.mjs
node scripts/leak-scan.mjs --sentinel "DSH_SENTINEL_PW_DO_NOT_USE"
npm test
```

---

## 7. 风险与明确未实现

### 7.1 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| **prompt injection 诱导填充到钓鱼站** | 凭据被送到错误 origin | origin 由 provider 解析、精确匹配；确认卡显示实际 origin/username；不做通配；不自动信任页面指令 |
| **helper 被替换/注入** | 所有保存的凭据失守 | 代码签名/公证；最小依赖；不监听 TCP、不访问外网；UDS 0600 + peer UID + token；安装路径校验；审计 |
| **同用户恶意进程** | 读日志/会话/profile/Keychain | OS 用户边界；文档明确不承诺；敏感账号隔离账户/机器 |
| **截图/录屏/肩窥** | 眼睛切换后密码可见 | fill 期间暂停 screencast/截图；不要在密码可见时共享屏幕；不做“截图永远安全”的承诺 |
| **Linux 无 Secret Service** | 无法保存/填充 | 功能关闭；不回退明文；headless 场景建议人工登录 |
| **备份/云同步** | `.dsh` 或 profile 被同步 | 文档建议排除/加密；敏感账号不要放同步目录 |
| **Chrome profile cookie 被复制** | 会话被劫持 | profile 0700；不导入用户 profile；磁盘加密；ephemeral 清理；named profile 显式删除 |
| **Node 字符串无法清零** | helper 内存可能残留 | 最终实现用 native 字节缓冲并清零；Node 仅原型 |
| **历史日志已含明文** | 改密前持续暴露 | 按“凭据已暴露”处理：改密、清理 `operations.jsonl`/会话记录/备份；仅删一个文件不够 |
| **passkey 无法自动化** | 用户期望落空 | 文档和 UI 明确“人工接管”；不提供虚拟 authenticator |
| **TOTP seed 高价值** | 2FA 被绕过 | 默认关闭；OS 库；不返回 seed；短时效 code；用户 presence |
| **跨平台差异** | 行为不一致 | 分阶段；每个平台独立测试；不可用就 fail closed |

### 7.2 当前明确未实现（不要对外承诺）

- 没有密码管理器/凭据库 UI。
- 没有 autofill；没有完整的 Keychain / Credential Manager / Secret Service 集成。`src/credentials.js` 只有 macOS Keychain 只读适配器（P1 安全基础 MVP，未接工具/驱动）。
- 没有 `credential` helper、没有 `credentials.*` 协议、没有 `chrome_type.credential`。
- `src/credentials.js` 只是 P1 安全基础 MVP（模块 + 测试）：没有 provider/工具接线、没有真实填充、没有保存/删除；不要把它当成密码管理器或 autofill。
- 没有 `chrome_credentials` 工具。
- 没有桌面 Chrome 程序化填充；MVP 只有手动/Chrome 自带 autofill。
- 没有 passkey/WebAuthn/TOTP/2FA 自动化。
- 没有截图像素脱敏、没有眼睛切换检测。
- 没有 DSH 会话日志擦除/脱敏。
- 没有 CI secret scan；没有 `scripts/leak-scan.mjs`。
- 没有 Windows/Linux helper；没有跨平台签名/公证。
- 没有对同用户恶意进程、root、键盘记录器、备份/云同步的防护承诺。
- 没有“抓包一定不含密码”的承诺；capture 只做已知规则脱敏。
- **`0.2.14` 已包含 `chrome_type.text` 的 operation-log 修复**；不要把它扩展成其他出口也已修复，也不要把它说成完整的密码管理。

### 7.3 开放问题（需要产品/安全拍板）

1. 桌面 Chrome 是否值得做程序化填充？如果做，helper → 扩展的明文交接是接受的残余风险吗？
2. 凭据 scope 是否要按 DSH 会话/工作区再细分？当前建议只分 `desktop` 与 `headless:<profileId>`。
3. 保存入口用 OS 原生提示，还是 DSH 自己的本地设置页？后者需要新的本地 UI 和 CSRF/token 设计。
4. TOTP 是否值得做？seed 的存储风险是否高于便利收益？
5. 是否允许跨 profile 复用凭据（例如 headless 用 desktop 的 GitHub 凭据）？默认建议不允许。
6. 审计里是否记录 username，还是只记 hash？

---

## 8. 关键文件索引

| 文件 | 用途 |
|---|---|
| `src/headless-redact.js` | capture URL/body 脱敏、预算、截断 |
| `extension/background.js:1308-1454` | 扩展侧 capture 脱敏（与 headless 对齐） |
| `src/headless-events.js` | headless capture 事件映射 |
| `src/tools-capture.js` | capture 工具、硬确认、headers 不采集的说明 |
| `test/capture-parity.mjs` | 两侧脱敏一致性测试 |
| `src/operation-log.js` | 操作日志、键名脱敏、allowlist、轮转；`0.2.14` 含 `chrome_type.text` 特例 |
| `src/credentials.js` | P1 安全基础 MVP：opaque credentialId + macOS Keychain 只读 + `fill()` 接口（未接 driver） |
| `test/credentials.mjs` | fake `exec` 凭据测试；已接入 `npm test` |
| `src/policy.js` | 站点策略/audit 日志 |
| `host/host.mjs` | native messaging relay、host.log、截图落盘 |
| `src/tools-login.js` / `src/headless-login.js` | 可见窗口登录 |
| `src/headless-launch.js` | headless 启动参数/profile |
| `src/contexts.js` | context profile 生命周期 |
| `src/tools-input.js` | `chrome_type` schema/execute/render |
| `src/headless-page-actions.js` | headless 快照/type/selection |
| `src/tools-verify.js` | `chrome_verify` 的 type steps/artifact |
| `src/viewer-auth.js` / `src/viewer-html.js` / `src/viewer-input.js` | viewer token/HTML/输入回包 |
| `src/tools-media.js` / `src/tools-screencast.js` | 截图/screencast |
| `src/artifact-store.js` | verify artifact 留存 |
| `src/config.js` / `docs/PLUGIN-SETTINGS.md` | 配置拒绝 secret、无插件 API key |
| `docs/APPROVAL.md:80` | “密码字段硬确认仍未接入”的现状记录 |
| `docs/DESIGN.md:43,244` | 设计非目标与敏感值原则 |
| `docs/HEADLESS.md:86-111` | 一次性登录/人工接管 |

---

## 9. 一句话总结

**当前能做的是“人工登录 + 显示打码 + 抓包脱敏”，不是密码管理。**（2026-10-19 新增的 `src/credentials.js` 只是未接线的 macOS Keychain 只读 MVP，不改变这个结论。）下一步先把 `chrome_type`/selection/viewer/capture 的明文出口堵住（P0；`0.2.14` 已修 operation log 的 `chrome_type.text`，其余仍在），再引入 OS 凭据库 + 独立 helper，让模型只说“填哪个站点的凭据”，由 helper 在内部取密并填充；桌面程序化填充、passkey/2FA 都不做过度承诺。


## 附：0.2.15 已修（Q31–Q33）

- `chrome_type` 结果不再返回字段值，render 不显示输入；
- headless selection 对敏感字段返回 `SENSITIVE_SELECTION`；
- viewer type 回包/状态栏不回显 value；
- capture 补 `pwd/otp/cvv/auth`、URL fragment、inline `password=...`；
- `chrome_verify` steps[].text 不再明文进 operation log。

仍没有 helper/UDS/工具接线/真实填充/保存删除/Windows/Linux 存储；`src/credentials.js` 只是 macOS 只读的 P1 安全基础 MVP。

## 附：P1 安全基础 MVP（2026-10-19，已落地）

**范围：`src/credentials.js` + `test/credentials.mjs`。只做安全基础，不接 UI/工具/驱动。** 本节是实现状态的权威说明；正文 §3–§7 里的“建议/目标”只要与本附录冲突，以本附录为准。

已实现：

- **opaque credentialId**：`cred_<32 hex>`，由 `randomBytes(16)` 生成；对外只返回 id/backend/scope/origin/username/label，不返回 Keychain service/account，更不返回明文。相同 (scope, origin, username) 每次注册也得到不同 id。
- **macOS Keychain 只读适配器**：通过 `security find-generic-password -s <service> -a <account> -w` 读取；`exec` 可注入，测试全部用 fake，不碰真实 Keychain。service 固定为 `com.deepseek.dsh.chrome.credentials`，account 为 `dsh-chrome/<scope>/<origin>/<username>`。
- **Windows / Linux**：只声明 backend 名字与 `supported:false`；`fill()` 返回 `UNSUPPORTED_PLATFORM`，不执行任何假读取。
- **错误收敛**：凭据读取失败只有 `CREDENTIAL_NOT_FOUND` / `UNSUPPORTED_PLATFORM` 两个公开错误码；CLI 的 stdout/stderr、账号、站点、用户名不拼进错误或日志。
- **`fill()` 接口**：签名 `fill(credentialId)`；sink 在构造时注入（`createCredentialStore({fillSink})`），明文只传给 helper 内部注入的 `fillSink(secret, descriptor)`。返回值严格是 `{filled:true}`，不返回明文或元数据回显。**sink 尚未接到任何 driver/CDP，`fill()` 没有默认实现；未接线时调用会得到 TypeError，不会假装填充成功。**
- **测试**：`test/credentials.mjs` 13 项，覆盖成功/不存在/错误/`security` 缺失、Windows/Linux/freebsd、opaque id、空白保留、错误/日志/结果不含哨兵；已接入 `npm test`。

仍未实现 / 明确不承诺：

- 没有 `chrome_credentials` 工具、没有 `chrome_type.credential`、没有 provider 接线；模型当前无法调用这个模块。
- 没有 UDS/native helper、没有第二个 native messaging host、没有安装/签名逻辑。
- 没有真实填充（headless 或桌面）、没有保存/删除条目、没有 Windows Credential Manager / Linux Secret Service 实现。
- 本模块是 Node 原型，明文会短暂存在于 Node 字符串；生产 helper 仍应使用 native 字节缓冲并清零（§3.3）。
- 没有使用任何真实密码或真实 Keychain 条目；测试数据全是哨兵值。
