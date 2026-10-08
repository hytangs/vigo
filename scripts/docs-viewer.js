'use strict';

function describePublicResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Expected a JSON response object.');
  if (!['vigo.route.v1', 'vigo.matrix.v1', 'vigo.reach.v1', 'vigo.error.v1'].includes(result.schema)) {
    throw new Error('Choose a public VIGO Route, Matrix, Reach, or error response. Python exports and debug traces use different fields.');
  }
  if (!['ok', 'not_found', 'error'].includes(result.status)) throw new Error('The response has an unrecognized status.');
  const fields = [['Schema', result.schema], ['Status', result.status]];
  const seconds = value => Number.isFinite(value) && value >= 0 ? `${value.toLocaleString()} s` : 'Unavailable';
  if (result.status === 'error') fields.push(['Error', result.error?.message || 'No error message supplied.']);
  else if (result.schema === 'vigo.route.v1') {
    if (result.status === 'ok' && !result.journey) throw new Error('An ok Route must contain a journey.');
    if (result.journey) {
      const j = result.journey;
      fields.push(['Departure', j.departureTime], ['Arrival', j.arrivalTime], ['Duration', seconds(j.durationSeconds)], ['Transfers', j.transfers], ['Legs', j.legs?.length]);
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
    if (reachable) fields.push(['Shortest duration', seconds(minimum)], ['Longest duration', seconds(maximum)]);
  } else if (result.schema === 'vigo.reach.v1') {
    const values = result.surface?.valuesSeconds;
    if (values !== undefined) {
      if (!Array.isArray(values) || values.some(value => value !== null && (!Number.isFinite(value) || value < 0))) throw new Error('Expected finite nonnegative surface values or null.');
      fields.push(['Raster cells', values.length], ['Reachable cells', values.filter(value => value !== null).length]);
    } else fields.push(['Surface', result.areas ? 'Map areas (raster omitted)' : 'No raster supplied']);
    if (Array.isArray(result.cutoffsSeconds)) fields.push(['Cutoffs', result.cutoffsSeconds.map(seconds).join(', ')]);
  }
  if (result.meta?.engineVersion) fields.push(['Engine', result.meta.engineVersion]);
  if (result.warnings?.length) fields.push(['Warnings', JSON.stringify(result.warnings)]);
  if (result.quality) fields.push(['Quality', JSON.stringify(result.quality)]);
  return fields.map(([label, value]) => [label, value === undefined ? 'Unavailable' : String(value)]);
}

const resultFile = document.querySelector('#result-file');
let resultRead = 0;
resultFile.addEventListener('change', async () => {
  const request = ++resultRead;
  const answer = document.querySelector('#result-answer');
  const raw = document.querySelector('#result-raw');
  answer.replaceChildren(); raw.textContent = 'No file selected.';
  const file = resultFile.files[0];
  if (!file) { answer.textContent = 'Your file stays on this device.'; return; }
  try {
    if (file.size > 25 * 1024 * 1024) throw new Error('Choose a file no larger than 25 MiB.');
    const contents = await file.text();
    if (request !== resultRead) return;
    const result = JSON.parse(contents);
    const fields = describePublicResult(result);
    const list = document.createElement('dl');
    for (const [label, value] of fields) {
      const term = document.createElement('dt'); term.textContent = label;
      const detail = document.createElement('dd'); detail.textContent = value;
      list.append(term, detail);
    }
    answer.append(list);
    raw.textContent = contents;
  } catch (error) { if (request === resultRead) answer.textContent = error.message; }
});
