import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createSkillRegistry } from '../src/agency/skillRegistry.mjs'
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agency-skills-'))
try {
  const registry = createSkillRegistry({ installedDirectory: directory })
  const calls = []
  const call = async (name, args) => { calls.push([name, args]); return { ok: true, data: {}, provenance: [], warnings: [] } }
  await registry.run('network-health-summary', {}, call)
  assert.deepEqual(calls.map(([name]) => name), ['network_overview', 'anomaly_scan', 'service_alerts'])
  const stamp = '2026-09-13T12:00:00Z'
  const first = { ok: true, data: {}, provenance: ['fixture:first'], generatedAt: stamp, warnings: [] }
  const activities = []
  let attempts = 0
  const failed = await registry.run('network-health-summary', {}, async () => {
    if (++attempts === 2) throw new Error('Observation unavailable')
    return first
  }, (item) => activities.push(item), { generatedAt: stamp })
  assert.equal(failed.status, 'failed')
  assert.equal(attempts, 2, 'Do not run later steps after a failed prerequisite')
  assert.deepEqual(failed.results[0].result, first, 'Completed evidence keeps its original source and timestamp')
  assert.equal(failed.results[1].result.generatedAt, stamp)
  assert.match(activities.at(-1).detail, /Observation unavailable/)
  const rejected = await registry.run('network-health-summary', {}, async () => failed.results[1].result)
  assert.equal(rejected.results.length, 1, 'Returned tool failures stop a skill just like thrown failures')
  assert.equal(rejected.status, 'failed')
  const stop = new AbortController()
  const stopped = await registry.run('network-health-summary', {}, async () => { stop.abort(); return first }, undefined, { signal: stop.signal })
  assert.equal(stopped.status, 'stopped')
  assert.equal(stopped.results.length, 1, 'Stop retains the finished step without invoking the next one')
  const unstarted = await registry.run('network-health-summary', {}, async () => assert.fail('A stopped study must not start'), undefined, { signal: stop.signal })
  assert.equal(unstarted.results.length, 0)
  registry.setEnabled('network-health-summary', false)
  await assert.rejects(registry.run('network-health-summary', {}, call), /disabled/)
  await assert.rejects(registry.run('departure-interval-audit', {}, call), /routeId/)
  await registry.run('service-supply-profile', { serviceDate: '2026-09-13' }, call)
  assert.deepEqual(calls.at(-1), ['service_profile', { serviceDate: '2026-09-13' }])
  const custom = { id: 'custom-route-study', name: 'Custom route study', description: 'Local research method.', instructions: 'Read exact route evidence.', inputs: [{ key: 'routeId', type: 'route', required: true }], steps: [{ tool: 'service_alerts', arguments: { routeId: '$input.routeId' } }] }
  registry.install(custom)
  assert.throws(() => registry.install(custom), /already exists/)
  assert.throws(() => registry.install({ ...custom, id: '../escape' }), /needs an ID/)
  assert.throws(() => registry.install({ ...custom, steps: [{ tool: 'execute_code' }] }), /installed transit tools/)
  assert.throws(() => registry.install({ ...custom, id: 'duplicate-inputs', inputs: [custom.inputs[0], custom.inputs[0]] }), /Unsupported skill inputs/)
  assert.throws(() => registry.install({ ...custom, id: 'invalid-version', version: {} }), /version/)
  fs.mkdirSync(path.join(directory, 'broken-method'))
  fs.writeFileSync(path.join(directory, 'broken-method', 'skill.json'), '{broken')
  const reopened = createSkillRegistry({ installedDirectory: directory })
  assert.match(reopened.warnings()[0], /broken-method.*Invalid JSON/)
  assert.ok(reopened.list().some(skill => skill.id === 'network-health-summary'), 'A damaged external method cannot disable built-in research or the City')
  await reopened.run(custom.id, { routeId: 'exact-route' }, call)
  assert.deepEqual(calls.at(-1), ['service_alerts', { routeId: 'exact-route' }])
  assert.equal(reopened.list().find((item) => item.id === custom.id).instructions, custom.instructions)
  assert.equal(createSkillRegistry().list().find((item) => item.id === 'network-health-summary').enabled, true)
  console.log('Agency skills: installed methods, typed inputs, persistence, partial failures, cancellation, and isolated preferences passed.')
} finally { fs.rmSync(directory, { recursive: true, force: true }) }
