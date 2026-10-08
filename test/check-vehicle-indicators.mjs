import assert from 'node:assert/strict'
import { vehicleAlert, bunchingPartner, occupancyIndicator, vehicleReportFresh } from '../src/agency/vehicleIndicators.ts'
const now = Date.parse('2026-09-16T14:00:00Z') / 1000
const vehicle = { id: 'V', tripId: 'T', routeId: 'R', startDate: '20260916', timestamp: now, sourceFeedTimestamp: now }
const snapshot = { vehicles: [vehicle] }
const event = { type: 'service-gap', vehicleId: 'V', tripId: 'feed\u001fT', routeId: 'feed\u001fR', serviceDate: '2026-09-16', observedAt: new Date(now * 1000).toISOString(), evidence: { observedHeadwaySeconds: 1800 } }
assert.equal(vehicleAlert(vehicle, snapshot, [event], 'spacing', now), event)
for (const patch of [{ timestamp: now - 181 }, { sourceFeedTimestamp: now - 181 }, { tripId: 'other' }, { startDate: undefined }, { startDate: '20260915' }, { startTime: '10:00:00' }, { id: 'other' }, { routeId: 'other' }]) assert.equal(vehicleAlert({ ...vehicle, ...patch }, snapshot, [event], 'spacing', now), undefined)
assert.equal(vehicleAlert(vehicle, { vehicles: [vehicle, { ...vehicle, id: 'other' }] }, [event], 'spacing', now), undefined)
assert.equal(vehicleAlert(vehicle, snapshot, [{ ...event, observedAt: new Date((now - 181) * 1000).toISOString() }], 'spacing', now), undefined)
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
assert.equal(vehicleAlert(leading, pairSnapshot, [pairEvent], 'spacing', now), pairEvent, 'Both members of a bunching pair need the spacing warning')
assert.equal(bunchingPartner(leading, pairSnapshot, pairEvent, now), vehicle, 'The leading member can inspect the same pair')
assert.equal(vehicleAlert(leading, pairSnapshot, [delay], 'delay', now), undefined, 'Do not copy the other vehicle delay')
assert.equal(vehicleAlert(leading, pairSnapshot, [{ ...pairEvent, type: 'service-gap' }], 'spacing', now), undefined, 'A wider gap belongs to the following trip')
for (const patch of [{ tripId: 'next-trip' }, { startDate: '20260915' }, { startTime: 'later' }, { timestamp: now - 181 }]) {
  const other = { ...leading, ...patch }
  assert.equal(vehicleAlert(other, { vehicles: [vehicle, other] }, [pairEvent], 'spacing', now), undefined, 'Pair markers keep exact trip instance and freshness checks')
}
assert.equal(bunchingPartner(vehicle, { vehicles: [vehicle, leading, { ...leading, sourceUrl: 'other' }] }, pairEvent, now), undefined)
assert.equal(bunchingPartner(vehicle, { vehicles: [vehicle, { ...leading, timestamp: now - 181 }] }, pairEvent, now), undefined)
assert.equal(bunchingPartner(vehicle, { vehicles: [vehicle, { ...leading, startDate: '20260915' }] }, pairEvent, now), undefined)
assert.equal(bunchingPartner({ ...vehicle, timestamp: now - 181 }, pairSnapshot, pairEvent, now), undefined, 'A stale caller cannot draw a current pair')
assert.equal(bunchingPartner(vehicle, pairSnapshot, { ...pairEvent, observedAt: new Date((now - 181) * 1000).toISOString() }, now), undefined)
assert.equal(bunchingPartner(vehicle, { vehicles: [vehicle, leading, { ...leading, id: 'conflicting-trip-owner' }] }, pairEvent, now), undefined, 'Ambiguous trip ownership cannot draw a link even if one vehicle ID matches')
const scoped = { ...leading, tripId: 'one\u001fP-trip', routeId: 'one\u001fR' }
const scopedPair = { ...pairEvent, routeId: 'one\u001fR', evidence: { ...pairEvent.evidence, tripIds: ['one\u001fP-trip', 'T'] } }
assert.equal(vehicleAlert(scoped, { vehicles: [scoped, { ...scoped, id: 'other-feed', tripId: 'two\u001fP-trip', routeId: 'two\u001fR' }] }, [scopedPair], 'spacing', now), scopedPair, 'A different scoped trip is not a duplicate of this vehicle')
assert.equal(vehicleAlert({ ...scoped, routeId: 'two\u001fR' }, { vehicles: [{ ...scoped, routeId: 'two\u001fR' }] }, [scopedPair], 'spacing', now), undefined, 'Explicit source namespaces must agree')

const { vehicleOccupancyIndicator } = await import('../src/agency/vehicleIndicators.ts')
assert.deepEqual(vehicleOccupancyIndicator(undefined, [{ occupancyStatus: 'FULL' }, { occupancyStatus: 'NO_DATA_AVAILABLE' }]), { label: '1/2 cars reporting · 1 crowded', crowded: true })
assert.equal(vehicleOccupancyIndicator(undefined, [{}]).label, 'Occupancy unknown')
assert.equal(vehicleOccupancyIndicator('MANY_SEATS_AVAILABLE', [{ occupancyStatus: 'FULL' }]).label, 'Seats available')
