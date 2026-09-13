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
  const reopened = createSkillRegistry({ installedDirectory: directory })
  await reopened.run(custom.id, { routeId: 'exact-route' }, call)
  assert.deepEqual(calls.at(-1), ['service_alerts', { routeId: 'exact-route' }])
  assert.equal(reopened.list().find((item) => item.id === custom.id).instructions, custom.instructions)
  assert.equal(createSkillRegistry().list().find((item) => item.id === 'network-health-summary').enabled, true)
  console.log('Agency skills: installed method packages, typed input binding, persistence, path boundaries, and isolated preferences passed.')
} finally { fs.rmSync(directory, { recursive: true, force: true }) }
