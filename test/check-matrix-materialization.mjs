import assert from 'node:assert/strict'
import { MatrixJourneyCache } from '../src/server/gtfs/matrix-materialization.mjs'

const origin = { lat: 42, lon: -71, name: 'Origin' }
const destination = { lat: 43, lon: -72 }
const makeJourney = () => ({ legs: [{ geometry: [[42, -71]], duration: 12 }] })
const cache = new MatrixJourneyCache()
const first = cache.materialize(origin, destination, makeJourney)
const repeated = cache.materialize(origin, destination, () => assert.fail('Repeated pair was rebuilt'))
assert.deepEqual(repeated, first)
first.legs[0].geometry[0][0] = 99
assert.equal(repeated.legs[0].geometry[0][0], 42)
cache.materialize({ ...origin, name: 'Another label' }, destination, makeJourney)
assert.equal(cache.materializations, 2)
assert.equal(cache.reuses, 1)

for (const options of [{ enabled: false }, { maximumKeyBytes: 0 }, { maximumEntries: 0 }]) {
  const bounded = new MatrixJourneyCache(options)
  bounded.materialize(origin, destination, makeJourney)
  bounded.materialize(origin, destination, makeJourney)
  assert.equal(bounded.materializations, 2)
  assert.equal(bounded.reuses, 0)
}
const bounded = new MatrixJourneyCache({ maximumEntries: 1 })
bounded.materialize(origin, destination, makeJourney)
bounded.materialize(destination, origin, makeJourney)
bounded.materialize(destination, origin, makeJourney)
bounded.materialize(origin, destination, () => assert.fail('Retained pair was evicted'))
assert.equal(bounded.materializations, 3)
assert.equal(bounded.reuses, 1)
const failed = new MatrixJourneyCache()
assert.throws(() => failed.materialize(origin, destination, () => { throw new Error('failed') }), /failed/)
assert.equal(failed.materializations, 0)
assert.equal(failed.materialize(origin, destination, () => null), null)
assert.equal(failed.materialize(origin, destination, () => assert.fail('Null was not cached')), null)
console.log('Matrix materialization reuse, isolation, and memory bounds passed.')
