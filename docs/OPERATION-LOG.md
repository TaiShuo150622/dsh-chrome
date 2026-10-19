# 操作记录（operations.jsonl）

`chrome_*` 工具的每一次调用都会在 `~/.dsh/cache/dsh-chrome/operations.jsonl` 追加一行 JSON。它回答的是「哪个工具、走哪个 backend、什么时候、跑了多久、成功还是失败、参数和结果大致是什么」，用于审计和复盘；不保存页面内容。

实现：

- [`src/operation-log.js`](../src/operation-log.js)：写入、脱敏、限长、轮转、统计；
- [`index.js`](../index.js)：在工具注册处包一层。顺序固定为
  `wrapToolsForBackend()` → `wrapToolsForOperationLog()` → `ctx.tools.register()`，所以记录到的是实际 backend（`args.backend`，缺省用 router 默认），而工具本身收到的参数、返回值和抛出的错误都保持原样。

日志写入是 best-effort：任何失败都被吞掉，不会改变工具行为。

## 位置、权限、开关

| 项 | 值 |
|---|---|
| 路径 | `<DSH_HOME>/cache/dsh-chrome/operations.jsonl`；未设置 `DSH_HOME` 时是 `~/.dsh/cache/dsh-chrome/operations.jsonl` |
| 文件权限 | `0600`（目录创建时 `0700`；已存在的目录不改权限） |
| 关闭 | `DSH_OPERATION_LOG=0`（也接受 `false` / `off`）；关闭后不创建文件、不写盘 |
| 轮转阈值 | `DSH_OPERATION_LOG_MAX_BYTES`，默认 `4194304`（4 MiB）；非正数/非法值回退默认 |
| 单行上限 | 2048 字节（含换行） |

关闭只影响之后的写入，已经写下的文件保留，需要时自行删除。

## 格式

每行一个 JSON 对象，字段白名单固定，不写入未知字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `v` | number | 格式版本，当前为 `1` |
| `startedAt` | string | 调用开始时间，ISO 8601（UTC） |
| `tool` | string | 工具名，如 `chrome_goto`（最长 80） |
| `backend` | string | `desktop` 或 `headless` |
| `durationMs` | number | 调用耗时（整数毫秒，≥0） |
| `ok` | boolean | 工具是否正常返回（抛出错误为 `false`） |
| `errorCode` | string \| null | 成功为 `null`；失败取 `error.code`，其次 `error.name`，都没有则 `INTERNAL` |
| `args` | object | 参数摘要，见下 |
| `result` | object | 结果摘要，见下 |
| `truncated` | boolean | 仅当整行超过上限、需要进一步收缩时出现 |

示例（实际是一行）：

```json
{"v":1,"startedAt":"2026-10-17T21:31:00.000Z","tool":"chrome_type","backend":"headless","durationMs":31,"ok":true,"errorCode":null,"args":{"ref":12,"text":"hello hello …","password":"«redacted»"},"result":{"tabId":9,"textLength":1000,"visible":true}}
```

失败示例（不记录错误消息，只记录错误码）：

```json
{"v":1,"startedAt":"2026-10-17T21:32:00.000Z","tool":"chrome_goto","backend":"desktop","durationMs":2,"ok":false,"errorCode":"NAV_FAILED","args":{"url":"[invalid-url 11 chars]"},"result":{}}
```

## 参数摘要（args）

先做脱敏，再做截断：

- **URL**：去掉 `userinfo`（`user:pass@` 整段不出现）；查询参数与 fragment 中名称像 secret 的值替换成 `«redacted»`（`token`、`secret`、`password`、`api_key`、`signature`、`session_id`、`code`、`access` 等，见 `isSecretQueryName()`）；其余查询值截断 80 字符；URL 总计最长 400 字符。非 http(s) URL 只记录 `[non-http-url N chars]`，data URL 只记录 `[data-url N chars]`。
- **字段名脱敏**：名称命中 password/passwd/passphrase、secret、token、api_key、authorization、cookie、credential、session_id、private_key、csrf/xsrf、signature 等规则的字段，值替换成 `«redacted»`，嵌套对象同样处理。
- **chrome_storage 特例**：如果同级的 `key`/`name` 本身像 secret，`value`/`values` 也替换成 `«redacted»`。
- **行内 secret**：字符串里出现的 `token=...`、`password: ...`、`Bearer ...`、`sk-...`、JWT、`AKIA...` 会被替换掉。
- **长文本**：普通字符串截断到 160 字符，以 `…` 结尾；URL 类字段最多 400。
- **内容字段**：键名为 `html`、`body`、`content`、`data`、`dataBase64`、`base64`、`image`、`screenshot`、`responseBody`、`requestBody` 的值不记录内容，只记录 `[omitted N chars]`。疑似 base64 的长字符串记录成 `[base64 N chars]`。
- **结构上限**：最多 2 层嵌套；各层最多 16/12/8 个键；数组最多 6 项。参数摘要总大小约 800 字节；被裁掉时摘要对象里会出现 `"_truncated": true`。

## 结果摘要（result）

结果按**严格白名单**生成，未列出的字段一律丢弃，因此不会把页面大内容带进日志：

- 只保留：id/引用（`tabId`、`ref`、`frameRef` 等）、计数（`count`、`groupCount`、`tabCount` 等）、布尔状态（`ok`、`connected`、`active` 等）、URL（同样脱敏）、标题（最长 120）、状态类短字符串（`loadState`、`mode`、`status`、`op` 等）、版本/格式等。
- 页面文本/HTML/body/截图 base64 等字段只记录长度：`textLength`、`htmlLength`、`dataBase64Length`……
- 列表字段只记录数量：`tabsCount`、`entriesCount`、`itemsCount`……
- 结果里若有 `error` 字段，只记 `resultError: true`，不记录消息。
- 结果摘要总大小约 400 字节。整行超过 2048 字节时会进一步收缩（`args` → 240 字节、`result` → 120 字节，必要时清空摘要），并写 `truncated: true`。

## 容量与轮转

- 每次写入前检查：`当前大小 + 本条字节数 > 阈值` 时，把 `operations.jsonl` 重命名为 `operations.jsonl.1`（覆盖旧的 `.1`），再写新文件。进程内缓存的大小在轮转时归零；轮转前先关闭 fd（否则 fd 跟着 inode 走，会继续写进 `.1`）。
- 只保留**一个**轮转文件。正常配置下，活动文件不超过阈值，磁盘占用约 `2 × 阈值`（默认约 8 MiB）。
- 如果阈值被设得比单行还小，活动文件可能超过阈值；但单行仍不超过 2048 字节。
- 轮转是 best-effort：重命名失败时继续写活动文件。多会话/多进程同时写时，轮转存在竞态：缓存大小每 16 条或 250ms 才复核一次（`APPEND_REFRESH_APPENDS`），别的进程在这段窗口里写入的字节可能让活动文件**超出阈值最多约 16 条记录**（默认阈值下可忽略）；极端情况下最后一行可能是半行，读取统计时会跳过无法解析的行。

## 统计

```js
import { readOperationStats } from './src/operation-log.js'

const stats = readOperationStats({ limit: 20 })
```

返回：

| 字段 | 说明 |
|---|---|
| `path` | 活动文件路径 |
| `enabled` | 当前 `DSH_OPERATION_LOG` 是否开启 |
| `maxBytes` | 当前轮转阈值 |
| `bytes` / `entries` | 活动文件字节数 / 非空行数 |
| `rotatedBytes` / `rotatedEntries` | `.1` 文件的字节数 / 非空行数 |
| `totalBytes` / `totalEntries` | 两个文件合计 |
| `recent` | 最近 N 条记录，新的在前；活动文件不够时再从 `.1` 补。`limit` 默认 20，最大 100 |

`entries` 统计的是非空行（包含损坏行）；`recent` 会跳过损坏行。统计只读文件，不修改任何内容，也不会抛错。默认配置下最多读约 8 MiB，不建议在热路径里频繁调用。

## 性能

- 工具正常返回或抛错后，在 `finally` 里执行一次追加；每条记录先脱敏、截断到 2 KiB 再写。
- **稳态只做一次 `writeSync`**：进程内按日志文件缓存一个追加 fd 和当前字节数（`APPEND_STATE`），不再每次 `mkdir + stat + open/write/close`；目录在建过一次后不再重复 `mkdir`。缓存的大小/句柄每 16 条或 250ms 用一次 `statSync` 复核（`APPEND_REFRESH_APPENDS`），复核发现文件被替换/删除就重开，发现别的进程写大了就采纳真实大小后再判断轮转。
- 任何一次缓存路径出错都会丢弃缓存、退回原来的 one-shot 路径（`appendLineUncached`），所以日志仍然 best-effort、`appendOperation()` 仍然不抛错。
- 实测（2026-10-17，同机交替 A/B，本机 SSD，记录约 285–365 字节/条）：

| 场景 | 改前 | 改后 |
|---|---|---|
| 10k 次 append（小记录） | 0.055–0.057 ms/次、CPU 0.059–0.061 ms | **0.018–0.021 ms/次、CPU 0.022–0.026 ms**（−65%） |
| 每次 `chrome_*` 调用的记录开销（wrapper 实测） | 0.0646 ms、CPU 0.074 ms | **0.025–0.027 ms、CPU 0.033–0.034 ms**（−60%） |
| 144KB `text` 参数（长 `type`/`evaluate`） | 0.74–0.80 ms | **0.036 ms**（−95%） |
| 60KB `expression` | 0.17 ms | **0.044 ms**（−74%） |
| 6000 条混合记录：GC 次数 / GC 时间 / 堆增长 | 88–89 次 / 75–81 ms / 28–36 MB | **52–54 次 / 4.5–4.9 ms / 0.8–1.9 MB** |

- 大参数快那么多是因为 `looksLikeBase64()` 以前会先把整个参数（可能几百 KB）压成一份无空白副本再取样；现在只在**前 1024 字符**里取样。副作用：base64 只会被认出来自开头那一段——真 base64 没有空白，实际不受影响。
- 关闭日志时在打开文件前就返回，不产生文件系统操作（也不会打开 fd）。
- 没有后台线程、网络请求或额外工具调用；日志失败不改变工具的返回值/异常。
- 以同步方式写盘是为了记录不丢失、顺序稳定；如果磁盘本身卡住，append 会像其他同步 I/O 一样等待。这是有意的取舍。
- 每条记录的**内容**没有变化：改前改后同一批记录的字节数逐条相同，字段白名单、脱敏规则与 2 KiB 上限都不变。

## 已知限制

- **没有内容级回放**：只记录摘要，页面文本、HTML、body、截图/PDF base64、console/network body 都不保存，无法据此还原页面。
- **不记录错误消息**：只有 `errorCode`；排查具体失败原因仍需看工具返回或日志。
- **只保留一个轮转文件**：`.1` 会被下一次轮转覆盖，没有长期归档。
- **不是防篡改审计**：没有签名/哈希链，同账号用户可以直接编辑或删除；`0600` 只限制其他账号。
- **脱敏按字段名和已知模式**：藏在普通字段名下的秘密（例如把 token 放进 `chrome_type.text`）只能做行内模式脱敏，不能保证识别；长文本会有前 160 字符进入日志。不要把操作日志当作密钥保管设施。
- **统计是同步整文件读取**：默认上限下约 8 MiB；把 `DSH_OPERATION_LOG_MAX_BYTES` 调得很大时，`readOperationStats()` 的读取成本随之增加。
- **并发轮转**：多个会话同时写时，轮转/重命名可能竞态；单行 append 在 POSIX 上通常原子，但没有跨进程锁。
- **缓存句柄的陈旧窗口**：写入方按日志路径缓存 fd 和大小，最多 16 条或 250ms 复核一次。在这段窗口里：外部删除/替换的日志文件不会立刻重建（期间写入落到已 unlink 的 inode，会丢）；别的进程写入时阈值可能被小幅超出。日志会自己恢复，不需要重启进程。
- **一个 fd**：启用了日志的进程会一直持有一个日志文件描述符（轮转时换成新文件的）；`DSH_OPERATION_LOG=0` 时不打开、不持有。
- **只覆盖 `chrome_*` 工具**：native host、扩展内部消息、browser-use 内部调用不经过这层，不会出现在 `operations.jsonl`。
