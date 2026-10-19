# 隔离浏览器上下文（I1）

> 0.1.94 起：`backend:"headless"` 的调用会按 **DSH 会话（agent id）** 懒创建独立的 headless context；每个 context 有自己的 profile、截图/下载目录，任务结束/空闲清理。新增 `chrome_context` 管理工具。

## 1. 为什么

- 不同 DSH 会话默认不共享浏览器 cookie/storage；
- 适合沙箱操作后的网页验证（后台运行，不弹窗）；
- 以后可扩展 `visible-isolated` / `shared-visible`，当前只实现 headless 隔离。

## 2. `chrome_context`

| op | 作用 |
|---|---|
| `create` | 为当前会话创建一个 context；`preset` 默认 `sandbox` |
| `list` | 列出当前会话的 context |
| `current` | 当前 active context |
| `use` | 切换当前会话的 active context |
| `close` | 关闭 context（ephemeral profile 会清理） |

`backend:"headless"` 的工具调用会自动使用当前会话的 active context；没有则按配置默认 preset 新建。`chrome_context` 创建后可通过 `use` 切换。

## 3. 预设（当前）

| preset | isolation | visible | 状态 |
|---|---|---|---|
| `sandbox` | ephemeral | 否 | ✅ 默认，headless |
| `sandbox-persistent` | named | 否 | ✅ headless + 保留 profile |
| `debug` | named | 是 | ✅ I2：独立 profile + 可见 Chrome 窗口 |
| `collab` | shared | 是 | ⏳ I3；lease 基础已落地（0.1.98），collab 仍未启用 |

> tab lease 的语义、错误码与接入点见 [LEASES.md](LEASES.md)；0.1.98 只提供 lease 模块和 `chrome_lease` 工具，尚未接入所有 chrome_* 写动作。

## 4. 配置

用户级：`~/.dsh/config.json`；兼容旧的 `~/.dsh/cache/dsh-chrome/config.json`。
项目级：`<cwd>/.dsh-chrome/config.json`，优先级高于用户级（安全字段取更严格者的规则后续补）。

```jsonc
{
  "version": 1,
  "browser": {
    "preset": "sandbox",
    "maxContexts": 4,
    "idleTimeoutMs": 300000,
    "headless": { "chromeExecutable": null, "viewport": { "width": 1440, "height": 900 } }
  },
  "verification": {
    "screenshotFormat": "png",
    "captureConsole": true,
    "captureNetwork": "metadata",
    "maxArtifactBytes": 52428800
  }
}
```

- 配置里不放密码/API key/secret；
- 未知字段忽略并 warning；错误版本回退默认；
- 配置变更只影响新 context。

## 5. 生命周期

- 每 context 一个独立的 headless Chrome profile（目录不可预测）；
- 空闲 `idleTimeoutMs`（默认 5 分钟）后关闭；ephemeral profile 删除；
- provider 卸载/停止时关闭所有 context；
- `maxContexts` 默认 4，超过返回 `CONTEXT_LIMIT`；
- named profile 同一时间只能被一个 context 使用（`PROFILE_IN_USE`）。

## 5.1 I2 可见隔离（0.1.97）

- `chrome_context {op:"create", preset:"debug"}` 创建**独立 profile + 可见 Chrome 窗口**；`backend:"headless"` 的工具调用会操作这个窗口；
- visible context 不参与空闲回收（窗口属于用户，必须显式 `close`）；
- 适合人工登录、CAPTCHA、演示和调试；
- 仍是独立 profile，不与用户日常 Chrome/其他会话共享 cookie。

## 6. 当前限制

- 隔离 preset（`sandbox` / `sandbox-persistent` / `debug`）已实现；shared `collab` 仍未启用（0.1.98 只落地 lease 基础，见 [LEASES.md](LEASES.md)）；
- 还没有 `chrome_verify` 断言编排；先用 snapshot/screenshot/console/network 让 agent 断言；
- 还没有跨平台 Chrome 路径自动探测的完整矩阵（沿用现有 headless 探测）；
- `chrome_verify` 的 report/screenshot 会保存到全局 artifacts 目录（`~/.dsh/cache/dsh-chrome/artifacts/verify-<runId>/`），context 关闭后仍保留；默认保留最近 50 次，可用 `verification.artifactRetentionRuns` 调整。

## 7. `chrome_verify`（I1.5）

在隔离 context 上做可重复验证：

```text
chrome_verify {
  contextId?, url?,
  steps: [
    { action: "navigate", url },
    { action: "waitFor", selector|text|url, timeoutMs? },
    { action: "click", selector|ref },
    { action: "type", selector|ref, text, replace? },
    { action: "assert", checks: [
      { type: "url", contains|matches },
      { type: "title", contains },
      { type: "text", contains },
      { type: "element", selector, state: "visible"|"absent"|"enabled", contains? },
      { type: "console", maxErrors },
      { type: "network", maxFailures, urlPattern? }
    ] }
  ]
}
```

返回 `{ok, contextId, url, durationMs, checks[], artifacts[]}`；每次运行都会保存 JSON report + 截图到该 context 的 `artifacts/`。首期不支持任意 JS 断言（element 检查用固定 querySelector 表达式）。
