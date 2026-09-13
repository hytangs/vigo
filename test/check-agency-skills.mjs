import assert from 'node:assert/strict'
import { createSkillRegistry } from '../src/agency/skillRegistry.mjs'
const registry = createSkillRegistry()
const calls = []
const call = async (name) => { calls.push(name); return { ok: true, data: {}, provenance: [], warnings: [] } }
await registry.run('network-health-summary', {}, call)
assert.deepEqual(calls, ['network_overview', 'anomaly_scan'])
registry.setEnabled('network-health-summary', false)
await assert.rejects(registry.run('network-health-summary', {}, call), /disabled/)
await assert.rejects(registry.run('disruption-triage', {}, call), /routeId/)
await assert.rejects(registry.run('headway-control-advisor', {}, call), /unavailable/)
assert.throws(() => registry.setEnabled('headway-control-advisor', true), /not installed/)
assert.equal(createSkillRegistry().list()[0].enabled, true, 'City skill settings remain isolated')
console.log('Agency skills: workflow composition, inputs, disabling, isolation, unavailable adapter passed.')
