# FAQ

## 会抢焦点、影响我正常浏览吗？

不会。工具默认在**后台标签**里操作，并把它们收进本会话的折叠标签组（`DSH · <会话尾号>`），不调用 `activate`/`bringToFront`。例外：
- `chrome_tabs {op:"new"}` 从 0.1.6 起默认后台（可显式激活的场景后续再加参数）；
- 页面动作通过 CDP 执行，Chrome 可能在 attach 期间短暂显示「正在调试此浏览器」提示，动作结束立即 detach。

## 数据会离开本机吗？

插件本身的通信都在本机：UNIX socket（0600 + 随机 token）+ Chrome native messaging。但**页面文本、console、截图会进入当前 DSH 会话上下文**，这是"让模型看页面"的功能语义；敏感页面请自行判断是否操作。

## 为什么需要 `debugger` 权限？

点击、输入、按键、滚动、区域截图、dialog 处理都走 Chrome DevTools Protocol（`Runtime.evaluate` / `Page.captureScreenshot` / `Page.javascriptDialogOpening`）。P1 实测：后台折叠标签上 `executeScript` 与 content-script 消息会挂起，CDP 是唯一稳定通道。Claude in Chrome 同样申请 `debugger` 权限做点击/打字/截图。

## 会不会自动提交订单、删数据？

默认 `follow-dsh`：普通动作跟随 DSH 会话权限预设。当前 profile 为 `danger-full-access` 时日常读写不弹卡；上传文件等敏感动作走审批；`confirm`/`prompt` 对话框**默认取消**，只有显式 `dialog:{accept:true}` 才会确认。想更严格可切 `balanced`/`strict`（见 APPROVAL.md）。

## 和 Claude in Chrome / Codex 的差别？

- 嵌在 DSH Desktop 里，由模型通过工具调用驱动，不是 Chrome 侧边栏聊天；
- 每个 DSH 会话独立标签组与所有权，多会话互不干扰；
- 全部本机通信，开源（MIT）；
- 已有虚拟光标、find/get_text/console/network/upload/download/claim/dialog 等能力（对齐见 `docs/P2-PLAN.md`）。

## 支持 Windows / Linux 吗？

目前只承诺 **macOS**（P3 前）。Windows 作为后续可选支线（launcher 与路径适配），Linux 不承诺。

## 连接断了怎么办？

1. 点扩展图标 → popup 的 **Reload**（0.1.24+）；
2. 还不行：`chrome://extensions` → 卡片 ⟳；
3. 再不行：完全退出 Chrome（⌘Q）再打开（让 native messaging manifest 重新读取）；
4. 诊断：`npm run status` 看 bridge/host/扩展版本；日志在 `~/.dsh/cache/dsh-chrome/host.log`。

扩展 0.1.25 起有 watchdog + 自愈：端口连续失败会自动 reload 扩展（上限 5 次）。

## 多个会话能同时用吗？

可以。每个 DSH 会话有独立 owner→标签映射与标签组；`chrome_tabs list` 只列本会话标签，不会读/切你的其他标签。

## 和 DevTools 冲突吗？

同一标签上 CDP 是独占的：如果 DevTools 已经 attach 在该标签，扩展的页面动作会失败（`DEBUGGER_FAILED`）。关掉 DevTools 或换标签即可。

## 怎么卸载？

1. `chrome://extensions` 移除扩展；
2. 删除 `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.deepseek.dsh.chrome.json`；
3. 删除 `~/.dsh/cache/dsh-chrome/`；
4. 在 DSH 里停用/移除 `dsh-desktop-chrome` bundle。
