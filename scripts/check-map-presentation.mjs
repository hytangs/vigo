import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'

const root = resolve(import.meta.dirname, '..')
const source = readFileSync(resolve(root, 'src/app/mapPresentation.ts'), 'utf8')
const geometrySource = readFileSync(resolve(root, 'src/app/geometry.ts'), 'utf8')
const workspacePreviewPath = resolve(root, 'src/app/workspacePreview.ts')
assert.ok(existsSync(workspacePreviewPath), 'Workspace preview LOD helper is missing.')
const workspacePreviewSource = readFileSync(workspacePreviewPath, 'utf8')
const scheduledVehiclesSource = readFileSync(resolve(root, 'src/scheduledVehicles.ts'), 'utf8')
const serviceVehiclesSource = readFileSync(resolve(root, 'src/serviceVehicles.ts'), 'utf8')
const routeServicesPath = resolve(root, 'src/routeServices.ts')
assert.ok(existsSync(routeServicesPath), 'Route service identity helper is missing.')
const routeServicesSource = readFileSync(routeServicesPath, 'utf8')
const firstRenderTelemetryPath = resolve(root, 'src/app/mapFirstRenderTelemetry.ts')
assert.ok(existsSync(firstRenderTelemetryPath), 'Map first-render telemetry helper is missing.')
const firstRenderTelemetrySource = readFileSync(firstRenderTelemetryPath, 'utf8')
const mapSource = readFileSync(resolve(root, 'src/VigoMap.tsx'), 'utf8')
const nativeBridgeSource = readFileSync(resolve(root, 'src/app/nativeBridge.ts'), 'utf8')
const nativeShellSource = readFileSync(resolve(root, 'scripts/macos/VigoApp.m'), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: 'mapPresentation.ts',
}).outputText
const geometryCompiled = ts.transpileModule(geometrySource, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: 'geometry.ts',
}).outputText
const geometryUrl = `data:text/javascript;base64,${Buffer.from(geometryCompiled).toString('base64')}`
const presentationUrl = `data:text/javascript;base64,${Buffer.from(compiled.replace("from './geometry'", `from '${geometryUrl}'`)).toString('base64')}`
const presentation = await import(presentationUrl)
const routeServicesCompiled = ts.transpileModule(routeServicesSource, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: 'routeServices.ts',
}).outputText
const routeServicesUrl = `data:text/javascript;base64,${Buffer.from(routeServicesCompiled).toString('base64')}`
const routeServices = await import(routeServicesUrl)
const routePresentationSource = readFileSync(resolve(root, 'src/app/routePresentation.ts'), 'utf8')
const routePresentationCompiled = ts.transpileModule(routePresentationSource, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: 'routePresentation.ts',
}).outputText
  .replace("from '../scheduledVehicles'", `from 'data:text/javascript,export function formatScheduleClock(){}'`)
const routePresentation = await import(`data:text/javascript;base64,${Buffer.from(routePresentationCompiled).toString('base64')}`)
const workspacePreviewCompiled = ts.transpileModule(workspacePreviewSource, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: 'workspacePreview.ts',
}).outputText
  .replace("from './mapPresentation'", `from '${presentationUrl}'`)
  .replace("from '../routeServices'", `from '${routeServicesUrl}'`)
const workspacePreview = await import(`data:text/javascript;base64,${Buffer.from(workspacePreviewCompiled).toString('base64')}`)
const scheduledVehiclesCompiled = ts.transpileModule(scheduledVehiclesSource, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: 'scheduledVehicles.ts',
}).outputText.replace("from './app/geometry'", `from '${geometryUrl}'`)
const scheduledVehicles = await import(`data:text/javascript;base64,${Buffer.from(scheduledVehiclesCompiled).toString('base64')}`)
const scheduledVehiclesUrl = `data:text/javascript;base64,${Buffer.from(scheduledVehiclesCompiled).toString('base64')}`
const serviceVehiclesCompiled = ts.transpileModule(serviceVehiclesSource, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: 'serviceVehicles.ts',
}).outputText
  .replace("from './scheduledVehicles'", `from '${scheduledVehiclesUrl}'`)
  .replace("from './routeServices'", `from '${routeServicesUrl}'`)
const serviceVehicles = await import(`data:text/javascript;base64,${Buffer.from(serviceVehiclesCompiled).toString('base64')}`)
const firstRenderTelemetryCompiled = ts.transpileModule(firstRenderTelemetrySource, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: 'mapFirstRenderTelemetry.ts',
}).outputText
const firstRenderTelemetry = await import(`data:text/javascript;base64,${Buffer.from(firstRenderTelemetryCompiled).toString('base64')}`)

const stops = Array.from({ length: 1_200 }, (_value, index) => ({
  id: `stop-${index}`,
  name: `Stop ${index}`,
  lat: 45.8 + (index % 40) * 0.05,
  lon: 5.9 + Math.floor(index / 40) * 0.14,
  x: 0,
  y: 0,
  routes: [],
  tripCount: 0,
  transferScore: 0,
}))
const emptyRouteShells = Array.from({ length: 500 }, (_value, index) => ({
  id: `route-${index}`,
  shortName: `${index}`,
  longName: `${index}`,
  color: '#2f80ed',
  tripCount: 0,
  stopCount: 0,
  headwayMinutes: 0,
  spanHours: 0,
  serviceHours: 0,
  status: 'baseline',
  coordinates: [],
  points: [],
  stopIds: [],
}))

const sameNameBranches = [
  { ...emptyRouteShells[0], id: 'feed::branch-a', routeId: 'agency-a-1', shortName: '1', longName: 'Alpha → Bravo' },
  { ...emptyRouteShells[0], id: 'feed::branch-b', routeId: 'agency-b-1', shortName: '1', longName: 'Charlie → Delta' },
]
assert.notEqual(
  routeServices.scopedRouteServiceKey(sameNameBranches[0]),
  routeServices.scopedRouteServiceKey(sameNameBranches[1]),
  'Same-name GTFS branches must retain distinct route_id identities.',
)
assert.equal(
  routeServices.scopedRouteServiceKey({ ...sameNameBranches[0], id: 'feed::branch-a--pattern-2' }),
  routeServices.scopedRouteServiceKey(sameNameBranches[0]),
  'Patterns from one GTFS route_id must remain grouped in the inspector.',
)
const tiedLabels = routePresentation.routeListLabels([
  { ...sameNameBranches[0], longName: 'Central loop' },
  { ...sameNameBranches[1], longName: 'Central loop' },
])
assert.equal(tiedLabels.get('feed::branch-a'), 'Central loop · agency-a-1')
assert.equal(tiedLabels.get('feed::branch-b'), 'Central loop · agency-b-1')

const sample = presentation.spatiallySampleStops(stops, 120)
assert.equal(sample.length, 120)
assert.ok(new Set(sample.map((stop) => Math.floor((stop.lat - 45.8) / 0.5))).size >= 4)
assert.ok(new Set(sample.map((stop) => Math.floor((stop.lon - 5.9) / 0.7))).size >= 5)
assert.equal(presentation.inferredRouteJumpThresholdKm([0.8, 1.1, 72]), 4.5)
assert.ok(presentation.inferredRouteJumpThresholdKm([34, 48, 62]) >= 100)
assert.deepEqual(
  presentation.routingLabelAnchor([[-77, 38], [-77, 38.01], [-77, 38.03]]),
  [-77, 38.015],
)
assert.equal(presentation.routingLabelAnchor([[-77, 38], [-77, 38.0001]]), null)

const denseRoutes = Array.from({ length: 160 }, (_value, routeIndex) => (
  Array.from({ length: 3 }, (_patternValue, patternIndex) => ({
    ...emptyRouteShells[0],
    id: `feed::pattern-${routeIndex}-${patternIndex}`,
    routeId: `route-${routeIndex}`,
    patternId: `feed::pattern-${routeIndex}-${patternIndex}`,
    shortName: `${routeIndex}`,
    tripCount: patternIndex + 1,
    stopIds: Array.from({ length: 250 }, (_stopValue, stopIndex) => `feed::stop-${(routeIndex * 17 + stopIndex) % 3_000}`),
    coordinates: Array.from({ length: 250 }, (_coordinateValue, coordinateIndex) => [
      -77.12 + routeIndex * 0.0004 + coordinateIndex * 0.00001,
      38.82 + routeIndex * 0.0003 + coordinateIndex * 0.00001,
    ]),
  }))
)).flat()
const denseStops = Array.from({ length: 3_000 }, (_value, index) => ({
  ...stops[0],
  id: `feed::stop-${index}`,
  name: `DC stop ${index}`,
  lat: 38.78 + (index % 60) * 0.002,
  lon: -77.14 + Math.floor(index / 60) * 0.002,
}))
const selectedPatternId = 'feed::pattern-159-0'
const workspaceLod = workspacePreview.buildWorkspacePreviewLod({
  routes: denseRoutes,
  stops: denseStops,
  stopPairs: [{ id: 'pair-that-must-not-ship' }],
}, selectedPatternId)
const workspaceShapePoints = workspaceLod.routes.reduce(
  (sum, route) => sum + (route.coordinates?.length ?? 0),
  0,
)

assert.equal(workspaceLod.routes.length, denseRoutes.length, 'Every public route pattern must remain in the workspace atlas.')
assert.ok(workspaceLod.stops.length <= 16_000)
assert.equal(workspaceLod.stopPairs.length, 0)
assert.equal(workspaceShapePoints, denseRoutes.length * 250, 'Published route points must remain unchanged in the workspace atlas.')
assert.ok(workspaceLod.routes.some((route) => route.id === selectedPatternId))
assert.equal(new Set(workspaceLod.routes.map(workspacePreview.workspacePublicRouteKey)).size, workspaceLod.routes.length)
assert.ok(workspaceLod.routes.some((route) => route.routeId === 'route-0' && route.tripCount === 3))
assert.ok(
  mapSource.includes("networkLens === 'shape' || networkLens === 'risk'")
    && mapSource.includes("['==', ['get', 'geometrySource'], 'shape']")
    && mapSource.includes("map.setFilter('vigo-routes', routeFilter)")
    && mapSource.includes("'line-dasharray': ['case', ['==', ['get', 'geometrySource'], 'shape']"),
  'Ordinary network lenses must hide inferred stop chords while selected and geometry-QA routes remain explicitly dashed.',
)

const sameNameServiceLod = workspacePreview.buildWorkspacePreviewLod({
  routes: [
    { ...emptyRouteShells[0], id: 'feed::shuttle-a', routeId: 'shuttle-a', routeType: 3, shortName: 'Orange Line Shuttle', tripCount: 20, coordinates: [[-71.1, 42.3], [-71.0, 42.4]] },
    { ...emptyRouteShells[0], id: 'feed::shuttle-b', routeId: 'shuttle-b', routeType: 3, shortName: 'Orange Line Shuttle', tripCount: 10, coordinates: [[-71.2, 42.3], [-71.1, 42.4]] },
  ],
  stops: [],
  stopPairs: [],
})
assert.equal(sameNameServiceLod.routes.length, 2, 'Same-name route variants must remain independently inspectable.')

const vehiclePreview = {
  routes: [{
    ...emptyRouteShells[0],
    id: 'feed::route-p66::pattern-0',
    routeId: 'P66',
    shortName: 'P66',
    geometrySource: 'shape',
    coordinates: [[-77.1, 38.9], [-77.05, 38.92], [-77, 38.94]],
    stopIds: ['feed::stop-a', 'feed::stop-b', 'feed::stop-c'],
    firstDepartureMinutes: 480,
    lastArrivalMinutes: 500,
    scheduledTrips: [{
      tripId: 'feed::trip-1',
      routeId: 'P66',
      firstDepartureMinutes: 480,
      lastArrivalMinutes: 500,
      serviceDays: ['weekday'],
      stopTimes: [
        { stopId: 'feed::stop-a', sequence: 1, arrivalMinutes: 480, departureMinutes: 480, progress: 0 },
        { stopId: 'feed::stop-b', sequence: 2, arrivalMinutes: 490, departureMinutes: 491, progress: 0.5 },
        { stopId: 'feed::stop-c', sequence: 3, arrivalMinutes: 500, departureMinutes: 500, progress: 1 },
      ],
    }],
  }],
  stops: [],
  stopPairs: [],
}
const projectedVehicle = scheduledVehicles.scheduledVehiclesAtTime(vehiclePreview, 485, 'weekday')[0]
assert.equal(projectedVehicle.nextStopId, 'feed::stop-b')
assert.equal(projectedVehicle.nextStopArrivalMinutes, 490)
assert.equal(projectedVehicle.destinationStopId, 'feed::stop-c')
const minuteByMinuteVehicles = [480, 481, 482, 483].map(
  (minute) => scheduledVehicles.scheduledVehiclesAtTime(vehiclePreview, minute, 'weekday')[0],
)
assert.deepEqual(
  minuteByMinuteVehicles.map((vehicle) => Number(vehicle.progress.toFixed(3))),
  [0, 0.05, 0.1, 0.15],
  'Minute playback must interpolate each minute instead of reusing a five-minute cache bucket.',
)
assert.ok(
  minuteByMinuteVehicles.slice(1).every((vehicle, index) => (
    vehicle.progress > minuteByMinuteVehicles[index].progress
    && vehicle.progress - minuteByMinuteVehicles[index].progress <= 0.051
  )),
  'Consecutive one-minute frames must move continuously without a multi-minute jump.',
)

const fullFleetTripCount = 1_505
const fullFleetPreview = {
  ...vehiclePreview,
  routes: [{
    ...vehiclePreview.routes[0],
    scheduledTrips: Array.from({ length: fullFleetTripCount }, (_value, index) => ({
      ...vehiclePreview.routes[0].scheduledTrips[0],
      tripId: `feed::full-fleet-${index}`,
    })),
  }],
}
const fullFleetFrame = scheduledVehicles.scheduledVehiclesAtTime(fullFleetPreview, 485, 'weekday')
assert.equal(
  fullFleetFrame.length,
  fullFleetTripCount,
  'Full-network playback must retain every active scheduled trip beyond the former vehicle cap.',
)
assert.strictEqual(
  scheduledVehicles.scheduledVehiclesAtTime(fullFleetPreview, 485, 'weekday'),
  fullFleetFrame,
  'Repeated reads of the current playback frame should reuse the projection.',
)
scheduledVehicles.scheduledVehiclesAtTime(fullFleetPreview, 486, 'weekday')
assert.notStrictEqual(
  scheduledVehicles.scheduledVehiclesAtTime(fullFleetPreview, 485, 'weekday'),
  fullFleetFrame,
  'Playback must retain only the current full-fleet frame instead of accumulating fleet-sized history.',
)
assert.equal(
  scheduledVehicles.scheduledVehiclesAtTime(fullFleetPreview, 485, 'sunday').length,
  0,
  'An inactive service day must not invent static vehicles.',
)
const joinedVehiclePreview = {
  ...vehiclePreview,
  stops: [
    { ...stops[0], id: 'feed::stop-a', name: 'Stop A' },
    { ...stops[0], id: 'feed::stop-b', name: 'Stop B' },
    { ...stops[0], id: 'feed::stop-c', name: 'Stop C' },
  ],
}
const liveFrame = serviceVehicles.buildServiceVehicleFrame({
  mode: 'live',
  preview: joinedVehiclePreview,
  realtimeSnapshot: {
    fetchedAt: '2026-08-23T18:30:00.000Z',
    entityCount: 4,
    counts: { vehicles: 2, tripUpdates: 1, alerts: 2, other: 0 },
    vehicles: [
      { id: 'live-1', label: 'Vehicle 1', routeId: 'P66', tripId: 'ADDED-1', lat: 38.92, lon: -77.05, timestamp: 1_777_000_000 },
      { id: 'invalid-position', routeId: 'P66', tripId: 'ADDED-2', lat: 200, lon: -77.05 },
    ],
    tripUpdates: [{
      id: 'update-1',
      routeId: 'P66',
      tripId: 'ADDED-1',
      stopUpdateCount: 2,
      nextStopId: 'stop-b',
      nextStopSequence: 2,
      stopTimeUpdates: [
        { stopId: 'stop-b', stopSequence: 2, arrival: { time: 1_777_000_300 } },
        { stopId: 'stop-c', stopSequence: 3, arrival: { time: 1_777_000_900 } },
      ],
    }],
    alerts: [],
  },
  scheduledVehicles: [],
})
assert.equal(liveFrame.vehicles.length, 1, 'The live frame must retain every valid position and reject only invalid coordinates.')
assert.equal(liveFrame.vehicles[0].source, 'live')
assert.equal(liveFrame.vehicles[0].nextStopFeatureId, 'feed::stop-b')
assert.equal(liveFrame.vehicles[0].card.journey.nextStop, 'Stop B')
assert.equal(liveFrame.vehicles[0].card.journey.destination, 'Stop C')
assert.equal(liveFrame.vehicles[0].card.journey.arrivalLabel, 'Expected arrival')
assert.notEqual(liveFrame.vehicles[0].card.journey.arrival, 'Not encoded')
assert.equal(serviceVehicles.serviceVehicleCount(liveFrame, joinedVehiclePreview.routes[0]), 1)
const scheduleFrame = serviceVehicles.buildServiceVehicleFrame({
  mode: 'schedule',
  preview: joinedVehiclePreview,
  realtimeSnapshot: null,
  scheduledVehicles: [projectedVehicle],
})
assert.equal(scheduleFrame.vehicles[0].source, 'schedule')
assert.equal(scheduleFrame.vehicles[0].card.journey.nextStop, 'Stop B')
assert.equal(scheduleFrame.vehicles[0].card.journey.arrivalLabel, 'Scheduled arrival')
assert.ok(!mapSource.includes('routeFeatureBudget'), 'The map renderer must not discard complete route geometry by feature count.')
assert.ok(!mapSource.includes('realtimeVehicleBudget'), 'The map renderer must not truncate valid GTFS-RT positions.')
assert.ok(serviceVehiclesSource.includes('return snapshot.vehicles.flatMap((vehicle) => {'))
assert.ok(
  mapSource.includes('if (selectedRouteId && !selectedRouteMatch) return []'),
  'Route focus must remove other services from the visible and clickable live-vehicle source.',
)
assert.ok(
  serviceVehiclesSource.includes('const realtimeArrivalTimestamp = nextStopUpdate?.arrival?.time ?? nextStopUpdate?.departure?.time'),
  'Live vehicle details must use absolute GTFS-RT arrival events for added trips without static stop times.',
)
assert.ok(
  mapSource.includes("updateDynamicPointSource(map, 'vigo-service-vehicles', vehicleGeoJson, vehicleSourceStateRef)"),
  'Live and scheduled vehicles must share one bounded dynamic source update path.',
)
assert.ok(mapSource.includes('mapSource.updateData({'), 'Dynamic vehicle sources must update by stable feature ID instead of replacing the entire collection each frame.')
assert.ok(!mapSource.includes('vigo-realtime-vehicles') && !mapSource.includes('vigo-scheduled-vehicles'), 'The map must not retain duplicate live and schedule vehicle sources.')
assert.ok(mapSource.includes("filter: ['==', ['get', 'selectedRoute'], true]"), 'Dense vehicle labels and halos must stay selected-route only.')

const tracker = firstRenderTelemetry.createMapFirstRenderTracker({
  key: 'dc:first-render',
  basemap: 'dark',
  navigationStartedAt: 100,
  mapMountedAt: 120,
  featuresPreparedAt: 125.125,
})
assert.equal(firstRenderTelemetry.markMapCreated(tracker, 130), true)
assert.equal(firstRenderTelemetry.markMapCreated(tracker, 131), false)
assert.equal(firstRenderTelemetry.markMapLoaded(tracker, 180), true)
assert.equal(firstRenderTelemetry.markLocalSourceSubmitted(tracker, 200), true)
assert.equal(firstRenderTelemetry.markLocalSourceRendered(tracker, 240), true)
assert.equal(firstRenderTelemetry.markBasemapRequested(tracker, 'dark', 190), true)
assert.equal(firstRenderTelemetry.basemapTelemetryStatus(tracker), 'pending')
assert.equal(firstRenderTelemetry.markBasemapReady(tracker, 450), true)
assert.deepEqual(firstRenderTelemetry.mapFirstRenderTimings(tracker), {
  navigationToMapMountMs: 20,
  featureProcessingMs: 5.125,
  mapLoadMs: 50,
  localSourceRenderMs: 40,
  localFirstPaintMs: 140,
  basemapReadyMs: 260,
  basemapAfterLocalMs: 210,
})
assert.equal(firstRenderTelemetry.basemapTelemetryStatus(tracker), 'ready')
assert.equal(firstRenderTelemetry.markBasemapRequested(tracker, 'none', 500), true)
assert.equal(firstRenderTelemetry.basemapTelemetryStatus(tracker), 'pending')
assert.equal(firstRenderTelemetry.markBasemapReady(tracker, 500), true)
assert.equal(firstRenderTelemetry.basemapTelemetryStatus(tracker), 'not-requested')

assert.ok(mapSource.includes("map.on('render', reportReadyIfRendered)"))
assert.ok(mapSource.includes("map.off('render', reportReadyIfRendered)"))
assert.ok(!mapSource.includes("map.once('idle', reportReadyIfRendered)"))
assert.ok(mapSource.includes("map.on('sourcedata', handleSourceData)"))
assert.ok(mapSource.indexOf('ensureLayers(map)') < mapSource.indexOf('syncBasemap(map, basemapRef.current, appearanceRef.current)'))
assert.ok(mapSource.includes('const remoteBasemapDeferred ='))
assert.ok(mapSource.includes("tracker?.localSourceRenderedAt === undefined"))
assert.ok(mapSource.includes('syncBasemap(map, currentBasemap, appearanceRef.current)'))
assert.ok(mapSource.includes("featureKind: 'label'"))
assert.ok(mapSource.includes("'symbol-placement': 'point'"))
assert.ok(mapSource.includes("'text-rotation-alignment': 'viewport'"))
assert.ok(!mapSource.includes("'symbol-placement': 'line'"))
assert.ok(nativeBridgeSource.includes("action: 'mapPhase'"))
assert.ok(nativeBridgeSource.includes('localFirstPaintMs'))
assert.ok(nativeShellSource.includes('VIGO_MAP_PHASE'))
assert.ok(nativeShellSource.includes('VIGO_NAV_READY elapsedMs='))

console.log('Map presentation check passed (40 behavioral contracts).')
