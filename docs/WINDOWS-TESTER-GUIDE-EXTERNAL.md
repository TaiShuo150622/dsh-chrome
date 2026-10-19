# Windows 预览版测试说明（0.1.93）

感谢帮忙测试！这是 DSH Desktop Chrome 插件的 **Windows 预览版**，主要验证 Windows 上 Chrome 能否正常拉起 native host，以及基础浏览器工具是否可用。

## 1. 获取测试包

- 仓库：<https://github.com/TaiShuo150622/dsh-chrome>
- 预览 Release：<https://github.com/TaiShuo150622/dsh-chrome/releases/tag/v0.1.93-win-preview.1>

如果打不开 GitHub（私有仓库需要权限），请让管理员把下面文件直接发给你：

| 文件 | 用途 |
|---|---|
| `dsh-desktop-chrome-0.1.93.tgz` | DSH 插件包（内含 Windows host.exe） |
| `dsh-chrome-extension-0.1.93.zip` | Chrome 扩展 |
| `WINDOWS-TESTER-GUIDE-EXTERNAL.md` | 本文 |

> 不需要安装 Node；host.exe 自带运行环境。

## 2. 前置条件

- Windows 10/11 x64
- Chrome 或 Edge 稳定版（Chrome 最低 116）
- **DSH Harness 已安装并运行**（这是插件的宿主；没有 DSH 无法工作）
- 建议先退出所有 Chrome 窗口

## 3. 安装

### 3.1 安装 DSH 插件（如果 DSH 里还没有）

1. 把 `dsh-desktop-chrome-0.1.93.tgz` 解压或交给 DSH 的插件安装入口。
2. 确认插件目录里存在：
   ```text
   host\bin\win32-x64\dsh-chrome-host.exe
   ```
3. 在 DSH 的插件/Provider 设置里启用 `dsh-desktop-chrome`。
4. 启动/重启 DSH。

> 如果 DSH 已经有 dsh-chrome 插件：把 tgz 解压后覆盖到现有插件目录即可，重点确认 `host\bin\win32-x64\dsh-chrome-host.exe` 存在。
> 如果 DSH 不认这个包，把 DSH 版本和报错发给管理员，不要自己改注册表。

### 3.2 安装 Chrome 扩展

1. 解压 `dsh-chrome-extension-0.1.93.zip`。
2. Chrome 打开 `chrome://extensions`。
3. 右上角打开 **Developer mode / 开发者模式**。
4. 点 **Load unpacked / 加载已解压的扩展程序**，选择解压出来的 `dsh-chrome-extension` 目录。
5. 记下扩展 ID，应为：
   ```text
   mejmgfhpgklcmphgimfbfohaodmjfmok
   ```
   如果不同，请记录并反馈。

### 3.3 让 Chrome 认识 native host

正常情况下，DSH 启动时会自动写 native messaging manifest 和注册表。需要确认：

1. DSH 启动后，**完全退出 Chrome（所有窗口）**，再重新打开；
2. 点击扩展图标，popup 显示 **Connected**；
3. 如果显示 Not connected：
   - 退出 Chrome 再开一次；
   - 检查 DSH 是否在运行、插件是否启用；
   - 把 DSH 启动日志和 popup 截图发给管理员，不要自行改注册表。

> Windows 只在浏览器启动时读取 native messaging 注册表，所以“先启动 DSH，再完全重启 Chrome”很关键。

## 4. 需要测试什么（请逐项打勾）

测试只使用公开网站，**不要登录真实账号、不要输入真实密码/API key、不要付款**。

### A. 安装/连接（必测）
- [ ] 扩展加载成功，ID 正确
- [ ] popup 显示 **Connected**
- [ ] 任务管理器里能看到 `dsh-chrome-host.exe`
- [ ] 重启 Chrome 后自动重连
- [ ] 重启 DSH/插件后能恢复连接（可能需要重新点扩展图标）

### B. 基础浏览器工具（必测，用公开页面）
建议页面：
- `https://example.com`
- `https://httpbin.org/forms/post`（公开表单，适合测输入/点击）
- `https://httpbin.org/status/404`（测网络/console）
- `https://www.wikipedia.org`

逐项：
- [ ] `chrome_status` 返回 connected
- [ ] `chrome_goto` 打开一个新页面
- [ ] `chrome_snapshot` 能读到标题/正文/控件
- [ ] `chrome_click` 点一个链接或按钮
- [ ] `chrome_type` 在 httpbin 表单里输入**假数据**
- [ ] `chrome_screenshot` 生成 PNG，能打开
- [ ] `chrome_tabs` 新建/切换/关闭 tab
- [ ] `chrome_console` 能看到 console 信息
- [ ] `chrome_network` 能看到网络请求
- [ ] `chrome_find` / `chrome_get_text` 可用

### C. Windows 特有（重点）
- [ ] Windows 用户名含**空格或中文**时正常
- [ ] 非管理员账户下正常
- [ ] Chrome 启动时没有黑色控制台窗口闪现
- [ ] 未签名 exe 触发 SmartScreen/杀毒提示时，记录提示（这是预览版预期）
- [ ] 测试包放在非 C 盘路径（如 `D:\dsh-test\`）也能工作
- [ ] Edge 也能加载/连接（可选）
- [ ] 关闭 DSH 后没有大量残留 `dsh-chrome-host.exe` 进程

### D. headless backend（必测）
- [ ] `backend:"headless"` 的 `chrome_goto` / `chrome_snapshot` / `chrome_screenshot` 可用
- [ ] `chrome_headless_login {op:"show"}` 能在公开页面（如 example.com）弹出可见窗口
- [ ] `{op:"finish"}` 后下一次 headless 调用能恢复页面
- [ ] headless profile 目录能创建/复用

### E. 稳定性/边界
- [ ] 连续 50 次 snapshot/click 不断开
- [ ] 切到别的窗口再回来，`chrome_resume` 正常
- [ ] 中文/emoji 页面 snapshot 不乱码
- [ ] 大页面（如 Wikipedia）不崩溃
- [ ] `chrome_pdf` 能生成 PDF 并打开
- [ ] 操作日志文件存在（DSH 数据目录下 `cache/dsh-chrome/`）

### F. 本版不需要测
- 侧边栏里的 DSH Web 嵌入（本版只提供侧边栏壳，完整嵌入要等后续）
- 原生 sidecar/Keychain 隐私层（后续版本）
- arm64 Windows
- 真实支付/真实账号登录

## 5. 失败时请提供

- Windows 版本
- Chrome/Edge 版本
- 扩展 ID、popup 显示的版本
- DSH 版本
- 失败的工具名 + 错误信息/错误码 + 截图
- DSH 数据目录下 `cache/dsh-chrome/host.log` 的最后 30 行
- 是否管理员、路径是否含空格/中文、是否有杀毒/SmartScreen 提示

## 6. 注意

- 这是预览版，exe 未签名；SmartScreen 提示是预期现象，请记录。
- 不要测试真实账号、支付、密码或 API key；需要登录的页面请跳过或问管理员。
- 测试过程中遇到任何“页面卡住/浏览器没反应”，先截屏并保留日志，再重启 Chrome。
