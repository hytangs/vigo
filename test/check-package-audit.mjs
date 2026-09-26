import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { engineEnvironment } from '../public/engine-environment.mjs'
import { auditPackageFiles } from '../scripts/lib/package-audit.mjs'

const root = await mkdtemp(path.join(os.tmpdir(), 'vigo-package-audit-'))
try {
  await writeFile(path.join(root, 'app.js'), 'const optionalLocalProvider = "http://localhost:11434";')
  assert.equal((await auditPackageFiles(root)).files, 1, 'Optional provider presets are not active configuration')
  for (const [name, content, reason] of [
    ['.env', 'not-a-real-secret', /credential file/],
    ['app.js', ['', 'Users', 'build-owner', 'project', 'source'].join('/'), /developer path/],
    ['app.cjs', ['C:', 'Users', 'build-owner', 'source'].join('\\'), /developer path/],
    ['app.lock', ['C:', 'Users', 'build-owner', 'source'].join('\\\\'), /developer path/],
    ['app.bin', Buffer.from(['C:', 'Users', 'build-owner', 'source'].join('\\'), 'utf16le'), /developer path/],
    ['app.tex', 'vigo-' + 'bench/results', /private workspace/],
    ['app.js', 'sk-' + 'x'.repeat(32), /possible embedded credential/],
    ['app.js', 'ghp_' + 'x'.repeat(32), /possible embedded credential/],
    ['app.js', 'github_pat_' + 'x'.repeat(32), /possible embedded credential/],
    ['app.js', 'crsr_' + 'x'.repeat(32), /possible embedded credential/],
    ['app.js', 'AKIA' + 'X'.repeat(16), /possible embedded credential/],
    ['old.sqlite', '', /development data/],
    ['check-example.mjs', '', /test artifact/],
    ['example.test.js', '', /test artifact/],
  ]) {
    await writeFile(path.join(root, name), content)
    await assert.rejects(auditPackageFiles(root), reason)
    await rm(path.join(root, name))
  }
  for (const name of ['test', 'tests', '__tests__', 'fixtures', 'coverage']) {
    await mkdir(path.join(root, name))
    await assert.rejects(auditPackageFiles(root), /test artifact/)
    await rm(path.join(root, name), { recursive: true })
  }
  await symlink(path.join(root, 'absent'), path.join(root, 'outside'))
  await assert.rejects(auditPackageFiles(root), /symlink/)
} finally { await rm(root, { recursive: true, force: true }) }
const original = { PATH: '/usr/bin:/bin', SystemRoot: 'windows', TMPDIR: 'temporary', LANG: 'en_US.UTF-8',
  OPENAI_API_KEY: 'fixture', GH_TOKEN: 'fixture', AWS_SECRET_ACCESS_KEY: 'fixture',
  LD_PRELOAD: 'injected', LD_LIBRARY_PATH: 'injected', ELECTRON_RUN_AS_NODE: '1',
  VIGO_AGENCY_LLM_BASE_URL: 'http://localhost:1234', VIGO_AGENCY_LLM_API_KEY: 'fixture', VIGO_ROUTE_WORKER_URL: '/private/worker', NODE_OPTIONS: '--require=/private/file' }
for (const isPackaged of [true, false]) {
  const environment = engineEnvironment({ isPackaged, env: original, nativeKernelPath: '/bundle/server/kernel.node' })
  assert.equal(environment.VIGO_AGENCY_LLM_BASE_URL, isPackaged ? undefined : original.VIGO_AGENCY_LLM_BASE_URL)
  assert.equal(environment.VIGO_AGENCY_LLM_API_KEY, isPackaged ? undefined : 'fixture')
  assert.equal(environment.VIGO_ROUTE_WORKER_URL, isPackaged ? undefined : '/private/worker')
  assert.equal(environment.NODE_OPTIONS, undefined)
  for (const name of ['LD_PRELOAD', 'LD_LIBRARY_PATH', 'ELECTRON_RUN_AS_NODE']) assert.equal(environment[name], undefined)
  for (const name of ['OPENAI_API_KEY', 'GH_TOKEN', 'AWS_SECRET_ACCESS_KEY']) assert.equal(environment[name], isPackaged ? undefined : 'fixture')
  for (const name of ['PATH', 'SystemRoot', 'TMPDIR', 'LANG']) assert.equal(environment[name], original[name])
  assert.equal(environment.VIGO_NATIVE_ROUTING_KERNEL, '/bundle/server/kernel.node')
  assert.equal(environment.VIGO_API_TRANSPORT, 'memory')
}
assert.equal(original.VIGO_AGENCY_LLM_API_KEY, 'fixture', 'Do not mutate the launching shell')
console.log('Package audit and desktop environment isolation passed.')
