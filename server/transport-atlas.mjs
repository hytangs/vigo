export const transportAtlasBudgets = Object.freeze({
  routes: 96,
  stops: 1_000,
  shapePoints: 20_000,
  stopPairs: 0,
})

export const projectTransportAtlasBudgets = Object.freeze({
  routes: 100,
  stops: 16_000,
  shapePoints: 200_000,
  stopPairs: 0,
})

function publicRouteKey(route) {
  return String(route?.routeId || route?.id || '')
}

function routeWeight(route) {
  return Number(route?.tripCount ?? 0) * 1_000_000
    + Number(route?.stopCount ?? route?.stopIds?.length ?? 0) * 1_000
    + Number(route?.coordinates?.length ?? route?.points?.length ?? 0)
}

function fairBoundedAllocation(demands, total) {
  const allocations = demands.map(() => 0)
  let remaining = Math.max(0, Math.floor(total))
  let active = demands.map((_demand, index) => index).filter((index) => demands[index] > 0)
  while (remaining > 0 && active.length) {
    const share = Math.floor(remaining / active.length)
    if (!share) {
      for (const index of active) {
        if (!remaining) break
        allocations[index] += 1
        remaining -= 1
      }
      break
    }
    const satisfied = active.filter((index) => demands[index] - allocations[index] <= share)
    if (satisfied.length) {
      const satisfiedSet = new Set(satisfied)
      for (const index of satisfied) {
        const increment = Math.max(0, demands[index] - allocations[index])
        allocations[index] += increment
        remaining -= increment
      }
      active = active.filter((index) => !satisfiedSet.has(index))
      continue
    }
    for (const index of active) allocations[index] += share
    remaining -= share * active.length
  }
  return allocations
}

function proportionalAllocation(weights, total) {
  const weightTotal = weights.reduce((sum, weight) => sum + Math.max(0, weight), 0)
  if (!weightTotal || total <= 0) return weights.map(() => 0)
  const exact = weights.map((weight) => Math.max(0, weight) / weightTotal * total)
  const allocations = exact.map(Math.floor)
  let remaining = Math.max(0, Math.floor(total) - allocations.reduce((sum, value) => sum + value, 0))
  const order = exact.map((value, index) => ({ index, fraction: value - allocations[index] }))
    .sort((left, right) => right.fraction - left.fraction || left.index - right.index)
  for (const item of order) {
    if (!remaining) break
    allocations[item.index] += 1
    remaining -= 1
  }
  return allocations
}

export function allocateProjectTransportAtlasBudgets(feeds, totals = projectTransportAtlasBudgets) {
  const routeDemands = feeds.map((feed) => new Set((feed.mapPreview?.routes ?? []).map(publicRouteKey)).size)
  const stopDemands = feeds.map((feed) => Number(feed.mapPreview?.stops?.length ?? 0))
  // Route geometry is never selectively dropped from an opened project. Dense
  // networks reduce points per line, while every public service remains in the
  // atlas and selectable from the map.
  const routeAllocations = routeDemands
  const stopAllocations = fairBoundedAllocation(stopDemands, totals.stops)
  const completeRouteShapeBudget = routeAllocations.reduce((sum, count) => sum + count * 72, 0)
  const shapeAllocations = proportionalAllocation(routeAllocations, Math.max(totals.shapePoints, completeRouteShapeBudget))
  return new Map(feeds.map((feed, index) => [feed.id, {
    routes: routeAllocations[index],
    stops: stopAllocations[index],
    shapePoints: shapeAllocations[index],
    stopPairs: 0,
  }]))
}

function representativeRoutes(routes, limit) {
  const representatives = new Map()
  for (const route of routes ?? []) {
    const key = publicRouteKey(route)
    const current = representatives.get(key)
    if (!current || routeWeight(route) > routeWeight(current)) representatives.set(key, route)
  }
  return [...representatives.values()]
    .sort((left, right) => routeWeight(right) - routeWeight(left) || publicRouteKey(left).localeCompare(publicRouteKey(right)))
    .slice(0, limit)
}

function evenlySample(values, limit) {
  if (values.length <= limit) return values
  if (limit <= 0) return []
  if (limit === 1) return [values[0]]
  const sampled = []
  for (let index = 0; index < limit; index += 1) {
    sampled.push(values[Math.round(index * (values.length - 1) / (limit - 1))])
  }
  return sampled
}

function boundedRouteShapes(routes, totalPointLimit) {
  if (!routes.length) return routes
  const inferredRoutes = routes.filter((route) => route.geometrySource !== 'shape')
  const perRouteLimit = inferredRoutes.length
    ? Math.max(2, Math.floor(totalPointLimit / inferredRoutes.length))
    : 0
  return routes.map((route) => {
    const coordinates = Array.isArray(route.coordinates) ? route.coordinates : []
    if (route.geometrySource === 'shape') return route
    if (coordinates.length <= perRouteLimit) return route
    return { ...route, coordinates: evenlySample(coordinates, perRouteLimit) }
  })
}

function hasPosition(stop) {
  return Number.isFinite(Number(stop?.lat)) && Number.isFinite(Number(stop?.lon))
}

function spatiallySampleStops(stops, limit, retainedStopIds) {
  if (limit <= 0) return []
  if ((stops?.length ?? 0) <= limit) return stops ?? []
  const retained = []
  const candidates = []
  for (const stop of stops ?? []) {
    if (retainedStopIds.has(stop.id) && retained.length < limit) retained.push(stop)
    else candidates.push(stop)
  }
  if (retained.length >= limit) return retained.slice(0, limit)

  const positioned = candidates.filter(hasPosition)
  if (!positioned.length) return [...retained, ...evenlySample(candidates, limit - retained.length)]
  let south = Number.POSITIVE_INFINITY
  let north = Number.NEGATIVE_INFINITY
  let west = Number.POSITIVE_INFINITY
  let east = Number.NEGATIVE_INFINITY
  for (const stop of positioned) {
    south = Math.min(south, Number(stop.lat))
    north = Math.max(north, Number(stop.lat))
    west = Math.min(west, Number(stop.lon))
    east = Math.max(east, Number(stop.lon))
  }
  const remaining = limit - retained.length
  const gridSide = Math.max(1, Math.ceil(Math.sqrt(remaining)))
  const cells = new Map()
  for (const stop of positioned) {
    const row = Math.min(gridSide - 1, Math.floor((Number(stop.lat) - south) / Math.max(1e-9, north - south) * gridSide))
    const column = Math.min(gridSide - 1, Math.floor((Number(stop.lon) - west) / Math.max(1e-9, east - west) * gridSide))
    const key = `${row}:${column}`
    const cell = cells.get(key) ?? []
    cell.push(stop)
    cells.set(key, cell)
  }
  const orderedCells = [...cells.entries()]
    .sort(([left], [right]) => left.localeCompare(right, 'en', { numeric: true }))
    .map(([, cell]) => cell)
  const sampled = [...retained]
  let depth = 0
  while (sampled.length < limit) {
    let added = 0
    for (const cell of orderedCells) {
      if (!cell[depth]) continue
      sampled.push(cell[depth])
      added += 1
      if (sampled.length >= limit) break
    }
    if (!added) break
    depth += 1
  }
  if (sampled.length < limit) {
    const sampledIds = new Set(sampled.map((stop) => stop.id))
    sampled.push(...evenlySample(candidates.filter((stop) => !sampledIds.has(stop.id)), limit - sampled.length))
  }
  return sampled
}

export function compactTransportPreview(preview, { routingReady = false, budgets = transportAtlasBudgets } = {}) {
  if (!routingReady || !preview) return preview
  const routeLimitValue = Number(budgets.routes)
  const stopLimitValue = Number(budgets.stops)
  const shapePointLimitValue = Number(budgets.shapePoints)
  const routeLimit = Math.max(0, Math.floor(Number.isFinite(routeLimitValue) ? routeLimitValue : transportAtlasBudgets.routes))
  const stopLimit = Math.max(0, Math.floor(Number.isFinite(stopLimitValue) ? stopLimitValue : transportAtlasBudgets.stops))
  const shapePointLimit = routeLimit
    ? Math.max(routeLimit * 2, Math.floor(Number.isFinite(shapePointLimitValue) ? shapePointLimitValue : transportAtlasBudgets.shapePoints))
    : 0
  const routes = boundedRouteShapes(representativeRoutes(preview.routes ?? [], routeLimit), shapePointLimit)
  const retainedStopIds = new Set()
  const selectedRouteStopIds = new Set()
  for (const route of routes) {
    const stopIds = route.stopIds ?? []
    for (const stopId of stopIds) selectedRouteStopIds.add(stopId)
    if (stopIds[0]) retainedStopIds.add(stopIds[0])
    if (stopIds.at(-1)) retainedStopIds.add(stopIds.at(-1))
  }
  const routeStops = (preview.stops ?? []).filter((stop) => selectedRouteStopIds.has(stop.id))
  const stops = spatiallySampleStops(routeStops.length ? routeStops : preview.stops ?? [], stopLimit, retainedStopIds)
  const visibleStopIds = new Set(stops.map((stop) => stop.id))
  const boundedRoutes = routes.map((route) => ({
    ...route,
    stopIds: (route.stopIds ?? []).filter((stopId) => visibleStopIds.has(stopId)),
  }))
  const visiblePublicRouteIds = new Set(boundedRoutes.flatMap((route) => [route.routeId, route.shortName, route.id].filter(Boolean).map(String)))
  const boundedStops = stops.map((stop) => ({
    ...stop,
    routes: (stop.routes ?? []).filter((routeId) => visiblePublicRouteIds.has(String(routeId))),
  }))
  const sourceStopPairs = preview.stopPairs ?? []
  const deferredStopPairs = Math.max(sourceStopPairs.length, Number(preview.coverage?.stopPairsIndexed ?? 0))
  const shapePoints = boundedRoutes.reduce((sum, route) => sum + Number(route.coordinates?.length ?? 0), 0)

  return {
    ...preview,
    routes: boundedRoutes,
    stops: boundedStops,
    stopPairs: [],
    coverage: {
      ...(preview.coverage ?? {}),
      stopPairsIndexed: preview.coverage?.stopPairsIndexed ?? sourceStopPairs.length,
      capped: Boolean(
        preview.coverage?.capped
        || boundedRoutes.length < (preview.routes?.length ?? 0)
        || stops.length < (preview.stops?.length ?? 0)
        || sourceStopPairs.length
        || shapePoints < (preview.routes ?? []).reduce((sum, route) => sum + Number(route.coordinates?.length ?? 0), 0)
      ),
      transportLod: {
        publicRoutes: boundedRoutes.length,
        stops: stops.length,
        shapePoints,
        stopPairsDeferred: deferredStopPairs,
      },
    },
  }
}
