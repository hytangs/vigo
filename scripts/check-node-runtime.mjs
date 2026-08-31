import assert from 'node:assert/strict'
import process from 'node:process'

const minimumNode = Object.freeze([24, 18, 0])
const supportedTargets = new Set([
  'darwin:arm64',
  'linux:x64',
  'win32:x64',
])

function versionParts(value) {
  const parts = String(value).split('.').map((part) => Number(part))
  assert(parts.length >= 3 && parts.every(Number.isInteger), `Invalid Node.js version: ${value}`)
  return parts
}

function atLeast(actual, minimum) {
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] > minimum[index]) return true
    if (actual[index] < minimum[index]) return false
  }
  return true
}

const actualNode = versionParts(process.versions.node)
assert(
  atLeast(actualNode, minimumNode),
  `VIGO requires Node.js ${minimumNode.join('.')} or newer; found ${process.versions.node}.`,
)
assert(
  Number(process.versions.napi) >= 10,
  `VIGO requires Node-API 10 or newer; found ${process.versions.napi ?? 'none'}.`,
)
assert(
  supportedTargets.has(`${process.platform}:${process.arch}`),
  `VIGO does not configure a native build for ${process.platform}:${process.arch}.`,
)

const sqlite = await import('node:sqlite')
assert.equal(typeof sqlite.DatabaseSync, 'function', 'VIGO requires the stable node:sqlite DatabaseSync API.')

console.log(JSON.stringify({
  status: 'passed',
  node: process.versions.node,
  napi: process.versions.napi,
  target: `${process.platform}:${process.arch}`,
  sqlite: 'DatabaseSync',
}))
