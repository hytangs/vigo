// Deterministic, synthetic scheduled lines. Every stop has service; each group
// has both travel directions and a directed transfer to the following group.
export function timetableQueryFixture(groups = 128) {
  const width = 32
  const stopCount = groups * width
  const columns = Object.fromEntries([
    'departureSeconds', 'arrivalSeconds', 'fromStop', 'toStop', 'sequence',
    'segmentTrip', 'segmentRun', 'continuityBreak', 'canBoard', 'canAlight',
  ].map(key => [key, []]))
  const tripStart = [0]
  const departures = Array.from({ length: stopCount }, () => [])
  for (let group = 0; group < groups; group++) {
    for (let direction = 0; direction < 2; direction++) {
      for (let run = 0; run < 4; run++) {
        const trip = tripStart.length - 1
        for (let step = 0; step < width - 1; step++) {
          const from = group * width + (direction ? width - step - 1 : step)
          const to = from + (direction ? -1 : 1)
          const departure = 600 + run * 300 + step * 10
          departures[from].push(columns.fromStop.length)
          const values = [departure, departure + 10, from, to, step + 1,
            trip, trip, Number(step === 0), 1, 1]
          Object.keys(columns).forEach((key, i) => columns[key].push(values[i]))
        }
        tripStart.push(columns.fromStop.length)
      }
    }
  }
  const departureOffset = [0], departureOrder = []
  const transferOffset = [0], transferTo = [], transferDuration = []
  for (let stop = 0; stop < stopCount; stop++) {
    departures[stop].sort((a, b) => columns.departureSeconds[a] - columns.departureSeconds[b] || a - b)
    departureOrder.push(...departures[stop])
    departureOffset.push(departureOrder.length)
    if ((stop + 1) % width === 0 && stop + 1 < stopCount) {
      transferTo.push(stop + 1)
      transferDuration.push(30)
    }
    transferOffset.push(transferTo.length)
  }
  return {
    stopCount, runCount: tripStart.length - 1,
    ...Object.fromEntries(Object.entries(columns).map(([key, values]) => [key,
      ['continuityBreak', 'canBoard', 'canAlight'].includes(key)
        ? new Uint8Array(values) : new Uint32Array(values)])),
    tripStart: new Uint32Array(tripStart),
    departureOffset: new Uint32Array(departureOffset),
    departureOrder: new Uint32Array(departureOrder),
    transferOffset: new Uint32Array(transferOffset),
    transferTo: new Uint32Array(transferTo),
    transferDuration: new Uint32Array(transferDuration),
    forbiddenSameStop: new Uint8Array(stopCount),
  }
}

export function timetableMatrixRequest(origins, destinations, options = {}) {
  return {
    originOffsets: origins.map((_, i) => i).concat(origins.length),
    originStops: origins, originWalkSeconds: origins.map(() => 0),
    allowPreRideTransfers: origins.map(() => true),
    destinationOffsets: destinations.map((_, i) => i).concat(destinations.length),
    destinationStops: destinations, destinationWalkSeconds: destinations.map(() => 0),
    allowPostRideTransfers: destinations.map(() => true),
    departure: 590, horizon: 1210, arriveBy: false, includeJourneys: true,
    ...options,
  }
}

export function timetableQuerySemantics(result) {
  // All search counters, reachability, times, selected legs and tie breaks
  // remain comparable; only elapsed time is excluded.
  const { queryNs, ...semantics } = result
  return semantics
}
