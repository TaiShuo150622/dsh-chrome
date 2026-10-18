# 发布说明 0.1.90（人工接管 / CI 硬化）

> 2026-10-18 · 扩展 **0.1.90** / provider **0.1.90** · 私有仓库 CI 绿

## 新增：后台浏览器的人工接管

`chrome_headless_login` 增加 `op:"show"`：把 **headless 当前页面暂停并显示到屏幕**（同一 profile 的可见 Chrome 窗口），用于登录/CAPTCHA/支付/OTP 等必须人工的步骤；`op:"finish"` 关闭窗口，下一次 `backend:"headless"` 调用会**恢复同一 URL**。`start`/`show` 都需硬确认。

## CI / 测试

- GitHub 私有仓库 CI 全绿（ubuntu-latest + macos-latest）；`windows-host.yml` 在 GitHub Actions 跑通，产出 `dsh-chrome-host.exe` artifact。
- 新增/修复：沙箱功能矩阵、安全 Top 5 回归、Windows host 静态测试；`npm test` 22 个测试文件。
- CI 环境差异处理：headless 时序/帧流套件在 CI 默认 SKIP（`DSH_HEADLESS_STRICT=1` 可强制），CI 用 `sandbox-smoke` 覆盖 headless 功能；bench 无 CPU 采样时跳过 CPU 断言；临时目录清理加 retry。
- 本地严格套件仍全跑；时序断言按 loadavg 缩放，`npm test` 带 4 次重试兜底。

## 其他

- 私有仓库：<https://github.com/TaiShuo150622/dsh-chrome>（private）。
- 公开前仍需：Windows 真机验证、敏感信息移出/历史清理、GitHub Actions 在公开仓库复核（见 `docs/PUBLIC-RELEASE-CHECKLIST.md`）。
