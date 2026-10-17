# 自动更新（扩展与 provider）

## 开发期（未打包扩展）

链路（0.1.8+，0.1.34+ 补版本核对）：

```
provider 写 ~/.dsh/cache/dsh-chrome/dev.json {watch, extensionDir}
        │
native host 启动时 fs.watch(extension/)，变更 800ms 去抖 + 3s 冷却 + manifest JSON 校验
        │ ext.changed
Service Worker → 去抖 800ms → chrome.runtime.reload()
        │
扩展重载后 SW 启动 → connectNative → 新 host → host 上报 ext.state{version}
        │
SW 比较磁盘版本与运行版本：不一致 → 再 reload（覆盖"host 离线期间已更新"）
```

保障与边界：

- 会话映射存 `chrome.storage.local`（0.1.43+），自动 reload 后本会话标签仍被跟踪；
- host watcher 的冷却/校验用于避免批量文件写/删除引发 reload 风暴（0.1.33）；
- **host 在扩展 reload 期间退出时，扩展侧没有 host 可触发下一次 reload** → 需要 popup 的 Reload 或 `chrome://extensions` ⟳（已知边界）。

## 发布形态

| 形态 | 更新机制 |
|---|---|
| 未打包（开发者） | 上面的 host watcher + ext.state 版本核对 |
| Chrome Web Store / CRX + `update_url` | Chrome 自身负责下载与更新；扩展只需版本握手与提示重载 |
| provider（DSH bundle） | DSH bundle 管理；host 常驻会在 provider 重载后自动重连，扩展不受影响 |

## 可见性

- popup：`Auto-update` 行（on / reload pending / off）；`Reload` 按钮；
- `chrome_status`：`extensionVersion`、`diskVersion`、`autoReload`；
- `~/.dsh/cache/dsh-chrome/host.log`：`extension state sent: version ...`、`extension change detected ...`。

## 恢复手册

1. popup → **Reload**；
2. 不行 → `chrome://extensions` → 卡片 ⟳；
3. 再不行 → 完全退出 Chrome 再打开（native messaging manifest 只在启动时读取）；
4. 诊断：`npm run status`、`tail ~/.dsh/cache/dsh-chrome/host.log`。
