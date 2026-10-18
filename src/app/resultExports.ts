import type { FeatureCollection, Geometry } from 'geojson'
import type { RoutingPlan } from '../routingModel'
import { routingPlanJourneyMinutes, routingPlanStartWaitMinutes, routingPlanTotalElapsedMinutes } from './routingPlan'
import { reachResultDifference, reachResultMetrics, reachScenarioDifference } from './resultSummary'
import {
  scenarioImprovedPixels, scenarioWorsenedPixels, scenarioReachablePixels,
  type ReachResult, type ReachComparisonResult,
} from '../reach'

import { rankedCompareEntries, type ComparisonRun } from './comparison'

export type ResultFile = { name: string; text: string; type: string }
export type ResultExportFormat = 'json' | 'geojson' | 'csv' | 'md'

function file(kind: string, format: ResultExportFormat, value: unknown, identity: string[], exportedAt: string): ResultFile {
  const slug = (value: string) => {
    const safe = value.normalize('NFKC').replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^[.-]+|[.-]+$/g, '')
    let result = '', bytes = 0
    for (const character of safe) {
      bytes += new TextEncoder().encode(character).length
      if (bytes > 36) break
      result += character
    }
    return result
  }
  return {
    name: ['vigo', kind, ...identity.map(slug).filter(Boolean), exportedAt.replace(/[-:.]/g, '')].join('-') + `.${format}`,
    type: format === 'md' ? 'text/markdown;charset=utf-8' : format === 'csv' ? 'text/csv;charset=utf-8'
      : format === 'geojson' ? 'application/geo+json' : 'application/json',
    text: format === 'csv' || format === 'md' ? String(value) : `${JSON.stringify(value, null, 2)}\n`,
  }
}

function csv(rows: unknown[][]) {
  return rows.map(row => row.map(value => {
    const text = value == null ? '' : String(value)
    return `"${text.replaceAll('"', '""')}"`
  }).join(',')).join('\r\n') + '\r\n'
}

export function journeyGeometryAvailable(plan: RoutingPlan) {
  const line = (leg: RoutingPlan['legs'][number]) => leg.coordinates?.length >= 2
    && leg.coordinates.every(point => point.length === 2 && point.every(Number.isFinite))
  return plan.legs.some(line) && plan.legs.every(leg => line(leg) || leg.distanceKm === 0)
}

export function journeyResultSummary(plan: RoutingPlan) {
  return {
    journeyId: plan.id, status: plan.status, choice: plan.choiceLabel ?? plan.title,
    travelMode: plan.travelMode, timePreference: plan.timePreference,
    serviceDate: plan.diagnostics.serviceDate ?? null,
    timeZone: plan.diagnostics.routingDataProvenance?.timeZone ?? null,
    origin: plan.origin.label, destination: plan.destination.label,
    via: plan.waypoints?.map(point => point.label) ?? [],
    requestedTimeMinutes: plan.diagnostics.routingDataProvenance?.requestedTimeMinutes
      ?? plan.diagnostics.departurePresentation?.requestedDepartMinutes
      ?? plan.diagnostics.departureWindow?.centerMinutes ?? null,
    departMinutes: plan.departMinutes, arriveMinutes: plan.arriveMinutes ?? plan.departMinutes + plan.durationMinutes,
    totalElapsedMinutes: routingPlanTotalElapsedMinutes(plan), journeyMinutes: routingPlanJourneyMinutes(plan),
    initialWaitMinutes: routingPlanStartWaitMinutes(plan), walkMinutes: plan.walkMinutes,
    rideMinutes: plan.rideMinutes, waitMinutes: plan.waitMinutes, transfers: plan.transfers,
  }
}

function markdownItinerary(plan: RoutingPlan) {
  const text = (value: string) => value.replace(/[\r\n]+/g, ' ').replace(/[\\`*_{}\[\]<>#|]/g, '\\$&')
  const clock = (minutes: number) => {
    const seconds = Math.round(minutes * 60)
    return `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
  }
  const summary = journeyResultSummary(plan)
  return [
    '# VIGO journey', '', `${text(summary.origin)} → ${text(summary.destination)}`,
    ...(summary.via.length ? [`Via: ${summary.via.map(text).join(' → ')}`] : []), '',
    `Service date: ${summary.serviceDate ?? 'unavailable'} · time zone: ${summary.timeZone ?? 'unavailable'}`,
    'Clocks are hours after service-day midnight; hours above 23 belong to the following calendar day.', '',
    `Leave ${clock(summary.departMinutes)} · arrive ${clock(summary.arriveMinutes)}`,
    ...(summary.requestedTimeMinutes === null ? [] : [`Requested ${summary.timePreference === 'arrive' ? 'arrival' : 'departure'}: ${clock(summary.requestedTimeMinutes)}`]),
    summary.timePreference === 'arrive' ? `Journey duration: ${summary.journeyMinutes} min`
      : `Total from requested departure: ${summary.totalElapsedMinutes} min · journey: ${summary.journeyMinutes} min · initial wait: ${summary.initialWaitMinutes} min`,
    `${summary.walkMinutes} min walking · ${summary.rideMinutes} min riding/driving · ${summary.waitMinutes} min waiting en route · ${summary.transfers} transfers`, '',
    ...plan.legs.flatMap((leg, index) => [
      `${index + 1}. ${clock(leg.startMinutes)}–${clock(leg.endMinutes)} · ${leg.type === 'ride' ? `Ride ${text(leg.routeShortName ?? leg.routeId ?? '')}` : leg.type === 'drive' ? 'Drive' : 'Walk'} · ${text(leg.fromName)} → ${text(leg.toName)}`,
      `   ${leg.durationMinutes} min · ${leg.distanceKm} km${leg.tripId ? ` · trip ${text(leg.tripId)}` : ''}`, '',
    ]),
    ...(plan.diagnostics.dataSemantics?.limitations?.length ? ['Declared limits:',
      ...plan.diagnostics.dataSemantics.limitations.map(limit => `- ${text(limit.detail ?? limit.code)}`), ''] : []),
    `Journey ID: ${text(plan.id)}`, '',
  ].join('\n')
}

export function exportJourney(plan: RoutingPlan, format: ResultExportFormat): ResultFile {
  if (plan.status !== 'ready') throw new Error('Only completed journeys can be saved.')
  const exportedAt = new Date().toISOString()
  const identity = [plan.diagnostics.serviceDate ?? '', plan.origin.label, plan.destination.label, plan.id]
  const save = (value: unknown) => file('journey', format, value, identity, exportedAt)
  if (format === 'md') return save(markdownItinerary(plan))
  if (format === 'json') return save({
    schemaVersion: 'vigo.studio.journey-export.v1', exportedAt,
    clock: 'minutes after service-day midnight; values can exceed 1440', summary: journeyResultSummary(plan), plan,
  })
  if (format === 'csv') return save(csv([
    ['journey_id', 'clock_service_date', 'leg', 'mode', 'from', 'to', 'route_id', 'trip_id', 'start_minutes', 'end_minutes', 'duration_minutes', 'distance_km', 'geometry_source', 'time_zone', 'transfer_source', 'street_path_verified'],
    ...plan.legs.map((leg, index) => [plan.id, plan.diagnostics.serviceDate, index + 1,
      leg.type, leg.fromName, leg.toName, leg.routeId, leg.tripId,
      leg.startMinutes, leg.endMinutes, leg.durationMinutes, leg.distanceKm, leg.geometrySource,
      plan.diagnostics.routingDataProvenance?.timeZone, leg.transferSource, leg.streetPathVerified]),
  ]))
  if (!journeyGeometryAvailable(plan)) throw new Error('Complete path geometry is unavailable. Save JSON or an itinerary instead.')
  const collection: FeatureCollection<Geometry> = {
    type: 'FeatureCollection', features: plan.legs.flatMap((leg, index) => {
      if (leg.coordinates?.length < 2 || !leg.coordinates?.every(point => point.length === 2 && point.every(Number.isFinite))) return []
      return [{ type: 'Feature' as const, geometry: { type: 'LineString' as const, coordinates: leg.coordinates },
        properties: { journeyId: plan.id, clockServiceDate: plan.diagnostics.serviceDate,
          leg: index + 1, mode: leg.type, from: leg.fromName, to: leg.toName,
          fromStopId: leg.fromStopId, toStopId: leg.toStopId, transferSource: leg.transferSource,
          streetPathVerified: leg.streetPathVerified,
          routeId: leg.routeId, tripId: leg.tripId, startMinutes: leg.startMinutes,
          endMinutes: leg.endMinutes, durationMinutes: leg.durationMinutes, distanceKm: leg.distanceKm,
          timeZone: plan.diagnostics.routingDataProvenance?.timeZone, geometrySource: leg.geometrySource } }]
    }),
  }
  return save(collection)
}

/** Retain every completed alternative, including options outside the visible five. */
export function exportJourneys(plans: RoutingPlan[], format: ResultExportFormat, selectedJourneyId?: string): ResultFile {
  if (format !== 'json' && format !== 'csv') throw new Error('Save journey options as JSON or CSV.')
  const completed = plans.filter(plan => plan.status === 'ready')
  if (!completed.length) throw new Error('No completed journeys to save.')
  const exportedAt = new Date().toISOString()
  const summaries = completed.map(journeyResultSummary)
  const value = format === 'json' ? {
    schemaVersion: 'vigo.studio.journey-comparison-export.v1', exportedAt,
    clock: 'minutes after service-day midnight; values can exceed 1440',
    selectedJourneyId: completed.some(plan => plan.id === selectedJourneyId) ? selectedJourneyId : null,
    summaries, plans: completed,
  } : csv([
    ['journey_id', 'selected', 'choice', 'mode', 'time_preference', 'service_date', 'time_zone', 'origin', 'via', 'destination',
      'requested_time_minutes', 'depart_minutes', 'arrive_minutes', 'total_elapsed_minutes', 'journey_minutes',
      'initial_wait_minutes', 'walk_minutes', 'ride_minutes', 'wait_minutes', 'transfers'],
    ...summaries.map(row => [row.journeyId, row.journeyId === selectedJourneyId, row.choice, row.travelMode, row.timePreference,
      row.serviceDate, row.timeZone, row.origin, JSON.stringify(row.via), row.destination, row.requestedTimeMinutes,
      row.departMinutes, row.arriveMinutes, row.totalElapsedMinutes, row.journeyMinutes, row.initialWaitMinutes,
      row.walkMinutes, row.rideMinutes, row.waitMinutes, row.transfers]),
  ])
  return file('journey-options', format, value, [summaries[0].serviceDate ?? '', summaries[0].origin, summaries[0].destination], exportedAt)
}

type ReachExportEntry = { name: string; feedId?: string; result: ReachResult }
const reachSurfaces = (entries: ReachExportEntry[]) => entries.length > 1 && entries.every(entry => entry.feedId)
  ? ['baseline'] as const : ['baseline', 'scenario'] as const
export function reachGeometryAvailable(entries: ReachExportEntry[], cutoffMinutes: number) {
  return entries.length > 0 && entries.every(({ result }) => reachSurfaces(entries).every(surface => {
    const collection = result.surface.areas?.[surface] ?? result.surface.contours?.[surface]
    return Boolean(collection && (collection.features.some(feature => Number(feature.properties?.cutoffMinutes) === cutoffMinutes)
      || (!collection.features.length && result.request.cutoffsMinutes?.includes(cutoffMinutes)
        && scenarioReachablePixels(result, surface, cutoffMinutes) === 0)))
  }))
}
export function exportReachResults(entries: ReachExportEntry[], format: ResultExportFormat, cutoffMinutes: number): ResultFile {
  if (format === 'md') throw new Error('Save Reach as JSON, GeoJSON or CSV.')
  if (!entries.length || entries.some(({ result }) => result.diagnostics.preliminary)) throw new Error('Wait for complete Reach results before saving.')
  if (!Number.isFinite(cutoffMinutes) || cutoffMinutes <= 0 || entries.some(({ result }) => cutoffMinutes > result.summary.maximumCutoffMinutes)) {
    throw new Error('Update Reach to compute the selected time budget before saving.')
  }
  const exportedAt = new Date().toISOString()
  const cityComparison = reachSurfaces(entries).length === 1
  const reference = entries[0]
  const selectedSummary = () => entries.flatMap(({ name, feedId, result }) => reachSurfaces(entries).map(surface => ({
    name, feedId, surface, ...reachResultMetrics(result, surface, cutoffMinutes),
    differenceFromReference: cityComparison ? reachResultDifference(reference.result, result, cutoffMinutes) : null,
    differenceFromBaseline: surface === 'scenario' ? reachScenarioDifference(result, cutoffMinutes) : null,
    fasterOrNewlyReachedCells: surface === 'scenario' ? scenarioImprovedPixels(result, cutoffMinutes) : null,
    slowerOrLostCells: surface === 'scenario' ? scenarioWorsenedPixels(result, cutoffMinutes) : null,
  })))
  const save = (value: unknown) => file(cityComparison ? 'city-comparison' : 'reach', format, value,
    [reference.result.request.serviceDate, reference.name, `${cutoffMinutes}min`], exportedAt)
  if (format === 'json') return save({
    schemaVersion: 'vigo.studio.reach-export.v1', exportedAt,
    selectedCutoffMinutes: cutoffMinutes, referenceFeedId: cityComparison ? reference.feedId : null, selectedSummary: selectedSummary(), entries,
  })
  if (format === 'csv') return save(csv([
    ['name', 'feed_id', 'service_date', 'depart_minutes', 'origin_lon', 'origin_lat', 'sampling', 'cutoff_minutes', 'surface', 'reachable_cells', 'area_km2', 'transit_stops', 'faster_or_newly_reached_cells', 'slower_or_lost_cells', 'total_processing_ms', 'area_source', 'reference_feed_id', 'area_delta_km2', 'transit_stop_delta', 'mode', 'max_walk_km', 'walk_speed_kph', 'max_transfers', 'baseline_identity', 'scenario_id', 'reference_surface'],
    ...entries.flatMap(({ name, feedId, result }) => reachSurfaces(entries).map(side => {
      const metrics = reachResultMetrics(result, side, cutoffMinutes)
      const difference = cityComparison ? reachResultDifference(reference.result, result, cutoffMinutes)
        : side === 'scenario' ? reachScenarioDifference(result, cutoffMinutes) : null
      return [name, feedId, result.request.serviceDate, result.request.departMinutes,
        ...result.request.origin.coordinate, result.request.surfaceSampling ?? 'street', cutoffMinutes, side,
        metrics.reachableCells, metrics.areaKm2, metrics.transitStops,
        side === 'scenario' ? scenarioImprovedPixels(result, cutoffMinutes) : '',
        side === 'scenario' ? scenarioWorsenedPixels(result, cutoffMinutes) : '', metrics.totalProcessingMs,
        metrics.areaSource, cityComparison ? reference.feedId : '', difference?.areaKm2, difference?.transitStops,
        result.request.mode ?? 'transit', result.request.maxWalkKm, result.request.walkSpeedKph ?? 4.8,
        result.request.maxTransfers, result.request.baselineIdentity, side === 'scenario' ? result.request.scenario.id : '', 'baseline']
    })),
  ]))
  if (!reachGeometryAvailable(entries, cutoffMinutes)) throw new Error('Update Reach to retain geometry for this cutoff, or save JSON or CSV.')
  const collection: FeatureCollection<Geometry> = { type: 'FeatureCollection', features: entries.flatMap(({ name, feedId, result }) =>
    reachSurfaces(entries).flatMap(surface => (result.surface.areas?.[surface]?.features ?? result.surface.contours?.[surface]?.features ?? [])
      .filter(feature => Number(feature.properties?.cutoffMinutes) === cutoffMinutes)
      .map(feature => ({ ...feature, properties: { ...feature.properties, name, feedId, surface,
        serviceDate: result.request.serviceDate, departMinutes: result.request.departMinutes } })))) }
  return save(collection)
}

export function reachExportEntries(analysis: ReachResult | null, comparison: ReachComparisonResult[] | null): ReachExportEntry[] {
  return comparison?.length ? comparison.map(entry => ({ name: entry.feedName, feedId: entry.feedId, result: entry.result }))
    : analysis ? [{ name: analysis.request.scenario.name, result: analysis }] : []
}

/**
 * Compare: the ranking as a spreadsheet, the full run with the variant shown
 * on the map, or that variant's areas beside the reference's.
 */
export function exportComparison(run: ComparisonRun, selected: ReachResult | null, format: ResultExportFormat): ResultFile {
  if (format === 'md') throw new Error('Save Compare as CSV, JSON or GeoJSON.')
  const exportedAt = new Date().toISOString()
  const ranked = rankedCompareEntries(run.entries)
  const identity = [run.serviceDate, run.reference.label, `${run.cutoffMinutes}min`]
  if (format === 'csv') return file('compare', format, csv([
    ['variant', 'kind', 'reference', 'cutoff_minutes', 'area_km2', 'area_change_km2', 'stops_reached', 'stops_change',
      'cells_faster', 'cells_slower', 'cells_newly_reached', 'cells_no_longer_reached', 'cells_reached_by_both', 'mean_minutes_saved_on_shared_cells'],
    [run.reference.label, run.reference.kind, run.reference.label, run.cutoffMinutes, run.reference.areaKm2, 0, run.reference.stops, 0, 0, 0, 0, 0, '', 0],
    ...ranked.map(({ variant, stats }) => [variant.label, variant.kind, run.reference.label, run.cutoffMinutes,
      stats?.areaKm2, stats?.areaDeltaKm2, stats?.stops, stats?.stopsDelta, stats?.fasterPixels, stats?.slowerPixels,
      stats?.newPixels, stats?.lostPixels, stats?.commonPixels, stats?.meanSavedMinutes]),
  ]), identity, exportedAt)
  if (format === 'json') return file('compare', format, {
    schemaVersion: 'vigo.studio.compare-export.v1', exportedAt,
    cutoffMinutes: run.cutoffMinutes, serviceDate: run.serviceDate, departMinutes: run.departMinutes,
    reference: { id: run.reference.id, label: run.reference.label, kind: run.reference.kind, feedIds: run.reference.feedIds, areaKm2: run.reference.areaKm2, stops: run.reference.stops },
    variants: ranked.map(({ variant, stats, error }) => ({ id: variant.id, label: variant.label, kind: variant.kind, feedIds: variant.feedIds, stats, ...(error ? { error } : {}) })),
    selectedVariantId: run.selectedId,
    selected: selected ?? null,
  }, identity, exportedAt)
  if (!selected) throw new Error('Choose a variant to save its map geometry.')
  const label = run.entries.find((entry) => entry.variant.id === run.selectedId)?.variant.label ?? 'Variant'
  const collection: FeatureCollection<Geometry> = { type: 'FeatureCollection', features: (['baseline', 'scenario'] as const).flatMap((surface) =>
    (selected.surface.areas?.[surface]?.features ?? [])
      .filter((feature) => Number(feature.properties?.cutoffMinutes) === run.cutoffMinutes)
      .map((feature) => ({ ...feature, properties: { ...feature.properties, name: surface === 'baseline' ? run.reference.label : label,
        surface: surface === 'baseline' ? 'reference' : 'variant', serviceDate: run.serviceDate, departMinutes: run.departMinutes } }))) }
  if (!collection.features.length) throw new Error('Update Compare to retain geometry for this cutoff, or save JSON or CSV.')
  return file('compare', format, collection, identity, exportedAt)
}
