# Windows 预览版 0.1.93（测试版）

> 基于 tag `v0.1.93`（扩展/provider 0.1.93）的 Windows 预览包。
> **未在真实 Windows Chrome 上验证**；host.exe 由 GitHub Actions `windows-latest` 构建并通过 stdin-EOF/host.log 冒烟。

## 包内容

- Chrome 扩展 0.1.93（unpacked）
- `dsh-chrome-host.exe`（Node SEA，win32-x64）
- Windows 测试指南（`WINDOWS-TESTER-GUIDE.md`）

## 重点验证

1. Chrome/Edge 能通过注册表+manifest 启动 `dsh-chrome-host.exe`；
2. 扩展 popup 显示 Connected，native host 日志出现 `host started` / `bridge authenticated`；
3. Windows 上的基本工具（goto/snapshot/click/type/screenshot/tabs）可用；
4. 用户名/路径含空格或中文、非管理员、未签名 exe/杀毒软件、headless backend。

## 已知限制

- 需要 DSH Harness/provider 已运行；仅装扩展不会 Connected。
- exe 未签名；SmartScreen/AV 可能提示（预览预期）。
- 只构建 x64；arm64 不在本轮。
- 侧边栏 v1 的 DSH Web iframe 在 DSH 上不可用（cross-site 拒绝），本包不含原生侧边栏/隐私层。
- 数据目录：`%USERPROFILE%\.dsh\cache\dsh-chrome\`。

详细测试项见 `WINDOWS-TESTER-GUIDE.md`。
