# 发布说明 0.2.2（可选自动更新检查）

> 2026-10-19 · 扩展/provider **0.2.2**

## 新增

配置项（默认关闭）：

```json
{
  "update": {
    "enabled": false,
    "autoInstall": false,
    "channel": "stable",
    "checkIntervalHours": 24,
    "repository": "TaiShuo150622/dsh-chrome"
  }
}
```

- `enabled`：启动后检查 GitHub Release；结果写入 `~/.dsh/cache/dsh-chrome/update.json`；
- `channel`：`stable`（忽略 prerelease）或 `preview`；
- `autoInstall`：仅 **Windows** 会下载并校验 SHA-256 后替换 native host exe；DSH 插件本体仍通过 DSH 插件管理器更新；
- `chrome_status` 显示 plugin update 状态；
- 默认 `enabled=false`，不联网、不改变现有安装。

## 说明

- Chrome 未打包扩展不能自更新；扩展更新仍需重新加载/重新安装；
- 自动安装 host exe 时如果 Chrome 正在运行，Windows 可能拒绝替换，等下次启动再试；
- 自动更新是可选功能，默认不替用户做决定。
