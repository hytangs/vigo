import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import packageJson from '../package.json' with { type: 'json' }
import { startInMemoryVigoApi } from './helpers/in-memory-vigo-api.mjs'
import {
  apiVersion,
  capabilityCatalog,
  cityFormatVersion,
  publicCliCommands,
  resultSchemaVersion,
  supportedReachRasterSizes,
} from '../src/capabilities.mjs'

const root = path.resolve(import.meta.dirname, '..')
const cliPath = path.join(root, 'public', 'vigo.mjs')

assert.deepEqual(capabilityCatalog.product.model, ['City', 'Scenario', 'Query', 'Result'])
assert.deepEqual(capabilityCatalog.product.queryFamilies, ['Route', 'Matrix', 'Reach'])
assert.deepEqual(capabilityCatalog.queries.map((query) => query.id), ['route', 'matrix', 'reach'])
assert.deepEqual(publicCliCommands, ['build', 'capabilities', 'inspect', 'route', 'matrix', 'reach', 'compare'])
assert.deepEqual(supportedReachRasterSizes, [48, 64, 96, 128, 192, 256, 384, 512, 1024])
assert.deepEqual(
  capabilityCatalog.productLine.map((product) => product.label),
  ['VIGO command', 'VIGO Studio', 'VIGO Python'],
)
for (const query of capabilityCatalog.queries) {
  assert.deepEqual(Object.keys(query.interfaces).sort(), ['cli', 'python', 'studio'])
}

const result = JSON.parse(execFileSync(process.execPath, [cliPath, 'capabilities'], { encoding: 'utf8' }))
assert.equal(result.schemaVersion, capabilityCatalog.schemaVersion)
assert.equal(result.productVersion, packageJson.version)
assert.equal(result.apiVersion, apiVersion)
assert.equal(result.cityFormatVersion, cityFormatVersion)
assert.equal(result.resultSchemaVersion, resultSchemaVersion)
assert.deepEqual(result.publicCliCommands, publicCliCommands)
assert.deepEqual(result.reachRasterSizes, supportedReachRasterSizes)
assert.deepEqual(result.queries, capabilityCatalog.queries)

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-capability-api-'))
let api
try {
  api = await startInMemoryVigoApi({
    repositoryRoot: root,
    environment: {
      VIGO_PROJECTS_DIR: path.join(temporary, 'cities'),
      VIGO_CONFIG_DIR: path.join(temporary, 'config'),
    },
  })
  const response = await api.fetch('http://127.0.0.1/api/capabilities')
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.deepEqual(body.capabilities, result)
} finally {
  await api?.stop()
  await fs.rm(temporary, { recursive: true, force: true })
}

console.log('VIGO product model passed.')
