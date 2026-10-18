import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ext = path.join(root, 'extension')
const read = (name) => fs.readFileSync(path.join(ext, name), 'utf8')
const manifest = JSON.parse(read('manifest.json'))

assert.equal(manifest.side_panel?.default_path, 'sidepanel.html', 'manifest must declare the side panel entry')
assert.ok(manifest.permissions.includes('sidePanel'), 'sidePanel permission is required to open the panel')
assert.equal(manifest.action?.default_popup, 'popup.html', 'the toolbar popup stays available')
for (const file of ['sidepanel.html', 'sidepanel.css', 'sidepanel.js']) {
  assert.ok(fs.statSync(path.join(ext, file)).size > 100, `${file} must be packaged`)
}
const panel = read('sidepanel.html')
assert.match(panel, /id="frame"/, 'side panel must embed the DSH web app')
assert.match(panel, /sidepanel\.js/, 'side panel script must load')
const logic = read('sidepanel.js')
assert.match(logic, /chrome\.storage\.local/, 'panel URL must persist')
assert.match(logic, /chrome\.tabs\.query/, 'panel can detect a DSH tab')
assert.match(logic, /normalizeUrl/, 'only local http(s) URLs are accepted')
const popup = read('popup.js')
assert.match(popup, /chrome\.sidePanel\.open/, 'popup must open the side panel on a user gesture')
assert.match(read('popup.html'), /id="sidebar"/, 'popup must expose a Sidebar button')
console.log('SIDEPANEL TEST: PASS')
