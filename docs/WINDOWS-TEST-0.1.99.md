# Windows 测试说明书（0.1.99）

> 目标：验证 DSH Desktop Chrome 插件在 Windows 上的安装、native host 注册和基础浏览器工具。
> 版本：0.1.99 · 公开仓库：<https://github.com/TaiShuo150622/dsh-chrome>

## 1. 你需要准备

- Windows 10/11 x64
- Chrome 或 Edge ≥ 116
- 已安装并运行 DSH Harness
- 不需要安装 Node

## 2. 获取文件

Release：<https://github.com/TaiShuo150622/dsh-chrome/releases/tag/v0.1.99-win-preview.1>

- `dsh-desktop-chrome-0.1.99.tgz`（DSH 插件，内含 host.exe）
- `dsh-chrome-extension-0.1.99.zip`
- `WINDOWS-TESTER-GUIDE-EXTERNAL.md`

## 3. 安装

1. 解压 tgz，得到 `package/` 目录（含 `package.json`、`host/bin/win32-x64/dsh-chrome-host.exe`）。
2. DSH → 插件 → 添加插件 → 输入这个 `package` 目录的绝对路径。
3. 启用 `dsh-desktop-chrome`，启动/重启 DSH。
4. Chrome → `chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → 选 `dsh-chrome-extension/`。
5. 扩展 ID 应为 `mejmgfhpgklcmphgimfbfohaodmjfmok`。
6. **完全退出 Chrome 再打开**，点扩展图标应显示 Connected。

> 0.1.99 起 provider 会自动写 HKCU 注册表；0.1.93 及更早需要手动注册。

## 4. 如果报 “Specified native messaging host not found”

1. 检查 manifest：
```powershell
Test-Path "$env:USERPROFILE\.dsh\cache\dsh-chrome\native-messaging-hosts\com.deepseek.dsh.chrome.json"
```
2. 查注册表：
```powershell
reg query "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.deepseek.dsh.chrome" /ve
```
Edge 把 `Google\Chrome` 换成 `Microsoft\Edge`。
3. 没有就手动注册：
```powershell
reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.deepseek.dsh.chrome" /ve /d "%USERPROFILE%\.dsh\cache\dsh-chrome\native-messaging-hosts\com.deepseek.dsh.chrome.json" /f
```
4. 检查 host.exe：
```powershell
Test-Path "$env:USERPROFILE\.dsh\cache\dsh-chrome\host\dsh-chrome-host.exe"
```
如果不存在，把 release 的 `dsh-chrome-host-win32-x64.exe` 复制成这个路径，重启 DSH。
5. 完全退出 Chrome 再打开。

## 5. 测试清单

### A. 安装/连接
- [ ] 扩展加载成功，ID 正确
- [ ] popup 显示 Connected
- [ ] 任务管理器有 `dsh-chrome-host.exe`
- [ ] `host.log` 有 `host started` / `bridge authenticated`
- [ ] 重启 Chrome/DSH 后能重连

### B. 基础工具
公开页面：`https://example.com`、`https://httpbin.org/forms/post`、`https://wikipedia.org`
- [ ] `chrome_status`
- [ ] `chrome_goto`
- [ ] `chrome_snapshot`
- [ ] `chrome_click`
- [ ] `chrome_type`（只用假数据）
- [ ] `chrome_screenshot`
- [ ] `chrome_tabs`
- [ ] `chrome_console` / `chrome_network`

### C. Windows 特有
- [ ] 用户名/路径含空格或中文
- [ ] 非管理员账户
- [ ] 无黑色控制台闪窗
- [ ] 未签名 exe 的 SmartScreen/杀毒提示
- [ ] 非 C 盘安装
- [ ] Edge 可选
- [ ] 退出后无大量残留进程

### D. headless
- [ ] `backend:"headless"` 的 goto/snapshot/screenshot
- [ ] `chrome_headless_login {op:"show"}` 可见窗口，finish 后恢复

### E. 稳定性
- [ ] 连续 50 次动作不断开
- [ ] 切窗口后 `chrome_resume`
- [ ] 中文/emoji、大页面
- [ ] PDF 输出
- [ ] 日志文件存在

不要输入真实密码、API key，不要付款。

## 6. 失败请提供

Windows/Chrome/DSH 版本、扩展 ID、失败工具名+错误码+截图、`host.log` 最后 30 行、是否管理员/路径含空格/SmartScreen 提示。
