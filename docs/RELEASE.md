# 发布检查清单

> 适用：打 tag / GitHub Release / 交给外部测试者。P3 之前只承诺 macOS。

## 1. 版本

- [ ] `extension/manifest.json` 版本 +1（语义：新增能力 minor，修复 patch）
- [ ] `CHANGELOG.md` 增加对应版本条目（Added/Changed/Fixed）
- [ ] `npm run docs:tools`，`docs/TOOLS.md` 有 diff 则提交
- [ ] README 能力表/版本号是否需要更新

## 2. 验证

- [ ] `npm test` 五条全过
- [ ] 真机 smoke：`chrome_status` → `chrome_goto` → `chrome_snapshot` → `chrome_screenshot` → `chrome_close_session`
- [ ] 真机新能力逐项（对照 `docs/P2-PLAN.md` 完成表）
- [ ] 自愈/重连：kill host 后 ≤30s 恢复（或按已知限制记录）
- [ ] 干净机器/新 profile 安装一遍 `docs/INSTALL.md`，10 分钟内完成

## 3. 产物

- [ ] `npm run package:extension` → `dist/dsh-chrome-extension-<version>.zip`
- [ ] zip 解压后根目录含 `manifest.json`（Load unpacked 可直接选）
- [ ] 记录 zip 的 sha256 写进 Release notes
- [ ] 若含 vendor：确认 `NOTICE.md` 与 `vendor/browser-use/LICENSE` 仍准确

## 4. 发布

- [ ] git tag `v<version>`（与扩展 manifest 对齐）
- [ ] GitHub Release 附件：扩展 zip；正文列出变更、已知限制、安装链接
- [ ] 回归：老版本用户升级路径（重载扩展 / 重启 Chrome）
- [ ] 阶段记录：`docs/records/` 对应 record 状态改为 pass 并附真机证据

## 5. 已知限制（发布正文应包含）

- 页面动作依赖 CDP；attach 期间 Chrome 可能提示「正在调试此浏览器」
- 扩展被回收后的自愈 reload 上限 5 次；超限需手动重载
- 仅 macOS；`chrome_network` v1 无状态码/headers
