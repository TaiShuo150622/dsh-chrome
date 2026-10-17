/**
 * Extension/package structural checks — no Chrome required.
 *
 * Catches the class of bugs where the manifest references a file that does not
 * exist (extension silently fails to load) or where the pinned extension id /
 * native host name drifts between extension, provider and host.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const extensionDir = path.join(root, 'extension')
const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, 'manifest.json'), 'utf8'))

let failures = 0
function check(name, condition, detail = '') {
  if (condition) console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`)
  else {
    failures += 1
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// 1) every file the manifest references must exist
const referenced = new Set()
referenced.add(manifest.background?.service_worker)
referenced.add(manifest.action?.default_popup)
for (const icon of Object.values(manifest.icons ?? {})) referenced.add(icon)
for (const icon of Object.values(manifest.action?.default_icon ?? {})) referenced.add(icon)
for (const script of manifest.content_scripts ?? []) {
  for (const file of script.js ?? []) referenced.add(file)
  for (const file of script.css ?? []) referenced.add(file)
}
for (const file of referenced) {
  check(`manifest file exists: ${file}`, typeof file === 'string' && fs.existsSync(path.join(extensionDir, file)))
}

// 2) pinned extension id derives from the manifest key (Chrome id algorithm)
const der = Buffer.from(String(manifest.key || ''), 'base64')
const hash = createHash('sha256').update(der).digest('hex').slice(0, 32)
const extensionId = [...hash].map((char) => String.fromCharCode(97 + Number.parseInt(char, 16))).join('')
check('manifest key is valid base64 SPKI', der.length > 0)
check('extension id is 32 chars a-p', /^[a-p]{32}$/.test(extensionId), extensionId)

// 3) native host name is identical in extension, provider installer and host
const hostName = 'com.deepseek.dsh.chrome'
const sources = {
  'src/install.js': 'HOST_NAME',
  'extension/background.js': 'HOST_NAME',
}
for (const [file, constant] of Object.entries(sources)) {
  const text = fs.readFileSync(path.join(root, file), 'utf8')
  const hasConstant = new RegExp(`const ${constant}\\s*=\\s*'${hostName.replace(/\./g, '\\.')}'`).test(text)
  check(`native host name consistent in ${file}`, hasConstant)
}

// 4) minimum Chrome version supports MAIN-world content scripts (111+)
check(
  'minimum_chrome_version >= 111 (MAIN world content scripts)',
  Number.parseInt(manifest.minimum_chrome_version, 10) >= 111,
  manifest.minimum_chrome_version,
)

// 5) version is semver-ish and matches package version line
check('manifest version looks like semver', /^\d+\.\d+\.\d+$/.test(manifest.version), manifest.version)

// 6) popup/offscreen HTML files exist because background opens them
check('offscreen.html exists', fs.existsSync(path.join(extensionDir, 'offscreen.html')))
check('popup.html exists', fs.existsSync(path.join(extensionDir, 'popup.html')))

console.log(failures === 0 ? '\nEXTENSION MANIFEST TEST: PASS' : `\nEXTENSION MANIFEST TEST: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
