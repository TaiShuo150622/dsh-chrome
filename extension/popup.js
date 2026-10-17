const badge = document.getElementById('badge')
const version = document.getElementById('version')
const tab = document.getElementById('tab')
const hint = document.getElementById('hint')

chrome.runtime.sendMessage({ type: 'dsh-status' }, (status) => {
  if (chrome.runtime.lastError || !status) {
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
    : 'Start DSH Desktop with the dsh-chrome plugin, then reload this extension. If the provider is running, quit and reopen Chrome once so it reads the native messaging manifest.'
})
