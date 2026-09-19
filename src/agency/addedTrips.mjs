import { rawId, scopeOf } from './agencyContext.mjs'
import { validDate } from './agencyClock.mjs'

export const isAddedTrip = record => ['ADDED', 'NEW'].includes(record?.scheduleRelationship)
const indexes = new WeakMap()
const finite = value => typeof value === 'number' && Number.isFinite(value)

// Realtime-only trips supply their own calls. Static services, headsigns and
// scheduled times must never be borrowed from a similar trip on the route.
export function addedTripIndex(context, snapshot, isFresh) {
  let indexed = indexes.get(context)
  if (!indexed) {
    const index = rows => {
      const result = new Map()
      for (const [id, row] of rows) result.set(rawId(id), [...(result.get(rawId(id)) ?? []), row])
      return result
    }
    indexed = { routes: index(context.routeIndex), stops: index(context.stopIndex) }
    indexes.set(context, indexed)
  }
  const exact = (rows, field, id, scope) => (rows.get(rawId(id)) ?? []).filter(row =>
    (!String(id).includes('\u001f') || row[field] === id) && (scope === undefined || scopeOf(row[field]) === scope))
  const identity = (record, requireAdded = false) => {
    if ((requireAdded && !isAddedTrip(record)) || !record.tripId || !record.routeId || !record.startDate || !context.timezone) return null
    const date = String(record.startDate).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3')
    if (!validDate(date)) return null
    const routes = exact(indexed.routes, 'route_id', record.routeId, record.sourceScope || (String(record.tripId).includes('\u001f') ? scopeOf(record.tripId) : undefined))
    if (routes.length !== 1) return null
    const route = routes[0], scope = scopeOf(route.route_id)
    const id = scope ? `${scope}\u001f${rawId(record.tripId)}` : rawId(record.tripId)
    if (context.tripById.has(id)) return null
    return { id, routeId: route.route_id, scope, serviceDate: date, key: JSON.stringify([id, date]) }
  }
  const entries = new Map()
  for (const [kind, records] of [['updates', snapshot?.tripUpdates], ['vehicles', snapshot?.vehicles]]) {
    for (const record of records ?? []) {
      const match = identity(record, true)
      if (!match) continue
      let entry = entries.get(match.key)
      if (!entry) { entry = { ...match, updates: [], vehicles: [], calls: [], warnings: [] }; entries.set(match.key, entry) }
      entry[kind].push(record)
    }
  }
  // Related cancellations and descriptors without a relationship still refer
  // to an already declared added trip; they cannot create one themselves.
  for (const [kind, records] of [['updates', snapshot?.tripUpdates], ['vehicles', snapshot?.vehicles]]) {
    for (const record of records ?? []) {
      if (isAddedTrip(record)) continue
      const match = identity(record), entry = match && entries.get(match.key)
      if (entry) entry[kind].push(record)
    }
  }
  for (const entry of entries.values()) {
    const records = [...entry.updates, ...entry.vehicles]
    const directions = [...new Set(records.filter(row => row.directionId !== undefined).map(row => String(row.directionId)))]
    const starts = new Set(records.map(row => row.startTime).filter(Boolean))
    entry.ambiguous = directions.length > 1 || starts.size > 1 || entry.updates.length > 1
    entry.directionId = directions.length === 1 ? directions[0] : null
    entry.trip = { trip_id: entry.id, route_id: entry.routeId, direction_id: entry.directionId }
    if (entry.ambiguous) { entry.warnings.push('Multiple reports disagree on this added trip; its stop sequence and predictions are unresolved.'); continue }
    const update = entry.updates[0]
    const calls = []
    let invalid = false
    for (const report of update?.stopTimeUpdates ?? []) {
      const stops = exact(indexed.stops, 'stop_id', report.stopId, entry.scope)
      if (!report.stopId || stops.length !== 1 || (report.stopSequence !== undefined && !finite(report.stopSequence))) { invalid = true; break }
      calls.push({ stopId: stops[0].stop_id, sequence: report.stopSequence ?? null, arrival: null, departure: null, report })
    }
    if (calls.length && calls.every(call => finite(call.sequence))) {
      calls.sort((a, b) => a.sequence - b.sequence)
      if (calls.some((call, index) => index && call.sequence === calls[index - 1].sequence)) invalid = true
    } else if (calls.some(call => finite(call.sequence))) invalid = true
    if (invalid) { entry.warnings.push('The added trip has unknown stops or an ambiguous stop sequence.'); continue }
    // A producer may omit passed calls. Retain the currently reported stop when
    // its sequence establishes where it belongs in the remaining reported calls.
    for (const vehicle of entry.vehicles.filter(row => isFresh(row, true))) {
      const stops = exact(indexed.stops, 'stop_id', vehicle.stopId, entry.scope)
      if (stops.length !== 1 || !vehicle.stopId) continue
      const existing = calls.find(call => call.sequence === vehicle.currentStopSequence)
      if (existing) continue
      if (calls.length && (!finite(vehicle.currentStopSequence) || !calls.every(call => finite(call.sequence)))) continue
      if (!calls.length || !calls.some(call => call.stopId === stops[0].stop_id && !finite(call.sequence))) {
        calls.push({ stopId: stops[0].stop_id, sequence: vehicle.currentStopSequence ?? null, arrival: null, departure: null })
      }
    }
    if (calls.every(call => finite(call.sequence))) calls.sort((a, b) => a.sequence - b.sequence)
    entry.calls = calls
    entry.update = update
    entry.current = Boolean(update && isFresh(update))
    entry.warnings.push('Added service: only reported stops are shown; scheduled times and delay are unavailable.')
  }
  return { entries: [...entries.values()], get(record) { const match = identity(record); return match ? entries.get(match.key) : undefined } }
}
