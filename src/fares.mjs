// GTFS boarding prices, not a journey fare optimizer. Never sum these prices:
// transfers, joined fare legs and passes can change the amount a rider pays.
const indexes = new WeakMap()
const currencies = new Set(Intl.supportedValuesOf('currency'))
const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const unavailable = reason => ({ status: 'unavailable', reason })
const indexRows = (rows = [], key) => new Map(rows.map(row => [row[key], row]))

function index(catalog) {
  if (indexes.has(catalog)) return indexes.get(catalog)
  const t = catalog.tables
  const result = {
    t, routes: indexRows(t.routes, 'route_id'), stops: indexRows(t.stops, 'stop_id'),
    agencies: indexRows(t.agency, 'agency_id'), media: indexRows(t.fare_media, 'fare_media_id'),
    categories: indexRows(t.rider_categories, 'rider_category_id'),
    areas: new Map(), networks: new Map(),
    mentioned: Object.fromEntries(['network_id', 'from_area_id', 'to_area_id'].map(field => [field,
      new Set((t.fare_leg_rules ?? []).map(row => row[field]).filter(Boolean))])),
  }
  for (const [rows, key, value, target] of [
    [t.stop_areas ?? [], 'stop_id', 'area_id', result.areas],
    [t.route_networks ?? [], 'route_id', 'network_id', result.networks],
  ]) for (const row of rows) target.set(row[key], [...(target.get(row[key]) ?? []), row[value]])
  indexes.set(catalog, result)
  return result
}

function price(amount, currency) {
  if (!currencies.has(currency) || !/^\d+(?:\.\d+)?$/.test(String(amount ?? ''))) return null
  const number = Number(amount)
  const scale = 10 ** new Intl.NumberFormat('en-US', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits
  return Number.isFinite(number) && number >= 0 && Number.isSafeInteger(Math.round(number * scale))
    && Math.abs(number * scale - Math.round(number * scale)) < 1e-7 ? number : null
}

function stopAreas(data, stopId) {
  const result = new Set(), seen = new Set()
  while (stopId && !seen.has(stopId)) {
    seen.add(stopId)
    for (const area of data.areas.get(stopId) ?? []) result.add(area)
    stopId = data.stops.get(stopId)?.parent_station
  }
  return result
}

function stopTimezone(data, stopId, fallback) {
  const seen = new Set()
  while (stopId && !seen.has(stopId)) {
    seen.add(stopId)
    const stop = data.stops.get(stopId)
    if (stop?.stop_timezone) return stop.stop_timezone
    stopId = stop?.parent_station
  }
  return fallback
}

function eventDay(serviceDate, minutes) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(serviceDate ?? '') || !Number.isFinite(minutes) || minutes < 0) return null
  const date = new Date(`${serviceDate}T12:00:00Z`)
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== serviceDate) return null
  date.setUTCDate(date.getUTCDate() + Math.floor(minutes / 1440))
  return { date: date.toISOString().slice(0, 10).replaceAll('-', ''), weekday: weekdays[date.getUTCDay()], seconds: (minutes % 1440) * 60 }
}

function clockSeconds(text, fallback) {
  if (!text) return fallback
  if (!/^\d{2}:\d{2}:\d{2}$/.test(text)) return NaN
  const [h, m, s] = text.split(':').map(Number)
  return h <= 24 && m < 60 && s < 60 && (h < 24 || m + s === 0) ? h * 3600 + m * 60 + s : NaN
}

function timeframeMatches(t, group, day) {
  if (!group) return true
  if (!day) return false
  return (t.timeframes ?? []).some(frame => {
    if (frame.timeframe_group_id !== group) return false
    const exception = (t.calendar_dates ?? []).find(row => row.service_id === frame.service_id && row.date === day.date)
    const active = exception ? exception.exception_type === '1' : (t.calendar ?? []).some(row => row.service_id === frame.service_id
      && row.start_date <= day.date && row.end_date >= day.date && row[day.weekday] === '1')
    return active && day.seconds >= clockSeconds(frame.start_time, 0) && day.seconds < clockSeconds(frame.end_time, 86400)
  })
}

function v2Options(data, leg, serviceDate) {
  const { t } = data
  const rules = t.fare_leg_rules ?? []
  const route = data.routes.get(leg.routeId)
  const networks = new Set(data.networks.get(leg.routeId) ?? [route.network_id].filter(Boolean))
  const from = stopAreas(data, leg.fromStopId), to = stopAreas(data, leg.toStopId)
  const priority = rules.some(row => Object.hasOwn(row, 'rule_priority'))
  const fields = [['network_id', networks], ['from_area_id', from], ['to_area_id', to]]
  const matches = rules.filter(rule => fields.every(([field, values]) => rule[field]
    ? values.has(rule[field]) : priority || ![...values].some(value => data.mentioned[field].has(value))))
  const timed = matches.some(row => row.from_timeframe_group_id || row.to_timeframe_group_id)
  const agency = data.agencies.get(route.agency_id) ?? (data.agencies.size === 1 ? [...data.agencies.values()][0] : null)
  if (timed && (!serviceDate || [leg.fromStopId, leg.toStopId].some(id => {
    const timezone = stopTimezone(data, id, agency?.agency_timezone)
    return timezone && timezone !== agency?.agency_timezone
  }) || leg.scheduleMode === 'realtime-adjusted')) return null
  let applicable = matches.filter(rule => timeframeMatches(t, rule.from_timeframe_group_id, eventDay(serviceDate, leg.startMinutes))
    && timeframeMatches(t, rule.to_timeframe_group_id, eventDay(serviceDate, leg.endMinutes)))
  if (priority && applicable.length) {
    if (applicable.some(row => row.rule_priority && !/^\d+$/.test(row.rule_priority))) return null
    const highest = Math.max(...applicable.map(row => Number(row.rule_priority || 0)))
    applicable = applicable.filter(row => Number(row.rule_priority || 0) === highest)
  }
  // MBTA's published extension identifies products available only on transfer.
  // They must not appear as a free or discounted new boarding.
  if (applicable.some(row => row.transfer_only && !['0', '1'].includes(row.transfer_only))) return null
  const products = new Set(applicable.filter(row => row.transfer_only !== '1').map(row => row.fare_product_id))
  const rows = (t.fare_products ?? []).filter(row => products.has(row.fare_product_id)
    && (!row.rider_category_id || data.categories.get(row.rider_category_id)?.is_default_fare_category === '1'))
  if ([...products].some(id => !rows.some(row => row.fare_product_id === id))) return null
  return rows.map(row => ({ productId: row.fare_product_id, name: row.fare_product_name || 'Published fare',
    amount: price(row.amount, row.currency), currency: row.currency,
    media: row.fare_media_id ? data.media.get(row.fare_media_id)?.fare_media_name || row.fare_media_id : '',
    riderCategory: row.rider_category_id ? data.categories.get(row.rider_category_id)?.rider_category_name || row.rider_category_id : '',
  }))
}

function v1Options(data, leg) {
  const { t } = data
  const route = data.routes.get(leg.routeId)
  const agencyId = route.agency_id || (data.agencies.size === 1 ? [...data.agencies.keys()][0] : '')
  const from = data.stops.get(leg.fromStopId)?.zone_id, to = data.stops.get(leg.toStopId)?.zone_id
  const options = []
  for (const fare of t.fare_attributes ?? []) {
    if (fare.agency_id ? fare.agency_id !== agencyId : data.agencies.size > 1) continue
    const rules = (t.fare_rules ?? []).filter(rule => rule.fare_id === fare.fare_id)
    const matching = rules.filter(rule => (!rule.route_id || rule.route_id === leg.routeId)
      && (!rule.origin_id || rule.origin_id === from) && (!rule.destination_id || rule.destination_id === to))
    if (rules.length && !matching.length) continue
    if (matching.some(rule => rule.contains_id)) return null
    options.push({ productId: fare.fare_id, name: 'Published fare', amount: price(fare.price, fare.currency_type), currency: fare.currency_type,
      media: fare.payment_method === '0' ? 'Pay on board' : fare.payment_method === '1' ? 'Pay before boarding' : '' })
  }
  return options
}

export function quoteBoardingFare(catalog, leg, serviceDate) {
  if (catalog.unavailableReason) return unavailable(catalog.unavailableReason)
  const data = index(catalog)
  const route = data.routes.get(leg.routeId)
  if (!route || !data.stops.has(leg.fromStopId) || !data.stops.has(leg.toStopId)) return unavailable('No fare could be matched to these stops and route.')
  const v2 = Object.hasOwn(data.t, 'fare_products')
  const options = v2 ? v2Options(data, leg, serviceDate) : v1Options(data, leg)
  if (!options?.length || options.some(option => option.amount === null)) return unavailable('The published rules do not establish a boarding fare for this leg.')
  const agency = data.agencies.get(route.agency_id) ?? (data.agencies.size === 1 ? [...data.agencies.values()][0] : null)
  const url = agency?.agency_fare_url
  return { status: 'published', source: catalog.source, standard: v2 ? 'GTFS Fares v2' : 'GTFS Fares v1',
    options, ...(url && /^https?:\/\//i.test(url) ? { agencyUrl: url } : {}) }
}

export function farePriceLabel(options = []) {
  const groups = new Map()
  for (const option of options) {
    if (price(String(option.amount), option.currency) === null) continue
    groups.set(option.currency, [...(groups.get(option.currency) ?? []), option.amount])
  }
  return [...groups].map(([currency, amounts]) => {
    const format = new Intl.NumberFormat('en-US', { style: 'currency', currency })
    const min = Math.min(...amounts), max = Math.max(...amounts)
    return min === max ? format.format(min) : `${format.format(min)}–${format.format(max)}`
  }).join(' / ')
}

export function boardingFareEvidence(plan) {
  const rides = plan?.legs?.filter(leg => leg.type === 'ride') ?? []
  if (!rides.length) return undefined
  return { basis: 'Separate new boardings. Transfers, joined fare legs and passes are not priced. Do not sum these amounts into a journey total.',
    boardings: rides.map(leg => ({ route: leg.routeShortName || leg.routeId, from: leg.fromName, to: leg.toName,
      status: leg.fare?.status || 'unavailable', options: leg.fare?.options, reason: leg.fare?.reason })) }
}
