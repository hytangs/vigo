import type { Feature, FeatureCollection } from 'geojson'
import { apiJson } from '../app/api'
import { bundleFeedId } from '../app/projectState'
import { createScenarioRoadGeometryRequest } from '../app/scenarioRoadGeometryRequest'
import { flexZoneRing, smoothRailPath } from '../app/scenarioGeometry'
import { maximumScenarioChanges, maximumScenarios, newScenario } from '../app/scenarioLibrary'
import { createStore, memoizeLast } from '../app/store'
import type { LngLat, MapPreview, RouteMetric } from '../domain'
import { entityFeedScope } from '../networkTruth'
import { scopedRouteServiceKey } from '../routeServices'
import {
  joinScenarioSegmentGeometry,
  routeHasPublishedShape,
  scenarioInsertionAnchors,
  scenarioPublishedShapeSegmentIndexes,
  scenarioSegmentRuntimeMinutes,
  scenarioStopFromRoutingPoint,
  scenarioStopsForRoute,
  type ScenarioChangeDraft,
  type ScenarioChangeKind,
  type ScenarioDraft,
  type ScenarioGeometryMode,
  type ScenarioStopDraft,
  type ScenarioStopPlacement,
} from '../reach'
import type { RoutingPoint } from '../routingModel'
import { buildRoutingPointFromMap } from '../routingUi'
import { invalidateAnalyzeResult } from './analyze'
import { city, setActiveFeedId } from './city'
import { openScenariosView } from './navigation'
import {
  activeCaseFeeds,
  activeScenario,
  activeScenarioChange,
  cityGrouping,
  findScenarioRoute,
  scenarioLibrary,
  scenarioValues,
} from './scenarios'
import { preview, routingScope, selectedProject } from './scope'
import { shell } from './shell'

/**
 * Scenarios workspace: which change is being drawn and how a map click edits
 * it. The scenarios themselves live in the City's saved library.
 */
export type ScenarioEditorState = {
  placement: ScenarioStopPlacement | null
  /** Keep placing: each click appends the next stop or zone corner. */
  drawing: boolean
  /** A published line clicked on the map, offered for a new change. */
  pickedRouteId: string
}

export const scenarioEditor = createStore<ScenarioEditorState>({ placement: null, drawing: false, pickedRouteId: '' })

const setters = scenarioLibrary
let roadTrace: AbortController | null = null
let roadTraceRequestId = 0
let autoTraceTimer = 0

export function resetScenarioEditor() {
  roadTrace?.abort()
  roadTrace = null
  roadTraceRequestId += 1
  globalThis.clearTimeout(autoTraceTimer)
  scenarioEditor.set({ placement: null, drawing: false, pickedRouteId: '' })
}

/** Line kinds that carry an ordered stop sequence of their own. */
export function changeHasStops(kind: ScenarioChangeKind) {
  return kind === 'add-line' || kind === 'change-line'
}

export function changeRunsService(kind: ScenarioChangeKind) {
  return kind === 'add-line' || kind === 'enhance-line' || kind === 'change-line'
}

function newScenarioChange(kind: ScenarioChangeKind, index: number): ScenarioChangeDraft {
  const id = `intervention-${crypto.randomUUID()}`
  if (kind === 'flex-zone') {
    return {
      id, kind, name: `Flex zone ${index + 1}`, stops: [],
      headwayMinutes: 30, averageSpeedKph: 30, startMinutes: 6 * 60, endMinutes: 22 * 60,
      bidirectional: false, flexWaitMinutes: 15,
    }
  }
  const changesGeometry = changeHasStops(kind)
  return {
    id,
    kind,
    scheduleMode: kind === 'change-line' ? 'preserve-trips' : 'frequency',
    name: kind === 'add-line' ? `New line ${index + 1}` : kind.replaceAll('-', ' '),
    stops: [],
    headwayMinutes: 10,
    averageSpeedKph: 25,
    startMinutes: 5 * 60,
    endMinutes: 25 * 60,
    bidirectional: kind === 'add-line',
    routeScope: kind === 'add-line' ? undefined : 'pattern',
    timeModel: changesGeometry ? 'infer-road' : 'preserve-scheduled',
    geometryMode: changesGeometry ? 'auto-road' : 'published-shape',
    geometryStatus: 'idle',
  }
}

/** The geometry mode a change uses, including drafts saved before modes were explicit. */
export function changeGeometryMode(change: ScenarioChangeDraft): ScenarioGeometryMode {
  return change.geometryMode
    ?? (change.timeModel === 'infer-road' ? 'auto-road' : change.timeModel === 'estimate-distance' ? 'straight-line' : 'published-shape')
}

const scenarioRoutesOf = memoizeLast((routes: RouteMetric[], feedIds: string[]) => routes.filter((entry) => feedIds.includes(entityFeedScope(entry.id))))
/** Routes a change can edit: those of the timetables the scenario runs on. */
export const scenarioRoutes = () => scenarioRoutesOf(preview().routes, activeCaseFeeds().feedIds)

const emptyStops: ScenarioStopDraft[] = []
const emptyCoordinates: LngLat[] = []

/** The stops or zone corners of the change being edited. */
export const scenarioSketchStops = () => {
  const change = activeScenarioChange()
  return change && (changeHasStops(change.kind) || change.kind === 'flex-zone') ? change.stops : emptyStops
}

/** The drawn path of a change: traced roads, a rail curve, a published shape, or chords. */
export function changeGeometry(change: ScenarioChangeDraft, scenarioRoute: RouteMetric | undefined, stops: ScenarioStopDraft[]): LngLat[] {
  if (change.kind === 'flex-zone') return flexZoneRing(stops.map((stop) => stop.coordinate))
  if (stops.length < 2) return emptyCoordinates
  const mode = changeGeometryMode(change)
  if (mode === 'smooth-rail') return smoothRailPath(stops.map((stop) => stop.coordinate)).geometry
  if (mode === 'auto-road' && change.geometryStatus === 'ready') return change.inferredGeometry ?? stops.map((stop) => stop.coordinate)
  const published = routeHasPublishedShape(scenarioRoute) ? scenarioRoute.coordinates : undefined
  if (mode === 'published-shape' && published && published.length >= 2) return published
  // A new line stays point-only until its road path is traced, rather than
  // drawing an invented chord; an existing route keeps its shape as context.
  if (mode === 'auto-road') return published ?? emptyCoordinates
  return stops.map((stop) => stop.coordinate)
}

const sketchGeometryOf = memoizeLast((change: ScenarioChangeDraft | undefined, scenarioRoute: RouteMetric | undefined, stops: ScenarioStopDraft[]) => (
  change ? changeGeometry(change, scenarioRoute, stops) : emptyCoordinates
))
export function scenarioSketchGeometry() {
  const change = activeScenarioChange()
  return sketchGeometryOf(change, findScenarioRoute(preview().routes, change?.routeId), scenarioSketchStops())
}

const emptyCollection: FeatureCollection = { type: 'FeatureCollection', features: [] }

/**
 * Everything else in the scenario, drawn quietly under the change being
 * edited: other new and changed lines, removed routes and Flex zones.
 */
const scenarioContextOf = memoizeLast((scenario: ScenarioDraft | undefined, activeId: string, previewValue: MapPreview): FeatureCollection => {
  if (!scenario?.interventions.length) return emptyCollection
  const features: Feature[] = []
  for (const change of scenario.interventions) {
    const active = change.id === activeId
    const route = findScenarioRoute(previewValue.routes, change.routeId)
    if (change.kind === 'flex-zone') {
      const ring = flexZoneRing(change.stops.map((stop) => stop.coordinate))
      if (ring.length >= 4) features.push({ type: 'Feature', properties: { kind: 'flex-zone', active, name: change.name }, geometry: { type: 'Polygon', coordinates: [ring] } })
      continue
    }
    if (active) continue
    if (change.kind === 'remove-line') {
      if (route?.coordinates && route.coordinates.length >= 2) {
        features.push({ type: 'Feature', properties: { kind: 'removed', name: change.name }, geometry: { type: 'LineString', coordinates: route.coordinates } })
      }
      continue
    }
    const stops = changeHasStops(change.kind) ? change.stops : scenarioStopsForRoute(route, previewValue)
    const line = changeGeometry(change, route, stops)
    if (line.length >= 2) features.push({ type: 'Feature', properties: { kind: change.kind === 'add-line' ? 'added' : 'changed', name: change.name }, geometry: { type: 'LineString', coordinates: line } })
    for (const stop of changeHasStops(change.kind) ? stops : []) {
      features.push({ type: 'Feature', properties: { kind: 'context-stop' }, geometry: { type: 'Point', coordinates: stop.coordinate } })
    }
  }
  return { type: 'FeatureCollection', features }
})
export const scenarioContextFeatures = () => scenarioContextOf(activeScenario(), activeScenarioChange()?.id ?? '', preview())

export function activeScenarioStopPlacement() {
  const placement = scenarioEditor.get().placement
  return placement?.interventionId === activeScenarioChange()?.id ? placement : null
}

/** Whether a map click in Scenarios places a stop or zone corner. */
export function scenarioEditPicking() {
  return shell.get().activeRouteTool === 'scenarios' && Boolean(activeScenarioStopPlacement())
}

// Selecting and managing scenarios.

export function selectScenario(caseId: string) {
  invalidateAnalyzeResult()
  scenarioEditor.set({ placement: null, drawing: false })
  const { setActiveScenarioId, setActiveScenarioChangeId } = setters()
  setActiveScenarioId(caseId)
  const selected = scenarioValues().cases.find((entry) => entry.id === caseId)
  setActiveScenarioChangeId(selected?.interventions[0]?.id ?? '')
}

export function addScenario(groupId?: string) {
  const { cases, activeCaseId } = scenarioValues()
  const grouping = cityGrouping()
  const targetGroupId = groupId ?? grouping.value.cases[activeCaseId] ?? grouping.value.groups[0]?.id ?? ''
  if (cases.length >= maximumScenarios) return
  invalidateAnalyzeResult()
  const next = newScenario(cases.length, targetGroupId)
  scenarioEditor.set({ placement: null, drawing: false })
  const { setScenarioDrafts, setActiveScenarioId, setActiveScenarioChangeId } = setters()
  setScenarioDrafts((current) => [...current, next])
  setActiveScenarioId(next.id)
  setActiveScenarioChangeId('')
}

/** Copy a scenario and its changes; the copy runs on the same timetables. */
export function duplicateScenario(caseId: string) {
  const { cases } = scenarioValues()
  const source = cases.find((entry) => entry.id === caseId)
  if (!source || cases.length >= maximumScenarios) return
  invalidateAnalyzeResult()
  const copy: ScenarioDraft = {
    ...newScenario(cases.length, source.groupId ?? ''),
    name: `${source.name} copy`.slice(0, 80),
    interventions: source.interventions.map((change) => ({
      ...change,
      id: `intervention-${crypto.randomUUID()}`,
      geometryStatus: change.geometryStatus === 'loading' ? 'idle' : change.geometryStatus,
    })),
  }
  scenarioEditor.set({ placement: null, drawing: false })
  const { setScenarioDrafts, setActiveScenarioId, setActiveScenarioChangeId } = setters()
  setScenarioDrafts((current) => [...current, copy])
  setActiveScenarioId(copy.id)
  setActiveScenarioChangeId(copy.interventions[0]?.id ?? '')
}

export function removeScenario(caseId: string) {
  const { cases } = scenarioValues()
  if (cases.length <= 1) return
  invalidateAnalyzeResult()
  const next = cases.filter((entry) => entry.id !== caseId)
  scenarioEditor.set({ placement: null, drawing: false })
  const { setScenarioDrafts, setActiveScenarioId, setActiveScenarioChangeId } = setters()
  setScenarioDrafts((current) => current.filter((entry) => entry.id !== caseId))
  setActiveScenarioId(next[0].id)
  setActiveScenarioChangeId(next[0].interventions[0]?.id ?? '')
}

export function renameScenario(caseId: string, name: string) {
  setters().setScenarioDrafts((current) => current.map((entry) => entry.id === caseId ? { ...entry, name: name.slice(0, 80) } : entry))
}

export function assignScenarioGroup(id: string, groupId: string) {
  invalidateAnalyzeResult()
  cityGrouping().assignCase(id, groupId)
}

/** Open a scenario from City data in the Scenarios workspace. */
export function openScenarioCase(caseId: string) {
  selectScenario(caseId)
  setActiveFeedId(bundleFeedId)
  openScenariosView()
}

// Changes within the open scenario.

export function addScenarioChange(kind: ScenarioChangeKind, routeId = '') {
  const scenario = activeScenario()
  if (!scenario || scenario.interventions.length >= maximumScenarioChanges) return
  invalidateAnalyzeResult()
  const intervention = newScenarioChange(kind, scenario.interventions.filter((entry) => entry.kind === kind).length)
  const { setScenarioDrafts, setActiveScenarioChangeId } = setters()
  setScenarioDrafts((current) => current.map((entry) => (
    entry.id === scenario.id
      ? { ...entry, interventions: [...entry.interventions, intervention] }
      : entry
  )))
  setActiveScenarioChangeId(intervention.id)
  // A new line or zone starts by drawing it.
  scenarioEditor.set(kind === 'add-line' || kind === 'flex-zone'
    ? { placement: { interventionId: intervention.id, mode: 'append', index: 0 }, drawing: true, pickedRouteId: '' }
    : { placement: null, drawing: false, pickedRouteId: '' })
  if (routeId) updateScenarioChangeRoute(intervention.id, routeId)
}

/**
 * A line clicked on the Scenarios map. A change that edits a published
 * route takes it at once; otherwise the line is offered for a new change.
 * Tile features name a route as `feed::route`; the busiest pattern of that
 * route in the scenario's timetables stands for it.
 */
export function pickScenarioRouteFromMap(featureId: string) {
  const split = featureId.indexOf('::')
  const key = split > 0 ? `${featureId.slice(0, split)}:${featureId.slice(split + 2)}` : `:${featureId}`
  const route = scenarioRoutes()
    .filter((candidate) => scopedRouteServiceKey(candidate) === key)
    .sort((left, right) => (left.patternRank ?? Number.MAX_SAFE_INTEGER) - (right.patternRank ?? Number.MAX_SAFE_INTEGER) || right.tripCount - left.tripCount)[0]
  if (!route) return
  const change = activeScenarioChange()
  if (change && ['change-line', 'enhance-line', 'remove-line'].includes(change.kind) && !change.routeId) {
    updateScenarioChangeRoute(change.id, route.id)
    return
  }
  scenarioEditor.set({ pickedRouteId: route.id })
}

export const dismissPickedRoute = () => scenarioEditor.set({ pickedRouteId: '' })

/** The line clicked on the map, while it is offered for a change. */
export const pickedScenarioRoute = () => {
  const id = scenarioEditor.get().pickedRouteId
  return id ? findScenarioRoute(preview().routes, id) : undefined
}

export function selectScenarioChange(interventionId: string) {
  scenarioEditor.set({ placement: null, drawing: false, pickedRouteId: '' })
  setters().setActiveScenarioChangeId(interventionId)
}

const clearedTrace = {
  inferredGeometry: undefined,
  inferredGeometrySource: undefined,
  inferredFallbackSegmentCount: undefined,
  inferredPublishedShapeSegmentCount: undefined,
  inferredOsmSegmentCount: undefined,
  inferredSegmentGeometry: undefined,
  inferredSegmentDistanceKm: undefined,
  inferredSegmentRuntimeMinutes: undefined,
  geometryStatus: 'idle' as const,
  geometryError: undefined,
}

export function updateScenarioChange(interventionId: string, patch: Partial<ScenarioChangeDraft>) {
  invalidateAnalyzeResult()
  const currentPreview = preview()
  setters().setScenarioDrafts((current) => current.map((entry) => ({
    ...entry,
    interventions: entry.interventions.map((intervention) => {
      if (intervention.id !== interventionId) return intervention
      const geometryInvalidated = (
        patch.stops !== undefined
        || patch.routeId !== undefined
        || patch.geometryMode !== undefined
        || patch.kind !== undefined
      ) && patch.inferredGeometry === undefined
      const nextIntervention = { ...intervention, ...patch, ...(geometryInvalidated ? clearedTrace : {}) }
      if (patch.kind && patch.kind !== intervention.kind) {
        const scenarioRoute = findScenarioRoute(currentPreview.routes, intervention.routeId)
        return {
          ...nextIntervention,
          scheduleMode: patch.kind === 'change-line' ? 'preserve-trips' : 'frequency',
          routeScope: patch.kind === 'add-line' ? undefined : 'pattern' as const,
          bidirectional: patch.kind === 'add-line',
          ...(changeHasStops(patch.kind)
            ? { geometryMode: 'auto-road' as const, timeModel: 'infer-road' as const }
            : {}),
          stops: ['change-line', 'enhance-line', 'remove-line'].includes(patch.kind)
            ? scenarioStopsForRoute(scenarioRoute, currentPreview)
            : [],
        }
      }
      return nextIntervention
    }),
  })))
  if (patch.stops !== undefined || patch.geometryMode !== undefined) scheduleAutoTrace(interventionId)
}

/**
 * A new line set to follow roads is traced again shortly after its stops
 * settle, so the map always shows the snapped path. Edits to published lines
 * keep the explicit Trace action: their path mixes GTFS shape and roads.
 */
function scheduleAutoTrace(interventionId: string) {
  globalThis.clearTimeout(autoTraceTimer)
  autoTraceTimer = window.setTimeout(() => {
    if (scenarioEditor.get().drawing) return
    const change = activeScenario()?.interventions.find((entry) => entry.id === interventionId)
    if (change?.kind === 'add-line' && changeGeometryMode(change) === 'auto-road'
      && change.stops.length >= 2 && change.geometryStatus === 'idle'
      && selectedProject().osmStreetIndex?.status === 'ready') void inferScenarioRoadGeometry(interventionId)
  }, 350)
}

export function updateScenarioChangeRoute(interventionId: string, routeId: string) {
  const currentPreview = preview()
  scenarioEditor.set({ placement: null, drawing: false })
  updateScenarioChange(interventionId, {
    routeId,
    stops: scenarioStopsForRoute(findScenarioRoute(currentPreview.routes, routeId), currentPreview),
  })
}

export async function inferScenarioRoadGeometry(interventionId: string) {
  const intervention = activeScenario()?.interventions.find((entry) => entry.id === interventionId)
  if (!intervention || !changeRunsService(intervention.kind)) return
  const currentPreview = preview()
  const project = selectedProject()
  const { activeFeedId } = city.get()
  const { nationalRoutingFeed } = routingScope()
  const scenarioRoute = findScenarioRoute(currentPreview.routes, intervention.routeId)
  const stops = intervention.stops.length >= 2
    ? intervention.stops
    : scenarioRoute
      ? scenarioStopsForRoute(scenarioRoute, currentPreview)
      : []
  const fail = (geometryError: string) => updateScenarioChange(interventionId, { geometryStatus: 'error', geometryError })
  if (stops.length < 2) return fail('Place at least two ordered stops before tracing a road-following path.')
  if (project.osmStreetIndex?.status !== 'ready') return fail('Build the local OSM street index before tracing a road-following path.')
  const feedId = activeFeedId === bundleFeedId
    ? scenarioRoute ? entityFeedScope(scenarioRoute.id) || nationalRoutingFeed?.id : nationalRoutingFeed?.id
    : activeFeedId
  if (!feedId) return fail('Choose a ready GTFS feed before tracing a route.')
  invalidateAnalyzeResult()
  roadTrace?.abort()
  // Bind to this City's drafts: a late answer must not edit another City.
  const { setScenarioDrafts } = setters()
  const controller = createScenarioRoadGeometryRequest(interventionId, setScenarioDrafts)
  roadTrace = controller
  const requestId = roadTraceRequestId + 1
  roadTraceRequestId = requestId
  const fallbackGeometry = routeHasPublishedShape(scenarioRoute) ? scenarioRoute.coordinates : undefined
  const fallbackSegmentRuntimeMinutes = scenarioRoute
    ? scenarioSegmentRuntimeMinutes(scenarioRoute, stops, currentPreview)
    : undefined
  const publishedShapeSegmentIndexes = scenarioPublishedShapeSegmentIndexes(scenarioRoute, stops)
  const edit = (change: (candidate: ScenarioChangeDraft) => ScenarioChangeDraft) => setScenarioDrafts((current) => current.map((entry) => ({
    ...entry,
    interventions: entry.interventions.map((candidate) => candidate.id === interventionId ? change(candidate) : candidate),
  })))
  edit((candidate) => ({ ...candidate, geometryStatus: 'loading', geometryError: '' }))
  try {
    const result = await apiJson<{
      geometry: {
        status: 'ready' | 'blocked'
        segments?: Array<{
          coordinates?: [number, number][]
          distanceKm?: number
          durationMinutes?: number
          source?: 'osm_drive' | 'published_shape' | 'published_shape_fallback'
        }>
        snappedCoordinates?: [number, number][]
        detail?: string
        fallbackSegmentCount?: number
        publishedShapeSegmentCount?: number
        osmSegmentCount?: number
      }
    }>(
      `/api/projects/${encodeURIComponent(project.id)}/scenario-road-geometry`,
      {
        method: 'POST',
        signal: controller.signal,
        body: JSON.stringify({
          feedId,
          maxStreetKm: 100,
          points: stops.map((stop) => ({ coordinate: stop.coordinate, label: stop.label })),
          ...(fallbackGeometry ? { fallbackGeometry } : {}),
          ...(fallbackSegmentRuntimeMinutes ? { fallbackSegmentRuntimeMinutes } : {}),
          ...(publishedShapeSegmentIndexes.length ? { publishedShapeSegmentIndexes } : {}),
        }),
      },
    )
    if (controller.signal.aborted || roadTraceRequestId !== requestId) return
    const geometry = result.geometry
    const segments = Array.isArray(geometry?.segments) ? geometry.segments : []
    if (geometry?.status !== 'ready' || segments.length !== stops.length - 1) {
      throw new Error(geometry?.detail ?? 'The OSM street network could not connect every ordered stop.')
    }
    const hasOsmSegments = segments.some((segment) => segment.source === 'osm_drive')
    const hasShapeSegments = segments.some((segment) => segment.source === 'published_shape' || segment.source === 'published_shape_fallback')
    const snappedCoordinates = Array.isArray(geometry.snappedCoordinates) ? geometry.snappedCoordinates : []
    edit((candidate) => ({
      ...candidate,
      stops: candidate.stops.length >= 2
        ? candidate.stops.map((stop, index) => snappedCoordinates[index]?.length === 2 ? { ...stop, coordinate: snappedCoordinates[index] } : stop)
        : candidate.stops,
      inferredGeometry: joinScenarioSegmentGeometry(segments.map((segment) => segment.coordinates ?? [])),
      inferredSegmentGeometry: segments.map((segment) => segment.coordinates ?? []),
      inferredGeometrySource: hasOsmSegments && hasShapeSegments ? 'hybrid' : hasShapeSegments ? 'published_shape_fallback' : 'osm_drive',
      inferredFallbackSegmentCount: Number(geometry.fallbackSegmentCount ?? segments.filter((segment) => segment.source === 'published_shape_fallback').length),
      inferredPublishedShapeSegmentCount: Number(geometry.publishedShapeSegmentCount ?? segments.filter((segment) => segment.source === 'published_shape').length),
      inferredOsmSegmentCount: Number(geometry.osmSegmentCount ?? segments.filter((segment) => segment.source === 'osm_drive').length),
      inferredSegmentDistanceKm: segments.map((segment) => Number(segment.distanceKm ?? 0)),
      inferredSegmentRuntimeMinutes: segments.map((segment) => Number(segment.durationMinutes ?? 0)),
      geometryStatus: 'ready',
      geometryError: '',
    }))
  } catch (error) {
    if (controller.signal.aborted || roadTraceRequestId !== requestId) return
    const message = error instanceof Error ? error.message : 'OSM road inference failed.'
    edit((candidate) => ({ ...candidate, geometryStatus: 'error', geometryError: message }))
  } finally {
    if (roadTrace === controller) roadTrace = null
  }
}

// Placing stops and zone corners on the map.

export function beginScenarioStopPlacement(interventionId: string, mode: ScenarioStopPlacement['mode'], index: number) {
  scenarioEditor.set({ placement: { interventionId, mode, index }, drawing: false })
}

/** Click after click appends stops (or corners) until finished. */
export function startScenarioDrawing(interventionId: string) {
  const change = activeScenario()?.interventions.find((entry) => entry.id === interventionId)
  if (!change) return
  scenarioEditor.set({ placement: { interventionId, mode: 'append', index: change.stops.length }, drawing: true })
}

export function finishScenarioDrawing() {
  const placement = scenarioEditor.get().placement
  scenarioEditor.set({ placement: null, drawing: false })
  if (placement) scheduleAutoTrace(placement.interventionId)
}

export const cancelScenarioStopPlacement = finishScenarioDrawing

/** The last placed stop, undone while drawing. */
export function undoScenarioStop() {
  const change = activeScenarioChange()
  if (!change?.stops.length) return
  updateScenarioChange(change.id, { stops: change.stops.slice(0, -1) })
  if (scenarioEditor.get().drawing) scenarioEditor.set({ placement: { interventionId: change.id, mode: 'append', index: change.stops.length - 1 } })
}

export function scenarioPointFromMap(point: RoutingPoint) {
  const change = activeScenarioChange()
  const placement = activeScenarioStopPlacement()
  if (!change || !placement || shell.get().activeRouteTool !== 'scenarios') return
  if (change.stops.length >= 256 && placement.mode !== 'replace') return
  const zone = change.kind === 'flex-zone'
  // Zone corners are places, not stops; lines snap to the GTFS stop clicked.
  const mapPoint = zone || (point.source === 'map' && !point.named)
    ? buildRoutingPointFromMap(point.coordinate, zone ? `Corner ${placement.index + 1}` : `${point.coordinate[1].toFixed(4)}, ${point.coordinate[0].toFixed(4)}`)
    : point
  const nextStops = [...change.stops]
  if (placement.mode === 'replace') {
    const existing = nextStops[placement.index]
    if (!existing) return
    const addedHere = ['inserted', 'added'].includes(existing.editStatus ?? '')
    nextStops[placement.index] = {
      ...scenarioStopFromRoutingPoint(change.id, mapPoint, 'replaced'),
      id: existing.id,
      baselineStopId: addedHere ? undefined : existing.baselineStopId ?? existing.stopId,
      baselineStopIndex: existing.baselineStopIndex,
      anchorBeforeStopId: existing.anchorBeforeStopId,
      anchorAfterStopId: existing.anchorAfterStopId,
      anchorBeforeStopIndex: existing.anchorBeforeStopIndex,
      anchorAfterStopIndex: existing.anchorAfterStopIndex,
      editStatus: addedHere ? existing.editStatus : 'replaced',
    }
  } else if (placement.mode === 'insert') {
    if (placement.index < 1 || placement.index >= nextStops.length) return
    const { beforeStopId, afterStopId, beforeStopIndex, afterStopIndex } = scenarioInsertionAnchors(nextStops[placement.index - 1], nextStops[placement.index])
    nextStops.splice(placement.index, 0, {
      ...scenarioStopFromRoutingPoint(change.id, mapPoint, 'inserted'),
      anchorBeforeStopId: beforeStopId,
      anchorAfterStopId: afterStopId,
      anchorBeforeStopIndex: beforeStopIndex,
      anchorAfterStopIndex: afterStopIndex,
    })
  } else {
    // A click on the line's first stop closes a zone; on its last, ends drawing.
    const last = nextStops.at(-1), first = nextStops[0]
    const same = (stop: ScenarioStopDraft | undefined) => stop && Math.abs(stop.coordinate[0] - mapPoint.coordinate[0]) < 1e-7 && Math.abs(stop.coordinate[1] - mapPoint.coordinate[1]) < 1e-7
    if (same(last) || (zone && nextStops.length >= 3 && same(first))) return finishScenarioDrawing()
    nextStops.push(scenarioStopFromRoutingPoint(change.id, mapPoint, 'added'))
  }
  updateScenarioChange(change.id, { stops: nextStops })
  const { drawing } = scenarioEditor.get()
  scenarioEditor.set(drawing && placement.mode === 'append'
    ? { placement: { ...placement, index: nextStops.length } }
    : { placement: null, drawing: false })
}

export function moveScenarioStopFromMap(index: number, coordinate: [number, number]) {
  const intervention = activeScenarioChange()
  const stop = intervention?.stops[index]
  if (!intervention || !stop) return
  const zone = intervention.kind === 'flex-zone'
  updateScenarioChange(intervention.id, {
    stops: intervention.stops.map((candidateStop, candidateIndex) => {
      if (candidateIndex !== index) return candidateStop
      const addedHere = zone || candidateStop.editStatus === 'inserted' || candidateStop.editStatus === 'added'
      return {
        ...candidateStop,
        stopId: undefined,
        baselineStopId: addedHere ? undefined : candidateStop.baselineStopId ?? candidateStop.stopId,
        coordinate,
        source: 'map',
        editStatus: addedHere ? candidateStop.editStatus : 'replaced',
      }
    }),
  })
}

export function removeScenarioStop(interventionId: string, index: number) {
  const intervention = activeScenario()?.interventions.find((entry) => entry.id === interventionId)
  const minimum = intervention?.kind === 'flex-zone' ? 3 : 2
  if (!intervention || intervention.stops.length <= minimum || !intervention.stops[index]) return
  scenarioEditor.set({ placement: null, drawing: false })
  updateScenarioChange(interventionId, { stops: intervention.stops.filter((_, stopIndex) => stopIndex !== index) })
}

/** Run a new line the other way. */
export function reverseScenarioLine(interventionId: string) {
  const intervention = activeScenario()?.interventions.find((entry) => entry.id === interventionId)
  if (!intervention || intervention.kind !== 'add-line' || intervention.stops.length < 2) return
  updateScenarioChange(interventionId, { stops: [...intervention.stops].reverse() })
}

export function resetScenarioRouteStops(interventionId: string) {
  const intervention = activeScenario()?.interventions.find((entry) => entry.id === interventionId)
  if (!intervention?.routeId) return
  const currentPreview = preview()
  scenarioEditor.set({ placement: null, drawing: false })
  updateScenarioChange(interventionId, {
    stops: scenarioStopsForRoute(findScenarioRoute(currentPreview.routes, intervention.routeId), currentPreview),
  })
}

export function clearScenarioSketch(interventionId: string) {
  scenarioEditor.set({ placement: null, drawing: false })
  updateScenarioChange(interventionId, { stops: [] })
}

export function removeScenarioChange(interventionId: string) {
  invalidateAnalyzeResult()
  scenarioEditor.set({ placement: null, drawing: false })
  const scenario = activeScenario()
  const remaining = scenario?.interventions.filter((entry) => entry.id !== interventionId) ?? []
  const { setScenarioDrafts, setActiveScenarioChangeId } = setters()
  setScenarioDrafts((current) => current.map((entry) => (
    entry.id === scenario?.id
      ? { ...entry, interventions: entry.interventions.filter((change) => change.id !== interventionId) }
      : entry
  )))
  setActiveScenarioChangeId(remaining[0]?.id ?? '')
}
