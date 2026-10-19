# Backend 能力契约（capabilities）

> 2026-10-17 · 基线 provider 0.1.87 / 扩展 0.1.86
> 相关：`docs/ARCHITECTURE-PLATFORM.md` §1.1（目标抽象）、`docs/HEADLESS.md` §3（headless 暂不支持）、内部 GAP 记录（shadow DOM）

## 0. 一句话

`src/capabilities.js` 是 **backend 能力清单的唯一事实源**；`src/backend.js` 的 `BackendRouter` 按 AsyncLocalStorage 里的当前 backend 暴露 `capabilities` / `supports(capability)`。工具层在调用后端之前查能力，缺能力统一返回 `UNSUPPORTED_BACKEND`，而不是每个工具各写一个 `if (backend === 'headless')`。

**接入状态（E11 已接）**：`src/tools.js` 增加内部 helper `supports(capability)`，读取 `bridge.supports()`（provider 注入的 `bridge` 就是 `BackendRouter`，见 `index.js`）；`chrome_pick`（`pick`）与 `chrome_screencast`（`screencast`）已在 `execute` 开头门控。**desktop 默认路径行为完全不变**；没有 `supports()` 的 fake / 旧 bridge 回退为「支持」，现有测试与旧调用方无感。`src/headless.js` 的方法白名单与 `UNSUPPORTED_BACKEND` 仍是运行时兜底（路由语义 `call`、`connected`、`hostVersion`、`extensionVersion`、`runWithBackend` 未改）。

## 1. 能力清单与矩阵

能力名是稳定的英文标识（写入 `src/capabilities.js` 的 `CAPABILITIES`，顺序即展示顺序）：

| capability | 含义 | desktop | headless | 相关工具 / 方法 |
|---|---|---|---|---|
| `frames` | iframe 深读（frame-qualified ref） | ✅ | ✅ | `chrome_frames`、`frameRef` 系列动作、`tab.frames` |
| `shadow` | open shadow DOM 深读 | ✅ | ✅ | `chrome_snapshot` / `find` / `get_text` / `click` / `type` / `upload` 的 deep query |
| `capture` | Network 抓包（请求 / 响应 / body） | ✅ | ✅ | `chrome_capture_start` / `_requests` / `_stop` |
| `upload` | 本地文件挂到 `<input type=file>` | ✅ | ✅ | `chrome_upload`、`tab.upload` |
| `download` | 触发 / 列出浏览器下载 | ✅ | ✅ | `chrome_download`、`browser.downloads` |
| `pick` | 真人点击页面的元素拾取 | ✅ | ❌ | `chrome_pick`、`tab.pick_start` / `_status` / `_cancel` |
| `screencast` | 连续帧流（viewer） | ✅ | ✅ | `chrome_screencast`、`tab.screencast_*` |
| `tabs` | 多标签生命周期 / 选择 | ✅ | ✅ | `chrome_tabs`、`chrome_close_session`、`tab.tabs` |
| `pause` | USER_SWITCHED 前台暂停语义 | ✅ | ❌ | 扩展侧暂停检测；`chrome_resume` / `chrome_tabs {op:"focus"}` 清除 |
| `evaluate` | 页面上下文 JavaScript 求值 | ✅ | ✅ | `chrome_evaluate`（默认不注册；硬确认） |

矩阵摘要：

- **desktop 10/10**：可见 Chrome + MV3 扩展 + native host，全部能力有落点；
- **headless 8/10**：只缺 `pick` 与 `pause`。两者都需要「可见浏览器 + 真人」：
  - `pick` 要真人点页面，headless 没有鼠标交互语义（工具层 E11 已把 `pick` 门控成带下一步提示的 `UNSUPPORTED_BACKEND`，见 §3.1）；
  - `pause` 是「用户切走前台 tab」的语义，headless 没有前台 tab 可切走（`chrome_resume` 在 headless 下是 no-op）。

> `pause` 不是工具名：当前没有 `chrome_pause` 工具，它描述的是扩展 `/resume` 的前台暂停状态机。列进契约是为了让将来加「后台 tab 保护」类工具时有一个可查询的语义位。

## 2. API

### 2.1 纯函数（`src/capabilities.js`，无 I/O、无第三方依赖）

```js
import {
  CAPABILITIES,            // frozen string[]，能力全集（顺序即展示顺序）
  BACKEND_CAPABILITIES,    // frozen { desktop: string[], headless: string[] }
  KNOWN_BACKENDS,          // frozen string[]，目前 ['desktop', 'headless']；须与 backend.js 的 BACKENDS 一致
  isKnownBackend,          // (backend) => boolean
  capabilitiesFor,         // (backend) => frozen string[]；未知 backend -> []
  backendSupports,         // (backend, capability) => boolean；未知一律 false，不抛错
  assertBackendSupports,   // (backend, capability, detail?) => true 或抛 UNSUPPORTED_BACKEND
} from './src/capabilities.js'
```

约定：

- **未知 backend / 未知 capability 都安全返回 false**，纯探测不会抛错；
- `assertBackendSupports` 失败时抛出 `Error`，带 `code = 'UNSUPPORTED_BACKEND'`、`backend`、`capability` 字段，`message` 里写清是哪个 backend 缺哪个能力；可选 `detail` 追加下一步提示；
- 能力列表与 `BACKEND_CAPABILITIES` 都是 frozen 的契约数据，调用方不能改。

```js
backendSupports('headless', 'pick')          // false
backendSupports('headless', 'frames')        // true
backendSupports('firefox', 'tabs')           // false（未知 backend 安全）
assertBackendSupports('headless', 'pick', '用 backend:"desktop" 或 snapshot+selector')
// throws Error { code: 'UNSUPPORTED_BACKEND', backend: 'headless', capability: 'pick' }
```

### 2.2 Router（`src/backend.js`）

`BackendRouter` 在原有路由职责上加两个只读入口，回答的是 **AsyncLocalStorage 当前 backend** 的能力：

```js
router.capabilities   // frozen string[]：当前 backend 的能力；工具调用外默认 desktop
router.supports(cap)  // boolean：当前 backend 是否声明了 cap；未知能力 false
```

```js
router.supports('pick')                            // true（默认 desktop 路由）
router.runWithBackend('headless', () => {
  router.supports('pick')                          // false
  router.supports('frames')                        // true
  router.capabilities                              // ['frames', 'shadow', 'capture', ...]
})
```

构造时可用 `headlessCapabilities` 覆盖 headless 的声明集合（给「只实现部分能力的 driver / 代理」或测试用；`null` = 用声明的默认集合）：

```js
const router = new BackendRouter({
  desktop: bridge,
  headless: driver,
  headlessCapabilities: ['frames', 'capture', 'tabs'], // 收窄 headless
})
```

- 注入接受任意可迭代字符串集合，自动去重并按 `CAPABILITIES` 顺序冻结；未知能力名 / 非字符串在构造时抛 `TypeError`（尽早暴露拼写错误）；
- 覆盖只影响 headless 的 `capabilities` / `supports`，desktop 与所有原有路由行为不受影响；
- **能力 ≠ 可用性**：`supports()` 只回答契约；driver 是否连上仍看 `router.connected`，没有 headless driver 时 `supports('frames')` 仍为 true，但 `router.call()` 照旧抛 `UNSUPPORTED_BACKEND`（现有行为未改）。

## 3. 与 `UNSUPPORTED_BACKEND` 的关系

统一码，三种来源，工具层不新增错误码：

| 来源 | 现在在哪 | 语义 |
|---|---|---|
| 运行时：没有 driver | `src/backend.js:131-133`（no headless driver）、`src/headless.js:628` / `:1966`（找不到 Chrome 可执行文件） | 「这台机器现在用不了这个 backend」 |
| 运行时：方法未实现 | `src/headless.js:1345` / `:1903`（`<method> is not implemented by the headless backend yet`） | 「这个 backend 还没实现这个方法」 |
| 契约：能力缺失 | `assertBackendSupports()`（纯函数）；工具层 `chrome_pick` / `chrome_screencast` 用 `BridgeError('UNSUPPORTED_BACKEND')`（E11） | 「这个 backend 类型不承诺这个能力」 |

### 3.1 工具层门控规则（**E11 已接**）

`chromeTools()` 内部有一个 helper `supports(capability)`：provider 注入的 `bridge` 就是 `BackendRouter`，所以它回答的是 AsyncLocalStorage 当前 backend 的能力；没有 `supports` 的 fake / 旧 bridge 回退为 `true`（兼容，不改变既有行为）。

```js
// src/tools.js（chromeTools 内部）
function supports(capability) {
  if (typeof bridge?.supports === 'function') return Boolean(bridge.supports(capability))
  return true
}

if (!supports('pick')) {
  throw new BridgeError('UNSUPPORTED_BACKEND', PICK_UNSUPPORTED_MESSAGE)
}
```

已在 `execute` 开头门控的工具：

| 工具 | capability | desktop | headless | 缺能力时 |
|---|---|---|---|---|
| `chrome_pick` | `pick` | 通过 | **拒绝** | `BridgeError('UNSUPPORTED_BACKEND')`，提示 `backend:"desktop"` 或 `chrome_snapshot` + selector/ref |
| `chrome_screencast` | `screencast` | 通过 | 通过（headless 已声明） | `BridgeError('UNSUPPORTED_BACKEND')`，提示 `backend:"desktop"` 或 `chrome_screenshot` |

错误合同（复用既有 `UNSUPPORTED_BACKEND`，不新增错误码）：

1. **抛 `BridgeError`，不抛裸 `Error`**：`src/tools.js` 的 `normalize()` 会把非 `BridgeError` 包成 `code = 'INTERNAL'`，错误码会丢；
2. `code` 固定为 `'UNSUPPORTED_BACKEND'`；`message` 必须写明缺哪个能力，并给出可执行的下一步（换 `backend:"desktop"`，或改用 snapshot + selector/ref 等替代路径）；
3. **先门控、后调用**：检查在 `execute` 开头、任何 `bridge.call()` / driver 请求之前；缺能力时不产生后端副作用；
4. **运行时兜底保留**：即使某个 backend 声明了能力但实际没实现，`src/headless.js` 的方法白名单仍会在请求时抛 `UNSUPPORTED_BACKEND`；`chrome_pick` 原有的 catch 继续把这类运行时错误映射成同一句带提示的消息；
5. **默认 desktop 行为不变**：desktop 声明全部 10 项能力，门控对默认路径是 no-op。

**尚未逐工具门控的能力**（E11 范围只到 `pick` / `screencast`）：`frames`、`shadow`、`capture`、`upload`、`download`、`tabs`、`pause`、`evaluate` 仍由各工具自身的参数校验 + `src/headless.js` 方法白名单兜底；后续按同一 helper 逐工具接入即可，不需要新错误码。

## 4. 如何给新 backend 声明能力

以将来加 `remote-cloud`（云浏览器，走 CDP）为例：

1. **在 `src/capabilities.js` 的 `BACKEND_CAPABILITIES` 里加一项**，按 `CAPABILITIES` 顺序列出它**真正能兑现**的能力（不伪造；拿不准就先不列，等实现落地再加）：

   ```js
   export const BACKEND_CAPABILITIES = Object.freeze({
     desktop: CAPABILITIES,
     headless: Object.freeze(CAPABILITIES.filter((name) => name !== 'pick' && name !== 'pause')),
     'remote-cloud': Object.freeze(['frames', 'capture', 'tabs', 'evaluate']),
   })
   ```

   `KNOWN_BACKENDS`、`capabilitiesFor()` 与 `backendSupports()` 会自动包含它。

2. **路由**：把新 backend 接进 `BackendRouter`（driver、`call()` 分支、`runWithBackend` 的 mode 白名单）并同步 `src/backend.js` 的 `BACKENDS`（工具 schema 的 `backend` enum）——这是另一张卡的工作。**两步必须一起落地**：只加能力声明不同步 `BACKENDS`，工具 enum 与能力矩阵会漂移；只加 enum 不接路由，新值会被静默回落到 desktop。`test/backend-contract.mjs` 会断言 `BACKENDS` 与 `KNOWN_BACKENDS` 一致，漏改直接测试失败。本卡的 `runWithBackend` 仍只认 `desktop` / `headless`（其它值照旧回落到 desktop）。

3. **运行时只有子集**（灰度、代理裁剪、测试）：构造 `BackendRouter` 时用 `headlessCapabilities` 这类注入收窄，或先按诚实集合声明。

4. **同步三处**：`test/backend-contract.mjs` 加矩阵断言、本文档 §1 表格加列、`docs/ARCHITECTURE-PLATFORM.md` 的路线图（如果需要）。

## 5. 测试

```bash
node test/backend-contract.mjs
# BACKEND CONTRACT TEST: PASS (20 checks)
```

自包含：不启动浏览器 / native host / HTTP server，不占端口，只 import 两个模块 + 假 backend。覆盖：

- `CAPABILITIES` 规范清单与 frozen；
- desktop 全量 10/10、headless 除 `pick` / `pause` 外全有；
- 未知 backend（`firefox` / `remote-cloud` / 空串 / 大小写 / 非字符串）一律安全 false；
- 未知 capability 一律 false；
- `assertBackendSupports` 的返回 / 抛错字段 / `detail` 提示 / 未知 backend 文案；
- Router 默认 desktop 视图、`runWithBackend('headless')` 视图、并发调用不串 backend；
- `headlessCapabilities` 注入（数组 / Set / 去重 / 空集合 / 非法输入 TypeError）；
- `capabilities` 为 frozen，外部 push 抛 `TypeError`；
- 能力 ≠ 可用性（无 driver 仍声明能力，但 `call` 抛 `UNSUPPORTED_BACKEND`）；
- **不改变现有行为**：`call` 仍走 desktop→`desktop.call` / headless→`headless.request`、`connected` / 版本字段语义不变、`wrapToolsForBackend` 的 backend 参数注入与剥离不变、`runWithBackend` 对未知 mode 的桌面回落不变。

> `backend-contract` 与 `p2-tools` 都已在 `npm test` 链里（`package.json` 的 `test` 脚本），无需单独登记。

工具层门控（E11）由 `test/p2-tools.mjs` 覆盖（该测试本来就需要 fake host，不新增依赖）：

```bash
node test/p2-tools.mjs
# P2 TOOLS TEST: PASS
```

- fake bridge 显式提供 `supports()`；默认全量能力，**不改变原有 40 工具计数与其余断言**；
- `chrome_pick` 支持路径照旧执行（成功返回 ref/selector/text），并断言确实查询了 `supports('pick')`；
- `chrome_pick` 不支持路径：`error.code === 'UNSUPPORTED_BACKEND'`、消息含 `backend:"desktop"` 与 `chrome_snapshot`、且**没有**发往后端的请求；
- 无 `supports()` 的 bridge 回退为支持，`chrome_pick` 仍可用；
- `chrome_screencast` 不支持路径同样在调用前抛 `UNSUPPORTED_BACKEND`；desktop / headless 都声明支持，正常路径行为不变。

## 6. 边界与已知差异

- **capability 是契约，不是实现验收**：`supports()` 不逐工具验证；每个工具真正的落点仍看 `src/tools.js` / `src/headless.js`。
- **headless 的 `shadow`**：桌面扩展有 `__dshDeep` 深查询（open shadow root），headless 的快照/查找目前仍走 `document.querySelectorAll`，不进入 shadow root（见 内部 GAP 记录）。契约按「headless 除 pick/pause 外大部分」声明为支持；在把 `shadow` 接进工具层门控之前，要么 headless 补 deep query，要么把 `shadow` 从 headless 集合移除——两者都只在 `src/capabilities.js` 改一行。
- **provider 本地工具不受 backend 影响**：`chrome_status` / `chrome_config` / `chrome_policy` / `chrome_audit` / `chrome_shots` / `chrome_headless_login` 不走路由，不在能力矩阵里。
- **未声明的 backend**：`remote-cloud` / `firefox-extension` 等将来 backend 在声明前，任何 `backendSupports` 查询都安全返回 false（不会误报支持）。
