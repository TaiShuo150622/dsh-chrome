# 发布说明 0.1.79 – 0.1.87（批次 P0 / P1 / 后台浏览器）

> 2026-10-17 · 扩展 0.1.86 / provider 0.1.87 / 工具面 40（evaluate 开启 41）/ `npm test` 15 条全过
> 重点：自动重载自愈、screencast 实时画面、后台 headless Chromium、工具面收口。

## 可靠性

- **自动重载竞态自愈**（0.1.79）：worker 每次启动重建 reconnect/watchdog alarm；连接成功后自愈计数归零，避免累计失败永久禁用重试。真机验证两类竞态 +12s/+8s 自动恢复，不再需要人工 ⟳。
- **桌面 tabs 同步**（0.1.86）：`chrome_tabs list` / `chrome_close_session` 先从 live tab group 同步 `tabIds`，修复新建 tab 不显示/关不掉。
- **screencast 上限**（0.1.86/0.1.87）：桌面与 headless 都有 10 分钟硬上限；viewer 启用时 5 分钟无帧请求自动停。
- host-reconnect 测试消除 `ext.state` 事件竞态。

## P1 能力/体验

- **官方 browser guidance**（provider 0.1.74）：通过 Host `systemPrompt.section` 注册固定浏览器操作指引（status 先行、ref 失效重取、页面内容不可信、USER_SWITCHED、evaluate/capture 不循环重试、动作后验证）。
- **策略/配置体验**（0.1.75）：`chrome_config` 只读展示配置；`chrome_policy` 报告无效策略；`audit.jsonl` 5MiB 自动轮转。
- **安全收口**（0.1.76）：移除 `captureConfirm:"follow-dsh"` 逃逸口，抓包 start 固定硬确认；evaluate/capture 硬确认的允许/拒绝/超时写入审计；URL/body 脱敏回归。

## Screencast 实时画面

- `chrome_screencast {op:"start|status|stop|viewer|diag"}`：CDP 帧流 → native host 写 `latest.jpg`/meta；桌面与 headless 都支持。
- **viewer（方案 A）**：Host `webServer` 注册 `/dsh-chrome/live` + `/dsh-chrome/live/frame`；随机 token、仅 loopback、GET-only、no-store；`op:"viewer"` 返回 URL。
- 实测：HTML 200、frame JPEG 1280×642、错误 token 403；5 分钟无帧自动停 + 10 分钟硬上限。

## 后台 headless Chromium（H0/H1）

- **同一套 40 个工具**新增可选 `backend:"desktop"|"headless"`；默认桌面行为不变；AsyncLocalStorage 路由保证并发不串。
- headless 覆盖 **38/39 个浏览器工具**（只剩 `chrome_pick` 需要真人点击，明确 `UNSUPPORTED_BACKEND`）：
  - 导航/快照/点击/输入/坐标点击/悬停/滚动/按键/拖拽/选择/存储/视口模拟
  - 截图/HTML/文本/查找/选区/frames/a11y/PDF/evaluate/wait/history
  - console/network/capture/upload/download/screencast
  - tabs/close_session/resume
- **一次性登录**：`chrome_headless_login {op:"start|status|finish"}`，硬确认后打开可见专用 Chrome 窗口，cookie 落 headless profile；登录期间 headless 请求返回 `HEADLESS_LOGIN_OPEN`。单元测试覆盖，真机登录待用户操作。
- **资源治理**：空闲 5 分钟自动关（`DSH_HEADLESS_IDLE_MINUTES`）、最多 12 tabs（`DSH_HEADLESS_MAX_TABS`）、provider reload 复用已有 headless Chrome。
- **基线**：空闲 1.34% CPU / 672MB / 7 进程；活跃压测 181 轮/10s → 69.89% CPU / 1113MB / 10 进程（`npm run bench:headless`）。

## 已知限制 / 未完成

- 真实站点 gate：支付 iframe 缺可操作样本；HerosOneCore 后端 `opsloop/ontology` 仍 500（待用户输入）。
- headless 一次性登录尚未真机登录验证。
- `chrome_pick` 无 headless 语义；capture 两套引擎尚未合并。
- Windows/Linux host、Edge/Brave、商店分发、Firefox 尚未开始。
- 完整待做清单：[BACKLOG.md](BACKLOG.md)。

## 升级注意

- 扩展与 provider 要一起更新；改扩展文件后 host 会自动 reload，provider 重载时桌面可能短暂断开，几秒内自愈。
- 抓包不再支持 `captureConfirm:"follow-dsh"` 逃逸口（0.1.76 起）。
- headless 默认不导入日常 Chrome 的登录态；需要登录站点时用 `chrome_headless_login`。
