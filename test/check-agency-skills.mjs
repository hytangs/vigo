import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { intelligenceScenario } from './fixtures/intelligence/scenario.mjs'
import { createToolRegistry } from '../src/agency/toolRegistry.mjs'
import { createSkillRegistry } from '../src/agency/skillRegistry.mjs'
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agency-skills-'))
const fixture = intelligenceScenario(directory)
try {
  const registry = createSkillRegistry({ installedDirectory: directory })
  const call = createToolRegistry(fixture)
  const result = await registry.run('network-health-summary', {}, call)
  assert.equal(result.status, 'complete', JSON.stringify(result))
  assert.equal(result.results.length, 3)
  registry.setEnabled('network-health-summary', false)
  await assert.rejects(registry.run('network-health-summary', {}, call), /disabled/)
  await assert.rejects(registry.run('departure-interval-audit', {}, call), /routeId/)
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
  const installedResult = await reopened.run(custom.id, { routeId: '39' }, call)
  assert.equal(installedResult.status, 'complete', JSON.stringify(installedResult))
  assert.equal(reopened.list().find((item) => item.id === custom.id).instructions, custom.instructions)
  assert.equal(createSkillRegistry().list().find((item) => item.id === 'network-health-summary').enabled, true)
  console.log('Agency skills: installed methods, typed inputs, persistence, real tool execution and isolated preferences passed.')
} finally { fixture.close(); fs.rmSync(directory, { recursive: true, force: true }) }
