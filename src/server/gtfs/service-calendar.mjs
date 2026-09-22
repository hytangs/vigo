import { boundedCacheGet, boundedCacheSet } from '../weighted-lru-cache.mjs'

import { numeric } from '../number-utils.mjs'
import { resolveServiceDay } from '../service-day.mjs'

export function yyyymmdd(value) {
  return Number(String(value ?? '').replace(/-/g, '')) || 0
}

function activeServiceIds(db, date, serviceModel = 'exact-date', serviceDay = 'weekday') {
  const dateNumber = yyyymmdd(date)
  const parsed = parseServiceDate(date)
  if (!dateNumber || !parsed) throw new Error('A valid service date is required for national routing.')
  const weekday = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][parsed.getUTCDay()]
  const services = new Set(db.prepare(`SELECT service_id FROM calendar WHERE start_date <= ? AND end_date >= ? AND ${weekday}=1`).all(dateNumber, dateNumber).map((row) => row.service_id))
  for (const row of db.prepare('SELECT service_id, exception_type FROM calendar_dates WHERE date=?').all(dateNumber)) {
    if (row.exception_type === 1) services.add(row.service_id)
    else if (row.exception_type === 2) services.delete(row.service_id)
  }
  if (!services.size && serviceModel === 'weekday-template') {
    const templateColumn = serviceDay === 'saturday' ? 'saturday' : serviceDay === 'sunday' ? 'sunday' : 'monday'
    for (const row of db.prepare(`SELECT service_id FROM calendar WHERE ${templateColumn}=1`).all()) services.add(row.service_id)
  }
  return services
}

function parseServiceDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? '').slice(0, 10))
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  // Date.UTC treats years 0-99 as 1900-1999. Set the full year after
  // construction so date arithmetic and service-day derivation remain correct
  // for every supported four-digit ISO year.
  const parsed = new Date(0)
  parsed.setUTCFullYear(year, month - 1, day)
  parsed.setUTCHours(12, 0, 0, 0)
  if (
    year < 1
    || year > 9999
    || parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) return null
  return parsed
}

function parseNumericServiceDate(value) {
  const text = String(Math.trunc(numeric(value))).padStart(8, '0')
  return parseServiceDate(`${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`)
}

function formatServiceDate(date) {
  return date.toISOString().slice(0, 10)
}

function shiftServiceDate(date, days) {
  return new Date(date.getTime() + days * 86_400_000)
}

export function servicesForDate(store, serviceDate, serviceDay = 'weekday') {
  const serviceKey = `${serviceDate}|${serviceDay}`
  const cached = store.servicesByDate.get(serviceKey)
  if (cached) return cached
  const services = activeServiceIds(store.db, serviceDate, store.serviceModel, serviceDay)
  boundedCacheSet(store.servicesByDate, serviceKey, services, 512)
  return services
}

function activeServiceScopes(services, expectedScopes) {
  const scopes = new Set()
  for (const serviceId of services) {
    const separator = String(serviceId).indexOf('\u001f')
    if (separator <= 0) continue
    const scope = String(serviceId).slice(0, separator)
    if (expectedScopes.has(scope)) scopes.add(scope)
  }
  return scopes
}

export function completeServiceDateSuggestions(store, resolution, serviceDay = 'weekday') {
  if (
    !resolution
    || store.serviceModel !== 'exact-date-multi-feed'
    || resolution.availableServiceScopeCount < 2
    || resolution.resolvedServiceScopeCount >= resolution.availableServiceScopeCount
  ) return []

  const requested = parseServiceDate(resolution.requestedServiceDate)
  if (!requested) return []
  const cacheKey = `complete-date-options|${resolution.requestedServiceDate}|${serviceDay}`
  const cached = boundedCacheGet(store.serviceDateResolutionCache, cacheKey)
  if (cached) return cached

  const expectedScopes = new Set(store.sourceScopes)
  const isComplete = (date) => {
    const services = servicesForDate(store, formatServiceDate(date), serviceDay)
    return activeServiceScopes(services, expectedScopes).size >= expectedScopes.size
  }
  let earlier = null
  let later = null
  // This is a bounded calendar lookup inside the resident worker, not an OD
  // search. Normal gaps resolve in one or two probes; the guard prevents a
  // malformed or disjoint feed pair from scanning an unbounded date range.
  for (let distanceDays = 1; distanceDays <= 62 && (!earlier || !later); distanceDays += 1) {
    if (!earlier) {
      const candidate = shiftServiceDate(requested, -distanceDays)
      if (isComplete(candidate)) earlier = { date: formatServiceDate(candidate), relation: 'earlier', distanceDays }
    }
    if (!later) {
      const candidate = shiftServiceDate(requested, distanceDays)
      if (isComplete(candidate)) later = { date: formatServiceDate(candidate), relation: 'later', distanceDays }
    }
  }

  const options = [earlier, later].filter(Boolean)
  if (options.length) {
    const recommended = [...options].sort((left, right) => (
      left.distanceDays - right.distanceDays
      || (left.relation === 'earlier' ? -1 : 1)
    ))[0]
    recommended.recommended = true
  }
  const result = options.map(({ date, relation, recommended = false }) => ({ date, relation, recommended }))
  boundedCacheSet(store.serviceDateResolutionCache, cacheKey, result, 256)
  return result
}

function serviceDateCandidates(store, requestedDate) {
  const requested = parseServiceDate(requestedDate)
  if (!requested) throw new Error('A valid service date is required for national routing.')
  const targetWeekday = requested.getUTCDay()
  const weekday = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][targetWeekday]
  const seeds = new Set([formatServiceDate(requested)])
  for (const row of store.db.prepare(`SELECT start_date, end_date FROM calendar WHERE ${weekday}=1`).all()) {
    const start = parseNumericServiceDate(row.start_date)
    const end = parseNumericServiceDate(row.end_date)
    if (!start || !end || start > end) continue
    const first = shiftServiceDate(start, (targetWeekday - start.getUTCDay() + 7) % 7)
    const last = shiftServiceDate(end, -((end.getUTCDay() - targetWeekday + 7) % 7))
    if (first > last) continue
    const nearest = requested < first ? first : requested > last ? last : requested
    seeds.add(formatServiceDate(first))
    seeds.add(formatServiceDate(last))
    seeds.add(formatServiceDate(nearest))
  }
  for (const row of store.db.prepare('SELECT DISTINCT date FROM calendar_dates').all()) {
    const exceptionDate = parseNumericServiceDate(row.date)
    if (exceptionDate?.getUTCDay() === targetWeekday) seeds.add(formatServiceDate(exceptionDate))
  }
  const candidates = new Set()
  for (const seed of seeds) {
    const date = parseServiceDate(seed)
    for (const offset of [-7, 0, 7]) {
      const candidate = shiftServiceDate(date, offset)
      if (candidate.getUTCDay() === targetWeekday) candidates.add(formatServiceDate(candidate))
    }
  }
  return candidates
}

function resolveServiceDateUncached(store, requestedServiceDate, serviceDay = 'weekday', allowFallback = false) {
  const requestedDate = parseServiceDate(requestedServiceDate)
  if (!requestedDate) throw new Error('A valid service date is required for national routing.')
  const requested = formatServiceDate(requestedDate)
  if (store.serviceModel === 'weekday-template') {
    const exactRequestedServices = activeServiceIds(store.db, requested, 'exact-date', serviceDay)
    const templateServices = exactRequestedServices.size ? exactRequestedServices : servicesForDate(store, requested, serviceDay)
    const expectedScopes = new Set(store.sourceScopes)
    const requestedScopeCount = activeServiceScopes(exactRequestedServices, expectedScopes).size
    const exact = {
      requestedServiceDate: requested,
      resolvedServiceDate: requested,
      serviceDateFallbackApplied: false,
      serviceDateTemplateApplied: exactRequestedServices.size === 0 && templateServices.size > 0,
      requestedServiceScopeCount: requestedScopeCount,
      resolvedServiceScopeCount: requestedScopeCount,
      availableServiceScopeCount: expectedScopes.size,
      services: templateServices,
    }
    if (exactRequestedServices.size || !allowFallback) return exact
    const cacheKey = `weekday-template|${requested}|${serviceDay}`
    const cached = boundedCacheGet(store.serviceDateResolutionCache, cacheKey)
    if (cached) return cached
    let best = null
    for (const candidate of serviceDateCandidates(store, requested)) {
      const services = activeServiceIds(store.db, candidate, 'exact-date', serviceDay)
      if (!services.size) continue
      const candidateDate = parseServiceDate(candidate)
      const distanceDays = Math.abs(candidateDate.getTime() - requestedDate.getTime()) / 86_400_000
      if (
        best
        && (distanceDays > best.distanceDays
          || (distanceDays === best.distanceDays && services.size < best.services.size)
          || (distanceDays === best.distanceDays && services.size === best.services.size && candidate <= best.resolvedServiceDate))
      ) continue
      best = {
        requestedServiceDate: requested,
        resolvedServiceDate: candidate,
        serviceDateFallbackApplied: candidate !== requested,
        serviceDateTemplateApplied: false,
        requestedServiceScopeCount: requestedScopeCount,
        resolvedServiceScopeCount: activeServiceScopes(services, expectedScopes).size,
        availableServiceScopeCount: expectedScopes.size,
        services,
        distanceDays,
      }
    }
    const resolution = best
      ? {
        requestedServiceDate: best.requestedServiceDate,
        resolvedServiceDate: best.resolvedServiceDate,
        serviceDateFallbackApplied: best.serviceDateFallbackApplied,
        serviceDateTemplateApplied: best.serviceDateTemplateApplied,
        requestedServiceScopeCount: best.requestedServiceScopeCount,
        resolvedServiceScopeCount: best.resolvedServiceScopeCount,
        availableServiceScopeCount: best.availableServiceScopeCount,
        services: best.services,
      }
      : exact
    boundedCacheSet(store.serviceDateResolutionCache, cacheKey, resolution, 256)
    return resolution
  }
  const requestedServices = servicesForDate(store, requested, serviceDay)
  const expectedScopes = new Set(store.sourceScopes)
  const requestedScopeCount = activeServiceScopes(requestedServices, expectedScopes).size
  const exact = {
    requestedServiceDate: requested,
    resolvedServiceDate: requested,
    serviceDateFallbackApplied: false,
    serviceDateTemplateApplied: false,
    requestedServiceScopeCount: requestedScopeCount,
    resolvedServiceScopeCount: requestedScopeCount,
    availableServiceScopeCount: expectedScopes.size,
    services: requestedServices,
  }
  if (
    !allowFallback
    || store.serviceModel !== 'exact-date-multi-feed'
    || expectedScopes.size < 2
    || requestedScopeCount >= expectedScopes.size
  ) return exact

  const cacheKey = `${requested}|${serviceDay}`
  const cached = boundedCacheGet(store.serviceDateResolutionCache, cacheKey)
  if (cached) return cached
  let best = { ...exact, distanceDays: 0 }
  for (const candidate of serviceDateCandidates(store, requested)) {
    const services = servicesForDate(store, candidate, serviceDay)
    const scopeCount = activeServiceScopes(services, expectedScopes).size
    if (!scopeCount) continue
    const candidateDate = parseServiceDate(candidate)
    const distanceDays = Math.abs(candidateDate.getTime() - requestedDate.getTime()) / 86_400_000
    if (
      scopeCount < best.resolvedServiceScopeCount
      || (scopeCount === best.resolvedServiceScopeCount && distanceDays > best.distanceDays)
      || (scopeCount === best.resolvedServiceScopeCount && distanceDays === best.distanceDays && candidate >= best.resolvedServiceDate)
    ) continue
    best = {
      requestedServiceDate: requested,
      resolvedServiceDate: candidate,
      serviceDateFallbackApplied: candidate !== requested,
      serviceDateTemplateApplied: false,
      requestedServiceScopeCount: requestedScopeCount,
      resolvedServiceScopeCount: scopeCount,
      availableServiceScopeCount: expectedScopes.size,
      services,
      distanceDays,
    }
  }
  const resolution = {
    requestedServiceDate: best.requestedServiceDate,
    resolvedServiceDate: best.resolvedServiceDate,
    serviceDateFallbackApplied: best.serviceDateFallbackApplied,
    serviceDateTemplateApplied: best.serviceDateTemplateApplied,
    requestedServiceScopeCount: best.requestedServiceScopeCount,
    resolvedServiceScopeCount: best.resolvedServiceScopeCount,
    availableServiceScopeCount: best.availableServiceScopeCount,
    services: best.services,
  }
  boundedCacheSet(store.serviceDateResolutionCache, cacheKey, resolution, 256)
  return resolution
}

export function resolveServiceDate(store, requestedServiceDate, serviceDay, allowFallback = false) {
  const resolvedServiceDay = resolveServiceDay(requestedServiceDate, serviceDay)
  // Calendar resolution depends only on the immutable, storage-identity-bound
  // GTFS store and these scalar inputs. Cache this derived calendar context,
  // never an OD, access frontier, timetable answer, or materialized plan.
  // openNationalStore invalidation discards the cache when source storage
  // identity changes, so a hot route avoids reparsing the same date and
  // rescanning the same active service set without weakening data freshness.
  const cacheKey = [
    'resolved-service-date-v1',
    String(requestedServiceDate ?? ''),
    resolvedServiceDay,
    allowFallback ? 'fallback' : 'exact',
  ].join('|')
  const cached = boundedCacheGet(store.serviceDateResolutionCache, cacheKey)
  if (cached) return cached
  const resolution = resolveServiceDateUncached(
    store,
    requestedServiceDate,
    resolvedServiceDay,
    allowFallback,
  )
  boundedCacheSet(store.serviceDateResolutionCache, cacheKey, resolution, 256)
  return resolution
}

export function serviceDateDiagnostics(resolution) {
  return {
    serviceDate: resolution.requestedServiceDate,
    requestedServiceDate: resolution.requestedServiceDate,
    resolvedServiceDate: resolution.resolvedServiceDate,
    serviceDateFallbackApplied: resolution.serviceDateFallbackApplied,
    serviceDateTemplateApplied: resolution.serviceDateTemplateApplied === true,
    requestedServiceScopeCount: resolution.requestedServiceScopeCount,
    resolvedServiceScopeCount: resolution.resolvedServiceScopeCount,
    availableServiceScopeCount: resolution.availableServiceScopeCount,
    resolutionStrategy: resolution.resolutionStrategy,
  }
}

export function lightweightServiceAnchorDateResolution(store, request) {
  // A single exact-date store has no cross-feed completeness choice and does
  // not support nearest-date substitution. The service-anchor certificate is
  // deliberately built from the all-service role superset, so enumerating
  // every active service_id cannot tighten or validate that lower bound. On
  // very large feeds it only repeats tens of thousands of indexed table
  // lookups before the normal route core would perform the same enumeration.
  if (store.serviceModel === 'exact-date' && store.sourceScopes.length === 0) {
    const requestedDate = parseServiceDate(request.serviceDate)
    if (!requestedDate) throw new Error('A valid service date is required for national routing.')
    const requestedServiceDate = formatServiceDate(requestedDate)
    return {
      requestedServiceDate,
      resolvedServiceDate: requestedServiceDate,
      serviceDateFallbackApplied: false,
      serviceDateTemplateApplied: false,
      requestedServiceScopeCount: 0,
      resolvedServiceScopeCount: 0,
      availableServiceScopeCount: 0,
      services: new Set(),
      resolutionStrategy:
        'single_feed_exact_date_global_anchor_superset_no_service_enumeration',
    }
  }
  return resolveServiceDate(
    store,
    request.serviceDate,
    request.serviceDay,
    request.allowServiceDateFallback === true,
  )
}
