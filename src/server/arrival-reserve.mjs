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
