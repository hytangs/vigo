import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
const packages = {
  'darwin-arm64': [
    'aarch64-apple-darwin',
    '7c4b6adad820135c948848047728c921f688aeb6a7d282859214f39172cc2544',
  ],
  'linux-arm64': [
    'aarch64-unknown-linux-gnu',
    'db77c80a7c8065f6acc1abb9e9650c2bb2b31e10c9e3324572ac510ee97bf505',
  ],
  'linux-x64': [
    'x86_64-unknown-linux-gnu',
    '163cfa63a72b7f075d9945ffcac4bdea251439cb50f5383f46752baeddcc668f',
  ],
  'win32-x64': [
    'x86_64-pc-windows-msvc',
    '9b080604302674e89030115cc3a55c39962753cd479b4829be78e889417f6df2',
  ],
}
// Original c8da84f archive bytes are retained as dedicated public release assets.
// Names distinguish them from later v0.5.0 repackaging; hashes never change.
const digest = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
export async function published050(directory) {
  let binary = process.env.VIGO_050_REFERENCE_BINARY
  if (!binary) {
    const pinned = packages[`${process.platform}-${process.arch}`]
    assert(
      pinned,
      'No published 0.5.0 reference for this platform; provide a verified VIGO_050_REFERENCE_BINARY',
    )
    const [target, sha256] = pinned
    const name = `VIGO-Rust-0.5.0-${target}.tar.gz`
    const archive = path.join(directory, name)
    const asset = name.replace('.tar.gz', '-baseline-c8da84fff781.tar.gz')
    const response = await fetch(
      `https://github.com/hytangs/vigo/releases/download/v0.5.0/${asset}`,
      { signal: AbortSignal.timeout(120000) },
    )
    assert(
      response.ok,
      `Permanent reference download failed (${response.status}); provide VIGO_050_REFERENCE_BINARY from the pinned package`,
    )
    fs.writeFileSync(archive, Buffer.from(await response.arrayBuffer()))
    assert.equal(
      digest(archive),
      sha256,
      'Reference archive differs from the permanent baseline; never repin the hash',
    )
    const extracted = path.join(directory, 'reference')
    fs.mkdirSync(extracted)
    execFileSync('tar', ['-xzf', archive, '-C', extracted, '--strip-components=1'])
    binary = path.join(extracted, process.platform === 'win32' ? 'vigo.exe' : 'vigo')
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(binary), 'manifest.json')))
  assert.equal(manifest.sourceCommit, 'c8da84fff7812d570fd5985cbcbcb83885587bf6')
  assert.equal(manifest.version, '0.5.0')
  assert.equal(manifest.dirty, false)
  assert.equal(digest(binary), manifest.binarySha256)
  return binary
}
