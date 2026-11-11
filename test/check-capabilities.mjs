import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import packageJson from '../package.json' with { type: 'json' }
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
assert.deepEqual(publicCliCommands, ['build', 'build-scenarios', 'capabilities', 'inspect', 'route', 'matrix', 'reach', 'stream', 'compare'])
assert.deepEqual(supportedReachRasterSizes, [48, 64, 96, 128, 192, 256, 384, 512, 1024])
assert.deepEqual(
  capabilityCatalog.productLine.map((product) => product.label),
  ['VIGO Engine', 'VIGO Studio', 'VIGO Python'],
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

console.log('VIGO product model passed.')
