import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { downloadReleaseAsset } from '../scripts/lib/github-release-asset.mjs'

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-release-download-'))
const destination = path.join(directory, 'artifact.zip')
const bytes = Buffer.from('pinned public artifact')
const options = { repository: 'example/project', tag: 'v1.0.0', name: 'artifact.zip', destination,
  sha256: crypto.createHash('sha256').update(bytes).digest('hex') }
try {
  const calls = []
  await downloadReleaseAsset(options, async (url, request) => {
    calls.push(url)
    assert.equal(new URL(url).hostname, 'api.github.com')
    if (url.endsWith('/tags/v1.0.0')) return Response.json({ assets: [{ name: options.name, id: 42 }] })
    assert(url.endsWith('/assets/42')); assert.equal(request.headers.Accept, 'application/octet-stream')
    return new Response(bytes)
  })
  assert.equal(calls.length, 2)
  assert.deepEqual(fs.readFileSync(destination), bytes)
  await downloadReleaseAsset(options, async (url, request) => {
    if (new URL(url).hostname === 'api.github.com') return new Response('', { status: 503 })
    assert.equal(request.headers.Authorization, undefined, 'API credentials never go to the public URL')
    return new Response(bytes)
  })
  await assert.rejects(downloadReleaseAsset(options, async url => url.includes('/tags/')
    ? Response.json({ assets: [{ name: options.name, id: 42 }] }) : new Response('corrupt bytes')), /checksum mismatch/)
  assert.deepEqual(fs.readFileSync(destination), bytes, 'failed verification preserves the old artifact')
  await assert.rejects(downloadReleaseAsset(options, async url => url.includes('/tags/')
    ? Response.json({ assets: [{ name: options.name, id: 42 }] })
    : new Response(new ReadableStream({ start(controller) { controller.error(new Error('interrupted')) } }))), /interrupted/)
  assert.deepEqual(fs.readdirSync(directory), ['artifact.zip'], 'failed streams leave no partial artifact')
  console.log('Release downloads: API, public fallback, credential boundary, checksum rejection and interrupted streams pass.')
} finally { fs.rmSync(directory, { recursive: true, force: true }) }
