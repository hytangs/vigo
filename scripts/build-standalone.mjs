#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import { rustRoutingTarget } from './lib/rust-routing-targets.mjs'
import path from 'node:path'

if (!rustRoutingTarget(process.platform, process.arch)) throw new Error(`Unsupported VIGO target: ${process.platform}:${process.arch}`)

const root = path.resolve(import.meta.dirname, '..')
const cargo = String(process.env.VIGO_CARGO ?? '').trim()
  || path.join(os.homedir(), '.cargo', 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo')
execFileSync(cargo, ['build', '--locked', '--release', '--manifest-path',
  path.join(root, 'native/vigo-routing-kernel/Cargo.toml'),
  '--no-default-features', '--features', 'standalone', '--bin', 'vigo'], { cwd: root, stdio: 'inherit' })
