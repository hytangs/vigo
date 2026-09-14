import { publicCliCommands, supportedReachRasterSizes } from '../capabilities.mjs'

// Help and validation share these definitions. Computation stays in the engines.
export const options = {
  city: ['PATH', 'Complete VIGO City directory'],
  gtfs: ['PATH', 'GTFS ZIP; repeat for multiple sources', 'repeat'],
  'gtfs-scope': ['VALUE', 'Unique source scope; one per --gtfs', 'repeat'],
  osm: ['PATH', 'OSM .pbf covering the City'],
  'private-access': ['VALUE', 'public (default) or endpoints for authorized access'],
  output: ['PATH', 'Save the result; JSON is also printed (use - for stdout only)'],
  replace: ['', 'Replace an existing City', 'boolean'],
  input: ['PATH', 'Route CSV with origin/destination coordinates or stop IDs'],
  request: ['PATH', 'JSON request file; - reads standard input'],
  mode: ['VALUE', 'transit (default), walk, or drive; Reach supports transit only'],
  time: ['HH:MM', 'Local service time, 00:00–29:59 (default: 08:00)'],
  'time-preference': ['VALUE', 'depart (default) or arrive; Reach supports depart only'],
  objective: ['VALUE', 'earliest_arrival'],
  'departure-window': ['MIN', 'Centered departure profile, ±0–30 integral minutes; Route only'],
  'service-day': ['VALUE', 'weekday, saturday, or sunday; must agree with the date'],
  'service-date': ['YYYY-MM-DD', 'Required exact service date in the City timezone'],
  'max-walk': ['KM', 'Physical walking budget (default: 1.2)'],
  'max-transfers': ['N', 'Maximum transit changes, 0–31 (default: unrestricted)'],
  horizon: ['MIN', 'Transit search horizon, 1–2880 (default: 480)'],
  cutoffs: ['MINUTES', 'Reach limits, comma-separated, 5–240 (default: 15,30,45,60)'],
  'extent-radius': ['KM', 'Reach computation radius, 1–40 (default: 8)'],
  'raster-size': ['N', `Reach grid: ${supportedReachRasterSizes.join(', ')} (default: 96)`],
  'walk-speed': ['KPH', 'Reach walking speed, 1–8 (default: 4.8)'],
  before: ['PATH', 'Saved result before a change'],
  after: ['PATH', 'Saved result after a change'],
  help: ['', 'Show help for this command', 'flag'],
  version: ['', 'Print the VIGO version', 'flag'],
  // Private worker arguments are validated but excluded from public help.
  'city-name': ['VALUE', ''],
  'osm-pbf': ['PATH', ''],
  'output-store': ['PATH', ''],
  'street-store': ['PATH', ''],
}

const queryOptions = ['city', 'request', 'output', 'mode', 'time', 'time-preference', 'objective',
  'service-date', 'service-day', 'max-walk', 'max-transfers', 'horizon', 'departure-window']
export const commands = {
  build: {
    summary: 'Compile GTFS and OSM into a reusable City.',
    usage: ['--gtfs feed.zip --osm region.osm.pbf --output ./city [--replace]'],
    options: ['gtfs', 'gtfs-scope', 'osm', 'output', 'private-access', 'replace'],
    notes: ['--output is the City directory. Existing Cities require --replace.',
      'Progress goes to stderr; the completed City manifest goes to stdout.'],
  },
  capabilities: {
    summary: 'List versions and supported query combinations as JSON.',
    usage: [''], options: [],
  },
  inspect: {
    summary: 'Inspect a City’s identity, data sources, and counts.',
    usage: ['--city ./city [--output result.json]'], options: ['city', 'output'],
  },
  route: {
    summary: 'Find a journey or run a batch of transit journeys.',
    usage: ['--city ./city --request route.json --service-date YYYY-MM-DD [options]',
      '--city ./city --input trips.csv --output routes.csv --service-date YYYY-MM-DD [options]'],
    options: [...queryOptions, 'input'],
    notes: ['Request: {"origin":"STOP_A","destination":"STOP_B"}',
      'Points: exact stop ID, {"stopId":"..."}, or {"coordinate":[longitude,latitude]}.',
      'Optional ordered stops: {"origin":"A","waypoints":["X"],"destination":"B"}.',
      'CSV columns: id, origin_lon, origin_lat, destination_lon, destination_lat.',
      'Or use origin_stop_id and destination_stop_id. Names: origin_name, destination_name.',
      'CSV batches support transit and require an output file; their JSON summary goes to stdout.'],
  },
  matrix: {
    summary: 'Compute travel times for every supplied origin/destination pair.',
    usage: ['--city ./city --request matrix.json --service-date YYYY-MM-DD [options]'],
    options: queryOptions,
    notes: ['Request: {"origins":[{"id":"a","point":"A"}],"destinations":[{"id":"b","point":"B"}]}',
      'Points can also use {"coordinate":[longitude,latitude]}. Departure windows are unsupported.'],
  },
  reach: {
    summary: 'Compute a transit travel-time surface and contours.',
    usage: ['--city ./city --request reach.json --service-date YYYY-MM-DD [options]'],
    options: [...queryOptions.filter(name => name !== 'horizon'), 'cutoffs', 'extent-radius', 'raster-size', 'walk-speed'],
    notes: ['Request: {"origin":"STOP_A","cutoffsMinutes":[15,30,45]}',
      'Uses fixed departures and transit with walking access. Departure windows are unsupported.'],
  },
  compare: {
    summary: 'Compare two saved results without rerunning the engine.',
    usage: ['--before before.json --after after.json [--output change.json]'],
    options: ['before', 'after', 'output'],
    notes: ['Both results must be from the same query family. Reach results must use the same grid.'],
  },
  '_build-city': { options: ['gtfs', 'gtfs-scope', 'osm', 'private-access', 'output', 'city-name'] },
  '_build-osm-store': { options: ['osm-pbf', 'output-store'] },
  '_prepare-osm-drive': { options: ['street-store'] },
  '_route-stream': { options: queryOptions },
}

export function usage(version, command = '') {
  if (!command) return [
    `VIGO ${version}`, '', 'Build a City. Query its timetable and street network.', '', 'Commands:',
    ...publicCliCommands.map(name => `  ${`vigo ${name}`.padEnd(22)}${commands[name].summary}`),
    '', 'Start here:', '  vigo build --gtfs feed.zip --osm region.osm.pbf --output ./city',
    '  vigo inspect --city ./city',
    '  vigo route --city ./city --request route.json --service-date YYYY-MM-DD',
    '', 'Help:', '  vigo help COMMAND    Command options and request examples',
    '  vigo COMMAND -h      Same as --help', '  vigo --version       Same as -V',
    '', 'JSON goes to stdout; diagnostics go to stderr. Use --request - for piped JSON.',
    'Exit 0: result produced (including blocked results). Exit 2: invalid input or failure.', '',
  ].join('\n')
  const definition = commands[command]
  if (!definition?.usage) throw new Error(`No public help for ${command}`)
  return [
    `VIGO ${version} · ${command}`, '', definition.summary, '', 'Usage:',
    ...definition.usage.map(example => `  vigo ${command}${example ? ` ${example}` : ''}`), '', 'Options:',
    ...[...definition.options.filter(name => name !== 'departure-window' || command === 'route'), 'help', 'version'].map(name => {
      const [placeholder, description] = options[name]
      const label = `--${name}${placeholder ? ` ${placeholder}` : ''}`
      const explanation = name === 'output' && command === 'build' ? 'City output directory'
        : name === 'mode' ? command === 'reach' ? 'transit (walking access and egress)' : 'transit (default), walk, or drive'
          : name === 'time-preference' ? command === 'reach' ? 'depart (fixed departure)' : 'depart (default) or arrive'
            : description
      return `  ${label.padEnd(28)}${explanation}`
    }),
    ...(definition.notes ? ['', ...definition.notes] : []),
    '', 'Options accept --name value or --name=value. Coordinates are [longitude, latitude].', '',
  ].join('\n')
}
