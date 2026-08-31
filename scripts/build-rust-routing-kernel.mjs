#!/usr/bin/env node

import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { rustRoutingTarget } from './lib/rust-routing-targets.mjs'

const execFileAsync = promisify(execFile)
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const crateRoot = path.join(repositoryRoot, 'native', 'vigo-routing-kernel')
const cargo = String(process.env.VIGO_CARGO ?? '').trim()
  || path.join(os.homedir(), '.cargo', 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo')
const platformBuild = rustRoutingTarget(process.platform, process.arch)

if (!platformBuild) {
  throw new Error(`The production Rust routing kernel is not configured for ${process.platform}/${process.arch}.`)
}

const inheritedRustFlags = String(process.env.RUSTFLAGS ?? '').trim()
const rustFlags = [inheritedRustFlags, ...platformBuild.rustFlags].filter(Boolean).join(' ')
await execFileAsync(cargo, ['build', '--release', '--target', platformBuild.targetTriple], {
  cwd: crateRoot,
  env: {
    ...process.env,
    RUSTFLAGS: rustFlags,
  },
  maxBuffer: 16 * 1024 * 1024,
})

const source = path.join(
  crateRoot,
  'target',
  platformBuild.targetTriple,
  'release',
  platformBuild.libraryName,
)
const destination = path.join(crateRoot, 'vigo-routing-kernel.node')
await fs.copyFile(source, destination)
if (platformBuild.sign) {
  // A linker signature can validate on disk yet fail macOS page validation
  // after the dylib is copied to its `.node` load path. Re-sign the final
  // bytes, which are the artifact Node actually maps, instead of relying on
  // the intermediate Cargo output's embedded signature.
  await execFileAsync('/usr/bin/codesign', ['--force', '--sign', '-', destination])
}
const stats = await fs.stat(destination)
if (!stats.isFile() || stats.size < 16_384) {
  throw new Error('Rust routing kernel build did not produce a valid Node-API library.')
}
console.log(JSON.stringify({
  status: 'built',
  target: platformBuild.targetTriple,
  platform: process.platform,
  architecture: process.arch,
  path: path.relative(repositoryRoot, destination),
  bytes: stats.size,
}, null, 2))
