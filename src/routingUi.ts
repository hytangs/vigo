import { formatNumber, type LngLat, type MapPreview, type RouteMetric, type StopMetric } from './domain'
import { coordinateDistanceKm } from './app/geometry'
import { routeListLabel, routeListLabels } from './app/routePresentation'
import { scopedRouteServiceKey } from './routeServices'
import type {
  NetworkSearchHit,
  RoutingPoint,
} from './routingModel'
export { parseRoutingCommand } from './routingCommand'

function normalize(value: string) {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function stopCoordinate(stop: StopMetric): LngLat | null {
  if (typeof stop.lon === 'number' && typeof stop.lat === 'number') return [stop.lon, stop.lat]
  return null
}

export function buildRoutingPointFromMap(coordinate: LngLat, label: string): RoutingPoint {
  return {
    coordinate,
    label,
    source: 'map',
  }
}

type TextMatch = {
  level: 0 | 1 | 2 | 3
  score: number
}

const noTextMatch: TextMatch = { level: 0, score: 0 }

// Levels are contains (1), prefix (2) and exact (3); the score orders matches
// of the same level.
function matchText(normalizedQuery: string, normalizedValues: string[]): TextMatch {
  let best = noTextMatch
  for (const value of normalizedValues) {
    let match = noTextMatch
    if (value === normalizedQuery) match = { level: 3, score: 120 }
    else if (value.startsWith(normalizedQuery)) match = { level: 2, score: 92 - value.length * 0.1 }
    else if (value.includes(normalizedQuery)) match = { level: 1, score: Math.max(1, 58 - value.indexOf(normalizedQuery)) }
    if (match.score > best.score) best = match
  }
  return best
}

// Hits sort by rank before score. Exact names lead, then station and stop name
// prefixes, then lines, then near-duplicate service variants, and finally stops
// matched only inside their names or through ids, platforms or served routes.
const searchRank = {
  stopExact: 0,
  lineExact: 1,
  stopPrefix: 2,
  line: 3,
  variant: 4,
  stopContains: 5,
  stopOther: 6,
} as const

function stopSearchRank(name: TextMatch, other: TextMatch) {
  if (name.level === 3) return searchRank.stopExact
  if (name.level === 2) return searchRank.stopPrefix
  if (name.level === 1) return searchRank.stopContains
  return other.level ? searchRank.stopOther : null
}

function searchEntityScope(id = '') {
  const scopeSplit = id.indexOf('::')
  return scopeSplit > 0 ? id.slice(0, scopeSplit) : ''
}

function preferredSearchRoute(routes: RouteMetric[]) {
  return [...routes].sort((left, right) => {
    const rankDelta = (left.patternRank ?? Number.MAX_SAFE_INTEGER) - (right.patternRank ?? Number.MAX_SAFE_INTEGER)
    if (rankDelta) return rankDelta
    return right.tripCount - left.tripCount
  })[0]
}

function routeGroupSubtitle(route: RouteMetric, routes: RouteMetric[], detailLabel = routeListLabel(route)) {
  if (routes.length <= 1) return detailLabel
  const trips = routes.reduce((sum, item) => sum + Math.max(0, item.tripCount || 0), 0)
  const directions = new Set(routes.map((item) => item.directionId ?? '').filter(Boolean)).size
  const directionLabel = directions ? `${directions} direction${directions === 1 ? '' : 's'}` : 'direction unknown'
  return `${detailLabel} · ${routes.length} variants · ${directionLabel} · ${formatNumber(trips)} trips`
}

// Separate GTFS routes sharing a feed, mode, colour and short name, such as
// rail-replacement shuttles, are variants of one service in search.
function routeVariantKey(route: RouteMetric, normalizeValue: (value: string) => string) {
  const name = normalizeValue(route.shortName || '')
  if (!name) return ''
  const color = String(route.color || '').replace(/^#/, '').toLowerCase()
  return `${searchEntityScope(route.id)}:${route.routeType ?? ''}:${color}:${name}`
}

const maxStopSearchGroupRadiusKm = 0.35

function stopSearchBaseKey(stop: StopMetric, normalizeValue: (value: string) => string) {
  if (stop.parentStationId) return `${searchEntityScope(stop.id)}:parent:${stop.parentStationId}`
  return `${searchEntityScope(stop.id)}:${normalizeValue(stop.name || stop.id)}`
}

function groupSearchStops(stops: StopMetric[], normalizeValue: (value: string) => string) {
  const buckets = new Map<string, StopMetric[]>()
  const coordinates = new Map<StopMetric, LngLat>()
  for (const stop of stops) {
    const coordinate = stopCoordinate(stop)
    if (!coordinate) continue
    coordinates.set(stop, coordinate)
    const key = stopSearchBaseKey(stop, normalizeValue)
    const bucket = buckets.get(key)
    if (bucket) bucket.push(stop)
    else buckets.set(key, [stop])
  }

  const groups: StopMetric[][] = []
  for (const bucket of buckets.values()) {
    const localGroups: StopMetric[][] = []
    for (const stop of [...bucket].sort((left, right) => right.tripCount + right.transferScore - (left.tripCount + left.transferScore))) {
      const coordinate = coordinates.get(stop)
      if (!coordinate) continue
      const existing = localGroups.find((group) => group.some((member) => {
        const memberCoordinate = coordinates.get(member)
        return memberCoordinate && coordinateDistanceKm(coordinate, memberCoordinate) <= maxStopSearchGroupRadiusKm
      }))
      if (existing) existing.push(stop)
      else localGroups.push([stop])
    }
    groups.push(...localGroups)
  }
  return groups
}

function stopGroupSubtitle(stop: StopMetric, stops: StopMetric[]) {
  if (stops.length <= 1) {
    const serviceCount = stop.routes.length
    return `${formatNumber(serviceCount)} ${serviceCount === 1 ? 'service' : 'services'} · ${formatNumber(stop.tripCount)} stop-times`
  }
  const routeCount = new Set(stops.flatMap((item) => item.routes)).size
  const stopTimes = stops.reduce((sum, item) => sum + Math.max(0, item.tripCount || 0), 0)
  return `${formatNumber(stops.length)} platforms · ${formatNumber(routeCount)} services · ${formatNumber(stopTimes)} stop-times`
}

type IndexedRouteSearchGroup = {
  route: RouteMetric
  normalizedValues: string[]
  label: string
  subtitle: string
  tripCount: number
  variantKey: string
}

type IndexedSearchStop = {
  stop: StopMetric
  nameValues: string[]
  otherValues: string[]
  activity: number
}

type IndexedStopSearchGroup = {
  stops: IndexedSearchStop[]
  subtitle: string
  activity: number
}

export type NetworkSearchIndex = {
  routeGroups: IndexedRouteSearchGroup[]
  stopGroups: IndexedStopSearchGroup[]
}

export function buildNetworkSearchIndex(preview: MapPreview): NetworkSearchIndex {
  const normalizedValueCache = new Map<string, string>()
  const normalizeValue = (value: string) => {
    const cached = normalizedValueCache.get(value)
    if (cached !== undefined) return cached
    const normalized = normalize(value)
    normalizedValueCache.set(value, normalized)
    return normalized
  }
  const normalizedValues = (values: string[]) => values.map(normalizeValue).filter(Boolean)
  const routeGroups = new Map<string, RouteMetric[]>()
  for (const route of preview.routes) {
    const key = scopedRouteServiceKey(route)
    const group = routeGroups.get(key)
    if (group) group.push(route)
    else routeGroups.set(key, [route])
  }
  const groupedRoutes = Array.from(routeGroups.values())
  const preferredRoutes = groupedRoutes.map(preferredSearchRoute)
  const routeLabels = routeListLabels(preferredRoutes)
  const variantKeys = preferredRoutes.map((route) => routeVariantKey(route, normalizeValue))
  const variantCounts = new Map<string, number>()
  for (const key of variantKeys) if (key) variantCounts.set(key, (variantCounts.get(key) ?? 0) + 1)

  return {
    routeGroups: groupedRoutes.map((routes, index) => {
      const route = preferredRoutes[index]
      const label = routeLabels.get(route.id) ?? routeListLabel(route)
      return {
        route,
        normalizedValues: normalizedValues(routes.flatMap((item) => [
          item.routeId ?? '',
          item.shortName,
          item.longName,
        ])),
        label,
        subtitle: routeGroupSubtitle(route, routes, label),
        tripCount: routes.reduce((sum, item) => sum + Math.max(0, item.tripCount || 0), 0),
        variantKey: (variantCounts.get(variantKeys[index]) ?? 0) > 1 ? variantKeys[index] : '',
      }
    }),
    stopGroups: groupSearchStops(preview.stops, normalizeValue).map((stops) => ({
      stops: stops.map((stop) => ({
        stop,
        nameValues: normalizedValues([stop.name, stop.parentStationName ?? '']),
        otherValues: normalizedValues([stop.id, stop.platformCode ?? '', ...stop.routes]),
        activity: stop.tripCount + stop.transferScore,
      })),
      subtitle: stopGroupSubtitle(stops[0], stops),
      activity: stops.reduce((sum, item) => sum + Math.max(0, item.tripCount + item.transferScore), 0),
    })),
  }
}

function buildNetworkStopSearchHits(index: NetworkSearchIndex, normalizedQuery: string) {
  return index.stopGroups
    .map<NetworkSearchHit | null>((group) => {
      let preferred: { candidate: IndexedSearchStop, rank: number, score: number } | null = null
      for (const candidate of group.stops) {
        const name = matchText(normalizedQuery, candidate.nameValues)
        const other = matchText(normalizedQuery, candidate.otherValues)
        const rank = stopSearchRank(name, other)
        if (rank === null) continue
        const score = Math.max(name.score, other.score)
        if (
          !preferred
          || rank < preferred.rank
          || (rank === preferred.rank && score > preferred.score)
          || (rank === preferred.rank && score === preferred.score && candidate.activity > preferred.candidate.activity)
        ) preferred = { candidate, rank, score }
      }
      if (!preferred) return null
      const { stop } = preferred.candidate
      const coordinate = stopCoordinate(stop)
      if (!coordinate) return null
      return {
        id: `stop:${stop.id}`,
        kind: 'stop',
        title: stop.parentStationName || stop.name || stop.id,
        subtitle: group.subtitle,
        rank: preferred.rank,
        score: preferred.score + Math.min(18, Math.log10(Math.max(1, group.activity)) * 3),
        stopId: stop.id,
        coordinate,
      }
    })
    .filter((hit): hit is NetworkSearchHit => Boolean(hit))
}

type RouteSearchMatch = {
  group: IndexedRouteSearchGroup
  match: TextMatch
}

function routeSearchHit({ route }: IndexedRouteSearchGroup, rank: number, score: number, tripCount: number, subtitle: string): NetworkSearchHit {
  return {
    id: `route:${route.id}`,
    kind: 'route',
    title: route.shortName || route.routeId || route.id,
    subtitle,
    rank,
    score: score + Math.min(18, Math.log10(Math.max(1, tripCount)) * 4),
    routeId: route.id,
  }
}

// One result stands for every matching variant of a service; it opens the
// variant that matches the query best.
function routeVariantSearchHit(matches: RouteSearchMatch[]): NetworkSearchHit {
  const ordered = [...matches].sort((left, right) => right.match.score - left.match.score || right.group.tripCount - left.group.tripCount)
  const [best] = ordered
  const rank = best.match.level === 3 ? searchRank.lineExact : searchRank.variant
  const tripCount = ordered.reduce((sum, item) => sum + item.group.tripCount, 0)
  if (ordered.length === 1) return routeSearchHit(best.group, rank, best.match.score, tripCount, best.group.subtitle)
  const labels = ordered.slice(0, 3).map((item) => item.group.label)
  const subtitle = `${formatNumber(ordered.length)} variants · ${labels.join(', ')}${ordered.length > labels.length ? '…' : ''}`
  return { ...routeSearchHit(best.group, rank, best.match.score, tripCount, subtitle), variantCount: ordered.length }
}

function buildNetworkRouteSearchHits(index: NetworkSearchIndex, normalizedQuery: string) {
  const hits: NetworkSearchHit[] = []
  const variants = new Map<string, RouteSearchMatch[]>()
  for (const group of index.routeGroups) {
    const match = matchText(normalizedQuery, group.normalizedValues)
    if (!match.level) continue
    if (!group.variantKey) {
      const rank = match.level === 3 ? searchRank.lineExact : searchRank.line
      hits.push(routeSearchHit(group, rank, match.score, group.tripCount, group.subtitle))
      continue
    }
    const family = variants.get(group.variantKey)
    if (family) family.push({ group, match })
    else variants.set(group.variantKey, [{ group, match }])
  }
  for (const family of variants.values()) hits.push(routeVariantSearchHit(family))
  return hits
}

// Keep room for both services and stops so a dense set of stop names cannot
// hide every line, then fill the remaining places in rank order.
function balancedSearchHits(hits: NetworkSearchHit[], limit: number) {
  const quota = Math.ceil(limit / 2)
  const kindCounts = { route: 0, stop: 0 }
  const chosen = new Set<NetworkSearchHit>()
  for (const hit of hits) {
    if (chosen.size >= limit) break
    if (kindCounts[hit.kind] >= quota) continue
    chosen.add(hit)
    kindCounts[hit.kind] += 1
  }
  for (const hit of hits) {
    if (chosen.size >= limit) break
    chosen.add(hit)
  }
  return hits.filter((hit) => chosen.has(hit))
}

function isNetworkSearchIndex(source: MapPreview | NetworkSearchIndex): source is NetworkSearchIndex {
  return 'routeGroups' in source && 'stopGroups' in source
}

export function findNetworkSearchHits(source: MapPreview | NetworkSearchIndex, query: string, limit = 8): NetworkSearchHit[] {
  const normalizedQuery = normalize(query)
  if (!normalizedQuery) return []
  const index = isNetworkSearchIndex(source) ? source : buildNetworkSearchIndex(source)

  const routeHits = buildNetworkRouteSearchHits(index, normalizedQuery)
  const stopHits = normalizedQuery.length > 1
    ? buildNetworkStopSearchHits(index, normalizedQuery)
    : []

  const ranked = [...routeHits, ...stopHits]
    .sort((left, right) => left.rank - right.rank || right.score - left.score)
  return balancedSearchHits(ranked, limit)
}
