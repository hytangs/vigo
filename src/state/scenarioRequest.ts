import { flexZoneRing, flexZoneSelfIntersects, smoothRailPath } from '../app/scenarioGeometry'
import type { RouteMetric } from '../domain'
import {
  routeHasPublishedShape,
  scenarioEdgeEditError,
  scenarioEdgeGeometryForBranch,
  scenarioEdgeIndexes,
  scenarioInsertedStopsForEdge,
  scenarioSegmentRuntimeMinutes,
  scenarioSourceRouteId,
  scenarioStopsForEdgeBranch,
  scenarioStopsForRoute,
  type ScenarioChangeDraft,
  type ScenarioDraft,
  type ScenarioGeometryMode,
  type ScenarioRouteScope,
  type ScenarioServiceDraft,
  type ScenarioStopDraft,
  type ScenarioTimeModel,
} from '../reach'
import { scopedRouteServiceKey } from '../routeServices'
import { clock } from './clock'
import { findScenarioRoute } from './scenarios'
import { preview } from './scope'

/**
 * A saved scenario as the engine's planned services, or the first change that
 * cannot run yet. Route and Reach send exactly this; the Rust overlay compiles it.
 */
export function scenarioRequestFor(scenario: ScenarioDraft | undefined) {
  const currentPreview = preview()
  const serviceDate = clock.get().serviceDate
  const services: ScenarioServiceDraft[] = []
  const excludedRouteIds: string[] = []
  const excludedPatternIds: Array<{ routeId: string; patternId: string }> = []
  const serviceFor = (
    intervention: ScenarioChangeDraft,
    scenarioRoute: RouteMetric | undefined,
    stops: ScenarioStopDraft[],
    serviceId: string,
    serviceName: string,
  ): ScenarioServiceDraft => {
    const geometryMode: ScenarioGeometryMode = intervention.geometryMode
      ?? (intervention.timeModel === 'infer-road'
        ? 'auto-road'
        : intervention.timeModel === 'estimate-distance'
          ? 'straight-line'
          : scenarioRoute ? 'published-shape' : 'straight-line')
    // A rail alignment is measured along its curve; the engine times each
    // stop pair from those supplied distances, as it does a traced road path.
    const rail = geometryMode === 'smooth-rail' ? smoothRailPath(stops.map((stop) => stop.coordinate)) : null
    const timeModel: ScenarioTimeModel = geometryMode === 'auto-road' || rail
      ? 'infer-road'
      : geometryMode === 'straight-line'
        ? 'estimate-distance'
        : 'preserve-scheduled'
    const inferredReady = intervention.geometryStatus === 'ready'
      && Array.isArray(intervention.inferredGeometry)
      && intervention.inferredGeometry.length >= 2
    const geometry = rail
      ? rail.geometry
      : geometryMode === 'auto-road'
        ? inferredReady
          ? intervention.inferredGeometry
          : undefined
        : geometryMode === 'straight-line'
          ? stops.map((stop) => stop.coordinate)
          : routeHasPublishedShape(scenarioRoute)
            ? scenarioRoute.coordinates
            : undefined
    const segmentDistancesKm = rail
      ? rail.distancesKm
      : inferredReady
        ? intervention.inferredSegmentDistanceKm
        : undefined
    return {
      id: serviceId,
      name: serviceName,
      operation: intervention.kind === 'add-line'
        ? 'add'
        : intervention.kind === 'change-line'
          ? 'replace'
          : 'augment',
      scheduleMode: intervention.kind === 'change-line' ? intervention.scheduleMode ?? 'preserve-trips' : 'frequency',
      sourceRouteId: scenarioRoute ? scenarioSourceRouteId(scenarioRoute) : undefined,
      sourcePatternId: scenarioRoute?.patternId ?? scenarioRoute?.id,
      // Each exact-edge branch replacement is hydrated and excluded by its
      // own GTFS pattern. The UI-level edge scope is expanded below.
      routeScope: intervention.routeScope === 'edge' ? 'pattern' : intervention.routeScope,
      timeModel,
      bidirectional: intervention.routeScope === 'edge'
        || (intervention.kind === 'change-line' && intervention.scheduleMode !== 'frequency')
        ? false : intervention.bidirectional,
      headwayMinutes: intervention.headwayMinutes,
      startMinutes: intervention.startMinutes,
      endMinutes: intervention.endMinutes,
      averageSpeedKph: intervention.averageSpeedKph,
      dwellMinutes: 0.35,
      ...(segmentDistancesKm ? { segmentDistancesKm } : {}),
      ...(scenarioRoute && (timeModel === 'preserve-scheduled' || timeModel === 'infer-road')
        ? {
            segmentRuntimeMinutes: scenarioSegmentRuntimeMinutes(scenarioRoute, stops, currentPreview, {
              segmentDistancesKm,
            }),
            addedStopDwellMinutes: timeModel === 'infer-road' ? 0.35 : 0,
          }
        : {}),
      ...(geometry && geometry.length >= 2
        ? {
            geometry,
            geometrySource: geometryMode === 'auto-road'
              ? intervention.inferredGeometrySource === 'published_shape_fallback'
                ? 'shape' as const
                : 'osm_drive' as const
              : geometryMode === 'straight-line' || rail
                ? 'stop_sequence' as const
                : scenarioRoute?.geometrySource ?? 'shape' as const,
          }
        : {}),
      stops,
    }
  }
  const flexZones: Array<{ id: string; name: string; geometry: { type: string; coordinates: number[][][] }; startMinutes: number; endMinutes: number; averageSpeedKph: number; waitMinutes: number }> = []
  for (const intervention of scenario?.interventions ?? []) {
    if (intervention.kind === 'flex-zone') {
      const vertices = intervention.stops.map(stop => stop.coordinate)
      if (vertices.length < 3 || flexZoneSelfIntersects(vertices)) return { error: `${intervention.name} needs a valid outline with at least three corners.` }
      flexZones.push({ id: intervention.id, name: intervention.name,
        geometry: { type: 'Polygon', coordinates: [flexZoneRing(vertices)] },
        startMinutes: intervention.startMinutes, endMinutes: intervention.endMinutes,
        averageSpeedKph: intervention.averageSpeedKph, waitMinutes: intervention.flexWaitMinutes ?? 15 })
      continue
    }
    const scenarioRoute = findScenarioRoute(currentPreview.routes, intervention.routeId)
    if (intervention.kind !== 'add-line' && !scenarioRoute) {
      return { error: `Choose a route for ${intervention.name}.` }
    }
    const sourceRouteId = scenarioRoute ? scenarioSourceRouteId(scenarioRoute) : undefined
    const routeScope: ScenarioRouteScope = intervention.routeScope ?? 'pattern'
    if (['remove-line', 'change-line'].includes(intervention.kind) && sourceRouteId) {
      if (routeScope === 'route') {
        excludedRouteIds.push(sourceRouteId)
      } else if (scenarioRoute?.patternId ?? scenarioRoute?.id) {
        if (intervention.kind === 'remove-line') {
          excludedPatternIds.push({
            routeId: sourceRouteId,
            patternId: scenarioRoute.patternId ?? scenarioRoute.id,
          })
        }
      }
    }
    if (intervention.kind === 'remove-line') continue
    if (intervention.geometryMode === 'auto-road' && intervention.geometryStatus !== 'ready') {
      return { error: `Trace ${intervention.name} along roads before running it, or choose a rail or direct alignment.` }
    }
    const stops = ['add-line', 'change-line'].includes(intervention.kind)
      ? intervention.stops
      : scenarioStopsForRoute(scenarioRoute, currentPreview)
    if (stops.length < 2) {
      return { error: `${intervention.name} needs at least two ordered GTFS or placed stops.` }
    }
    if (routeScope === 'edge' && intervention.kind === 'change-line') {
      if (!scenarioRoute) return { error: `${intervention.name} needs a selected GTFS branch before applying an exact edge edit.` }
      const edgeRoute = scenarioRoute
      const edgeError = scenarioEdgeEditError(edgeRoute, stops)
      if (edgeError) return { error: `${intervention.name}: ${edgeError}` }
      const edgeEdit = scenarioInsertedStopsForEdge(stops)
      if (!edgeEdit) {
        return { error: `${intervention.name} needs one or more inserted stops anchored between an exact ordered A → B GTFS edge.` }
      }
      const serviceBranches = currentPreview.routes
        .filter((candidate) => scopedRouteServiceKey(candidate) === scopedRouteServiceKey(edgeRoute))
      if (serviceBranches.length !== edgeRoute.serviceVariantCount
        || serviceBranches.some((candidate) => candidate.analysisSource !== 'focused'
          || candidate.analysisServiceDate !== serviceDate)) {
        return { error: `Load every GTFS branch of ${edgeRoute.shortName} for ${serviceDate} before applying an exact-edge edit.` }
      }
      const matchingBranches = serviceBranches.filter((candidate) => (
        scenarioEdgeIndexes(candidate, edgeEdit.beforeStopId, edgeEdit.afterStopId).length > 0
      ))
      if (!matchingBranches.length) {
        return { error: `No GTFS branch in ${edgeRoute.shortName} serves the exact ordered ${edgeEdit.beforeStopId} → ${edgeEdit.afterStopId} edge.` }
      }
      for (const branch of matchingBranches) {
        const branchStops = scenarioStopsForEdgeBranch(intervention, branch, currentPreview)
        if (branchStops.length < 2) {
          return { error: `Load the complete ordered stops for ${branch.shortName} · Pattern ${branch.patternRank ?? branch.id} before applying this edge edit.` }
        }
        const branchGeometry = intervention.geometryMode === 'auto-road'
          ? scenarioEdgeGeometryForBranch(intervention, branch, currentPreview)
          : undefined
        if (intervention.geometryMode === 'auto-road' && !branchGeometry) {
          return { error: `The edited road gap cannot be applied to ${branch.shortName} · ${branch.patternRank ?? branch.id}. Load its complete published shape and rebuild the road path.` }
        }
        services.push(serviceFor(
          branchGeometry ? { ...intervention, inferredGeometry: branchGeometry.geometry,
            inferredSegmentDistanceKm: branchGeometry.segmentDistancesKm, inferredGeometrySource: 'hybrid' } : intervention,
          branch,
          branchStops,
          `${intervention.id}:${branch.id}`,
          `${intervention.name} · ${branch.directionId || 'branch'} · ${branch.patternRank ?? branch.id}`,
        ))
      }
      continue
    }
    services.push(serviceFor(
      intervention,
      scenarioRoute,
      stops,
      intervention.id,
      intervention.name,
    ))
  }
  return {
    flexZoneCount: flexZones.length,
    scenario: {
      id: scenario?.id ?? 'baseline-only',
      name: scenario?.name ?? 'Baseline',
      services,
      flexZones,
      excludedRouteIds: [...new Set(excludedRouteIds)],
      excludedPatternIds,
    },
  }
}
