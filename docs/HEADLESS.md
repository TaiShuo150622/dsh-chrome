# 后台浏览器（headless Chromium）H0/H1

> 2026-10-17 · provider 0.1.87 · 扩展 0.1.86 · 工具面 40（新增 `chrome_headless_login`）
> 目标：不显示在桌面上也能调用浏览器，同时保留前台可见的 Chrome 登录态。

## 1. 为什么是「另起一个浏览器」

Claude 相关实现分两类（官方文档）：

- **Claude in Chrome / Claude Code Chrome 集成**：控制用户可见的 Chrome，共享登录态；
- **Computer Use**：控制真实桌面（mac) / 虚拟机，仍不是"隐藏的浏览器"。

真正后台跑，业界常见做法是另起 **headless Chromium / 云浏览器 / VM**。本项目采用：

```text
桌面 Chrome（可见，登录态） ── 扩展/native host ──┐
                                                   ├─ BackendRouter ── chrome_* 工具（同一套 39 个）
本地 headless Chromium（无窗口） ── CDP ───────────┘
```

每个 `chrome_*` 工具多一个可选参数 `backend`：

```json
{ "url": "https://example.com", "backend": "headless" }
```

- 省略或 `"desktop"`：走原来的扩展，用户可见；
- `"headless"`：走 provider 自己拉起的 headless Chromium（独立 profile，无窗口）。

并发安全：后端选择放在 `AsyncLocalStorage` 里，异步工具执行期间不会串。

## 2. 已实现（H0 验证通过）

启动方式：provider 首次收到 `backend:"headless"` 请求时，spawn：

```text
Chrome --headless=new --remote-debugging-port=0
       --user-data-dir=~/.dsh/cache/dsh-chrome/headless/profile
       --no-first-run --no-default-browser-check --disable-extensions ...
```

Profile 持久保存（`~/.dsh/cache/dsh-chrome/headless/profile`），但**默认不导入用户 Chrome 的 cookie**，所以：

- 公开站点、批量任务、回归测试：直接可用；
- 需要登录的站点：后续加「一次性登录」流程（见 §5）。

已实现的方法（同一套工具可直接用）：

| 工具 | headless 支持 |
|---|---|
| `chrome_status` | 显示 backend + headless 运行状态（`headless: available (running ...)`） |
| `chrome_goto` `chrome_tabs` `chrome_snapshot` | ✅ 导航 / tab 列表/新建/关闭/claim/focus / 快照（含 refs） |
| `chrome_click` `chrome_type` `chrome_click_at` `chrome_hover` `chrome_scroll` `chrome_press` | ✅ DOM 级点击、输入（React/Vue-safe setter）、坐标点击、悬停、滚动、按键 |
| `chrome_screenshot` | ✅ 截图写 `~/.dsh/cache/dsh-chrome/headless/screenshots/`，作为图片附件返回 |
| `chrome_evaluate` | ✅（仍受 provider 的 `allowEvaluate` 硬确认约束） |
| `chrome_html` `chrome_text` `chrome_selection` | ✅ |
| `chrome_frames` `chrome_a11y` | ✅ CDP frame tree / AX tree |
| `chrome_history` `chrome_wait` `chrome_pdf` | ✅ |
| `chrome_select` `chrome_drag` `chrome_storage` `chrome_emulate` `chrome_find` `chrome_get_text` | ✅（ref/selector、select/checkbox、拖拽、localStorage/sessionStorage、CDP 视口覆盖、文本查找/读取） |
| `chrome_console` | ✅ Runtime.consoleAPICalled / exceptionThrown 缓冲（按 tab，最多 200 条） |
| `chrome_capture_start/requests/stop` | ✅ Network 域抓包：XHR/fetch/document、URL 脱敏、secret 参数/JSON/form 字段脱敏、body 预算 8MiB、10 分钟自动停、按 owner 隔离 |
| `chrome_network` | ✅ performance resource timing（URL/type/duration/transferSize） |
| `chrome_upload` | ✅ `DOM.setFileInputFiles`（ref 或 selector；文件在 provider 端先校验存在） |
| `chrome_download` | ✅ `Browser.setDownloadBehavior` + download 事件；文件落 `~/.dsh/cache/dsh-chrome/headless/downloads/` |
| `chrome_resume` | ✅ no-op（headless 没有前台暂停语义） |
| `chrome_screencast` | ✅ CDP Page.startScreencast → 写 `latest.jpg`/meta；配合 `op:"viewer"` 可看 headless 实时画面；10 分钟硬上限自动停 |
| `chrome_close_session` | ✅ 关闭该 owner 的 headless tabs |

实测（桌面 Chrome 未受任何影响）：

```text
chrome_status                              → desktop CONNECTED，headless: available
chrome_goto   {backend:"headless"}         → DSH Chrome P1 Test Page (complete)
chrome_snapshot {backend:"headless"}       → 8 controls, refs 1..8
chrome_type   {backend:"headless", ref:1}  → value "Headless"
chrome_click  {backend:"headless", ref:2}  → Greet
chrome_snapshot {backend:"headless"}       → 页面文本出现 "Hello Headless"
chrome_screenshot {backend:"headless"}     → 1440x813 PNG，无桌面窗口
chrome_close_session {backend:"headless"}  → closed 1
chrome_status                              → desktop 仍 CONNECTED；headless running Chrome/155
```

证据截图：[headless-test-page.png](records/2026-10-17-code-headless/attachments/headless-test-page.png)（1440×813，headless 截图；桌面没有窗口）。

## 2.2 一次性登录（持久 profile）

headless profile 默认不导入用户 Chrome 的 cookie；需要访问登录站点时用：

```text
chrome_headless_login {op:"start", url:"https://example.com/login"}
  → 关闭正在跑的 headless Chrome（如有），打开一个**可见的专用 Chrome 窗口**（同一 profile）
  → 用户手动登录
chrome_headless_login {op:"finish"}
  → 关闭登录窗口；cookie 留在 profile 里，之后 backend:"headless" 复用
chrome_headless_login {op:"status"}
```

- `start` 每次都要 **硬确认**；detail 里写明 cookie 会落到 headless profile；
- 登录窗口打开期间 headless backend 会拒绝请求（`HEADLESS_LOGIN_OPEN`）；
- 这是唯一会把登录态写入 headless profile 的入口，日常 Chrome 不受影响。

## 3. 暂不支持（会返回 `UNSUPPORTED_BACKEND`）

| 工具/方法 | 原因 | H1 计划 |
|---|---|---|
| `chrome_pick` | 无"鼠标点页面"的用户交互语义（headless 没有真人点击） | 明确返回 `UNSUPPORTED_BACKEND`；可选用 selector 流程 |
| `chrome_pause` | 前台概念（headless 无暂停语义，`chrome_resume` no-op） | 不需要 |

> 覆盖：40 个工具里 headless 支持 38 个 chrome 工具（除 `chrome_pick` 外全部），加上 `chrome_headless_login`；provider 本地工具（status/config/policy/audit/shots）与 backend 无关，照常可用。
| `chrome_shots` / `chrome_audit` / `chrome_policy` / `chrome_config` | provider 本地工具，与 backend 无关，照常工作 | — |

## 4. 安全与资源

- headless profile 独立，默认**不携带**用户 Chrome 的 cookie/登录态；
- 无窗口、无扩展、无用户桌面干扰；Chrome 进程随 provider 卸载关闭；
- 页面内容仍按不可信处理；`chrome_evaluate` 的 `allowEvaluate` 硬确认照旧；
- 同一 owner 的 headless tabs 隔离；不同 DSH session 的 owner 互见不到；
- **空闲回收**：没有 tab 且 5 分钟无请求时自动关闭 headless Chrome（`DSH_HEADLESS_IDLE_MINUTES` 可调）；
- **并发限制**：最多 12 个 headless tabs（`DSH_HEADLESS_MAX_TABS` 可调），超出返回 `RESOURCE_LIMIT`；
- **CPU/内存基线**（本机 Chrome 155，headless 无 tab 空闲 60s 采样）：见下方 §4.1。

### 4.1 空闲与活跃基线（本机，Chrome 155）

headless 无 tab、无请求，60s `ps` 时间差：

| 指标 | 值 |
|---|---|
| CPU（全部 7 个 headless 进程合计） | **1.34%**（0.84s / 62.5s） |
| 内存 RSS | **672 MB** |
| 进程数 | 7 |

**活跃压测**（`node scripts/headless-bench.mjs --seconds 10`，每轮 snapshot + type + screenshot + scroll，10 个进程）：

| 指标 | 优化前（基线） | 优化后（本次） |
|---|---|---|
| 动作 | **181 轮/10s** | **233–241 轮/10s**（5 次复跑，中位 238，+31%） |
| CPU | **69.89%**（6.99s / 10s） | 63.6–71.4%（中位 69.6%）；**每动作 CPU 35.8ms → 27ms（约 -24%）** |
| 内存 RSS | **1113 MB** | 1049–1115 MB（中位 1108 MB，约持平） |

CPU 百分比总量看起来没降，是因为 10s 内完成的动作多了 ~31%：单动作成本下降体现在「每动作 CPU」和「每轮墙钟」上。

分项（优化后，单次调用墙钟均值，同一次压测采样）：

| 动作 | 耗时 |
|---|---|
| `tab.snapshot` | 0.62 ms |
| `tab.type` | 0.57 ms |
| `tab.screenshot` | 40.1 ms |
| `tab.scroll` | 0.64 ms |
| 每轮合计 | 41.9 ms |

结论：**screenshot 占每轮 ~96%**，是活跃期的绝对瓶颈；CDP 往返优化只能再拿几个百分点。剩余成本在 Chrome `Page.captureScreenshot` 的取帧 + PNG 编码本身（~40ms/次，与页面内容复杂度相关、与像素数弱相关——1440×813 与 720×450 实测几乎同价）。

本次优化（`src/headless.js`，其余行为不变）：

1. **PNG 默认走 Chrome 快编码** `optimizeForSpeed`：bench 页 screenshot 51.1 → 40.1ms/次（-21%），内容更复杂的页面收益更大（另测 ~48→38ms）。代价是 PNG 体积约 1.3–2×（仍无损、仍是 PNG，`chrome_screenshot` 语义不变）；需要旧行为可传 `optimizeForSpeed:false`。
2. **去掉每轮多余的 CDP 往返**：
   - `tab.snapshot` 不再先 `syncTabMeta`（snapshotPage 本身已返回 title/url，直接刷 tab 缓存）；
   - `tab.screenshot` 不再每次 evaluate `innerWidth/innerHeight`，按 tab 缓存，`tab.emulate` 时失效；
   - `tab.scroll` 把「滚动 + 读位置」合并为一次 evaluate；
   - `tab.click` 用页面返回值刷新 title/url，去掉点击后的一次 `Runtime.evaluate`。
3. 截图/PDF 输出目录只 `mkdir` 一次；文件名加序号避免同毫秒覆盖；bench 增加逐动作计时、相对基线 delta 与截图格式选项。

A/B（同一台机器，同样的 10s 场景；「普通 PNG」是通过 `--no-optimize` 复现旧编码路径）：

| 变体 | 动作 | 每轮墙钟 | screenshot |
|---|---|---|---|
| 旧代码（基线） | 181 | ~55.2 ms | — |
| 新代码 + 普通 PNG | 189 | 53.1 ms | 51.1 ms |
| **新代码 + 快 PNG（默认）** | **237** | **42.2 ms** | **40.4 ms** |
| 新代码 + JPEG q60 | 237 | 42.2 ms | 40.3 ms |

去掉 CDP 往返本身约 +4%（181→189）；其余 +27% 来自截图编码路径。JPEG q60 与快 PNG 速度基本一致，所以**工具默认仍返回 PNG**（与桌面扩展行为一致、无损），JPEG 只是 bench 的可选对照。

复跑：

```bash
cd /Users/taishuo/projects/dsh-chrome
node scripts/headless-bench.mjs --seconds 10                  # 默认：快 PNG
node scripts/headless-bench.mjs --seconds 10 --no-optimize    # 旧 PNG 编码路径
node scripts/headless-bench.mjs --seconds 10 --shot-format jpeg --shot-quality 60
node test/headless.mjs                                        # headless 回归
```

## 5. 下一步（H1）

1. `chrome_pick` 的 headless 语义（可返回 selector 流程）；
2. capture 引擎与扩展共享（两套行为一致性）；
3. 截图性能的剩余大头是 Chrome 取帧 + PNG 编码（~40ms/次）：可选方向是「同一帧内复用/限频」（需要页面变更信号才能保证不返回陈旧画面）、JPEG 快照（已测：与快 PNG 同速，故未改默认）、或把 `chrome_screenshot` 的 `clip`/`ref` 参数接到 headless（能直接缩小区块）。

## 6. 代码

| 文件 | 内容 |
|---|---|
| `src/headless.js` | headless Chromium 启动、CDP client、页面动作、`tab.*`/`browser.*` 请求实现 |
| `src/backend.js` | BackendRouter + AsyncLocalStorage + `wrapToolsForBackend`（给 39 个工具加 `backend` 参数） |
| `index.js` | 创建 HeadlessDriver/Router，包装工具，卸载时关闭 |
| `scripts/headless-bench.mjs` | 活跃 CPU/RSS 压测：逐动作计时 + 相对 §4.1 基线的 delta + 截图格式选项 |
| `test/backend-router.mjs` | 路由/参数剥离/默认桌面回归 |
| `test/headless.mjs` | 真 Chrome headless 端到端（goto/snapshot/type/click/screenshot/capture/screencast/emulate 等，含快 PNG 合法性、缓存视口、JPEG 可选路径断言） |
