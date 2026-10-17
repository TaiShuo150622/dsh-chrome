const badge = document.getElementById('badge')
const version = document.getElementById('version')
const tab = document.getElementById('tab')
const hint = document.getElementById('hint')
const reconnect = document.getElementById('reconnect')
const reload = document.getElementById('reload')
const focus = document.getElementById('focus')
const selfheal = document.getElementById('selfheal')
const autoupdate = document.getElementById('autoupdate')

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
  if (status.autoReload) {
    autoupdate.textContent =
      status.diskVersion && status.diskVersion !== status.extensionVersion
        ? `reload pending (disk ${status.diskVersion})`
        : `on (disk ${status.diskVersion || '?'})`
  } else {
    autoupdate.textContent = 'off (no dev.json watcher)'
  }
  hint.textContent = status.connected
    ? 'The DSH provider can open background tabs. Nothing is focused automatically.'
    : 'Start DSH Desktop with the dsh-chrome plugin, then press Reconnect. If it still fails, quit and reopen Chrome once so it reads the native messaging manifest.'
  if (!status.connected && status.lastError) {
    hint.textContent += `\nLast error: ${status.lastError}`
  }
}

chrome.storage.local.get('dshSelfHeal', (stored) => {
  const count = stored?.dshSelfHeal?.count || 0
  selfheal.textContent = count > 0 ? `${count} automatic reload(s)` : 'none'
})

focus.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'dsh-focus-tab' }, (response) => {
    if (chrome.runtime.lastError || !response?.ok) {
      hint.textContent = `Focus failed: ${chrome.runtime.lastError?.message || response?.error || 'unknown'}`
      return
    }
    hint.textContent = `Focused tab: ${response.title || response.url || response.tabId}`
  })
})

reload.addEventListener('click', () => {
  badge.textContent = 'reloading…'
  chrome.runtime.reload()
})

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
