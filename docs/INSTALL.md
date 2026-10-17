# 安装（macOS，本地 / 开发者）

> 适用：DSH Desktop 0.2.x、Chrome 155（最低 116）。P3 之前只承诺 macOS 本机。

## 前置

- DSH Desktop 已安装（本插件随 bundle 启用）。
- Google Chrome 已安装，且你想用的那个 Chrome profile 已登录目标账号。

## 一次性安装

### 1. 启用 provider bundle

在 DSH Desktop 里启用 `dsh-desktop-chrome` bundle（插件管理 / plugin_manager）。启用后 provider 会自动写：

- native host 启动器与 `host.mjs`：`~/.dsh/cache/dsh-chrome/host/`
- native messaging manifest：`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.deepseek.dsh.chrome.json`
- 桥接 discovery：`~/.dsh/cache/dsh-chrome/bridge.json`
- 安装说明：`~/.dsh/cache/dsh-chrome/INSTALL.md`

### 2. 加载未打包扩展

1. 打开 `chrome://extensions`
2. 右上角打开「开发者模式」
3. 点「加载已解压的扩展程序」，选择仓库里的 `extension/` 目录
4. 记下扩展 ID（本仓库通过 manifest `key` 固定为 `mejmgfhpgklcmphgimfbfohaodmjfmok`）

> 如果 native messaging manifest 是**在 Chrome 启动后**才写入的，必须完全退出 Chrome（⌘Q）再打开，Chrome 只在启动时读取它。

### 3. 确认连接

点工具栏的 DSH Chrome 图标：

- 显示 **Connected** → 就绪；
- 显示 **Not connected** → 先点 `Reconnect`，再不行点 `chrome://extensions` 卡片上的 ⟳ 重载扩展。

## 日常使用

- 模型通过 `chrome_*` 工具在**后台标签组**里操作（组名 `DSH · <会话尾号>`），不会抢焦点；
- 关会话时 `chrome_close_session` 关闭本会话标签；
- 详细工具列表见 [TOOLS.md](TOOLS.md)。

## 开发模式（自动重载）

provider 启用时会写 `~/.dsh/cache/dsh-chrome/dev.json`；native host 会监听 `extension/`：

- 改 `extension/` 下文件 → 几秒内扩展自动 reload（无需点 ⟳）；
- 改 provider（`src/`、`index.js`）→ 仍需在 plugin_manager 里重载 bundle（host 常驻，扩展侧不会断）。

## 排障

| 现象 | 处理 |
|---|---|
| popup 显示 Not connected | 先 ⟳ 重载扩展；再不行重启 Chrome（让 native manifest 生效） |
| `Last error: chrome.runtime.connectNative is not a function` | 该错误不应再出现（native port 由 SW 持有）；若出现请重载扩展并反馈 |
| 工具报 `Chrome extension is not connected` | 看 `~/.dsh/cache/dsh-chrome/host.log` 是否在长；确认扩展版本与磁盘一致 |
| 页面动作超时 | 确认页面是 http(s)；首次动作偶发超时会自动重试一次 |
| 想彻底卸载 | 移除 native manifest `com.deepseek.dsh.chrome.json`、删除 `~/.dsh/cache/dsh-chrome/`、在 chrome://extensions 移除扩展 |

日志位置：

- native host：`~/.dsh/cache/dsh-chrome/host.log`
- 截图：`~/.dsh/cache/dsh-chrome/screenshots/`
- 扩展 popup 的 `Last error` 行
