# Codex 任务书：代码结构审查

> 用途：把这份文档直接交给 Codex，让它审查 `dsh-chrome` 当前代码结构。
> 状态：任务书，不代表已完成审查。审查结果建议保存为 `docs/CODE-REVIEW-CODEX.md`。
> 仓库：`/Users/taishuo/projects/dsh-chrome`（公开：https://github.com/TaiShuo150622/dsh-chrome）
> 当前版本：0.2.4（以 `package.json` 为准）

## 角色与约束

你是资深代码架构审查者，只读审查，**不要修改任何文件、不要运行测试、不要运行会改文件的命令**。

目标：判断代码结构是否可以更优美——模块拆分是否够细、职责是否混杂、调用链是否过于复杂或隐式、测试是否容易替换。不要为了“优雅”建议重写核心；优先找**会实际增加 bug 概率/维护成本**的结构问题。

## 必读文件

- `index.js`（组合根）
- `src/tools.js`（约 3450 行，45 个工具）
- `src/headless.js`（约 3650 行，CDP driver + 页面动作 + 登录 + screencast + 视觉探针）
- `src/backend.js` + `src/tool-guards.js`（backend 路由 + lease 门控）
- `src/contexts.js`、`src/headless-contexts.js`、`src/lease.js`
- `src/context-viewer.js`（DSH 侧边栏 viewer 原型）
- `src/update.js`（可选发布检查/Windows host 更新）
- `src/config.js`、`src/bridge.js`、`src/install.js`、`src/liveview.js`
- `extension/`（MV3 扩展、popup、background、sidepanel）
- `test/`（重点看覆盖方式与 fake 边界）
- 已有自审：`docs/CODE-REVIEW-SELF.md`（请核对、挑战或补充，不要只复述）

## 审查问题（逐项回答）

1. **模块拆分/职责**
   - 哪些文件承担了明显不相关的多个职责？
   - 哪些模块的公开接口太宽、依赖过多？
   - `tools.js` 的 45 个工具是否应拆域？拆的边界怎么定？
   - `headless.js` 的启动/CDP/页面动作/登录/screencast/视觉探针如何分层？
   - `context-viewer.js`、`update.js` 内部是否该拆文件？

2. **调用链/隐式契约**
   - `wrapToolsForOperationLog(wrapToolsForBackend(chromeTools(...)))` 三层包装是否过度？读代码/排障成本如何降低？
   - `chromeTools` 一个 closure 捕获 11 个服务，哪些是真依赖、哪些应显式注入？
   - `WRITE_TOOLS` 名字集合、`backend` 参数、lease 自动 acquire/release 是否构成隐式契约？新增工具时怎么避免漏门控？
   - `context-viewer` 的 owner 绑定、`chrome_verify` 直接走 driver 绕过 router/approval，是否有隐藏耦合？
   - 是否存在循环依赖或“模块知道太多”的反向依赖？

3. **测试可替换性**
   - 哪些模块无法单独测试，必须 fake 整个 CDP/bridge？
   - 哪些测试文件过大、场景耦合，应该拆 fixture/场景？
   - 如果要做上面重构，现有测试够不够当安全网？缺哪类契约测试？

4. **结构风险**
   - 找出 3–5 个最值得先做的重构，按收益/风险排序。
   - 每条给：改什么、为什么、预计工作量、回归测试、风险。
   - 明确“不建议现在做”的项，避免大重写。

## 输出格式（严格）

用中文输出，结构如下：

```markdown
# Codex 结构审查（日期/版本）

## 结论（3–5 句）

## P0（必须优先）
### 问题标题
- 证据：`src/xxx.js:行号`
- 问题：
- 建议：
- 收益/风险：

## P1 / P2
（同上）

## 调用链图（文字版）
（标出 index → backend/guards → tools → driver/bridge 的实际路径与异常分支）

## 重构顺序（3–5 条）
| 顺序 | 改什么 | 收益 | 风险 | 回归测试 |

## 不建议现在做的
```

要求：
- 尽量给 `文件:行`，不要泛泛而谈；
- 区分“结构问题”和“个人风格”；
- 如果同意已有自审，请明确“同意/部分同意/不同意 + 原因”；
- 不要修改仓库，不要输出代码补丁（只给建议）。

## 运行方式（任选）

```bash
cd /Users/taishuo/projects/dsh-chrome
# 用默认模型（gpt-6.1-sol 可能 capacity 不足）
codex exec -s read-only --skip-git-repo-check - < docs/CODEX-TASK-STRUCTURE-REVIEW.md \
  > docs/CODE-REVIEW-CODEX.md 2>&1
```

或把上面「角色与约束」到「输出格式」整段复制进 Codex UI/CLI。

如果报 `Selected model is at capacity` / websocket reset：换默认模型或稍后重试；不要让它改代码。
