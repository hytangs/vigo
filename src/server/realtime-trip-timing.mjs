// Resolve GTFS-RT against one identified scheduled trip, before native routing.
// Arrival and departure remain distinct; delay propagates forward until a new
// prediction or NO_DATA. No inference about causes or vehicle positions occurs.
const finite = value => value !== undefined && value !== null && value !== '' && Number.isFinite(Number(value))
  ? Number(value) : undefined
const relationship = value => typeof value === 'number'
  ? ['SCHEDULED', 'SKIPPED', 'NO_DATA', 'UNSCHEDULED'][value] ?? 'UNKNOWN'
  : String(value || 'SCHEDULED').trim().toUpperCase()
const localId = value => String(value).split('\u001f').at(-1)

function eventDelay(event, scheduled, toServiceSeconds) {
  if (finite(event?.time) !== undefined) {
    const time = toServiceSeconds(Number(event.time))
    if (Number.isFinite(time)) return time - scheduled
  }
  return finite(event?.delay)
}

export function resolveRealtimeTripTimes(rows, update, toServiceSeconds) {
  const bySequence = new Map(), byStop = new Map()
  const updates = update.stopTimeUpdates ?? []
  if (!Array.isArray(updates)) return { status: 'invalid' }
  for (const stopUpdate of updates) {
    if (!['SCHEDULED', 'SKIPPED', 'NO_DATA'].includes(relationship(stopUpdate?.scheduleRelationship))) {
      return { status: 'unsupported' }
    }
    const sequence = finite(stopUpdate?.stopSequence)
    // A stop sequence identifies one call on a loop. Do not also apply that
    // prediction to other occurrences of the same stop through an ID fallback.
    const index = Number.isInteger(sequence) ? bySequence : byStop
    const key = Number.isInteger(sequence) ? sequence : localId(stopUpdate?.stopId ?? '')
    if (key === '' || index.has(key)) return { status: 'invalid' }
    index.set(key, stopUpdate)
  }
  if (byStop.size) {
    const seen = new Set()
    for (const row of rows) {
      const id = localId(row.stop_id)
      if (seen.has(id) && byStop.has(id)) return { status: 'invalid' }
      seen.add(id)
    }
  }
  const stopTimes = []
  let delay = finite(update.delaySeconds)
  let previousDeparture = -Infinity
  for (const row of rows) {
    const sequence = Number(row.stop_sequence), stopId = String(row.stop_id)
    const stopUpdate = bySequence.get(sequence) ?? byStop.get(localId(stopId))
    if (stopUpdate?.stopId && localId(stopUpdate.stopId) !== localId(stopId)) return { status: 'invalid' }
    const state = relationship(stopUpdate?.scheduleRelationship)
    const scheduledArrival = finite(row.arrival), scheduledDeparture = finite(row.departure)
    if (scheduledArrival === undefined || scheduledDeparture === undefined) return { status: 'invalid' }
    if (state === 'NO_DATA') delay = undefined
    const arrivalDelay = state === 'NO_DATA' ? undefined : eventDelay(stopUpdate?.arrival, scheduledArrival, toServiceSeconds)
    if (arrivalDelay !== undefined) delay = arrivalDelay
    const arrival = scheduledArrival + (delay ?? 0)
    const departureDelay = state === 'NO_DATA' ? undefined : eventDelay(stopUpdate?.departure, scheduledDeparture, toServiceSeconds)
    if (departureDelay !== undefined) delay = departureDelay
    const departure = scheduledDeparture + (delay ?? 0)
    // Contradictory observations must not introduce backwards ride segments.
    if (!Number.isFinite(arrival) || !Number.isFinite(departure) || departure > 0xffffffff
      || arrival < 0 || departure < arrival || arrival < previousDeparture) return { status: 'invalid' }
    stopTimes.push({ stopId, sequence, arrival, departure,
      canBoard: state !== 'SKIPPED' && (row.can_board === undefined || Number(row.can_board) === 1),
      canAlight: state !== 'SKIPPED' && (row.can_alight === undefined || Number(row.can_alight) === 1),
    })
    previousDeparture = departure
  }
  return { status: 'ready', stopTimes }
}
