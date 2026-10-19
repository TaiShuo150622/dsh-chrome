# 贡献指南

## 环境

- macOS（P3 之前只承诺 macOS）
- Node.js 22+（测试与脚本不依赖任何 npm 包）
- DSH Desktop 0.2.x + Google Chrome 116+

## 开发循环

```bash
git clone <repo> && cd dsh-chrome
npm test                 # 四条测试，无需 Chrome
npm run docs:tools       # 改过工具定义后重新生成 docs/TOOLS.md
npm run package:extension
```

真机调试：

1. DSH Desktop 启用本 bundle（provider 会写 native host manifest 与 `dev.json`）；
2. `chrome://extensions` → 开发者模式 → 加载 `extension/`；
3. 之后改 `extension/` 下文件会被 native host 监听并**自动 reload 扩展**；
4. 改 `src/` / `index.js` 后在 plugin_manager 里重载 bundle（host 常驻，扩展不会断）。

## 提交前

- `npm test` 全过；
- 改过 `src/tools.js` 的话 `npm run docs:tools` 并提交 `docs/TOOLS.md`；
- 改了扩展版本号（`extension/manifest.json`）时同步更新 `CHANGELOG.md`；
- 新工具至少加一条 fake-extension 测试（断言参数确实到达扩展）。

## 目录约定

```
src/          provider（工具、bridge、install）
host/         native messaging host（保活/转发/截图物化）
extension/    MV3 扩展（background/page/console-hook/popup）
test/         无 Chrome 的集成测试
docs/         设计、路线图、安装、工具参考、阶段记录
scripts/      文档生成与打包
```

## 工作记录

每个阶段（P0/P1/P2…）在 `内部记录 ` 落一份 record.md + log.md，格式见已有记录；写完跑：

```bash
python ~/.dsh/skills/work-record/scripts/check_record.py 内部记录 <id>/record.md --fix
```
