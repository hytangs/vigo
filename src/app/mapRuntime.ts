import { setWorkerUrl } from 'maplibre-gl'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'

// Bundle the worker with the app so both HTTP development and Studio's custom
// protocol use the same local module instead of guessing a CDN-relative URL.
setWorkerUrl(workerUrl)

export * from 'maplibre-gl'
