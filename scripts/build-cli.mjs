import { chmod, mkdir, readFile, rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outputRoot = join(repoRoot, 'public')
const outputFile = join(outputRoot, 'vigo.mjs')
const rolldownCli = join(repoRoot, 'node_modules', 'rolldown', 'bin', 'cli.mjs')

await readFile(rolldownCli)
await mkdir(outputRoot, { recursive: true })
await rm(outputFile, { force: true })
await execFileAsync(process.execPath, [
  rolldownCli,
  join(repoRoot, 'src', 'cli', 'vigo.ts'),
  '--file', outputFile,
  '--format', 'esm',
  '--platform', 'node',
  '--banner', '#!/usr/bin/env node',
  '--minify',
], { cwd: repoRoot })
await chmod(outputFile, 0o755)

console.log(`Built ${outputFile}`)
