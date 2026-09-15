// A compact index lets the model choose specialist schemas without loading
// every journey/SQL parameter for ordinary conversation. Selection is the
// model's decision, never a keyword classifier over the user's question.
const descriptions = {
  inspect_service: 'Test hypotheses using surrounding service, prediction progression, vehicle agreement, alerts and historical evidence',
  historical_runtime: 'LAMP running-time study and chronological prediction accuracy',
  run_runtime_study: 'Run an explicitly requested LAMP historical study for past dates',
  compare_holding: 'Compare alternatives in an opened synthetic Operations replay; no live dispatch',
  operational_context: 'Approved City context explicitly marked public; private SOPs stay in Operations',
  historical_baseline: 'Comparable historical prediction summaries and chronological evaluation',
  runtime_status: 'Server-recorded model connection and privacy limits',
  network_overview: 'Computed network diagnosis, all-service coverage, shared corridor patterns and counts',
  recall_notebook: 'Saved conversation excerpts; private staff annotations are excluded',
  resolve_entities: 'GTFS stops and routes by name',
  place_search: 'Business and address coordinates',
  nearby_stops: 'Stops and scheduled routes near verified place coordinates',
  walk_compare: 'Compare candidate walking distances and test distance requirements in a batch',
  walk_route: 'Walking distance and time, including ordered visits',
  service_profile: 'Scheduled trip starts by hour on a date',
  stop_arrivals: 'Station times for all routes or a specified vehicle, with separate schedules and predictions',
  gtfs_query: 'Read-only SQL against indexed transit tables',
  route_plan: 'Transit journeys with arrival deadlines and constraints',
  reach: 'Places reachable within a travel-time budget',
  realtime_status: 'Current vehicle, trip and route reports',
  anomaly_scan: 'Schedule deviations and service findings',
  service_alerts: 'Full agency alert explanations and causes',
  draft_rider_message: 'Rider copy from operational evidence',
}

// Common requests must not spend a model round loading their own schema.
const readyTools = new Set(['inspect_service', 'network_overview', 'resolve_entities', 'place_search', 'nearby_stops', 'realtime_status', 'route_plan', 'runtime_status', 'service_profile', 'stop_arrivals'])

export function discoverableTools(available, retainedNames = []) {
  const index = available.filter(tool => descriptions[tool.name] && !readyTools.has(tool.name))
  const active = new Set(available.filter(tool => !descriptions[tool.name] || readyTools.has(tool.name) || retainedNames.includes(tool.name)).map(tool => tool.name))
  const discovery = { name: 'prepare_tools', description: `Load specialist tools when needed, then use their supplied schemas. Routing tools resolve names directly. Available: ${index.map(tool => `${tool.name}: ${descriptions[tool.name]}`).join('; ')}.`,
    parameters: { type: 'object', properties: { names: { type: 'array', items: { type: 'string', enum: index.map(tool => tool.name) }, minItems: 1, maxItems: 4 } }, required: ['names'], additionalProperties: false } }
  return {
    definitions: () => [...available.filter(tool => active.has(tool.name)), ...(index.length ? [discovery] : [])],
    prepare(input) {
      if (!input || Object.keys(input).some(key => key !== 'names') || !Array.isArray(input.names) || input.names.length < 1 || input.names.length > 4 || input.names.some(name => !available.some(tool => tool.name === name))) throw new Error('Choose one to four tools from the available catalogue.')
      for (const name of input.names) active.add(name)
      return { available: input.names, nextStep: 'Use the tools now available. Preparing tools has not queried any data.' }
    },
  }
}
