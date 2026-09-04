import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const repositoryRoot = path.resolve(import.meta.dirname, '..')
const [main, preload, server, bridge, desktopStyles, packageJson] = await Promise.all([
  readFile(path.join(repositoryRoot, 'desktop', 'main.mjs'), 'utf8'),
  readFile(path.join(repositoryRoot, 'desktop', 'preload.cjs'), 'utf8'),
  readFile(path.join(repositoryRoot, 'src', 'server', 'vigo-api.mjs'), 'utf8'),
  readFile(path.join(repositoryRoot, 'src', 'app', 'desktopBridge.ts'), 'utf8'),
  readFile(path.join(repositoryRoot, 'src', 'styles', 'theme.css'), 'utf8'),
  readFile(path.join(repositoryRoot, 'package.json'), 'utf8').then(JSON.parse),
])

assert.match(main, /utilityProcess\.fork\(/u)
assert.match(main, /VIGO_API_TRANSPORT = 'memory'/u)
assert.match(main, /protocol\.handle\(studioScheme/u)
assert.match(main, /nodeIntegration: false/u)
assert.match(main, /contextIsolation: true/u)
assert.match(main, /sandbox: true/u)
assert.match(main, /icon: studioIconPath/u)
assert.match(main, /app\.dock\.setIcon\(studioIconPath\)/u)
assert.match(main, /titleBarStyle: 'hiddenInset'/u)
assert.match(main, /trafficLightPosition: \{ x: 16, y: 19 \}/u)
assert.doesNotMatch(main, /\.listen\(/u)
assert.doesNotMatch(main, /VIGO_PORT\s*=/u)
assert.match(preload, /contextBridge\.exposeInMainWorld\('vigoDesktop'/u)
assert.match(preload, /process\.platform === 'darwin' \? 'macos' : process\.platform/u)
assert.match(preload, /DOMContentLoaded', applyDesktopPlatform/u)
assert.doesNotMatch(preload, /require\(['"]node:/u)
assert.match(server, /process\.parentPort/u)
assert.match(server, /bodyBytes/u)
assert.match(bridge, /globalThis as \{ vigoDesktop\?: DesktopBridge \}/u)
assert.match(desktopStyles, /\[data-vigo-desktop="macos"\] \.topbar[\s\S]*app-region: drag/u)
assert.match(desktopStyles, /\[data-vigo-desktop="macos"\] \.topbar-brand \{[\s\S]*padding-left: 82px/u)
assert.match(desktopStyles, /\[data-vigo-desktop="macos"\] \.topbar-mark-button,[\s\S]*app-region: no-drag/u)
assert.equal(packageJson.main, 'desktop/main.mjs')
assert.equal(packageJson.scripts.studio, 'electron .')

console.log(JSON.stringify({
  status: 'passed',
  shell: 'electron',
  rendererNodeAccess: false,
  transport: 'memory',
  localPort: false,
}))
