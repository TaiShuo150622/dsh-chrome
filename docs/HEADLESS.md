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

**边界**：剩下 ~750ms 是 Chrome 进程启动（435ms）+ Chrome 在端口写完到能服务 CDP 之间（316ms），Node 侧动不了。不建议为了第一条工具调用预热 Chrome 进程：空闲 headless 进程树 RSS 就有 672MB（§4.1），不用 headless 后端的桌面用户不该付这份常驻内存。标准 bench 不受影响（启动发生在计时窗口外，bench 先 warm-up 再计时）：改后复跑 539 / 558 / 577 动作/10s。

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

## 5. 下一步（H1）

1. `chrome_pick` 的 headless 语义（可返回 selector 流程）；
2. capture 引擎与扩展共享（两套行为一致性）；
3. 截图性能：PNG/JPEG 帧流（§4.1.1、§4.1.2）、静态页空闲保活（§4.1.3）、`clip`/`ref` 从帧缓存裁剪（§4.1.4）都已落地；整视口「页面变了」的下限仍是合成器帧间隔 ~15–16ms。本轮之后剩余的方向：
   - `clip` 的 JPEG 请求仍走 capture（driver 里没有 JPEG 解码），~45ms；如要补，需要 JPEG 帧流 + 一个能裁剪 JPEG 的路径（或让调用方接受 PNG）。
   - ~~只读 evaluate 后的 40ms 重绘窗~~ ✅ **已落地（§4.1.7）**：页面侧视觉变更追踪器证明「没重绘」时不再推进 change marker，只读 evaluate → 截图 43.2 → 0.26 ms、边界 scroll 42.2 → 0.22 ms；有 canvas / 同源 subframe / 异步重绘时保持保守。剩余同类项：合成 click 与 `Input.*` 动作（press / clickAt / hover / drag）仍走满窗口。
   - viewer 分支每帧的 base64+磁盘写已节流（§4.1.6）：headless 落盘 15.0→10.0 帧/s、fs 同步耗时中位 −31%、node CPU −13%；桌面 host 落盘 29.7→10.4 帧/s、fs 同步耗时 −55%。
   - 冷启动剩下的 ~750ms 在 Chrome 进程启动与 CDP 端口就绪（§4.1.5），Node 侧不可控；不建议预热进程（空闲即 672MB RSS）。
4. 启动参数在帧流路径上扫过（§4.1.3），没有净收益；`--disable-frame-rate-limit` 仍是否掉的（每动作 CPU +41%）。

## 6. 代码

| 文件 | 内容 |
|---|---|
| `src/headless.js` | headless Chromium 启动、CDP client、页面动作、`tab.*`/`browser.*` 请求实现；截图帧流与 `clip`/`ref` 的驱动层 PNG 裁剪（§4.1.1–§4.1.4）、冷启动并行化（§4.1.5）、viewer 帧落盘节流（§4.1.6）、页面侧视觉变更追踪器与重绘窗短路（§4.1.7） |
| `host/host.mjs` | Chrome native messaging host：扩展 ↔ provider 的 JSON 帧中继、discovery 文件重连、viewer 帧落盘（节流，§4.1.6）与扩展热更新监听 |
| `src/backend.js` | BackendRouter + AsyncLocalStorage + `wrapToolsForBackend`（给 39 个工具加 `backend` 参数） |
| `index.js` | 创建 HeadlessDriver/Router，包装工具，卸载时关闭 |
| `scripts/headless-bench.mjs` | 活跃 CPU/RSS 压测：逐动作计时 + 每动作 CPU + 相对 §4.1 基线的 delta + 截图格式选项；`--gap-ms` 轮间空闲、`--static` 静态页（测缓存/保活）、`--shot-clip WxH` / `--shot-ref` 元素/区域截图路径（§4.1.4）、`--readonly-eval` 只读 evaluate + 截图场景（§4.1.7）；动作上限 `ACTIONS*50`（只读场景 `ACTIONS*2000`），保证 `--seconds` 跑满 |
| `test/backend-router.mjs` | 路由/参数剥离/默认桌面回归 |
| `test/headless.mjs` | 真 Chrome headless 端到端（goto/snapshot/type/click/screenshot/capture/screencast/emulate 等，含快 PNG 合法性、缓存视口、PNG/JPEG 截图帧流复用与新鲜度、format/quality 切换、emulate 尺寸、空闲 2s 后保活缓存、clip/ref 裁剪尺寸与新鲜度、viewer 帧落盘产物断言） |
| `test/host-reconnect.mjs` | native host 持久化（provider 重启后重连）+ viewer 帧落盘/节流 trailing flush 断言（§4.1.6） |
