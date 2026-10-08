// Structural checks for the stable public v1 outputs. These do not establish
// route optimality, real-world accuracy, or correctness of the supplied City.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = value => typeof value === 'string' && value.length > 0
const seconds = value => Number.isSafeInteger(value) && value >= 0
const cell = value => value === null || seconds(value)
const clock = value => typeof value === 'string' && /^\d{2,}:[0-5]\d:[0-5]\d$/.test(value)
const bounds = value => Array.isArray(value) && value.length === 4 && value.every(Number.isFinite)
  && value[0] < value[2] && value[1] < value[3]
const message = value => object(value) && text(value.code) && text(value.message)
const reference = value => object(value) && text(value.id) && (value.feed === null || text(value.feed))
const point = value => object(value) && (reference(value.stop)
  || Array.isArray(value.coordinate) && value.coordinate.length === 2 && value.coordinate.every(Number.isFinite))

function journey(value) {
  return object(value) && clock(value.departureTime) && clock(value.arrivalTime)
    && ['durationSeconds', 'walkingSeconds', 'waitingSeconds', 'ridingSeconds', 'boardings', 'transfers'].every(key => seconds(value[key]))
    && (!Object.hasOwn(value, 'drivingSeconds') || seconds(value.drivingSeconds))
    && Array.isArray(value.legs) && value.legs.every(leg => object(leg)
      && ['walk', 'transit', 'drive'].includes(leg.type) && object(leg.from) && object(leg.to)
      && clock(leg.departureTime) && clock(leg.arrivalTime) && seconds(leg.durationSeconds)
      // The public formatter retains unknown source route metadata as null.
      && (leg.type !== 'transit' || object(leg.route) && (leg.route.id === null || reference(leg.route.id)) && reference(leg.trip)))
}

function grid(value) {
  return object(value) && Number.isSafeInteger(value.width) && value.width > 0
    && Number.isSafeInteger(value.height) && value.height > 0 && bounds(value.bounds)
    && Array.isArray(value.valuesSeconds) && value.valuesSeconds.length === value.width * value.height
    && value.valuesSeconds.every(cell)
}

const coordinate = value => Array.isArray(value) && value.length >= 2 && value.every(Number.isFinite)
const line = value => Array.isArray(value) && value.length >= 2 && value.every(coordinate)
const ring = value => line(value) && value.length >= 4 && JSON.stringify(value[0]) === JSON.stringify(value.at(-1))
const polygon = value => Array.isArray(value) && value.length > 0 && value.every(ring)
function features(value, area) {
  if (!object(value) || value.type !== 'FeatureCollection' || !Array.isArray(value.features)) return false
  return value.features.every(feature => {
    if (!object(feature) || feature.type !== 'Feature' || !object(feature.geometry)) return false
    const { type, coordinates } = feature.geometry
    if (area && type === 'Polygon') return polygon(coordinates)
    if (area && type === 'MultiPolygon') return Array.isArray(coordinates) && coordinates.every(polygon)
    if (!area && type === 'LineString') return line(coordinates)
    return !area && type === 'MultiLineString' && Array.isArray(coordinates) && coordinates.every(line)
  })
}

function validateResult(query, result) {
  if (result.schema !== `vigo.${query.kind}.v1`) return 'Missing or mismatched endpoint schema'
  if (!object(result.query) || !object(result.meta) || !text(result.meta.engineVersion)
    || !/^[a-f0-9]{64}$/.test(result.meta.queryFingerprint ?? '')) return 'Missing public query or metadata'
  if (result.status === 'not_found') {
    if (query.kind !== 'route' || result.journey !== null || !message(result.reason)) return 'Invalid no-journey result'
    return null
  }
  if (query.kind === 'route') {
    if (!journey(result.journey)) return 'Missing or malformed route journey'
    if (Object.hasOwn(result, 'alternatives') && (!Array.isArray(result.alternatives) || !result.alternatives.every(journey))) return 'Malformed route alternatives'
    return null
  }
  if (query.kind === 'matrix') {
    const { origins, destinations } = result.query
    if (!Array.isArray(origins) || !origins.every(point) || !Array.isArray(destinations) || !destinations.every(point)
      || !Array.isArray(query.origins) || origins.length !== query.origins.length
      || !Array.isArray(query.destinations) || destinations.length !== query.destinations.length) return 'Matrix endpoints do not match request dimensions'
    const matrix = (rows, valid) => Array.isArray(rows) && rows.length === origins.length
      && rows.every(row => Array.isArray(row) && row.length === destinations.length && row.every(valid))
    if (!matrix(result.durationsSeconds, cell)) return 'Missing or malformed matrix durationsSeconds'
    if (Object.hasOwn(result, 'journeys') && !matrix(result.journeys, value => value === null || journey(value))) return 'Malformed matrix journeys'
    return null
  }
  if (query.kind === 'reach') {
    if (!Array.isArray(result.cutoffsSeconds) || !result.cutoffsSeconds.length || !result.cutoffsSeconds.every(seconds)) return 'Missing or malformed Reach cutoffsSeconds'
    if (!features(result.areas, true)) return 'Missing or malformed Reach areas'
    if (query.reachFormat === 'map') return bounds(result.bounds) ? null : 'Missing or malformed Reach map bounds'
    if (!grid(result.surface) || !features(result.contours, false)) return 'Missing or malformed Reach surface or contours'
    const width = query.surface?.width ?? query.rasterSize, height = query.surface?.height ?? query.rasterSize
    if ((width !== undefined && result.surface.width !== width) || (height !== undefined && result.surface.height !== height)) return 'Reach grid dimensions do not match request'
    if (Object.hasOwn(result, 'fullSurface') && !grid(result.fullSurface)) return 'Malformed Reach fullSurface'
    return null
  }
  return 'Unsupported endpoint'
}

export function classifyResponse(query, http, result) {
  // HTTP failures retain their meaning even when a gateway sends HTML or an
  // apparently successful body. Only a successful HTTP response is validated.
  const failure = { 429: 'overloaded', 503: 'unavailable', 504: 'timeout' }[http]
  if (failure || http < 200 || http >= 300) return {
    outcome: failure ?? 'http_error', error: message(result?.error) ? result.error.message : `HTTP ${http}`,
  }
  if (!object(result)) return { outcome: 'invalid_response', error: 'Response is not a public result object' }
  if (result.status === 'error' && result.schema === 'vigo.error.v1' && message(result.error)) {
    return { outcome: 'query_error', error: result.error.message }
  }
  if (!['ok', 'not_found'].includes(result.status)) return { outcome: 'invalid_response', error: 'Unexpected or malformed public result status' }
  const error = validateResult(query, result)
  return error ? { outcome: 'invalid_response', error } : { outcome: result.status }
}

// Race the complete response read against the deadline itself. Fetch may use
// a generic AbortError for a timed-out body, so error names alone are ambiguous.
export async function withDeadline(operation, deadline) {
  if (deadline.aborted) throw deadline.reason
  let expire
  const expired = new Promise((resolve, reject) => {
    expire = () => reject(deadline.reason)
    deadline.addEventListener('abort', expire, { once: true })
  })
  try { return await Promise.race([expired, Promise.resolve().then(operation)]) }
  finally { deadline.removeEventListener('abort', expire) }
}

export function classifyTransportError(error, deadline) {
  return deadline.aborted && deadline.reason?.name === 'TimeoutError' && error === deadline.reason
    ? 'timeout' : 'transport_error'
}
