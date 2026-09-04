type DesktopBridge = {
  postMessage: (message: unknown) => void
  subscribe: (eventName: string, listener: (detail: unknown) => void) => number
  unsubscribe: (subscription: number) => void
}

type DesktopMapFirstRenderTimings = {
  navigationToMapMountMs: number
  featureProcessingMs: number
  mapLoadMs?: number
  localSourceRenderMs?: number
  localFirstPaintMs?: number
  basemapReadyMs?: number
  basemapAfterLocalMs?: number
}

type DesktopMapTelemetryPayload = {
  feedName: string
  basemap: string
  basemapStatus: 'not-started' | 'not-requested' | 'pending' | 'ready' | 'failed'
  timings: DesktopMapFirstRenderTimings
  sourceRouteFeatures: number
  sourceStopFeatures: number
}

type DesktopChromeCommand = 'toggleSidebar' | 'navigateBack' | 'navigateForward'

type DesktopChromeState = {
  appearance: 'dark' | 'light'
  title: string
  sidebarAvailable: boolean
  sidebarCollapsed: boolean
  canGoBack: boolean
  canGoForward: boolean
}

function desktopBridge(): DesktopBridge | undefined {
  return (globalThis as { vigoDesktop?: DesktopBridge }).vigoDesktop
}

function subscribeDesktopEvent<T>(eventName: string, listener: (detail: T) => void) {
  const bridge = desktopBridge()
  if (!bridge) return () => undefined
  const subscription = bridge.subscribe(eventName, (detail) => listener(detail as T))
  return () => bridge.unsubscribe(subscription)
}

export function syncDesktopChromeState(state: DesktopChromeState) {
  desktopBridge()?.postMessage({ action: 'setChromeState', ...state })
}

export function subscribeDesktopCommands(onCommand: (command: DesktopChromeCommand) => void) {
  return subscribeDesktopEvent<{ command?: DesktopChromeCommand }>('command', (detail) => {
    if (detail?.command) onCommand(detail.command)
  })
}

export function reportDesktopMapReady(payload: {
  feedName: string
  state: 'network' | 'stops-only'
  routeFeatures: number
  stopFeatures: number
  sourceRouteFeatures: number
  sourceStopFeatures: number
  basemap: string
  basemapStatus: DesktopMapTelemetryPayload['basemapStatus']
  timings: DesktopMapFirstRenderTimings
}) {
  desktopBridge()?.postMessage({ action: 'mapReady', ...payload })
}

export function reportDesktopMapPhase(payload: DesktopMapTelemetryPayload & {
  phase: 'features-prepared' | 'map-load' | 'local-source-render' | 'basemap-ready' | 'basemap-failed'
}) {
  desktopBridge()?.postMessage({ action: 'mapPhase', ...payload })
}

export function reportDesktopMapFailed(payload: {
  feedName: string
  stage: 'initialize' | 'render'
  message: string
}) {
  desktopBridge()?.postMessage({ action: 'mapFailed', ...payload })
}

type DesktopPathSelection = {
  path?: string
  kind?: string
  cancelled?: boolean
}

function requestDesktopPath(
  eventName: 'folder' | 'file',
  action: 'chooseHomeFolder' | 'chooseGtfsFile' | 'chooseOsmFile',
  accepts: (detail: DesktopPathSelection | undefined) => boolean,
  onPath: (path: string) => void,
) {
  const bridge = desktopBridge()
  if (!bridge) return false
  let unsubscribe: () => void = () => undefined
  unsubscribe = subscribeDesktopEvent<DesktopPathSelection>(eventName, (detail) => {
    if (!accepts(detail)) return
    unsubscribe()
    if (!detail?.cancelled && detail?.path) onPath(detail.path)
  })
  bridge.postMessage({ action })
  return true
}

export function requestDesktopHomeFolder(onPath: (path: string) => void) {
  return requestDesktopPath('folder', 'chooseHomeFolder', () => true, onPath)
}

export function requestDesktopGtfsFile(onPath: (path: string) => void) {
  return requestDesktopPath('file', 'chooseGtfsFile', (detail) => detail?.kind === 'gtfs', onPath)
}

export function requestDesktopOsmFile(onPath: (path: string) => void) {
  return requestDesktopPath('file', 'chooseOsmFile', (detail) => detail?.kind === 'osm', onPath)
}
