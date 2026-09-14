import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { createAgencyFixture } from '../agency.mjs'
import { AgencyContext } from '../../../src/agency/agencyContext.mjs'
import { deriveOperationalState } from '../../../src/agency/realtimeIntelligence.mjs'
import { createNotebook } from '../../../src/agency/notebook.mjs'
import { createOperationsStore } from '../../../src/agency/operationsStore.mjs'
import { workspaceSelection } from '../../../src/agency/workspaceSelection.mjs'

// Deliberately synthetic. Familiar labels exercise the submitted questions;
// geometry, timetable, delays and notices are NOT Boston service records.
export function intelligenceScenario(directory) {
  const file = path.join(directory, 'schedule.sqlite')
  createAgencyFixture(file)
  const db = new DatabaseSync(file)
  db.exec(`DELETE FROM routes; DELETE FROM stops; DELETE FROM trips; DELETE FROM connections;
    UPDATE metadata SET value='["America/New_York"]' WHERE key='agencyTimezones';`)
  const stops = [['A', 'Forest Hills'], ['B', 'Huntington Avenue'], ['C', 'Harvard Square'], ['D', 'Kenmore'], ['E', 'Park Street']]
  for (const [i, [id, name]] of stops.entries()) db.prepare('INSERT INTO stops VALUES(?,?,?,?,?,?,?)').run(id, name, 42.34 + i * .005, -71.10 + i * .005, '', 0, '')
  const now = Date.parse('2026-09-14T12:00:00Z') / 1000
  const tripSource = 'https://example.org/trips', vehicleSource = 'https://example.org/vehicles', alertSource = 'https://example.org/alerts'
  const snapshot = { fetchedAt: new Date(now * 1000).toISOString(), feedTimestamp: now, feeds: [tripSource, vehicleSource, alertSource].map((sourceUrl, i) => ({ sourceUrl, kind: ['tripUpdates', 'vehicles', 'alerts'][i], feedTimestamp: now })), tripUpdates: [], vehicles: [], alerts: [] }
  for (const route of ['39', '66', '55', '57', '9', 'Red', '1']) {
    db.prepare('INSERT INTO routes VALUES(?,?,?,?,?)').run(route, route === 'Red' ? 'Red Line' : route, `Synthetic service ${route}`, route === 'Red' ? 1 : 3, '557755')
    for (let t = 0; t < 12; t++) {
      const trip = `${route}-${t}`, start = 27900 + t * 600
      db.prepare('INSERT INTO trips VALUES(?,?,?,?)').run(trip, route, 'S', '0')
      for (let s = 0; s < 4; s++) db.prepare('INSERT INTO connections VALUES(?,?,?,?,?,?,?,?,?)').run(start + s * 300, start + s * 300 + 240, trip, route, 'S', '0', stops[s][0], stops[s + 1][0], s + 1)
      if (t > 5 || route === '57' && t === 3) continue
      const cancelled = route === '66' && t === 2
      const delay = route === '39' ? t === 0 ? 1200 : t === 1 ? 900 : 300 : ['55', '57'].includes(route) ? 600 : route === '66' ? t === 1 ? 900 : 0 : 0
      const vehicleId = route === '39' && t === 0 ? '1827' : `vehicle-${trip}`
      snapshot.tripUpdates.push({ id: trip, tripId: trip, routeId: route, directionId: 0, startDate: '20260914', timestamp: now, sourceUrl: tripSource, vehicleId,
        ...(cancelled ? { scheduleRelationship: 'CANCELED', stopTimeUpdates: [] } : { stopTimeUpdates: stops.slice(0, 4).map(([stopId], s) => ({ stopId, stopSequence: s + 1, departure: { delay } })) }) })
      if (!cancelled) snapshot.vehicles.push({ id: vehicleId, label: vehicleId, tripId: trip, routeId: route, directionId: 0, startDate: '20260914', timestamp: now, sourceUrl: vehicleSource, stopId: 'B', currentStopSequence: 2, currentStatus: 'IN_TRANSIT_TO', latitude: 42.345, longitude: -71.095, occupancyStatus: route === '66' && t === 1 ? 'FULL' : undefined })
    }
  }
  snapshot.alerts.push({ id: 'works', sourceUrl: alertSource, header: 'Route 39 delays near Huntington Avenue', description: 'Road work affects Route 39 near Huntington Avenue. No restoration time is available.', routeIds: ['39'], stopIds: ['B'], cause: 'CONSTRUCTION', effect: 'SIGNIFICANT_DELAYS', activePeriods: [{ start: now - 1800, end: now + 3600 }] },
    { id: 'access', sourceUrl: alertSource, header: 'Park Street elevator unavailable', description: 'Elevator out of service. Ask station staff about accessible alternatives.', routeIds: ['Red'], stopIds: ['E'], cause: 'MAINTENANCE', effect: 'ACCESSIBILITY_ISSUE', activePeriods: [{ start: now - 3600 }] })
  db.close()
  const context = new AgencyContext(file, 'Synthetic evaluation network')
  const state = deriveOperationalState(context, snapshot, now)
  state.tripHistory = { '39-0/2026-09-14': [8, 4, 0].map((ago, i) => ({ at: new Date((now - ago * 60) * 1000).toISOString(), delaySeconds: [600, 900, 1200][i], stopId: 'C', tripId: '39-0', serviceDate: '2026-09-14' })) }
  const notebook = createNotebook(path.join(directory, 'agency'))
  const operations = createOperationsStore(notebook.directory, 'evaluation', () => now * 1000)
  return { context, state, snapshot, notebook, operations, scheduleIdentity: 'synthetic-evaluation-v1',
    selection: workspaceSelection(context, { routeId: '39', stopId: 'C' }),
    close() { operations.close(); notebook.close(); context.close() } }
}
