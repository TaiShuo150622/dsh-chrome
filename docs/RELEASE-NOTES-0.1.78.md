# 发布说明：0.1.78（批次 A–D 集成）

> 日期：2026-10-17 · 扩展 0.1.78 · provider 0.1.73 · 工具面 37（`allowEvaluate` 开启后 38）
> 记录：A（内部记录） · B（内部记录） · C（内部记录） · D（内部记录）

## 这一版带来了什么

### 页面覆盖（批次 A/B）

- **open Shadow DOM**：快照/点击/输入/选择/拖拽/读取均可进入 shadow root（closed 明确不支持）；
- **iframe 全链路**：`chrome_snapshot` 聚合所有 frame（`f<frameId前8位>:<ref>`），click/type/hover/wait/find/get_text/screenshot（含元素截图偏移）支持 `frameRef`；跨源 iframe 真机验证；
- **坐标点击** `chrome_click_at`（Canvas/地图/自绘控件）、**chrome_html**（value/token/csrf 等脱敏）、**chrome_selection**（选区 + 来源）。

### 高敏感能力（批次 C）

- **debugger 会话管理器**：9 处 attach/detach 收敛为 1 处引用计数会话，抓包可 pin 住会话；dialog 拦截、onDetach/tab 关闭清理统一；
- **chrome_evaluate**：默认不注册（`config.json` 的 `allowEvaluate` 开启），每次 `userQuestions` 硬确认，CDP timeout 可打断死循环；
- **HTTP 抓包** `chrome_capture_start/stop/requests`：method/URL/status/mimeType/类型/时长 + 截断脱敏 body；**headers 永不采集**；start 每次硬确认；抓包期间页面动作不打断；stop 后冻结可读；10 分钟自动停。

### 协作与信任（批次 D）

- **站点策略** `policy.json`（allow/ask/block，人工维护）+ **审计** `audit.jsonl`；`chrome_policy` / `chrome_audit` 只读查询；
- **元素拾取** `chrome_pick`：覆盖层 + 高亮，返回可直接使用的 ref（阻塞 / nowait+poll / cancel）；
- **切页 pause/follow**：用户切走后变更动作返回 `USER_SWITCHED`，`chrome_resume` / `chrome_tabs focus` 恢复；
- **截图历史** `chrome_shots`：文件系统持久化，list/read。

## 默认安全姿态

| 能力 | 默认 |
|---|---|
| 普通写操作 | follow-dsh（danger-full-access 放行；站点 allow/block 覆盖） |
| evaluate | 不注册；开启后每次硬确认 |
| 抓包 start | 每次硬确认 |
| headers | 不采集 |
| 密码/支付字段 | 快照/选区/抓包输出均打码或拒绝 |

## 验证状态

- `npm test` 10 条全过；工作树干净；
- 桌面 Chrome 真机：A 批全部、C 批（C0 回归/evaluate 超时/抓包）、D1–D4（pick/pause 已复验）；
- Chrome for Testing 真机：B 批、D2/D3 交叉验证（跨源 iframe、pick、pause）；
- **遗留**：真实站点 gate（iframe 支付/Web Components/Canvas/JSON API）待用户提供站点；D2 真实用户点击可作为可选补验。

## 升级/恢复

1. `chrome://extensions` → DSH Desktop Chrome → **⟳**（加载 0.1.78）；
2. 若仍断开：完全退出 Chrome 后重开；
3. 诊断：`npm run status`、`tail ~/.dsh/cache/dsh-chrome/host.log`；
4. 配置见 [CONFIG](CONFIG.md)，安全边界见 [SECURITY](SECURITY.md)。
