# Tab lease（I3 基础）

> 0.1.98 · `src/lease.js` · `chrome_lease` 工具 · `test/lease.mjs`
>
> **现状：这是给 shared-visible / collab 用的最小 lease 基础，还不是完整的共享控制。**
> `chrome_*` 的写动作**尚未**统一接入 lease 门控；当前 lease 只有显式调用 `chrome_lease` 才会生效。
> `chrome_context preset:"collab"` 仍返回 `UNSUPPORTED_MODE`。下一步见 §7。

## 1. 为什么需要 lease

隔离 context（I1/I2）解决的是「不同会话不共享 profile」。`collab` 要反过来：**多个 agent 共用一个可见 Chrome**，同时让：

- 同一个 tab 只允许一个写者（点击/输入/导航等）；
- 读操作（snapshot/text/screenshot）可以由多个会话共享；
- 用户随时可以显式接管，撤销 agent 的 lease；
- 会话失联时 lease 不会永久占着 tab（TTL）；
- tab 关闭/导航后，旧 lease 自动作废。

lease 是**会话对 tab 的使用声明**，不是浏览器权限，也不改变 Chrome 的 cookie/profile 隔离。

## 2. API（`BrowserLeaseManager`）

```js
import { BrowserLeaseManager } from './src/lease.js'

const leases = new BrowserLeaseManager() // provider 内存中一个实例
const lease = leases.acquire({ tabId, owner, mode: 'write', ttlMs: 60000 })
```

| 方法 | 作用 | 返回 |
|---|---|---|
| `acquire({tabId, owner, mode, ttlMs})` | 获取 lease；`mode` 默认 `read` | `{leaseId, tabId, owner, mode, createdAt, expiresAt}` |
| `renew(leaseId, {owner?, ttlMs?})` | 从当前时刻续租 | 更新后的 lease |
| `release(leaseId, {owner?})` | 主动释放 | 被释放的 lease |
| `heartbeat(owner, {ttlMs?, leaseIds?})` | 一次续租该 owner 的所有 lease（或指定列表） | lease 数组 |
| `list({tabId?, owner?, mode?}?)` | 列出未过期 lease | lease 数组 |
| `status(tabId)` | 单个 tab 的占用情况 | `{tabId, active, count, holders, write, read, leases}` |
| `takeover(tabId, {by:'user'})` | 用户显式接管：撤销该 tab 上所有 agent lease | `{tabId, by, revoked, revokedCount}` |
| `releaseTab(tabId, {reason?})` | tab 关闭/导航时清空该 tab 的 lease | `{tabId, reason, revoked, revokedCount}` |
| `clear()` | provider 卸载/测试时清空 | 清掉的条数 |

规则：

- **write 独占**：tab 上只要还有任何未过期 lease（read 或 write），新的 write 就抛 `LEASE_HELD`。
- **read 共享**：没有 write 时，多个 owner 可以同时持有 read lease；有 write 时 read 也抛 `LEASE_HELD`。
- **TTL 自动失效**：`expiresAt <= now` 即过期；`list/status/acquire/renew/release/heartbeat/releaseTab/takeover` 都会顺手清理过期项。
- **默认 TTL 60s，上限 15min**；`ttlMs` 必须是正数且不超过 `MAX_LEASE_TTL_MS`。
- **owner 校验**：`renew/release/heartbeat` 传了 `owner` 时，owner 不匹配抛 `LEASE_OWNER_MISMATCH`；工具层始终传调用会话的 `ownerOf(exec)`。
- **仅内存**：不写盘、不跨进程同步；provider 重启后 lease 全部消失。

## 3. `chrome_lease` 工具

```text
chrome_lease {
  op: "acquire" | "renew" | "release" | "list" | "status" | "takeover",
  tabId?, mode?:"read"|"write", ttlMs?, leaseId?, owner?, by?:"user"
}
```

| op | 说明 |
|---|---|
| `acquire` | `owner` 固定用 `ownerOf(exec)`；`tabId` 必填 |
| `renew` | 传 `leaseId` 续一个；不传 `leaseId` 则对该会话所有 lease 做心跳续租 |
| `release` | `leaseId` 必填 |
| `list` | 可按 `tabId/owner/mode` 过滤；默认列出所有会话的 lease |
| `status` | `tabId` 必填，返回持有者/模式 |
| `takeover` | 必须显式 `by:"user"`，否则 `USER_TAKEOVER_REQUIRED` |

没有接入 lease manager 时，工具返回 `{ok:false, error:"LEASES_UNAVAILABLE"}`（当前 `index.js` 尚未传入 manager，属于预期行为）。

lease 失败以工具错误抛出，`code` 保留：

| code | 含义 |
|---|---|
| `INVALID_ARGUMENT` | tabId/owner/mode/ttlMs/leaseId 非法 |
| `LEASE_HELD` | write 冲突，或 read 撞上 write；`details.holders` 带现有持有者 |
| `LEASE_NOT_FOUND` | leaseId 不存在 |
| `LEASE_EXPIRED` | lease 已过期（同时被清理） |
| `LEASE_OWNER_MISMATCH` | 非 owner 尝试续租/释放/心跳 |
| `USER_TAKEOVER_REQUIRED` | `takeover` 没有传 `by:"user"` |

## 4. 心跳与 tab 生命周期

- **心跳**：调用方在长动作/定时器里用 `heartbeat(owner)` 或工具 `renew`（不带 leaseId）统一续租；当前没有内置自动定时器，接入动作层时再加。
- **tab 关闭/导航**：应调用 `releaseTab(tabId, {reason})`。当前模块提供了方法，但 `chrome_tabs {op:"close"}` / 导航事件尚未调用它（见 §7）。
- **用户接管**：`takeover(tabId,{by:"user"})` 只撤销现有 agent lease；接管后若 agent 再次 `acquire`，目前仍可能成功。真正的「用户占用期间禁止 agent 写」要等动作门控接入时配合用户占用标记一起做。

## 5. 并发语义

JavaScript 单线程内 `acquire` 没有 `await`，检查与写入在同一同步段完成，因此同一进程内不会出现两个写者同时通过检查。跨进程不适用：lease 只在单个 provider 实例内存中有效。

## 6. 明确未完成（不要当成已实现）

- **未接入所有 `chrome_*` 写动作**：click/type/press/goto/upload/drag/select/scroll/hover 等当前不会检查 lease。lease 是显式 API，不是强制门控。
- **未接入 `chrome_context preset:"collab"`**：`src/contexts.js` 仍返回 `UNSUPPORTED_MODE`（本批按要求不改 contexts/index）。
- **未持久化、未跨 provider 同步**：重启即失效；多 DSH 实例之间不共享。
- **未实现用户占用期间硬阻断**：`takeover` 只撤销 lease。
- **未实现 tab 关闭/导航自动 release**：已有 `releaseTab` 方法，事件接线待做。
- **无后台心跳定时器**：目前由调用方触发。

## 7. 下一步接入点

1. `index.js`（主仓并行开发时再改）：`const leases = new BrowserLeaseManager()`，作为 `chromeTools({..., leases})` 传入；provider 卸载时 `leases.clear()`。
2. 写动作门控：在 `guard()`/各写工具 execute 前按 `tabId` 做 `acquire({owner, mode:"write", ttlMs})`，动作结束 `release`；只读工具用 `read` lease，允许共享。
3. tab 生命周期：`chrome_tabs {op:"close"}` 与导航成功后调用 `releaseTab`；扩展/驱动上报 tab 关闭时也调用。
4. `chrome_context preset:"collab"`：在 contexts 里创建 shared/visible context，并把 lease 作为跨会话使用同一 tab 的准入条件。
5. 用户接管：UI 侧显式调用 `takeover(tabId,{by:"user"})`，并在动作门控里增加用户占用标记。

## 8. 测试

```bash
node test/lease.mjs
```

覆盖：read 共享、write 单写者、TTL 过期、renew、heartbeat、release、`releaseTab`、用户 takeover、错误码、`chrome_lease` 工具映射与 `LEASES_UNAVAILABLE`。
