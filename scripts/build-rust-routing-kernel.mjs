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
const staging = `${destination}.${process.pid}.tmp`
try {
  await fs.copyFile(source, staging)
  if (platformBuild.sign) {
    // Sign the copied bytes that Node will map, rather than relying on the
    // intermediate linker's signature after the library changes paths.
    await execFileAsync('/usr/bin/codesign', ['--force', '--sign', '-', staging])
  }
  // Running processes may have the previous binding mapped. Publish a new
  // inode instead of modifying or signing their executable pages.
  await fs.rename(staging, destination)
} finally {
  await fs.rm(staging, { force: true })
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
