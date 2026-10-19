# Computer Use：单独插件的长期规划

> 状态：**超远未来 / 不在 `dsh-chrome` 内实现**。本文只记录边界，防止 browser 插件无限膨胀。
> 触发：用户明确要求“超远未来 computer use 相关做到另外一个插件中”。

## 1. 边界

| 能力 | 归属 |
|---|---|
| Chrome/Edge 页面导航、DOM、截图、cookie、扩展 | `dsh-chrome`（本插件） |
| OS 级鼠标/键盘、桌面应用、系统截图、窗口管理、文件管理器、原生对话框 | **独立的 `dsh-computer-use` 插件** |
| 跨应用工作流（浏览器 + 终端 + Office） | 未来的 orchestration 插件，不在本插件 |

`dsh-chrome` 不提供：
- 全局鼠标/键盘钩子；
- 桌面截图/OCR/窗口枚举；
- 任意应用 UI automation；
- OS 凭据注入（那是 password helper 的独立边界）。

## 2. 为什么单独插件

- 权限模型不同：浏览器工具是页面级 + origin policy；Computer Use 是 OS 级，需要更高审批/用户在场；
- 依赖不同：需要平台 accessibility API、屏幕捕获权限、输入注入权限；
- 风险/审计不同：屏幕可能含密码/隐私，必须独立 redaction 与“用户可中断”；
- 发布节奏不同：浏览器插件可先上，Computer Use 需要 macOS/Windows 分别签名/权限说明。

## 3. 未来最小形态（仅记录，不承诺）

1. 明确平台：macOS 优先（Accessibility + ScreenCaptureKit），Windows 后（UI Automation）；
2. 用户显式授权 + 可见指示器 + 随时中断（Esc/按钮）；
3. 截图默认不返模型；需要时只给局部/打码帧；
4. 输入动作审批/lease，禁止后台静默点击；
5. 与 `dsh-chrome` 通过独立工具/服务协作，不共享 CDP 权限。

## 4. 非目标

- 不把 Computer Use 塞进 `dsh-chrome` 的 `chrome_*` 工具面；
- 不把系统级输入权限给浏览器扩展；
- 不在近期排期；只是保留架构边界。
