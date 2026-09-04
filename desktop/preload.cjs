const { contextBridge, ipcRenderer } = require('electron')

let sequence = 0
const subscriptions = new Map()

contextBridge.exposeInMainWorld('vigoDesktop', {
  postMessage(message) {
    ipcRenderer.send('vigo-desktop-message', message)
  },
  subscribe(eventName, listener) {
    if (typeof eventName !== 'string' || typeof listener !== 'function') return 0
    const id = ++sequence
    const handler = (_event, receivedName, detail) => {
      if (receivedName === eventName) listener(detail)
    }
    subscriptions.set(id, handler)
    ipcRenderer.on('vigo-desktop-event', handler)
    return id
  },
  unsubscribe(id) {
    const handler = subscriptions.get(id)
    if (!handler) return
    subscriptions.delete(id)
    ipcRenderer.removeListener('vigo-desktop-event', handler)
  },
})

const desktopPlatform = process.platform === 'darwin' ? 'macos' : process.platform
const applyDesktopPlatform = () => {
  document.documentElement?.setAttribute('data-vigo-desktop', desktopPlatform)
}

if (document.documentElement) applyDesktopPlatform()
else window.addEventListener('DOMContentLoaded', applyDesktopPlatform, { once: true })

window.addEventListener('keydown', (event) => {
  const key = String(event.key || '').toLowerCase()
  if ((event.metaKey || event.ctrlKey) && key === 'r') {
    event.preventDefault()
    event.stopImmediatePropagation()
  }
}, true)
