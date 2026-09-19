// An explicit research request is an input contract, not a display preference.
// Drop observation properties by descriptor, without ever reading their values.
export function normalizeRoutingDataRequest(request) {
  const mode = request?.routingDataMode
  if (mode === undefined) return request
  if (mode !== 'realtime' && mode !== 'scheduled') {
    const error = new Error('routingDataMode must be realtime or scheduled.')
    error.code = 'invalid_routing_data_mode'
    error.statusCode = 400
    throw error
  }
  if (mode === 'realtime') return request
  const date = request.serviceDate
  const time = request.timePreference === 'arrive'
    ? request.arriveMinutes ?? request.timeMinutes ?? request.departMinutes
    : request.departMinutes
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)
    || !Number.isFinite(Date.parse(`${date}T12:00:00Z`))
    || new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) !== date
    || time == null || time === '' || !Number.isFinite(Number(time))) {
    const error = new Error('Scheduled research routing requires an explicit valid serviceDate and departure or arrival time.')
    error.code = 'research_routing_time_required'
    error.statusCode = 400
    throw error
  }
  const descriptors = Object.getOwnPropertyDescriptors(request)
  for (const key of ['realtimeSnapshot', 'trafficSnapshot', 'traffic', 'serviceDateFallbackPolicy']) delete descriptors[key]
  for (const [key, value] of Object.entries({
    allowServiceDateFallback: false,
    __suppressServiceDateFallback: true,
    requireCompleteServiceCoverage: true,
  })) descriptors[key] = { value, writable: true, configurable: true, enumerable: true }
  return Object.create(Object.getPrototypeOf(request), descriptors)
}

export function routingDataModeForRequest(request) {
  return request.routingDataMode ?? (request.realtimeSnapshot ? 'realtime' : 'scheduled')
}

export function normalizeScheduledAnalysisRequest(request, label) {
  const normalized = normalizeRoutingDataRequest(request)
  if (routingDataModeForRequest(normalized) === 'realtime') {
    const error = new Error(`${label} currently uses scheduled service. Realtime journey routing is available through Route.`)
    error.code = 'realtime_analysis_unsupported'
    error.statusCode = 400
    throw error
  }
  return normalized
}
