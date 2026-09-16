import assert from 'node:assert/strict'
import { networkNarrative } from '../src/agency/networkNarrative.mjs'
const routes = ['22', '23', '28', '44', '45'].map(id => ({ id, name: id, laterTrips: 1, measuredTrips: 1, continued: [] }))
const diagnosis = { network: { measuredTrips: 5, laterTrips: 5, cancelledTrips: 4 }, coverage: { measuredRoutes: 66, scheduledTrips: 200, reportingScheduledTrips: 49, unknownTrips: 151, reportingShare: null }, routes, window: { minutes: 30 }, concentrations: [{ id: 'area', name: 'Tremont → Ruggles', routeIds: routes.map(r => r.id), tripCount: 12, maxDelaySeconds: 1860 }] }
const narrative = networkNarrative(diagnosis)
assert.equal(narrative.overview, 'Delays affect 5 of 66 routes with usable predictions. 4 scheduled trips are reported cancelled in the next 30 minutes.')
assert.match(narrative.sections[0].text, /routes 22, 23, 28, 44, and 45 pass through this area/)
assert.doesNotMatch(narrative.sections[0].text, /caused|because|shared-area/)
assert.match(narrative.coverage, /151 scheduled trips have no usable prediction or cancellation report/)
routes[0].widest = { predictedSeconds: 1560, scheduledSeconds: 780, maxIncreaseSeconds: 780, stopName: 'Prentiss Rd' }
assert.match(networkNarrative(diagnosis).sections.find(s => s.id === 'spacing').text, /26 minutes, compared with 13 minutes.*following service.*unknown/)
console.log('Network narrative: explicit denominators, natural route lists, noncausal concentration and unknown recovery passed.')
