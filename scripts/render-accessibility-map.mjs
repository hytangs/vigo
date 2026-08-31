#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const palettes = {
  viridis: ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'],
  sunset: ['#243b53', '#35658d', '#4ea699', '#f2cf66', '#ef8354', '#d95d39'],
  rainbow: ['#5b21b6', '#2563eb', '#06b6d4', '#10b981', '#facc15', '#f97316', '#e11d48'],
}

function usage() {
  return `Usage:
  node scripts/render-accessibility-map.mjs --input=isochrone-result.json --output=map.html [options]

Options:
  --palette NAME  viridis, sunset, or rainbow (default: viridis)
  --theme NAME    light or dark (default: light)
  --title TEXT    title shown in the map panel
  --self-test     validate the renderer without writing a file
  --help          show this help

The input must be a vigo.cli.isochrone.v1 JSON result. The generated HTML
uses remote Leaflet and OpenStreetMap tiles; the VIGO surface and contours are
embedded locally in the file.`
}

function parseArguments(argv) {
  const options = {
    input: '',
    output: '',
    palette: 'viridis',
    theme: 'light',
    title: '',
    selfTest: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--help' || token === '-h') {
      options.help = true
      continue
    }
    if (token === '--self-test') {
      options.selfTest = true
      continue
    }
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`)
    const equals = token.indexOf('=')
    const name = token.slice(2, equals >= 0 ? equals : undefined)
    const value = equals >= 0
      ? token.slice(equals + 1)
      : argv[index + 1]?.startsWith('--') !== false
        ? ''
        : argv[++index]
    if (!(name in options)) throw new Error(`Unknown option: --${name}`)
    if (name === 'selfTest') throw new Error('Use --self-test.')
    options[name] = value
  }
  return options
}

function finiteNumber(value, label) {
  const number = Number(value)
  if (!Number.isFinite(number)) throw new Error(`${label} must be finite.`)
  return number
}

function coordinate(value, label) {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error(`${label} must be [longitude, latitude].`)
  }
  return value.map((item, index) => finiteNumber(item, `${label}[${index}]`))
}

function featureCollection(value, label) {
  if (!value || value.type !== 'FeatureCollection' || !Array.isArray(value.features)) {
    throw new Error(`${label} must be a GeoJSON FeatureCollection.`)
  }
  return {
    type: 'FeatureCollection',
    features: value.features.filter((feature) => feature && feature.geometry),
  }
}

function uniqueSortedNumbers(values) {
  return [...new Set(values.map(Number).filter(Number.isFinite))].sort((left, right) => left - right)
}

function normalizePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('The input must be a JSON object.')
  }
  if (payload.schemaVersion !== 'vigo.cli.isochrone.v1') {
    throw new Error(
      `Expected vigo.cli.isochrone.v1, received ${String(payload.schemaVersion ?? 'unknown')}.`,
    )
  }
  const surface = payload.surface
  if (!surface || typeof surface !== 'object') throw new Error('The result is missing surface.')
  const width = Math.floor(finiteNumber(surface.width, 'surface.width'))
  const height = Math.floor(finiteNumber(surface.height, 'surface.height'))
  if (width < 1 || height < 1 || width > 1024 || height > 1024) {
    throw new Error('surface.width and surface.height must be between 1 and 1024.')
  }
  if (!Array.isArray(surface.values) || surface.values.length !== width * height) {
    throw new Error('surface.values must contain exactly width × height cells.')
  }
  const bounds = Array.isArray(surface.bounds) && surface.bounds.length === 4
    ? surface.bounds.map((value, index) => finiteNumber(value, `surface.bounds[${index}]`))
    : []
  if (bounds.length !== 4 || bounds[0] >= bounds[2] || bounds[1] >= bounds[3]) {
    throw new Error('surface.bounds must be [west, south, east, north].')
  }
  const query = payload.query && typeof payload.query === 'object' ? payload.query : {}
  const origin = query.origin && typeof query.origin === 'object'
    ? coordinate(query.origin.coordinate, 'query.origin.coordinate')
    : null
  const cutoffs = uniqueSortedNumbers(
    Array.isArray(query.cutoffsMinutes)
      ? query.cutoffsMinutes
      : (payload.isochrones?.features ?? []).map((feature) => feature?.properties?.cutoffMinutes),
  )
  const finiteValues = surface.values
    .map((value) => Number(value))
    .filter(Number.isFinite)
  const maximumValue = finiteValues.length
    ? finiteValues.reduce((maximum, value) => Math.max(maximum, value), 0)
    : 0
  const maximumCutoff = cutoffs.at(-1) ?? maximumValue
  if (!(maximumCutoff > 0)) throw new Error('The result contains no positive travel-time cutoff.')
  const stops = (Array.isArray(payload.stops) ? payload.stops : []).flatMap((stop) => {
    if (!stop || typeof stop !== 'object' || !Array.isArray(stop.coordinate)) return []
    const durationMinutes = Number(stop.durationMinutes)
    if (!Number.isFinite(durationMinutes)) return []
    return [{
      id: String(stop.id ?? stop.stopId ?? `stop-${durationMinutes}`),
      label: String(stop.label ?? stop.stopId ?? 'Reached stop'),
      coordinate: coordinate(stop.coordinate, 'stop.coordinate'),
      durationMinutes,
    }]
  })
  return {
    schemaVersion: payload.schemaVersion,
    title: String(query.origin?.label ?? 'VIGO accessibility map'),
    origin,
    originLabel: String(query.origin?.label ?? 'Origin'),
    bounds,
    width,
    height,
    values: surface.values.map((value) => {
      const number = Number(value)
      return Number.isFinite(number) ? number : null
    }),
    maximumCutoff,
    cutoffs,
    contours: featureCollection(payload.isochrones, 'isochrones'),
    stops,
    query: {
      timeMinutes: query.timeMinutes ?? null,
      serviceDate: query.serviceDate ?? null,
      serviceDay: query.serviceDay ?? null,
      maxWalkKm: query.maxWalkKm ?? null,
      walkSpeedKph: query.walkSpeedKph ?? null,
      radiusKm: query.radiusKm ?? null,
      rasterSize: query.rasterSize ?? width,
    },
  }
}

function safeJson(value) {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029')
}

function renderHtml(model, { paletteName, theme, title }) {
  const palette = palettes[paletteName]
  const config = {
    ...model,
    title: title || model.title,
    paletteName,
    palette,
    theme,
  }
  const embedded = safeJson(config)
  return `<!doctype html>
<html lang="en" data-theme="${theme}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${config.title.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</title>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
  <style>
    :root {
      color-scheme: light;
      --ink: #172033;
      --muted: #59677a;
      --panel: rgba(255, 255, 255, .92);
      --panel-border: rgba(21, 35, 54, .14);
      --shadow: 0 18px 50px rgba(24, 40, 61, .18);
      --map-backdrop: #dfe8ee;
      --accent: #243b53;
      --line: #ffffff;
    }
    [data-theme="dark"] {
      color-scheme: dark;
      --ink: #f4f7fb;
      --muted: #bac6d4;
      --panel: rgba(18, 28, 42, .92);
      --panel-border: rgba(235, 242, 250, .15);
      --shadow: 0 18px 50px rgba(0, 0, 0, .34);
      --map-backdrop: #1d2935;
      --accent: #8ed1c7;
      --line: #182536;
    }
    * { box-sizing: border-box; }
    html, body, #map { height: 100%; margin: 0; }
    body { background: var(--map-backdrop); color: var(--ink); font: 14px/1.45 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    #map { isolation: isolate; }
    .panel { position: absolute; z-index: 1000; width: min(360px, calc(100vw - 32px)); max-height: calc(100vh - 32px); overflow: auto; top: 16px; left: 16px; padding: 18px; border: 1px solid var(--panel-border); border-radius: 20px; background: var(--panel); box-shadow: var(--shadow); backdrop-filter: blur(18px); }
    .eyebrow { margin: 0 0 5px; color: var(--muted); font-size: 11px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
    h1 { margin: 0; font-size: 23px; line-height: 1.12; letter-spacing: -.03em; }
    .lede { margin: 8px 0 15px; color: var(--muted); }
    .toolbar { display: flex; gap: 8px; margin: 0 0 14px; }
    button, select, input { font: inherit; }
    button, select { min-height: 34px; border: 1px solid var(--panel-border); border-radius: 10px; background: transparent; color: var(--ink); }
    select { flex: 1; padding: 0 9px; }
    button { padding: 0 11px; cursor: pointer; }
    button:hover, button:focus-visible, select:focus-visible, input:focus-visible { outline: 3px solid color-mix(in srgb, var(--accent) 36%, transparent); outline-offset: 2px; }
    .section { padding-top: 13px; margin-top: 13px; border-top: 1px solid var(--panel-border); }
    .section-title { margin: 0 0 8px; font-weight: 800; }
    .control { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 10px; margin: 8px 0; }
    .control label { color: var(--muted); }
    input[type="checkbox"] { width: 17px; height: 17px; accent-color: var(--accent); }
    input[type="range"] { width: 125px; accent-color: var(--accent); }
    .metadata { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; margin: 0; color: var(--muted); font-size: 12px; }
    .metadata dt { font-weight: 700; }
    .metadata dd { margin: 0; text-align: right; color: var(--ink); }
    .legend { position: absolute; z-index: 900; right: 16px; bottom: 16px; width: min(300px, calc(100vw - 32px)); padding: 14px 15px; border: 1px solid var(--panel-border); border-radius: 16px; background: var(--panel); box-shadow: var(--shadow); backdrop-filter: blur(18px); }
    .legend-title { display: flex; justify-content: space-between; gap: 12px; font-weight: 800; }
    .legend-title span:last-child { color: var(--muted); font-size: 12px; font-weight: 600; }
    .ramp { height: 10px; margin: 10px 0 4px; border-radius: 999px; }
    .ramp-labels { display: flex; justify-content: space-between; color: var(--muted); font-size: 11px; }
    .cutoff-list { display: grid; gap: 5px; margin-top: 11px; }
    .cutoff-row { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 12px; }
    .cutoff-line { width: 24px; height: 0; border-top: 3px solid; border-radius: 4px; }
    .footnote { margin: 11px 0 0; color: var(--muted); font-size: 11px; }
    .contour-label { width: auto !important; height: auto !important; margin: -10px 0 0 -18px; padding: 3px 7px; border: 1px solid var(--panel-border); border-radius: 999px; background: var(--panel); color: var(--ink); box-shadow: 0 4px 12px rgba(0, 0, 0, .16); font-size: 11px; font-weight: 800; white-space: nowrap; }
    .origin-label { width: auto !important; height: auto !important; margin: -36px 0 0 -22px; padding: 4px 8px; border: 1px solid var(--panel-border); border-radius: 999px; background: var(--accent); color: #fff; font-size: 11px; font-weight: 800; white-space: nowrap; }
    .leaflet-control-attribution { font-size: 10px; }
    @media (max-width: 680px) {
      .panel { top: 10px; left: 10px; padding: 14px; }
      .legend { right: 10px; bottom: 10px; }
      h1 { font-size: 20px; }
    }
  </style>
</head>
<body>
  <div id="map" aria-label="Interactive accessibility map"></div>
  <aside class="panel" aria-label="Map controls">
    <p class="eyebrow">VIGO · accessibility surface</p>
    <h1 id="title"></h1>
    <p class="lede">Travel time to the directed pedestrian network from one fixed departure.</p>
    <div class="toolbar">
      <select id="palette" aria-label="Color palette">
        <option value="viridis">Viridis · quantitative</option>
        <option value="sunset">Sunset · warm</option>
        <option value="rainbow">Rainbow · presentation</option>
      </select>
      <button id="theme" type="button" aria-label="Toggle light and dark map theme">Dark mode</button>
    </div>
    <div class="section">
      <p class="section-title">Layers</p>
      <div class="control"><label for="surface">Travel-time surface</label><input id="surface" type="checkbox" checked></div>
      <div class="control"><label for="contours">Cutoff contours</label><input id="contours" type="checkbox" checked></div>
      <div class="control"><label for="stops">Reached timetable stops</label><input id="stops" type="checkbox" checked></div>
      <div class="control"><label for="opacity">Surface opacity</label><input id="opacity" type="range" min="0.15" max="0.85" step="0.05" value="0.52"></div>
    </div>
    <div class="section">
      <p class="section-title">Run settings</p>
      <dl class="metadata" id="metadata"></dl>
    </div>
  </aside>
  <section class="legend" aria-label="Map legend">
    <div class="legend-title"><span>Travel time</span><span id="palette-name"></span></div>
    <div id="ramp" class="ramp"></div>
    <div class="ramp-labels"><span>0 min</span><span id="maximum-cutoff"></span></div>
    <div id="cutoff-list" class="cutoff-list"></div>
    <p class="footnote">Modeled walk + transit + walk under the retained timetable, service date, walking policy, and OSM graph.</p>
  </section>
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <script>
    const config = ${embedded};
    const root = document.documentElement;
    const map = L.map('map', { zoomControl: false, preferCanvas: true });
    L.control.zoom({ position: 'bottomleft' }).addTo(map);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);

    const [west, south, east, north] = config.bounds;
    const geoBounds = [[south, west], [north, east]];
    const contourGroup = L.layerGroup().addTo(map);
    const stopGroup = L.layerGroup().addTo(map);
    let surfaceOverlay = null;
    let currentPalette = config.palette;

    function clamp(value, minimum, maximum) {
      return Math.max(minimum, Math.min(maximum, value));
    }

    function hexRgb(hex) {
      const value = hex.replace('#', '');
      return [parseInt(value.slice(0, 2), 16), parseInt(value.slice(2, 4), 16), parseInt(value.slice(4, 6), 16)];
    }

    function samplePalette(fraction) {
      const t = clamp(fraction, 0, 1) * (currentPalette.length - 1);
      const index = Math.min(currentPalette.length - 2, Math.floor(t));
      const local = t - index;
      const left = hexRgb(currentPalette[index]);
      const right = hexRgb(currentPalette[index + 1] || currentPalette[index]);
      return left.map((channel, position) => Math.round(channel + (right[position] - channel) * local));
    }

    function rgba(fraction, alpha) {
      const [red, green, blue] = samplePalette(fraction);
      return 'rgba(' + red + ',' + green + ',' + blue + ',' + alpha + ')';
    }

    function surfaceDataUrl() {
      const canvas = document.createElement('canvas');
      canvas.width = config.width;
      canvas.height = config.height;
      const context = canvas.getContext('2d');
      for (let y = 0; y < config.height; y += 1) {
        for (let x = 0; x < config.width; x += 1) {
          const value = config.values[y * config.width + x];
          if (value === null || value > config.maximumCutoff) continue;
          context.fillStyle = rgba(value / config.maximumCutoff, 0.92);
          context.fillRect(x, y, 1, 1);
        }
      }
      return canvas.toDataURL('image/png');
    }

    function updateSurface() {
      if (surfaceOverlay) map.removeLayer(surfaceOverlay);
      surfaceOverlay = null;
      if (!document.getElementById('surface').checked) return;
      surfaceOverlay = L.imageOverlay(surfaceDataUrl(), geoBounds, {
        opacity: Number(document.getElementById('opacity').value),
        interactive: false,
      }).addTo(map);
    }

    function longestLine(feature) {
      const geometry = feature.geometry || {};
      if (geometry.type === 'LineString') return geometry.coordinates || [];
      if (geometry.type !== 'MultiLineString') return [];
      return (geometry.coordinates || []).reduce((longest, line) => line.length > longest.length ? line : longest, []);
    }

    function midpoint(feature) {
      const line = longestLine(feature);
      if (!line.length) return null;
      const point = line[Math.floor(line.length / 2)];
      return Array.isArray(point) && point.length >= 2 ? [point[1], point[0]] : null;
    }

    function updateContours() {
      contourGroup.clearLayers();
      if (!document.getElementById('contours').checked) return;
      for (const feature of config.contours.features) {
        const cutoff = Number(feature.properties && feature.properties.cutoffMinutes);
        if (!Number.isFinite(cutoff)) continue;
        const color = 'rgb(' + samplePalette(cutoff / config.maximumCutoff).join(',') + ')';
        L.geoJSON(feature, { style: { color: 'var(--line)', weight: 7, opacity: 0.9, lineCap: 'round', lineJoin: 'round' } }).addTo(contourGroup);
        const line = L.geoJSON(feature, { style: { color, weight: 3, opacity: 0.96, lineCap: 'round', lineJoin: 'round' } }).addTo(contourGroup);
        line.bindTooltip(String(cutoff) + ' min', { sticky: true, opacity: 0.94 });
        const labelPoint = midpoint(feature);
        if (labelPoint) {
          L.marker(labelPoint, {
            interactive: false,
            icon: L.divIcon({ className: 'contour-label', html: String(cutoff) + ' min' }),
          }).addTo(contourGroup);
        }
      }
    }

    function updateStops() {
      stopGroup.clearLayers();
      if (!document.getElementById('stops').checked) return;
      for (const stop of config.stops) {
        L.circleMarker([stop.coordinate[1], stop.coordinate[0]], {
          radius: 4,
          color: '#ffffff',
          weight: 1.5,
          fillColor: 'rgb(' + samplePalette(stop.durationMinutes / config.maximumCutoff).join(',') + ')',
          fillOpacity: 0.96,
        }).bindTooltip(stop.label + ' · ' + stop.durationMinutes + ' min').addTo(stopGroup);
      }
    }

    function updateLegend() {
      document.getElementById('ramp').style.background = 'linear-gradient(90deg, ' + currentPalette.join(',') + ')';
      document.getElementById('palette-name').textContent = config.paletteName;
      document.getElementById('maximum-cutoff').textContent = config.maximumCutoff + ' min';
      document.getElementById('cutoff-list').innerHTML = config.cutoffs.map((cutoff) => {
        const color = 'rgb(' + samplePalette(cutoff / config.maximumCutoff).join(',') + ')';
        return '<div class="cutoff-row"><span class="cutoff-line" style="border-color:' + color + '"></span><span>' + cutoff + ' min contour</span></div>';
      }).join('');
    }

    function updateTheme() {
      root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
      document.getElementById('theme').textContent = root.dataset.theme === 'dark' ? 'Light mode' : 'Dark mode';
    }

    function setPalette(name) {
      currentPalette = config.paletteName === name ? config.palette : ({
        viridis: ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'],
        sunset: ['#243b53', '#35658d', '#4ea699', '#f2cf66', '#ef8354', '#d95d39'],
        rainbow: ['#5b21b6', '#2563eb', '#06b6d4', '#10b981', '#facc15', '#f97316', '#e11d48'],
      }[name] || config.palette);
      config.paletteName = name;
      updateSurface();
      updateContours();
      updateStops();
      updateLegend();
    }

    document.getElementById('title').textContent = config.title;
    document.getElementById('theme').textContent = root.dataset.theme === 'dark' ? 'Light mode' : 'Dark mode';
    document.getElementById('palette').value = config.paletteName;
    document.getElementById('metadata').innerHTML = [
      ['Origin', config.originLabel],
      ['Departure', config.query.timeMinutes ?? '—'],
      ['Service date', config.query.serviceDate ?? '—'],
      ['Walking budget', config.query.maxWalkKm == null ? '—' : config.query.maxWalkKm + ' km'],
      ['Radius', config.query.radiusKm == null ? '—' : config.query.radiusKm + ' km'],
      ['Raster', config.width + ' × ' + config.height],
      ['Reached stops', String(config.stops.length)],
    ].map((row) => '<dt>' + row[0] + '</dt><dd>' + row[1] + '</dd>').join('');
    document.getElementById('palette').addEventListener('change', (event) => setPalette(event.target.value));
    document.getElementById('theme').addEventListener('click', updateTheme);
    document.getElementById('surface').addEventListener('change', updateSurface);
    document.getElementById('contours').addEventListener('change', updateContours);
    document.getElementById('stops').addEventListener('change', updateStops);
    document.getElementById('opacity').addEventListener('input', () => {
      if (surfaceOverlay) surfaceOverlay.setOpacity(Number(document.getElementById('opacity').value));
    });

    if (config.origin) {
      L.circleMarker([config.origin[1], config.origin[0]], {
        radius: 8,
        color: '#ffffff',
        weight: 3,
        fillColor: '#172033',
        fillOpacity: 1,
      }).addTo(map).bindTooltip(config.originLabel, { permanent: true, direction: 'top', className: 'origin-label', offset: [0, -5] });
    }
    map.fitBounds(geoBounds, { padding: [28, 28] });
    updateSurface();
    updateContours();
    updateStops();
    updateLegend();
  </script>
</body>
</html>
`
}

function selfTest() {
  const model = normalizePayload({
    schemaVersion: 'vigo.cli.isochrone.v1',
    query: {
      origin: { coordinate: [-71, 42], label: 'Test origin' },
      timeMinutes: 480,
      serviceDate: '2026-01-05',
      serviceDay: 'weekday',
      maxWalkKm: 1.2,
      radiusKm: 2,
      rasterSize: 2,
      cutoffsMinutes: [15, 30],
    },
    surface: {
      schemaVersion: 'vigo.street.network-raster.v1',
      width: 2,
      height: 2,
      bounds: [-71.01, 41.99, -70.99, 42.01],
      values: [0, 12, 24, null],
    },
    stops: [{ id: 'stop-1', label: 'Test stop', coordinate: [-71, 42], durationMinutes: 12 }],
    isochrones: {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: { cutoffMinutes: 15 },
        geometry: { type: 'MultiLineString', coordinates: [[[-71.005, 42], [-70.995, 42]]] },
      }],
    },
  })
  const html = renderHtml(model, { paletteName: 'viridis', theme: 'light', title: '' })
  if (!html.includes('Test origin') || !html.includes('"cutoffMinutes":15') || !html.includes('vigo.cli.isochrone.v1')) {
    throw new Error('Renderer self-test did not produce the expected map contents.')
  }
  console.log('accessibility map renderer self-test passed')
}

const options = parseArguments(process.argv.slice(2))
if (options.help) {
  console.log(usage())
} else if (options.selfTest) {
  selfTest()
} else {
  if (!options.input || !options.output) throw new Error(`Both --input and --output are required.\n\n${usage()}`)
  if (!(options.palette in palettes)) throw new Error(`Unknown palette: ${options.palette}`)
  if (!['light', 'dark'].includes(options.theme)) throw new Error(`Unknown theme: ${options.theme}`)
  const payload = JSON.parse(await fs.readFile(path.resolve(options.input), 'utf8'))
  const model = normalizePayload(payload)
  const html = renderHtml(model, {
    paletteName: options.palette,
    theme: options.theme,
    title: options.title,
  })
  const outputPath = path.resolve(options.output)
  await fs.mkdir(path.dirname(outputPath), { recursive: true })
  await fs.writeFile(outputPath, html, 'utf8')
  console.log(`wrote ${outputPath}`)
}
