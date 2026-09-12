import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-static-assets-'))
const dist = path.join(temporary, 'dist')
let child
let exited

try {
  await fs.mkdir(path.join(dist, 'assets'), { recursive: true })
  const fixtures = new Map([
    ['index.html', '<link rel="stylesheet" href="/assets/index.css"><script src="/assets/app.js"></script>'],
    ['assets/index.css', 'body { color: red; }'],
    ['assets/app.js', 'window.build = "first";'],
    ['assets/icons.js', 'export const icon = "first";'],
  ])
  for (const [asset, content] of fixtures) await fs.writeFile(path.join(dist, asset), content)
  child = spawn(process.execPath, ['src/server/vigo-api.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      VIGO_API_TRANSPORT: 'tcp',
      VIGO_HOST: '127.0.0.1',
      VIGO_PORT: '0',
      VIGO_DIST_DIR: dist,
      VIGO_PROJECTS_DIR: path.join(temporary, 'projects'),
      VIGO_CONFIG_DIR: path.join(temporary, 'config'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  exited = new Promise((resolve) => child.once('exit', resolve))
  let log = ''
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Static server did not start.\n${log}`)), 15_000)
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      reject(new Error(`Static server exited (${code ?? signal}).\n${log}`))
    })
    child.stderr.on('data', (chunk) => { log = (log + chunk).slice(-8_000) })
    child.stdout.on('data', (chunk) => {
      log = (log + chunk).slice(-8_000)
      const ready = log.match(/VIGO_READY (http:\/\/127\.0\.0\.1:\d+\/)/)
      if (ready) { clearTimeout(timer); resolve(ready[1]) }
    })
  })
  for (const [asset, content] of fixtures) {
    const response = await fetch(new URL(asset, base), { signal: AbortSignal.timeout(5_000) })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-cache', `${asset} must be revalidated because its name survives rebuilds.`)
    assert.equal(await response.text(), content)
  }

  // Reuse the exact URLs, without a cache-busting query or request headers.
  // Equal-sized replacements also ensure the server rereads current bytes.
  for (const [asset, updated] of [
    ['assets/index.css', 'body { color: tan; }'],
    ['assets/app.js', 'window.build = "other";'],
  ]) {
    await fs.writeFile(path.join(dist, asset), updated)
    const response = await fetch(new URL(asset, base), { signal: AbortSignal.timeout(5_000) })
    assert.equal(response.headers.get('cache-control'), 'no-cache')
    assert.equal(await response.text(), updated, `${asset} must serve the rebuilt content at its original URL.`)
    const head = await fetch(new URL(asset, base), { method: 'HEAD', signal: AbortSignal.timeout(5_000) })
    assert.equal(head.status, 200)
    assert.equal(head.headers.get('cache-control'), 'no-cache')
    assert.equal(head.headers.get('content-length'), String(Buffer.byteLength(updated)))
    assert.equal(await head.text(), '')
  }
  console.log('Static asset HTTP checks passed: stable HTML/CSS/JS URLs revalidate and serve rebuilt bytes; HEAD remains bodyless.')
} finally {
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM')
    const force = setTimeout(() => child.kill('SIGKILL'), 2_000)
    try { await exited } finally { clearTimeout(force) }
  }
  await fs.rm(temporary, { recursive: true, force: true })
}
