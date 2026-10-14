'use strict';

// Read a public VIGO Result on this device. describePublicResult is also
// exercised by test/check-documentation.mjs, so keep its outputs stable.
function formatSeconds(value) {
  if (!Number.isFinite(value) || value < 0) return 'Unavailable';
  if (value < 60) return `${value.toLocaleString()} s`;
  const hours = Math.floor(value / 3600), minutes = Math.floor((value % 3600) / 60), seconds = Math.round(value % 60);
  if (hours) return `${hours} h ${minutes} min`;
  return seconds ? `${minutes} min ${seconds} s` : `${minutes} min`;
}

function describePublicResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Expected a JSON response object.');
  if (!['vigo.route.v1', 'vigo.matrix.v1', 'vigo.reach.v1', 'vigo.compare.v1', 'vigo.error.v1'].includes(result.schema)) {
    throw new Error('Choose a public VIGO Route, Matrix, Reach, Compare, or error response. Python exports and debug traces use different fields.');
  }
  if (!['ok', 'not_found', 'error'].includes(result.status)) throw new Error('The response has an unrecognized status.');
  const fields = [['Schema', result.schema], ['Status', result.status]];
  if (result.status === 'error') fields.push(['Error', result.error?.message || 'No error message supplied.']);
  else if (result.schema === 'vigo.route.v1') {
    if (result.status === 'ok' && !result.journey) throw new Error('An ok Route must contain a journey.');
    if (result.journey) {
      const j = result.journey;
      fields.push(['Departure', j.departureTime], ['Arrival', j.arrivalTime], ['Duration', formatSeconds(j.durationSeconds)], ['Transfers', j.transfers], ['Legs', j.legs?.length]);
      if (Array.isArray(result.alternatives)) fields.push(['Alternatives', result.alternatives.length]);
    } else fields.push(['Journey', 'No journey satisfies this request.']);
  } else if (result.schema === 'vigo.matrix.v1') {
    const rows = result.durationsSeconds;
    if (!Array.isArray(rows) || rows.some(row => !Array.isArray(row) || row.length !== rows[0].length)) throw new Error('Expected a rectangular durationsSeconds array.');
    let reachable = 0, missing = 0, minimum = Infinity, maximum = -Infinity;
    for (const row of rows) for (const value of row) {
      if (value === null) missing++;
      else if (Number.isFinite(value) && value >= 0) { reachable++; minimum = Math.min(minimum, value); maximum = Math.max(maximum, value); }
      else throw new Error('Matrix cells must be finite nonnegative seconds or null.');
    }
    fields.push(['Dimensions', `${rows.length} origins × ${rows[0]?.length || 0} destinations`], ['Reachable pairs', reachable], ['Unreachable pairs', missing]);
    if (reachable) fields.push(['Shortest duration', formatSeconds(minimum)], ['Longest duration', formatSeconds(maximum)]);
  } else if (result.schema === 'vigo.reach.v1') {
    const values = result.surface?.valuesSeconds;
    if (values !== undefined) {
      if (!Array.isArray(values) || values.some(value => value !== null && (!Number.isFinite(value) || value < 0))) throw new Error('Expected finite nonnegative surface values or null.');
      fields.push(['Raster cells', values.length], ['Reachable cells', values.filter(value => value !== null).length]);
    } else fields.push(['Surface', result.areas ? 'Map areas (raster omitted)' : 'No raster supplied']);
    if (Array.isArray(result.cutoffsSeconds)) fields.push(['Cutoffs', result.cutoffsSeconds.map(formatSeconds).join(', ')]);
  }
  else if (result.schema === 'vigo.compare.v1') {
    const counts = result.counts || {};
    const change = result.meanChangeSeconds;
    fields.push(['Comparable', counts.comparable], ['Faster', counts.faster], ['Slower', counts.slower], ['Unchanged', counts.unchanged],
      ['Newly reachable', counts.newlyReachable], ['No longer reachable', counts.noLongerReachable],
      ['Mean change', change === null || change === undefined ? 'No comparable entries' : `${change > 0 ? '+' : change < 0 ? '−' : ''}${formatSeconds(Math.abs(change))}`]);
  }
  if (result.meta?.engineVersion) fields.push(['Engine', result.meta.engineVersion]);
  if (result.warnings?.length) fields.push(['Warnings', JSON.stringify(result.warnings)]);
  if (result.quality) fields.push(['Quality', JSON.stringify(result.quality)]);
  return fields.map(([label, value]) => [label, value === undefined ? 'Unavailable' : String(value)]);
}

// Trimmed public-fixture Results for the viewer's sample buttons (generated with the engine).
const VIGO_SAMPLE_RESULTS = {"route":{"journey":{"arrivalTime":"08:22:52","boardings":1,"clockDate":"2026-07-15","departureTime":"07:50:00","durationSeconds":1972,"legs":[{"arrivalTime":"07:50:00","departureTime":"07:50:00","distanceMeters":0,"durationSeconds":0,"from":{"coordinate":[-77.05,38.9]},"quality":{"geometrySource":"unverified_transfer","streetGeometry":"unverified"},"to":{"coordinate":[-77.05,38.9],"name":"Alpha","stop":{"feed":null,"id":"A"}},"type":"walk"},{"arrivalTime":"08:10:00","departureTime":"08:00:00","directionId":"0","distanceMeters":1029,"durationSeconds":600,"fare":{"code":"missing_catalog","reason":"Fare data was not imported with this timetable.","status":"unavailable"},"from":{"coordinate":[-77.05,38.9],"name":"Alpha","stop":{"feed":null,"id":"A"}},"headsign":null,"intermediateStops":[],"quality":{"geometry":"stop_sequence","schedule":"timetable"},"route":{"color":"","id":{"feed":null,"id":"R1"},"longName":"First Route","name":"R1","shortName":"R1","type":3},"service":{"feed":null,"id":"WKD"},"serviceDate":"2026-07-15","to":{"coordinate":[-77.04,38.905],"name":"Transfer","stop":{"feed":null,"id":"X"}},"trip":{"feed":null,"id":"T1"},"tripShortName":null,"type":"transit"},{"arrivalTime":"08:22:52","departureTime":"08:10:00","distanceMeters":1029,"durationSeconds":772,"from":{"coordinate":[-77.04,38.905],"name":"Transfer","stop":{"feed":null,"id":"X"}},"quality":{"geometrySource":"osm","streetGeometry":"verified"},"to":{"coordinate":[-77.03,38.91]},"type":"walk"}],"ridingSeconds":600,"transfers":0,"waitingSeconds":600,"walkingSeconds":772},"meta":{"engineVersion":"0.5.2"},"mode":"transit","query":{"dataMode":"scheduled","destination":{"coordinate":[-77.03,38.91]},"origin":{"coordinate":[-77.05,38.9]},"requestedTime":"07:50:00","serviceDate":"2026-07-15","timePreference":"depart_at"},"schema":"vigo.route.v1","status":"ok"},"matrix":{"durationsSeconds":[[2400,null],[2400,null]],"meta":{"engineVersion":"0.5.2"},"mode":"transit","query":{"dataMode":"scheduled","destinations":[{"coordinate":[-77.03,38.91],"id":"bravo"},{"coordinate":[-77.05,38.9],"id":"alpha"}],"origins":[{"coordinate":[-77.05,38.9],"id":"alpha"},{"coordinate":[-77.04,38.905],"id":"transfer"}],"requestedTime":"07:50:00","serviceDate":"2026-07-15","timePreference":"depart_at"},"schema":"vigo.matrix.v1","status":"ok"},"reach":{"schema":"vigo.reach.v1","status":"ok","mode":"transit","query":{"dataMode":"scheduled","origin":{"coordinate":[-77.05,38.9]},"requestedTime":"07:55:00","serviceDate":"2026-07-15","timePreference":"depart_at"},"cutoffsSeconds":[600,1200,1800,2400],"meta":{"engineVersion":"0.5.2"},"surface":{"width":32,"height":32,"bounds":[-77.06731421298136,38.886525332375136,-77.03268578701864,38.91347466762486],"valuesSeconds":[null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,1299,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,1169,1252,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,1039,1085,1169,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,910,918,1002,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,780,835,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,650,668,751,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,520,584,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,390,417,501,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,260,334,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,130,167,250,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,0,0,83,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null]}}};

// Interactive tools. Everything below needs a full DOM; the documentation
// check evaluates this file with a minimal stub and only reads the functions above.
(function () {
  if (typeof document === 'undefined') return;
  const fileInput = document.querySelector('#result-file');
  if (!fileInput) return;
  const ready = typeof document.getElementById === 'function' && typeof document.createElement === 'function';
  const element = (tag, attributes = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attributes)) {
      if (key === 'class') node.className = value;
      else if (key === 'style') node.setAttribute('style', value);
      else node.setAttribute(key, value);
    }
    node.append(...children.filter(child => child !== null && child !== undefined));
    return node;
  };
  const clock = text => {
    const match = /^(\d+):(\d{2})(?::(\d{2}))?$/.exec(String(text || ''));
    return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3] || 0) : null;
  };
  const short = text => String(text || '').replace(/:00$/, '');
  const routeColor = leg => /^[0-9a-f]{6}$/i.test(leg.route?.color || '') ? '#' + leg.route.color : null;
  const place = end => end?.name || (end?.stop ? end.stop.id : end?.coordinate ? end.coordinate.map(n => Number(n).toFixed(4)).join(', ') : 'Point');

  function summary(result) {
    const list = element('dl', { class: 'result-summary' });
    for (const [label, value] of describePublicResult(result)) {
      const detail = element('dd', {}, value);
      if (label === 'Status') { detail.className = 'result-status'; detail.dataset.status = result.status; }
      list.append(element('div', {}, element('dt', {}, label), detail));
    }
    return list;
  }

  function routeVisual(result) {
    const journey = result.journey;
    if (!journey?.legs?.length) return null;
    const start = clock(journey.departureTime), end = clock(journey.arrivalTime);
    const total = Math.max(1, (end ?? 0) - (start ?? 0));
    const bar = element('div', { class: 'timeline', role: 'img', 'aria-label': `Journey from ${short(journey.departureTime)} to ${short(journey.arrivalTime)}` });
    let cursor = start;
    const legs = element('ol', { class: 'legs' });
    for (const leg of journey.legs) {
      const from = clock(leg.departureTime), to = clock(leg.arrivalTime);
      if (from !== null && cursor !== null && from > cursor) bar.append(element('span', { class: 'wait', style: `flex:${from - cursor}`, title: `Wait ${formatSeconds(from - cursor)}` }));
      const seconds = Math.max(0, (to ?? from) - (from ?? to) || 0);
      const color = routeColor(leg);
      if (seconds > 0) bar.append(element('span', { class: leg.type, style: `flex:${seconds}${color ? `;--leg:${color}` : ''}`, title: `${leg.type} ${formatSeconds(seconds)}` }));
      if (to !== null) cursor = to;
      const name = leg.type === 'transit'
        ? element('span', {}, element('span', { class: 'route-tag', style: color ? `--leg:${color}` : '' }, leg.route?.shortName || leg.route?.name || 'Ride'), `${place(leg.from)} → ${place(leg.to)}`, leg.headsign ? ` · towards ${leg.headsign}` : '')
        : element('span', {}, `${leg.type === 'walk' ? 'Walk' : 'Drive'} ${place(leg.from)} → ${place(leg.to)}`, leg.distanceMeters ? ` · ${Math.round(leg.distanceMeters).toLocaleString()} m` : '');
      legs.append(element('li', {},
        element('time', {}, `${short(leg.departureTime)}–${short(leg.arrivalTime)}`),
        element('span', { class: `dot ${leg.type}`, style: color ? `--leg:${color}` : '' }),
        name,
        element('span', { class: 'duration' }, formatSeconds(leg.durationSeconds ?? seconds))));
    }
    const axis = element('div', { class: 'timeline-axis' }, element('span', {}, short(journey.departureTime)), element('span', {}, formatSeconds(total)), element('span', {}, short(journey.arrivalTime)));
    return element('div', { class: 'visual' }, element('h3', {}, 'Journey'), bar, axis, legs);
  }

  function matrixVisual(result) {
    const rows = result.durationsSeconds;
    if (!Array.isArray(rows) || !rows.length) return null;
    const limit = 24;
    const labels = (list, n) => Array.from({ length: n }, (_, i) => list?.[i]?.id || list?.[i]?.name || String(i + 1));
    const origins = labels(result.query?.origins, rows.length), destinations = labels(result.query?.destinations, rows[0].length);
    const values = rows.flat().filter(value => value !== null);
    const minimum = Math.min(...values), maximum = Math.max(...values);
    const table = element('table', { class: 'heat' });
    const head = element('tr', {}, element('th', { scope: 'col' }, element('span', { class: 'sr-only' }, 'Origin')));
    destinations.slice(0, limit).forEach(label => head.append(element('th', { scope: 'col' }, label)));
    table.append(element('thead', {}, head));
    const body = element('tbody');
    rows.slice(0, limit).forEach((row, i) => {
      const line = element('tr', {}, element('th', { scope: 'row' }, origins[i]));
      row.slice(0, limit).forEach(value => {
        if (value === null) { line.append(element('td', { class: 'unreachable', title: 'Unreachable' }, '—')); return; }
        const share = maximum > minimum ? (value - minimum) / (maximum - minimum) : 0.5;
        line.append(element('td', { style: `background:color-mix(in srgb, var(--lime) ${Math.round(14 + share * 62)}%, transparent)`, title: `${value.toLocaleString()} s` }, formatSeconds(value)));
      });
      body.append(line);
    });
    table.append(body);
    const note = rows.length > limit || rows[0].length > limit ? element('p', { class: 'timeline-axis' }, `Showing the first ${limit} rows and columns.`) : null;
    return element('div', { class: 'visual' }, element('h3', {}, 'Travel times'), element('div', { class: 'table-wrap' }, table), note);
  }

  const bands = ['#3f6a2e', '#6c9733', '#a2bf45', '#cddc86', '#e9f0c8', '#f4f7e4'];
  function reachVisual(result) {
    const surface = result.surface;
    if (!surface?.valuesSeconds || !surface.width || !surface.height) {
      if (result.areas?.features) return element('div', { class: 'visual' }, element('h3', {}, 'Map areas'), element('p', {}, `${result.areas.features.length} area features; map output carries no raster.`));
      return null;
    }
    const cutoffs = [...(result.cutoffsSeconds || [])].sort((a, b) => a - b);
    const canvas = element('canvas', { width: String(surface.width), height: String(surface.height), role: 'img', 'aria-label': 'Reachable cells by cutoff, north at the top' });
    const context = canvas.getContext?.('2d');
    if (context) {
      surface.valuesSeconds.forEach((value, index) => {
        if (value === null) return;
        const band = cutoffs.findIndex(cutoff => value <= cutoff);
        context.fillStyle = band === -1 ? '#c9ced3' : bands[Math.min(band, bands.length - 1)];
        context.fillRect(index % surface.width, Math.floor(index / surface.width), 1, 1);
      });
    }
    const legend = element('ul', { class: 'legend' });
    cutoffs.forEach((cutoff, band) => legend.append(element('li', {}, element('i', { style: `background:${bands[Math.min(band, bands.length - 1)]}` }), `Within ${formatSeconds(cutoff)}`)));
    legend.append(element('li', {}, element('i', { style: 'background:#c9ced3' }), 'Beyond the last cutoff'));
    legend.append(element('li', {}, element('i', { style: 'border:1px solid var(--border-strong)' }), 'Unreached (null)'));
    const reached = surface.valuesSeconds.filter(value => value !== null).length;
    legend.append(element('li', {}, `${reached.toLocaleString()} of ${surface.valuesSeconds.length.toLocaleString()} cells reached · ${surface.width} × ${surface.height}`));
    return element('div', { class: 'visual raster' }, canvas, element('div', {}, element('h3', {}, 'Reach surface'), legend));
  }

  function visual(result) {
    if (result.status === 'error') return null;
    if (result.schema === 'vigo.route.v1') return routeVisual(result);
    if (result.schema === 'vigo.matrix.v1') return matrixVisual(result);
    if (result.schema === 'vigo.reach.v1') return reachVisual(result);
    return null;
  }

  function render(target, visualTarget, result) {
    target.replaceChildren(summary(result));
    const drawing = visual(result);
    if (result.status === 'error' && result.error?.message) target.append(element('p', { class: 'result-error' }, result.error.message));
    visualTarget.replaceChildren(...(drawing ? [drawing] : []));
  }

  const answer = document.querySelector('#result-answer');
  const raw = document.querySelector('#result-raw');
  const visualTarget = document.querySelector('#result-visual');
  let resultRead = 0;
  async function open(file) {
    const request = ++resultRead;
    if (!file) { answer.textContent = 'No Result open yet.'; return; }
    try {
      if (file.size > 25 * 1024 * 1024) throw new Error('Choose a file no larger than 25 MiB.');
      const contents = await file.text();
      if (request !== resultRead) return;
      show(JSON.parse(contents), contents);
    } catch (error) {
      if (request !== resultRead) return;
      answer.replaceChildren(element('p', { class: 'result-error' }, error.message));
      visualTarget.replaceChildren();
      raw.textContent = 'No file selected.';
    }
  }
  function show(result, contents) {
    render(answer, visualTarget, result);
    raw.textContent = contents.length > 400000 ? contents.slice(0, 400000) + '\n…' : contents;
  }
  fileInput.addEventListener('change', () => open(fileInput.files[0]));
  if (!ready) return;

  const drop = document.getElementById('result-drop');
  for (const name of ['dragenter', 'dragover']) drop.addEventListener(name, event => { event.preventDefault(); drop.classList.add('dragging'); });
  for (const name of ['dragleave', 'drop']) drop.addEventListener(name, () => drop.classList.remove('dragging'));
  drop.addEventListener('drop', event => { event.preventDefault(); open(event.dataTransfer?.files?.[0]); });
  for (const button of document.querySelectorAll('[data-sample]')) {
    button.addEventListener('click', () => {
      resultRead++;
      const sample = VIGO_SAMPLE_RESULTS[button.dataset.sample];
      show(sample, JSON.stringify(sample, null, 2));
      answer.prepend(element('p', { class: 'timeline-axis' }, 'Trimmed sample from VIGO’s public synthetic test fixture (stops A → X → B).'));
    });
  }

  // API console: active only when this page is served by `vigo serve`.
  const consoleRoot = document.getElementById('api-console');
  if (!consoleRoot) return;
  const state = document.getElementById('console-state');
  const form = document.getElementById('console-form');
  const endpoint = document.getElementById('console-endpoint');
  const token = document.getElementById('console-token');
  const body = document.getElementById('console-body');
  const timing = document.getElementById('console-timing');
  const consoleAnswer = document.getElementById('console-answer');
  const consoleRaw = document.getElementById('console-raw');
  const rawWrap = document.getElementById('console-raw-wrap');
  const consoleVisual = element('div', { class: 'console-visual' });
  consoleAnswer.after(consoleVisual);
  const boston = { serviceDate: '2026-10-05', time: '08:00' };
  const harvard = { coordinate: [-71.11902, 42.37334] }, southStation = { coordinate: [-71.05524, 42.35227] };
  const examples = {
    'POST /v1/route': { origin: harvard, destination: southStation, ...boston, maxWalkKm: 1.2, maxTransfers: 3, requireTransitRide: true },
    'POST /v1/matrix': { origins: [{ id: 'harvard', ...harvard }, { id: 'kendall', coordinate: [-71.08618, 42.36249] }], destinations: [{ id: 'south-station', ...southStation }, { id: 'copley', coordinate: [-71.07758, 42.34997] }], ...boston, maxWalkKm: 1.2 },
    'POST /v1/reach': { origin: harvard, ...boston, cutoffsMinutes: [15, 30, 45], extentRadiusKm: 6, rasterSize: 48 },
    'POST /v1/compare': { before: 'Paste a saved Reach Result here', after: 'Paste a second Reach Result on the same grid' },
    'POST /v1/native': { operation: 'timetable.identifiers', serviceDate: boston.serviceDate },
  };
  function example() {
    const value = examples[endpoint.value];
    body.value = value ? JSON.stringify(value, null, 2) : '';
    body.disabled = !value;
    body.placeholder = value ? '' : 'GET requests have no body.';
  }
  endpoint.addEventListener('change', example);
  body.addEventListener('keydown', event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); form.requestSubmit(); } });
  document.getElementById('console-example').addEventListener('click', example);
  example();
  function offline(reason) {
    state.replaceChildren(element('span', { class: 'console-offline' },
      reason, ' Start the engine with ', element('code', {}, 'vigo serve --city ./boston'), ' and open ', element('code', {}, 'http://127.0.0.1:8080/'),
      ' to send requests from this page. Requests go only to the service that served it.'));
  }
  // Probe only when the HTTP API page is open, so other pages make no requests.
  let probed = false;
  function probe() {
    if (probed || consoleRoot.closest('.doc-page')?.hidden) return;
    probed = true;
    if (!/^https?:$/.test(location.protocol)) { offline('This copy of the guide is not served by a VIGO engine.'); return; }
    fetch('/healthz', { cache: 'no-store', headers: { Accept: 'application/json' } })
      .then(response => response.ok ? response.json() : Promise.reject(new Error(String(response.status))))
      .then(health => {
        if (health?.runtime !== 'rust' || !health.status) throw new Error('not a VIGO engine');
        state.textContent = `Connected to the VIGO ${health.version || ''} engine at ${location.host} (${health.status}). Query endpoints need a token only when VIGO_API_TOKEN is set.`;
        form.hidden = false;
      })
      .catch(() => offline('No VIGO engine answered at this address.'));
  }
  window.addEventListener('hashchange', () => setTimeout(probe));
  setTimeout(probe);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const [method, path] = endpoint.value.split(' ');
    const headers = { Accept: 'application/json' };
    let payload;
    if (method === 'POST') {
      try { payload = JSON.stringify(JSON.parse(body.value)); }
      catch (error) { consoleAnswer.replaceChildren(element('p', { class: 'result-error' }, 'The request body is not valid JSON: ' + error.message)); return; }
      headers['Content-Type'] = 'application/json';
    }
    if (token.value.trim()) headers.Authorization = 'Bearer ' + token.value.trim();
    consoleAnswer.replaceChildren(element('p', { class: 'timeline-axis' }, `Sending ${method} ${path}…`));
    consoleVisual.replaceChildren();
    const started = performance.now();
    try {
      const response = await fetch(path, { method, headers, body: payload, cache: 'no-store' });
      const text = await response.text();
      const elapsed = Math.round(performance.now() - started);
      const server = response.headers.get('Server-Timing');
      timing.textContent = `HTTP ${response.status} · ${elapsed} ms in this browser${server ? ' · Server-Timing: ' + server : ''}`;
      rawWrap.hidden = false;
      let parsed;
      try { parsed = JSON.parse(text); } catch { parsed = null; }
      consoleRaw.textContent = parsed ? JSON.stringify(parsed, null, 2).slice(0, 400000) : text.slice(0, 400000);
      if (parsed && ['vigo.route.v1', 'vigo.matrix.v1', 'vigo.reach.v1', 'vigo.compare.v1', 'vigo.error.v1'].includes(parsed.schema)) render(consoleAnswer, consoleVisual, parsed);
      else if (!response.ok) consoleAnswer.replaceChildren(element('p', { class: 'result-error' }, parsed?.error?.message || `The service answered HTTP ${response.status}.`));
      else consoleAnswer.replaceChildren(element('p', {}, 'Response received. The full JSON is below.'));
    } catch (error) {
      timing.textContent = '';
      consoleAnswer.replaceChildren(element('p', { class: 'result-error' }, 'The request did not complete: ' + error.message));
    }
  });
})();
