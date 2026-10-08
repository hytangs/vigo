#!/usr/bin/env node
import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const root = path.resolve(import.meta.dirname, '..')
if (process.argv.length !== 2) throw new Error('Usage: build-cli-runtime.mjs')
for (const script of ['build-rust-routing-kernel.mjs', 'build-cli.mjs']) {
  const result = await run(process.execPath, [path.join(root, 'scripts', script)], { cwd: root, maxBuffer: 16 * 1024 * 1024 })
  process.stdout.write(result.stdout)
}
