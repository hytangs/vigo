import { lazy, memo, Suspense } from 'react'
import { countRender } from '../app/renderCounts'
import type { VigoMapProps } from '../VigoMap'

const MapCanvas = lazy(async () => {
  await import('maplibre-gl/dist/maplibre-gl.css')
  const module = await import('../VigoMap')
  return { default: module.VigoMap }
})

/** The map renders only when one of its own inputs changes. */
export const LazyVigoMap = memo(function LazyVigoMap(props: VigoMapProps) {
  countRender('VigoMap')
  return (
    <Suspense
      fallback={
        <div className="map-loading" role="status" aria-live="polite" aria-label="Loading map">
          <span className="map-loading-status">
            <span className="signal-loader" aria-hidden="true" />
            <strong>Opening network</strong>
            <small>Preparing the local atlas</small>
          </span>
        </div>
      }
    >
      <MapCanvas {...props} />
    </Suspense>
  )
})
