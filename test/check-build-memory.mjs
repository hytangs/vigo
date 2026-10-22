import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildMemoryEnvironment } from '../scripts/lib/build-memory.mjs'

const GiB = 1024 ** 3
const silent = () => {}
const large = { total: 64 * GiB, constrained: 0, available: 32 * GiB }
test('container limit wins over host RAM and user parallelism', () => {
  const messages = []
  const env = buildMemoryEnvironment({ CARGO_BUILD_JOBS: '8', KEEP: 'yes' },
    { ...large, constrained: 2 * GiB }, message => messages.push(message))
  assert.equal(env.CARGO_BUILD_JOBS, '1')
  assert.equal(env.CARGO_PROFILE_RELEASE_LTO, 'false')
  assert.equal(env.CARGO_PROFILE_RELEASE_CODEGEN_UNITS, '16')
  assert.equal(env.KEEP, 'yes')
  assert.match(messages[0], /2\.00 GiB/)
})
test('small machines select low mode', () => {
  assert.equal(buildMemoryEnvironment({}, { ...large, total: 4 * GiB }, silent).CARGO_PROFILE_RELEASE_LTO, 'false')
})
test('temporary pressure limits jobs without changing release optimizations', () => {
  const env = { CARGO_BUILD_JOBS: '8', CARGO_PROFILE_RELEASE_LTO: 'fat', CARGO_PROFILE_RELEASE_CODEGEN_UNITS: '1' }
  assert.deepEqual(buildMemoryEnvironment(env, { ...large, available: GiB }, silent), { ...env, CARGO_BUILD_JOBS: '1' })
})
test('large hosts retain release settings; unknown limits are ignored', () => {
  const env = { CARGO_BUILD_JOBS: '4', CARGO_PROFILE_RELEASE_LTO: 'fat' }
  assert.deepEqual(buildMemoryEnvironment(env, large, silent), env)
  assert.deepEqual(buildMemoryEnvironment(env, { total: 0, constrained: NaN, available: 0 }, silent), env)
})
test('explicit modes override detection and invalid modes fail', () => {
  assert.equal(buildMemoryEnvironment({ VIGO_BUILD_MEMORY: 'low' }, large, silent).CARGO_BUILD_JOBS, '1')
  const full = { VIGO_BUILD_MEMORY: 'full', CARGO_BUILD_JOBS: '2' }
  assert.deepEqual(buildMemoryEnvironment(full, { ...large, constrained: GiB }, silent), full)
  assert.throws(() => buildMemoryEnvironment({ VIGO_BUILD_MEMORY: 'typo' }, large, silent), /must be/)
})
