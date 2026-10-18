# 发布说明 0.1.88（能力门控 / 操作记录 / 性能循环）

> 2026-10-18 · 扩展 **0.1.88** / provider **0.1.88** / 工具面 40（evaluate 开启 41）/ `npm test` **20 个测试文件**
> 本版无新工具；重点是把能力契约、操作记录、后台性能与桌面可用性收口。

## 能力与工具

- **backend capability 门控**：`BackendRouter.capabilities/supports()` + `src/capabilities.js` 10 项能力矩阵；`chrome_pick` 在 headless 前置返回可执行 `UNSUPPORTED_BACKEND`（改用 desktop 或 snapshot+selector），`chrome_screencast` 统一门控；desktop 行为不变。
- **平台/浏览器路径表**：`src/platform.js` 覆盖 chrome/edge/brave/chromium × mac/linux/win；`install.js` 查表化，macOS 产物逐字节不变，Windows 只打印注册表命令不执行（真机风险：`.cmd` 可能需要 exe wrapper）。
- **操作记录系统**：`src/operation-log.js` 记录每个 `chrome_*` 调用（tool/backend/耗时/ok/errorCode/参数与结果摘要）；JSONL 单条 ≤2KB、4MiB 轮转、URL/secret/password 脱敏、HTML/base64 不落盘、`DSH_OPERATION_LOG=0` 可关、`readOperationStats()` 可查；10 项测试。
- **screencast 后台 tab**：start 自动激活 tab/展开折叠组/恢复聚焦窗口/USER_SWITCHED 复位；status 增加 `visible/tabActive/frameAt/frameAgeMs/hint`；真机验证后台 tab 也能出帧。

## 性能循环（8h Ralph，16 轮，S1–S9）

| 子目标 | 结果 |
|---|---|
| S1 帧写盘节流 | 落盘 15→10 帧/s、写盘 30→20 次/s、磁盘 −34% |
| S2 操作记录开销 | 10k append 0.055→**0.018ms**（−68%），单次工具 logging −55% |
| S3 changed-page 重绘窗 | 只读/边界 scroll/普通 click/hover 截图 43.2→**0.21–0.26ms** |
| S4 JPEG+clip | clip 截图 46.2→**18.4–21.2ms**（页面侧 codec 裁剪） |
| S5 headless 空闲内存 | 零 tab RSS 700→**449MB**、进程 7→5 |
| S6 扩展/host 空闲唤醒 | storage 写盘 26.3KB/min→0、update-state 1.18→0 次/min、alarm 2→1 |
| S7 snapshot 正文预算 | 100KB 正文页 wire 117.2→**35.4KB（−70%）**，模型可见文本 −74% |
| S8 真实负载 bench | 新增 `--mixed` / `--idle` 场景与 snapshot 字节指标 |
| S9 动作重绘窗 | press 45→**1.65–1.71ms**、drag 44.5→**1.33–1.40ms**、同值 type 43.3→**1.17ms**、同值 select 44.6→**1.35–1.43ms**；clickAt 下限 16.5ms（Chrome vsync） |

最终标准场景：**593 动作/10s、59.25 轮/s、每轮 16.85ms、截图 14.28ms**（60Hz 合成上限）；`--select-same` 8053 动作、每轮 1.23ms。

负结果 32 条与剩余瓶颈见 [PERF-LOOP.md](PERF-LOOP.md) §2/§4.1；未通过放宽测试来“优化”。

## 测试

`npm test` 20 个测试文件全过：原有工具/扩展/host 套件 + headless、bench-scenario、capture-parity、backend-contract、install-platform、operation-log、liveview、screencast-guard、headless-login 等。

## 已知限制

- Windows/Linux/Edge/Brave 仍是路径/注册脚手架，未真机验证；Windows `.cmd` launcher 风险见 [INSTALL-PLATFORM.md](INSTALL-PLATFORM.md)。
- headless 真实站点 gate（支付 iframe / HerosOneCore 后端）与一次性登录真机验证仍待用户输入。
- 整视口截图受 60Hz 合成上限；clickAt 的 vsync 等待不可在驱动侧消除；活跃内存 ~1GB 属 Chrome 渲染进程模型。
