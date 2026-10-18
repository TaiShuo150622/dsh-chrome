# Windows native host：单文件 `dsh-chrome-host.exe`（Node SEA）

> 2026-10-18 · 分支 `feat/windows-host`
> 状态：构建/安装路径已落地；SEA 机制已在 macOS 上用 `--allow-foreign` 做过同机制冒烟
> （构建出的二进制能启动内嵌 host 并正常 EOF 退出）；**Windows 真机仍未验证**（清单见 [§8](#8-windows-真机验证清单)）。

## 0. 一句话

Windows 上 Chrome/Edge/Brave 只接受 native messaging manifest 的 `path` 指向真正的 `.exe`
（`CreateProcess` 不能直接执行 `.cmd`）。本方案用 **Node SEA（single executable application）**
把 Node runtime 和 `host/host.mjs` 打进单文件 `dsh-chrome-host.exe`，由 CI 在 `windows-latest`
构建；`src/install.js` 找到这个 exe 后让 manifest 直接指向它，找不到时才退回旧的 `.cmd`
脚手架并明确告警——`.cmd` 只用于源码检出，不承诺能连上 Chrome。

## 1. 为什么选 Node SEA

| 方案 | 结论 | 原因 |
|---|---|---|
| **Node SEA（本方案）** | ✅ 采用 | 一个自包含 `.exe`：内嵌 Node + `host.mjs`，用户不用装 Node；与 macOS/Linux 共用同一份 host 源码；Node 官方工具链（`--experimental-sea-config` + postject）可在 GitHub Actions 复现；没有 install-time 编译或第三方运行时 |
| Electron / DSH app 二进制 | ❌ | Chrome 启动 manifest `path` 时不会设 `ELECTRON_RUN_AS_NODE=1`，也不会把 `host.mjs` 作为参数传进去；把 DSH app 变成 native host 需要改 app 主程序并新增 `--native-host` 模式，且主 app 的 Electron 环境（fuses、单实例锁）会干扰 |
| `node.exe` + 小 `.exe` wrapper | ❌ | 要随包发两个以上文件（node.exe、wrapper、host.mjs），wrapper 仍需 C/Rust/MSVC 构建链，且要自己解析相对路径；与 SEA 的单文件部署相比没有收益 |
| `.cmd` launcher | ❌（仅 dev fallback） | Chrome 的 native messaging host 通过 `CreateProcess` 启动；`.cmd` 不是可执行映像，通常直接失败。保留它只是为了让源码检出在没构建 exe 时仍能写出 manifest |
| 安装期生成 exe | ❌ | 用户机器上需要 Node + postject + 构建工具，失败面大、不可审计；发布物应在 CI 预构建 |

SEA 的硬约束与我们的处理：

- **SEA 注入的 main 必须是 CommonJS**（Node 22/24 文档明确写 “only supports … CommonJS”）。
  `host/host.mjs` 是 ESM（`import fs from 'node:fs'` 等），不能直接当 main。
- 处理方式：main 是一个极小的 CJS bootstrap（构建时生成 `sea-entry.cjs`），它从 SEA
  **asset** 里读出 `host.mjs` 源码，再用 `data:text/javascript;base64,...` 动态 `import()`
  把它当 ESM 执行。**不需要改写 host.mjs，也不需要 esbuild/bundler。**
- `useCodeCache` 必须为 `false`：Node 文档说明 `import()` 与 code cache 不兼容。
- 目前 SEA 里只放一个 asset：`host.mjs`。`host/host.mjs` 只 import `node:*` 内置模块，
  没有本地依赖；如果将来它开始 import 兄弟文件或读资源，需要把那些文件也加进
  `assets` 并用 `sea.getAsset()` 取，或者在构建期改用 bundler（届时同步改
  `scripts/build-windows-host.mjs` 与本文）。
- SEA 的启动开销、`node:` 内置模块、`process.env.DSH_HOME`、`os.homedir()` 等行为与普通
  node 进程一致；host 侧代码不需要知道自己在 SEA 里。

## 2. 构建产物与流水线

```text
host/host.mjs ──────────────┐
                            ├─ sea-entry.cjs      （CJS bootstrap，构建期生成）
                            ├─ sea-config.json    （main=entry，assets.host.mjs，useCodeCache:false）
                            └─ node --experimental-sea-config → sea-prep.blob
node.exe ── copy ──→ dsh-chrome-host.exe ── postject NODE_SEA_BLOB ──→ fuse :1
                                                    │
                                                    └─ smoke：stdin EOF 启动/退出
```

产物路径（也是 `src/install.js` 的首选搜索路径）：

```text
host/bin/win32-x64/dsh-chrome-host.exe
```

`package.json` 的 `files` 已包含整个 `host/` 树，所以发布时把 CI artifact 放到
`host/bin/win32-<arch>/`，`npm pack` 就会带上它。**本次改动没有改 `package.json`**；
发布/打包脚本需要在 `npm pack` 前完成这一步（CI 产物名与路径见
[`.github/workflows/windows-host.yml`](../.github/workflows/windows-host.yml)）。

> **不要把 `host/bin/` 里的 exe 提交进 git**：本轮只允许改/新增本文列出的文件，没有动
> `.gitignore`，所以 `host/bin/` 目前不在忽略列表里。发布物应来自 CI artifact；
> 本地验证请用 `--out dist/windows-host/...`（`dist/` 已忽略）或 `/tmp`。

## 3. 构建

### 3.1 GitHub Actions（推荐）

[`windows-host.yml`](../.github/workflows/windows-host.yml) 在 `windows-latest` 上：

1. `node --check` host / 构建脚本 / 测试；
2. `node test/platform-windows-host.mjs`（静态断言，不需要真机）；
3. `npm install --no-save --no-package-lock postject@1.0.0-alpha.6`；
4. `node scripts/build-windows-host.mjs --arch x64`；
5. `cmd /c "host\bin\win32-x64\dsh-chrome-host.exe < NUL"` 冒烟，并断言 `host.log`
   里有 `host started` 与 `stdin ended`；
6. 跑 `node test/platform-windows-host.mjs --require-built`：在 Windows 真文件系统上调用
   `ensureInstallAssets()`，断言 manifest 的 `path` 指向 exe，再启动安装后的 exe；
7. 生成 SHA-256，上传 `dsh-chrome-host-windows-x64` artifact（exe + `.sha256`）。

触发：`workflow_dispatch`、`main` 分支 push、PR（限定 `host/`、构建脚本、`src/install.js`、
`src/platform.js`、测试、本文和 workflow 自身）。发布时从 Actions 下载 artifact，
解压到 `host/bin/win32-x64/` 后再打包。

### 3.2 Windows 本地构建

```bat
npm install --no-save --no-package-lock postject@1.0.0-alpha.6
node scripts/build-windows-host.mjs --arch x64
```

默认：用当前 `node.exe` 做 SEA 基座、内嵌 `host/host.mjs`、输出
`host/bin/win32-x64/dsh-chrome-host.exe`，构建后用临时 `DSH_HOME` 以 stdin EOF 方式
启动一次做冒烟。

参数：

| 参数 | 默认 | 说明 |
|---|---|---|
| `--out <file>` | `host/bin/win32-<arch>/dsh-chrome-host.exe` | 输出 exe；相对路径按当前目录解析 |
| `--node <file>` | 当前 `process.execPath` | SEA 基座，必须是 **win32 PE** 的 `node.exe`，且版本就是运行时版本 |
| `--host <file>` | `host/host.mjs` | 要内嵌的 host 源码 |
| `--workdir <dir>` | 系统临时目录 | 放 `sea-entry.cjs` / `sea-config.json` / blob；成功后删除 |
| `--postject <file>` | `node_modules/postject/dist/cli.js` | postject CLI；没装时给出安装命令并退出 |
| `--arch <arch>` | 当前 `process.arch` | 只影响默认输出目录（CI 固定 `x64`） |
| `--dry-run` | 关 | 只校验并打印计划，不写文件、不跑注入（任何平台可跑） |
| `--allow-foreign` | 关 | 允许在非 Windows 上用**当前平台**的 node 构建 SEA 做机制冒烟；产物不可发布 |
| `--no-smoke` | 关 | 跳过启动冒烟 |
| `--keep-workdir` | 关 | 保留 scratch 目录，排障用 |
| `--json` | 关 | 输出单个 JSON（`--dry-run` 时最适合） |
| `--verbose` | 关 | 让子进程输出可见 |

退出码：`0` 成功/已打印计划；`1` 构建或冒烟失败；`2` 参数/平台错误。

冒烟验证的是“SEA 里的 bootstrap 能取到 asset 并启动 host.mjs”，**不是** Chrome native
messaging 端到端；后者必须在 Windows 真机做（§8）。

### 3.3 在 macOS / Linux 上做静态验证

```bash
node --check host/host.mjs
node --check scripts/build-windows-host.mjs
node scripts/build-windows-host.mjs --dry-run          # 打印 SEA config 与注入命令
node scripts/build-windows-host.mjs --dry-run --json   # 机器可读
node test/platform-windows-host.mjs                    # 全部静态断言
```

直接跑真实构建（不带 `--dry-run` / `--allow-foreign`）会以退出码 2 拒绝，并提示去
Windows 或使用 `--dry-run`。`--allow-foreign` 只用于本机验证 SEA 机制：

```bash
node scripts/build-windows-host.mjs \
  --allow-foreign --out /tmp/dsh-host/host.exe \
  --postject node_modules/postject/dist/cli.js
```

macOS 上脚本会在注入前 `codesign --remove-signature`、注入后 `codesign --sign -`，
否则内核会杀掉改过签名的二进制；这段只在 `format === 'macho'` 时执行，Windows 目标
构建完全不走它。**该产物是当前平台的二进制，只是名字叫 host.exe，不能发布。**

本分支已在 macOS 上用 Node 22.23.3 与 24.6.0 两种基座各跑通一次 `--allow-foreign`
完整构建：postject 注入成功、`host.log` 出现 `host started`、stdin EOF 后退出码 0。
这只证明 SEA bootstrap + asset + host 启动链路成立，**不证明 Windows PE 注入和
Chrome native messaging**（后者见 §8）。

## 4. manifest 如何指向 host.exe

### 4.1 install 写什么

`ensureInstallAssets()` 在 Windows 上：

1. 按顺序找可用的 host.exe（见 4.3）；
2. 找到：复制到 `%USERPROFILE%\.dsh\cache\dsh-chrome\host\dsh-chrome-host.exe`，
   manifest 的 `path` 指向它，不再写 `.cmd`，也不再复制 `host.mjs`（已内嵌）；
3. 没找到：沿用旧的 `.cmd` 脚手架 + `host.mjs`，并打 warn（Chrome 通常起不来，
   仅供源码检出）。

**运行中的 exe 不能被覆盖**：Windows 会在 native host 进程存活期间锁住 exe 映像。
install 每次启动会尝试把包里的 exe 复制到缓存目录；如果目标正被运行中的 host 占用
（`EPERM/EBUSY`），则保留已安装的 exe 并 warn，等浏览器完全退出、host 进程结束后的
下一次 DSH 启动再更新。失败的复制在打开目标时就被拒绝，不会截断旧 exe，所以
provider 重载不会因为锁文件而失败。

manifest 位置（`DSH_HOME` 可覆盖）：

```text
%USERPROFILE%\.dsh\cache\dsh-chrome\native-messaging-hosts\com.deepseek.dsh.chrome.json
```

内容示例（扩展 ID 由 `extension/manifest.json` 的 `key` 推导，当前为
`mejmgfhpgklcmphgimfbfohaodmjfmok`）：

```json
{
  "name": "com.deepseek.dsh.chrome",
  "description": "DSH Desktop Chrome native host",
  "path": "C:\\Users\\Alice\\.dsh\\cache\\dsh-chrome\\host\\dsh-chrome-host.exe",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://mejmgfhpgklcmphgimfbfohaodmjfmok/"]
}
```

注意：

- 注册表的值指向 **manifest JSON**，不是 exe；manifest 里的 `path` 才指向 exe。
- `path` 必须是绝对路径；JSON 里反斜杠要转义（install.js 用 `JSON.stringify` 写）。
- manifest 目录是 DSH 自管的，位置随意；浏览器通过注册表找到它。

### 4.2 Windows 上没有 NativeMessagingHosts 目录

Chrome/Edge/Brave/Chromium 在 Windows 上不读固定目录，而是读当前用户的注册表键
（见 §5）。`src/platform.js` 里每个浏览器的 `win.registryKey` 就是这张表；写注册表
这一步 **provider 不会自动执行**，只打印命令到 `INSTALL.md` 和日志。

### 4.3 host.exe 搜索顺序（`windowsHostExeCandidates`）

1. 环境变量 `DSH_CHROME_HOST_EXE`（显式覆盖，便携版/自定义发布目录用）；
2. `host/bin/win32-<arch>/dsh-chrome-host.exe`（发布布局，构建脚本默认输出）；
3. `dist/windows-host/win32-<arch>/dsh-chrome-host.exe`（可选本地目录，用
   `--out dist/windows-host/win32-<arch>/dsh-chrome-host.exe` 构建；`dist/` 已 gitignore）；
4. `host/host.exe`（临时拷入，bring-up 用）。

第 2 条与 `scripts/build-windows-host.mjs` 的默认输出路径是同一个契约；
`test/platform-windows-host.mjs` 会断言两者一致，防止改了一边忘了另一边。

## 5. registry 注册

当前用户（HKCU），**不需要管理员**。Chrome 示例（`cmd.exe`）：

```bat
reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.deepseek.dsh.chrome" /ve /d "%USERPROFILE%\.dsh\cache\dsh-chrome\native-messaging-hosts\com.deepseek.dsh.chrome.json" /f
reg query "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.deepseek.dsh.chrome" /ve
```

PowerShell 等价：

```powershell
$key = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.deepseek.dsh.chrome'
New-Item -Path $key -Force | Out-Null
Set-ItemProperty -Path $key -Name '(default)' -Value "$env:USERPROFILE\.dsh\cache\dsh-chrome\native-messaging-hosts\com.deepseek.dsh.chrome.json"
Get-ItemProperty -Path $key
```

各浏览器的键（其余部分相同）：

| 浏览器 | 注册表键（值仍是同一份 manifest 路径） |
|---|---|
| Chrome | `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.deepseek.dsh.chrome` |
| Edge | `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.deepseek.dsh.chrome` |
| Brave | `HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.deepseek.dsh.chrome` |
| Chromium | `HKCU\Software\Chromium\NativeMessagingHosts\com.deepseek.dsh.chrome` |

写完注册表后 **完全退出浏览器再打开**（Windows 上注册表与 manifest 只在启动时解析；
关窗口不算退出，检查任务管理器里没有 `chrome.exe`）。

## 6. 卸载

```bat
reg delete "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.deepseek.dsh.chrome" /f
```

Edge/Brave/Chromium 换成 §5 表里对应的键。然后删除本机数据目录（会一并删掉
`host.exe`、manifest、`INSTALL.md`、日志与缓存）：

```bat
rmdir /s /q "%USERPROFILE%\.dsh\cache\dsh-chrome"
```

最后在 `chrome://extensions`（Edge：`edge://extensions`）里移除 DSH 扩展。
若设过 `DSH_CHROME_HOST_EXE` 或把 exe 放在自定义目录，也要一并清理。

## 7. 失败模式与已知限制

- **未签名**：Node 官方 `node.exe` 带 Authenticode 签名，postject 注入后签名失效；
  本流程不重新签名（Windows SDK 的 `signtool` 不是必需依赖）。下载来的未签名 exe
  可能触发 SmartScreen/杀软拦截；公开发布应自行签名并在发行说明里给 SHA-256。
- **再分发许可**：host.exe 内嵌 Node runtime，随包分发时要遵守 Node.js 的 LICENSE
  及其第三方声明。仓库的 `LICENSE` / `NOTICE.md` 已随 npm 包发布；单独分发 GitHub
  Release 的 exe 时也应把 `LICENSE`、`NOTICE.md` 和 Node 版本号一起放进去。
- **Node 版本绑定**：exe 内嵌构建时的 Node；升级 Node（尤其安全修复）后必须重建、
  重发 artifact。构建脚本用 `--node` 指向的 binary 生成 blob，blob 与基座天然同版本；
  不要在别的 Node 版本上生成 blob 再注入。
- **SEA main 只能是 CJS**：`host.mjs` 继续是 ESM，由 bootstrap 以 data: URL 动态 import。
  如果 host.mjs 以后用 `import.meta.url`/`__dirname` 做资源定位，data: URL 会让它拿不到
  文件路径——要么继续只用 `node:` 内置模块和 `process.env`/`os.homedir()`，要么改成
  构建期 bundle。堆栈信息里 host 模块会显示为 `data:` URL，属于可接受代价。
- **`useCodeCache` 必须 false**：打开会让动态 `import()` 失效；构建脚本在
  `sea-config.json` 里固定写 false，`test/platform-windows-host.mjs` 也断言了。
- **体积**：单个 exe 约 65–110 MiB（随 Node 版本与官方二进制大小）；每个架构一份。CI 目前只构建
  `x64`（`windows-latest` 是 x64）；arm64 需要独立构建/runner，输出目录名用
  `win32-arm64` 即可，但未验证。
- **未真机验证**：注册表路径的可见性、Chrome 实际 `CreateProcess` 拉起 exe、
  exe 在用户 profile 下的权限、杀软行为、manifest 引号/空格路径都还没在 Windows
  上跑过；CI 只证明了“exe 能启动内嵌 host 并 EOF 退出”。
- **Chrome 启动行为**：node.exe 是 console 子系统，Chrome 通常以无窗口方式启动
  native host，但未真机确认不会闪控制台窗口，也未确认 stdin/stdout 句柄与缓冲在
  浏览器生命周期下的表现。
- **`.cmd` fallback 不等于可用**：没构建 exe 的源码检出仍会写 `.cmd` 并告警；
  这条路径预期 Chrome 连不上，只用于开发时看 manifest 结构。
- **浏览器只在启动时读取**：改 manifest / 注册表后必须完全退出再开，否则看到的是
  旧状态。
- **exe 更新可能延后**：正在运行的 host 锁住 exe 时 install 会保留旧版本并 warn；
  要立刻用上新构建，先完全退出浏览器（host 随之退出），再重启 DSH。
- **安全边界**：manifest 的 `allowed_origins` 固定到仓库里的扩展 ID；注册表写在
  HKCU，不需要管理员。exe 位于用户 profile，用户可写——和用户账户同信任级。
  对外分发请签名并考虑安装到受控目录。
- **host 协议不变**：native messaging 的 4-byte 长度前缀、32 MiB 帧上限、bridge
  socket/token 逻辑都沿用 `host/host.mjs`，Windows 没有单独实现。

## 8. Windows 真机验证清单

> 目标：证明“注册表 → manifest → host.exe → bridge → 扩展”整条链在真实 Windows 上通。

准备：Windows 10/11 x64、Chrome 116+、一份 exe artifact（或本地按 §3.2 构建）。
下载 artifact 后先核对 SHA-256（Windows 自带工具，不需要额外安装）：

```bat
certutil -hashfile dsh-chrome-host.exe SHA256
```

与 artifact 里的 `dsh-chrome-host.exe.sha256` 比对，不一致就不要继续。

1. **CLI 冒烟**（不涉及 Chrome）：

   ```bat
   cmd /c "host\bin\win32-x64\dsh-chrome-host.exe < NUL"
   type "%USERPROFILE%\.dsh\cache\dsh-chrome\host.log"
   ```

   预期：退出码 0，`host.log` 有 `host started`、`stdin ended`。若这里失败，
   先解决 exe/杀软/权限，不要往下走。

2. 把 exe 放到 `host\bin\win32-x64\`（或设 `DSH_CHROME_HOST_EXE` 指向它），启用
   provider / 触发 `ensureInstallAssets()`，确认返回的 `launcherKind === 'exe'`，
   并打开 manifest JSON 核对 `path` 以 `dsh-chrome-host.exe` 结尾、文件存在。

3. 按 §5 写注册表，`reg query ... /ve` 确认默认值就是 manifest 的绝对路径。

4. **完全退出** Chrome（任务管理器无 `chrome.exe`）再启动。

5. `chrome://extensions` → 开发者模式 → 加载 `extension/`；核对扩展 ID 与
   manifest `allowed_origins` 一致；点工具栏 DSH 图标，应显示 Connected。

6. 看 `%USERPROFILE%\.dsh\cache\dsh-chrome\host.log`：应有
   `host started`、`connected to bridge ...`；Chrome 侧在 `chrome://extensions`
   的 service worker / 错误页里看 native messaging 报错。

7. 回 DSH 调一个真实工具（如 `chrome_status`、`chrome_navigate`），确认扩展 ↔
   host ↔ provider 往返成功，而不只是“进程起来了”。

8. **负向验证**：临时 `reg delete`（或重命名 exe）→ 重启浏览器 → 扩展应断开；
   恢复后应重新连通。这能证明浏览器真的走了 registry/manifest 这条路径。

9. 重复 §5 的键，对 Edge / Brave / Chromium 至少各验一次（如果承诺支持）。

10. 记录：Windows 版本、浏览器版本、exe SHA-256、注册表导出、`host.log` 关键行、
    失败截图。未跑过的项在发布说明里继续标“未验证”。

## 9. 参考

- Node.js — Single executable applications：
  <https://nodejs.org/docs/latest-v22.x/api/single-executable-applications.html>
  （CJS main、assets、`sea.getAsset`、`useCodeCache` 与 `import()` 的互斥、postject 命令）
- postject：<https://github.com/nodejs/postject>
- Chrome native messaging：
  <https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging>
- 平台路径表与安装（macOS/Linux 行为）：[`src/platform.js`](../src/platform.js)、
  [`docs/INSTALL-PLATFORM.md`](INSTALL-PLATFORM.md)
- 构建脚本：[`scripts/build-windows-host.mjs`](../scripts/build-windows-host.mjs)
- CI：[`.github/workflows/windows-host.yml`](../.github/workflows/windows-host.yml)
- 测试：[`test/platform-windows-host.mjs`](../test/platform-windows-host.mjs)
