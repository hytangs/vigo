import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-check-runner-'))
try {
  fs.copyFileSync(new URL('../scripts/run-checks.mjs', import.meta.url), path.join(dir, 'runner.mjs'))
  fs.writeFileSync(path.join(dir, 'check-suites.json'), JSON.stringify({ mixed: ['fail.mjs', 'pass.mjs'], success: ['pass.mjs'] }))
  fs.writeFileSync(path.join(dir, 'fail.mjs'), 'process.exitCode = 7')
  fs.writeFileSync(path.join(dir, 'pass.mjs'), 'console.log("later-check-ran")')
  const run = suite => spawnSync(process.execPath, ['runner.mjs', suite], { cwd: dir, encoding: 'utf8' })
  const mixed = run('mixed')
  assert.equal(mixed.status, 1)
  assert.match(mixed.stdout, /later-check-ran/)
  assert.match(mixed.stdout, /mixed: 1\/2 passed/)
  assert.match(mixed.stderr, /FAILED fail.mjs/)
  assert.equal(run('success').status, 0)
  assert.notEqual(run('missing').status, 0)
  console.log('Check runner reports failures, runs later checks, and propagates status.')
} finally { fs.rmSync(dir, { recursive: true, force: true }) }
