# Windows 测试指南（0.2.25）

> 面向外部测试者。目标：确认 Windows 上 **安装 → Chrome 连接 → 基础工具 → headless → 多 tab/限额 → 崩溃/清理 → 安全边界** 全链路。
> 只使用公开页面；**不要登录真实账号、不要输入真实密码/OTP、不要付款**。
> 测试包：<https://github.com/TaiShuo150622/dsh-chrome/releases/tag/v0.2.25>

## 0. 测试包与校验

| 文件 | SHA-256 |
|---|---|
| `dsh-desktop-chrome-0.2.25.tgz` | `d474185a20e31736a14faaed03b8b1d29e77494352802afe32aa2e1147627691` |
| `dsh-chrome-extension-0.2.25.zip` | `58efbb634b4386d05d9c5d1a139b42be35c515245c78f3406ce0fe1d34906ef1` |
| `dsh-chrome-host-win32-x64.exe` | `09a4a09827e5f320ac86121427c1c9d0247d16f05163d3b1da7c7a769799e3de` |

PowerShell 校验：

```powershell
Get-FileHash .\dsh-desktop-chrome-0.2.25.tgz -Algorithm SHA256
Get-FileHash .\dsh-chrome-extension-0.2.25.zip -Algorithm SHA256
Get-FileHash .\dsh-chrome-host-win32-x64.exe -Algorithm SHA256
```

三个哈希必须与上表一致；不一致就停止测试并反馈。

## 1. 前置条件

- Windows 10/11 x64（arm64 暂不支持，见 §8）
- Chrome 116+；Edge/Brave 可作附加测试，但桌面控制默认只支持 Chrome
- DSH Desktop 已安装并可启动插件
- 建议先完全退出 Chrome（托盘也退出）
- 不需要安装 Node（host.exe 自带 runtime）

## 2. 安装

### 2.1 安装 DSH 插件

1. 解压 `dsh-desktop-chrome-0.2.25.tgz`。
2. DSH → 插件 → 添加插件 → 选择解压后的 `package` 目录（含 `package.json`、`cordis.patch.yml`）。
3. 确认存在：
   ```text
   host\bin\win32-x64\dsh-chrome-host.exe
   ```
4. 启用 `dsh-desktop-chrome`，重启 DSH。
5. 如果 DSH 里已有旧插件：覆盖安装后确认 exe 文件时间/大小变化；不要保留旧插件目录。

### 2.2 加载 Chrome 扩展

1. 解压 `dsh-chrome-extension-0.2.25.zip`。
2. `chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → 选 `dsh-chrome-extension`。
3. 扩展 ID 应为：
   ```text
   mejmgfhpgklcmphgimfbfohaodmjfmok
   ```
   不一致必须记录。

### 2.3 重启 Chrome / 连接

1. DSH 启动且插件启用后，**完全退出 Chrome，再打开**。
2. 点扩展图标，popup 应显示 **Connected**；provider 0.2.25、extension 0.2.25。
3. 若 Not connected，先收集 §7 的诊断包，不要自行改注册表；只有在诊断确认 manifest/registry 缺失时才按 [WINDOWS-HOST.md](WINDOWS-HOST.md) 兜底。

## 3. 10 分钟必测路径（先跑完这一组）

- [ ] 扩展加载、ID 正确、popup Connected
- [ ] `chrome_status` 显示 desktop connected，`bridgeError` 为 null
- [ ] 打开 `https://example.com`，`chrome_snapshot` 能读到页面
- [ ] `chrome_pointer` 显示鲸鱼 cursor + `DSH` 标签，`hide` 后消失
- [ ] popup Cursor 切换 Arrow/Dot 后，下一次 pointer/auto-follow 使用新外观
- [ ] 点击 `Learn more` 能跳转
- [ ] 截图成功，文件可在 Windows 打开
- [ ] 关闭 Chrome 后，`chrome_status` 变为断开且无崩溃 DSH
- [ ] 重新打开 Chrome，popup 能恢复 Connected（不需要重装）

## 4. 完整测试矩阵

### A. 安装 / native host / 平台

- [ ] `host\bin\win32-x64\dsh-chrome-host.exe` 存在，大小与 release 一致
- [ ] manifest 存在：`%USERPROFILE%\.dsh\cache\dsh-chrome\native-messaging-hosts\com.deepseek.dsh.chrome.json`
- [ ] manifest `path` 指向 exe，而不是 `.cmd`
- [ ] `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.deepseek.dsh.chrome` 指向 manifest
- [ ] 任务管理器能看到 `dsh-chrome-host.exe`；关闭 DSH/Chrome 后能退出
- [ ] DSH 重启后连接恢复
- [ ] 路径含空格（例如 `C:\Users\Test User\...`）时仍能连接
- [ ] 非管理员用户可安装/连接（若必须管理员，记录）

### B. Bridge / 协议

- [ ] `chrome_status` 无 `EACCES`、无 `ENOENT`、`bridgeError` null
- [ ] 连续 5 次快速调用 `chrome_snapshot` 不串结果
- [ ] 关闭 DSH 再启动，Chrome 扩展能自动重连
- [ ] 版本不匹配测试：provider/extension 版本不一致时，popup/chrome_status 给出明确提示，不静默工作（可选）
- [ ] Windows named pipe 路径不落成 `bridge.sock`；若日志出现 POSIX socket 路径，记录为 bug

### C. 基础浏览器工具

使用 `https://example.com` 和本地 demo（`docs/cursor-demo.html` 可由 DSH 静态服务器打开）：

- [ ] goto / snapshot / find / get_text
- [ ] click / type / press / scroll / select
- [ ] screenshot、pointer、annotate
- [ ] popup → Cursor：切换 Whale/Arrow/Dot/Crosshair 后下一次 pointer 立即生效
- [ ] 上传本地 PNG/JPEG（≤256 KB）→ 光标变成自定义图；选择 preset/Reset 后恢复
- [ ] 上传 >256 KB 或非图片文件被拒绝；远程 URL 不被接受
- [ ] tabs new / list / claim / close
- [ ] 页面刷新/前进后退后工具仍可用
- [ ] 中文页面/右键菜单/下载（公开文件）不崩

### D. Headless / 多 tab / 限额

先用 `chrome_context` 创建 sandbox context：

- [ ] `backend:"headless"` 能启动本机 Chrome/Chromium（若失败记录安装路径/引擎）
- [ ] 同一 context 创建 **4 个 tab**，分别 goto 不同公开页面；`chrome_tabs` 能看到并切换
- [ ] 每个 tab 做 snapshot/screenshot，互不串页
- [ ] 修改 `browser.maxTabs`（例如 5）后创建第 6 个 tab 返回 `RESOURCE_LIMIT`，且 Chrome 里没有多出孤儿页面
- [ ] `browser.maxContexts`（例如 1）下创建第二个 context 返回限额错误，而不是悄悄起第二套 Chrome
- [ ] 关闭 tab 后 `chrome_status` 的 tabs 计数下降；关闭 context 后 Chrome 进程退出
- [ ] 拒绝/失败初始化后再次创建不会留下半个 tab（可连续 create/close 5 轮）

> `maxTabs`/`maxContexts` 可在 DSH 插件设置或配置文件里改；改完重启 provider/context。

### E. 内存诊断

- [ ] `chrome_memory_stats` 返回 node rss/heap、contexts、tabs、captures、pending、chrome 进程数/RSS
- [ ] 创建 4 tab + 做截图后数字上升；关闭 tab/context 后对象计数回落
- [ ] Windows 上 `chrome.rss` 允许为 null（无 `ps`），但不应报错
- [ ] 可选：运行短 soak（如果测试包带 `benchmarks`）：`node benchmarks/soak.mjs --rounds 3 --tabs 2 --captures 2 --screencasts 1 --out .\soak-out`
  - 注意 Windows 需要 Node 24+；不要求外部测试者必须跑

### F. 安全边界（只做公开/假数据）

- [ ] capture 默认 `storeBodies:false`；`chrome_capture_requests` 不返回 body（除非显式开启）
- [ ] 打开一个含 `<input type="password">` 的公开演示页，`chrome_type` 写入前出现硬确认/拒绝；确认框显示完整 URL
- [ ] `chrome_headless_login` 确认卡显示目标 URL/origin，不是通用文案
- [ ] `chrome_verify` navigate 到 `http://127.0.0.1:...` 或内网地址默认被拒绝（除非测试 allowlist）
- [ ] `chrome_pdf` 显式路径写到系统目录/策略文件被拒绝；默认只能写 cache/cwd
- [ ] 两个 DSH 会话：A 的下载/截图不应被 B 直接读取（若可测）
- [ ] 页面脚本无法通过 `window.__dshOverlay` 控制/读取 overlay（可测则记录）

### G. 崩溃 / 关闭 / 清理

- [ ] 任务管理器结束 headless Chrome 进程 → 下次请求返回 `CONTEXT_CRASHED`，`chrome_status` 显示 crashed/deathReason
- [ ] `chrome_context {op:"restart"}` 能重建；crashed 不会被静默自动重启
- [ ] 结束 `dsh-chrome-host.exe` → 扩展显示断开；重启 DSH/Chrome 能恢复
- [ ] 关闭 DSH → host/Chrome 在合理时间退出，任务管理器无残留
- [ ] 关闭 Chrome → DSH 不崩，`chrome_status` 明确断开
- [ ] 连续创建/关闭 10 次 context，任务管理器无累积 Chrome 进程

### H. 更新 / 版本

- [ ] popup 显示 extension/provider 版本均为 0.2.25
- [ ] `chrome_status` 显示 hostVersion/source（若字段存在）
- [ ] 替换为旧扩展或旧 host 时，协议/版本不匹配返回明确错误，不静默降级
- [ ] 自动更新默认关闭；开启检查只提示，不自动覆盖 host（0.2.25 的默认行为）

### I. 附加引擎（可选，不阻断）

- [ ] 安装了 Edge/Brave 时，headless 候选能解析到路径（实际启动可记录结果）
- [ ] 桌面控制仍只连接 Chrome；Edge 桌面连接不要求

## 4.1 0.2.25 定向复测（Windows 报告 P1–P3/P6）

在完成 §4 后重点复跑：

- [ ] **P1 截图**：目标 tab 在折叠 tab 组、窗口失焦、非活动 tab 时，连续截图 10 次全部成功；单次超时后下一次截图能恢复，不需要重载扩展
- [ ] **P1 截图**：截图不应永久切换用户当前 tab（截图后应恢复原 active tab）
- [ ] **P2 history**：example.com → iana.org，`back`/`forward` 各 3 次成功；新 tab 的无 history 返回明确 `NO_HISTORY_ENTRY`
- [ ] **P3 focus**：双 tab 来回 `chrome_tabs focus`，`chrome_tabs list` 的 `*` 跟随；随后 snapshot/screenshot 使用新 active
- [ ] **P6 context**：创建 2 个 context，关闭当前 active 后 `chrome_context current` 自动回退到剩余 context；关闭最后一个返回明确错误
- [ ] **回归**：P4 overlay 页面可读写问题未在本版修复，预期仍存在；P5 auto-reload 抖动未修
- 记录失败时的操作序号/时间/截图/日志；不要用真实密码/账号

## 5. 判定标准

**通过（PASS）**：清单中 A–H 必测项全部通过，且无数据/进程残留。

**部分通过（PARTIAL）**：核心 A–C 通过，D–H 有明确失败但可复现。

**阻断（BLOCKER）**：满足任一即停止并优先反馈：

- 安装后 popup 永远 Not connected，且诊断包显示 manifest/registry/exe 缺失；
- host.exe 崩溃/被杀后 DSH 崩溃；
- 基础工具（goto/snapshot/click）不可用；
- 关闭 context 后 Chrome 进程持续残留/内存持续上涨；
- 密码/OTP 在未确认情况下被自动输入。

## 6. 预期限制（不算 bug）

- Windows 上 Chrome 峰值内存较高（单 headless Chrome 约 1.5–2GB，多 renderer）；
- `chrome_memory_stats` 的 `chrome.rss/processCount` 在 Windows 可能为 null（没有 `ps`）；
- exe 未签名，SmartScreen 可能提示“更多信息 → 仍要运行”；
- 桌面控制只保证 Chrome；Edge/Brave 桌面控制未验证；
- arm64 暂不支持；
- 自动更新只做提示/暂存，不自动替换正在运行的 host；
- strict `npm test` 的视觉探针在低配/高负载机器可能超时，以 `CI=1` 为准。

## 7. 诊断包（失败时请提供）

在 PowerShell 运行：

```powershell
# 1) 基本信息
$env:COMPUTERNAME; [Environment]::OSVersion.VersionString
(Get-Command chrome.exe -ErrorAction SilentlyContinue).Source
Get-Process dsh-chrome-host,chrome -ErrorAction SilentlyContinue | Select-Object Name,Id,Path

# 2) manifest / registry
$manifest = "$env:USERPROFILE\.dsh\cache\dsh-chrome\native-messaging-hosts\com.deepseek.dsh.chrome.json"
Test-Path $manifest
Get-Content $manifest -ErrorAction SilentlyContinue
reg query "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.deepseek.dsh.chrome" /ve

# 3) host 日志（最后 50 行）
Get-Content "$env:USERPROFILE\.dsh\cache\dsh-chrome\host.log" -Tail 50 -ErrorAction SilentlyContinue

# 4) 扩展 ID / provider 版本（从 popup 截图）
```

把以上输出 + popup 截图 + 复现步骤打包为 zip；**不要**包含真实密码、Cookie、Authorization、页面正文。

## 8. 已知平台缺口（请重点观察）

- Windows named pipe 全链路此前未在真机逐项验证；
- SEA exe 被 Chrome `CreateProcess` 拉起 + stdin/stdout EOF 行为；
- HKCU → manifest → exe 全链；
- SmartScreen/杀毒软件/空格路径/非管理员；
- Edge/Brave 桌面/headless 真机；
- arm64 未构建。

## 9. 反馈模板

```text
Windows 版本：
Chrome 版本：
DSH 版本：
插件包/扩展/host 哈希：
测试时间：
通过项：A1 A2 ... 
失败项（编号 + 现象 + 复现步骤 + 截图/日志）：
是否 blocker：
备注：
```

## 10. 安全规则

- 不要登录真实账号、输入真实密码/OTP、付款；
- 不要上传 Chrome Cookie/密码库/个人页面正文；
- 只用公开页面和本地 demo；
- 发现疑似安全问题时停止测试，保留日志并联系管理员。
