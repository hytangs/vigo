type NativeBridge = {
  postMessage: (message: unknown) => void
}

export type NativeMapFirstRenderTimings = {
  navigationToMapMountMs: number
  featureProcessingMs: number
  mapLoadMs?: number
  localSourceRenderMs?: number
  localFirstPaintMs?: number
  basemapReadyMs?: number
  basemapAfterLocalMs?: number
}

export type NativeMapTelemetryPayload = {
  feedName: string
  basemap: string
  basemapStatus: 'not-started' | 'not-requested' | 'pending' | 'ready' | 'failed'
  timings: NativeMapFirstRenderTimings
  sourceRouteFeatures: number
  sourceStopFeatures: number
}

export type NativeChromeCommand = 'toggleSidebar' | 'navigateBack' | 'navigateForward'

export type NativeChromeState = {
  appearance: 'dark' | 'light'
  title: string
  sidebarAvailable: boolean
  sidebarCollapsed: boolean
  canGoBack: boolean
  canGoForward: boolean
}

function nativeBridge(): NativeBridge | undefined {
  return (globalThis as {
    webkit?: { messageHandlers?: { vigoNative?: NativeBridge } }
  }).webkit?.messageHandlers?.vigoNative
}

export function syncNativeChromeState(state: NativeChromeState) {
  nativeBridge()?.postMessage({ action: 'setChromeState', ...state })
}

export function subscribeNativeCommands(onCommand: (command: NativeChromeCommand) => void) {
  if (!nativeBridge()) return () => undefined

  const handleCommand = (event: Event) => {
    const command = (event as CustomEvent<{ command?: NativeChromeCommand }>).detail?.command
    if (command) onCommand(command)
  }

  window.addEventListener('vigo-native-command', handleCommand)
  return () => window.removeEventListener('vigo-native-command', handleCommand)
}

export function reportNativeMapReady(payload: {
  feedName: string
  state: 'network' | 'stops-only'
  routeFeatures: number
  stopFeatures: number
  sourceRouteFeatures: number
  sourceStopFeatures: number
  basemap: string
  basemapStatus: NativeMapTelemetryPayload['basemapStatus']
  timings: NativeMapFirstRenderTimings
}) {
  nativeBridge()?.postMessage({ action: 'mapReady', ...payload })
}

export function reportNativeMapPhase(payload: NativeMapTelemetryPayload & {
  phase: 'features-prepared' | 'map-load' | 'local-source-render' | 'basemap-ready' | 'basemap-failed'
}) {
  nativeBridge()?.postMessage({ action: 'mapPhase', ...payload })
}

export function reportNativeMapFailed(payload: {
  feedName: string
  stage: 'initialize' | 'render'
  message: string
}) {
  nativeBridge()?.postMessage({ action: 'mapFailed', ...payload })
}

function requestNativeFolder(
  action: 'chooseHomeFolder',
  onPath: (path: string) => void,
) {
  const bridge = nativeBridge()
  if (!bridge) return false

  const handleFolder = (event: Event) => {
    const detail = (event as CustomEvent<{ path?: string; cancelled?: boolean }>).detail
    if (!detail?.cancelled && detail?.path) onPath(detail.path)
  }

  window.addEventListener('vigo-native-folder', handleFolder, { once: true })
  bridge.postMessage({ action })
  return true
}

export function requestNativeHomeFolder(onPath: (path: string) => void) {
  return requestNativeFolder('chooseHomeFolder', onPath)
}

function requestNativeFile(
  kind: 'gtfs' | 'osm',
  action: 'chooseGtfsFile' | 'chooseOsmFile',
  onPath: (path: string) => void,
) {
  const bridge = nativeBridge()
  if (!bridge) return false

  const handleFile = (event: Event) => {
    const detail = (event as CustomEvent<{ path?: string; kind?: string; cancelled?: boolean }>).detail
    if (detail?.kind !== kind) {
      window.addEventListener('vigo-native-file', handleFile, { once: true })
      return
    }
    if (!detail.cancelled && detail.path) onPath(detail.path)
  }

  window.addEventListener('vigo-native-file', handleFile, { once: true })
  bridge.postMessage({ action })
  return true
}

export function requestNativeGtfsFile(onPath: (path: string) => void) {
  return requestNativeFile('gtfs', 'chooseGtfsFile', onPath)
}

export function requestNativeOsmFile(onPath: (path: string) => void) {
  return requestNativeFile('osm', 'chooseOsmFile', onPath)
}

let nativeCacheCleanupSequence = 0

export function requestNativeWebCacheCleanup() {
  const bridge = nativeBridge()
  if (!bridge) return Promise.resolve(false)

  const requestId = `cache-${Date.now()}-${++nativeCacheCleanupSequence}`
  return new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (cleaned: boolean) => {
      if (settled) return
      settled = true
      window.clearTimeout(timeout)
      window.removeEventListener('vigo-native-cache-cleaned', handleResult)
      resolve(cleaned)
    }
    const handleResult = (event: Event) => {
      const detail = (event as CustomEvent<{ requestId?: string; cleaned?: boolean }>).detail
      if (detail?.requestId === requestId) finish(detail.cleaned === true)
    }
    const timeout = window.setTimeout(() => finish(false), 10_000)
    window.addEventListener('vigo-native-cache-cleaned', handleResult)
    bridge.postMessage({ action: 'clearWebCache', requestId })
  })
}
