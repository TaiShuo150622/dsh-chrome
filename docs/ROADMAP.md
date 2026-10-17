# 分阶段实施计划：从个人用到官方

> 日期：2026-10-17　关联：[设计文档](DESIGN.md) · [审批说明](APPROVAL.md) · [M0 清单](M0.md)
> 原则：**阶段门不过不进入下一阶段**；工具从核心到全量；分发从本地到官方；平台第一期只承诺这台 Mac。

## 1. 两条推进线

- **能力线**：核心 12 工具（能干活）→ 全工具（对齐 Claude/Codex）→ 官方化打磨。
- **交付线**：本地开发安装 → 个人日常使用 → 开源可交付 → 官方形态。

两条线在同一阶段汇合，每个阶段都有可验收的交付物和「停止 / 继续」判据。

## 2. 阶段总览

| 阶段 | 周期 | 目标 | 工具面 | 平台 | 分发 | 退出条件（Gate） |
|---|---|---|---|---|---|---|
| **P0 技术验证** | 0.5–1 天 | 证明五件事成立 | 4 个（status/goto/snapshot/screenshot） | 这台 Mac | 本地：plugin_manager + 未打包扩展 | 五个假设全部通过并留证 |
| **P1 个人日常** | 2–3 天 | 我能在本机真实干活 | **核心 12 个** | 这台 Mac | 本地 + 一键安装脚本 | 10 个真实场景 + 连续 3 天真实使用 + 重启恢复 + 不抢焦点 |
| **P2 个人主力** | 3–5 天 | 功能对齐 Claude/Codex | **全工具**（约 24 个工具 / 40+ 动作） | 这台 Mac | 本地 + 设置页 | 能力清单逐项打勾 + 3 个复杂真实任务 + 审批与设置可用 |
| **P3 开源可交付** | 3–5 天 | 别人能装、能维护 | 全工具稳定 | macOS 通用（Windows 视需要） | GitHub 公开 + Releases（扩展 zip） | 干净机器 10 分钟内装好 + CI 绿 + 文档齐 + 无回归 |
| **P4 官方化** | 依官方流程 | 进入官方形态 | 全工具 + 官方 runtime 对齐 | 官方支持矩阵 | 官方推荐 / 商店 / 内置 | 官方评审接受 |

> 个人全量可用约 **1–1.5 周**；开源可交付约 **2–2.5 周**；P4 取决于官方节奏。

## 3. 工具矩阵（最终目标态）

最终工具面按「少量工具 + 多操作」设计（减少 schema 与 token 体积），**能力上覆盖 Claude in Chrome + Codex 的浏览器动作**。

| 分类 | 工具（最终名） | 覆盖能力 | 首次出现 |
|---|---|---|---|
| 会话 | `chrome_status` | 连接/版本/会话标签组/诊断 | P0 |
| 会话 | `chrome_close_session` | 关闭本会话标签组 | P1 |
| 会话 | `chrome_browsers` | 多浏览器/多窗口枚举与选择 | P3 |
| 标签 | `chrome_tabs` | list / new / close / get / claim（认领用户当前标签） | P1（claim 在 P2） |
| 导航 | `chrome_goto` | 打开 URL（后台标签，不抢焦点） | P0 |
| 导航 | `chrome_history` | back / forward / reload | P1 |
| 导航 | `chrome_wait` | load / networkidle / 文本出现 | P1 |
| 读取 | `chrome_snapshot` | 文本快照 + 编号 ref + delta | P0 |
| 读取 | `chrome_get_text` | 局部/懒加载正文 | P2 |
| 读取 | `chrome_find` | 页面内查找 + 返回 ref | P2 |
| 读取 | `chrome_html` | DOM/HTML 片段（脱敏） | P2 |
| 读取 | `chrome_a11y` | 无障碍树 | P2 |
| 读取 | `chrome_console` | 控制台日志（需 debugger，显式开启） | P2 |
| 读取 | `chrome_network` | 网络请求（需 debugger，显式开启） | P2 |
| 交互 | `chrome_click` | 编号 ref 点击（React/Vue 安全） | P1 |
| 交互 | `chrome_type` | 输入/替换/提交 | P1 |
| 交互 | `chrome_press` | 键盘按键 | P1 |
| 交互 | `chrome_scroll` | 视口滚动 | P1 |
| 交互 | `chrome_select` | 下拉/复选/单选项 | P2 |
| 交互 | `chrome_hover` / `chrome_drag` | 悬停、拖拽 | P3 |
| 交互 | `chrome_dialog` | alert/confirm/prompt 处理 | P2 |
| 交互 | `chrome_evaluate` | 受限 JS 执行（默认关） | P2 |
| 交互 | `chrome_clipboard` | 读写剪贴板（需确认） | P3 |
| 采集 | `chrome_screenshot` | 视口/整页/元素截图（可回传视觉） | P0 |
| 采集 | `chrome_save_asset` | 页面图片/文件落盘 | P2 |
| 采集 | `chrome_upload` | 文件上传（需确认） | P2 |
| 采集 | `chrome_download` | 下载记录与文件路径 | P2 |
| 采集 | `chrome_export` | 页面→Markdown/文本导出 | P3 |
| 采集 | `chrome_record` | GIF/录屏（可选） | P3 |
| 批量 | `chrome_batch` | 一次调用多个动作（减少往返） | P3 |
| 权限 | `chrome_permissions` | 站点信任/审批设置（工具或设置页） | P2 |
| 效率 | `chrome_shortcuts` | 录制/重放常用动作 | P3 |
| 诊断 | `chrome_diagnostics` | host/扩展/版本/日志自检 | P1（并入 status 亦可） |

## 4. 各阶段详情

### P0 技术验证（这台 Mac，0.5–1 天）

- **范围**：空壳 bundle + 最小扩展 + native host + UNIX socket；4 个工具；截图进附件。
- **只验证假设**（见 [M0.md](M0.md)）：装得上、provider 注册、原生消息连通、快照/ref、图片回传。
- **交付物**：可安装的 spike 分支 + `docs/M0.md` 结果记录 + 手动步骤说明。
- **Gate**：5 项全过；任一失败先在 M0 内换替代（回环 WS / vendor provider 包 / 附件管线降级），不带着疑点进 P1。
- **平台边界**：仅 macOS + 本机 Chrome 155 + DSH 0.2.1-rc.1。

### P1 个人日常（这台 Mac，2–3 天）

- **目标**：我能用它在这台电脑上真实完成日常网页任务，而不是 demo。
- **范围**：核心 12 工具 + 每会话后台标签组 + 会话隔离 + 审批 v1 + 断线重连 + 安装脚本 + popup 状态。
- **不做**：设置页、claim 用户标签、console/network、上传下载、Windows、商店。
- **交付物**：可日常安装版本；10 场景验收脚本；`docs/INSTALL.md`（Mac 版）。
- **Gate**：
  1. 10 个真实场景通过（本地应用、登录站点、表单、多标签、截图、重连、并发会话、受保护页、登录交还、关闭清理）；
  2. 连续 3 天真实使用，无需重启 DSH/Chrome 才能继续；
  3. 后台标签不抢焦点；
  4. 审批卡在 DSH GUI 正常出现、拒绝路径正确；
  5. 卸载/重装不残留（native manifest、host、标签组）。

#### P1 实施结果（2026-10-17，记录见 [records/2026-10-17-code-p1-core-tools](records/2026-10-17-code-p1-core-tools/record.md)）

- **已完成**：12 个 `chrome_*` 工具；会话标签组与 owner 隔离；follow-dsh 审批门（先读会话 sandbox 模式）；native host 常驻重连；工具层测试 3 条脚本（`npm test`）；真机全序列验收（状态/导航/快照/输入/点击/等待/滚动/截图/标签新开与关闭/历史/关会话）。
- **关键实测结论**：后台且折叠标签组上，`executeScript` 与 content-script 消息都会无限挂起；页面动作最终固定走 CDP `Runtime.evaluate`（与截图同通道）。详见 [DESIGN 4.2.1](DESIGN.md)。
- **Gate 缺口**：Gate 1「10 个真实场景」尚未逐项留证；Gate 2「连续 3 天真实使用」未开始；Gate 3 有例外（`chrome_tabs new` 会激活新标签）；Gate 4 在本会话是 `danger-full-access`，审批卡未真实弹出过；Gate 5 未验证。
- **技术债**（P2 优先）：扩展侧自动重连、CDP 首次动作超时重试、tabs.new 后台打开、A2 browser-use seam、TS/vitest 迁移。

### P2 个人主力（全工具，3–5 天）

- **目标**：能力上不再需要 Claude/Codex 作为替代；处理复杂任务。
- **前置（P2-1 稳定性，先于广度）**：扩展自动重连（免人工 ⟳）、CDP 首次动作超时自动重试、`chrome_tabs new` 后台打开、扩展版本/死代码清理、V9/V10（DSH 重启/关闭）验证。
- **P2 规划文档**：[docs/P2-PLAN.md](P2-PLAN.md)。2026-10-17 探索周期后工具面达到 **25 个**（含 pdf/drag/emulate/storage/a11y），见 [P2 探索记录](records/2026-10-17-code-p2-explore/record.md)。
- **范围**：全工具矩阵（约 24 个工具），重点：
  - 调试与数据：`chrome_console` / `chrome_network` / `chrome_html` / `chrome_a11y` / `chrome_find` / `chrome_get_text`；
  - 账号与文件：`chrome_upload` / `chrome_download` / `chrome_dialog` / `chrome_select` / `chrome_evaluate`（默认关）；
  - 用户协作：`chrome_tabs.claim`（认领当前标签）、元素拾取、站点信任设置；
  - 设置：审批严格度、视觉开关、快照上限、debugger 高级能力开关。
- **Gate**：Claude/Codex 能力清单逐项打勾；3 个复杂真实任务（登录态多站调研、带上传的表单、长页面采集/导出）完成并留证；高级能力默认关且 banner 不出现。

### P3 开源可交付（macOS 通用，3–5 天）

- **目标**：陌生人按文档能装、能排错、能贡献。
- **范围**：公开仓库（GitHub）、版本号与 CHANGELOG、CI（typecheck/test/e2e，Chrome for Testing）、完整文档（README、INSTALL、TOOLS、TROUBLESHOOTING、SECURITY）、Releases 提供扩展 zip、安装器友好化。
- **平台**：macOS 通用；Windows 作为可选支线（`.cmd` launcher + 目录路径），不承诺 Linux。
- **已完成部分（2026-10-17）**：CI 工作流（`npm test` + `docs/TOOLS.md` 一致性检查）、[安装指南](INSTALL.md)、[工具参考](TOOLS.md)（`npm run docs:tools` 生成）、扩展打包脚本（`npm run package:extension` → `dist/*.zip`）。
- **Gate**：干净环境 10 分钟内装好；CI 绿；文档能让第三方独立完成安装与首个任务；P1/P2 验收无回归；许可与出处（NOTICE）齐备。

### P4 官方化（依官方流程）

- **目标**：从「第三方插件」进入「官方形态」。
- **范围**：对齐官方公开的 browser-use shared runtime 与包版本线；按官方规范整理包名/文档/测试；向上游提交 provider 或进入官方发布流程；Chrome 商店上架（如需要）；zh/en 完整 i18n；维护与安全响应。
- **Gate**：官方评审接受；或明确「仅在社区分发」并同步调整定位。
- **前提**：P1–P3 期间保持实现中性（不绑定个人路径/个人习惯），否则无法上游。

## 5. 分发与信任边界演进

| 阶段 | 安装方式 | 扩展来源 | 信任边界 | 用户 |
|---|---|---|---|---|
| P0 | plugin_manager + 开发者模式加载目录 | 本地未打包 | 本机 loopback + 本地 socket | 我 |
| P1 | + 一键安装脚本 | 本地未打包 | 同上 + token/0600 | 我 |
| P2 | + DSH 设置页 | 本地未打包 | 同上 + 站点信任管理 | 我（日常主力） |
| P3 | GitHub Releases + 文档 | 未打包 zip（或商店） | 同上 + 审计日志 | 早期用户 |
| P4 | 官方/商店 | 商店签名 | 官方策略 | 公众 |

## 6. 审批演进

| 阶段 | 审批能力 |
|---|---|
| P0 | 不做（本地验证，人工盯着） |
| P1 | 插件级审批 v1：**默认 `follow-dsh`**（普通动作跟随 DSH 会话策略）；硬敏感动作始终单独确认（`ctx.userQuestions`）；拒绝返回 `APPROVAL_DENIED`；可切 `strict`/`balanced` |
| P2 | 持久设置：严格度模式、站点信任列表、超时、审计日志；与 DSH 权限预设的交互定稿 |
| P3 | 设置页 + 文档 + 安全说明；默认值经真实使用校准 |
| P4 | 对齐官方审批/权限策略 |

详见 [APPROVAL.md](APPROVAL.md)。

## 7. 停止 / 继续判据

- **P0**：任一假设失败 → 停在 M0，换替代方案重验，不带着疑点进 P1。
- **P1**：真实使用 3 天如果有明显摩擦（误操作、抢焦点、频繁断线）→ 先修体验，不加新功能。
- **P2**：工具太多模型选错/抱怨 → 合并 op、改描述、必要时砍功能；不是继续堆。
- **P3**：商店审核阻塞 → 先只发 GitHub 未打包版本，商店不阻塞开源。
- **P4**：官方流程不明 → 保持社区版本维护，不无限期挂起。

## 8. 时间线（按顺序执行）

```
P0 0.5–1d → P1 2–3d → P2 3–5d → P3 3–5d → P4（官方节奏）
              └─ 个人全量 ~1–1.5 周 ─┘
                          └─ 开源可交付 ~2–2.5 周 ─┘
```

## 9. 第一期（P0/P1）明确边界 —— 这台 Mac

- **OS/硬件**：macOS（本机 Apple Silicon）；不做 Windows/Linux 兼容层。
- **运行时**：DSH Desktop 0.2.1-rc.1；Chrome 155；native host 用 app 自带 Electron-as-Node。
- **安装**：`plugin_manager` 装 bundle + 开发者模式加载扩展 + 首次重启 Chrome；不发布商店版本。
- **能力**：P1 的 12 工具 + 后台标签组 + 审批 v1；截图视觉可开。
- **数据**：页面内容只进当前 DSH 会话；只操作本会话标签组，不碰用户其他标签。
- **不做**：设置页、claim 用户标签、console/network、上传下载、GIF、多浏览器、Windows、i18n 完整化。
