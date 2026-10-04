#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const cargo = String(process.env.VIGO_CARGO ?? '').trim()
  || path.join(os.homedir(), '.cargo', 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo')
execFileSync(cargo, ['build', '--locked', '--release', '--manifest-path',
  path.join(root, 'native/vigo-routing-kernel/Cargo.toml'),
  '--no-default-features', '--features', 'standalone', '--bin', 'vigo'], { cwd: root, stdio: 'inherit' })
