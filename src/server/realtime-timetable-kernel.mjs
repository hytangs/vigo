// Each live snapshot is a complete timetable view. Keep the static stop and
// trip identities while replacing their segments, so every native search
// (including reverse and Pareto searches) reads the same prediction times.
const maximumNativeTime = (1 << 20) - 1
const maximumRunSegments = 1 << 15
const maximumRunCount = (1 << 29) - 1

function invalidReplacement(trip, detail) {
  const error = new Error(`Invalid realtime timetable trip ${trip}: ${detail}.`)
  error.code = 'realtime_timetable_invalid_trip'
  return error
}

export function compileRealtimeTimetableKernel(base, {
  replacements = new Map(), canceledTrips = new Set(), diagnostics,
} = {}) {
  const started = performance.now()
  const tripCount = base.tripIds.length
  const stopCount = base.stopIds.length
  for (const trip of [...replacements.keys(), ...canceledTrips]) {
    if (!Number.isInteger(trip) || trip < 0 || trip >= tripCount) {
      throw invalidReplacement(trip, 'unknown original trip index')
    }
  }
  let segmentCount = 0
  const realtimeTripIndices = new Set()
  for (let trip = 0; trip < tripCount; trip++) {
    if (canceledTrips.has(trip)) continue
    const replacement = replacements.get(trip)
    if (!replacement) {
      segmentCount += base.tripStart[trip + 1] - base.tripStart[trip]
      continue
    }
    const stops = replacement.stopTimes
    if (!Array.isArray(stops) || stops.length - 1 > maximumRunSegments) {
      throw invalidReplacement(trip, 'unsupported stop count')
    }
    let prior = null
    for (const stop of stops) {
      const stopIndex = base.stopIndex.get(stop.stopId)
      if (!Number.isInteger(stopIndex) || stopIndex < 0 || stopIndex >= stopCount) {
        throw invalidReplacement(trip, `unknown stop ${String(stop.stopId)}`)
      }
      if (![stop.arrival, stop.departure].every(time => (
        Number.isInteger(time) && time >= 0 && time <= maximumNativeTime
      )) || stop.departure < stop.arrival || (prior && stop.arrival < prior.departure)) {
        throw invalidReplacement(trip, 'non-monotonic or unsupported event time')
      }
      if (!Number.isInteger(stop.sequence) || stop.sequence < 0 || stop.sequence > 0xffff_ffff
        || (prior && stop.sequence <= prior.sequence)) {
        throw invalidReplacement(trip, 'non-increasing or unsupported stop sequence')
      }
      prior = stop
    }
    segmentCount += Math.max(0, stops.length - 1)
    realtimeTripIndices.add(trip)
  }
  if (segmentCount > 0x7fff_ffff) throw new Error('Realtime timetable exceeds the native segment domain.')

  const departureSeconds = new Uint32Array(segmentCount)
  const arrivalSeconds = new Uint32Array(segmentCount)
  const fromStop = new Uint32Array(segmentCount)
  const toStop = new Uint32Array(segmentCount)
  const sequence = new Uint32Array(segmentCount)
  const segmentTrip = new Uint32Array(segmentCount)
  const segmentRun = new Uint32Array(segmentCount)
  const continuityBreak = new Uint8Array(segmentCount)
  const canBoard = new Uint8Array(segmentCount)
  const canAlight = new Uint8Array(segmentCount)
  const tripStart = new Uint32Array(tripCount + 1)
  let segment = 0, run = -1
  for (let trip = 0; trip < tripCount; trip++) {
    tripStart[trip] = segment
    if (canceledTrips.has(trip)) continue
    const replacement = replacements.get(trip)
    if (replacement) {
      if (replacement.stopTimes.length < 2) continue
      run++
      for (let call = 0; call < replacement.stopTimes.length - 1; call++, segment++) {
        const from = replacement.stopTimes[call], to = replacement.stopTimes[call + 1]
        departureSeconds[segment] = from.departure
        arrivalSeconds[segment] = to.arrival
        fromStop[segment] = base.stopIndex.get(from.stopId)
        toStop[segment] = base.stopIndex.get(to.stopId)
        sequence[segment] = from.sequence
        segmentTrip[segment] = trip
        segmentRun[segment] = run
        canBoard[segment] = from.canBoard === false ? 0 : 1
        canAlight[segment] = to.canAlight === false ? 0 : 1
      }
      continue
    }
    for (let index = base.tripStart[trip]; index < base.tripStart[trip + 1]; index++, segment++) {
      if (index === base.tripStart[trip] || base.segmentRun[index] !== base.segmentRun[index - 1]
        || base.continuityBreak[index]) run++
      departureSeconds[segment] = base.departureSeconds[index]
      arrivalSeconds[segment] = base.arrivalSeconds[index]
      fromStop[segment] = base.fromStop[index]
      toStop[segment] = base.toStop[index]
      sequence[segment] = base.sequence[index]
      segmentTrip[segment] = trip
      segmentRun[segment] = run
      continuityBreak[segment] = base.continuityBreak[index]
      canBoard[segment] = base.canBoard[index]
      canAlight[segment] = base.canAlight[index]
    }
  }
  tripStart[tripCount] = segment
  const runCount = run + 1
  if (runCount > maximumRunCount) throw new Error('Realtime timetable exceeds the native run domain.')

  const departureOffset = new Uint32Array(stopCount + 1)
  for (let index = 0; index < segmentCount; index++) {
    if (canBoard[index]) departureOffset[fromStop[index] + 1]++
  }
  for (let stop = 0; stop < stopCount; stop++) departureOffset[stop + 1] += departureOffset[stop]
  const cursor = departureOffset.slice(0, stopCount)
  const departureOrder = new Uint32Array(departureOffset[stopCount])
  for (let index = 0; index < segmentCount; index++) {
    if (canBoard[index]) departureOrder[cursor[fromStop[index]]++] = index
  }
  for (let stop = 0; stop < stopCount; stop++) {
    departureOrder.subarray(departureOffset[stop], departureOffset[stop + 1])
      .sort((left, right) => departureSeconds[left] - departureSeconds[right] || left - right)
  }
  const kernel = {
    ...base,
    departureSeconds, arrivalSeconds, fromStop, toStop, sequence, segmentTrip,
    segmentRun, continuityBreak, canBoard, canAlight, tripStart,
    departureOffset, departureOrder, runCount, activeSegmentCount: segmentCount,
    realtimeTripIndices, realtimeDiagnostics: diagnostics,
    compileMs: Number((performance.now() - started).toFixed(3)),
    buildMs: 0,
    memoryDelta: null,
  }
  // These describe the static native instance; the caller will measure the
  // newly compiled instance if it preloads this view.
  for (const field of ['nativeTimetableKernel', 'sourceTypedArrayBytes', 'nativeIndexBytes', 'nativeWorkspaceBytes', 'typedArrayBytes', 'estimatedBytes']) {
    delete kernel[field]
  }
  return kernel
}
