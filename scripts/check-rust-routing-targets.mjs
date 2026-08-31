import assert from 'node:assert/strict'
import {
  rustRoutingTarget,
  supportedRustRoutingTargets,
} from './lib/rust-routing-targets.mjs'

assert.equal(rustRoutingTarget('darwin', 'arm64')?.targetTriple, 'aarch64-apple-darwin')
assert.equal(rustRoutingTarget('linux', 'x64')?.targetTriple, 'x86_64-unknown-linux-gnu')
assert.equal(rustRoutingTarget('linux', 'x64')?.libraryName, 'libvigo_routing_kernel.so')
assert.equal(rustRoutingTarget('win32', 'x64')?.targetTriple, 'x86_64-pc-windows-msvc')
assert.equal(rustRoutingTarget('darwin', 'x64'), null)
assert.equal(rustRoutingTarget('linux', 'arm64'), null)
assert.deepEqual(
  supportedRustRoutingTargets.map((target) => target.host).sort(),
  ['darwin:arm64', 'linux:x64', 'win32:x64'],
)

console.log('Rust routing target configuration checks passed.')
