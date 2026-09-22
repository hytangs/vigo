import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  net,
  protocol,
  shell,
  utilityProcess,
} from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

app.setName('VIGO Studio')
app.setPath('userData', path.join(app.getPath('appData'), 'VIGO'))

const studioScheme = 'vigo'
const studioOrigin = `${studioScheme}://studio`
const requestTimeoutMs = 15 * 60 * 1_000
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url))
const sourceRoot = path.resolve(moduleDirectory, '..')
const applicationRoot = app.isPackaged ? app.getAppPath() : sourceRoot
const publicRoot = path.join(applicationRoot, 'public')
const serverRoot = app.isPackaged
  ? path.join(applicationRoot, 'server')
  : path.join(applicationRoot, 'src', 'server')
const serverPath = path.join(serverRoot, 'vigo-api.mjs')
const nativeKernelPath = app.isPackaged
  ? path.join(serverRoot, 'vigo-routing-kernel.node')
  : path.join(applicationRoot, 'native', 'vigo-routing-kernel', 'vigo-routing-kernel.node')
const preloadPath = path.join(moduleDirectory, 'preload.cjs')
const studioIconPath = path.join(publicRoot, 'icons', 'VIGOIcon.png')

let mainWindow = null
let engine = null
let engineReady = null
let engineReadyResolve = null
let engineReadyReject = null
let engineSequence = 0
let quitting = false
const pendingRequests = new Map()

protocol.registerSchemesAsPrivileged([{
  scheme: studioScheme,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true,
    codeCache: true,
  },
}])

function isInside(parent, child) {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

async function studioAsset(pathname) {
  let relativePath
  try {
    relativePath = decodeURIComponent(pathname).replace(/^\/+/, '')
  } catch {
    return null
  }
  if (!relativePath || relativePath.endsWith('/')) relativePath += 'index.html'
  let candidate = path.resolve(publicRoot, relativePath)
  if (!isInside(publicRoot, candidate)) return null

  let fileStats = await fs.stat(candidate).catch(() => null)
  if (fileStats?.isDirectory()) {
    candidate = path.join(candidate, 'index.html')
    fileStats = await fs.stat(candidate).catch(() => null)
  }
  if (fileStats?.isFile()) return candidate

  if (!path.extname(relativePath)) {
    const indexPath = path.join(publicRoot, 'index.html')
    const indexStats = await fs.stat(indexPath).catch(() => null)
    if (indexStats?.isFile()) return indexPath
  }
  return null
}

function responseHeaders(rawHeaders = {}) {
  const headers = new Headers()
  for (const [name, rawValue] of Object.entries(rawHeaders)) {
    if (['connection', 'content-length', 'transfer-encoding'].includes(name.toLowerCase())) continue
    const values = Array.isArray(rawValue) ? rawValue : [rawValue]
    for (const value of values) {
      if (value !== undefined) headers.append(name, String(value))
    }
  }
  return headers
}

function failPendingRequests(error) {
  for (const entry of pendingRequests.values()) {
    clearTimeout(entry.timeout)
    entry.signal?.removeEventListener('abort', entry.abort)
    entry.reject(error)
  }
  pendingRequests.clear()
}

function engineEnvironment() {
  // A packaged engine needs OS paths and locale, not the launching shell's
  // provider credentials, build overrides or runtime injection settings.
  const environment = app.isPackaged
    ? Object.fromEntries(Object.entries(process.env).filter(([name]) => (
      /^(?:PATH|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|SystemRoot|WINDIR|TEMP|TMP|TMPDIR|XDG_CONFIG_HOME|XDG_CACHE_HOME|XDG_DATA_HOME|LANG|LANGUAGE|LC_[A-Z_]+|TZ)$/iu.test(name)
    )))
    : { ...process.env }
  for (const name of [
    'DYLD_INSERT_LIBRARIES',
    'DYLD_LIBRARY_PATH',
    'LD_PRELOAD',
    'LD_LIBRARY_PATH',
    'ELECTRON_RUN_AS_NODE',
    'NODE_OPTIONS',
    'NODE_PATH',
    'VIGO_API_PORT',
    'VIGO_API_TRANSPORT',
    'VIGO_CONFIG_DIR',
    'VIGO_DIST_DIR',
    'VIGO_HOST',
    'VIGO_NATIVE_ROUTING_KERNEL',
    'VIGO_PORT',
    'VIGO_PROJECTS_DIR',
  ]) {
    delete environment[name]
  }
  environment.VIGO_API_TRANSPORT = 'memory'
  environment.VIGO_NATIVE_ROUTING_KERNEL = nativeKernelPath
  return environment
}

function startEngine() {
  if (engine) return engineReady

  engineReady = new Promise((resolve, reject) => {
    engineReadyResolve = resolve
    engineReadyReject = reject
  })
  const startupTimeout = setTimeout(() => {
    engineReadyReject?.(new Error('VIGO Engine did not start within 30 seconds.'))
  }, 30_000)

  engine = utilityProcess.fork(serverPath, [], {
    cwd: applicationRoot,
    env: engineEnvironment(),
    serviceName: 'VIGO Engine',
    stdio: 'pipe',
  })
  engine.stdout?.on('data', (chunk) => process.stdout.write(`[engine] ${chunk}`))
  engine.stderr?.on('data', (chunk) => process.stderr.write(`[engine] ${chunk}`))
  engine.on('message', (message) => {
    if (message?.type === 'vigo-api-ready') {
      clearTimeout(startupTimeout)
      engineReadyResolve?.(message)
      return
    }
    if (message?.type !== 'vigo-api-response') return
    const id = String(message.id ?? '')
    const entry = pendingRequests.get(id)
    if (!entry) return
    pendingRequests.delete(id)
    clearTimeout(entry.timeout)
    entry.signal?.removeEventListener('abort', entry.abort)
    if (message.error || !Number(message.status)) {
      entry.reject(new Error(String(message.error || 'VIGO Engine request failed.')))
      return
    }
    entry.resolve(message)
  })
  engine.on('error', (error) => {
    clearTimeout(startupTimeout)
    engineReadyReject?.(error)
    failPendingRequests(error)
  })
  engine.on('exit', (code) => {
    clearTimeout(startupTimeout)
    const error = new Error(`VIGO Engine stopped with status ${code}.`)
    engineReadyReject?.(error)
    failPendingRequests(error)
    engine = null
    if (!quitting) {
      dialog.showErrorBox('VIGO Engine stopped', 'Close and reopen VIGO Studio to restart the engine.')
      app.quit()
    }
  })
  return engineReady
}

async function requestEngine(request, signal) {
  await engineReady
  if (!engine) throw new Error('VIGO Engine is not running.')
  if (signal?.aborted) throw signal.reason ?? new DOMException('Request aborted.', 'AbortError')

  const id = `${process.pid}-${++engineSequence}`
  return new Promise((resolve, reject) => {
    const finishWithError = (error) => {
      const entry = pendingRequests.get(id)
      if (!entry) return
      pendingRequests.delete(id)
      clearTimeout(entry.timeout)
      entry.signal?.removeEventListener('abort', entry.abort)
      reject(error)
    }
    const timeout = setTimeout(() => {
      engine?.postMessage({ type: 'vigo-api-cancel', id })
      finishWithError(new Error('VIGO Engine request exceeded 15 minutes.'))
    }, requestTimeoutMs)
    const abort = () => {
      engine?.postMessage({ type: 'vigo-api-cancel', id })
      finishWithError(signal.reason ?? new DOMException('Request aborted.', 'AbortError'))
    }
    pendingRequests.set(id, { resolve, reject, timeout, signal, abort })
    signal?.addEventListener('abort', abort, { once: true })
    try {
      engine.postMessage({ type: 'vigo-api-request', id, ...request })
    } catch (error) {
      finishWithError(error)
    }
  })
}

async function handleStudioProtocol(request) {
  const url = new URL(request.url)
  if (url.host !== 'studio') return new Response('Not found', { status: 404 })

  if (url.pathname.startsWith('/api/')) {
    const method = request.method.toUpperCase()
    const bodyBytes = ['GET', 'HEAD'].includes(method)
      ? undefined
      : new Uint8Array(await request.arrayBuffer())
    const result = await requestEngine({
      path: `${url.pathname}${url.search}`,
      method,
      headers: Object.fromEntries(request.headers.entries()),
      ...(bodyBytes?.byteLength ? { bodyBytes } : {}),
    }, request.signal)
    const body = result.bodyBytes instanceof Uint8Array
      ? result.bodyBytes
      : typeof result.bodyBase64 === 'string'
        ? Buffer.from(result.bodyBase64, 'base64')
        : Buffer.from(String(result.body ?? ''))
    return new Response([204, 205, 304].includes(Number(result.status)) ? null : body, {
      status: Number(result.status),
      headers: responseHeaders(result.headers),
    })
  }

  const filePath = await studioAsset(url.pathname)
  if (!filePath) return new Response('Not found', { status: 404 })
  return net.fetch(pathToFileURL(filePath).toString())
}

function trustedRenderer(event) {
  try {
    const url = new URL(event.senderFrame?.url ?? '')
    return url.protocol === `${studioScheme}:` && url.host === 'studio' && event.senderFrame?.top === event.senderFrame
  } catch {
    return false
  }
}

function sendDesktopEvent(name, detail = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('vigo-desktop-event', name, detail)
}

async function chooseDirectory() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose VIGO City Folder',
    buttonLabel: 'Use Folder',
    properties: ['openDirectory', 'createDirectory'],
  })
  return result.canceled ? '' : result.filePaths[0] ?? ''
}

async function chooseFile(kind) {
  const gtfs = kind === 'gtfs'
  const result = await dialog.showOpenDialog(mainWindow, {
    title: gtfs ? 'Choose GTFS ZIP' : 'Choose OpenStreetMap PBF',
    buttonLabel: gtfs ? 'Index GTFS' : 'Index Streets',
    properties: ['openFile'],
    filters: gtfs
      ? [{ name: 'GTFS', extensions: ['zip'] }]
      : [{ name: 'OpenStreetMap', extensions: ['pbf'] }],
  })
  return result.canceled ? '' : result.filePaths[0] ?? ''
}

function installDesktopBridge() {
  ipcMain.on('vigo-desktop-message', async (event, message) => {
    if (!trustedRenderer(event) || !message || typeof message !== 'object') return
    const action = String(message.action ?? '')
    if (action === 'chooseHomeFolder') {
      const selectedPath = await chooseDirectory()
      sendDesktopEvent('folder', { path: selectedPath, cancelled: !selectedPath })
      return
    }
    if (action === 'chooseGtfsFile' || action === 'chooseOsmFile') {
      const kind = action === 'chooseGtfsFile' ? 'gtfs' : 'osm'
      const selectedPath = await chooseFile(kind)
      sendDesktopEvent('file', { path: selectedPath, kind, cancelled: !selectedPath })
      return
    }
    if (action === 'setChromeState') {
      const appearance = message.appearance === 'dark' ? 'dark' : 'light'
      nativeTheme.themeSource = appearance
      if (mainWindow && typeof message.title === 'string') {
        mainWindow.setTitle(message.title.trim() || 'VIGO Studio')
      }
      return
    }
    if (['mapPhase', 'mapReady', 'mapFailed'].includes(action)) {
      console.log(`VIGO_${action.toUpperCase()} ${JSON.stringify(message)}`)
    }
  })
}

function installMenu() {
  const sendCommand = (command) => sendDesktopEvent('command', { command })
  const template = [
    {
      label: 'VIGO Studio',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'Choose City', accelerator: 'CmdOrCtrl+O', click: () => sendCommand('toggleSidebar') },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Back', accelerator: 'Alt+Left', click: () => sendCommand('navigateBack') },
        { label: 'Forward', accelerator: 'Alt+Right', click: () => sendCommand('navigateForward') },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1180,
    minHeight: 760,
    show: false,
    title: 'VIGO Studio',
    icon: studioIconPath,
    ...(process.platform === 'darwin' ? {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 16, y: 19 },
    } : {}),
    backgroundColor: '#f3f4f3',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//iu.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    if (targetUrl.startsWith(`${studioOrigin}/`)) return
    event.preventDefault()
    if (/^https?:\/\//iu.test(targetUrl)) void shell.openExternal(targetUrl)
  })
  mainWindow.webContents.on('did-fail-load', (_event, code, description, targetUrl) => {
    console.error(`VIGO_STUDIO_LOAD_FAILED code=${code} url=${targetUrl} ${description}`)
  })
  mainWindow.webContents.once('did-finish-load', () => {
    console.log(`VIGO_STUDIO_READY ${studioOrigin}/`)
  })
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
    mainWindow?.focus()
  })
  mainWindow.on('closed', () => { mainWindow = null })
  void mainWindow.loadURL(`${studioOrigin}/`)
}

async function startStudio() {
  if (process.platform === 'darwin') app.dock.setIcon(studioIconPath)
  protocol.handle(studioScheme, handleStudioProtocol)
  installDesktopBridge()
  installMenu()
  await startEngine()
  createWindow()
}

const hasSingleInstance = app.requestSingleInstanceLock()
if (!hasSingleInstance) app.quit()

app.on('second-instance', () => {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
})
app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => {
  quitting = true
  failPendingRequests(new Error('VIGO Studio is closing.'))
  engine?.kill()
  engine = null
})

if (hasSingleInstance) {
  app.whenReady().then(startStudio).catch((error) => {
    dialog.showErrorBox('Unable to open VIGO Studio', error instanceof Error ? error.message : String(error))
    app.quit()
  })
}
