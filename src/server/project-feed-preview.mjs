import { readNationalGtfsRouteCatalog, readNationalGtfsPreview } from './gtfs/network-preview.mjs'
import { readGtfsNetworkOverviewAsync } from './gtfs-analysis-store.mjs'
import { projectTransportAtlasBudgets } from './transport-atlas.mjs'

function mergePreviewStops(primary = [], secondary = []) {
  const merged = new Map()
  for (const stop of [...primary, ...secondary]) {
    const existing = merged.get(stop.id)
    if (!existing) {
      merged.set(stop.id, stop)
      continue
    }
    merged.set(stop.id, {
      ...existing,
      ...stop,
      routes: [...new Set([...(existing.routes ?? []), ...(stop.routes ?? [])])],
      tripCount: Math.max(Number(existing.tripCount ?? 0), Number(stop.tripCount ?? 0)),
      transferScore: Math.max(Number(existing.transferScore ?? 0), Number(stop.transferScore ?? 0)),
    })
  }
  return [...merged.values()]
}

// Build once away from the API event loop; the optional cache does not change City data.
export async function buildProjectFeedPreview(storePath, { sourceScope = '', routeCount, stopCount, tripCount }) {
const routeMetrics = readNationalGtfsRouteCatalog(storePath, { sourceScope })
const representativeRouteIds = [...routeMetrics]
  .sort((left, right) =>
    Number(right.tripCount ?? 0) - Number(left.tripCount ?? 0)
    || String(left.shortName ?? left.routeId ?? left.id).localeCompare(String(right.shortName ?? right.routeId ?? right.id)),
  )
  .slice(0, projectTransportAtlasBudgets.routes)
  .map((route) => route.routeId || route.id)
const mapPreview = readNationalGtfsPreview(storePath, {
  routeCount: routeCount,
  stopCount: stopCount,
  tripCount: tripCount,
  sourceScope,
  routeLimit: projectTransportAtlasBudgets.routes,
  representativeRouteIds,
})
const completeOverview = await readGtfsNetworkOverviewAsync(storePath, { sourceScope })
if (!completeOverview.routes.length) return undefined
const previewByRoute = new Map(completeOverview.routes.map((route) => [route.routeId || route.id, route]))
const hydratedRouteMetrics = routeMetrics.filter((route) => Number(route.tripCount ?? 0) > 0).map((route) => {
  const previewRoute = previewByRoute.get(route.routeId || route.id)
  return previewRoute
    ? { ...route, ...previewRoute, tripCount: route.tripCount, serviceVariantCount: route.serviceVariantCount }
    : route
})
const overviewStops = mergePreviewStops(completeOverview.stops, mapPreview.stops)
const completePreview = {
  ...mapPreview,
  routes: hydratedRouteMetrics,
  stops: overviewStops,
  coverage: {
    ...completeOverview.coverage,
    rawRouteRows: routeMetrics.length,
    publicRouteIdentities: hydratedRouteMetrics.length,
    stopsIndexed: overviewStops.length,
    capped: false,
  },
}
return {
  routeMetrics: hydratedRouteMetrics,
  stopMetrics: completePreview.stops,
  mapPreview: completePreview,
}
}
