# Windows 预览版 0.2.16（bridge 修复）

> 基于 0.2.16；修复 Windows 阻断性 bridge 缺陷。

## 修复

- Windows bridge 从普通文件 socket 改为命名管道 `\\.\pipe\dsh-chrome-<home hash>-<pid>`；
- 不再在 Windows 上 unlink/chmod socket 路径；
- `bridge.json` 现在会正常生成，host 可连接；
- `chrome_status` 增加 `bridgeError`，可区分“扩展没连”和“provider bridge 启动失败”。

## 请重测

1. 用 0.2.16 tgz 覆盖安装 DSH 插件（本地目录）；
2. 重启 DSH；
3. 重新加载 0.2.16 extension zip；
4. 完全退出 Chrome 再打开；
5. 检查 `bridge.json` 是否存在、`host.log` 是否有 `bridge authenticated`；
6. 再跑 chrome_goto/snapshot/screenshot。
