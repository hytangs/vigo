import { routingHorizonMinutes } from './gtfs/routing-policy.mjs'

// A caller-selected planning margin, not a probability or a change to GTFS
// event times. Apply once to the complete query and keep its original start.
export function validateArrivalBuffer(request, supported = true) {
  const value = request.arrivalBufferMinutes
  if (value === undefined) return 0
  if (!Number.isInteger(value) || value < 0 || value > 60) {
    throw new Error('arrivalBufferMinutes must be an integer from 0 to 60.')
  }
  if (value > 0 && (!supported || request.timePreference !== 'arrive'
    || (request.mode !== undefined && request.mode !== 'transit'))) {
    throw new Error('arrivalBufferMinutes requires an arrive-by Transit Route or Matrix.')
  }
  if (value > 0 && (request.waypoints?.length || request.via?.length)) {
    throw new Error('arrivalBufferMinutes with transit waypoints is not supported.')
  }
  return value
}

export function arrivalReserve(request) {
  const minutes = validateArrivalBuffer(request)
  if (!minutes) return null
  const deadline = request.arriveMinutes ?? request.timeMinutes ?? request.departMinutes
  if (!Number.isInteger(deadline) || deadline < minutes || deadline > 2880) {
    throw new Error('The arrival deadline must be an integral minute at least arrivalBufferMinutes and at most 2880.')
  }
  const horizon = routingHorizonMinutes(request)
  if (horizon - minutes < 1) {
    throw new Error('horizonMinutes must exceed arrivalBufferMinutes by at least one minute.')
  }
  return {
    request: { ...request, arrivalBufferMinutes: 0, arriveMinutes: deadline - minutes,
      horizonMinutes: horizon - minutes },
    diagnostics: { method: 'explicit_time_reserves', calibratedProbability: false,
      arrivalBufferMinutes: minutes, minimumTransferBufferMinutes: request.minimumTransferBufferMinutes ?? 0,
      requestedArrivalMinutes: deadline, planningArrivalMinutes: deadline - minutes },
  }
}

export function withArrivalReserve(result, reserve, matrix = false) {
  result.diagnostics = { ...result.diagnostics, timeReserves: reserve.diagnostics }
  if (matrix) {
    for (const row of result.rows) {
      // Matrix duration retains its public deadline-minus-departure meaning.
      // Nested journeys retain the actual modeled arrival and travel duration.
      if (Number.isFinite(row.arriveMinutes)) row.arriveMinutes += reserve.diagnostics.arrivalBufferMinutes
      if (Number.isFinite(row.durationMinutes)) row.durationMinutes = Number(
        (row.durationMinutes + reserve.diagnostics.arrivalBufferMinutes).toFixed(3),
      )
    }
  }
  return result
}
