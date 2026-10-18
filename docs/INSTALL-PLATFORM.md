# 平台安装（Windows / Linux / Edge / Brave）

> 2026-10-17 · 对应 `feat/platform-scaffold`（`src/platform.js` + `src/install.js` 重构）
> 状态：**macOS Chrome 行为不变**（路径逐字节同重构前）；Linux / Windows / Edge / Brave 是
> 「路径表 + manifest 写入」的脚手架，**均未在真机验证**。真机验证清单见 [§5](#5-当前限制未验证).

## 0. 一句话

provider 启动时调用 `ensureInstallAssets()`，按 [`src/platform.js`](../src/platform.js) 的路径表写
launcher 和 native messaging manifest：

- **macOS / Linux**：manifest 直接写进对应浏览器的 `NativeMessagingHosts/` 目录，浏览器启动时读取；
- **Windows**：写进 DSH 自己的 manifest 目录，并**打印**注册表命令——本仓库**不会自动改注册表**，
  这一步需要人执行（见 [§3.3](#33-windows)）。

浏览器/平台差异只允许出现在路径表里；`src/install.js` 只负责写文件，`src/tools.js` 不知道平台细节。

## 1. 路径表

代码：[`src/platform.js`](../src/platform.js)

- `BROWSERS`：`chrome / edge / brave / chromium` × `mac / linux / win` 的声明式表；
- `getPlatform(id = process.platform)`：把 `darwin/linux/win32`（及 `mac/windows/osx` 别名）归一成 `mac/linux/win`，
  未知值抛错；
- `browserPaths(browser = 'chrome', platform = process.platform, options?)`：解析出
  `userDataDir`、`nativeMessagingHostsDir`、`executableCandidates`、`registryKey`、`nativeMessagingMode`。

表里的字符串支持三种模板，由 `browserPaths()` 展开：

| 语法 | 含义 |
|---|---|
| 行首 `~` | 用户 home 目录 |
| `{dshHome}` | DSH 数据目录，默认 `~/.dsh`（尊重 `DSH_HOME`） |
| `%VAR%` | Windows 环境变量（`LOCALAPPDATA` / `PROGRAMFILES` / `PROGRAMFILES(X86)` / `USERPROFILE`） |

`options` 是测试/诊断注入点：`home`、`dshHome`、`env` 可替换 `os.homedir()` / `~/.dsh` / `process.env`。

### 1.1 macOS

| 浏览器 | userDataDir | NativeMessagingHosts | 可执行候选 |
|---|---|---|---|
| Chrome | `~/Library/Application Support/Google/Chrome` | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts` | `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` |
| Edge | `~/Library/Application Support/Microsoft Edge` | `~/Library/Application Support/Microsoft Edge/NativeMessagingHosts` | `/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge` |
| Brave | `~/Library/Application Support/BraveSoftware/Brave-Browser` | 同左 + `/NativeMessagingHosts` | `/Applications/Brave Browser.app/Contents/MacOS/Brave Browser` |
| Chromium | `~/Library/Application Support/Chromium` | 同左 + `/NativeMessagingHosts` | `/Applications/Chromium.app/Contents/MacOS/Chromium` |

> Chrome 一行与重构前 `src/install.js` 里硬编码的路径完全一致（回归测试逐字比对）。

### 1.2 Linux

| 浏览器 | userDataDir | NativeMessagingHosts | 可执行候选（PATH 名 + 绝对路径兜底） |
|---|---|---|---|
| Chrome | `~/.config/google-chrome` | `~/.config/google-chrome/NativeMessagingHosts` | `google-chrome`、`google-chrome-stable`、`/usr/bin/...`、`/opt/google/chrome/chrome` |
| Edge | `~/.config/microsoft-edge` | `~/.config/microsoft-edge/NativeMessagingHosts` | `microsoft-edge`、`microsoft-edge-stable`、`/usr/bin/...` |
| Brave | `~/.config/BraveSoftware/Brave-Browser` | 同左 + `/NativeMessagingHosts` | `brave-browser`、`brave`、`/opt/brave.com/brave/brave` |
| Chromium | `~/.config/chromium` | `~/.config/chromium/NativeMessagingHosts` | `chromium`、`chromium-browser`、`/usr/bin/...` |

### 1.3 Windows

Windows 上没有通用的 `NativeMessagingHosts/` 目录约定（浏览器只认注册表，见 [§3.3](#33-windows)），
所以表里同时存两样东西：`nativeMessagingHostsDir`（DSH 自管的 manifest 存放目录，任意位置即可）
和 `registryKey`。

| 浏览器 | userDataDir | manifest 目录（DSH 自管） | 注册表键（HKCU，无需管理员） |
|---|---|---|---|
| Chrome | `%LOCALAPPDATA%\Google\Chrome\User Data` | `{dshHome}\cache\dsh-chrome\native-messaging-hosts` | `HKCU\Software\Google\Chrome\NativeMessagingHosts` |
| Edge | `%LOCALAPPDATA%\Microsoft\Edge\User Data` | 同上（共用一份 manifest） | `HKCU\Software\Microsoft\Edge\NativeMessagingHosts` |
| Brave | `%LOCALAPPDATA%\BraveSoftware\Brave-Browser\User Data` | 同上 | `HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts` |
| Chromium | `%LOCALAPPDATA%\Chromium\User Data` | 同上 | `HKCU\Software\Chromium\NativeMessagingHosts` |

可执行候选覆盖 `%PROGRAMFILES%`、`%PROGRAMFILES(X86)%`、`%LOCALAPPDATA%` 三种安装位置：

- Chrome：`...\Google\Chrome\Application\chrome.exe`
- Edge：`...\Microsoft\Edge\Application\msedge.exe`（Edge 常见于 `Program Files (x86)`）
- Brave：`...\BraveSoftware\Brave-Browser\Application\brave.exe`
- Chromium：`...\Chromium\Application\chrome.exe`

> `executableCandidates` 目前只由路径表/测试使用：本轮 install 还不启动浏览器，
> 它是下一轮「选择浏览器 / `chrome_browsers` 枚举」的输入。

## 2. 扩展侧（所有 Chromium 系浏览器相同）

extension/ 是标准 MV3，Chrome / Edge / Brave / Chromium 共用；manifest 的 `key` 固定扩展 ID，
native host manifest 的 `allowed_origins` 是 `chrome-extension://<id>/`——Edge/Brave 的 native messaging
也用 `chrome-extension://` scheme，不需要改扩展。各浏览器的扩展管理页：

| 浏览器 | 扩展页 |
|---|---|
| Chrome / Chromium | `chrome://extensions` |
| Edge | `edge://extensions` |
| Brave | `brave://extensions` |

## 3. 安装流程

### 3.1 macOS（与重构前相同）

1. 启用 provider bundle，自动写入：
   - launcher + host：`~/.dsh/cache/dsh-chrome/host/`
   - manifest：`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.deepseek.dsh.chrome.json`
   - 安装说明：`~/.dsh/cache/dsh-chrome/INSTALL.md`
2. 打开 `chrome://extensions` → 开发者模式 → 「加载已解压的扩展程序」选择 `extension/`；
3. **完全退出 Chrome（⌘Q）再打开**；
4. 点工具栏图标确认 Connected。

日常流程仍以 [INSTALL.md](INSTALL.md) 为准。

### 3.2 Linux

1. 启用 provider bundle（自动写入 manifest，路径见 [§1.2](#12-linux)）：
   `~/.config/google-chrome/NativeMessagingHosts/com.deepseek.dsh.chrome.json`
   （Edge/Brave/Chromium 各写各的目录，见上表）；
2. 打开对应扩展页 → 开发者模式 → 加载 `extension/`；
3. **完全退出浏览器再打开**（Linux 也只在启动时读取 NativeMessagingHosts manifest）；
4. 点图标确认 Connected；不通时先看 `~/.dsh/cache/dsh-chrome/host.log`。

未接入 provider config 前，provider 默认只装 `chrome`；要装 Edge/Brave 用下一节的开关。

### 3.3 Windows

1. 启用 provider bundle，自动写入 manifest 到
   `%USERPROFILE%\.dsh\cache\dsh-chrome\native-messaging-hosts\com.deepseek.dsh.chrome.json`
   （`DSH_HOME` 可覆盖目录），**不自动写注册表**；
2. 注册 native host（当前用户，无需管理员），manifest 路径按实际输出替换：

   ```bat
   reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.deepseek.dsh.chrome" /ve /d "%USERPROFILE%\.dsh\cache\dsh-chrome\native-messaging-hosts\com.deepseek.dsh.chrome.json" /f
   ```

   Edge / Brave / Chromium 把中间的注册表键换成 [§1.3](#13-windows) 表里对应的键。
   PowerShell 里同样可以 `cmd /c` 执行上面的命令，或：

   ```powershell
   $key = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.deepseek.dsh.chrome'
   New-Item -Path $key -Force | Out-Null
   Set-ItemProperty -Path $key -Name '(default)' -Value "$env:USERPROFILE\.dsh\cache\dsh-chrome\native-messaging-hosts\com.deepseek.dsh.chrome.json"
   ```

3. 校验注册表默认值确实指向 manifest：

   ```bat
   reg query "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.deepseek.dsh.chrome" /ve
   ```

4. 打开 `chrome://extensions`（Edge：`edge://extensions`，Brave：`brave://extensions`）→
   开发者模式 → 加载 `extension/`；
5. **完全退出浏览器再打开**；
6. 点图标确认 Connected。

卸载（按需）：

```bat
reg delete "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.deepseek.dsh.chrome" /f
```

**已知限制（Windows 关键风险）**：当前 manifest 的 `path` 指向自动生成的
`dsh-chrome-host.cmd` 脚手架。Chrome 在 Windows 上通常要求 native host `path` 是真正的 `.exe`
（CreateProcess 不能直接执行 `.cmd`），所以**这条线大概率还起不来**，需要在正式支持前替换为：

- 一个极小的 `.exe` wrapper（把参数转给 `host.mjs`），或
- 让 DSH 的 Electron 二进制支持 `--native-host` 模式（Electron 可执行文件直接作为 `path`），或
- 安装期生成一个真正的 launcher exe。

在此之前，Windows 只承诺「manifest 已写 + 注册命令已打印」，不承诺连通。

## 4. 本轮怎么选浏览器 / 平台

`ensureInstallAssets()` 的默认值：

- `platform`：`process.platform`（自动归一成 `mac/linux/win`）；
- `browser`：`process.env.DSH_CHROME_BROWSER || 'chrome'`。

所以 Linux 上默认装 Chrome；要临时装 Edge/Brave（或做真机验证）：

```bash
DSH_CHROME_BROWSER=edge node -e "import('./src/install.js').then(m => m.ensureInstallAssets({ root: process.cwd() }))"
```

或在测试/未来 config 代码里传选项：

```js
await ensureInstallAssets({ root, platform: 'linux', browser: 'brave' })
```

可注入项（主要为测试）：`platform`、`browser`、`home`、`dshHome`、`env`、`fs`。
传了 `home` 而未传 `dshHome` 时，DSH 数据目录会落在 `<home>/.dsh`，测试不会碰真实 `~/.dsh`。
**provider 配置/UI 里选择浏览器还没接**（见 [§6](#6-后续)），本轮不新增设置项。

## 5. 当前限制（未验证）

- **Windows 未真机验证**：注册表命令、`.cmd` launcher 能否被 Chrome 作为 native host 拉起（大概率不行，
  见 §3.3）、杀软/权限行为；
- **Linux 未真机验证**：`google-chrome` 实际读取 `~/.config/google-chrome/NativeMessagingHosts/` 并拉起
  POSIX launcher 的端到端链路（路径按官方文档，未跑过真实 Chrome）；
- **Edge / Brave 未真机验证**：manifest 目录与注册表键按各自官方文档填写，native messaging 实际连通未测；
- **多 profile / 自定义 `--user-data-dir`**：Chrome for Testing 等场景要求 manifest 放进该 profile 的
  `NativeMessagingHosts/`，本轮未处理（见 [skill-backlog.md](skill-backlog.md) 对应条目）；
- **host.mjs / bridge 在 Windows 上的路径与行为**：只验证了安装侧写文件，没验证 host 实际跑起来；
- **商店分发 / 签名 / 多浏览器打包**：未开始（见 [ARCHITECTURE-PLATFORM.md](ARCHITECTURE-PLATFORM.md) §2）；
- **Firefox**：不在本表范围，`BROWSERS` 里没有 firefox，需要单独评估（同为 Chromium 的只有前四个）。

## 6. 后续

1. 把 `browser` / `platform` 选择接进 provider config（`~/.dsh/cache/dsh-chrome/config.json`）与
   `chrome_browsers` 类工具；
2. Windows 真机：先验 `reg add` 链路，再解决 `.exe` launcher；
3. Linux 真机：Chrome → Edge/Brave 逐个验 native messaging；
4. CI 矩阵（ubuntu / windows）跑 `node test/install-platform.mjs`；
5. 卸载 helper（删 manifest + `reg delete` / `~/.config` 目录）与 `npm run status` 的平台化。

## 7. 自检

```bash
node test/install-platform.mjs   # 路径表 + install 资产（无需 Chrome）
node test/extension-manifest.mjs # 结构约束：HOST_NAME 等在 install.js/extension 里一致
```

`test/install-platform.mjs` 覆盖：`BROWSERS` 表结构（4 浏览器 × 3 平台）、`getPlatform` 归一与未知值报错、
mac/linux/win 路径展开（含 `%VAR%` 与 `~`）、未知浏览器报错、`ensureInstallAssets` 在 macOS 下仍写原路径
（临时 home）、Linux Chrome/Edge/Brave 各写自己的目录、Windows 写 manifest + 返回注册命令但不改注册表
（内存 fs，不落盘）。
