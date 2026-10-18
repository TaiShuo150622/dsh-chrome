const STORAGE_KEY = 'dshSidePanelUrl'
const frame = document.getElementById('frame')
const frameWrap = document.getElementById('frameWrap')
const setup = document.getElementById('setup')
const empty = document.getElementById('empty')
const status = document.getElementById('status')
const urlInput = document.getElementById('url')
const hint = document.getElementById('hint')

function setStatus(text, tone = '') {
  status.textContent = text
  status.style.color = tone === 'error' ? '#f87171' : tone === 'ok' ? '#4ade80' : '#8b93a7'
}

function showSetup(message = '') {
  setup.hidden = false
  empty.hidden = true
  frameWrap.hidden = true
  hint.textContent = message
  hint.className = message ? 'hint error' : 'hint'
}

function normalizeUrl(raw) {
  const value = String(raw || '').trim()
  if (!value) return null
  try {
    const url = new URL(value)
    if (!/^https?:$/i.test(url.protocol)) return null
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return null
    return url.toString()
  } catch {
    return null
  }
}

function load(url) {
  if (!url) return showSetup()
  frame.src = url
  frameWrap.hidden = false
  setup.hidden = true
  empty.hidden = true
  urlInput.value = url
  setStatus('正在加载…')
}

async function save(raw) {
  const url = normalizeUrl(raw)
  if (!url) return showSetup('请输入本机 DSH Web 地址（127.0.0.1/localhost，http 或 https）。')
  await chrome.storage.local.set({ [STORAGE_KEY]: url })
  load(url)
}

async function detectFromTabs() {
  const tabs = await chrome.tabs.query({})
  const candidates = tabs.filter((tab) => {
    try {
      const url = new URL(tab.url || '')
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return false
      const hay = `${tab.title || ''} ${tab.url || ''}`.toLowerCase()
      return hay.includes('dsh') || hay.includes('deepseek') || hay.includes('harness')
    } catch {
      return false
    }
  })
  if (!candidates.length) {
    showSetup('没有找到已打开的 DSH 页面；请先打开 dsh web 打印的地址，或直接粘贴它。')
    return
  }
  const chosen = candidates[0]
  urlInput.value = chosen.url || ''
  setStatus('已找到 DSH 标签页')
}

document.getElementById('save').addEventListener('click', () => save(urlInput.value))
document.getElementById('detect').addEventListener('click', detectFromTabs)
document.getElementById('start').addEventListener('click', () => showSetup())
document.getElementById('settings').addEventListener('click', () => showSetup())
document.getElementById('reload').addEventListener('click', () => {
  if (frame.src) frame.src = frame.src
  else showSetup()
})
document.getElementById('opentab').addEventListener('click', async () => {
  const url = normalizeUrl(frame.src || urlInput.value)
  if (url) await chrome.tabs.create({ url })
})
frame.addEventListener('load', () => {
  setStatus('已加载', 'ok')
  hint.textContent = '如果页面显示 authentication required，请点 ⚙ 粘贴带 token 的完整 dsh web URL。'
  hint.className = 'hint'
})
frame.addEventListener('error', () => setStatus('加载失败', 'error'))
urlInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') save(urlInput.value)
})

chrome.storage.local.get(STORAGE_KEY).then((stored) => {
  const saved = normalizeUrl(stored?.[STORAGE_KEY])
  if (saved) load(saved)
  else showSetup()
}).catch(() => showSetup('无法读取设置。'))
