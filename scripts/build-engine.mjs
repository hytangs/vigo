#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { chmod } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const root = path.resolve(import.meta.dirname, '..')
const cliOnly = process.argv.includes('--cli-only')
if (process.argv.slice(2).some(arg => arg !== '--cli-only')) throw new Error('Usage: build-engine.mjs [--cli-only]')
for (const script of ['build-rust-routing-kernel.mjs', 'build-cli.mjs']) {
  const result = await run(process.execPath, [path.join(root, 'scripts', script)], { cwd: root, maxBuffer: 16 * 1024 * 1024 })
  process.stdout.write(result.stdout)
}
if (!cliOnly) {
  const output = path.join(root, 'public', 'engine-http.mjs')
  await run(process.execPath, [path.join(root, 'node_modules', 'rolldown', 'bin', 'cli.mjs'),
    path.join(root, 'src', 'server', 'engine-http.mjs'), '--file', output,
    '--format', 'esm', '--platform', 'node', '--minify'], { cwd: root })
  await chmod(output, 0o755)
  console.log(`Built ${output}`)
}
