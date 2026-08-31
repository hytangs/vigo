import { lazy, Suspense } from 'react'
import type { VigoMapProps } from '../VigoMap'

const MapCanvas = lazy(async () => {
  await import('maplibre-gl/dist/maplibre-gl.css')
  const module = await import('../VigoMap')
  return { default: module.VigoMap }
})

export function LazyVigoMap(props: VigoMapProps) {
  return (
    <Suspense
      fallback={
        <div className="map-loading" role="status" aria-live="polite" aria-label="Loading map">
          <span className="map-loading-status">
            <strong>Opening network</strong>
            <small>Preparing the local atlas</small>
          </span>
        </div>
      }
    >
      <MapCanvas {...props} />
    </Suspense>
  )
}
