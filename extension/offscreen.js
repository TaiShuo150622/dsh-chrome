// Offscreen keepalive: MV3 service workers can be evicted while the native
// messaging port is silently dead. This timer pings the worker so it can
// reconnect without waiting for an unrelated browser event.
const TICK_MS = 15000
function tick() {
  chrome.runtime.sendMessage({ type: 'dsh-tick' }).catch(() => {})
}
setInterval(tick, TICK_MS)
tick()
