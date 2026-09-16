import assert from 'node:assert/strict'
import { vehicleGap, vehicleAlert, bunchingPartner, occupancyIndicator, vehicleReportFresh } from '../src/agency/vehicleIndicators.ts'
const now = Date.parse('2026-09-16T14:00:00Z') / 1000
const vehicle = { id: 'V', tripId: 'T', routeId: 'R', startDate: '20260916', timestamp: now, sourceFeedTimestamp: now }
const snapshot = { vehicles: [vehicle] }
const event = { type: 'service-gap', vehicleId: 'V', tripId: 'feed\u001fT', routeId: 'feed\u001fR', serviceDate: '2026-09-16', observedAt: new Date(now * 1000).toISOString(), evidence: { observedHeadwaySeconds: 1800 } }
assert.equal(vehicleGap(vehicle, snapshot, [event], now), event)
for (const patch of [{ timestamp: now - 181 }, { sourceFeedTimestamp: now - 181 }, { tripId: 'other' }, { startDate: undefined }, { startDate: '20260915' }, { startTime: '10:00:00' }, { id: 'other' }, { routeId: 'other' }]) assert.equal(vehicleGap({ ...vehicle, ...patch }, snapshot, [event], now), undefined)
assert.equal(vehicleGap(vehicle, { vehicles: [vehicle, { ...vehicle, id: 'other' }] }, [event], now), undefined)
assert.equal(vehicleGap(vehicle, snapshot, [{ ...event, observedAt: new Date((now - 181) * 1000).toISOString() }], now), undefined)
assert.equal(vehicleReportFresh({ ...vehicle, sourceUrl: 'feed' }, { ...snapshot, feeds: [{ sourceUrl: 'feed', error: 'offline' }] }, now), false)
assert.equal(occupancyIndicator('FULL').crowded, true)
assert.equal(occupancyIndicator('STANDING_ROOM_ONLY').label, 'Standing room')
assert.equal(occupancyIndicator('NO_DATA_AVAILABLE').label, 'Occupancy unknown')
assert.equal(occupancyIndicator().crowded, false)
console.log('Vehicle indicators: exact trip instance, ambiguity, independent freshness, and reported occupancy passed.')

const delay = { ...event, type: 'delay', severity: 'warning', evidence: { delaySeconds: 600 } }
const compressed = { ...event, type: 'bunching', severity: 'critical', evidence: { observedHeadwaySeconds: 120, scheduledHeadwaySeconds: 600 } }
assert.equal(vehicleAlert(vehicle, snapshot, [delay, compressed], 'delay', now), delay)
assert.equal(vehicleAlert(vehicle, snapshot, [delay, compressed], 'spacing', now), compressed)
assert.equal(vehicleAlert(vehicle, snapshot, [{ ...delay, evidence: { ...delay.evidence, tripStartTime: '09:00:00' } }], 'delay', now), undefined)

const leading = { ...vehicle, id: 'P', tripId: 'P-trip', lon: -71, lat: 42 }
const pairEvent = { ...compressed, evidence: { ...compressed.evidence, leadingVehicleId: 'P', tripIds: ['P-trip', 'T'] } }
const pairSnapshot = { vehicles: [vehicle, leading] }
assert.equal(bunchingPartner(vehicle, pairSnapshot, pairEvent, now), leading)
assert.equal(bunchingPartner(vehicle, { vehicles: [vehicle, leading, { ...leading, sourceUrl: 'other' }] }, pairEvent, now), undefined)
assert.equal(bunchingPartner(vehicle, { vehicles: [vehicle, { ...leading, timestamp: now - 181 }] }, pairEvent, now), undefined)
assert.equal(bunchingPartner(vehicle, { vehicles: [vehicle, { ...leading, startDate: '20260915' }] }, pairEvent, now), undefined)

const { vehicleOccupancyIndicator } = await import('../src/agency/vehicleIndicators.ts')
assert.deepEqual(vehicleOccupancyIndicator(undefined, [{ occupancyStatus: 'FULL' }, { occupancyStatus: 'NO_DATA_AVAILABLE' }]), { label: '1/2 cars reporting · 1 crowded', crowded: true })
assert.equal(vehicleOccupancyIndicator(undefined, [{}]).label, 'Occupancy unknown')
assert.equal(vehicleOccupancyIndicator('MANY_SEATS_AVAILABLE', [{ occupancyStatus: 'FULL' }]).label, 'Seats available')
