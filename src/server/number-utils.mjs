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
