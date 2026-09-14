import { parseFareAmount } from './farePresentation.mjs'
import { fareClockSeconds, fareEventDay } from './fareTime.mjs'
import { WeightedLruCache } from './server/weighted-lru-cache.mjs'
export { farePriceLabel } from './farePresentation.mjs'

// Catalogs are immutable snapshots of one feed. Derived indexes and bounded
// caches are released when their catalog/database is released.
const indexes = new WeakMap()
const messages = {
  invalid_data: 'The saved fare data is incomplete or inconsistent.',
  no_rule: 'No published boarding fare matches this route and these stops.',
  schedule_unresolved: 'A scheduled boarding time is needed for this fare.',
  unsupported_rule: 'These fare conditions cannot yet be priced.',
}
const unavailable = (code, reason = messages[code]) => Object.freeze({ status: 'unavailable', code, reason })
const fields = ['network_id', 'from_area_id', 'to_area_id']

function groupRows(rows = [], key) {
  const result = new Map()
  for (const row of rows) {
    if (!result.has(row[key] || '')) result.set(row[key] || '', [])
    result.get(row[key] || '').push(row)
  }
  return result
}

function uniqueRows(rows, key) {
  const grouped = groupRows(rows, key)
  if ([...grouped.values()].some(values => values.length !== 1)) throw new Error('Duplicate fare reference.')
  return new Map([...grouped].map(([id, values]) => [id, values[0]]))
}

function index(catalog) {
  if (indexes.has(catalog)) return indexes.get(catalog)
  const t = catalog.tables
  if (!t || catalog.version !== 1) throw new Error('Unsupported fare catalog.')
  const rules = t.fare_leg_rules ?? []
  const data = {
    t, v2: Object.hasOwn(t, 'fare_products'), priority: rules.some(row => Object.hasOwn(row, 'rule_priority')),
    routes: uniqueRows(t.routes, 'route_id'), stops: uniqueRows(t.stops, 'stop_id'),
    agencies: uniqueRows(t.agency, 'agency_id'), media: uniqueRows(t.fare_media, 'fare_media_id'),
    categories: uniqueRows(t.rider_categories, 'rider_category_id'),
    areas: groupRows(t.stop_areas, 'stop_id'), networks: groupRows(t.route_networks, 'route_id'),
    rules: groupRows(rules, 'network_id'), v1Rules: groupRows(t.fare_rules, 'fare_id'),
    products: new Map(), frames: groupRows(t.timeframes, 'timeframe_group_id'),
    calendar: uniqueRows(t.calendar, 'service_id'), exceptions: new Map(),
    mentioned: Object.fromEntries(fields.map(field => [field, new Set(rules.map(row => row[field]).filter(Boolean))])),
    stopReferences: new Map(), candidates: new WeightedLruCache({ maxEntries: 1024, maxBytes: 2 * 1024 * 1024 }),
    quotes: new WeightedLruCache({ maxEntries: 1024, maxBytes: 2 * 1024 * 1024 }),
  }
  for (const [service, rows] of groupRows(t.calendar_dates, 'service_id')) data.exceptions.set(service, uniqueRows(rows, 'date'))
  for (const [id, rows] of groupRows(t.fare_products, 'fare_product_id')) {
    const defaults = new Set(rows.filter(row => row.rider_category_id && data.categories.get(row.rider_category_id)?.is_default_fare_category === '1').map(row => row.rider_category_id))
    const selected = rows.filter(row => !row.rider_category_id || defaults.has(row.rider_category_id))
    const variants = new Map()
    let invalid = rows.some(row => row.rider_category_id && !data.categories.has(row.rider_category_id)) || defaults.size > 1 || !selected.length
    for (const row of selected) {
      const option = { productId: id, name: row.fare_product_name || 'Published fare', amount: parseFareAmount(row.amount, row.currency), currency: row.currency,
        media: row.fare_media_id ? data.media.get(row.fare_media_id)?.fare_media_name || '' : '',
        riderCategory: row.rider_category_id ? data.categories.get(row.rider_category_id)?.rider_category_name || row.rider_category_id : '' }
      const key = JSON.stringify([row.fare_media_id || '', row.rider_category_id || ''])
      if (variants.has(key) || option.amount === null || (row.fare_media_id && !data.media.has(row.fare_media_id))) invalid = true
      variants.set(key, Object.freeze(option))
    }
    data.products.set(id, invalid ? null : Object.freeze([...variants.values()]))
  }
  indexes.set(catalog, data)
  return data
}

function stopReference(data, id) {
  if (data.stopReferences.has(id)) return data.stopReferences.get(id)
  const stop = data.stops.get(id)
  if (!stop) return null
  const parent = stop.parent_station ? data.stops.get(stop.parent_station) : null
  // Explicit platform membership replaces inherited station membership.
  const areas = data.areas.get(id) ?? data.areas.get(stop.parent_station) ?? []
  // A child's timezone is ignored when it belongs to a parent station.
  const timezone = stop.parent_station ? parent?.stop_timezone || '' : stop.stop_timezone || ''
  const result = { areas: new Set(areas.map(row => row.area_id)), timezone, zone: stop.zone_id }
  data.stopReferences.set(id, result)
  return result
}

function candidates(data, leg) {
  const key = JSON.stringify([leg.routeId, leg.fromStopId, leg.toStopId])
  const cached = data.candidates.get(key)
  if (cached) return cached
  const route = data.routes.get(leg.routeId), from = stopReference(data, leg.fromStopId), to = stopReference(data, leg.toStopId)
  if (!route || !from || !to) return { error: 'no_rule' }
  const agency = route.agency_id ? data.agencies.get(route.agency_id) : data.agencies.size === 1 ? data.agencies.values().next().value : null
  if (!agency) return { error: 'invalid_data' }
  if (!data.v2) return { route, agency, from, to, rules: [], timed: false }
  const assignments = data.networks.get(leg.routeId) ?? []
  if (assignments.length > 1 || (assignments.length && Object.hasOwn(route, 'network_id')) || !agency) return { error: 'invalid_data' }
  const network = assignments[0]?.network_id || route.network_id || ''
  const rules = [...(network ? data.rules.get(network) ?? [] : []),
    ...(data.priority || !data.mentioned.network_id.has(network) ? data.rules.get('') ?? [] : [])]
    .filter(rule => [['from_area_id', from.areas], ['to_area_id', to.areas]].every(([field, values]) => rule[field]
      ? values.has(rule[field]) : data.priority || ![...values].some(value => data.mentioned[field].has(value))))
  const result = { route, agency, from, to, rules, timed: rules.some(rule => rule.from_timeframe_group_id || rule.to_timeframe_group_id) }
  data.candidates.set(key, result, { bytes: key.length * 2 + rules.length * 8 + 192 })
  return result
}

function timeframeMatches(data, group, day) {
  if (!group) return true
  const frames = data.frames.get(group)
  if (!day || !frames?.length) return null
  let matched = false
  for (const frame of frames) {
    const start = fareClockSeconds(frame.start_time, 0), end = fareClockSeconds(frame.end_time, 86400)
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || Boolean(frame.start_time) !== Boolean(frame.end_time)) return null
    const exception = data.exceptions.get(frame.service_id)?.get(day.date), calendar = data.calendar.get(frame.service_id)
    if (!calendar && !data.exceptions.has(frame.service_id)) return null
    if (exception && !['1', '2'].includes(exception.exception_type)) return null
    const active = exception ? exception.exception_type === '1' : calendar
      && calendar.start_date <= day.date && calendar.end_date >= day.date && calendar[day.weekday] === '1'
    if (active && day.seconds >= start && day.seconds < end) matched = true
  }
  return matched
}

function v2Options(data, candidate, leg, serviceDate) {
  if (candidate.timed && leg.scheduleMode === 'realtime-adjusted') return { error: 'schedule_unresolved' }
  const start = candidate.timed ? fareEventDay(serviceDate, leg.startMinutes, candidate.agency.agency_timezone, candidate.from.timezone || candidate.agency.agency_timezone) : null
  const end = candidate.timed ? fareEventDay(serviceDate, leg.endMinutes, candidate.agency.agency_timezone, candidate.to.timezone || candidate.agency.agency_timezone) : null
  if (candidate.timed && (!start || !end)) return { error: 'schedule_unresolved' }
  const times = new Map()
  const matches = (group, day, role) => {
    const key = `${role}:${group || ''}`
    if (!times.has(key)) times.set(key, timeframeMatches(data, group, day))
    return times.get(key)
  }
  let applicable = []
  for (const rule of candidate.rules) {
    const from = matches(rule.from_timeframe_group_id, start, 'from'), to = matches(rule.to_timeframe_group_id, end, 'to')
    if (from === null || to === null) return { error: 'invalid_data' }
    if (from && to) applicable.push(rule)
  }
  if (data.priority && applicable.length) {
    if (applicable.some(row => row.rule_priority && (!/^\d+$/.test(row.rule_priority) || !Number.isSafeInteger(Number(row.rule_priority))))) return { error: 'invalid_data' }
    const highest = Math.max(...applicable.map(row => Number(row.rule_priority || 0)))
    applicable = applicable.filter(row => Number(row.rule_priority || 0) === highest)
  }
  if (applicable.some(row => row.transfer_only && !['0', '1'].includes(row.transfer_only))) return { error: 'unsupported_rule' }
  const ids = new Set(applicable.filter(row => row.transfer_only !== '1').map(row => row.fare_product_id))
  if ([...ids].some(id => !data.products.get(id))) return { error: 'invalid_data' }
  return { options: [...ids].flatMap(id => data.products.get(id)) }
}

function v1Options(data, candidate, leg) {
  const options = []
  for (const fare of data.t.fare_attributes ?? []) {
    if (fare.agency_id ? fare.agency_id !== candidate.agency.agency_id : data.agencies.size > 1) continue
    const rules = data.v1Rules.get(fare.fare_id) ?? []
    const matching = rules.filter(rule => (!rule.route_id || rule.route_id === leg.routeId)
      && (!rule.origin_id || rule.origin_id === candidate.from.zone) && (!rule.destination_id || rule.destination_id === candidate.to.zone))
    if (rules.length && !matching.length) continue
    if (matching.some(rule => rule.contains_id)) return { error: 'unsupported_rule' }
    const amount = parseFareAmount(fare.price, fare.currency_type)
    if (amount === null || !['0', '1'].includes(fare.payment_method)) return { error: 'invalid_data' }
    options.push(Object.freeze({ productId: fare.fare_id, name: 'Published fare', amount, currency: fare.currency_type,
      media: fare.payment_method === '0' ? 'Pay on board' : 'Pay before boarding' }))
  }
  return { options }
}

export function fareNeedsScheduledTime(catalog, leg) {
  try { const data = index(catalog); return data.v2 && candidates(data, leg).timed === true } catch { return false }
}

export function quoteBoardingFare(catalog, leg, serviceDate) {
  try {
    if (catalog.unavailableReason) return unavailable('unsupported_rule', catalog.unavailableReason)
    const data = index(catalog)
    if (data.error) return unavailable(data.error)
    const candidate = candidates(data, leg)
    if (candidate.error) return unavailable(candidate.error)
    const key = JSON.stringify([leg.routeId, leg.fromStopId, leg.toStopId, ...(candidate.timed ? [serviceDate, leg.startMinutes, leg.endMinutes, leg.scheduleMode === 'realtime-adjusted'] : [])])
    const cached = data.quotes.get(key)
    if (cached) return cached
    const { options, error } = data.v2 ? v2Options(data, candidate, leg, serviceDate) : v1Options(data, candidate, leg)
    let result
    if (error || !options?.length) result = unavailable(error || 'no_rule')
    else {
      let agencyUrl
      try { const url = new URL(candidate.agency.agency_fare_url); if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) agencyUrl = url.href } catch { /* No usable public fare link. */ }
      result = Object.freeze({ status: 'published', source: catalog.source, standard: data.v2 ? 'GTFS Fares v2' : 'GTFS Fares v1',
        options: Object.freeze(options), ...(agencyUrl ? { agencyUrl } : {}) })
    }
    data.quotes.set(key, result, { bytes: key.length * 2 + JSON.stringify(result).length * 2 })
    return result
  } catch {
    if (catalog && typeof catalog === 'object') indexes.set(catalog, { error: 'invalid_data' })
    return unavailable('invalid_data')
  }
}

export function boardingFareEvidence(plan) {
  const rides = plan?.legs?.filter(leg => leg.type === 'ride') ?? []
  if (!rides.length) return undefined
  return { basis: 'Separate new boardings. Transfers, joined fare legs and passes are not priced. Do not sum these amounts into a journey total.',
    boardings: rides.map(leg => ({ route: leg.routeShortName || leg.routeId, from: leg.fromName, to: leg.toName,
      status: leg.fare?.status || 'unavailable', options: leg.fare?.options, reason: leg.fare?.reason })) }
}
