#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import fs from 'node:fs'
import { rustRoutingTarget } from './lib/rust-routing-targets.mjs'
import path from 'node:path'
import { remappedBuildEnvironment } from './lib/remapped-build.mjs'

if (!rustRoutingTarget(process.platform, process.arch)) throw new Error(`Unsupported VIGO target: ${process.platform}:${process.arch}`)

const root = path.resolve(import.meta.dirname, '..')
if (process.env.VIGO_USE_BUILT_RUNTIME === '1') {
  fs.accessSync(path.join(root, 'target/release', process.platform === 'win32' ? 'vigo.exe' : 'vigo'))
  process.exit(0)
}
const cargo = String(process.env.VIGO_CARGO ?? '').trim()
  || path.join(os.homedir(), '.cargo', 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo')
execFileSync(cargo, ['build', '--locked', '--release', '--manifest-path',
  path.join(root, 'crates/vigo-runtime/Cargo.toml'),
  '--no-default-features', '--features', 'standalone', '--bin', 'vigo'],
  { cwd: root, stdio: 'inherit', env: remappedBuildEnvironment(root) })
