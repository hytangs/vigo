import { numeric } from '../number-utils.mjs'

// Internal migration switch. Fail closed on a typo; never fall back after a Rust error.
export function gtfsConnectionCompilerBackend() {
  const backend = process.env.VIGO_GTFS_CONNECTION_COMPILER ?? 'js'
  if (backend !== 'js' && backend !== 'rust') throw new Error('VIGO_GTFS_CONNECTION_COMPILER must be js or rust.')
  return backend
}

// Retained 0.5.2 compiler, used as the default and as the migration oracle.
export function compileGtfsConnectionsJs({ db, stage, excludedTripIds, onProgress }) {
  const tripLookup = db.prepare('SELECT route_id, service_id, direction_id FROM trips WHERE trip_id=?')
  const frequencyLookup = db.prepare('SELECT start_time, end_time, headway_secs, exact_times FROM frequencies WHERE trip_id=? ORDER BY start_time, end_time, headway_secs')
  const insertFrequencyTrip = db.prepare('INSERT OR IGNORE INTO trips VALUES(?,?,?,?)')
  const tripShapeLookup = db.prepare('SELECT shape_id FROM trip_shapes WHERE trip_id=?')
  const insertFrequencyTripShape = db.prepare('INSERT OR IGNORE INTO trip_shapes VALUES(?,?)')
  const copyFrequencyTripDetails = db.prepare('INSERT INTO trip_details SELECT ?,headsign,short_name FROM trip_details WHERE trip_id=?')
  const knownStopIds = new Set(db.prepare('SELECT stop_id FROM stops').all().map((row) => row.stop_id))
  const insertConnection = db.prepare('INSERT INTO connections VALUES(?,?,?,?,?,?,?,?,?)')
  const insertConnectionPermission = db.prepare('INSERT INTO connection_permissions VALUES(?,?,?,?)')
  const rows = stage.prepare(`
    SELECT trip_id, stop_sequence, stop_id, arrival, departure,
      can_board, can_alight, pickup_type, drop_off_type
    FROM stop_times
    ORDER BY trip_id, stop_sequence
  `).iterate()
  let previous = null
  let trip = null
  let connectionCount = 0
  let bridgedUntimedGapCount = 0
  let exactFrequencyExpandedTripCount = 0
  let exactFrequencyExpandedConnectionCount = 0
  const frequencyTripIds = new Set()
  const exactFrequencyInstances = (templateTripId, templateStartSeconds) => {
    if (!Number.isFinite(templateStartSeconds)) return []
    const instances = frequencyLookup.all(templateTripId)
      .filter((frequency) => Number(frequency.exact_times ?? 0) === 1)
      .flatMap((frequency) => {
        const start = Number(frequency.start_time)
        const end = Number(frequency.end_time)
        const headway = Number(frequency.headway_secs)
        const count = Math.floor((end - start) / headway) + 1
        if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(headway) || count <= 0 || count > 100_000) {
          throw new Error(`GTFS exact frequency window for trip ${templateTripId} is outside the supported expansion bound.`)
        }
        return Array.from({ length: count }, (_, index) => {
          const departure = start + index * headway
          return { tripId: `${templateTripId}#frequency-${departure}`, offsetSeconds: departure - templateStartSeconds }
        })
      })
    return [...new Map(instances.map((instance) => [instance.tripId, instance])).values()]
  }
  db.exec('BEGIN IMMEDIATE')
  for (const row of rows) {
    if (!knownStopIds.has(row.stop_id)) {
      throw new Error(`Broken GTFS reference stop_times.stop_id -> stops.stop_id: trip ${row.trip_id || '(missing)'} references ${row.stop_id || '(missing)'}.`)
    }
    if (!previous || previous.trip_id !== row.trip_id) {
      const referencedTrip = tripLookup.get(row.trip_id)
      if (!referencedTrip) {
        throw new Error(`Broken GTFS reference stop_times.trip_id -> trips.trip_id: ${row.trip_id || '(missing)'}.`)
      }
      trip = excludedTripIds.has(row.trip_id) ? null : {
        ...referencedTrip,
        frequencyInstances: null,
        frequencyInstancesReady: false,
      }
      previous = row
      continue
    }
    if (numeric(row.stop_sequence, -1) <= numeric(previous.stop_sequence, -1)) {
      throw new Error(`Non-increasing or duplicate GTFS stop_sequence for trip ${row.trip_id} at ${row.stop_sequence}.`)
    }
    const departure = previous.departure ?? previous.arrival
    const arrival = row.arrival ?? row.departure
    if (departure !== null && arrival !== null && arrival < departure) {
      throw new Error(`Non-monotone GTFS trip time for trip ${row.trip_id} between stop_sequence ${previous.stop_sequence} and ${row.stop_sequence}.`)
    }
    if (trip && !trip.frequencyInstancesReady) {
      const templateStartSeconds = previous.departure ?? previous.arrival
      const instances = exactFrequencyInstances(row.trip_id, Number(templateStartSeconds))
      trip.frequencyInstances = instances.length ? instances : [{ tripId: row.trip_id, offsetSeconds: 0 }]
      trip.frequencyInstancesReady = true
      for (const instance of instances) {
        if (frequencyTripIds.has(instance.tripId)) continue
        frequencyTripIds.add(instance.tripId)
        insertFrequencyTrip.run(instance.tripId, trip.route_id, trip.service_id, trip.direction_id)
        copyFrequencyTripDetails.run(instance.tripId, row.trip_id)
        const shape = tripShapeLookup.get(row.trip_id)?.shape_id
        if (shape) insertFrequencyTripShape.run(instance.tripId, shape)
        exactFrequencyExpandedTripCount += 1
      }
    }
    if (trip && departure !== null && arrival !== null && arrival >= departure) {
      for (const instance of trip.frequencyInstances ?? []) {
        const instanceDeparture = departure + Number(instance.offsetSeconds ?? 0)
        const instanceArrival = arrival + Number(instance.offsetSeconds ?? 0)
        insertConnection.run(instanceDeparture, instanceArrival, instance.tripId, trip.route_id, trip.service_id, trip.direction_id, previous.stop_id, row.stop_id, previous.stop_sequence)
        if (previous.can_board !== 1 || row.can_alight !== 1) {
          insertConnectionPermission.run(
            instance.tripId,
            previous.stop_sequence,
            previous.can_board === 1 ? 1 : 0,
            row.can_alight === 1 ? 1 : 0,
          )
        }
        connectionCount += 1
        if (instance.tripId !== row.trip_id) exactFrequencyExpandedConnectionCount += 1
      }
      if (numeric(row.stop_sequence) > numeric(previous.stop_sequence) + 1) bridgedUntimedGapCount += 1
      if (connectionCount % 250_000 === 0) {
        db.exec('COMMIT; BEGIN IMMEDIATE')
        onProgress?.(connectionCount)
      }
    }
    if (row.arrival !== null || row.departure !== null) previous = row
  }
  db.exec('COMMIT')
  return { connectionCount, bridgedUntimedGapCount, exactFrequencyExpandedTripCount, exactFrequencyExpandedConnectionCount }
}
