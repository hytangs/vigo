const invalid = message => Object.assign(new Error(message), { statusCode: 400, code: 'invalid_scenario_timing' })

export function normalizeTiming(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('Timing must be an object.')
  const out = {}, allowed = new Set(['speedFactor', 'segmentIndexes', 'dwellMinutes', 'dwellScale', 'stopIndexes'])
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw invalid(`Unknown timing field: ${key}.`)
  for (const [key, min, max] of [['speedFactor', .1, 10], ['dwellMinutes', 0, 60], ['dwellScale', 0, 10]]) {
    if (value[key] === undefined) continue
    if (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] < min || value[key] > max) throw invalid(`${key} must be between ${min} and ${max}.`)
    out[key] = value[key]
  }
  if (out.dwellMinutes !== undefined && out.dwellScale !== undefined) throw invalid('Choose dwellMinutes or dwellScale, not both.')
  for (const key of ['segmentIndexes', 'stopIndexes']) if (value[key] !== undefined) {
    const indexes = value[key]
    if (!Array.isArray(indexes) || !indexes.length || new Set(indexes).size !== indexes.length || indexes.some(index => !Number.isInteger(index) || index < (key === 'stopIndexes' ? 1 : 0) || index >= 256)) throw invalid('Timing indexes must be distinct and inside the service pattern.')
    out[key] = [...indexes]
  }
  return out
}

export function adjustScheduledTrip(trip, timing) {
  if (!timing) return trip
  const t = normalizeTiming(timing), dep = trip.departureOffsetsSeconds, arr = trip.arrivalOffsetsSeconds
  if (dep.length < 2 || arr.length !== dep.length || dep[0] !== 0 || arr[0] !== 0) throw invalid('Timing edits require matching schedule offsets starting at zero.')
  for (const [key, max] of [['segmentIndexes', dep.length - 1], ['stopIndexes', dep.length]]) {
    if (t[key]?.some(index => index >= max)) throw invalid('Timing indexes must be inside the service pattern.')
  }
  const departures = [0], arrivals = [0]
  for (let i = 1; i < dep.length; i++) {
    const moving = arr[i] - dep[i - 1], standing = dep[i] - arr[i]
    if (!(moving >= 0 && standing >= 0)) throw invalid('Cannot adjust non-monotone schedule offsets.')
    const speed = !t.segmentIndexes || t.segmentIndexes.includes(i - 1) ? t.speedFactor ?? 1 : 1
    const dwell = !t.stopIndexes || t.stopIndexes.includes(i) ? t.dwellMinutes === undefined ? standing * (t.dwellScale ?? 1) : t.dwellMinutes * 60 : standing
    arrivals.push(departures[i - 1] + moving / speed)
    departures.push(arrivals[i] + dwell)
    if (!Number.isFinite(departures[i]) || departures[i] > 1048575) throw invalid('Adjusted schedule exceeds the supported time range.')
  }
  return { ...trip, arrivalOffsetsSeconds: arrivals, departureOffsetsSeconds: departures }
}
