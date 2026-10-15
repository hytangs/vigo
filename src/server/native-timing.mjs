// @ts-check
// Native bindings expose nanosecond counters. Keep all adapter-facing timing
// fields finite and in milliseconds even when an older or malformed binding
// omits a counter or returns a non-numeric value. Timing is diagnostic metadata
// and must never make an otherwise valid route throw from `.toFixed()` later.
/** @param {unknown} value @returns {number} */
export function normalizeNativeMilliseconds(value) {
  if (typeof value === 'boolean') return 0
  let nanoseconds
  try {
    nanoseconds = Number(value)
  } catch {
    return 0
  }
  if (!Number.isFinite(nanoseconds) || nanoseconds < 0) return 0
  return Number((nanoseconds / 1e6).toFixed(3))
}
