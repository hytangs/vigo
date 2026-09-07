import assert from 'node:assert/strict'
import { stationAccessPaths } from '../src/server/station-access.mjs'
import { haversineKm } from '../src/server/geometry-utils.mjs'

// Compare compilation with exhaustive simple-path enumeration. Positive
// cycles cannot improve either time or distance; zero-cost ties collapse.
let randomState = 51023
const random = () => ((randomState = (1664525 * randomState + 1013904223) >>> 0) / 2 ** 32)
for (let fixture = 0; fixture < 40; fixture += 1) {
  const stops = Array.from({ length: 6 }, (_, index) => ({
    stop_id: String(index), lon: random() * 0.01, lat: random() * 0.01,
  }))
  const transfers = new Map(stops.map(stop => [stop.stop_id, []]))
  for (const from of stops) for (const to of stops) {
    if (from !== to && random() < 0.3) transfers.get(from.stop_id).push({
      to_stop_id: to.stop_id, min_transfer_time: Math.floor(random() * 2000), provenance: 'gtfs_pathway',
    })
  }
  const actual = stationAccessPaths({ transfers, stationMembers: new Map(), forbiddenTransferPairs: new Set() }, stops)
  for (let from = 0; from < stops.length; from += 1) {
    const expected = []
    function visit(at, seconds, distanceM, seen) {
      if (at !== from) expected.push({ to: at, seconds, distanceM })
      for (const edge of transfers.get(String(at))) {
        const to = Number(edge.to_stop_id)
        if (seen.has(to)) continue
        const distance = haversineKm([stops[at].lon, stops[at].lat], [stops[to].lon, stops[to].lat]) * 1000
        visit(to, seconds + edge.min_transfer_time, distanceM + distance, new Set([...seen, to]))
      }
    }
    visit(from, 0, 0, new Set([from]))
    const frontier = expected.filter(a => !expected.some(b => a.to === b.to && b.seconds <= a.seconds
      && b.distanceM <= a.distanceM && (b.seconds < a.seconds || b.distanceM < a.distanceM)))
    const normalize = rows => [...new Set(rows.map(({ to, seconds, distanceM }) => `${to}:${seconds}:${distanceM.toFixed(6)}`))].sort()
    assert.deepEqual(normalize(actual.filter(path => path.from === from)), normalize(frontier))
  }
}
console.log('Station walking: 40 directed graphs match exhaustive time/distance frontiers.')
