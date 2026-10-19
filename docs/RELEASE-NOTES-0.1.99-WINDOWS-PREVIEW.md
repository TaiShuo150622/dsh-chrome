# Windows 预览版 0.1.99（测试）

> 基于 0.1.99：新增 Windows native host **HKCU 自动注册**，修复上一次测试者的 `Specified native messaging host not found`；同时包含 shared-visible 写租约门控。

## 包内容

- `dsh-desktop-chrome-0.1.99.tgz`（DSH 插件，含 `host/bin/win32-x64/dsh-chrome-host.exe`）
- `dsh-chrome-extension-0.1.99.zip`
- `dsh-chrome-host-win32-x64.exe` + sha256（host 二进制与 0.1.93 相同）
- `WINDOWS-TESTER-GUIDE-EXTERNAL.md`

## 这次重点

1. provider 在真实 Windows 上写 native manifest 后自动执行 `reg add HKCU\Software\Google\Chrome\NativeMessagingHosts\com.deepseek.dsh.chrome`；失败才打印手动命令。
2. 若仍报 `Specified native messaging host not found`，按 guide §3.4 检查注册表/manifest/exe 路径。
3. 旧 0.1.93 包不会自动注册，需要手动 `reg add`；0.1.99 起不需要。

## 已知限制

- 未签名 exe；SmartScreen/AV 可能提示。
- 需要 DSH Harness 环境；仅装扩展不会 Connected。
- Edge 真机/商店仍待后续。
- 仅 x64。
