import { createNativeFareCatalog } from './server/native-routing-kernel.mjs'
export { farePriceLabel } from './farePresentation.mjs'

// Boarding fares come from the Rust fare engine that the standalone runtime
// also uses, so both runtimes publish the same quote for the same ride. A
// catalog object, or its saved JSON, maps to one engine; quotes are frozen and
// reused so repeated renders of a ride share one immutable result.
const engines = new WeakMap()
const quotes = new WeakMap()
const invalid = Object.freeze({ status: 'unavailable', code: 'invalid_data', reason: 'The saved fare data is incomplete or inconsistent.' })

export function fareEngineFromJson(json) {
  return createNativeFareCatalog(json)
}

function fareEngine(catalog) {
  let engine = engines.get(catalog)
  if (!engine) {
    engine = createNativeFareCatalog(JSON.stringify(catalog))
    engines.set(catalog, engine)
  }
  return engine
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) deepFreeze(item)
    Object.freeze(value)
  }
  return value
}

// Scheduled ride clocks are whole service seconds; minute coordinates are not.
const serviceSeconds = minutes => (Number.isFinite(minutes) ? Math.round(minutes * 60) : NaN)
const text = value => (value == null ? '' : String(value))

export function quoteEngineFare(engine, leg, serviceDate) {
  try {
    const departure = serviceSeconds(leg.startMinutes)
    const arrival = serviceSeconds(leg.endMinutes)
    const realtime = leg.scheduleMode === 'realtime-adjusted'
    const key = JSON.stringify([leg.routeId, leg.fromStopId, leg.toStopId, serviceDate, departure, arrival, realtime])
    let cache = quotes.get(engine)
    if (!cache) quotes.set(engine, cache = new Map())
    const cached = cache.get(key)
    if (cached) return cached
    const result = deepFreeze(JSON.parse(engine.quote(text(leg.routeId), text(leg.fromStopId), text(leg.toStopId),
      text(serviceDate), departure, arrival, realtime)))
    if (cache.size >= 1024) cache.clear()
    cache.set(key, result)
    return result
  } catch {
    return invalid
  }
}

export function engineFareNeedsScheduledTime(engine, leg) {
  try { return engine.needsScheduledTime(text(leg.routeId), text(leg.fromStopId), text(leg.toStopId)) } catch { return false }
}

export function quoteBoardingFare(catalog, leg, serviceDate) {
  try { return quoteEngineFare(fareEngine(catalog), leg, serviceDate) } catch { return invalid }
}
