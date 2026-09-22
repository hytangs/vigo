import assert from 'node:assert/strict'
import { setMapSourceData, setStreetMapSourceData } from '../src/app/mapSourceUpdates.ts'

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

const streetData = cutoff => ({ type: 'FeatureCollection', features: [{
  type: 'Feature', properties: { cutoff }, geometry: { type: 'MultiLineString', coordinates: [[[0, 0], [1, 1]]] },
}] })
const streets45 = streetData(45), streets60 = streetData(60), streets90 = streetData(90)
const streetSent = [], completions = []
const streetSource = { setData(data) {
  streetSent.push(data)
  return new Promise(resolve => completions.push(resolve))
} }
const complete = async () => { completions.shift()(); await new Promise(setImmediate) }
setStreetMapSourceData(streetSource, streets45)
assert.deepEqual(streetSent, [streets45], 'Initial street data loads directly')
await complete()
setStreetMapSourceData(streetSource, streets60)
assert.equal(streetSent.at(-1).features.length, 0, 'Release the old worker index before constructing its replacement')
assert.equal(streetSent.includes(streets60), false, 'The next index cannot start while the old index is being released')
setStreetMapSourceData(streetSource, streets90)
await complete()
assert.equal(streetSent.at(-1), streets90, 'Rapid cutoff changes keep only the latest selection')
assert.equal(streetSent.includes(streets60), false, 'A superseded cutoff must never be sent to the worker')
setStreetMapSourceData(streetSource, streets45)
assert.equal(streetSent.at(-1), streets90, 'In-flight street loads are serialized')
await complete()
assert.equal(streetSent.at(-1).features.length, 0)
// Changing the departure or leaving the street view clears the result even
// when another cutoff is waiting for the worker; it must not reappear later.
setStreetMapSourceData(streetSource, first)
await complete()
assert.equal(streetSent.at(-1), first)
await complete()
const sentCount = streetSent.length
setStreetMapSourceData(streetSource, first)
assert.equal(streetSent.length, sentCount, 'Unchanged street collections are not resubmitted')
setStreetMapSourceData(streetSource, streets60)
assert.equal(streetSent.at(-1), streets60, 'An empty source accepts the next result directly')
await complete()
const replacementSent = []
setStreetMapSourceData({ setData: data => { replacementSent.push(data); return Promise.resolve() } }, streets60)
assert.deepEqual(replacementSent, [streets60], 'A rebuilt street source receives the current result')
console.log('Street cutoff updates passed: previous index released, latest selection wins, loads serialized, and invalidated results stay cleared.')
