# 配置（provider config）

配置文件：`~/.dsh/cache/dsh-chrome/config.json`（不存在 = 全部默认）。
修改后需要**重载 provider bundle** 才生效（扩展侧无需改动）。

## 选项

| 键 | 默认 | 含义 | 风险 |
|---|---|---|---|
| `allowEvaluate` | `false` | 为 `true` 时注册第 33 个工具 `chrome_evaluate`；关闭时工具**不存在** | 高：页面内任意 JS |
| `evaluateConfirmTimeoutMs` | `120000` | evaluate 硬确认等待上限；超时 → `APPROVAL_TIMEOUT` | 低 |
| `captureConfirm` | `"hard"` | `"hard"`：每次 `chrome_capture_start` 弹确认卡；`"follow-dsh"`：跟随会话策略（**仅本地自动化验证用逃逸口**，danger-full-access 下等于无确认） | 高：抓包含页面数据 |
| `captureConfirmTimeoutMs` | `120000` | 抓包确认等待上限 | 低 |

## 示例

只启用 evaluate，保持抓包每次确认：

```json
{
  "allowEvaluate": true,
  "evaluateConfirmTimeoutMs": 60000
}
```

本地自动化验证抓包（**不要长期保留**）：

```json
{
  "captureConfirm": "follow-dsh"
}
```

## 硬确认行为

- 不受会话 `danger-full-access` 影响：确认由 `ctx.userQuestions`（DSH GUI 问题卡）完成，不走普通 `approval` 服务；
- 拒绝 → `APPROVAL_DENIED`；超时 → `APPROVAL_TIMEOUT`；子代理会话 → `DELEGATED_CALLER`；
- 确认服务不可用 → fail-closed（拒绝）。

## 数据边界

- `chrome_evaluate`：表达式与返回值会进入会话日志/模型上下文（页面内容不可信）。
- `chrome_capture_*`：
  - 只采集 method/URL/status/mimeType/resourceType/时长/截断后的 body；
  - **不采集 headers**（Cookie / Authorization / Set-Cookie 不进入任何输出）；
  - URL secret 参数、JSON/form 的 secret key、Bearer/JWT/sk-/AKIA 字符串 → `«redacted»`；
  - 单 capture body 预算 8 MiB，响应 4 KiB / 请求 2 KiB 截断（读取时最多放大到 64 KiB）；
  - 抓包期间 Chrome 显示「正在调试此浏览器」横幅，最长 10 分钟自动停止。
- 抓包缓冲在扩展 Service Worker 内存；worker 被回收后 `chrome_capture_requests` 返回 `CAPTURE_LOST`，不会假装还在抓。
