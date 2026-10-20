const badge = document.getElementById('badge')
const version = document.getElementById('version')
const tab = document.getElementById('tab')
const hint = document.getElementById('hint')
const reconnect = document.getElementById('reconnect')
const reload = document.getElementById('reload')
const focus = document.getElementById('focus')
const sidebar = document.getElementById('sidebar')
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

sidebar.addEventListener('click', async () => {
  try {
    const win = await chrome.windows.getCurrent()
    await chrome.sidePanel.open({ windowId: win.id })
    window.close()
  } catch (error) {
    hint.textContent = `Sidebar failed: ${error?.message || error}`
  }
})

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

const CURSOR_KEY = 'dshCursor'
const CURSOR_MAX_BYTES = 256 * 1024
const cursorPreset = document.getElementById('cursor-preset')
const cursorFile = document.getElementById('cursor-file')
const cursorPreview = document.getElementById('cursor-preview')
const cursorStatus = document.getElementById('cursor-status')
const cursorReset = document.getElementById('cursor-reset')

function renderCursor(cursor) {
  const value = { preset: 'whale', image: null, size: 30, ...(cursor || {}) }
  cursorPreset.value = ['whale', 'arrow', 'dot', 'crosshair'].includes(value.preset) ? value.preset : 'whale'
  if (value.image) {
    cursorPreview.src = value.image
    cursorPreview.hidden = false
    cursorStatus.textContent = 'Custom local image active; choosing a preset removes it.'
  } else {
    cursorPreview.removeAttribute('src')
    cursorPreview.hidden = true
    cursorStatus.textContent = 'Preset active · local PNG/JPEG/WebP ≤256 KB'
  }
}

function saveCursor(cursor) {
  const value = { preset: cursor.preset || 'whale', image: cursor.image || null, size: 30 }
  chrome.storage.local.set({ [CURSOR_KEY]: value }, () => {
    if (chrome.runtime.lastError) {
      cursorStatus.textContent = `Save failed: ${chrome.runtime.lastError.message}`
      return
    }
    renderCursor(value)
  })
}

chrome.storage.local.get(CURSOR_KEY, (stored) => renderCursor(stored?.[CURSOR_KEY]))
cursorPreset.addEventListener('change', () => saveCursor({ preset: cursorPreset.value }))
cursorReset.addEventListener('click', () => {
  cursorFile.value = ''
  saveCursor({ preset: 'whale', image: null })
})
cursorFile.addEventListener('change', () => {
  const file = cursorFile.files?.[0]
  if (!file) return
  if (!/^image\/(png|jpe?g|webp)$/.test(file.type)) {
    cursorStatus.textContent = 'Unsupported file type; use PNG, JPEG or WebP.'
    cursorFile.value = ''
    return
  }
  if (file.size > CURSOR_MAX_BYTES) {
    cursorStatus.textContent = `Image is ${Math.round(file.size / 1024)} KB; limit is 256 KB.`
    cursorFile.value = ''
    return
  }
  const reader = new FileReader()
  reader.onload = () => {
    const image = String(reader.result || '')
    if (!/^data:image\/(?:png|jpe?g|webp);base64,/i.test(image)) {
      cursorStatus.textContent = 'Could not read image.'
      return
    }
    saveCursor({ preset: cursorPreset.value, image })
  }
  reader.onerror = () => { cursorStatus.textContent = 'Could not read image.' }
  reader.readAsDataURL(file)
})
