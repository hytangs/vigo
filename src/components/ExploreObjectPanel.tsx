import { type CSSProperties, useMemo } from 'react'
import { AlertTriangle, ArrowRight, Check, Clock3, Database, GitBranch, SearchCheck } from 'lucide-react'
import type { FeedSummary, MapPreview, RouteMetric, StopMetric } from '../domain'
import { formatNumber, classNames } from '../domain'
import { routeHeadwayLabel, routeListLabel, routeModeLabel, routeSpanLabel } from '../app/routePresentation'
import { scopedRouteServiceKey, type RouteRenderMode } from '../routeServices'
import { gtfsDirectionLabel, gtfsPatternStops, gtfsPatternTimetable, gtfsServiceClock, orderedGtfsPatterns } from '../app/gtfsPresentation'

function patternGroup(preview: MapPreview, route: RouteMetric) {
  const key = scopedRouteServiceKey(route)
  return orderedGtfsPatterns(preview.routes.filter((candidate) => scopedRouteServiceKey(candidate) === key))
}

function uniqueStops(routes: RouteMetric[]) {
  return new Set(routes.flatMap((route) => route.stopIds)).size
}

function temporalPatternRows(routes: RouteMetric[]) {
  return routes.map((route, index) => ({
    id: route.id,
    direction: gtfsDirectionLabel(route.directionId),
    patternLabel: `P${index + 1}`,
    ...gtfsPatternTimetable(route),
    color: route.color,
  }))
}

function temporalDirectionRows(routes: RouteMetric[]) {
  const grouped = new Map<string, RouteMetric[]>()
  for (const route of routes) {
    const direction = gtfsDirectionLabel(route.directionId)
    grouped.set(direction, [...(grouped.get(direction) ?? []), route])
  }

  return [...grouped.entries()]
    .map(([direction, patterns]) => {
      const timetables = patterns.map(gtfsPatternTimetable)
      const starts = timetables.flatMap((row) => row.startMinutes === undefined ? [] : [row.startMinutes])
      const ends = timetables.flatMap((row) => row.endMinutes === undefined ? [] : [row.endMinutes])
      const startMinutes = starts.length ? Math.min(...starts) : undefined
      const endMinutes = ends.length ? Math.max(...ends) : undefined
      return {
        id: patterns[0].id,
        direction,
        startMinutes,
        endMinutes,
        spanLabel: startMinutes !== undefined && endMinutes !== undefined
          ? `${gtfsServiceClock(startMinutes)}–${gtfsServiceClock(endMinutes)}`
          : timetables.every((row) => row.dated && row.tripCount === 0) ? 'No trips on this date' : 'Times unavailable',
        tripCount: timetables.reduce((sum, row) => sum + row.tripCount, 0),
        patternCount: patterns.length,
        color: patterns[0]?.color ?? '#6da8ff',
      }
    })
    .sort((left, right) => left.direction.localeCompare(right.direction, undefined, { numeric: true }))
}

function TemporalServiceCanvas({
  routes,
  selectedRouteId,
  renderMode,
  onRenderModeChange,
  onSelectPattern,
}: {
  routes: RouteMetric[]
  selectedRouteId: string
  renderMode: RouteRenderMode
  onRenderModeChange: (mode: RouteRenderMode) => void
  onSelectPattern: (routeId: string) => void
}) {
  const patternRows = useMemo(() => temporalPatternRows(routes), [routes])
  const directionRows = useMemo(() => temporalDirectionRows(routes), [routes])
  const rows = renderMode === 'service' ? directionRows : patternRows
  const maximumMinutes = Math.ceil(Math.max(1_440, ...rows.map((row) => row.endMinutes ?? 0)) / 360) * 360
  const tickStep = Math.ceil(maximumMinutes / 5 / 360) * 360
  const ticks = Array.from({ length: Math.floor(maximumMinutes / tickStep) + 1 }, (_, index) => index * tickStep)
  const serviceDate = routes.every((route) => route.analysisServiceDate === routes[0]?.analysisServiceDate && Array.isArray(route.scheduledTrips))
    ? routes[0]?.analysisServiceDate : undefined

  return (
    <section className="temporal-canvas" aria-label="Temporal service canvas" title="Bands span first departure to last arrival, including gaps. Times after 24:00 continue into the next calendar day.">
      <div className="object-section-heading">
        <span><Clock3 size={13} />{serviceDate ? 'Scheduled service' : 'Feed timetable'}</span>
        <small>{serviceDate || 'All calendars'}</small>
      </div>
      <div className="temporal-view-switch" role="group" aria-label="Route rendering detail">
        <button
          type="button"
          className={classNames(renderMode === 'service' && 'is-active')}
          aria-pressed={renderMode === 'service'}
          onClick={() => onRenderModeChange('service')}
        >
          Full service
        </button>
        <button
          type="button"
          className={classNames(renderMode === 'pattern' && 'is-active')}
          aria-pressed={renderMode === 'pattern'}
          onClick={() => onRenderModeChange('pattern')}
        >
          Selected pattern
        </button>
      </div>
      <div className="temporal-axis" aria-hidden="true">
        {ticks.map((tick) => (
          <span key={tick} style={{ left: `${tick / maximumMinutes * 100}%` }}>
            {gtfsServiceClock(tick)}
          </span>
        ))}
      </div>
      <div className="temporal-rows">
        {rows.map((row) => {
          const hasTimes = row.startMinutes !== undefined && row.endMinutes !== undefined
          const start = Math.max(0, Math.min(100, (row.startMinutes ?? 0) / maximumMinutes * 100))
          const width = Math.max(1.5, Math.min(100 - start, ((row.endMinutes ?? 0) - (row.startMinutes ?? 0)) / maximumMinutes * 100))
          const rowContent = (
            <>
              <span className="temporal-row-label">
                <strong>{'patternLabel' in row ? `${row.patternLabel} · ` : ''}{row.direction}</strong>
                <small>
                  {formatNumber(row.tripCount)} trip{row.tripCount === 1 ? '' : 's'}
                  {'patternCount' in row ? ` · ${row.patternCount} pattern${row.patternCount === 1 ? '' : 's'}` : ''}
                </small>
                {hasTimes || row.tripCount > 0 ? <small>{row.spanLabel}</small> : null}
              </span>
              <span className="temporal-track">
                {hasTimes ? <i
                  style={{
                    '--pattern-left': `${start}%`,
                    '--pattern-width': `${width}%`,
                    '--pattern-color': row.color,
                  } as CSSProperties}
                /> : null}
              </span>
            </>
          )

          return (
            <button
              key={row.id}
              type="button"
              className={classNames('temporal-row', renderMode === 'pattern' && row.id === selectedRouteId && 'is-active')}
              onClick={() => onSelectPattern(row.id)}
              aria-pressed={renderMode === 'pattern' && row.id === selectedRouteId}
              aria-label={`${row.direction}, ${'patternLabel' in row ? row.patternLabel : 'select main pattern'}, ${row.tripCount} scheduled trips, ${row.spanLabel}`}
              title={`${row.direction} · ${row.spanLabel}`}
            >
              {rowContent}
            </button>
          )
        })}
      </div>
    </section>
  )
}

function DirectionPatternBrowser({ routes, stops, selectedRouteId, renderMode, onSelectPattern }: {
  routes: RouteMetric[]
  stops: StopMetric[]
  selectedRouteId: string
  renderMode: RouteRenderMode
  onSelectPattern: (routeId: string) => void
}) {
  const stopLookup = useMemo(() => new Map(stops.map((stop) => [stop.id, stop])), [stops])
  const directions = [...new Set(routes.map((route) => gtfsDirectionLabel(route.directionId)))]
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
  const selectedRoute = routes.find((route) => route.id === selectedRouteId)
  const selectedStops = selectedRoute ? gtfsPatternStops(selectedRoute, stopLookup) : []
  return (
    <section className="gtfs-pattern-browser" aria-label="Route directions and branches">
      <div className="object-section-heading">
        <span><GitBranch size={13} />Directions</span>
        <small>{routes.length} patterns</small>
      </div>
      <div className="gtfs-pattern-list">
        {directions.map((direction) => (
          <div className="gtfs-direction-group" key={direction} role="group" aria-label={direction}>
            <h3>{direction}</h3>
            {routes.map((route, index) => {
              if (gtfsDirectionLabel(route.directionId) !== direction) return null
              const orderedStops = gtfsPatternStops(route, stopLookup)
              const firstStop = orderedStops[0]
              const lastStop = orderedStops.at(-1)
              const selected = route.id === selectedRouteId
              return (
                <button
                  key={route.id}
                  type="button"
                  className={classNames('gtfs-pattern-choice', selected && 'is-active')}
                  aria-pressed={selected && renderMode === 'pattern'}
                  aria-label={`Show P${index + 1}, ${direction}, from ${firstStop?.name ?? 'unknown'} to ${lastStop?.name ?? 'unknown'}, ${orderedStops.length} stops`}
                  title={route.geometrySource === 'shape' ? `shape_id=${route.shapeId ?? 'unavailable'}` : route.geometrySource === 'stop_sequence' ? 'Stop connections · exact path unavailable' : 'Geometry source unverified'}
                  onClick={() => onSelectPattern(route.id)}
                >
                  <span className="gtfs-pattern-choice-heading"><b>P{index + 1}</b><small>{formatNumber(route.tripCount)} feed trips{selected && renderMode === 'pattern' ? <Check size={13} aria-hidden="true" /> : null}</small></span>
                  <span className="gtfs-pattern-endpoints"><span>{firstStop?.name ?? 'Start unavailable'}</span><ArrowRight size={13} aria-hidden="true" /><strong>{lastStop?.name ?? 'End unavailable'}</strong></span>
                  <span className="gtfs-pattern-facts">{orderedStops.length} stops{firstStop && firstStop.id === lastStop?.id ? ' · Loop' : ''}</span>
                </button>
              )
            })}
          </div>
        ))}
      </div>
      {selectedRoute ? (
        <details className="object-disclosure gtfs-stop-disclosure">
          <summary>P{routes.indexOf(selectedRoute) + 1} · Stops <small>{selectedStops.length}</small></summary>
          <ol className="gtfs-ordered-stops">
            {selectedStops.map((stop, index) => (
              <li key={`${stop.id}:${stop.order}`}>
                <span className="gtfs-stop-number">{stop.order}</span>
                <span><strong>{stop.name}</strong><small>{index === 0 ? 'Start · ' : index === selectedStops.length - 1 ? 'End · ' : ''}{stop.id}{stop.platform ? ` · Platform ${stop.platform}` : ''}</small></span>
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </section>
  )
}

export function ExploreObjectPanel({
  feed,
  preview,
  selectedRoute,
  selectedStop,
  analysisLoading,
  analysisError,
  routeRenderMode,
  onRouteRenderModeChange,
  onSelectPattern,
  onOpenSources,
  onClearSelection,
}: {
  feed: FeedSummary
  preview: MapPreview
  selectedRoute?: RouteMetric
  selectedStop?: StopMetric
  analysisLoading: boolean
  analysisError: string
  routeRenderMode: RouteRenderMode
  onRouteRenderModeChange: (mode: RouteRenderMode) => void
  onSelectPattern: (routeId: string) => void
  onOpenSources: () => void
  onClearSelection: () => void
}) {
  if (!selectedRoute && !selectedStop) {
    return (
      <section className="sidebar-section object-first-empty">
        <SearchCheck size={18} />
        <strong>Explore the GTFS map</strong>
        <p>Select a route or stop.</p>
        <button type="button" className="text-action" onClick={onOpenSources}>View source tables</button>
      </section>
    )
  }

  if (selectedStop && !selectedRoute) {
    return (
      <section className="sidebar-section object-detail" aria-label="Selected stop details">
        <div className="object-detail-head">
          <span>Stop</span>
          <button type="button" onClick={onClearSelection}>Clear</button>
          <h2>{selectedStop.name}</h2>
          <p>{selectedStop.parentStationName || (selectedStop.parentStationId ? 'Station platform' : 'Independent stop')}</p>
        </div>
        <dl className="object-metric-grid">
          <div><dt>Routes</dt><dd>{formatNumber(selectedStop.routes.length)}</dd></div>
          <div><dt>Trips</dt><dd>{formatNumber(selectedStop.tripCount)}</dd></div>
          <div><dt>Platform</dt><dd>{selectedStop.platformCode || 'Not encoded'}</dd></div>
          <div><dt>Cluster</dt><dd>{selectedStop.parentStationId ? 'Encoded' : 'Review'}</dd></div>
        </dl>
        <section className="object-lineage">
          <div className="object-section-heading"><span><Database size={13} />GTFS facts</span></div>
          <button type="button" onClick={onOpenSources}>
            <strong>stops.txt</strong>
            <small>stop_id={selectedStop.id}</small>
          </button>
          <button type="button" onClick={onOpenSources}>
            <strong>stop_times.txt</strong>
            <small>{formatNumber(selectedStop.tripCount)} indexed references</small>
          </button>
          <button type="button" onClick={onOpenSources}>
            <strong>transfers.txt + pathways.txt</strong>
            <small>{selectedStop.parentStationId ? `parent_station=${selectedStop.parentStationId}` : 'No parent station encoded'}</small>
          </button>
        </section>
      </section>
    )
  }

  const route = selectedRoute as RouteMetric
  const patterns = patternGroup(preview, route)
  const serviceTrips = patterns.reduce((sum, pattern) => sum + pattern.tripCount, 0)
  const serviceStops = uniqueStops(patterns)
  const firstDepartures = patterns.flatMap((pattern) => pattern.firstDepartureMinutes === undefined ? [] : [pattern.firstDepartureMinutes])
  const lastArrivals = patterns.flatMap((pattern) => pattern.lastArrivalMinutes === undefined ? [] : [pattern.lastArrivalMinutes])
  const headwayTrips = patterns.reduce((sum, pattern) => sum + (pattern.headwayMinutes ? pattern.tripCount : 0), 0)
  const serviceRoute = {
    ...route,
    tripCount: serviceTrips || route.tripCount,
    stopCount: serviceStops || route.stopIds.length,
    firstDepartureMinutes: firstDepartures.length ? Math.min(...firstDepartures) : route.firstDepartureMinutes,
    lastArrivalMinutes: lastArrivals.length ? Math.max(...lastArrivals) : route.lastArrivalMinutes,
    headwayMinutes: headwayTrips
      ? Math.round(patterns.reduce((sum, pattern) => sum + (pattern.headwayMinutes ?? 0) * pattern.tripCount, 0) / headwayTrips)
      : route.headwayMinutes,
  }
  serviceRoute.spanHours = serviceRoute.firstDepartureMinutes !== undefined && serviceRoute.lastArrivalMinutes !== undefined
    ? Math.max(0, (serviceRoute.lastArrivalMinutes - serviceRoute.firstDepartureMinutes) / 60)
    : route.spanHours

  return (
    <section className="sidebar-section object-detail" aria-label="Selected route details">
      <div className="object-detail-head" style={{ '--route-color': route.color } as CSSProperties}>
        <span>{routeModeLabel(route.routeType)}</span>
        <button type="button" onClick={onClearSelection}>Clear</button>
        <h2>{route.shortName}</h2>
        <p>{routeListLabel(route)} · {feed.name}</p>
      </div>
      <dl className="object-metric-grid">
        <div title="Across all feed calendars"><dt>Feed span</dt><dd>{routeSpanLabel(serviceRoute, analysisLoading)}</dd></div>
        <div title="Mean pattern headway weighted by trip count, across all feed calendars"><dt>Mean headway</dt><dd>{routeHeadwayLabel(serviceRoute, analysisLoading)}</dd></div>
        <div><dt>Feed trips</dt><dd>{formatNumber(serviceTrips || route.tripCount)}</dd></div>
        <div><dt>Unique stops</dt><dd>{formatNumber(serviceStops || route.stopIds.length)}</dd></div>
      </dl>
      {analysisLoading ? (
        <div className="object-analysis-state" role="status">
          <Database size={14} />
          <span><strong>Loading timetable…</strong></span>
        </div>
      ) : analysisError ? (
        <div className="object-analysis-state is-error" role="alert">
          <AlertTriangle size={14} />
          <span><strong>Analysis needs review</strong><small>{analysisError}</small></span>
        </div>
      ) : null}
      <DirectionPatternBrowser
        routes={patterns}
        stops={preview.stops}
        selectedRouteId={route.id}
        renderMode={routeRenderMode}
        onSelectPattern={onSelectPattern}
      />
      <TemporalServiceCanvas
        routes={patterns}
        selectedRouteId={route.id}
        renderMode={routeRenderMode}
        onRenderModeChange={onRouteRenderModeChange}
        onSelectPattern={onSelectPattern}
      />
      <details className="object-disclosure" aria-label="GTFS source data">
        <summary>Source data</summary>
        <div className="lineage-stack">
          <button type="button" onClick={onOpenSources}>
            <i className="tone-fact" />
            <span><strong>routes.txt</strong><small>route_id={route.routeId ?? route.id}</small></span>
          </button>
          <button type="button" onClick={onOpenSources}>
            <i className="tone-inference" />
            <span><strong>trips.txt · stop_times.txt</strong><small>{patterns.length} patterns</small></span>
          </button>
          <button type="button" onClick={onOpenSources}>
            <i className="tone-visual" />
            <span><strong>{route.geometrySource === 'shape' ? 'shapes.txt' : 'Geometry'}</strong><small>{route.geometrySource === 'shape' ? `shape_id=${route.shapeId ?? 'unavailable'}` : route.geometrySource === 'stop_sequence' ? 'Stop connections · exact path unavailable' : 'Source unverified'}</small></span>
          </button>
        </div>
      </details>
    </section>
  )
}
