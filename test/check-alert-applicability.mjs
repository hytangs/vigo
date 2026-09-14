import assert from 'node:assert/strict'
import { alertSelectors, alertInScope } from '../src/agency/alertApplicability.mjs'
import { eventInSelection, selectedStopIds } from '../src/agency/workspaceSelection.mjs'

const routes = [{ route_id: 'R1', route_type: 3, agency_id: 'A' }, { route_id: 'R2', route_type: 2, agency_id: 'B' }]
const stops = [{ stop_id: 'S1', parent_station: 'P' }, { stop_id: 'S2' }, { stop_id: 'P' }]
const trips = [{ trip_id: 'T1', route_id: 'R1', direction_id: 0 }]
const context = { routes, stops, trips, routeIndex: new Map(routes.map(row => [row.route_id, row])), stopIndex: new Map(stops.map(row => [row.stop_id, row])), scopes: [''] }
const event = (informedEntities, sourceScope) => ({ type: 'service-alert', selectors: alertSelectors(context, { informedEntities, sourceScope }) })
const match = (notice, routeId, stopId, rest = {}) => alertInScope(notice, { routeId, stopIds: stopId ? new Set([stopId]) : undefined, ...rest })
const pairs = event([{ routeId: 'R1', stopId: 'S1' }, { routeId: 'R2', stopId: 'S2' }])
assert.equal(match(pairs, 'R1', 'S1'), true)
assert.equal(match(pairs, 'R2', 'S2'), true)
assert.equal(match(pairs, 'R1', 'S2'), false)
assert.equal(match(pairs, 'R2', 'S1'), false)
assert.equal(match(pairs, 'R1'), true, 'A route overview can show a stop-specific notice with its selector retained')
const selection = { route: { id: 'R1' }, stop: { id: 'P' } }
assert.equal(eventInSelection(pairs, selection, selectedStopIds(context, selection)), true)
assert.equal(eventInSelection(pairs, { ...selection, route: { id: 'R2' } }, selectedStopIds(context, selection)), false)
const directional = event([{ routeId: 'R1', directionId: 0 }])
assert.equal(match(directional, 'R1', null, { directionId: 0 }), true)
assert.equal(match(directional, 'R1', null, { directionId: 1 }), false)
assert.equal(match(event([{ trip: { tripId: 'T1', startDate: '20260913' } }]), 'R1', null, { tripId: 'T1', serviceDate: '2026-09-13' }), true)
assert.equal(match(event([{ trip: { tripId: 'T1', startDate: '20260913' } }]), 'R1', null, { tripId: 'T1', serviceDate: '2026-09-14' }), false)
assert.equal(match(event([{ trip: { tripId: 'T1' } }]), 'R1', null, { tripId: 'OTHER' }), false)
assert.equal(match(event([{ routeId: 'R2', trip: { tripId: 'T1' } }]), 'R2'), false)
assert.equal(match(event([{ routeId: 'R1', routeType: 2 }]), 'R1'), false)
assert.equal(match(event([{ routeType: 3 }]), 'R1'), true)
assert.equal(match(event([{ routeType: 3 }]), 'R2'), false)
assert.equal(match(event([{ agencyId: 'A' }]), 'R1'), true)
assert.equal(match(event([{ agencyId: 'A' }]), 'R2'), false)
assert.equal(match(event([{ routeId: 'R1', agencyId: 'unknown' }]), 'R1'), false)
assert.equal(match(event([{ routeId: 'R1' }], 'other-feed'), 'R1'), false)
assert.equal(match(event([{}]), 'R1'), false)
const unresolved = alertSelectors(context, { routeIds: ['R1', 'R2'], stopIds: ['S1', 'S2'] })
assert.deepEqual(unresolved, [], 'Ambiguous legacy lists cannot reconstruct route-stop pairs')
const merged = { ...context, scopes: ['north', 'south'], routes: ['north', 'south'].map(scope => ({ route_id: `${scope}\u001fR`, route_type: 3 })), stops: [], trips: [] }
merged.routeIndex = new Map(merged.routes.map(row => [row.route_id, row]))
assert.equal(alertInScope({ selectors: alertSelectors(merged, { informedEntities: [{ routeId: 'R' }] }) }, { routeId: 'north\u001fR' }), false)
assert.equal(alertInScope({ selectors: alertSelectors(merged, { sourceScope: 'north', informedEntities: [{ routeId: 'R' }] }) }, { routeId: 'north\u001fR' }), true)
assert.equal(alertInScope({ selectors: alertSelectors(merged, { sourceScope: 'north', informedEntities: [{ routeType: 3 }] }) }, { routeId: 'south\u001fR' }), false)
assert.equal(alertInScope({ selectors: alertSelectors(merged, { sourceScope: 'north', informedEntities: [{ agencyId: 'A', routeId: 'R' }] }) }, { routeId: 'north\u001fR' }), false, 'Missing agency ownership is unresolved, not broadened')
console.log('Alert selectors: conjunctions, parent stations, direction, trip/date, route type, agency, legacy ambiguity and feed isolation passed.')
