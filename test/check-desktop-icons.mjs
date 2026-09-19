import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')

const pngAssets = new Map([
  ['public/vigo-mark-transparent.png', null],
  ['public/vigo-mark-dark.png', null],
  ['public/favicon.png', [128, 128]],
  ['public/github-social-preview.png', [1280, 640]],
  ['public/icons/VIGOIcon.png', [1024, 1024]],
  ['public/icons/VIGO.iconset/icon_16x16.png', [16, 16]],
  ['public/icons/VIGO.iconset/icon_16x16@2x.png', [32, 32]],
  ['public/icons/VIGO.iconset/icon_32x32.png', [32, 32]],
  ['public/icons/VIGO.iconset/icon_32x32@2x.png', [64, 64]],
  ['public/icons/VIGO.iconset/icon_128x128.png', [128, 128]],
  ['public/icons/VIGO.iconset/icon_128x128@2x.png', [256, 256]],
  ['public/icons/VIGO.iconset/icon_256x256.png', [256, 256]],
  ['public/icons/VIGO.iconset/icon_256x256@2x.png', [512, 512]],
  ['public/icons/VIGO.iconset/icon_512x512.png', [512, 512]],
  ['public/icons/VIGO.iconset/icon_512x512@2x.png', [1024, 1024]],
])

for (const [relativePath, expectedSize] of pngAssets) {
  const data = fs.readFileSync(path.join(root, relativePath))
  assert.deepEqual([...data.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], `${relativePath} is not a PNG.`)
  if (expectedSize) {
    assert.equal(data.readUInt32BE(16), expectedSize[0], `${relativePath} has the wrong width.`)
    assert.equal(data.readUInt32BE(20), expectedSize[1], `${relativePath} has the wrong height.`)
  }
}

const studioIcon = fs.readFileSync(path.join(root, 'public/icons/VIGOIcon.png'))
assert.equal(
  createHash('sha256').update(studioIcon).digest('hex'),
  '040d2d891ba9140424b8913090adedc3338a5e0fa4095f995848e930560b64b2',
  'public/icons/VIGOIcon.png must retain the macOS safe-area inset.',
)

const icnsPath = path.join(root, 'public/icons/VIGO.icns')
const icns = fs.readFileSync(icnsPath)
assert.equal(icns.subarray(0, 4).toString('ascii'), 'icns', 'public/icons/VIGO.icns has an invalid header.')
assert.equal(icns.readUInt32BE(4), icns.byteLength, 'public/icons/VIGO.icns has an invalid length.')

const ico = fs.readFileSync(path.join(root, 'public/icons/VIGO.ico'))
assert.deepEqual([...ico.subarray(0, 4)], [0, 0, 1, 0], 'public/icons/VIGO.ico has an invalid header.')

console.log(JSON.stringify({
  status: 'passed',
  pngAssets: pngAssets.size,
  icnsBytes: icns.byteLength,
  icoBytes: ico.byteLength,
}))
