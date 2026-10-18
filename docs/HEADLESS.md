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
- 无窗口、无扩展、无用户桌面干扰；启动时不建初始窗口（`--no-startup-window`，第一个 tab 才建，§4.1.10）；Chrome 进程随 provider 卸载关闭；
- 页面内容仍按不可信处理；`chrome_evaluate` 的 `allowEvaluate` 硬确认照旧；
- 同一 owner 的 headless tabs 隔离；不同 DSH session 的 owner 互见不到；
- **空闲回收**：没有 tab 且 5 分钟无请求时自动关闭 headless Chrome（`DSH_HEADLESS_IDLE_MINUTES` 可调）；
- **并发限制**：最多 12 个 headless tabs（`DSH_HEADLESS_MAX_TABS` 可调），超出返回 `RESOURCE_LIMIT`；
- **CPU/内存基线**（本机 Chrome 155，headless 无 tab 空闲 60s 采样）：见下方 §4.1。

### 4.1 空闲与活跃基线（本机，Chrome 155）

headless 无 tab、无请求，60s `ps` 时间差（**2026-10-18 起**，`--no-startup-window` 落地后，§4.1.10）：

| 指标 | 值 |
|---|---|
| CPU（全部 5 个 headless 进程合计） | **0.1–0.3%** |
| 内存 RSS（进程求和，共享页重复计） | **449 MB**（`footprint` 的 phys footprint 151 MB，更接近真实占用） |
| 进程数 | 5 |

改前同一状态（Chrome 自己开一个没人用的 `about:blank` 窗口）：7 进程、RSS 692–700 MB、footprint 298–307 MB、CPU 0.1%；历史基线记作 1.34% / 672 MB——那 1.34% 里含 Chrome 启动后 ~40s 的自身 CPU 尾巴（§4.1.10）。

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

### 4.1.1 2026-10-17 第二轮：截图帧流（Ralph 循环第 1 轮）

先量「40ms 到底花在哪」，否掉两个方向，第三个方向拿到收益。

**方向 A（否决）：截图参数 / 编码路径。** 同一页面、同一台机器，只改一处，20 次取中位：

| 变体 | 单次截图（中位） |
|---|---|
| 快 PNG（现状） | 44.5 ms |
| 普通 PNG | 48.9 ms |
| JPEG q60 | 41.6 ms |
| JPEG q30 | 35.3 ms（均值 40.4，噪声内） |
| `fromSurface:false` | 347 ms |
| `clip` 全视口 / 半视口 | 48.9 / 45.9 ms |
| `captureBeyondViewport:false` | 42.8 ms |

编码格式、压缩率、截取面积都只动几个百分点，`fromSurface:false` 反而慢 7 倍：40ms 主要不在 PNG 编码，而在「等一帧可截的合成帧」。

**方向 B（否决）：Chrome 启动参数。** 每个参数单独起一个探针 Chrome，60 次截图取中位 + 进程树 CPU：

| 参数 | 单次墙钟 | 每动作 CPU |
|---|---|---|
| 默认 | 42.9 ms | 26.3 ms |
| `--disable-frame-rate-limit` | **13.2 ms** | **56.5 ms** |
| `--disable-gpu-vsync` | 42.4 ms | 39.0 ms |
| `--disable-gpu` / `--disable-gpu-compositing` | 42.5–42.9 ms | 26–28 ms |
| `--enable-begin-frame-control`、`--run-all-compositor-stages-before-draw`、`--disable-threaded-animation`、`--disable-new-content-rendering-timeout`、`--disable-lcd-text`、`--disable-partial-raster` | 43–50 ms | 噪声内 |
| `--use-angle=metal` | 43 ms | 噪声内 |
| `--use-angle=swiftshader` | 66 ms | 更差 |

`--disable-frame-rate-limit` 用 2.1× 的每动作 CPU（空闲合成器常驻，探针里进程树合计一度 370–420%）换 3.2× 墙钟，对后台浏览器是净亏，未采纳。

**方向 C（采纳）：PNG `Page.startScreencast` 帧即截图。** 关键事实（探针实测）：同一内容下，screencast 的 PNG 帧与 `Page.captureScreenshot` 的输出**字节相同**（MD5 一致、1440×813），因为 Chrome 走同一个编码器；但帧由合成器按自己的节奏产出，不在请求-响应路径上。所以截图请求到达后只等「请求之后合成的那一帧」（帧 metadata 的 `timestamp` 是 Unix epoch 秒，可直接和 `Date.now()` 比较）：没变就复用上一帧（0–3ms），变了等下一帧（15–16ms），等不到时退回最近一帧（可见页面且这次动作没重绘）或 `Page.captureScreenshot`（首帧缺失、隐藏 tab、viewer 占用等）。

实现（`src/headless.js`）：

- `tab.screenshot` 的默认 PNG 走帧流；`clip`/`ref`/`frameRef`/`highlight`、`fullPage`、`optimizeForSpeed:false`、以及 live viewer 占用 screencast 时保持原截图路径（JPEG 在下一轮补成 JPEG 帧流，见 §4.1.2）。
- 每个可能改变渲染的请求（goto/click/type/scroll/evaluate/emulate/wait/…）返回后写 `tab.renderChangeAt`；只有 `frame.composedAt >= renderChangeAt` 的帧才可复用，保证不返回早于最后一次动作的画面。
- 首帧最多等 150ms；已有缓存时重绘窗口 40ms，超时且 `visibilityState === 'visible'` 说明这次动作没产生重绘（例如只读 evaluate），复用最近一帧；隐藏 tab 不合成，直接走 capture。
- 最后一次截图后 2s 关掉 screencast（`DSH_HEADLESS_SHOT_STREAM_IDLE_MS` 可调；重绘窗口 `DSH_HEADLESS_SHOT_STREAM_FRAME_TIMEOUT_MS`、首帧窗口 `DSH_HEADLESS_FIRST_FRAME_TIMEOUT_MS` 也可调）；这 2s 内页面**一帧都没产**的静态页会保留流与缓存帧（§4.1.3 的保活规则，`DSH_HEADLESS_SHOT_STREAM_KEEPALIVE=0` 可回退）；`tab.emulate` 按新视口重启流；`tab.debug_diag` 暴露 `screenshotStream {frames, restarts, served, fallbacks, repaintMisses}`。
- 回归：`test/headless.mjs` 增加「未变页面两次截图字节相同」「evaluate 改页面后截图必须变」「emulate 后 PNG 头是 800×600」「帧流确实被使用」四条断言。

**前后数字**（本机，同样命令 `node scripts/headless-bench.mjs --seconds 10`，每轮 snapshot + type + screenshot + scroll）：

| 指标 | 改前（本轮基线） | 改后（3 次复跑，中位） |
|---|---|---|
| 动作/10s | 229 | **585**（577–596） |
| 每轮墙钟 | 43.76 ms | **17.11 ms**（16.79–17.35） |
| `tab.screenshot` | 41.59 ms | **15.48 ms**（15.15–15.52） |
| 每动作 CPU | 26.7 ms | **17.45 ms**（16.91–17.57，**-35%**） |
| CPU 总量 | 61.05% | 98.7–104.6%（中位 100.6%） |
| 内存 RSS | 991 MB | 1038–1122 MB（中位 1105） |

吞吐 +155%、每轮墙钟 -61%、单次截图 -63%、每动作 CPU -35%。CPU 百分比总量反而上升，是因为 10s 内多做了 2.55 倍的截图：按 229 轮/10s 折算，帧流路径约用 40% CPU（0.4s/s），低于改前的 61%。**衡量交互延迟看每动作墙钟/CPU，不是 10s 总量。**

bench 小改动：原硬上限 `ACTIONS*20`（默认 400）会把这次 10s 跑截断在 6.7s，改为 `ACTIONS*50`（默认 1000），让 `--seconds 10` 真正跑满；输出新增 `cpuMsPerAction`。

**代价与边界**：

- 帧流活跃期截图更快，但 2s 没有截图就停流；静态页上流只产出一帧，两次空闲探针的差值（+9、+29 个百分点）与机器负载噪声同量级，未分离出稳定开销，停流后为 0。
- 后台 tab（`visibilityState=hidden`）不合成，仍走 capture（36–48ms），不会为了省时间返回陈旧帧。
- 只读 `tab.evaluate` 后没有重绘时，截图为等满 40ms 后复用缓存（与 capture 的 44ms 大致持平）；这是为了让「evaluate → screenshot」这种常见序列不被误判成陈旧。
- 剩余瓶颈：合成器帧间隔（~15–16ms）就是「页面变了」的截图下限；PNG 编码仍在合成器线程上。再往下需要：从帧里裁 `clip`/`ref`（要解码图像）、让 viewer 的 screencast 与截图缓存共用、或对 JPEG 请求单开 JPEG 帧流（后者已在 §4.1.2 完成）。

复跑（本轮验收）：

```bash
cd /Users/taishuo/projects/dsh-chrome
node test/headless.mjs
node scripts/headless-bench.mjs --seconds 10
```

### 4.1.2 2026-10-17 第三轮：JPEG 帧流（Ralph 循环第 2 轮）

第 1 轮只把默认 PNG 接到帧流，JPEG 仍走 `Page.captureScreenshot`（~42ms）。本轮先用探针把「一帧的 CPU 到底花在哪个进程」钉死，再补上 JPEG 帧流；同时否掉「每张截图现开现关帧流」的方向。

**先量清楚：一帧的 Chrome CPU 花在哪。**

- 按进程拆 10s 压测（`ps` 时间差，仅统计该 profile 的 Chrome 进程树）：总 **14.1ms/动作**，其中 **browser 进程 11.3ms、GPU 1.4ms、renderer 1.2ms、utility 0.05ms**。截图帧的取帧+编码在 browser 进程，不在渲染器；优化渲染侧没有意义。
- 同一台机器、同一个已热身 Chrome（同一进程内连续 8s 循环，避免冷启动噪声）：PNG 帧流 **11.2–11.9ms/动作**、JPEG 帧流 **9.5–9.6ms/动作**、JPEG capture **12–23ms/动作（46ms 墙钟）**。**帧流省的是墙钟，不是把编码变便宜**；JPEG 只比 PNG 少 ~15% CPU。
- 冷启动/热身差：bench 每次起全新 profile，前 10s 的 `cpuMsPerAction`（~16.5–17.5ms）比同一 Chrome 热身后的稳定值（~11ms）高约 5–6ms/动作，是一次性启动成本平摊，不是截图路径变慢；跨版本比较要用同一命令、多次复跑取中位，别拿热身探针数字和 bench 数字直接比。
- 静态页 + 活跃帧流：4s 内只产 8 帧，browser CPU 在连续三个 2s 窗为 41% / 27% / 0.4%——帧流开启初期有一次性合成/编码，随后归零；现有「最后一张截图 2s 后停流」正好把这段尾巴截掉。

**方向 D（采纳）：JPEG 请求也走 JPEG 帧流。** `Page.startScreencast` 的 `format` 与 `quality` 跟请求走；同一 tab 的帧流缓存带 `format`/`quality`，PNG↔JPEG 或 quality 变化时停流重启（不能拿 PNG 帧冒充 JPEG）。新鲜度规则与 PNG 完全相同（`renderChangeAt` + 帧 `metadata.timestamp`、40ms 重绘窗、首帧 150ms、隐藏 tab 回退 capture）；`clip`/`ref`/`frameRef`/`highlight`/`fullPage` 仍走 capture。新增 `DSH_HEADLESS_SHOT_STREAM=0` 总开关（排查用，默认开）。

**方向 E（否决）：每张截图现开现关帧流。** 动机是省掉两次截图之间的帧流开销。同一循环交替跑 3 组（type+screenshot，含写文件）：

| 模式 | 动作/秒 | 每动作 CPU | 截图墙钟中位 |
|---|---|---|---|
| 持续帧流 | 57.9–58.0 | 10.6–10.8ms | 16.1ms |
| 每张现开现关 | 56.6–57.0 | 11.7–11.9ms | 16.2–16.4ms |

现开现关多 ~10% CPU、墙钟不降（`--disable-frame-rate-limit` 一类的方向也早已否决）。另外帧流空闲尾部的 CPU 会自己衰减到 0（见上），停流策略只需保住 2s 即可，不必每张重启。

**前后数字**（同一台机器、同一命令多次复跑取中位；PNG 改前 3 次、改后 5 次，JPEG 改前 2 次、改后 3 次；JPEG 用 `--shot-format jpeg --shot-quality 70`）：

| 指标 | PNG 默认：改前 | PNG 默认：改后 | JPEG：改前 | JPEG：改后 |
|---|---|---|---|---|
| 动作/10s | 579 | 588（580–593） | 229（226–232） | **575**（567–593，+151%） |
| 每轮墙钟 | 17.32 ms | 17.01 ms（噪声内） | 43.80 ms | **17.38 ms（-60%）** |
| `tab.screenshot` | 15.39 ms | 15.21 ms（噪声内） | 41.84 ms | **15.17 ms（-64%）** |
| 每动作 CPU | 16.60 ms | 17.18 ms（16.8–18.7；与第 1 轮最终 16.7–17.5 同一分布） | 25.00 ms | **15.56 ms（-38%）** |
| CPU 总量 | 95.8% | 101.8%（多做了 2.5× 截图） | 57.1% | 90.9% |
| 内存 RSS | 1041 MB | 1055 MB | 1020 MB | 1074 MB |

**默认 PNG 没有变快，是实情也是预期**：15–16ms 就是合成器帧间隔，帧流已在第 1 轮拿到；本轮 JPEG 沿同一条路把 41.8ms 的 capture 降到 15.2ms。按 10s 总量看 PNG 的 CPU 更高，只是因为 10s 内完成了更多动作；看交互延迟用每轮墙钟/每动作 CPU。关掉帧流的同期对照（`DSH_HEADLESS_SHOT_STREAM=0 node scripts/headless-bench.mjs --seconds 10`）：211 轮、截图 45.2ms、每轮 47.5ms、每动作 CPU 28.6ms——帧流本身贡献了墙钟 -64%、每动作 CPU -40%。

**回归**：`test/headless.mjs` 增加 JPEG 帧流断言（SOI/EOI 头尾、`debug_diag.screenshotStream.format/quality`、`served` 增长、未变页面复用同一 JPEG 字节、改页面后 JPEG 必须变、切回 PNG 后帧流 format 恢复 png）；连续 3 次 PASS，完整 `npm test` 全绿。

复跑：

```bash
cd /Users/taishuo/projects/dsh-chrome
node test/headless.mjs
node scripts/headless-bench.mjs --seconds 10
node scripts/headless-bench.mjs --seconds 10 --shot-format jpeg --shot-quality 70
DSH_HEADLESS_SHOT_STREAM=0 node scripts/headless-bench.mjs --seconds 10   # 关帧流对照
```

### 4.1.3 2026-10-17 第四轮：启动参数端到端扫描 + 静态页帧流保活（Ralph 循环第 3 轮）

第 1 轮只在 `Page.captureScreenshot` 路径上扫过启动参数；本轮在**帧流路径**上重做端到端扫描（每个组合跑完整 10s bench，不靠单独探针），再给「截图后 2s 停流」加一条保活规则。结论：启动参数没有净收益；保活规则拿到静态页重复截图的 10× 墙钟下降，标准场景不变。

**先把上限钉死：默认 PNG 已在 60Hz 合成帧下限。** 同一命令 5 次复跑 560–595 动作/10s，中位 581；每轮 16.79–17.85ms。60Hz 的合成帧间隔是 16.67ms，即 10s 最多约 600 轮；标准场景每轮都改页面、截图必须等下一帧，所以已经在 93–99% 的上限上。`HeadlessExperimental.beginFrame`（老 headless 的「按需强制一帧」）在 Chrome 155 的 `--headless=new` 里不存在：在正确的 tab session 上直接返回 `'HeadlessExperimental.beginFrame' wasn't found`（同一次调用里 `Page.startScreencast` 正常），所以不能靠它绕开 vsync。

**方向 F（否决）：帧流路径上的启动参数扫描。** 用新增的 `DSH_HEADLESS_CHROME_ARGS`（空格分隔，追加在默认参数之后；默认不设，见下方说明）注入，每个组合跑一次完整 bench；括号内是复跑次数，未标注的为单次：

| 参数 | 动作/10s | 每轮墙钟 | screenshot | 每动作 CPU | 总 CPU |
|---|---|---|---|---|---|
| 默认（3 次中位） | **590** | **16.96 ms** | **15.26 ms** | **17.02 ms** | 99.9% |
| `--disable-gpu-vsync`（3 次） | 594 | 16.83 ms | 14.78 ms | 17.71 ms | 105.1% |
| `--disable-frame-rate-limit` | 797 | 12.55 ms | 10.33 ms | 24.03 ms | 191.2% |
| `--disable-gpu` | 594 | 16.84 ms | 15.25 ms | 20.35 ms | 120.8% |
| `--use-angle=metal` | 582 | 17.19 ms | 15.38 ms | 18.02 ms | 104.8% |
| 后台节流三开关（2 次） | 596–597 | 16.77–16.78 ms | 14.98–15.21 ms | 17.34–17.57 ms | 103–105% |
| `--disable-gpu-vsync` + 后台节流 | 597 | 16.75 ms | 14.94 ms | 17.24 ms | 102.8% |
| `--disable-gpu-compositing` | 592 | 16.88 ms | 15.02 ms | 20.14 ms | 119.2% |
| Puppeteer 式后台工作包（2 次） | 588–592 | 16.90–17.01 ms | 15.22–15.41 ms | 16.56–17.06 ms | 97–101% |

- 只有 `--disable-frame-rate-limit` 明显改变墙钟（797 轮、10.33ms 截图），但每动作 CPU 24.03ms（+41%）、总 CPU 191%：取消 vsync 让合成器空转/多产帧，和第 1 轮 capture 路径的结论一致，后台浏览器不接受。
- `--disable-gpu-vsync`（以及再加后台节流）墙钟低 0.5–1.2%，但每动作 CPU 高 1–4%，且都在复跑分布（560–595 动作、16.79–17.85ms）内，不当作收益。
- Puppeteer 式后台工作包（`--disable-breakpad`、`--disable-component-extensions-with-background-pages`、`--disable-default-apps`、`--disable-domain-reliability`、`--disable-client-side-phishing-detection`、`--no-pings`、`--disable-hang-monitor`、`--metrics-recording-only`、`--disable-features=Translate,MediaRouter,OptimizationHints,AcceptCHFrame,BackForwardCache`）把 RSS 从 1026–1128MB 降到 910–933MB，但墙钟/每动作 CPU 都在噪声内；不是本轮验收指标，也没有改默认（其中几条会关站点功能）。
- 结论：**不采纳任何启动参数**，默认启动参数保持原样。`DSH_HEADLESS_CHROME_ARGS` 只作为后续实验钩子保留（默认空，不影响行为；同名开关按 Chrome 的解析规则处理，仅用于本机实验）。

**方向 G（采纳）：静态页的帧流保活。** 原来最后一张截图 2s 后无条件 `Page.stopScreencast` 并丢掉缓存帧，下次截图要重新起流、等首帧（实测 10–23ms）。但静态页开着流其实不花 CPU：没有帧可编码（§4.1.2 静态页 4s 只产 8 帧、随后归零；本轮探针里静态页 18s 只产 1 帧）。规则改为：

- 2s 空闲计时到点时，如果这 2s 内页面**一帧都没产**且 tab 可见，就**不停流、保留缓存帧**，并继续按 2s 检查（每次检查一次 `visibilityState` evaluate，~0.5ms/2s）；
- 这 2s 内有帧（光标闪烁约 2 帧/s、动画、视频）就照旧停流，避免后台按 60fps 编码；
- 隐藏 tab 也停流：隐藏期间不合成，缓存帧可能早于隐藏期间发生的变化；
- `DSH_HEADLESS_SHOT_STREAM_KEEPALIVE=0` 可完全回退旧行为；`tab.debug_diag.screenshotStream.restarts` 暴露起流次数（测试用它证明没重启）；`tab.tabs {op:"close"}` 现在也会清掉该 tab 的帧流计时器。

**前后数字**（同机；`node scripts/headless-bench.mjs --seconds 20 --gap-ms 3000 --static`：每轮只 snapshot + screenshot、页面不变，所以直接反映缓存命中与重启；各 2 次）：

| 指标 | 旧行为（2 次） | 保活（2 次） |
|---|---|---|
| screenshot | 19.07 / 23.34 ms | **1.36 / 1.56 ms** |
| 每轮墙钟 | 21.62 / 25.60 ms | **3.62 / 4.09 ms** |
| 起流次数（同逻辑探针，5 张） | 6 | **1** |
| 总 CPU（场景大半在空闲，仅看是否变差） | 34.0 / 30.1% | 32.6 / 24.6% |

逐张截图的分布（3s 间隔、静态页、5 张）：旧行为 9.8 / 12.7 / 13.4 / 20.3 / 14.2 ms（中位 13.4），保活 1.2 / 4.7 / 1.4 / 1.7 / 1.4 ms（中位 1.4）。另测「每隔 3s 点一下按钮改变页面」（会重绘）：旧行为 18.3 / 19.5 / 27.7 / 27 / 29.3 ms（中位 27），保活 11.1 / 12.7 / 27 / 26.6 / 12.1 ms（中位 12.7）——保活不牺牲改页面后的截图（少了起流那一段）。

**标准场景不受影响**（每轮都改页面，2s 空闲计时根本走不到）：改前 3 次中位 590 轮、16.96ms/轮、15.26ms/截图、17.02ms/动作；改后 5 次 560–595（中位 581）、16.79–17.85（中位 17.21）、15.35ms/截图、16.69ms/动作——均在既有复跑分布内。JPEG 改后 2 次：575 / 593 轮、17.13ms/轮、15.33ms/截图、15.10ms/动作。

**回归**：`node test/headless.mjs` 增加保活断言（blur 掉光标后静置 2.6s，第二次截图必须 `restarts` 不变、`served` 增加、流仍 active）；连续 2 次 PASS，完整 `npm test` exit 0（CAPTURE PARITY: 77 checks, 0 failure(s), 17 documented divergence(s)）。

**剩余瓶颈（本轮结论）**：

1. 改页面后的截图 = 等下一合成帧，15–16ms 是 60Hz 硬下限；10s 标准场景上限约 600 轮，当前 581 中位（93–99%）。能超过它的只有取消帧率限制，但每动作 CPU +41%、总 CPU 191%，否掉。
2. 每动作 Chrome CPU ~17ms 里 browser 进程 PNG 编码 ~11.3ms（§4.1.2）；启动参数、GPU/ANGLE、后台节流都动不了它；JPEG 省 ~15%，但工具默认必须是无损 PNG。
3. 冷启动一次性成本 ~5–6ms/动作（热身后 ~11ms/动作），是 10s bench 的固有偏差；跨版本比较必须同命令多次复跑取中位。
4. 保活只对「不产帧的静态页」生效；有光标闪烁/动画的页面维持 2s 停流（后台 CPU 优先）。要再激进只能找可靠的「页面自上次截图后没变」信号，`Page` 没有 damage/sequence API，`HeadlessExperimental` 不可用；当前没有不返回陈旧帧的做法。

复跑（本轮验收）：

```bash
cd /Users/taishuo/projects/dsh-chrome
node test/headless.mjs
node scripts/headless-bench.mjs --seconds 10
node scripts/headless-bench.mjs --seconds 10 --shot-format jpeg --shot-quality 70
node scripts/headless-bench.mjs --seconds 20 --gap-ms 3000 --static   # 静态页缓存/保活
DSH_HEADLESS_SHOT_STREAM_KEEPALIVE=0 node scripts/headless-bench.mjs --seconds 20 --gap-ms 3000 --static   # 旧行为对照
```

### 4.1.4 2026-10-17 第五轮：clip/ref 区域截图从帧缓存裁剪 + bench 场景拆分

§4.1.3 留下的两个方向，本轮一个落地、一个否掉（方向 I）。落地的是「`clip`/`ref` 从帧里裁剪」，而且先钉出一个**语义缺口**：改前 `tab.screenshot` 收到 `clip`/`ref`/`frameRef`/`highlight` 就直接走 `Page.captureScreenshot`，但 capture 参数里根本没有 `clip`——也就是说 headless 后端的 `chrome_screenshot {ref}` 一直静默返回整视口。本轮在 driver 层把 `clip`/`ref` 真正实现出来，并且不再走 capture：从帧流的最后一张合成帧里解码、裁剪、重编码。

**为什么 driver 里裁剪可行。** Chrome 的 screencast PNG 是 8-bit、非隔行、RGB（colorType 2；1440×813 一帧约 39KB）。Node 侧 `zlib.inflateSync` + 逐行反滤波就拿到像素；PNG 的 5 种行滤波只引用「左边/上边」的像素，所以只解码裁剪区**左上方的前缀**（行 0..y+h、列 0..x+w）就够了——顶部/左上元素常常只解 10–20% 的帧。裁剪后按 filter 0 + deflate 6 重编码，写文件返回。

**实现（`src/headless.js`）**：

- `resolveScreenshotClip`：`clip` 按桌面后端语义是 CSS px，非法值抛 `INVALID_ARGUMENT`；`ref` 用页面 evaluate 取 `getBoundingClientRect()`（与扩展 `elementBox` 同口径），取不到/不可见抛 `REF_STALE`；`fullPage` 覆盖两者（仍走 `captureBeyondViewport`）。
- `cropScreenshotFrame`：先只解析 IHDR 拿帧像素尺寸，按 `frameWidth / innerWidth` 折算 dpr，把 CSS px 的裁剪框换算成设备像素，算出需要的前缀再解码/裁剪/编码。解码结果缓存在帧对象上：页面没变时重复截图跳过解码与帧等待，只花 encode（<1ms）。
- 回退规则不变、但这次区域是对的：JPEG+clip、`fullPage`、`frameRef`、`highlight`、`optimizeForSpeed:false`、帧流不可用/隐藏 tab/PNG 形态不支持（16-bit/调色板/隔行/JPEG 帧）→ `Page.captureScreenshot`，并把解析出的 `clip` 传给它；`ref` 元素完全在视口外（`getBoundingClientRect` 与视口无交集）同样回退 capture。
- 帧流新鲜度规则完全复用 §4.1.1/§4.1.2：`renderChangeAt` + 帧 `metadata.timestamp` + 40ms 重绘窗；`tab.debug_diag.screenshotStream` 新增 `cropped` 计数。

**bench 场景拆分（`scripts/headless-bench.mjs`）**：新增 `--shot-clip WxH`（固定视口区域，CSS px）与 `--shot-ref`（每轮用 snapshot 里的 input ref）。标准场景已被 60Hz 合成帧钉死（§4.1.3），这两条才是还有优化空间的路径。ref 模式的滚动量改为 60px，避免元素滚出视口后走回退分支（元素在视口外是另一个正确但更慢的分支，单独在边界里说明）。

**前后数字**（同机、同命令；改前用 HEAD 74ddee5 跑同一份 bench，clip/ref 各 2 次；改后 clip 2 次、ref 2 次）：

| 场景 | 指标 | 改前（74ddee5：capture，且忽略 clip/ref） | 改后 |
|---|---|---|---|
| `--shot-clip 600x300` | 动作/10s | 223 / 231 | **465 / 438** |
| | `tab.screenshot` | 42.48 / 40.76 ms | **18.86 / 19.88 ms** |
| | 每轮墙钟 | 45.01 / 43.46 ms | **21.50 / 22.86 ms** |
| | 每动作 CPU | 27.35 / 28.27 ms | **19.48 / 20.37 ms** |
| `--shot-ref`（input，153×21） | 动作/10s | 206 / 212 | **591 / 573** |
| | `tab.screenshot` | 45.17 / 44.69 ms | **14.78 / 15.04 ms** |
| | 每轮墙钟 | 48.62 / 47.16 ms | **16.92 / 17.45 ms** |
| | 每动作 CPU | 28.69 / 29.76 ms | **16.67 / 16.49 ms** |

区域截图吞吐约 ×2、元素截图吞吐约 ×2.8；元素截图已经和整视口截图同速（14.8 vs 15.3ms），因为 153×21 的裁剪/编码开销在噪声内。**标准视口场景不受影响**：改后 3 次 539 / 558 / 577 动作，`screenshot` 15.28–15.63ms，每轮 17.35–18.57ms（改前 2 次 550 / 586、14.82–16.02ms——同一条复跑分布内，仍贴着 60Hz 上限）。

**中间迭代（也是数字）**：第一版是整帧解码（3.5MB RGB 前缀全解：inflate 2–3ms + 反滤波 7–10ms），clip 到 344 / 345 动作、`screenshot` 25.1 / 25.3ms；改成「只解裁剪区左上方前缀」后才到上表。

**代价与边界**：

- 解码量随裁剪区左上方覆盖的行/列数增长：左上/顶部元素几乎免费（ref 场景已与整视口同速），视口右下角的大区域接近整帧解码（~13ms），但仍远低于 capture ~45ms。
- 元素在视口外、隐藏 tab、首帧未就绪、JPEG+clip → 回退 capture（~45–50ms），区域仍正确。
- 输出是 filter 0 的 PNG，600×300 内容约 5–10KB（比 Chrome 自己的编码器大 1.3–2×；无损，语义不变）。
- 每个 tab 至多缓存一份解码前缀（≤ 整帧 3.5MB），随下一帧替换/GC。

**方向 I（否决）：viewer screencast 与截图缓存共用。** 子代理静态分析结论：viewer 默认 `jpeg/q60/1280×800/EveryNthFrame=2`，截图要 `png`、`maxWidth=viewport×dpr=1440×813`、`everyNthFrame=1`——格式和尺寸两个轴都不匹配；唯一兼容角落是「png viewer + emulate 到 ≤1280×800」，很罕见，却要 viewer 付出 1.27–2.5× 的帧编码/带宽成本，并处理 `latest.jpg` 陈旧、10min 帧流计时器与 5min viewer 空闲的冲突。不做，保留 capture 回退。顺带记一个可以单独做的小项：viewer 分支**每帧**都 base64 解码 + `mkdirSync` + 原子写 + 重写 `meta.json`（≤30 次/s），而消费端 300ms 才轮询一次——可节流到 ≥100ms 一次或只留内存最新帧（本轮未做，留给后续）。

**回归**：`node test/headless.mjs` PASS（连跑 2 次），新增断言：clip 的 PNG 尺寸 = CSS px × dpr、未变页面两次裁剪字节相同、改页面后裁剪必须变、ref 尺寸 = 元素框、ref PNG 小于 600×300 clip、未知 ref → `REF_STALE`、空 clip → `INVALID_ARGUMENT`。

### 4.1.5 2026-10-17 第六轮：冷启动路径（子代理并行调研）

背景：§4.1.3 看到 bench 的每动作 CPU（~17ms）比同一 Chrome 热身后（~11ms）高 5–6ms，是一次性启动成本被 10s 窗口摊薄。先把冷启动拆开量（子代理独立探针：3 个全新 profile 循环、Chrome 155；绝对值受当时机器负载影响，按相对值看）：

| 阶段 | 中位 [范围] ms |
|---|---|
| `spawn()` → `DevToolsActivePort` 写完（2 行） | 434.9 [284.1–446.2] |
| 端口文件 → WebSocket open | 316.2 [294.8–329.6] |
| WS → `Browser.getVersion` 返回 | 50.9 [30.8–89.5] |
| `getVersion` → `ensureStarted()` 返回（mkdir + setDownloadBehavior） | 42.7 [31.3–60.0] |
| `ensureStarted()` → 第一个 tab attach 完成（createTarget+attach+Page/Runtime.enable） | 157.3 [133.0–162.0] |
| 第一个真实 `tab.goto` → load complete | 69.9 [53.9–73.1]（页面真实 load 22.0） |
| 第一次截图（冷合成器） | 77.6 [71.1–85.1]；第二次 0.7 |
| **spawn → 第一次截图完成** | **1125.9 [1037.7–1229.4]** |

**采纳（`src/headless.js`）**：

1. `Browser.getVersion` 与 `Browser.setDownloadBehavior` 互不依赖，改成 `Promise.all`：启动尾部 52.4ms → 1.9ms（省 ~45ms，负载下 34–67ms）。
2. 新 tab 的 `Page.enable` / `Runtime.enable` 也并行：冷 RTT 13.3 + 11.1ms 串行 → 取 max，省 ~11ms（负载下重叠可到 25–58ms）。
3. `waitReady` 的 `document.readyState` 轮询 100 → 25ms：测到真实 goto 在页面 load 完成后平均还要等 43ms 才返回；25ms 轮询把这段压到 ≤25ms（本地极快页面在第一次 evaluate 就 complete，碰不到这个等待）。

**否掉：`DevToolsActivePort` 轮询 150 → 20ms。** 轮询超时是真的（n=18，中位 30.6ms，范围 −0.6–136.5ms），但 Chrome 写完端口文件后还要 300–570ms 才接受 WebSocket：探针在端口文件一出现就连接，WS open 相对 driver 只差 −2.5/−0.4/−0.3ms；配对 A/B 里 `port → ws open` 不变（+2.8ms 中位差）。轮询等待完全被 launch 覆盖，保持 150ms（注释里记了这个结论，防止后来者再「优化」它）。

**边界**：剩下 ~750ms 是 Chrome 进程启动（435ms）+ Chrome 在端口写完到能服务 CDP 之间（316ms），Node 侧动不了。不建议为了第一条工具调用预热 Chrome 进程：空闲 headless 进程树 RSS 就有 449MB（§4.1，`--no-startup-window` 之前是 672–700MB），不用 headless 后端的桌面用户不该付这份常驻内存。标准 bench 不受影响（启动发生在计时窗口外，bench 先 warm-up 再计时）：改后复跑 539 / 558 / 577 动作/10s。

**回归**：`node test/headless.mjs` PASS。

### 4.1.6 2026-10-17 第七轮：viewer screencast 帧写盘节流（Ralph 循环第 1 轮）

背景：§4.1.4 方向 I 的附带发现——viewer 分支**每帧**都 base64 解码 + `mkdirSync` + 原子写 `latest.<ext>` + 重写 `meta.json`（≤30 次/s），而消费端（liveview 页面）300ms 才轮询一次。桌面路径（`host/host.mjs`，扩展 → native 消息 → 落盘）和 headless 路径（`src/headless.js`）各有一份同样的代码。

**改动**（两处同构）：

1. 帧到达时只记 `state.pending = params` 并计数/更新 `lastAt`（ack 仍立即发，否则帧流会停）；**解码与写盘移到 flush**。
2. flush 节流到 `SCREENCAST_WRITE_INTERVAL_MS = 100`：距上次写 ≥100ms 立即 flush；否则挂一个 trailing timer（`.unref()`），保证一串变化的**最后一帧**仍会落盘（否则静止页面会永久停在旧帧上）。
3. `mkdirSync` 从每帧一次改为每次 screencast 会话一次（`dirReady` 标记）。
4. `tab.screencast_stop` 与 10 分钟自动停止：先清 trailing timer 并**同步 flush** 最新帧，再停 `Page.stopScreencast`——停流不会丢掉最后一帧。

**测量方法**：`/tmp` 探针（`--import` 一个只读 fs 钩子，统计 `/screencast` 目录下的 `writeFileSync`/`mkdirSync`/`renameSync` 次数、字节数与同步耗时；headless 探针跑一个「视口内每 33ms 变色」的页面并取 5s 稳定窗口，host 探针用 native 消息管道按 30 帧/s 灌 60 帧）。对照组用 `git archive HEAD` 导出的同一个 `d5b06c4` 树，A/B 各 3 次。

| 路径 | 指标（5s / 60 帧窗口） | 改前（d5b06c4） | 改后 |
|---|---|---|---|
| headless | 帧/5s（everyNthFrame=2） | 75 / 76 / 76 | 75 / 75 / 76 |
| | 落盘帧/s | 15.0 / 15.2 / 15.2 | **10.0 / 10.0 / 10.0** |
| | `writeFileSync`/5s（帧 + meta） | 150 / 152 / 152 | **100 / 100 / 100** |
| | 磁盘字节/5s | 549.6 / 556.9 / 858.0 KB | **366.4 / 366.4 / 366.4 KB** |
| | fs 同步耗时/5s | 64.2 / 52.1 / 58.0 ms | **42.3 / 35.6 / 40.2 ms** |
| | node CPU/5s | 124.1 / 119.1 / 116.7 ms | **103.4 / 99.3 / 108.3 ms**（中位 −13.2%） |
| | CPU/帧 | 1.65 / 1.57 / 1.54 ms | **1.38 / 1.32 / 1.42 ms** |
| host（桌面） | 落盘帧/s | 29.7 / 29.7 / 29.8（3 次） | **10.4 / 10.4 / 10.4** |
| | `writeFileSync`/60 帧 | 120 / 120 | **42 / 42 / 42** |
| | fs 同步耗时 | 47.4 / 52.2 ms | **25.9 / 19.1 / 22.0 ms**（中位 −55%） |
| | 最后一帧落盘 | 是 | **是**（3/3） |

`mkdirSync`：改前每帧一次（headless 75 次/5s、host 60 次/窗口），改后每次会话一次（0 次在后 5s 统计窗口内，会话开始时创建）。headless 探针 6 次（A/B 各 3 次）`ok` 全为真：viewer 路由返回 200 + `image/jpeg` + 字节数与 `latest.jpg` 一致，`meta.json` 的 `bytes` 与文件一致、`frames` 为最新计数、`updatedAt` 落后 ≤8ms。

**为什么 CPU 只降 ~13%**：per-frame 成本的大头是 WS/native 消息的 JSON 解析与 ack（每帧都必须做），解码 + 2 次写 + rename 只是其中一部分；节流去掉的是后一部分里被跳过的那 1/3 帧。写盘次数/字节/同步耗时都降了 1/3（headless）到 65%（桌面），这才是本轮的确定收益。

**边界与取舍**：

- `latest.<ext>` 最多落后 100ms（消费端 300ms 轮询，肉眼不可见）；`meta.json.updatedAt` 同理，`chrome_screencast {op:"status"}` 读到的帧年龄 ≤100ms。
- 静止页面：帧本来就不再来，节流不会让画面更旧；一串变化结束时 trailing timer 会把最后一帧写下去（探针在 stop 后测到 `metaAge` 2–8ms）。
- 帧流本身的 10 分钟自动停止、5 分钟 viewer 空闲自停（`src/screencast-guard.js`）行为不变：`tab.screencast` 计数（`frames`）仍是**每帧**累加，只有落盘被节流。
- 未改协议/参数：`everyNthFrame` 默认仍为 2；提高它（例如 4）可以再降编码/传输成本，但那是画质/流畅度取舍，留给调用方。

**回归**：`node test/headless.mjs` PASS（新增断言：stop 后 `latest.jpg` 是合法 JPEG、`meta.json.bytes` 与文件大小一致、`frames` 不超过流计数、`updatedAt` 新鲜）；`node test/host-reconnect.mjs` PASS（新增断言：连发两帧后磁盘上是**第二帧**——trailing flush 生效——且 meta 的 `frames`/`bytes` 与文件一致）；`node test/liveview.mjs`、`node test/extension-logic.mjs`、`npm test` PASS。标准截图 bench（`node scripts/headless-bench.mjs --seconds 10`）不受影响：591 动作/10s、`screenshot` 14.93ms、每轮 16.91ms、每动作 CPU 16.35ms（改前同命令 575 动作、14.84ms、17.39ms、19.30ms——同分布/负载波动内）。

### 4.1.7 2026-10-17 第八轮：只读 evaluate / 空滚动的重绘窗（Ralph 循环第 3 轮）

背景：截图帧流的新鲜度规则是 `renderChangeAt` + 帧 `metadata.timestamp` + 40ms 重绘窗（§4.1.1）。页面**没重绘**时（只读 evaluate、已经在边界上的 scroll），这一窗必然走满：实测截图 42.0–43.2ms，而静态页缓存命中只要 0.14–0.18ms。§5 当时留的待办正是「需要可靠的『没有重绘』信号」。

**先给结论**：`Page` 没有 damage/sequence 信号，本轮探针也确认 `document.timeline.currentTime` 在静态页上照样每 ~33–50ms 前进（合成器一直有 BeginFrame，只有 screencast 的**发帧**按 damage 触发），所以「没重绘」只能从**页面侧**证明：driver 在每个文档里装一个视觉变更追踪器，在动作前后各取一次快照，两次快照完全一致时才跳过重绘窗。

**实现**（`src/headless.js`）：

1. `attachTab` 时 `Page.addScriptToEvaluateOnNewDocument`（覆盖后续文档，含子 frame）+ 直接 `Runtime.evaluate` 一次（覆盖当前文档），装 `window.__dshVisual`；装失败就整条短路回退。
2. 追踪器累计 `MutationObserver`（subtree/childList/attributes/characterData）条数、`scroll`、`focusin/focusout` 事件数；快照再带 `document.getAnimations().length`、`scrollX/Y`、文档 token、URL、readyState，以及两个「追踪器看不见的面」：页面里有没有 `<canvas>`（画布像素不产生 DOM 变更）、有没有**同源** subframe 文档（它的 DOM 不在主文档 observer 里）。
3. `tab.evaluate` 用 `visualProbeAction()` 包起来：动作前/后各一次快照，所有字段一致 → `tab.skipRenderChange = true`；`request()` 据此**不推进** `renderChangeAt`，下一张截图直接命中缓存帧。快照形状不对（页面自己占了 `window.__dshVisual`）、`getAnimations` 不可用、有 canvas/同源 subframe → 一律保守。
4. `tab.scroll` 把「是否真的移动」和「是否 `scroll-behavior: smooth`」放进同一次 evaluate 的返回值：没移动且不是平滑滚动 → 同样跳过；平滑滚动会在 evaluate 返回后继续动，保持保守。
5. `tab.debug_diag` 新增 `visualTracker`、`visualSkips`（被证明无重绘的动作数）。
6. `DSH_HEADLESS_VISUAL_PROBE=0` 一键回到旧行为。

**A/B（同机交替，`git archive 83435f6` 导出原树 vs 本轮；探针在 `/tmp`；每侧 3 次取中位）**：

| 截图前的动作 | 改前 | 改后 | 说明 |
|---|---|---|---|
| 只读 evaluate | **43.23 ms**（25/25 走满窗口，0 帧） | **0.26 ms**（25/25 命中缓存） | −99.4% |
| 已在边界的 scroll（到底再向下 / 已在顶端再 `top`） | 42.15 ms（11–12/20 走满） | **0.22 ms**（20/20 命中） | −99.5% |
| 改 DOM 的 evaluate | 16.14 ms | 15.38 ms | 不变 |
| type | 15.77 ms | 15.83 ms | 不变 |
| 合成 click（无视觉变化） | 43.09 ms | 43.17 ms | 未覆盖，仍走满 |
| press（Shift） | 43.10 ms | 42.82 ms | 未覆盖，仍走满 |
| 无动作（纯缓存） | 0.18 ms | 0.14 ms | 不变 |

`node scripts/headless-bench.mjs --seconds 10 --readonly-eval`（新场景：snapshot + 只读 evaluate + 截图，页面全程不重绘）：

| 指标 | 改前（83435f6） | 改后 |
|---|---|---|
| 动作/10s | 231 / 231 / 231 | 6756 / 7020 / 7576 |
| 轮/s | 23.00–23.08 | 675.5–757.6 |
| `screenshot` | 42.16 / 42.26 / 42.20 ms | 0.50 / 0.46 / 0.42 ms（中位 −98.9%） |
| 每轮合计 | 43.31–43.45 ms | 1.32–1.48 ms |
| 每动作 CPU | 13.20–14.55 ms | 1.15–1.24 ms |
| RSS | 1095–1119 MB | 1007–1026 MB |

标准场景（页面每轮都变）不回归：改前 587/592 动作、`screenshot` 15.26/14.96 ms、每轮 17.03/16.91 ms、每动作 CPU 17.34/16.55 ms；改后 583/601 动作、14.85/14.90 ms、17.14/16.65 ms、16.79/16.34 ms。

**代价**：`tab.evaluate` 多两次页面快照往返。300 次只读 evaluate 的中位：改前 0.262–0.293 ms → 改后 0.616–0.826 ms（+0.35–0.53 ms/次）；`DSH_HEADLESS_VISUAL_PROBE=0` 时 0.225–0.270 ms（追踪器本身在页面里没有可测开销）。一次「只读 evaluate → 截图」省 43 ms，所以只有「截图紧跟 evaluate」才需要它；若截图从不跟随 evaluate，这 0.4ms 是纯成本——相对一次工具调用的秒级节奏可忽略。

**正确性（不返回陈旧帧）**：9 项检查在改后 3/3 次探针里全为真，改前树对应的 3 项为假（它没有短路）：

- 只读 evaluate → 截图字节与上一帧相同、帧计数不变、没有走满窗口；
- 改 DOM / 页面内 `window.scrollTo` / `focus()` → 截图字节必须变化（分别由 mutation / scroll 事件 / focus 事件判定为 dirty）；
- 页里存在 `<canvas>` 时往画布上画 → 必须等新帧（画布像素对追踪器不可见，所以有 canvas 就整条回退保守路径）；移除 canvas 后只读 evaluate 又能命中缓存；
- 边界 scroll → 命中缓存。

`node test/headless.mjs` 新增上述断言（追踪器已装、只读 evaluate 与边界 scroll 的 `visualSkips`/帧计数/字节、DOM/页面内 scroll/focus/canvas 四类新鲜性、canvas 移除后恢复；参考帧前加 150ms settle，避免一次重绘落成两帧时竞态），连跑 8 次 PASS。

**边界与取舍（明确不覆盖的类）**：

- **异步/间接重绘**：evaluate 里 `setTimeout`/`fetch().then`/跨源 iframe `postMessage` 等，在快照之后才画。此时截图反映「动作完成那一刻」的页面，而不是再等 40ms 后的样子；旧实现也只是 best-effort（40ms 之后的重绘同样会漏）。这是与旧行为唯一的语义差别。
- 有 `<canvas>`、有同源 subframe 文档、`getAnimations` 不可用、快照形状不对 → 一律保守。
- 合成 click 与 `Input.*` 系动作（press / clickAt / hover / drag）仍走满窗口：它们可能改变焦点轮廓、`:active`、真实输入状态，本轮不覆盖（下一轮候选）。
- **为什么不用更省事的替代**（都量过，别再试）：`Page.captureScreenshot` 空闲表面 15.6 ms、有未提交重绘 45–47 ms、负载下 34.5 ms；`Page.stopScreencast`+`startScreencast` 取首帧在静态页 14.7–15.0 ms，但刚改过页面后 17.6–23 ms、连续重启时偶发 ~200 ms；`document.timeline.currentTime` 在静态页上也一直前进（见上）。所以「等一帧再 capture」「重启流取首帧」都不比 40ms 窗口稳，而且会把已改页面的截图拖慢到 30–65 ms。

### 4.1.8 2026-10-17 第九轮：合成 click / hover 的重绘窗（Ralph 循环第 4 轮）

背景：§4.1.7 的页面侧追踪器只包住了 `tab.evaluate` 与边界 scroll。合成 `tab.click`/`tab.hover` 仍盲等 40ms 重绘窗：点一个没有任何 handler 的普通元素（页面不可能重绘）也要 43.2ms，而静态页缓存命中只要 0.2–0.3ms。

**难点**：click 的目标元素自己可能触发 UA 默认动作，而且这些动作**不产生 DOM mutation**，§4.1.7 的计数器看不见：`<a href>`/`<area href>` 导航、`<button type=submit>` 表单提交（`button.form` 关联的也算）、`<label>` 转发激活、checkbox/radio/select/file/range 等控件的 UA 状态、`<video controls>` 播放、`popover`/`command` 顶层浮层。JS handler 里的 `checkbox.click()`、`showPopover()`、`location.assign`、`element.scrollTop = ...` 也是「无 mutation 的重绘」。

**实现**（`src/headless.js`）：

1. `clickPage` 在派发前算 `hazard`（`null` 才允许短路）：`a[href]`/`area[href]` → `navigation`；`label` → `label-activation`；`input/select/textarea`（含后代）→ `form-control`；`button` 且 `button.form`（或祖先 form）存在、类型不是 button/reset → `form-submit`；`video/audio` 后代 → `media-control`；`[popovertarget]`/`[commandfor]` → `ua-toggle`。
2. `tab.click`/`tab.hover` 走 `visualProbeAction(action, accept)`：`accept` 只在 `ok && hazard === null` 时允许取第二张快照；hazard 非空时只多付一次快照（~0.23ms）就保持保守窗口。
3. 追踪器新增 `change`（checkbox/radio/select/file 激活）与 `beforetoggle`/`toggle`（popover/details/command）计数器；快照新增 `changes`/`toggles`/`media`。任一计数器变化、页面里有 `video`/`audio`（媒体面像 canvas 一样无 mutation 重绘）→ `unknown`。
4. `DSH_HEADLESS_VISUAL_PROBE=0` 仍然一键回退（click/hover 一起回退）。

**A/B**（同机交替，`git archive 023bb89` 导出原树 vs 本轮；探针 `/tmp/perf-s4/probe.mjs`，每侧 3 次取中位；1-min load 5.7–5.9）：

| 动作 → 截图 | 改前 | 改后 | 说明 |
|---|---|---|---|
| 普通 click（无 handler 的 div） | **43.19 ms**（0/25 短路、25/25 走满窗口） | **0.23 ms**（25/25 短路、0 帧、像素不变） | −99.5% |
| hover 同一元素 | 43.39 ms | **0.21 ms** | −99.5% |
| click 改 DOM 的按钮（handler 写 textContent） | 15.00 ms | 14.22 ms | 不短路，帧数/结果不变 |
| click checkbox（UA 切换，无 mutation） | 14.60 ms | 13.18 ms | 不短路；像素变化 5/5 |
| click `<a download>` | 42.67 ms | 42.55 ms | 导航 hazard，保持保守 |
| press(Shift) | 43.94 ms | 42.98 ms | `Input.*` 未覆盖，仍走满 |
| 只读 evaluate / 边界 scroll（§4.1.7 回归） | 0.55 / 0.54 ms | 0.38 / 0.29 ms | 仍短路 |

`node scripts/headless-bench.mjs --seconds 10 --noop-click`（新场景：snapshot + 点普通 div + 截图，页面全程不重绘）：

| 指标 | 改前（023bb89） | 改后 |
|---|---|---|
| 动作/10s | 224 / 225 / 227 | 7570 / 7649 / 7584 |
| 轮/s | 22.36–22.61 | 727.9–764.8 |
| `click` | 0.46–0.54 ms | 0.59 ms |
| `screenshot` | 43.01–43.27 ms | 0.38–0.45 ms |
| 每轮合计 | 44.21–44.71 ms | 1.30–1.37 ms |
| 每动作 CPU | 14.44–16.08 ms | 1.18–1.22 ms |
| RSS | 1089–1175 MB | 1171–1382 MB（run 间波动，无系统性变化） |

标准场景（页面每轮都变）不回归：改前 583/600/600/601 动作、`screenshot` 14.52–15.36 ms、每轮 16.65–17.14 ms、每动作 CPU 16.67–17.48 ms；改后 583/599/600/600、14.57–15.28 ms、16.67–17.16 ms、17.02–17.58 ms。只读 evaluate 场景也不回归：7683 → 8210 动作、`screenshot` 0.41 → 0.39 ms、每动作 CPU 1.19 → 1.14 ms。

**代价**：每次 click 多两次快照；hazard 命中只多一次。200 次连点（无截图）中位：普通 click 0.27 → 0.68 ms（+0.41）、导航 hazard 0.25 → 0.48 ms（+0.23）、改 DOM 的 click 0.35 → 0.85 ms（+0.50）。一次「click → 截图」省 43 ms，所以只有「截图紧跟 click」才需要它；若 click 后不截图，这 0.2–0.5ms 是纯成本（相对一次工具调用的秒级节奏可忽略）。

**正确性（探针 3/3 次全真）**：

- 普通 click / hover → 短路（`visualSkips` 25/25）、帧计数不变、像素与上一帧逐字节相同；
- click 改 DOM → 不短路、帧数 +25、`out` 文本是 handler 写的值；
- click checkbox → 不短路、像素变化（勾选可见）；从 evaluate 里 `checkbox.click()` 同样不短路（change 计数器）；
- click `<a download>` / `<button type=submit>`（form onsubmit 取消提交）→ 不短路（导航 hazard）；
- click popover 触发器、evaluate 里 `showPopover()` → 不短路（hazard / toggle 计数器），浮层可见；DOM 里有未打开的 popover 不影响短路；
- 页面含 `<video>`/`<canvas>` 时 evaluate 与 click 都不短路（媒体面/canvas 像素不可见）；移除 canvas 后恢复（§4.1.7 用例保留）；
- press(Shift) 仍不短路（`Input.*` 未覆盖）。

`node test/headless.mjs` 新增断言：普通 click/hover 的 `visualSkips`/帧计数/像素、改 DOM 的 click 新鲜性、checkbox 点击与 JS 激活不短路、form submit 不短路、press 仍保守、下载链接点击不短路（导航 hazard）；连跑 5 次 PASS。`npm test` exit 0。

**边界与取舍**：

- **异步/间接重绘**：handler 里 `setTimeout`/`fetch().then`/`element.scrollTop = ...`（元素滚动事件下一帧才发）等，在两张快照之后才画。截图反映「动作完成那一刻」的页面；与 §4.1.7 的 evaluate 语义相同，旧 40ms 窗口对 >40ms 的效果同样会漏。
- **媒体面**：`video`/`audio` 现在让整个 tab 的 evaluate/click 都保守。这是顺带的正确性修复（播放中的媒体重绘没有 DOM mutation，旧实现会误判 clean），代价是含媒体元素的页面失去短路。
- 声明式导航由 hazard 挡住；JS handler 里的 `location.assign` 无法同步观测，属于上面「异步效果」一类。
- shadow DOM 里的 canvas、跨源 iframe 的绘制仍是既有边界（不可见）。
- `Input.*`（press / clickAt / drag）仍走满窗口：它们走 CDP Input，页面侧探针不覆盖，留给下一轮。

### 4.1.9 2026-10-17 第十轮：JPEG `clip`/`ref` 用页面编解码器裁剪（Ralph 循环第 5 轮）

背景：§4.1.4/§5 留的最后一个截图方向——`clip`/`ref` 的 **JPEG** 请求一直回退到 `Page.captureScreenshot`（本轮实测 45.9–47.9ms/次），而同一区域的 PNG 已经能从帧缓存裁剪（14.6–15.2ms）。缺的是「能裁 JPEG 的路径」：driver 里没有 JPEG 编解码器（不加依赖）。本轮不写编解码器，而是**把裁剪交给页面自己的 codec**：`createImageBitmap` 解码 + `canvas.toDataURL('image/jpeg', q)` 编码，都在一个**专用 isolated world** 里跑。

**实现**（`src/headless.js`）：

1. `jpegFrameSize()`：只走 SOF 头（几百字节）拿帧的像素尺寸，用来把 CSS px 的 `clip` 换算成帧像素；从不整帧解码（与 PNG 的 `pngFrameSize` 同一分工）。
2. 帧字节缓存在 isolated world 的 `window.__dshShotFrame`，token = `composedAt:字节数`：同一帧再裁不重传，只有新帧才付 base64 传输。裁剪请求仍走一次 `Runtime.evaluate`（`awaitPromise`），返回 base64 JPEG。
3. **isolated world**（`Page.createIsolatedWorld`，world `dsh-shot-crop`，每个文档一个，随导航失效后重建一次）：页面脚本碰不到它的 globals/DOM 原型，所以页面既不能把裁剪弄坏、也不能伪造自己截图的像素——测试里把主世界 `HTMLCanvasElement.prototype.toDataURL` 覆盖成常量，裁剪仍然返回正确的 600×300 图像。
4. **帧几何过滤**：Chrome 会吐出几何不对的帧——实测在请求 1440×813 的 stream 上收到过 600×300、1440×720、531×300 的帧（`metadata.deviceWidth/Height` 也跟着错）。这种帧按它换算会「内容对、分辨率错」，所以 `Page.screencastFrame` 里按**帧实际像素尺寸**（±2px 容差）过滤，不符的帧不当缓存帧、也算「没收到帧」，让 clip 路径立刻走 capture 而不是白等 40ms 重绘窗。`tab.debug_diag.screenshotStream` 新增 `jpegCropped`。
5. **clip capture 会污染 screencast（本轮的坑）**：在 stream 运行时做带 `clip` 的 `Page.captureScreenshot`，Chrome 之后会一直吐 **clip 尺寸**的 screencast 帧（600×300），后续裁剪全部失效（实测一次污染能让 10s 的 bench 一次裁剪都做不成）。而在 stream 启动**之前**做 clip capture 不会污染（对照探针 3/3）。因此：
   - 冷路径（tab 上没有活跃 stream）**先**做带 clip 的 capture（Chrome 只编码该区域，最便宜），**再**启动 stream 给后续截图预热；
   - stream 在跑但拿不到可用帧 → 做**全视口 capture + 同一个页面裁剪**（全视口 capture 顺带重画整个 surface，下一帧恢复可用），不再用带 clip 的 capture；
   - repaint-miss（40ms 内没有新帧）不拿旧帧去裁，直接走全视口 capture——宁可多花一次 capture，也不返回动作前的像素。
6. `DSH_HEADLESS_JPEG_CROP=0` 一键回退到 capture；单帧超过 2MB（4K 级全细节页）也回退 capture。

**前后数字**（同机交替 A/B：`git archive 8ef018b` 导出原树 vs 本轮；每侧每对交替跑；1-min load 3.7–7.6）：

`node scripts/headless-bench.mjs --seconds 10 --shot-clip 600x300 --shot-format jpeg --shot-quality 70`（页面每轮 type/scroll，截图紧跟其后）：

| 指标 | 改前（8ef018b） | 改后 |
|---|---|---|
| 动作/10s | 201 / 200 / 201 | **435 / 490 / 487** |
| 轮/s | 20.1–20.2 | 43.5–49.0 |
| `tab.screenshot` | 46.23 / 45.92 / 46.35 ms | **21.19 / 18.20 / 18.35 ms**（中位 −60%） |
| 每轮合计 | 49.80–50.12 ms | **20.41–23.01 ms** |
| 每动作 CPU | 25.37 / 25.80 / 25.75 ms | 23.63 / 25.14 / 23.90 ms |
| RSS | 1063–1120 MB | 1165–1190 MB |
| 流计数 | —（从不建 stream） | `cropped` 399/483/482、`fallbacks` 36/5/3（全是 repaint-miss） |

`--shot-ref --shot-format jpeg`（ref 解析 + 裁剪端到端）：改前 200/201 动作、`screenshot` 47.91/46.78 ms、每动作 CPU 26.95/25.12 ms → 改后 **388/584 动作、23.47/15.51 ms、24.36/20.80 ms**（`cropped` 347/580）。

**单张与间隔调用**（`/tmp` 探针，同一页面：静态页连拍 / 每次动作后隔 3s 再截图；单位 ms）：

| 场景 | 改前 | 改后 |
|---|---|---|
| 冷第一张（tab 上还没有 stream） | 30.43 | **18.78** |
| 第 2 张（stream 预热后第一张，仍走一次全视口 capture） | 31.49 | 42.98 |
| 第 3 / 4 张（同一静态页） | 49.53 / 51.65 | **10.92 / 7.00** |
| 闲置 3s 后第 1 张（stream 已被 idle 停掉） | 14.26 | 12.05 |
| 闲置 3s 后第 2 张（同页） | 48.49 | **12.07** |
| 改 DOM 后截图 | 48.64 | **22.12** |
| 动作 + 截图间隔 3s（5 次中位） | 28.70 | 28.86（持平） |

静态页连拍是收益最大的常见形态（第 3 张起 7–11ms vs 47–52ms）；隔 3s 的「动作 → 截图」保持持平（冷路径先做 clip capture），爆发式连拍（bench）才是 −60% 的主场。

**不回退**：PNG `--shot-clip` 改前 474–598 动作、15.1–18.8ms → 改后 474–588、17.7–18.6ms（同一代码路径，`cropped == served`、`fallbacks 0`，差异在机器噪声内）；标准 PNG 视口 599–601 → 575–598、14.4–15.4ms；JPEG 视口（无 clip）601 → 589、14.91 → 15.35ms——都不在改动路径上。

**代价与边界**：

- RSS +50–80MB（多一条 JPEG screencast + 帧缓冲），每动作 CPU 略降（更多轮次走裁剪而不是 capture）。
- 两次 JPEG 代：stream 帧（请求的 quality）→ 页面按请求 quality 再编码一次；截图是给人/模型看的，不是像素级存档。
- 裁剪成本随内容复杂度上升：617KB 的噪声页帧（1440×813）页面侧解码+编码 22ms、每次重传 32ms，而 capture 只要 ~50ms；所以单帧 >2MB 直接回退 capture（2MB 已是 4K 级全细节页）。
- 静态页上「第二张」仍要一次全视口 capture 来建立可用帧（42.98ms），之后才 7–11ms。
- 页面拿不到 JS（崩溃/导航中）、isolated world 建不出来、页面 canvas 编码失败、输出不是合法 JPEG（SOI/EOI、≥128B）→ 全部回退，行为与改前一致。
- 输出是**设备像素**（与 PNG 裁剪一致），`width`/`height` 仍报 CSS px；`dpr=1` 时两者相同。
- 已走满窗口/保留 capture 的仍保留：`fullPage`、`frameRef`、`highlight`、`optimizeForSpeed:false`。

**回归**：`node test/headless.mjs` 新增 12 组断言（JPEG clip 的 SOI/EOI、SOF 像素尺寸 = 600×300×dpr、同一页字节相同、改页后必须变、`ref` 尺寸 = 元素框、主世界覆盖 `toDataURL` 后裁剪仍正确且不是页面给的字节、页面状态复原），清理探针残留的 141 个 headless Chrome 后连跑 7 次 PASS（机器被占满时，既有断言「两张截图都要由 stream 提供」会偶发假失败——那是旧竞态、与本次改动无关，负载正常后稳定）；`npm test` exit 0（含 `HEADLESS TEST: PASS`、`EXTENSION LOGIC TEST: PASS`、`13 checks passed, 0 failed`）。

### 4.1.10 2026-10-18 第十一轮：不启初始窗口（Ralph 循环第 6 轮）

**改了什么**（`src/headless.js`，launch args 一行）：`--no-startup-window`。driver 的每个 tab 都是自己用 `Target.createTarget` 建的，Chrome 启动时自己开的那个 `about:blank` 页面从来没人驱动；不开它，Chrome 启动后零 tab，第一个 tab 才建窗口。

**为什么安全**（4 条实测，都在同一棵树上交替跑）：

1. **关掉所有 session tab 后 Chrome 不退出**：`tab.close_session` 之后两棵树都 `cdp: true`、进程存活、`tabs: 0`，再建 tab 正常（base 77ms / new 279ms，一次性的窗口重建）。
2. **视口不变**：`--window-size=1440,900` 仍作用于后来创建的窗口——`innerWidth/innerHeight = 1440/813`、`dpr = 1`，同一页同一张视口截图**字节完全相同**（21708 B）。
3. **冷启动不回归**（3 对交替，fresh profile）：`ensureStarted` 740/754/530 → 528/536/341 ms（中位 740→528），第一个 `tab.goto` 173/187/254 → 280/296/346 ms（中位 187→296，要建窗口），到第一张截图 972/967/832 → 732/897/861 ms（中位 967→861）。启动省的时间基本被「第一个 tab 建窗口」吃掉，净持平偏好。
4. 位置参数 `about:blank` **保留**：Chrome 认 `--no-startup-window` 时会忽略它；万一某个版本不认这个开关，位置参数还能退回旧的「开一个 about:blank 窗口」行为。

**空闲 A/B**（`git archive 98b35e2` 导出原树 vs 本轮；每个状态 60s 预热 + 15s 采样，交替 1–2 对，1-min load 3.4–5.4；RSS = 所有进程 `ps -o rss` 求和，会把共享页重复计；footprint = `footprint -p` 的 phys footprint）：

| 空闲状态 | 改前 | 改后 |
|---|---|---|
| **从没用过（零 tab）** | 7 进程 / 3 renderer / RSS 692,700 / footprint 298,307 / CPU 0.1% | **5 / 1 / 449,450 / 150,152 / 0.1–0.3%** |
| 用一个 tab、页面闲着 | 8 / 4 / 813,820 / 336,339 / CPU 0.4–1.0% | **7 / 3 / 712,715 / 307,309 / 0.2–0.6%** |
| 所有 tab 都关了 | 7 / 3 / 705 / 304 / 0.3% | **5 / 1 / 497 / 177 / 0.2%** |

最常用的是「从没用过」态：**footprint −150 MB（−50%）、RSS −246 MB（−35%）、进程 7→5**；开着一个 tab 时 **footprint −30 MB（−9%）、RSS −103 MB（−13%）**。

**为什么零 tab 比一个 tab 降得多**：Chrome 的 top-chrome 浏览器 UI 是两个 `browser_ui` target（`chrome://omnibox-popup.top-chrome/` 和 `.../omnibox_popup_aim.html`），随窗口创建，合计 ≈25 + 49 MB footprint。零 tab 时没窗口 → 不创建；有一个 tab 时它们会被建出来，只有关掉最后一个 tab 才一起消失。

**活跃压测不回归**（同机交替 A/B，`--seconds 10`，`node scripts/headless-bench.mjs`）：

| 场景 | 改前 | 改后 |
|---|---|---|
| 标准 PNG（3 对） | 601/601/589 动作、screenshot 15.11/14.92/15.23 ms、每动作 CPU 17.20/16.84/17.47 ms、RSS 1180/1147/1145 MB、10 进程 | 595/584/586 动作、14.50/14.80/15.47 ms、17.18/16.25/17.32 ms、RSS 1023/1023/1015 MB、9 进程 |
| JPEG clip 600×300（3 对） | 465/457/458 动作、19.69/20.00/19.57 ms、每动作 CPU 23.61/23.61/25.41 ms | 426/468/533 动作、21.20/19.29/16.87 ms、25.94/24.21/23.30 ms |

（都在既有噪声带内：上一轮同场景 457–465 动作 / 19.6–20.0 ms。活跃期 RSS 降 130–155 MB 来自少一个空闲 renderer。）

**空闲 CPU：没有可优化的了。** 三种空闲态的 Chrome 合计 CPU 都是 0.1–1.0%，Node driver 0.1%。文档里旧的「空闲 1.34%」主要是**启动尾巴**——同一台机器、完全不经 CDP 直接起 Chrome（raw 探针）：browser 进程启动后前 20s ≈40%、第二个 20s ≈13%，之后 0.1–1.3%。那是 Chrome 自己的 profile/首启工作，Node 侧没有可动的；A/B 两侧的空闲 CPU 都在这个噪声量级。

**量过但不采纳**：

- `--renderer-process-limit=1`（配合本改动）：6 进程 / 2 renderer / RSS 636 MB（比改前 −176 MB），但把所有 tab 并进一个 renderer：丢站点隔离（恶意页可在同进程读其它站点内存）、多 tab 时互相拖慢。不做默认。
- 用 CDP 关 `browser_ui` target：`Target.closeTarget` 返回 `{success:true}` 但 target 仍在、进程不掉。
- `--disable-features=WebUIOmniboxPopup`：只去掉 `omnibox-popup.top-chrome/` 一个 target（`.../omnibox_popup_aim.html` 还在），进程数/RSS 不变（同窗口态 3 renderer / 709 MB）。`AimEnabled`、`WebUIOmniboxFullPopup`、`PreloadTopChromeWebUI`、`--app=about:blank` 对 target 集合没有影响。另外把 `--disable-features` 写进默认参数会覆盖用户经 `DSH_HEADLESS_CHROME_ARGS` 传的同名开关，收益又不确定，不做。
- `--disable-component-extensions-with-background-pages --disable-default-apps`：只去掉两个组件扩展 target（`fignfif…`/`nkeimh…` 的 service worker / background page），它们启动十几秒后自己就退了，稳态 RSS 无变化（796 vs 806 MB）。不做。
- 拿不到窗口就关不掉 Chrome top-chrome UI；要更省只能换 `chrome-headless-shell` 一类的独立二进制（本机没装，不引入）。

**回归**：`node test/headless.mjs` 3 次 PASS（没加新断言——改的只是启动参数，行为由既有 e2e 覆盖，含 tab 生命周期、截图/帧流、capture、screencast、downloads）；`npm test` exit 0（含 `HEADLESS TEST: PASS`、`EXTENSION LOGIC TEST: PASS`、`13 checks passed, 0 failed`）。

### 4.1.11 2026-10-18 第十二轮：bench 真实负载（mixed 节奏 / 空闲采样 / snapshot 字节）（Ralph 循环第 9 轮）

**为什么改**：第 7 轮的空闲 CPU/写盘是手工用 `ps` 采的、第 8 轮的 snapshot 字节/延迟是 `/tmp` 一次性探针测的——两个数都不在 bench 里，下一轮想复查得重写探针。本轮只动测量工具：新增场景与指标，**不改任何现有场景与指标的定义**。

**改了什么**（`scripts/headless-bench.mjs`，新增实现 + `test/bench-scenario.mjs`）：

- `--mixed`：每轮 = snapshot → 轮转执行 `type`（改 DOM）/ `click`（`#go`，真重绘）/ 只读 `evaluate` / `noopClick`（`#noop`，不重绘）/ `scroll` → screenshot；轮间间隔是确定性的 **150–400ms**（`150 + (i*97) % 251`，均值 275ms），模拟真实工具调用节奏而不是背靠背最坏情况。显式 `--gap-ms` 覆盖节奏。
- `--idle-seconds N`：活跃循环结束后再采 N 秒 Chrome 进程树，输出 `idle.cpuPercent / rssMb / processes / streamFrames`。`--idle-settle-seconds N` 先等 N 秒再采；每条 idle 报告都带 `browserUptimeSeconds`。
- 每次运行都输出 `snapshot.maxChars / calls / bytesMean / bytesMax`：`tab.snapshot` 返回值的 JSON 字节（driver 层，`maxChars=2000`），在计时桶之外测，不影响 `perActionMs.snapshot`。这是「快照正文预算」类回归在 bench 里的可见指标。
- `gapMs` 顶层字段改为**实际生效**的轮间间隔：非 mixed 场景仍是 `--gap-ms` 的值（默认 0，与旧输出一致），mixed 场景是最新节奏均值（旧输出会显示 0，与实际 275ms 矛盾）。

**mixed 基线**（3 次 10s 跑；同机 1-min load 3.5–4.0；Chrome 155；每次 35 轮、3.43–3.46 轮/s，节奏均值 275.3ms / 实测 156–396ms）：

| 指标 | 中位 |
|---|---|
| snapshot | 1.33 ms |
| type | 1.06 ms |
| evaluate（只读） | 1.38 ms |
| click（`#go`，真重绘） | 2.00 ms |
| scroll | 0.66 ms |
| screenshot | 9.72 ms |
| 每轮合计 | 12.60 ms |
| snapshot 响应字节 | 691 B/次（`maxChars=2000`） |
| RSS / 进程 | 1024–1046 MB / 9（短跑仍带启动期多出的 renderer；40s 跑稳定到 758 MB / 7） |

`cpuPercent` 37.6–41.3、`cpuMsPerAction` 110–119 在这类短跑里**主要是 Chrome 自己的启动尾巴加 275ms 轮间空闲**，不能和背靠背标准场景的每动作 CPU 横比；mixed 场景看 `perActionMs`，CPU 只在同长度、同节奏的两次运行之间比。

**空闲基线**（同一工具连续测，`idle.cpuPercent`；窗口起点 = 空闲窗口开始时的浏览器 uptime）：

| 空闲窗口起点 | 窗口 | CPU | RSS | 进程 | 空闲期帧数 |
|---|---|---|---|---|---|
| 活跃 5s 后（uptime 13.1s） | 1s | 23.93% | 932 MB | 9 | — |
| 活跃 40s 后（uptime 42s） | 15s | 1.53% | 736 MB | 7 | — |
| `--idle-settle-seconds 45`（uptime 62.6s） | 10s | **0.60–0.70%** | **730–733 MB** | **7** | **0** |

结论：**稳态空闲 0.6–0.7% CPU / ~730MB / 7 进程**（一个 tab + 截图帧流），空闲期 0 帧——这 0.6% 不是帧编码。要量稳态必须越过 Chrome 启动尾巴（§4.1.10 的 raw 探针：前 20s ≈40%、第二个 20s ≈13%、之后 0.1–1.3%），短跑后直接采会得到 20–70% 的尾巴数；`browserUptimeSeconds` 就是用来判断这一点的。

**现有场景不回归**（`git archive HEAD` 原 bench vs 本轮，各 3 次交替，`--seconds 10`，load 3.5–4.0）：

| 场景 | 改前（中位） | 改后（中位） |
|---|---|---|
| 动作数 | 592（553–597） | 594（588–595） |
| screenshot | 15.18 ms（15.01–15.22） | 14.89 ms（14.73–15.27） |
| 每轮合计 | 16.90 ms（16.75–18.09） | 16.84 ms（16.81–17.01） |
| 每动作 CPU | 16.99 ms（16.45–17.88） | 17.24 ms（15.64–17.29） |
| RSS | 1035 MB（1000–1068） | 1038 MB（1018–1048） |
| snapshot 响应字节 | —（旧 bench 不测） | 695 B/次 |

全部在噪声带内；新增的 `snapshot` 字节测量在计时桶之外，没有抬高 `perActionMs.snapshot`（0.60–0.74 ms，与改前 0.58–0.99 ms 同带）。

**复跑**：

```bash
cd /Users/taishuo/projects/dsh-chrome
node scripts/headless-bench.mjs --seconds 10 --mixed
node scripts/headless-bench.mjs --seconds 10 --mixed --idle-seconds 10 --idle-settle-seconds 45
node scripts/headless-bench.mjs --seconds 10            # 旧场景输出不变（多了 snapshot 字节字段）
node test/bench-scenario.mjs                            # 契约测试（npm test 里也跑）
```

**没做/没采纳**：不把 idle 默认自动 settle 到 uptime≈45s（会让 `--idle-seconds` 悄悄多花 45s；改成显式开关 + 报告 uptime）；不按轮逐次采样 CPU（35–139 轮会让 `ps` 进程数翻倍，测出来的是探针自己的开销）；不把启动尾巴预热加进默认路径（10s 跑会变成 50s+，还会改变既有基线）；mixed 不新增「纯动作 CPU」指标（短跑里启动尾巴不可分，硬拆会得到假数）。

### 4.1.12 2026-10-18 第十三轮：键盘 `tab.press` 的重绘窗（Ralph 循环第 10 轮）

**为什么改**：第 3/4 轮让只读 evaluate、边界 scroll、普通 click/hover 在「可证明没有重绘」时复用缓存帧，但 `Input.*` 动作仍无条件推进变更标记。本轮探针实测（同一页、body 焦点）：

| 动作 + 截图 | 截图耗时 | 结果 |
|---|---|---|
| `press Escape`（无可编辑焦点） | **43.2–43.4 ms** | 6/6 次 `repaintMisses`，返回按键前的旧帧 |
| `press k`（body 焦点） | 43.2 ms | 同上 |
| `press ArrowDown` / `Shift` | 43.3 ms | 同上（这些本来就该等） |
| 只读 evaluate + 截图 | 0.4–0.8 ms | 命中缓存 |
| `clickAt` 到普通 div / `drag` | 18.7 / 28.5 ms | 焦点/拖动事件真的重绘了一部分 |

也就是说：**每个无可视效果的按键都白等满 40ms 重绘窗，然后拿回一张旧帧**（`repaintMisses` 计数就是它）。这和第 3/4 轮修的是同一类问题，只是键位路径一直没接探针。

**改了什么**（`src/headless.js`）：

- 追踪器快照新增 5 个字段（都只读、页面侧实测快照仍 ~0.01ms）：`active`（焦点元素 tag，穿透 open shadow root）、`editable`（input/textarea/select/contenteditable/role=textbox…、以及 **iframe/frame/object/embed** 与**自定义元素**——后者可能有无法探测的 closed shadow root）、`interactive`（a[href]/button/summary/label/area/[tabindex]/popovertarget/commandfor，Enter 能激活的东西）、`selection`（非折叠选区）、`fullscreen`（fullscreenElement/pictureInPictureElement）。
- `visualProbeAction(tab, action, accept, precheck)` 新增 `precheck(before)`：用**动作前**状态否决短路，否决时连第二张快照都不拍（不合格的按键只多付 1 次快照 ≈0.25ms）。
- `tab.press` 走该探针，键位策略 `pressProbeEligible(key, before)`：

| 键/状态 | 是否短路 | 原因 |
|---|---|---|
| 可打印 ASCII 字符（`!`–`~`，不含空格） | 是（≤`complete` 且无编辑/选区/全屏） | 无可编辑焦点时没有 UA 默认动作 |
| `Enter` | 仅当焦点不在可激活控件上 | 会激活按钮/链接/表单 |
| `Escape` | 是（无编辑/选区/全屏且页面已加载完） | 只可能关 dialog/popover（都是 DOM 变更）或退全屏（已否决）/中止加载（要求 readyState complete） |
| `Tab` / 方向键 / PageUp/Down / Home/End / Space / Backspace / Delete / F1–F12 / 任何多字符键名 | 否 | 滚动可能落在 after 快照之后（合成器线程），重载/导航/激活可能在快照之后才提交 |
| 焦点在可编辑元素、非折叠选区、全屏、自定义元素、`readyState !== 'complete'`、canvas/media/同源 iframe、`DSH_HEADLESS_VISUAL_PROBE=0` | 否 | 探针看不见或来不及看见 |

页面自己的 `keydown` 处理器与 click 处理器同类：同步改 DOM 会被 `mutations` 计数抓住，异步稍后重绘对任何探针都不可见（与 click 的既有边界相同）。**动作语义没有变**：仍然是同样的两次 `Input.dispatchKeyEvent`（keyDown + keyUp），只是不再无条件推进变更标记。

**A/B（同机 3+3 交替，`--seconds 10 --press`，load 4.3–5.4）**：

| 指标 | 改前（`git archive HEAD` 旧驱动 + 新 bench） | 改后 |
|---|---|---|
| 每轮 | **44.96–45.12 ms** | **1.65–1.71 ms**（−96%） |
| 截图 | 43.22–43.37 ms | 0.45–0.47 ms |
| 轮/秒 | 22.15–22.23 | **582–603** |
| repaint 超时（每轮白等的 40ms） | 222/222/223 | **0** |
| visualSkips | 0 | 5828–6028（每轮都短路 + 热身） |
| RSS | 940–1030 MB | 997–1034 MB |

改前的 45ms/轮 = 0.9ms 快照 + 0.85ms 按键 + 43.3ms 截图（40ms 窗口 + 开销）；改后 1.66ms = 0.39 + 0.82 + 0.45。

**不回归**：mixed 场景 3+3 交替（同机，load 3.9–5.1）每轮 12.24/13.60/12.24 → 12.05/13.00/12.56 ms（中位 12.24 → 12.56，成对 −0.19/−0.60/+0.32，噪声带内）；`visualSkips` 两边都 18、`repaintMisses` 3/4/3 → 3/3/3；各动作桶同带（snapshot 1.20–1.50 / 1.20–1.35、click 1.78–2.23 / 1.92–2.38、screenshot 9.44–10.73 / 9.18–10.06）。

**正确性证据**：

- 正对照：把新 `test/headless.mjs` 放进旧树跑 → 第一条新断言 FAIL（`no-op Escape press did not skip the repaint window: {"before":15,"after":15}`），说明断言不是摆设。
- `test/headless.mjs` 新增 21 条断言，覆盖：Escape/可打印键短路且字节与缓存帧相同、键盘延迟 <25ms；焦点在按钮时可打印键仍短路而 Enter 不短路；ArrowDown/Shift 不短路；焦点在 input 时 `k`/`Escape` 都不短路；**open shadow root 内的 input** 被 `shadowRoot.activeElement` 穿透；**closed shadow root 的自定义元素**保守等待；非折叠选区等待、清除后恢复短路；`<dialog showModal>` 的 Escape 关闭（属性变更）不短路且 dialog 真的关了；页面 keydown 处理器改 DOM 时截图必须是新帧。
- `/tmp` 探针同口径复核（modal dialog、handler、open/closed shadow、按钮焦点、选区）；`node test/headless.mjs` PASS、`node test/bench-scenario.mjs` PASS（新增 `--press` 契约：`visualSkips === actions + 1`、`repaintMisses === 0`、截图 <5ms）。

**复跑**：

```bash
cd /Users/taishuo/projects/dsh-chrome
node scripts/headless-bench.mjs --seconds 10 --press   # 每轮 ~1.7ms、repaintMisses 0
node scripts/headless-bench.mjs --seconds 10 --mixed   # 不回归
node test/headless.mjs && node test/bench-scenario.mjs
```

**本轮没做**：`tab.clickAt` / `tab.drag` 仍不接探针（`clickAt` 是可信鼠标事件，点中可编辑元素会在已聚焦的输入框内移动插入符、双击会选文本，两者都不可由计数器证明；`drag` 的 `DragEvent` 合成不触发 UA 拖放状态，收益待量）；不放宽键位策略去覆盖 Tab/滚动键/功能键（原因见上表）；不把探针并进动作本身的 evaluate（§PERF-LOOP §2 已否决的方向）。

### 4.1.13 2026-10-18 第十四轮：真实鼠标 `tab.clickAt` 的重绘窗（Ralph 循环第 11 轮）

**为什么改**：§4.1.7/§4.1.8/§4.1.12 把只读 evaluate、边界 scroll、合成 click/hover、键位都接上了视觉探针，但 `Input.*` 里的**可信鼠标**动作一直无条件推进变更标记。第 10 轮的探针已经量到 `clickAt` 到普通 div + 截图 18.7ms（那次页面里还聚焦着 input，点击会让它失焦，所以是「真的重绘了」）。本轮先在同一页面上把真正无重绘的情形量清楚（`--click-at`，pointer 已在目标点、body 焦点、无选区）：

| 情形（clickAt + 截图） | 截图耗时 | repaint 超时 | 说明 |
|---|---|---|---|
| 第 1 次点到新位置（pointer 从别处移过来） | 34.9–57.3 ms | 0–1 | 指针移动改变了 CSS `:hover` 链（可能真的重绘） |
| 同一点重复点击（pointer 已在那儿） | **43.3–45.1 ms** | **每次 1** | 什么都不该重绘，却白等满 40ms 窗 |
| 同一点重复点击（页面有 `#noop:hover{...}`，hover 已生效） | **43.3 ms** | 每次 1 | 同上 |
| 点击聚焦 input 旁边（失焦会重绘） | 8.9–20.5 ms | 0 | 真的重绘，不该短路 |
| 纯 `clickAt`（不含截图，三次 `Input.dispatchMouseEvent`） | 5.0–17.8 ms | — | `mouseMoved` 占大头（2.4–16.2ms），pressed/released 各 0.5–2ms |

结论：**同一位置的重复点击是「可证明无重绘却付满 40ms」的缺口**；难点不在「有无 DOM 变更」，而是**指针移动本身**——`mouseMoved` 会改 UA 的 `:hover` 状态，paint 可以不产生任何 counter。

**改了什么**（`src/headless.js`）：

- 追踪器快照新增 2 个字段，且**只在带坐标时计算**（普通动作的 payload/开销不变）：`hover`（当前 `:hover` 链的 child-index 路径，例如 `0.1.4`；`''` = 没有任何元素 hover）与 `point`（`{x,y,hit,hazard,hover}`：`elementFromPoint` 命中 + 该点 hazard + 指针移过去**会**产生的 hover 路径）。页面侧实测 `querySelectorAll(':hover')` 在 12,005 元素的页面上中位 0.1ms。
- `visualSnapshot(tab, point)` / `visualProbeAction(tab, action, accept, precheck, point)`：两次快照都带同一坐标，`verdict` 里新增「hover 链变了 → `unknown`」（这是唯一没有 counter 的重绘源）。
- `tab.clickAt` 走探针，`clickAtProbeEligible(before, point)` 只放行**单击左键**，并且：

| 条件 | 是否短路 | 原因 |
|---|---|---|
| `clickCount === 1`、`button` 为 `left`/未指定 | 前置 | 双击会选文本，右/中键有各自的 UA 动作 |
| 指针已在命中元素上（`point.hover === before.hover`） | **必须** | 否则 `mouseMoved` 会改 hover 链，可能重绘且无 counter |
| `document.activeElement` 是 body/html | 必须 | 点击会移动焦点/失焦，焦点环与插入符不在计数器里 |
| 无折叠选区（`selection === false`） | 必须 | 单击会折叠选区（重绘） |
| 未全屏、无 canvas/media/同源 iframe、`readyState === 'complete'` | 必须 | 追踪器看不见的面 |
| 命中链上有 `a[href]/area`、`label`、`video/audio`、`[popovertarget]/[commandfor]`、`summary/details`、`dialog`、`iframe/frame/object/embed`、`button`、`input/select/textarea/[contenteditable]/[tabindex]`、自定义元素 | **否** | 导航/激活/焦点/插入符/关闭/子框架/closed shadow root 里的 `:hover`——clickPage 的 hazard 之外的鼠标专属项都补上了 |

页面自己的 click 处理器与 §4.1.8 的边界相同：同步改 DOM 会被 `mutations` 抓住，异步稍后重绘对探针不可见。**动作语义没有变**：仍然是同样的 `mouseMoved` + `mousePressed` + `mouseReleased`。

**A/B（同机 3+3 交替，`--seconds 10 --click-at`，load 4.5–5.0；旧侧 = `git archive HEAD` 旧驱动 + 同一份新 bench）**：

| 指标 | 改前 | 改后 |
|---|---|---|
| 每轮 | **50.03–50.24 ms** | **16.68–16.76 ms**（−67%） |
| 截图 | 42.97–43.88 ms | **0.75–1.05 ms** |
| `clickAt` 自身（含 2 次探针快照） | 5.02–6.17 ms | 14.80–15.44 ms |
| 轮/秒 | 19.89–19.97 | **59.60–59.89**（3×） |
| repaint 超时 | 200/201/201 | **0/0/0** |
| visualSkips | 1（只有那次只读 rect evaluate） | 599/601/599（每轮都短路） |
| RSS | 1003–1046 MB | 902–1022 MB |

改前每轮 50ms = 快照 0.9 + clickAt 5.2 + 截图 43.8（40ms 窗 + 开销）；改后 16.7ms = 快照 0.9 + clickAt 14.8（**2 次带命中判定的快照 + 三次鼠标事件**）+ 截图 0.8。**下一步的主矛盾已经变成 `clickAt` 自身**（`mouseMoved` 一次 2.4–16.2ms，占了 90%），不再是重绘窗。

**不回归**：mixed 场景 6 对（3 对 old→new，3 对 new→old，抵消 load 漂移 5.4–8.7）每轮 12.28/12.41/12.90/12.71/13.47/12.04 → 13.14/12.88/13.06/12.34/13.71/12.03 ms，成对 +0.86/+0.47/+0.16/−0.37/+0.24/−0.01（中位 +0.20ms ≈ 噪声）；`visualSkips` 6 次都 18、`repaintMisses` 都 3、`frames` 85–88。

**正确性证据**：

- 正对照：把新 `test/headless.mjs` 放进旧树跑 → 首条新断言 FAIL（`a repeated click at the same point did not skip the repaint window: {"before":28,"after":28}`）；新 `test/bench-scenario.mjs` 跑旧驱动 → FAIL（`click-at screenshots still pay the repaint window: 43.41ms`）。
- **hover 新鲜性**（本轮最关键的一条）：页面注入 `#hover-probe:hover{background:#f00}`，第一次点上去必须不短路，且截图**必须**是 hover 之后的新帧；settle 之后同一点再点必须短路，且截图字节必须等于 hover 后的帧——证明短路返回的是「已经画上去的 hover 帧」，不是 hover 前的旧帧。
- `test/headless.mjs` 新增 21 条运行期断言（18 处 `assert`，hazard 循环对 4 类目标各跑一次）：同点重复点击短路（`visualSkips +1`、`repaintMisses` 不变、<25ms、字节等于缓存帧）、双击不短路、移动指针不短路（且停下后恢复短路）、按钮/链接/input/`[tabindex]` 上**各点两次**（第二次 hover 已稳，只有 hazard 能否决它）、聚焦 input 时不短路、非折叠选区不短路且清除后恢复、hover 改样式时的新鲜性、以及 `hover` 不变时 `verdict` 才 clean。所有字节比较都先等「连续两张截图相同」（`stableFrameBytes`），避免把迟到的合成帧误判成点击问题。
- `/tmp` 探针同口径复核：按钮/链接/input/双击/聚焦/选区/自定义元素/hover 改样式 ≥9 类反例全部不短路；探针里 `hover` 链（`html>body>div#noop`）在 pointer 移开后变成 `html`、移回来又恢复，且 `getComputedStyle` 立刻看到 `rgb(255,0,0)`。
- `node test/headless.mjs` 连续 3 次 PASS（另需注意：本机 load 4.5–8.7 时，**既有的**新鲜性断言（如「DOM 改动的 click 必须是新帧」「canvas 绘制必须是新帧」）偶发失败，HEAD 树同样 1/4 次失败，与本轮无关——见 §PERF-LOOP §9）；`node test/bench-scenario.mjs` PASS（新增 `--click-at` 契约）、`npm test` exit 0。

**复跑**：

```bash
cd /Users/taishuo/projects/dsh-chrome
node scripts/headless-bench.mjs --seconds 10 --click-at   # 每轮 ~16.7ms、repaintMisses 0
node scripts/headless-bench.mjs --seconds 10 --mixed      # 不回归
node test/headless.mjs && node test/bench-scenario.mjs
```

**本轮没做**：

- 不放宽 `active === body` 的要求（焦点在普通 div 上时点击不会失焦，这是可做的方向，但要先证明「点击非可聚焦元素不动焦点」）。
- 不跳过重复位置的那次 `mouseMoved`（指针没动，真实的鼠标也不会发事件）：这会改变事件语义——页面 DOM 变化后浏览器会在下一次移动时重算 hover，跳过就等于让 hover 永久停在旧状态。
- 不合并三次 `Input.dispatchMouseEvent`（顺序必须保持；`mouseMoved` 单次 2.4–16.2ms 是 Chrome 侧等待，留给下一轮量）。
- 不修「保守动作把变更标记推到未来、之后每次截图都白等 40ms」这个**先前就存在**的放大效应（探针里实测：一次被否决的无重绘点击之后，连短路点击的截图也会 miss）——第 12 轮候选（已落地，见 §4.1.14）。

### 4.1.14 2026-10-18 第十五轮：重绘标记的退休（Ralph 循环第 12 轮）

**为什么改**：§4.1.7/§4.1.12/§4.1.13 的短路都建立在「变更标记（`tab.renderChangeAt`）由动作推进」上，但标记只会前进、不会后退：只要有一次动作无法被证明无重绘（hover 链变化、未被探针覆盖的按键、hazard 目标……），标记就停在缓存帧之后；截图等满一个窗后返回旧帧，**标记却留在未来**，于是之后*每一张*截图都继续白等同一个 40ms 窗——一次保守动作会污染它之后的所有截图延迟。第 11 轮已实测到这个放大效应（「被否决的无重绘 clickAt 之后，紧跟的短路 clickAt 截图仍 miss」），当时为不扩大改动面，bench 与测试都绕开了它。

本轮先用 `/tmp` 探针把放大效应单独量清楚（同页、body 焦点、无选区；两棵树各跑 3 次，下表给中位与极差）：

| 序列 | 改前 | 改后 |
|---|---|---|
| 一次保守的无重绘 clickAt（指针换位，hover 链变化）后连拍 4 张截图 | **41.25–43.88 ms，4 张全都 miss**（每张 `repaintMiss +1`） | 第 1 张 **43.06**（42.29–43.24）、之后 **0.66 / 0.43 / 0.45**（0.20–1.48）；只有第 1 张 miss |
| 保守 clickAt → 等 150ms → 只读 evaluate（干净判定）→ 截图 | **43.13**（41.85–43.16）ms，miss +1 | **0.49**（0.30–1.35）ms，miss +0 |
| 对照：真实重绘（DOM 写入）后连拍 2 张 | 10.63（10.16–11.24）/ 1.57（1.04–1.69）ms | 10.14（9.70–22.08）/ 0.94（0.77–1.14）ms（同量级；这条路径本轮不动） |

**改了什么**（`src/headless.js`）：

- 新增 `retireRenderChange(tab)`：把标记降到**当前已画出**的最新帧的 `composedAt`（只在「标记比缓存帧新」时生效），并累加 `renderChangeRetires`（`tab.debug_diag` 与 bench 报告里可见）。语义：标记是一张「欠一次绘制」的欠条，欠条只被授予一次 40ms 窗；过期没有帧到就作废，之后的截图不再为它付第二次。
- 两个退休点，都必须满足「窗口已经过完」：
  1. **截图 miss**：`screenshotFromStream` 等满 `SHOT_STREAM_FRAME_TIMEOUT_MS` 仍没有帧 → 返回旧帧的同时退休标记（本轮的主修复）；
  2. **干净判定**：`request()` 消费 `skipRenderChange` 时，若标记已经比窗口更老（`now - marker > 40ms`）→ 退休。这样「保守动作 → 只读/短路动作 → 截图」也不必再白等一次；窗口还没过完时**不**退（可能真有绘制在路上），所以这条路径从不缩短已经授予的等待，只是不再重复授予。
- 为什么对迟到的绘制安全：`state.last` 由 screencast 帧持续更新，晚到的帧只要 `composedAt >= 已退休的标记` 仍会被新鲜性检查服务——退休丢掉的只是「重复等待」，不是「已经到达的帧」。代价：若某次真实绘制的合成时间超过 40ms，第一次 miss 之后、该帧到达之前的那张截图可能拿到旧的（像素与 miss 自己返回的相同）。这是「窗口过期即视为没画」这条既有断言的直接延伸。
- 追踪器/探针语义未变：没有新增页面侧字段，也没有放宽任何短路条件。

**A/B（同机 3+3 交替，`--seconds 10 --shot-chain`，load 5.16–6.73；旧侧 = `git archive HEAD` 旧驱动 + 同一份新 bench）**

新场景 `--shot-chain`：每轮 = 真实 `clickAt` 在两个普通 div 之间交替（指针移动 → hover 链变化 → 探针必须保守）+ **3 张截图**。

| 指标 | 改前 | 改后 |
|---|---|---|
| 每轮 | **132.04–132.64 ms** | **50.45–51.21 ms**（−61.6%） |
| 截图（每张均摊） | 43.13–43.24 ms | **14.79–15.19 ms**（1 张付窗 + 2 张 ~0.3ms） |
| 轮/秒 | 7.54–7.57 | **19.52–19.81**（2.6×） |
| repaint 超时 | **228 = 3×76**（每轮 3 次） | **196/199/197 = 1× 轮数**（每轮 1 次） |
| `renderChangeRetires` | 0 | **196/199/197**（＝每轮一次） |
| 动作数/10s | 76/76/76 | 196/199/197 |

改前每轮 132ms = 快照 ~0.9 + clickAt ~2 + 截图 3×43.2；改后 50.8ms = 快照 ~0.7 + clickAt ~5 + 截图 43 + 2×0.3。`clickAt` 桶两边的差（1.9–2.1 → 4.8–5.8ms）是队列效应、不是动作变慢：`/tmp` 单独量 40 次换位点击，两棵树的中位都 16.5–16.8ms（旧 16.52/16.79、新 16.69/16.75）；旧侧的 clickAt 恰好夹在两次 40ms 空闲之间。

**不回归**：

- `--click-at` 3 对（同一份 bench，warm-up 未改）：每轮 16.60/16.73/16.62 → **16.60/16.61/16.66 ms**，截图 0.93/0.66/0.64 → 1.01/0.83/1.06 ms，`repaintMisses` 都 0，`visualSkips` 600–604 对 602–604。第 11 轮的 16.68–16.76ms 基线保持。
- `--mixed` 10 对（load 4.0–10.9，交替）：成对差 −1.14/−0.78/−0.51/+0.09/+0.23/+0.53/+0.58/+0.61/+0.87/+1.03 ms，中位 **+0.38**、均值 +0.15；`repaintMisses` 10 对都 3、`visualSkips` 都 18、`retires` 都 3。与第 11 轮 mixed 的成对中位 +0.20ms、极差 ±0.86 同带；mixed 每轮只有一张截图，本轮改的是「同一标记的第二次及以后」，这里本就不该有系统性变化。

**正确性证据**：

- 正对照（变异体各自跑真测试，`/tmp` 里复制新树后只改一处）：
  - 去掉两处 `retireRenderChange` 调用 → FAIL：`a repaint-window miss did not retire the change marker`（`0 !== 1`，1 次）；
  - 只去掉 miss 那一处 → FAIL 在同一条（3/3 次）；
  - 保留计数器但**不降标记** → FAIL：`the retired change marker made the next screenshot pay the repaint window again (amplification)`（3/3）——证明「放大效应」那条断言本身有效，不是被计数器带过的；
  - 只去掉「干净判定」那一处 → FAIL：`a proven paint-free action did not retire the stale change marker` / `a proven paint-free action past the repaint window still waited for a frame`（2/3 次，另一次先撞上既有环境 flake）。
- `test/headless.mjs` 新增 11 处断言（同一段落，并把视口内检查扩到 `#out`）：保守指针移动后第 1 张截图必须恰好 miss 一次且 `renderChangeRetires +1`；第 2 张必须命中（`repaintMisses` 不变、<15ms、字节等于 retire 后的缓存帧）；「保守动作 → 等过窗 → 只读 evaluate → 截图」必须 `repaintMisses` 不变、`retires` 增加、<15ms；退休之后的一次 DOM 写入仍必须产生**新帧**（不能因为标记被降过就返回旧帧）；随后同点重复点击的缓存命中/字节相等断言全部保持。所有字节比较前先 `stableFrameBytes()`（连续两张截图相同）。
- `test/bench-scenario.mjs` 新增 `--shot-chain` 契约：`repaintMisses ∈ [actions-1, actions+2]`（改前是 3×）、`perActionMs.screenshot < 20`、`visualRetires >= actions`；同一份测试跑旧驱动 → FAIL（`{"repaintMisses":114,"actions":38}`，正好 3×）。
- `node test/headless.mjs` 改完后连跑 5 次：4 次 PASS、1 次停在既有的 key-handler 新鲜性 flake（见下）；`node test/bench-scenario.mjs` PASS；`node test/operation-log.mjs` 13 checks、`node test/extension-logic.mjs` PASS、`npm test` exit 0。

**已知环境噪声**：本机 load 4.5–6.7 时，既有的「必须是新帧」断言（`a DOM-mutating key handler must not be stale` / `canvas draw must not be stale`）仍偶发失败。本轮用 `press → 截图` 的独立探针在同负载下对比两棵树：旧树 **6/160** 次 miss（3.75%）、新树 **3/160**（1.9%），中位延迟同为 ~18ms——**不是本轮引入的**；撞上就重跑，不要放宽断言。

**复跑**：

```bash
cd /Users/taishuo/projects/dsh-chrome
node scripts/headless-bench.mjs --seconds 10 --shot-chain   # 每轮 ~50.8ms、repaintMisses ≈ 轮数、retires ≈ 轮数
node scripts/headless-bench.mjs --seconds 10 --mixed        # 不回归
node scripts/headless-bench.mjs --seconds 10 --click-at     # 不回归（16.6ms/轮）
node test/headless.mjs && node test/bench-scenario.mjs
```

**本轮没做**：

- 不用「miss 后第二次等待减半」之类的重试窗：仍然会周期性白等，且无法区分「慢绘制」与「根本不会画」；退休 + 新帧到达即服务更简单，也更符合既有「窗口过期 = 没画」的断言。
- 不让干净判定**无条件**退休（不检查标记是否已过窗）：那会把「刚刚发出、可能还在路上的绘制」的授予窗一起取消，等于缩短保守等待。
- 没有处理 `drag`（28.5ms/次的同类缺口）与 `type` 同值重输，见 `docs/PERF-LOOP.md` §10 的下一步。

### 4.1.15 2026-10-18 第十六轮：合成 drag 的重绘窗（Ralph 循环第 13 轮）

**为什么改**：第 10/11 轮把 `Input.*` 里的键盘与真实鼠标接进了视觉探针，第 12 轮补上了标记退休；`tab.drag` 是最后一个「明明什么都没画、却让下一张截图等满 40ms」的动作（第 10 轮探针 28.5ms/次、3/6 白等）。先量清楚它到底画了什么（`/tmp` 探针，同页、`#a/#b` 两个无 handler 的 div，两棵树各 2 轮、每轮 3 张截图）：

| 序列（drag → 3 张截图） | 改前（HEAD） | 改后 |
|---|---|---|
| 无 handler 的普通 div 之间 | **42.83 / 43.86 ms**（第 1 张 miss），之后 0.36–0.68 ms | **0.38 / 0.23 / 0.19**、**0.31 / 0.28 / 0.21 ms**，0 miss |
| 页面有 `dragover`/`drop` handler 但只 `preventDefault()` + 计数（不改 DOM） | **44.30 / 43.94 ms**（miss） | **0.30 / 0.23 / 0.21**、**0.48 / 0.22 / 0.16 ms** |
| `drop` handler 往目标里 append 一个 `<span>` | 10.17 / 20.46 ms（新帧，0 miss） | 19.73 / 19.91 ms（新帧，0 miss；本轮不动） |
| `dragstart` handler 给源元素加 class | 9.30 / 44.03 ms（一次新帧、一次 miss） | 9.78 / 43.18 ms（同带：mutation 账本有歧义时保守） |
| 页面上有 `<canvas>` 时的普通 div 之间 | 42.47 / 44.35 ms（miss） | 41.84 / 42.34 ms（miss：探针否决） |

探针同时记录页面侧 `__dshVisual.snapshot()` 的前后差：无 handler / 只 `preventDefault` 的 drag **没有任何字段变化**（mutations/scrolls/focus/changes/toggles/animations/active/editable/interactive/selection/fullscreen/hover 全同）；append span 与加 class 只改 `mutations`。也就是说：能不能短路不取决于「drag 这个动作」本身，而取决于处理函数有没有留下 tracker 看得见的痕迹。

**为什么合成 drag 可以比真实 click 更宽**：`dragPage` 走的是页面内 `dispatchEvent`（`DragEvent`，`bubbles + cancelable + composed`），**不是** `Input.dispatchDragEvent`；未信任事件不触发 UA 默认动作，所以拖放不会真的移动数据、不会改焦点/选区、不会导航、不会激活控件——真实 click 需要 `hazard` 正是为了挡住这些 UA 路径。剩下需要否决的只有 tracker 本身看不见的绘制面（canvas 像素、media 表面、同源 subframe）、还在加载的页面、以及 fullscreen 文档：

```js
function dragProbeEligible(before) {
  if (!before) return false
  if (before.readyState !== 'complete') return false
  if (before.broken || before.canvas || before.media || before.frames) return false
  if (before.fullscreen) return false
  return true
}
```

页面处理函数若同步 `focus()` / 改选区，`visualProbeVerdict` 的 `active/editable/selection` 比较仍会把它判成 `unknown`；异步绘制（rAF / setTimeout 之后才画）与合成 click 一样在探针边界之外。

**改了什么**：`src/headless.js` 的 `tab.drag` 接入 `visualProbeAction`（`accept = value?.ok === true`，`precheck = dragProbeEligible`）；否决时只多一次追踪器快照、不拍第二张。`scripts/headless-bench.mjs` 新增 `--drag` 场景（snapshot + 两个无 handler 的 `<button>` 之间 drag + 截图；refs 从真快照里取）+ `drag` 计时桶 + `dragMode`/`drag` 报告字段；`test/bench-scenario.mjs` 新增契约；`test/headless.mjs` 新增 5 处断言（见下）。没有新增页面侧字段，也没有放宽任何既有短路条件。

**A/B（同机 3+3 交替，`--seconds 10 --drag`，1-min load 21.5 → 10.1 单调下降；旧侧 = `git archive HEAD` 旧驱动 + 同一份新 bench）**：

| 指标 | 改前 | 改后 |
|---|---|---|
| 每轮 | 44.48–44.71 ms | **1.33–1.40 ms**（−97%） |
| 截图 | 43.11–43.32 ms | **0.40–0.42 ms** |
| 轮/秒 | 22.35–22.47 | **706.8–749.0**（×31–33） |
| repaint 超时 | 224 / 224 / 225（= 轮数） | **0** |
| `visualSkips` | 0 | 7069–7220（> 轮数：warm-up 也算） |
| 动作数/10s | 224 / 224 / 225 | 7069 / 7497 / 7219 |
| `drag` 桶 | 0.46–0.53 ms | 0.57–0.61 ms（两次追踪器快照，≈+0.1ms） |

负载在本轮 A/B 里单调下降（旧侧先跑、负载更高），但差距是固定的 40ms 窗口（`SHOT_STREAM_FRAME_TIMEOUT_MS`），不是负载能解释的；`drag` 桶的 +0.1ms 是探针成本。

**不回归**：`--mixed` 3 对（load 6.1–8.2，mixed 不调用 drag）：每轮 12.23 / 12.70 / 11.72 → 13.33 / 12.67 / 12.30 ms，成对 +1.10 / −0.03 / +0.58；`visualSkips` 都 18、`repaintMisses` 都 3、`snapshot` 字节 830 = 830、动作数都 35；各桶差在噪声带内（旧 8.97–9.84 vs 新 9.60–10.26 的 screenshot 是混合场景里真重绘轮的抖动，mixed 不跑 drag）。bench 页面多了两个 button，但 `snapshot.bytesMean` 两边都是 830。

**正确性**：

- 旧驱动正对照（`/tmp/dsh-old-13`：HEAD 驱动 + 新 bench / 新测试）：`node test/bench-scenario.mjs` → FAIL `drag screenshots still pay the repaint window: 43.21ms`；`node test/headless.mjs` → FAIL `a handler-free drag did not skip the repaint window: {"before":38,"after":38}`。
- 变异体 ①（`tab.drag` 无条件 `skipRenderChange = true`，不做任何证明）→ `test/headless.mjs` FAIL `a page with a canvas must keep the conservative wait for drags`（`40 !== 39`）。
- 变异体 ②（`visualProbeVerdict` 去掉 `mutations` 比较）→ `/tmp` 探针：append span 的 drag 被短路，截图 **0.32 / 0.18 / 0.15 ms 且字节与上一帧相同**（span 不出现）；真树同序列 19.73ms 且字节变化——证明「改 DOM 的 drag 必须给新帧」那条断言不是摆设。
- `test/headless.mjs` 新增断言：无 handler 的 drag 必须 `visualSkips +1`、`repaintMisses` 不变、drag + 截图 <25ms、字节等于缓存帧；页面上有 `<canvas>` 时必须不短路且截图付一次窗（`repaintMisses +1`）；`drop` handler append `<span>` 时必须不短路且截图必须是新帧。
- `node test/headless.mjs` 连跑 5 次 3 PASS（2 次撞在既有环境 flake：一次 `a proven paint-free action did not retire the stale change marker`、一次截图字节比较；两次都发生在本轮新断言之前，HEAD 树同负载下同样偶发，重跑即过）；`node test/bench-scenario.mjs` PASS；`node test/operation-log.mjs` 13 checks；`node test/extension-logic.mjs` PASS；`npm test` exit 0。

**复跑**：

```bash
node scripts/headless-bench.mjs --seconds 10 --drag    # ≈1.35ms/轮、706–749 轮/s、repaintMisses 0、visualSkips ≈ 轮数
node scripts/headless-bench.mjs --seconds 10 --mixed   # 不回归
node test/headless.mjs && node test/bench-scenario.mjs
```

**本轮没做**：

- 不加 hover / hit-test 命中判定（clickAt 的 `point` 那套）：合成 DragEvent 不移动指针、不触发 UA 拖放，hover 链不会因它变化，命中判定只会多一次页面侧 hit-test。
- 不把 `dragPage` 换成原生 `Input.dispatchDragEvent`（真实拖放）：那会改工具语义（真搬数据、触发 UA drop），不是本轮的性能问题；要真 DnD 是另一件事。
- 不覆盖异步绘制（handler 里 rAF / setTimeout 之后才画）：与合成 click 的探针边界一致。

### 4.1.16 2026-10-18 第十七轮：同值重输的重绘窗（Ralph 循环第 14 轮）

**为什么改**：`Input.*` 的 press / clickAt / drag 都已接进视觉探针（§4.1.12–§4.1.15），`tab.type` 是最后一个「没改任何可见内容、却让下一张截图等满 40ms」的动作：把字段已经有的值再写一遍（幂等重填/重试），`typePage` 照样调 value setter、照样派发 `input`/`change`，但值、焦点、光标全都没动。先量清楚它到底画了什么（`/tmp/probe-type-r14.mjs`，同一个 `input#q`，旧/新驱动各一轮，每步 type 后连拍两张截图）：

| 序列（type → 截图） | 改前（HEAD） | 改后 |
|---|---|---|
| 同值重输（聚焦、光标在末尾） | **42.02 / 43.65 / 43.41 / 42.39 ms**（4/4 miss） | **0.46 / 0.96 / 0.46 / 0.50 ms** |
| 空 append（同值、光标不动） | 43.41 ms（miss） | 0.46 ms |
| 改值 `seed` → `seedX` | 9.79 ms（新帧） | 14.67 ms（新帧，两个方向都是真重绘） |
| 同值、但先把光标移到 0 | 10.96 ms（新帧，见下） | 0.33 ms（命中缓存） |
| append 一个字符 | 9.98 ms（新帧） | 20.35 ms（新帧） |
| 同值、但字段未聚焦（要移动焦点） | 16.73 ms（新帧） | 16.43 ms（新帧：焦点变化 → 否决） |

探针同时记录页面侧 `__dshVisual.snapshot()` 的前后差：同值重输只改 `changes`（`typePage` 自己派发的那一个 `change`，不是别人的 UA 状态变化），mutations/scrolls/focus/toggles/animations/active/editable/interactive/selection/fullscreen 全同。**光标被设为 0 那一行的 10.96ms 不是这次 type 画的**：前后 `selectionStart/End` 都是 0（Chrome 的 value setter 在值没变时不动光标），那是输入框光标闪烁带来的无关帧；短路后这一行变成 0.33ms 命中，画面差异最多是光标相位，与任何缓存命中同性质。

**为什么同值重输可以不画**：字段的可见内容只由「值 + 光标 + 焦点」决定（外加 placeholder/validity，而它们都是值的函数）。三者在动作前后逐项相等时，写 value 与派发 `input`/`change` 不会改变任何可见像素；页面处理函数自己改的东西（DOM 写入、`change`/`focus`/`toggle`、滚动、动画计数）由追踪器计数器与 verdict 兜底，与合成 click 完全同一条边界。因此判定放在页面侧结果里，而不是再加一套 hazard：

```js
// typePage 末尾（节选）
const changed =
  document.activeElement !== activeBefore ||
  valueAfter !== valueBefore ||
  caretAfter[0] !== caretBefore[0] ||
  caretAfter[1] !== caretBefore[1]
return { ok: true, value: ..., submitted, changed, changeEvents, probeBefore }
```

`accept` 要求 `ok && changed === false && submitted === false`：值变了、光标动了、焦点挪了都算真重绘；`submit` 可能走 `requestSubmit()` 在 after 快照之后才导航，一律保守。precheck（`typeProbeEligible`）只挡追踪器看不见的绘制面（canvas 像素 / media 表面 / 同源 subframe）、还没加载完的页面与 fullscreen——verdict 自己也有同样的三项兜底（变异体实测：去掉 precheck 的 canvas 判定后仍不会短路）。

**探针成本是怎么降下来的**：第一版把同值重输接进 `visualProbeAction`（动作前另拍一张追踪器快照）。`--type-same` 从 42.7ms 降到 1.2–1.5ms，但**每一个改值的 type**（最常见的那种）要多付一次 evaluate：`--mixed` 的 `type` 桶 0.96–1.14 → 1.70–2.46 ms、标准场景每轮 +0.36ms。type 本来就要往页面里跑一趟，于是把动作前的追踪器快照**放进 `typePage` 自己的 evaluate**（`visualProbeAction` 新增第 7 个参数 `actionSnapshot(value)`，从动作结果里取回 before 快照；快照在 focus/value 写入之前拍，语义与独立快照相同）。这样改值 type 只多付页面内快照本身的工作（不付往返），同值 type 再多一张 after 快照。合并后标准场景每轮 +0.06–0.12ms、`type` 桶 +0.26ms；第一版的 +0.36ms/轮 不再需要。

**A/B（同机交替，`--seconds 10 --type-same`，1-min load 5.9–6.4；旧侧 = `git archive HEAD` 旧驱动 + 同一份新 bench）**：

| 指标 | 改前 | 改后（合并快照后） |
|---|---|---|
| 每轮 | 43.34 / 42.98 ms | **1.17 / 1.17 ms**（−97.3%） |
| 截图 | 41.62 / 41.51 ms | **0.24 / 0.24 ms** |
| 轮/秒 | 23.06 / 23.25 | **848.98 / 845.20**（×36–37） |
| repaint 超时 | 218 / 218（= 轮数） | **0 / 0** |
| `visualSkips` | 0 / 0 | 8494 / 8452（= 动作数） |
| 动作数/10s | 231 / 233 | 8494 / 8452 |
| `type` 桶 | 0.77 / 0.53 ms | 0.53 / 0.53 ms |

第一版（动作前独立快照，3+3 交替）是 42.67 / 42.71 / 42.75 → 1.23 / 1.47 / 1.41 ms、23.4 → 674–807 轮/s、`repaintMisses` 219–221 → 0，数字同量级；合并快照只影响改值 type 的成本。

**不回归**：标准场景（`--seconds 10`，2 对交替）每轮 16.78 / 16.67 → 16.90 / 16.73 ms（成对 +0.12 / +0.06），`type` 桶 0.60 / 0.64 → 0.90 / 0.88 ms（合并后只多页面内快照 ~0.26ms，标准场景每轮 1 次 type，且 type 是真重绘、截图照常等帧）；`--mixed`（2 对交替）每轮 12.80 / 12.91 → 13.45 / 12.92 ms（成对 +0.65 / +0.01，mixed 由 150–400ms 节奏决定轮数，35 轮不变），`visualSkips` 都 18、`repaintMisses` 都 3、snapshot 字节都 830；`type` 桶 0.79–0.96 → 1.25–1.58 ms（1/5 的动作，mixed 里渲染线程刚画完帧，页面内快照约 0.5ms）。第一版（独立快照）的 mixed 3 对是 17.39 / 13.09 / 13.44 → 13.79 / 13.53 / 12.89，`type` 桶 0.96–1.14 → 1.70–2.46 ms——这就是后来合并快照的原因。

**正确性**：

- 旧驱动正对照（`/tmp/dsh-old-14`：HEAD 驱动 + 新 bench / 新测试）：`node test/bench-scenario.mjs` → FAIL `type-same screenshots still pay the repaint window: 41.21ms`；`node test/headless.mjs` → FAIL `a same-value type did not skip the repaint window: {"before":41,"after":41}`。
- 变异体 ①（`changed` 去掉值比较，只留焦点/光标）：同值判定仍对，但**同长度的改值**（`same` → `SAME`，光标不动）会被误判成无重绘 → FAIL `a value-changing type must keep the conservative wait`。测试里的改值用例因此刻意用等长替换，否则光标跟着走会掩盖这个缺口。
- 变异体 ②（`accept` 去掉 `submitted`）：FAIL `a submitted type must keep the conservative wait`。
- 变异体 ③（`typeProbeEligible` 去掉 canvas）：**不失败**——verdict 自己也有 canvas/media/frames 三项，precheck 只是省第二张快照的前置否决；这条记录在案，避免以为它是唯一闸门。
- `test/headless.mjs` 新增断言：同值重输必须 `visualSkips +1`、`repaintMisses` 不变、type+截图 <25ms、字节等于缓存帧；等长改值（`same` → `SAME`）必须不短路且截图是新帧；页面有 `<canvas>` 时同值重输不短路且截图付一次窗（`repaintMisses +1`）；未聚焦字段的同值重输（焦点移动）不短路；带 `submit` 的同值重输不短路；contenteditable 同文本写入（重建文本节点）不短路。
- `node test/headless.mjs` 本轮共跑 17 次、12 PASS；5 次失败**全部**是既有环境 flake：4 次 `a proven paint-free action did not retire the stale change marker`（第 12 轮 §4.1.14 就记录过、本轮之前的断言）、1 次 press 的 `no-op Escape press paid the repaint window (29.5ms)`；HEAD 树同机 3/3 PASS（1-min load 4.8–5.7），失败轮次 load ≥8.7，不放松任何断言。同机还有别的会话在跑 72 个 `--headless=new` 探针进程（`dsh-poison-probe-*`，已跑 40–66 分钟），是本轮负载与 flake 的外部来源。`node test/bench-scenario.mjs` PASS；`node test/operation-log.mjs` 13 checks；`node test/extension-logic.mjs` PASS；`npm test` 第 3 次 exit 0（前两次都停在同一处既有 flake 上，load 分别 5.4 / 5.8，第三次 4.9 通过）。

**复跑**：

```bash
node scripts/headless-bench.mjs --seconds 10 --type-same   # ≈1.2ms/轮、845–849 轮/s、repaintMisses 0、visualSkips ≈ 轮数
node scripts/headless-bench.mjs --seconds 10 --mixed       # 不回归
node test/headless.mjs && node test/bench-scenario.mjs
```

**本轮没做**：

- 不跳过同值 type 的 `change` 事件派发（「值没变就不派发」）：那会让依赖该事件的页面处理函数收不到回调，是语义变化，不是性能优化；探针改为把这个自有事件作为「预期增量」告诉 verdict。
- 不在值真变了时省掉等待（例如按「值变了必有新帧」直接返回缓存帧）：真重绘必须给新帧，这是 §4.1.14 之后仍然保留的底线。
- 不覆盖异步重绘（处理函数里 rAF / setTimeout 之后才画）与 IME/组合输入：与其它探针同一条边界。
- 不把 `probeBefore` 快照并进 `Input.*` 的其它动作：clickAt/press/drag 的动作本身没有页面 evaluate 可搭车，合并要另开 CDP 往返语义，收益只有 ~0.25ms（§2 已否决同类改动）。

## 5. 下一步（H1）

1. `chrome_pick` 的 headless 语义（可返回 selector 流程）；
2. capture 引擎与扩展共享（两套行为一致性）；
3. 截图性能：PNG/JPEG 帧流（§4.1.1、§4.1.2）、静态页空闲保活（§4.1.3）、`clip`/`ref` 从帧缓存裁剪（§4.1.4）、JPEG `clip`/`ref` 的页面侧裁剪（§4.1.9）都已落地；整视口「页面变了」的下限仍是合成器帧间隔 ~15–16ms。剩余的方向：
   - ~~`clip` 的 JPEG 请求仍走 capture~~ ✅ **已落地（§4.1.9）**：isolated world 里用页面自己的 JPEG codec 裁剪，`--shot-clip --shot-format jpeg` 46.2 → 18.4 ms/截图（动作/10s 201 → 435–490），`--shot-ref` jpeg 47.9 → 15.5–23.5 ms。边界：双 JPEG 代、单帧 >2MB 回退 capture、静态页第二张要一次全视口 capture 解锁。**别再做**：在 stream 运行时用带 clip 的 capture（会让 Chrome 之后一直吐 clip 尺寸的帧）。
   - ~~只读 evaluate 后的 40ms 重绘窗~~ ✅ **已落地（§4.1.7）**：页面侧视觉变更追踪器证明「没重绘」时不再推进 change marker，只读 evaluate → 截图 43.2 → 0.26 ms、边界 scroll 42.2 → 0.22 ms；有 canvas / 同源 subframe / 异步重绘时保持保守。~~剩余同类项：`Input.*` 动作里的 `drag` 仍走满窗口~~ ✅ **已落地（§4.1.15）**：无 handler 的合成 drag → 截图 **0.40–0.42ms**（原 43.1–43.3ms，付满窗）；canvas/media/同源 subframe 与改 DOM 的 handler 仍保守。
   - ~~合成 click / hover 后的 40ms 重绘窗~~ ✅ **已落地（§4.1.8）**：普通 click → 截图 43.2 → 0.23 ms、hover 43.4 → 0.21 ms；目标可能导航 / 提交表单 / 激活控件 / 操作媒体 / 开关 popover 时保持保守（hazard），无 mutation 的 UA 状态变化由 change/toggle 计数器兜底。`Input.*` 与 type 均已覆盖：press / clickAt / drag（§4.1.12–§4.1.15）、同值重输 → 截图 **0.24ms**（原 41.5–41.6ms，付满窗，§4.1.16；改值/焦点/光标/subelement 变化时仍保守）。
   - viewer 分支每帧的 base64+磁盘写已节流（§4.1.6）：headless 落盘 15.0→10.0 帧/s、fs 同步耗时中位 −31%、node CPU −13%；桌面 host 落盘 29.7→10.4 帧/s、fs 同步耗时 −55%。
   - 冷启动剩下的 ~750ms 在 Chrome 进程启动与 CDP 端口就绪（§4.1.5），Node 侧不可控；不建议预热进程（空闲即 449MB RSS，§4.1）。
   - ~~headless 空闲内存~~ ✅ **已落地（§4.1.10）**：`--no-startup-window` 去掉了没人用的初始 `about:blank` 窗口——零 tab 空闲 7 进程/700MB RSS/footprint 302MB → **5 / 449MB / 151MB**；开着一个 tab 8/816 → 7/714；关掉所有 tab 7/705 → 5/497。**别再做**：`--renderer-process-limit=1`（丢站点隔离）、用 CDP 关 `browser_ui` target（关不掉）、`--disable-features` 关 omnibox popup（只少一个 target、RSS 不变，还会覆盖用户传的 `--disable-features`）。**剩余**：有窗口时 Chrome 的两个 top-chrome UI renderer（≈74MB footprint）关不掉，除非换 `chrome-headless-shell` 独立二进制（本机没装）。
4. 启动参数在帧流路径上扫过（§4.1.3），没有净收益；`--disable-frame-rate-limit` 仍是否掉的（每动作 CPU +41%）。

## 6. 代码

| 文件 | 内容 |
|---|---|
| `src/headless.js` | headless Chromium 启动（`--no-startup-window`：只有 tab 才建窗口，§4.1.10）、CDP client、页面动作、`tab.*`/`browser.*` 请求实现；截图帧流与 `clip`/`ref` 的驱动层 PNG 裁剪（§4.1.1–§4.1.4）、冷启动并行化（§4.1.5）、viewer 帧落盘节流（§4.1.6）、页面侧视觉变更追踪器与重绘窗短路（§4.1.7）、合成 click/hover 的 hazard 判定与 change/toggle 计数（§4.1.8）、JPEG `clip`/`ref` 的 isolated-world 页面裁剪与 screencast 帧几何过滤（§4.1.9）、键盘 press 的重绘窗探针与键位策略（§4.1.12）、真实鼠标 clickAt 的 hover 链/命中 hazard 判定（§4.1.13）、重绘标记的退休（miss 后与过窗后的干净判定，`renderChangeRetires`，§4.1.14）、合成 drag 的探针与 `dragProbeEligible` 否决面（canvas/media/subframe/未加载/fullscreen，§4.1.15）、`tab.type` 的同值重输探针（`typePage` 返回 `changed`/`changeEvents` 并自带 before 快照，`typeProbeEligible` 否决面，verdict 接受自有 `change` 增量，§4.1.16） |
| `host/host.mjs` | Chrome native messaging host：扩展 ↔ provider 的 JSON 帧中继、discovery 文件重连、viewer 帧落盘（节流，§4.1.6）与扩展热更新监听 |
| `src/backend.js` | BackendRouter + AsyncLocalStorage + `wrapToolsForBackend`（给 39 个工具加 `backend` 参数） |
| `index.js` | 创建 HeadlessDriver/Router，包装工具，卸载时关闭 |
| `scripts/headless-bench.mjs` | 活跃 CPU/RSS 压测：逐动作计时 + 每动作 CPU + 相对 §4.1 基线的 delta + 截图格式选项；`--gap-ms` 轮间空闲、`--static` 静态页（测缓存/保活）、`--shot-clip WxH` / `--shot-ref` 元素/区域截图路径（§4.1.4，PNG 驱动裁剪 / JPEG 页面裁剪 §4.1.9）、`--readonly-eval` 只读 evaluate + 截图场景（§4.1.7）、`--noop-click` 普通 click + 截图场景（§4.1.8）、`--mixed` 真实节奏混合场景（§4.1.11）、`--press` 无效果按键 + 截图场景（§4.1.12）、`--click-at` 同点重复点击 + 截图场景（§4.1.13）、`--shot-chain` 保守指针移动 + 3 张截图场景（§4.1.14）、`--drag` 无 handler 按钮之间的合成拖拽 + 截图场景（§4.1.15）、`--type-same` 同值重输 + 截图场景（§4.1.16）、`--idle-seconds` / `--idle-settle-seconds` 空闲采样（§4.1.11）；输出里带 `screenshotStream` 计数器（served/cropped/jpegCropped/fallbacks）、`snapshot` 响应字节、mixed 轮转/节奏统计、`idle` 块、`visualSkips`/`visualRetires`、`dragMode`/`drag.refs`、`typeSameMode`/`typeSame`；动作上限 `ACTIONS*50`（短路场景 `ACTIONS*2000`），保证 `--seconds` 跑满 |
| `test/backend-router.mjs` | 路由/参数剥离/默认桌面回归 |
| `test/headless.mjs` | 真 Chrome headless 端到端（goto/snapshot/type/click/screenshot/capture/screencast/emulate 等，含快 PNG 合法性、缓存视口、PNG/JPEG 截图帧流复用与新鲜度、format/quality 切换、emulate 尺寸、空闲 2s 后保活缓存、clip/ref 裁剪尺寸与新鲜度、JPEG clip/ref 的 SOI/EOI 与像素尺寸、同页字节复用与改页新鲜性、主世界覆盖 `toDataURL` 后 isolated-world 裁剪仍正确、viewer 帧落盘产物断言、只读 evaluate/边界 scroll/合成 click/hover/无可效果按键的视觉探针短路与陈旧帧断言，含 editable/选区/open+closed shadow root/modal dialog/keydown handler 的反例；真实鼠标 clickAt 的同点短路与按钮/链接/input/tabindex/双击/指针移动/聚焦/选区/hover 改样式反例，§4.1.13；重绘标记退休：miss 一次后第 2 张截图必须命中、过窗后的干净判定必须退休、退休后 DOM 写入仍是新帧，§4.1.14；合成 drag 的无 handler 短路 / canvas 否决 / 改 DOM 的 handler 必须给新帧，§4.1.15；同值重输的短路与等长改值/焦点移动/submit/contenteditable/canvas 否决，§4.1.16) |
| `test/bench-scenario.mjs` | bench 的 `--mixed` / `--idle-seconds` / `--press` 契约：真起 Chrome 跑 5s 混合场景 + 1s 空闲，断言轮转覆盖五种动作、确定性 150–400ms 节奏、`snapshot` 字节与既有指标字段都在、idle 窗口真的等满（§4.1.11）；再跑 4s `--press`，断言每轮都短路（`visualSkips === actions + 1`）、`repaintMisses === 0`、截图桶 <5ms（§4.1.12）；再跑 4s `--click-at`，断言 `clickAtMode`/点位、每轮都短路、`repaintMisses === 0`、截图桶 <5ms（§4.1.13）；再跑 4s `--shot-chain`，断言每轮 3 张截图只付 1 个重绘窗（`repaintMisses ∈ [actions-1, actions+2]`、`visualRetires >= actions`、截图桶 <20ms）（§4.1.14）；再跑 4s `--drag`，断言 `dragMode`/refs、每轮都短路（`visualSkips >= actions`）、`repaintMisses === 0`、截图桶 <5ms（§4.1.15）；再跑 4s `--type-same`，断言 `typeSameMode`/文本、每轮都短路（`visualSkips >= actions`）、`repaintMisses === 0`、截图桶 <5ms（§4.1.16） |
| `test/host-reconnect.mjs` | native host 持久化（provider 重启后重连）+ viewer 帧落盘/节流 trailing flush 断言（§4.1.6） |
