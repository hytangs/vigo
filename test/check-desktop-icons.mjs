import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { inflateSync } from 'node:zlib'

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
  'f9c9ecf5cf0eabb7cf6d2aca445b6ad365631a4cdce141ab893dc51463c995e7',
  'public/icons/VIGOIcon.png must retain the macOS safe-area inset.',
)

// Decode an 8-bit, non-interlaced RGBA PNG and return pixel alpha.
function pngAlpha(data) {
  const width = data.readUInt32BE(16), height = data.readUInt32BE(20)
  assert.deepEqual([data[24], data[25], data[28]], [8, 6, 0], 'Icon checks expect 8-bit, non-interlaced RGBA.')
  const chunks = []
  for (let offset = 8; offset < data.length;) {
    const length = data.readUInt32BE(offset), type = data.toString('ascii', offset + 4, offset + 8)
    if (type === 'IDAT') chunks.push(data.subarray(offset + 8, offset + 8 + length))
    offset += length + 12
  }
  const raw = inflateSync(Buffer.concat(chunks)), stride = width * 4
  const pixels = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let x = 0; x < stride; x += 1) {
      const left = x >= 4 ? pixels[y * stride + x - 4] : 0, up = y ? pixels[(y - 1) * stride + x] : 0
      const corner = x >= 4 && y ? pixels[(y - 1) * stride + x - 4] : 0
      const estimate = left + up - corner
      const paeth = [left, up, corner].reduce((best, value) => Math.abs(estimate - value) < Math.abs(estimate - best) ? value : best)
      pixels[y * stride + x] = line[x] + [0, left, up, (left + up) >> 1, paeth][filter]
    }
  }
  return (x, y) => pixels[y * stride + x * 4 + 3]
}
// The tile's rounded corners stay clear: no shadow clipped to its square bounds.
const iconAlpha = pngAlpha(studioIcon)
for (const [x, y] of [[140, 140], [883, 140], [140, 883], [883, 883]]) {
  assert.ok(iconAlpha(x, y) <= 8, `public/icons/VIGOIcon.png must keep its corner at ${x},${y} clear.`)
}

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
