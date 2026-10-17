// Content-script keepalive: an open port plus periodic messages keeps the
// extension service worker alive while any http(s) page is open, so a dead
// native host is reconnected without waiting for an unrelated browser event.
try {
  const port = chrome.runtime.connect({ name: 'dsh-keepalive' })
  port.onDisconnect.addListener(() => {
    // The worker went away; nothing to do in the page.
  })
  setInterval(() => {
    try {
      port.postMessage({ tick: Date.now() })
    } catch {
      // worker restart closes the port; a page reload reconnects
    }
  }, 20000)
} catch {
  // extension context invalidated (reload); ignore
}
