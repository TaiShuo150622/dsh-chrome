# 安全模型（P2 + 批次 C 后）

## 边界

```
模型（DSH 会话）
  └─ provider 插件（本机进程，DSH Desktop 内）
       └─ UNIX socket（~/.dsh/cache/dsh-chrome/bridge.sock，0600，随机 token）
            └─ native messaging host（Chrome 拉起，本机进程）
                 └─ Chrome MV3 扩展（固定 ID）
                      └─ 用户的真实 Chrome（登录态）
```

- 所有通信都在本机：UNIX socket + Chrome native messaging，不监听 TCP 端口。
- `bridge.json` 权限 `0600`，内含随机 token；host 必须握手通过才收请求。
- native messaging manifest 的 `allowed_origins` 固定为本扩展 ID（由 manifest `key` 决定），其他扩展无法调用该 host。
- 扩展只在 `http(s)` 页面注入 helper；`chrome://`、扩展页、Web Store 等受保护页面直接拒绝。
- 模型看到的页面内容与截图会随对话上下文发送给模型服务商，这是功能本身的语义；敏感页面请自行判断是否让 agent 操作。

## 权限与动作

| 能力 | 实现 | 风险控制 |
|---|---|---|
| 读页面/截图 | CDP `Runtime.evaluate` / `Page.captureScreenshot` | 页面 = 不可信输入；快照对密码/支付输入打码 |
| 写动作（goto/click/type/press/scroll/history/tabs/upload/claim） | CDP 合成事件 / tabs API | 走 `follow-dsh` 审批门；`danger-full-access` 直接放行，低权限模式走 `ctx.approval` |
| console/network | 主世界 hook / Resource Timing | 只读本地缓冲 |
| upload | `DOM.setFileInputFiles` | provider 先校验本地文件存在；只接受显式传入的路径；走审批 |
| download | `chrome.downloads.search` | 只读列表，不自动打开文件 |
| dialog | CDP 对话框拦截 | 默认策略：alert 接受；confirm/prompt/beforeunload 取消（需显式 `accept:true`） |
| evaluate（默认关） | CDP `Runtime.evaluate` + CDP timeout | 配置 `allowEvaluate` 才注册；每次调用 `ctx.userQuestions` 硬确认，不受 danger-full-access 影响；拒绝/超时/子代理 fail-closed |
| capture（always registered） | CDP `Network.enable` 事件缓冲 | start **固定硬确认，无配置旁路**（0.1.76 起）；允许/拒绝/超时写审计；不采集 headers；URL/body 脱敏 `«redacted»`；10 分钟自动停；body 预算 8 MiB；worker 回收报 `CAPTURE_LOST` |

## 明确不做

- 反检测/隐身、绕过受保护页面与付费墙、自动过 CAPTCHA；
- 读取用户其他标签（`chrome_tabs list` 只列本会话标签；`claim` 需显式调用）；
- 在 Chrome 内聊天（聊天面只在 DSH）。

## 已知限制

- 扩展被 Chrome 回收后的自动恢复依赖自愈 reload（0.1.17，真机验证待补）；
- 调试器 attach 期间 Chrome 可能显示「正在调试此浏览器」横幅（动作结束即 detach）；
- 本插件面向个人本机使用；多用户/远程场景不在当前安全模型内。
