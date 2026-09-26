import os from 'node:os'

export function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0
    ? Math.max(minimum, Math.min(maximum, Math.floor(number)))
    : fallback
}

// Respect a container limit when Node can report it. This is a planning
// budget, not a promise that native allocations cannot exhaust the process.
const constrained = process.constrainedMemory?.() || os.totalmem()
export const memoryCapacityBytes = Math.min(os.totalmem(), constrained)
export const defaultTimetableBudgetBytes = Math.max(64 * 1024 * 1024, Math.min(
  2 * 1024 * 1024 * 1024, Math.floor(memoryCapacityBytes / 8),
))

export const timetableBudgetBytes = boundedInteger(
  process.env.VIGO_ACTIVE_KERNEL_MAX_BYTES, defaultTimetableBudgetBytes,
  1024 * 1024, 16 * 1024 * 1024 * 1024,
)

export function runtimeCapacityError(message, code = 'VIGO_ROUTE_CAPACITY') {
  const error = new Error(message)
  error.code = code
  error.statusCode = 503
  return error
}
