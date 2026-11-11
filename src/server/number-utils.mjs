export function numeric(value, fallback = 0) {
  try {
    const number = Number(value)
    return Number.isFinite(number) ? number : fallback
  } catch {
    return fallback
  }
}

export function integralNumber(value, fallback = undefined) {
  if (
    value === null
    || value === undefined
    || typeof value === 'boolean'
    || (typeof value === 'string' && value.trim() === '')
  ) return fallback
  const number = numeric(value, Number.NaN)
  return Number.isInteger(number) ? number : fallback
}

// Studio exposes 00:00..29:59. Native public requests separately admit seconds
// through 71:59:59.
const studioRoutingMinuteLimit = 1800

export function routingMinute(value, label, fallback = 480) {
  const parsed = integralNumber(value === undefined ? fallback : value)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed >= studioRoutingMinuteLimit) {
    throw new Error(`${label} must be an integral minute in [0, ${studioRoutingMinuteLimit}).`)
  }
  return parsed
}

export function timingMilliseconds(value, fallback = 0) {
  if (
    value === null
    || value === undefined
    || typeof value === 'boolean'
    || (typeof value === 'string' && value.trim() === '')
  ) return fallback
  const number = numeric(value, Number.NaN)
  return number >= 0 ? Number(number.toFixed(3)) : fallback
}
