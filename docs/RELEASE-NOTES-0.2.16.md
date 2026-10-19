# 发布说明 0.2.16（Windows bridge 命名管道）

> 2026-10-19 · 扩展/provider **0.2.16**

## 修复：Windows 阻断性缺陷

Windows 测试报告（0.1.99）定位到：

- `src/bridge.js` 用普通文件路径 `...\cache\dsh-chrome\bridge.sock` 调 `net.Server.listen()`；
- Node 在 Windows 只接受 `\\.\pipe\<name>`，监听报 `EACCES`；
- `bridge.json` 从未生成，host 永远 `discovery file missing`，Chrome 无法 Connected。

修复：

- `bridgeSocketPath({home,platform,pid})`：
  - Windows：`\\.\pipe\dsh-chrome-<home hash>-<pid>`；
  - macOS/Linux：保持 `.../bridge.sock`；
- Windows 跳过 socket 文件 `unlink`/`chmod`；
- host 继续从 `bridge.json` 读路径，无需改 host；
- `chrome_status` 增加 `bridgeError`，能区分“扩展没连”和“provider bridge 启动失败”；
- 新增 `test/bridge-windows.mjs`（命名管道格式、pid 防冲突、POSIX 不变）。

## 说明

- 该修复解决 Windows 桥接；headless Windows 候选路径仍由多引擎任务处理；
- 需要重新安装 0.2.16 Windows 包并完全重启 DSH/Chrome 验证。
