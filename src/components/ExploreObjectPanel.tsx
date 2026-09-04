import { type CSSProperties, useMemo } from 'react'
import { AlertTriangle, Clock3, Database, SearchCheck } from 'lucide-react'
import type { FeedSummary, MapPreview, RouteMetric, StopMetric } from '../domain'
import { formatNumber, classNames } from '../domain'
import { routeHeadwayLabel, routeListLabel, routeModeLabel, routeSpanLabel } from '../app/routePresentation'
import { scopedRouteServiceKey, type RouteRenderMode } from '../routeServices'

function patternGroup(preview: MapPreview, route: RouteMetric) {
  const key = scopedRouteServiceKey(route)
  return preview.routes.filter((candidate) => scopedRouteServiceKey(candidate) === key)
}

function uniqueStops(routes: RouteMetric[]) {
  return new Set(routes.flatMap((route) => route.stopIds)).size
}

function temporalPatternRows(routes: RouteMetric[]) {
  const totalTrips = routes.reduce((sum, route) => sum + route.tripCount, 0)
  return [...routes]
    .sort((left, right) => (
      (left.firstDepartureMinutes ?? Number.MAX_SAFE_INTEGER) - (right.firstDepartureMinutes ?? Number.MAX_SAFE_INTEGER)
      || right.tripCount - left.tripCount
    ))
    .map((route) => ({
      id: route.id,
      direction: route.directionId === undefined || route.directionId === '' ? 'Primary' : `Direction ${route.directionId}`,
      startMinutes: Math.max(0, route.firstDepartureMinutes ?? 0),
      endMinutes: Math.max(
        route.firstDepartureMinutes ?? 0,
        route.lastArrivalMinutes ?? (route.firstDepartureMinutes ?? 0),
      ),
      headwayMinutes: route.headwayMinutes,
      tripCount: route.tripCount,
      share: totalTrips ? route.tripCount / totalTrips : 0,
      color: route.color,
    }))
}

function temporalDirectionRows(routes: RouteMetric[]) {
  const grouped = new Map<string, RouteMetric[]>()
  for (const route of routes) {
    const direction = route.directionId === undefined || route.directionId === '' ? 'Primary' : `Direction ${route.directionId}`
    grouped.set(direction, [...(grouped.get(direction) ?? []), route])
  }

  return [...grouped.entries()]
    .map(([direction, patterns]) => {
      const tripCount = patterns.reduce((sum, pattern) => sum + pattern.tripCount, 0)
      const headwayTripCount = patterns.reduce((sum, pattern) => (
        sum + (pattern.headwayMinutes ? pattern.tripCount : 0)
      ), 0)
      const weightedHeadway = patterns.reduce((sum, pattern) => (
        sum + (pattern.headwayMinutes ?? 0) * pattern.tripCount
      ), 0)
      return {
        id: direction,
        direction,
        startMinutes: Math.min(...patterns.map((pattern) => Math.max(0, pattern.firstDepartureMinutes ?? 0))),
        endMinutes: Math.max(...patterns.map((pattern) => Math.max(
          pattern.firstDepartureMinutes ?? 0,
          pattern.lastArrivalMinutes ?? (pattern.firstDepartureMinutes ?? 0),
        ))),
        headwayMinutes: headwayTripCount ? Math.round(weightedHeadway / headwayTripCount) : 0,
        tripCount,
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
  const maximumMinutes = Math.max(1_800, ...rows.map((row) => row.endMinutes))
  const ticks = [0, 360, 720, 1_080, 1_440, 1_800].filter((tick) => tick <= maximumMinutes)

  return (
    <section className="temporal-canvas" aria-label="Temporal service canvas">
      <div className="object-section-heading">
        <span><Clock3 size={13} />Service day</span>
        <small>{directionRows.length} direction{directionRows.length === 1 ? '' : 's'} · {patternRows.length} patterns</small>
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
          Patterns
        </button>
      </div>
      <div className="temporal-axis" aria-hidden="true">
        {ticks.map((tick) => (
          <span key={tick} style={{ left: `${tick / maximumMinutes * 100}%` }}>
            {String(Math.floor(tick / 60) % 24).padStart(2, '0')}:00
          </span>
        ))}
      </div>
      <div className="temporal-rows">
        {rows.map((row, index) => {
          const start = Math.max(0, Math.min(100, row.startMinutes / maximumMinutes * 100))
          const width = Math.max(1.5, Math.min(100 - start, (row.endMinutes - row.startMinutes) / maximumMinutes * 100))
          const rowContent = (
            <>
              <span className="temporal-row-label">
                <strong>{row.direction}{renderMode === 'pattern' ? ` · P${index + 1}` : ''}</strong>
                <small>
                  {formatNumber(row.tripCount)} trip{row.tripCount === 1 ? '' : 's'}
                  {'patternCount' in row ? ` · ${row.patternCount} pattern${row.patternCount === 1 ? '' : 's'}` : ''}
                  {' · '}{row.headwayMinutes ? `~${row.headwayMinutes} min` : 'trip-based'}
                </small>
              </span>
              <span className="temporal-track">
                <i
                  style={{
                    '--pattern-left': `${start}%`,
                    '--pattern-width': `${width}%`,
                    '--pattern-color': row.color,
                  } as CSSProperties}
                />
              </span>
            </>
          )

          return renderMode === 'pattern' ? (
            <button
              key={row.id}
              type="button"
              className={classNames('temporal-row', row.id === selectedRouteId && 'is-active')}
              onClick={() => onSelectPattern(row.id)}
              aria-label={`${row.direction}, ${row.tripCount} ${row.tripCount === 1 ? 'trip' : 'trips'}, pattern ${index + 1}`}
            >
              {rowContent}
            </button>
          ) : (
            <div
              key={row.id}
              className="temporal-row is-summary"
              aria-label={`${row.direction}, ${row.tripCount} scheduled trips across ${'patternCount' in row ? row.patternCount : 1} patterns`}
            >
              {rowContent}
            </div>
          )
        })}
      </div>
      <p className="object-method-note">
        {renderMode === 'service'
          ? 'Direction bands summarize the complete public service. The map draws every pattern separately and never joins pattern endpoints.'
          : 'Pattern mode isolates distinct GTFS stop sequences for inspection. Bars are timetable facts, not live operations.'}
      </p>
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
        <p>Choose a service from the list or click a route or stop on the map. Open source tables when you need the raw feed.</p>
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
        <p>{routeListLabel(route)} · {feed.name} · {patterns.length} reconstructed pattern{patterns.length === 1 ? '' : 's'}</p>
      </div>
      <dl className="object-metric-grid">
        <div><dt>Service span</dt><dd>{routeSpanLabel(serviceRoute, analysisLoading)}</dd></div>
        <div><dt>Headway</dt><dd>{routeHeadwayLabel(serviceRoute, analysisLoading)}</dd></div>
        <div><dt>Trips</dt><dd>{formatNumber(serviceTrips || route.tripCount)}</dd></div>
        <div><dt>Stops</dt><dd>{formatNumber(serviceStops || route.stopIds.length)}</dd></div>
      </dl>
      {analysisLoading ? (
        <div className="object-analysis-state" role="status">
          <Database size={14} />
          <span><strong>Reconstructing complete service</strong><small>Reading trip patterns, stops, span, and headway from local SQLite.</small></span>
        </div>
      ) : analysisError ? (
        <div className="object-analysis-state is-error" role="alert">
          <AlertTriangle size={14} />
          <span><strong>Analysis needs review</strong><small>{analysisError}</small></span>
        </div>
      ) : null}
      <TemporalServiceCanvas
        routes={patterns}
        selectedRouteId={route.id}
        renderMode={routeRenderMode}
        onRenderModeChange={onRouteRenderModeChange}
        onSelectPattern={onSelectPattern}
      />
      <details className="object-disclosure" open aria-label="Calculation lineage">
        <summary>Calculation lineage</summary>
        <div className="lineage-stack">
          <button type="button" onClick={onOpenSources}>
            <i className="tone-fact" />
            <span><strong>GTFS fact</strong><small>routes.txt · route_id={route.routeId ?? route.id}</small></span>
          </button>
          <button type="button" onClick={onOpenSources}>
            <i className="tone-inference" />
            <span><strong>Derived service structure</strong><small>trips.txt + stop_times.txt · {patterns.length} distinct stop sequences</small></span>
          </button>
          <button type="button" onClick={onOpenSources}>
            <i className="tone-visual" />
            <span><strong>Map geometry</strong><small>{route.geometrySource === 'shape' ? `shapes.txt · shape_id=${route.shapeId ?? 'selected trip shape'}` : 'ordered stop coordinates'}</small></span>
          </button>
        </div>
      </details>
    </section>
  )
}
