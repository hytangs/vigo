// Resolve GTFS-RT against one identified scheduled trip, before native routing.
// Arrival and departure remain distinct; delay propagates forward until a new
// prediction or NO_DATA. No inference about causes or vehicle positions occurs.
const supplied = value => value !== undefined && value !== null
const finite = value => (typeof value === 'number' || (typeof value === 'string' && value.trim() !== ''))
  && Number.isFinite(Number(value)) ? Number(value) : undefined
// Match the packed native exit-time and relative-segment domains before one
// malformed feed record can reach compilation of the complete snapshot.
const maximumNativeTime = (1 << 20) - 1
const maximumRunSegments = 1 << 15
const relationship = value => typeof value === 'number'
  ? ['SCHEDULED', 'SKIPPED', 'NO_DATA', 'UNSCHEDULED'][value] ?? 'UNKNOWN'
  : String(value || 'SCHEDULED').trim().toUpperCase()
const localId = value => String(value).split('\u001f').at(-1)
const matchesStopId = (suppliedId, staticId) => String(suppliedId).includes('\u001f')
  ? String(suppliedId) === String(staticId) : String(suppliedId) === localId(staticId)

function eventDelay(event, scheduled, toServiceSeconds) {
  if (!supplied(event)) return undefined
  if (typeof event !== 'object' || Array.isArray(event)) return Number.NaN
  for (const field of ['time', 'delay']) {
    if (supplied(event[field]) && !Number.isSafeInteger(finite(event[field]))) return Number.NaN
  }
  if (supplied(event.time)) {
    if (Number(event.time) < 0) return Number.NaN
    try {
      const time = toServiceSeconds(Number(event.time))
      return Number.isInteger(time) && time >= 0 && time <= maximumNativeTime
        ? time - scheduled : Number.NaN
    } catch {
      return Number.NaN
    }
  }
  return finite(event?.delay)
}

export function resolveRealtimeTripTimes(rows, update, toServiceSeconds, options = {}) {
  const bySequence = new Map(), byStop = new Map()
  const updates = update.stopTimeUpdates ?? []
  if (!Array.isArray(updates) || !Array.isArray(rows) || rows.length < 2
    || rows.length - 1 > maximumRunSegments) return { status: 'invalid' }
  let lastReportedSequence = -1
  for (const stopUpdate of updates) {
    if (!['SCHEDULED', 'SKIPPED', 'NO_DATA'].includes(relationship(stopUpdate?.scheduleRelationship))) {
      return { status: 'unsupported' }
    }
    const sequence = finite(stopUpdate?.stopSequence)
    if (supplied(stopUpdate?.stopSequence)
      && (!Number.isInteger(sequence) || sequence < 0 || sequence > 0xffff_ffff)) return { status: 'invalid' }
    if (Number.isInteger(sequence)) {
      if (sequence <= lastReportedSequence) return { status: 'invalid' }
      lastReportedSequence = sequence
    }
    // A stop sequence identifies one call on a loop. Do not also apply that
    // prediction to other occurrences of the same stop through an ID fallback.
    const index = Number.isInteger(sequence) ? bySequence : byStop
    const key = Number.isInteger(sequence) ? sequence : String(stopUpdate?.stopId ?? '')
    if (key === '' || index.has(key)) return { status: 'invalid' }
    index.set(key, stopUpdate)
  }
  if (byStop.size) {
    const seen = new Set(), seenLocal = new Set()
    for (const row of rows) {
      const id = String(row.stop_id), local = localId(id)
      if ((seen.has(id) && byStop.has(id))
        || (seenLocal.has(local) && byStop.has(local))) return { status: 'invalid' }
      seen.add(id); seenLocal.add(local)
    }
  }
  // Compact stores retain each connection's boarding sequence but not its
  // terminal alighting sequence. Only that explicitly marked synthetic row
  // may bind an unknown sequence, and only to the same terminal stop after
  // every actual boarding sequence. Never guess a missing intermediate call.
  const terminal = rows.at(-1), terminalPrior = rows.at(-2)
  let terminalUpdate, terminalSequence
  if (terminal.stop_sequence_inferred === true) {
    const knownSequences = new Set(rows.map(row => Number(row.stop_sequence)))
    const candidates = updates.filter(stopUpdate => (
      Number.isInteger(finite(stopUpdate?.stopSequence))
      && !knownSequences.has(Number(stopUpdate.stopSequence))
      && Number(stopUpdate.stopSequence) > Number(terminalPrior.stop_sequence)
      && supplied(stopUpdate.stopId) && matchesStopId(stopUpdate.stopId, terminal.stop_id)
    ))
    if (candidates.length > 1 || (candidates.length && bySequence.has(Number(terminal.stop_sequence)))) {
      return { status: 'invalid' }
    }
    terminalUpdate = candidates[0]
    terminalSequence = terminalUpdate ? Number(terminalUpdate.stopSequence) : undefined
  }
  const stopTimes = []
  const usedUpdates = new Set()
  let delay = finite(update.delaySeconds)
  if (supplied(update.delaySeconds) && !Number.isSafeInteger(delay)) return { status: 'invalid' }
  // Omitted past calls have unknown delay. Their scheduled departures can be
  // excluded only once they precede the captured feed and observation clocks;
  // never back-propagate a later prediction into an invented trip history.
  // Keeping this boundary on source timestamps makes a cached snapshot stable.
  const nowSeconds = finite(options.nowSeconds)
  const sourceTimes = [finite(options.feedTimestamp ?? update.sourceFeedTimestamp)]
  if (supplied(update.timestamp)) sourceTimes.push(finite(update.timestamp))
  let pastBoundaryEpoch, pastBoundaryService
  if (Number.isFinite(nowSeconds) && sourceTimes.every(time => Number.isSafeInteger(time) && time >= 0 && time <= nowSeconds)) {
    pastBoundaryEpoch = Math.min(...sourceTimes)
    try {
      const boundary = toServiceSeconds(pastBoundaryEpoch)
      if (Number.isInteger(boundary) && boundary >= 0 && boundary <= maximumNativeTime) pastBoundaryService = boundary
    } catch { /* A missing usable clock preserves the conservative rejection. */ }
  }
  let omittedPastPrefixStops = 0
  let previousDeparture = -Infinity
  let previousSequence = -1
  for (const row of rows) {
    const sequence = row === terminal && terminalSequence !== undefined ? terminalSequence : finite(row.stop_sequence)
    const stopId = String(row.stop_id ?? '')
    if (!stopId || !Number.isInteger(sequence) || sequence < 0 || sequence > 0xffff_ffff
      || sequence <= previousSequence) return { status: 'invalid' }
    const sequenceUpdate = row === terminal && terminalUpdate ? terminalUpdate : bySequence.get(sequence)
    const exactIdUpdate = byStop.get(stopId), localIdUpdate = byStop.get(localId(stopId))
    if (exactIdUpdate && localIdUpdate && exactIdUpdate !== localIdUpdate) return { status: 'invalid' }
    const idUpdate = exactIdUpdate ?? localIdUpdate
    if (sequenceUpdate && idUpdate) return { status: 'invalid' }
    const stopUpdate = sequenceUpdate ?? idUpdate
    if (stopUpdate) usedUpdates.add(stopUpdate)
    if (stopUpdate?.stopId && !matchesStopId(stopUpdate.stopId, stopId)) return { status: 'invalid' }
    const state = relationship(stopUpdate?.scheduleRelationship)
    const scheduledArrival = finite(row.arrival), scheduledDeparture = finite(row.departure)
    if (scheduledArrival === undefined || scheduledDeparture === undefined) return { status: 'invalid' }
    if (state === 'NO_DATA') delay = undefined
    const arrivalDelay = state === 'NO_DATA' ? undefined : eventDelay(stopUpdate?.arrival, scheduledArrival, toServiceSeconds)
    if (arrivalDelay !== undefined) delay = arrivalDelay
    let arrival = scheduledArrival + (delay ?? 0)
    const departureDelay = state === 'NO_DATA' ? undefined : eventDelay(stopUpdate?.departure, scheduledDeparture, toServiceSeconds)
    if (departureDelay !== undefined) delay = departureDelay
    const departure = scheduledDeparture + (delay ?? 0)
    // A skipped call is not a routing vertex. Its optional event may update
    // the propagated delay, but an invented scheduled passing time must not
    // invalidate the next actual stop's prediction. Connecting the remaining
    // calls preserves through travel without inventing intermediate times.
    if (state === 'SKIPPED') {
      if (![arrival, departure].every(time => Number.isInteger(time) && time >= 0 && time <= maximumNativeTime)) {
        return { status: 'invalid' }
      }
      previousSequence = sequence
      continue
    }
    const firstPredictionEpoch = finite(stopUpdate?.arrival?.time ?? stopUpdate?.departure?.time)
    const firstArrival = arrivalDelay === undefined ? Math.min(arrival, departure) : arrival
    if (stopTimes.length && state === 'SCHEDULED' && stopUpdate && usedUpdates.size === 1
      && !supplied(update.delaySeconds) && pastBoundaryService !== undefined
      && Number.isSafeInteger(firstPredictionEpoch) && firstPredictionEpoch >= 0 && firstPredictionEpoch < pastBoundaryEpoch
      && firstArrival < pastBoundaryService
      && (firstArrival < previousDeparture || (arrivalDelay === undefined && departure < arrival))
      && stopTimes.every(stop => stop.departure < pastBoundaryService)) {
      omittedPastPrefixStops = stopTimes.length
      stopTimes.length = 0
      previousDeparture = -Infinity
    }
    // There is no incoming ride at the first call. A departure-only early
    // prediction must not conflict with an arrival invented from the schedule.
    if (!stopTimes.length && arrivalDelay === undefined) arrival = Math.min(arrival, departure)
    // Contradictory observations must not introduce backwards ride segments.
    if (!Number.isInteger(arrival) || !Number.isInteger(departure) || departure > maximumNativeTime
      || arrival < 0 || departure < arrival || arrival < previousDeparture) return { status: 'invalid' }
    stopTimes.push({ stopId, sequence, arrival, departure,
      canBoard: state !== 'SKIPPED' && (row.can_board === undefined || Number(row.can_board) === 1),
      canAlight: state !== 'SKIPPED' && (row.can_alight === undefined || Number(row.can_alight) === 1),
    })
    previousDeparture = departure
    previousSequence = sequence
  }
  // Every update must bind to a single actual call. Otherwise an unknown
  // sequence/stop could be reported as applied while its prediction was lost.
  if (usedUpdates.size !== updates.length) return { status: 'invalid' }
  return { status: 'ready', stopTimes, omittedPastPrefixStops }
}
