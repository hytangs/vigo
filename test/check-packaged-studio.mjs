import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { studioPaths } from '../scripts/lib/studio-paths.mjs'

const root = path.resolve(import.meta.dirname, '..')
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
const packaged = studioPaths(process.env.VIGO_RELEASE_ROOT ?? path.join(root, 'release'), version)
const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', VIGO_NATIVE_ROUTING_KERNEL: packaged.nativeKernel }
const capabilities = JSON.parse(execFileSync(packaged.executable, [packaged.program, 'capabilities'], { env, encoding: 'utf8', timeout: 30_000 }))
assert.equal(capabilities.productVersion, version)
assert.equal(capabilities.apiVersion, '1.0')
execFileSync(process.execPath, [path.join(root, 'test/check-city-portability.mjs')], {
  env: { ...env, VIGO_TEST_CLI: packaged.program, VIGO_TEST_EXECUTABLE: packaged.executable },
  stdio: 'inherit', timeout: 180_000,
})
console.log(`Packaged Studio runtime ${version} passed on ${process.platform}:${process.arch}.`)
