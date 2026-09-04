import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const compiled = ts.transpileModule(
  readFileSync(new URL('../src/app/mapSourceUpdates.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } },
).outputText
const { setMapSourceData } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
const sent = []
const source = { setData: (data) => sent.push(data) }
const first = { type: 'FeatureCollection', features: [] }
const second = { type: 'FeatureCollection', features: [] }
setMapSourceData(source, first)
for (let i = 0; i < 100; i += 1) setMapSourceData(source, first)
assert.equal(sent.length, 1)
setMapSourceData(source, second)
setMapSourceData(source, first)
assert.deepEqual(sent, [first, second, first])
setMapSourceData({ setData: (data) => sent.push(data) }, first)
assert.equal(sent.length, 4, 'A replacement source must receive its data.')
let attempts = 0
const recovering = { setData: () => { if (++attempts === 1) throw new Error('Style loading') } }
assert.throws(() => setMapSourceData(recovering, first), /Style loading/)
setMapSourceData(recovering, first)
assert.equal(attempts, 2, 'Failed submissions must be retried.')
console.log('Map source updates passed: unchanged collections skipped; changes, replacement sources, and retries submitted.')
