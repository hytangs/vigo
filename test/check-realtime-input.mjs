import assert from 'node:assert/strict'
import { mbtaRealtimeFeeds, realtimeRequestFromFields } from '../src/app/realtime.ts'

assert.deepEqual(realtimeRequestFromFields(mbtaRealtimeFeeds), { urls: mbtaRealtimeFeeds })
assert.deepEqual(realtimeRequestFromFields({
  vehicles: 'https://transit.example/positions?key=demo',
  tripUpdates: 'https://transit.example/predictions',
  alerts: 'https://transit.example/service',
}), { urls: {
  vehicles: 'https://transit.example/positions?key=demo',
  tripUpdates: 'https://transit.example/predictions',
  alerts: 'https://transit.example/service',
} })
assert.deepEqual(realtimeRequestFromFields({
  vehicles: `Vehicle Positions: ${mbtaRealtimeFeeds.vehicles}`,
  tripUpdates: '',
  alerts: '',
}), { url: mbtaRealtimeFeeds.vehicles })
assert.deepEqual(realtimeRequestFromFields({
  vehicles: Object.values(mbtaRealtimeFeeds).join('\n'),
  tripUpdates: '',
  alerts: '',
}), { urls: mbtaRealtimeFeeds })
const viewer = `https://viz.rt.gtfs.zone/#rt_vp=${encodeURIComponent(mbtaRealtimeFeeds.vehicles)}`
assert.deepEqual(realtimeRequestFromFields({ vehicles: viewer, tripUpdates: '', alerts: '' }), { url: viewer })
assert.deepEqual(realtimeRequestFromFields({ vehicles: mbtaRealtimeFeeds.vehicles, tripUpdates: '', alerts: '  ' }), { url: mbtaRealtimeFeeds.vehicles })
for (const vehicles of ['', 'not a URL', 'file:///tmp/feed.pb', 'https://user:password@transit.example/feed']) {
  assert.throws(() => realtimeRequestFromFields({ vehicles, tripUpdates: mbtaRealtimeFeeds.tripUpdates, alerts: '' }), /valid HTTP or HTTPS URL/)
}
assert.throws(() => realtimeRequestFromFields({ vehicles: mbtaRealtimeFeeds.vehicles, tripUpdates: 'invalid', alerts: '' }), /trip updates/)
console.log('Live feed inputs preserve MBTA presets, labeled pastes, viewer links, and custom endpoint roles.')
