const badge = document.getElementById('badge')
const version = document.getElementById('version')
const tab = document.getElementById('tab')
const hint = document.getElementById('hint')
const reconnect = document.getElementById('reconnect')

function render(status) {
  if (!status) {
    badge.textContent = 'worker unavailable'
    hint.textContent = 'Reload the extension from chrome://extensions, then reopen this popup.'
    return
  }
  badge.textContent = status.connected ? 'Connected' : 'Not connected'
  badge.className = `badge ${status.connected ? 'ok' : 'bad'}`
  version.textContent = status.extensionVersion || '—'
  tab.textContent = status.sessionTabId == null ? 'none yet (call chrome_goto)' : `#${status.sessionTabId}`
  hint.textContent = status.connected
    ? 'The DSH provider can open background tabs. Nothing is focused automatically.'
    : 'Start DSH Desktop with the dsh-chrome plugin, then press Reconnect. If it still fails, quit and reopen Chrome once so it reads the native messaging manifest.'
  if (!status.connected && status.lastError) {
    hint.textContent += `\nLast error: ${status.lastError}`
  }
}

reconnect.addEventListener('click', () => {
  badge.textContent = 'connecting…'
  badge.className = 'badge bad'
  chrome.runtime.sendMessage({ type: 'dsh-connect' }, (status) => {
    if (chrome.runtime.lastError) {
      render(null)
      return
    }
    render(status)
  })
})

chrome.runtime.sendMessage({ type: 'dsh-status' }, (status) => {
  if (chrome.runtime.lastError) {
    render(null)
    return
  }
  render(status)
})
