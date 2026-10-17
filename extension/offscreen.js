// Offscreen keepalive: MV3 service workers can be evicted while the native
// messaging port is silently dead. This timer pings the worker so it can
// reconnect without waiting for an unrelated browser event.
const TICK_MS = 15000
function tick() {
  try {
    chrome.runtime.sendMessage({ type: 'dsh-tick' }, () => {
      // Reading lastError prevents Chrome from logging an unchecked-error entry
      // when the worker happens to be asleep.
      void chrome.runtime.lastError
    })
  } catch {
    // offscreen being torn down
  }
}
setInterval(tick, TICK_MS)
tick()
