import '../../src/index.css'
import '../../src/App.css'
// Lazy maps load this stylesheet after Studio's theme. Preserve that order.
import 'maplibre-gl/dist/maplibre-gl.css'
import { Map } from '../../src/app/mapRuntime'
import { addMapControls } from '../../src/app/mapControls'

document.getElementById('root').innerHTML = `
  <main class="app-shell page-project appearance-light">
    <header class="topbar"><strong>VIGO</strong><span>Map controls</span></header>
    <div class="shell-body">
      <aside class="app-sidebar"><section class="sidebar-panel"><h1>Route</h1></section></aside>
      <div class="app-frame"><div class="workbench project-workbench route-investigation-shell">
        <section class="route-surface"><div></div><div class="surface-panel route-map-shell">
          <div class="map-stage"><div id="map" class="maplibre-canvas"></div>
            <div class="map-live-card has-stop-arrivals" data-overlay="stop"><strong>Central Square</strong><small>Upcoming departures</small><p>47 · 4 min<br>1 · 8 min</p></div>
          </div>
          <div class="map-scope-control" data-overlay="network"><div class="map-scope-actions"><button>Map</button><button>Line</button></div></div>
          <div class="agency-map-context" data-overlay="agency"><div><strong>Network overview</strong><small>Scheduled service</small></div><button>Details</button></div>
        </div></section>
      </div></div>
      <aside class="routing-detail-panel" data-overlay="journey"><div class="routing-detail-scroll"><h2>Journey details</h2><p>Walk · Red Line</p></div></aside>
    </div>
  </main>`

const attribution = '<a href="https://openfreemap.org/">OpenFreeMap</a> © <a href="https://openmaptiles.org/">OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
const map = new Map({ container: 'map', center: [-71.1, 42.36], zoom: 12, attributionControl: false,
  style: { version: 8, sources: { local: { type: 'geojson', attribution, data: { type: 'FeatureCollection', features: [
    { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[-71.12, 42.35], [-71.08, 42.37]] } },
  ] } } }, layers: [
    { id: 'background', type: 'background', paint: { 'background-color': '#e5e9e4' } },
    { id: 'street', source: 'local', type: 'line', paint: { 'line-color': '#92a289', 'line-width': 6 } },
  ] } })
addMapControls(map)

function assert(condition, message) { if (!condition) throw Error(message) }
const frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
const query = selector => document.querySelector(selector)
function clickable(element, description) {
  const rect = element.getBoundingClientRect()
  assert(rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight,
    `${description} outside viewport: ${JSON.stringify(rect)}`)
  const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
  assert(element === hit || element.contains(hit), `${description} covered by ${hit?.className}`)
}
function luminance(color) {
  const channels = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => v / 255)
    .map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
}
function contrast(foreground, background) {
  const a = luminance(foreground), b = luminance(background)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}
function waitForMove(action) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Map control did not complete movement')), 5000)
    map.once('moveend', () => { clearTimeout(timer); resolve() }); action()
  })
}

window.controlsReady = new Promise(resolve => map.once('idle', () => resolve()))
window.checkControls = async () => {
  const zoomIn = query('.maplibregl-ctrl-zoom-in'), zoomOut = query('.maplibregl-ctrl-zoom-out')
  const compass = query('.maplibregl-ctrl-compass'), info = query('.maplibregl-ctrl-attrib-button')
  const start = map.getZoom()
  await waitForMove(() => zoomIn.click())
  assert(Math.abs(map.getZoom() - start - 1) < 0.01, 'Zoom in did not increase map zoom')
  await waitForMove(() => zoomOut.click())
  assert(Math.abs(map.getZoom() - start) < 0.01, 'Zoom out did not restore map zoom')
  map.jumpTo({ bearing: 60, pitch: 30 })
  await waitForMove(() => compass.click())
  assert(Math.abs(map.getBearing()) < 0.01 && Math.abs(map.getPitch()) < 0.01, 'Compass did not reset map orientation')
  const credits = query('.maplibregl-ctrl-attrib')
  if (!credits.open) info.click()
  info.click(); assert(!credits.open, 'Credits cannot collapse')
  info.click(); assert(credits.open, 'Credits cannot expand')
  assert([...credits.querySelectorAll('a')].map(link => link.href).join('|') ===
    'https://openfreemap.org/|https://openmaptiles.org/|https://www.openstreetmap.org/copyright', 'Attribution links changed')
  for (const element of [zoomIn, zoomOut, compass, info]) {
    element.focus()
    assert(document.activeElement === element, `${element.title} is not focusable`)
    assert(element.title || element.getAttribute('aria-label'), 'Control has no accessible label')
  }
  info.blur()
  return { zoom: true, orientation: true, attributionLinks: true, expandCollapse: true, keyboardFocus: true }
}
window.checkControlsLayout = async (dark, overlay) => {
  const shell = query('.app-shell')
  shell.className = `app-shell page-project appearance-${dark ? 'dark' : 'light'}${overlay === 'journey' ? ' routing-detail-open' : ''}${overlay === 'agency' ? ' view-agency agency-map-open' : ''}`
  document.documentElement.dataset.appearance = dark ? 'dark' : 'light'
  for (const element of document.querySelectorAll('[data-overlay]')) element.style.display = element.dataset.overlay === overlay ? '' : 'none'
  map.setPaintProperty('background', 'background-color', dark ? '#28332d' : '#e5e9e4')
  await frames(); map.resize(); await frames()
  for (const element of document.querySelectorAll('.maplibregl-ctrl-group button')) clickable(element, `${innerWidth}px ${overlay}: ${element.title}`)
  const info = query('.maplibregl-ctrl-attrib-button'), credits = query('.maplibregl-ctrl-attrib')
  clickable(info, `${innerWidth}px ${overlay}: attribution`)
  if (!credits.open) info.click()
  // MapLibre can collapse credits during resize. Opening <details> exposes
  // previously skipped content; let Chromium restyle its inherited theme
  // before measuring it, and finish the controls' finite color transitions.
  await frames()
  await Promise.all(query('.map-stage').getAnimations({ subtree: true })
    .filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime))
    .map(animation => animation.finished.catch(() => {})))
  const rect = credits.getBoundingClientRect(), canvas = query('.map-stage').getBoundingClientRect()
  assert(rect.left >= canvas.left && rect.right <= canvas.right + 1 && rect.height < canvas.height,
    `${innerWidth}px credits do not wrap within map: ${JSON.stringify(rect)}`)
  const style = getComputedStyle(credits), linkStyle = getComputedStyle(credits.querySelector('a'))
  const ratio = contrast(linkStyle.color, style.backgroundColor)
  assert(ratio >= 4.5, `${dark ? 'Dark' : 'Light'} attribution contrast is ${ratio} (${linkStyle.color} on ${style.backgroundColor}; ${innerWidth}px ${overlay})`)
  const group = getComputedStyle(query('.maplibregl-ctrl-group'))
  assert(group.backgroundColor === style.backgroundColor, 'Navigation lost theme background to lazy map stylesheet')
  const infoStyle = getComputedStyle(info, '::before')
  assert(infoStyle.color === linkStyle.color && infoStyle.content === '"i"', 'Info icon lost theme foreground')
  return { width: innerWidth, dark, overlay, contrast: Number(ratio.toFixed(2)), mapWidth: Math.round(canvas.width) }
}
