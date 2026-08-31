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

function scoreTextMatch(normalizedQuery: string, normalizedValues: string[]) {
  let score = 0
  for (const value of normalizedValues) {
    if (value === normalizedQuery) score = Math.max(score, 120)
    else if (value.startsWith(normalizedQuery)) score = Math.max(score, 92 - value.length * 0.1)
    else if (value.includes(normalizedQuery)) score = Math.max(score, 58 - value.indexOf(normalizedQuery))
  }
  return score
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
  subtitle: string
  tripCount: number
}

type IndexedSearchStop = {
  stop: StopMetric
  normalizedValues: string[]
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

  return {
    routeGroups: groupedRoutes.map((routes) => {
      const route = preferredSearchRoute(routes)
      return {
        route,
        normalizedValues: normalizedValues(routes.flatMap((item) => [
          item.routeId ?? '',
          item.shortName,
          item.longName,
        ])),
        subtitle: routeGroupSubtitle(route, routes, routeLabels.get(route.id)),
        tripCount: routes.reduce((sum, item) => sum + Math.max(0, item.tripCount || 0), 0),
      }
    }),
    stopGroups: groupSearchStops(preview.stops, normalizeValue).map((stops) => ({
      stops: stops.map((stop) => ({
        stop,
        normalizedValues: normalizedValues([
          stop.id,
          stop.name,
          stop.parentStationName ?? '',
          stop.platformCode ?? '',
          ...stop.routes,
        ]),
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
      let preferred = group.stops[0]
      let preferredTextScore = 0
      let textScore = 0
      for (const candidate of group.stops) {
        const candidateTextScore = scoreTextMatch(normalizedQuery, candidate.normalizedValues)
        textScore = Math.max(textScore, candidateTextScore)
        if (
          candidateTextScore > preferredTextScore
          || (candidateTextScore === preferredTextScore && candidate.activity > preferred.activity)
        ) {
          preferred = candidate
          preferredTextScore = candidateTextScore
        }
      }
      if (textScore <= 0) return null
      const coordinate = stopCoordinate(preferred.stop)
      if (!coordinate) return null
      return {
        id: `stop:${preferred.stop.id}`,
        kind: 'stop',
        title: preferred.stop.parentStationName || preferred.stop.name || preferred.stop.id,
        subtitle: group.subtitle,
        score: textScore + Math.min(18, Math.log10(Math.max(1, group.activity)) * 3),
        stopId: preferred.stop.id,
        coordinate,
      }
    })
    .filter((hit): hit is NetworkSearchHit => Boolean(hit))
}

function isNetworkSearchIndex(source: MapPreview | NetworkSearchIndex): source is NetworkSearchIndex {
  return 'routeGroups' in source && 'stopGroups' in source
}

export function findNetworkSearchHits(source: MapPreview | NetworkSearchIndex, query: string, limit = 8): NetworkSearchHit[] {
  const normalizedQuery = normalize(query)
  if (!normalizedQuery) return []
  const index = isNetworkSearchIndex(source) ? source : buildNetworkSearchIndex(source)

  const routeHits = index.routeGroups
    .map<NetworkSearchHit | null>((group) => {
      const textScore = scoreTextMatch(normalizedQuery, group.normalizedValues)
      if (textScore <= 0) return null
      const { route } = group
      return {
        id: `route:${route.id}`,
        kind: 'route',
        title: route.shortName || route.routeId || route.id,
        subtitle: group.subtitle,
        score: textScore + Math.min(18, Math.log10(Math.max(1, group.tripCount)) * 4),
        routeId: route.id,
      }
    })
    .filter((hit): hit is NetworkSearchHit => Boolean(hit))

  const stopHits = normalizedQuery.length > 1
    ? buildNetworkStopSearchHits(index, normalizedQuery)
    : []

  return [...routeHits, ...stopHits]
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
}
