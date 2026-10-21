# 公共契约（A-01）

> 基线：0.2.21 / commit 3014180。四条执行线必须遵守；变更需 Lead + 审查者确认，不自行发明公共结构。

## 1. 传输与协议

- Native host ↔ provider：`net` socket/POSIX 或 Windows 命名管道，JSON lines，首帧 `hello` token 握手。
- provider ↔ extension：native messaging JSON 帧，`id` 请求/响应，event frame 预留。
- 协议版本 `PROTOCOL_VERSION`（当前 1）：hello/hello-ok 必须带版本；不兼容返回稳定错误码 `PROTOCOL_VERSION_MISMATCH`，不要静默降级。
- `id` 只在当前连接 generation 内有效；重连/重载后旧 id 的响应必须丢弃。

## 2. ID 体系

| ID | 生成者 | 生命周期 | 作用域 |
|---|---|---|---|
| contextId | `BrowserContextManager` | context create→close | 单 provider |
| tabId | `HeadlessDriver` / extension | tab open→close | 单 context/浏览器 |
| owner | DSH session/agent id | provider run | 单 DSH 会话 |
| runId | 工具/verify/操作日志 | 一次 agent run | 跨 context/tab |
| callId | operation log | 一次工具调用 | 单 provider |
| captureId | capture start | capture start→stop/TTL | 单 tab |
| leaseId | BrowserLeaseManager | acquire→release/expire | 单 tab |

`runId` 不是安全边界；owner 才是授权边界。子代理写动作只允许 owner 自己的 context/tab。

## 3. 错误码

- 通用：`INVALID_ARGUMENT`、`UNSUPPORTED_BACKEND`、`NOT_CONNECTED`、`BRIDGE_RESTARTING`、`TIMEOUT`、`INTERNAL`。
- context/tab：`CONTEXT_NOT_FOUND`、`TAB_NOT_FOUND`、`RESOURCE_LIMIT`、`CONTEXT_CRASHED`、`PROFILE_IN_USE`。
- 资源：`CAPTURE_NOT_FOUND`、`CAPTURE_EXPIRED`、`HEADLESS_EXECUTABLE_NOT_FOUND`、`HEADLESS_CDP_TIMEOUT`。
- 安全：`APPROVAL_DENIED`、`APPROVAL_TIMEOUT`、`SITE_BLOCKED`、`SENSITIVE_SELECTION`、`USER_PAUSED`。
- 凭据：`CREDENTIAL_NOT_FOUND`、`CREDENTIAL_ORIGIN_MISMATCH`、`UNSUPPORTED_PLATFORM`。
错误码只增不改；同一语义不得换名。

## 4. 资源 owner 与清理

- `BrowserContextManager` 拥有 context 生命周期；`HeadlessDriver` 拥有 Chrome/CDP/tab/capture/screencast 状态；`BridgeServer` 拥有 socket/pending；`MemoryMonitor` 拥有采样 ring。
- 每个资源只有一个正常释放路径和一个异常释放路径；所有释放幂等。
- 关闭顺序：tab → capture/screencast → driver/CDP → Chrome process → context/profile 清理 → owner 归零。
- 任何失败初始化必须回滚已创建资源；不得留下 target/session/map/timer。
- 资源上限（默认）：maxContexts=4、maxTabs=12、capture entries=300/hard 1000、capture body=8MB、console=500、host pending=64、screenshot frame 有硬上限。
- 超限必须返回 `RESOURCE_LIMIT`，不得先创建资源再报错。

## 5. 可观测性契约

- `chrome_memory_stats` 只返回数值/计数/告警，不返回页面内容或凭据；`chrome_health` 当前由 `chrome_status` 承担。
- 采样可 1s 一次，内存 ring ≤600，JSONL 0600、轮转、≤2 天；监控本身不能显著增加内存。
- 日志/operation log 不写页面正文、密码、OTP、token、cookie、Authorization；只记大小/数量/哈希。

## 6. 版本兼容

- package/manifest/provider/host 版本一致；host 的 `HOST_VERSION` 由构建注入，不硬编码 0.0.1。
- release 更新只使用 SHA-256 + 可选签名校验；autoInstall 默认关闭，签名完成前不默认启用。
- 不兼容时保留旧版本/回滚路径，返回稳定错误码；不允许静默用旧协议。

## 7. 公共文件改动规则

- `index.js`、`package.json`、`src/config.js`、`src/tools.js`、公共 docs 属于集成文件；执行线不得直接改，需 Lead 的接入任务。
- 每条线只改任务卡列出的目录；跨线共享代码通过明确接口/适配层，不互相 rebase 对方分支。
