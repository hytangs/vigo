import { compileNativeRealtimeTimetable } from './native-routing-kernel.mjs'

function invalidReplacement(trip, detail) {
  const error = new Error(`Invalid realtime timetable trip ${trip}: ${detail}.`)
  error.code = 'realtime_timetable_invalid_trip'
  return error
}

// JS resolves feed identities; Rust validates calls and reconstructs the entire
// immutable view, including cancellation, continuity and departure ordering.
export function compileRealtimeTimetableKernel(base, { replacements = new Map(), canceledTrips = new Set(), diagnostics } = {}) {
  const started = performance.now(), tripCount = base.tripIds.length
  for (const trip of [...replacements.keys(), ...canceledTrips]) {
    if (!Number.isInteger(trip) || trip < 0 || trip >= tripCount) throw invalidReplacement(trip, 'unknown original trip index')
  }
  const canceled = new Uint8Array(tripCount)
  for (const trip of canceledTrips) canceled[trip] = 1
  const number = value => typeof value === 'number' ? value : NaN
  const updates = [...replacements].filter(([trip, replacement]) => replacement && !canceled[trip]).map(([trip, replacement]) => {
    if (!Array.isArray(replacement.stopTimes) || replacement.stopTimes.length > (1 << 15) + 1) throw invalidReplacement(trip, 'unsupported stop count')
    return { trip, stops: replacement.stopTimes.map(call => {
      const stop = base.stopIndex.get(call.stopId)
      if (!Number.isInteger(stop) || stop < 0 || stop >= base.stopIds.length) throw invalidReplacement(trip, `unknown stop ${String(call.stopId)}`)
      return { stop, arrival: number(call.arrival), departure: number(call.departure), sequence: number(call.sequence),
        canBoard: call.canBoard !== false, canAlight: call.canAlight !== false }
    }) }
  })
  let compiled
  try { compiled = compileNativeRealtimeTimetable({ ...base, stopCount: base.stopIds.length, canceled, replacements: updates }) }
  catch (error) {
    if (error.message.startsWith('Invalid realtime timetable trip')) error.code = 'realtime_timetable_invalid_trip'
    throw error
  }
  const kernel = { ...base, ...compiled, realtimeTripIndices: new Set(compiled.realtimeTripIndices), realtimeDiagnostics: diagnostics,
    compileMs: Number((performance.now() - started).toFixed(3)), buildMs: 0, memoryDelta: null }
  for (const field of ['nativeTimetableKernel', 'sourceTypedArrayBytes', 'nativeIndexBytes', 'nativeWorkspaceBytes', 'typedArrayBytes', 'estimatedBytes']) delete kernel[field]
  return kernel
}
