import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { auditPackageFiles } from '../scripts/lib/package-audit.mjs'
import { execFileSync } from 'node:child_process'
import { studioPaths } from '../scripts/lib/studio-paths.mjs'

const root = path.resolve(import.meta.dirname, '..')
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
const sourcePackage = studioPaths(process.env.VIGO_RELEASE_ROOT ?? path.join(root, 'release'), version)
const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-packaged-clean-'))
const packaged = studioPaths(path.join(isolated, 'relocated'), version)
const env = { PATH: process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32') : '/usr/bin:/bin',
  ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}),
  TMPDIR: isolated, TEMP: isolated, TMP: isolated,
  VIGO_CONFIG_DIR: path.join(isolated, 'config'), VIGO_PROJECTS_DIR: path.join(isolated, 'cities'),
  ELECTRON_RUN_AS_NODE: '1', VIGO_NATIVE_ROUTING_KERNEL: packaged.nativeKernel }
try {
  fs.cpSync(sourcePackage.directory, packaged.directory, { recursive: true, verbatimSymlinks: true, mode: fs.constants.COPYFILE_FICLONE })
  const audit = await auditPackageFiles(path.dirname(path.dirname(packaged.program)), { forbiddenRoots: [root] })
  console.log(JSON.stringify({ packageAudit: audit }))
  const capabilities = JSON.parse(execFileSync(packaged.executable, [packaged.program, 'capabilities'], { env, cwd: isolated, encoding: 'utf8', timeout: 30_000 }))
  assert.equal(capabilities.productVersion, version)
  assert.equal(capabilities.apiVersion, '1.0')
  execFileSync(process.execPath, [path.join(root, 'test/check-city-portability.mjs')], {
    env: { ...env, VIGO_TEST_CLI: packaged.program, VIGO_TEST_EXECUTABLE: packaged.executable },
    cwd: isolated, stdio: 'inherit', timeout: 180_000,
  })
  console.log(`Packaged Studio runtime ${version} passed on ${process.platform}:${process.arch}.`)

} finally { fs.rmSync(isolated, { recursive: true, force: true }) }
