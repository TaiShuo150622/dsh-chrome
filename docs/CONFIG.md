# 配置（provider config）

配置文件：`~/.dsh/cache/dsh-chrome/config.json`（不存在 = 全部默认）。
修改后需要**重载 provider bundle** 才生效（扩展侧无需改动）。

## 选项

| 键 | 默认 | 含义 | 风险 |
|---|---|---|---|
| `allowEvaluate` | `false` | 为 `true` 时注册第 33 个工具 `chrome_evaluate`；关闭时工具**不存在** | 高：页面内任意 JS |
| `evaluateConfirmTimeoutMs` | `120000` | evaluate 硬确认等待上限；超时 → `APPROVAL_TIMEOUT` | 低 |
| `captureConfirmTimeoutMs` | `120000` | 抓包确认等待上限（start 固定硬确认，没有配置逃逸口） | 低 |
| `contextViewer.allowInput` | `false` | context viewer 的点击/输入/滚动写操作 opt-in；默认只读，写请求返回 `403 VIEWER_READ_ONLY` | 高：绕过工具层直接操作页面 |

## 示例

只启用 evaluate，保持抓包每次确认：

```json
{
  "allowEvaluate": true,
  "evaluateConfirmTimeoutMs": 60000
}
```

> 抓包 start 没有 `captureConfirm` 逃逸口：每次必须用户在 GUI 确认（0.1.76 起固定 hard）；`captureConfirmTimeoutMs` 只控制等待上限。

## 硬确认行为

- 不受会话 `danger-full-access` 影响：确认由 `ctx.userQuestions`（DSH GUI 问题卡）完成，不走普通 `approval` 服务；
- 拒绝 → `APPROVAL_DENIED`；超时 → `APPROVAL_TIMEOUT`；子代理会话 → `DELEGATED_CALLER`；
- 确认服务不可用 → fail-closed（拒绝）。

## 可选自动更新

`~/.dsh/config.json` 的 `update.enabled`（默认 false）开启发布检查；`update.autoInstall` 仅 Windows 自动更新 host exe。详见 [AUTO-UPDATE.md](AUTO-UPDATE.md)。

## 数据边界

- `chrome_evaluate`：表达式与返回值会进入会话日志/模型上下文（页面内容不可信）。
- `chrome_capture_*`：
  - 只采集 method/URL/status/mimeType/resourceType/时长/截断后的 body；
  - **不采集 headers**（Cookie / Authorization / Set-Cookie 不进入任何输出）；
  - URL secret 参数、JSON/form 的 secret key、Bearer/JWT/sk-/AKIA 字符串 → `«redacted»`；
  - 单 capture body 预算 8 MiB，响应 4 KiB / 请求 2 KiB 截断（读取时最多放大到 64 KiB）；
  - 抓包期间 Chrome 显示「正在调试此浏览器」横幅，最长 10 分钟自动停止。
- 抓包缓冲在扩展 Service Worker 内存；worker 被回收后 `chrome_capture_requests` 返回 `CAPTURE_LOST`，不会假装还在抓。
- viewer（`chrome_context {op:"viewer"}` / `chrome_screencast {op:"viewer"}`）：带 `token`/`access` 的 URL 只写进本机 0600 文件，工具结果、render 与 operation log 里只有 `handle` + `urlFile` + `hint`；viewer 输入默认只读，opt-in 后每次写操作写 audit（不记输入文本/URL）。
