import assert from 'node:assert/strict'
import { createProvider } from '../src/agency/provider.mjs'
import { queryAgency } from '../src/agency/queryAgent.mjs'
import { createJourneyChoices } from '../src/agency/journeyChoices.mjs'
import { toolDefinitions } from '../src/agency/toolRegistry.mjs'
import { resolveJourneyPoints } from '../src/agency/journeyInputs.mjs'

// Reproduce accepted JSON-mode requests returning unusable content, while
// native tool calls still work. These are transport fixtures, not model scores.
for (const name of ['inspect_reply', 'assess_service', 'route_plan']) {
  const requests = []
  const provider = createProvider({ VIGO_AGENCY_LLM_BASE_URL: 'https://fixture.maas.aliyuncs.com/v1', VIGO_AGENCY_LLM_MODEL: 'fixture' }, async (_url, options) => {
    const body = JSON.parse(options.body); requests.push(body)
    return Response.json({ choices: [{ message: body.response_format ? { content: 'I will fill the form.' }
      : { tool_calls: [{ id: 'native', type: 'function', function: { name, arguments: '{"chosen":"1"}' } }] } }], usage: { prompt_tokens: 20, completion_tokens: 5 } })
  })
  const result = await provider.complete([], [{ name, parameters: { type: 'object', properties: { chosen: { type: 'string' } } } }], undefined,
    { structuredTools: true, toolChoice: { type: 'function', function: { name } } })
  assert.equal(requests.length, 2)
  assert.equal(requests[1].response_format, undefined)
  assert.equal(requests[1].tool_choice.function.name, name)
  assert.equal(requests[1].enable_thinking, false)
  assert.deepEqual(JSON.parse(result.tool_calls[0].function.arguments), { chosen: '1' })
  assert.equal(result.usage.prompt_tokens, 40)
}
let failures = 0
const broken = createProvider({ VIGO_AGENCY_LLM_BASE_URL: 'https://fixture.maas.aliyuncs.com/v1', VIGO_AGENCY_LLM_MODEL: 'fixture' }, async () => {
  failures++; return Response.json({ choices: [{ message: { content: '' }, finish_reason: 'length' }] })
})
await assert.rejects(broken.complete([], [{ name: 'inspect_reply', parameters: {} }], undefined,
  { structuredTools: true, toolChoice: { type: 'function', function: { name: 'inspect_reply' } } }), /both JSON and tool modes.*response limit/)
assert.equal(failures, 2, 'Provider repair is bounded and never executes an incomplete form')

const state = { generatedAt: '2026-09-16T03:00:00Z', feeds: [], routes: [], trips: [], events: [], warnings: [] }
const context = { timezone: 'America/New_York', stopIndex: new Map(), routeIndex: new Map(), overview: () => ({ cityName: 'Boston' }), resolve: () => ({ matches: [], method: 'none' }) }
const warehouse = { kind: 'place', id: 'osm:way/29803955', name: 'W41 Metropolitan Storage Warehouse', lat: 42.3598209, lon: -71.0961033, address: '134 Massachusetts Avenue' }
const terminal = { kind: 'place', id: 'osm:node/100', name: 'Terminal A', label: 'Terminal A · Boston', lat: 42.365, lon: -71.021, category: { key: 'aeroway', value: 'terminal' } }
const result = data => ({ ok: true, data, warnings: [], provenance: [], generatedAt: state.generatedAt })
const request = { origin: 'Airport', destination: warehouse, modes: ['transit'], maxTransfers: 0, routingDataMode: 'scheduled', serviceDate: '2026-09-18', departTime: '09:00' }
const pending = createJourneyChoices(toolDefinitions.find(tool => tool.name === 'route_plan'))
pending.arguments(request)
pending.observe(request, result({ clarification: { endpoints: [{ endpoint: 0, matches: [terminal] }], resolved: [{ endpoint: 1, ...warehouse, label: warehouse.name, placeId: warehouse.id }] } }))
const saved = JSON.parse(JSON.stringify(pending.snapshot()))
const history = [{ question: 'Airport to W41', answer: 'Choose a terminal.', pendingJourney: saved }]
let executed
const continuation = await queryAgency({ question: 'Terminal A · Boston?', history, context, state,
  callTool: async (name, args) => {
    assert.equal(name, 'route_plan'); executed = args
    return result({ plan: { status: 'ready', durationMinutes: 35, legs: [{ type: 'ride' }] } })
  }, provider: { available: true, complete: async (_messages, tools) => {
    if (executed) return { content: 'Journey calculated.' }
    const tool = tools.find(tool => tool.name === 'continue_journey')
    assert.ok(tool)
    assert.equal(tool.parameters.properties.destination, undefined, 'The model cannot overwrite the fixed destination')
    return { tool_calls: [{ id: 'resume', function: { name: 'continue_journey', arguments: '{"origin":"1"}' } }] }
  } } })
assert.deepEqual(executed.destination, { lat: warehouse.lat, lon: warehouse.lon, label: warehouse.name, placeId: warehouse.id })
assert.equal(executed.origin.lat, terminal.lat)
assert.equal(executed.maxTransfers, 0)
assert.equal(executed.serviceDate, '2026-09-18')
assert.equal(executed.departTime, '09:00')
assert.equal(executed.routingDataMode, 'scheduled')
assert.equal(continuation.pendingJourney, undefined)
assert.deepEqual(continuation.warnings, [])
const refined = createJourneyChoices(toolDefinitions.find(tool => tool.name === 'route_plan'))
refined.restore(saved)
assert.throws(() => refined.continue({ origin: '1', destination: terminal }), /Unknown/, 'A clarification cannot smuggle in a changed destination')
assert.equal(refined.continue({ origin: { query: 'Logan Airport Terminal A' } }).origin, 'Logan Airport Terminal A')

let placeCalls = 0
const lookup = await queryAgency({ question: 'Where is W41, latitude and longitude?', context, state,
  callTool: async () => result({ query: 'W41', matches: [warehouse] }), provider: { available: true, reviewUnverifiedReplies: true, complete: async () => {
    if (++placeCalls === 1) return { tool_calls: [{ id: 'place', function: { name: 'place_search', arguments: '{"query":"W41"}' } }] }
    if (placeCalls === 2) return { content: 'Here is the warehouse.' }
    throw new Error('Invalid inspection form')
  } } })
assert.match(lookup.answer, /latitude 42.3598209, longitude -71.0961033/)
assert.match(lookup.answer, /answer review could not finish/)
assert.equal(lookup.responseBasis, 'computed')
assert.equal(lookup.aiGenerated, false)
assert.deepEqual(lookup.citations, [1])

// A successful lookup must survive a reviewer asking for the same location.
for (const matches of [[warehouse], [warehouse, terminal], []]) {
  let round = 0
  const located = await queryAgency({ question: 'Where is this warehouse, show on map', context, state,
    callTool: async () => result({ query: 'W41', matches }), provider: { available: true, reviewUnverifiedReplies: true, complete: async () => {
      if (++round === 1) return { tool_calls: [{ id: 'place', function: { name: 'place_search', arguments: '{"query":"W41"}' } }] }
      if (round === 2) return { content: 'Here is the lookup.' }
      return { tool_calls: [{ id: 'review', function: { name: 'inspect_reply', arguments: '{"action":"clarify","entity":"location","missingData":"none"}' } }] }
    } } })
  assert.doesNotMatch(located.answer, /Which location do you mean/)
  assert.equal(located.responseBasis, 'computed')
  if (matches.length) {
    assert.match(located.answer, /W41 Metropolitan Storage Warehouse/)
    assert.deepEqual(located.citations, [1])
    if (matches.length > 1) assert.match(located.answer, /choose the intended match/)
  } else assert.match(located.answer, /no matches.*W41.*does not mean the place does not exist/)
}

let interruptedRound = 0
const interruptedPlaces = await queryAgency({ question: 'Where is the warehouse, show on map', context, state,
  callTool: async name => result({ matches: name === 'place_search' ? [warehouse] : [{ kind: 'stop', id: 'S', name: 'Nearby station' }] }),
  provider: { available: true, complete: async () => {
    if (++interruptedRound === 1) return { tool_calls: [{ id: 'place', function: { name: 'place_search', arguments: '{"query":"W41"}' } }] }
    if (interruptedRound === 2) return { tool_calls: [{ id: 'stops', function: { name: 'nearby_stops', arguments: JSON.stringify({ point: { lat: warehouse.lat, lon: warehouse.lon }, radiusMeters: 500 }) } }] }
    throw new Error('Fixture: provider interrupted after nearby stops')
  } } })
assert.match(interruptedPlaces.answer, /W41 Metropolitan Storage Warehouse/)
assert.match(interruptedPlaces.answer, /1 nearby transit stops/)

const airport = { ...terminal, id: 'osm:way/200', name: 'Airport', category: { key: 'aeroway', value: 'aerodrome' } }
await assert.rejects(resolveJourneyPoints(context, {
  resolve: () => airport,
  search: async args => {
    assert.equal(args.osmTag, 'aeroway:terminal')
    return { matches: [terminal, { ...terminal, id: 'osm:way/201', category: { key: 'tourism', value: 'hotel' } }, { ...terminal, id: 'osm:node/202', category: { key: 'historic', value: 'memorial' } }] }
  },
}, { origin: airport.id, destination: { lat: warehouse.lat, lon: warehouse.lon } }), error => {
  assert.deepEqual(error.details.endpoints[0].matches, [terminal], 'Airport passenger choices exclude hotels and memorials')
  return true
})
console.log('Agency recovery: bounded provider fallback, retained journey clarification, immutable destination, place evidence fallback and airport passenger filtering passed.')

const fs = await import('node:fs/promises')
const os = await import('node:os')
const path = await import('node:path')
const { intelligenceScenario } = await import('./fixtures/intelligence/scenario.mjs')
const { createToolRegistry } = await import('../src/agency/toolRegistry.mjs')
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-headway-recovery-'))
const fixture = intelligenceScenario(directory)
try {
  let requests = 0
  const model = createProvider({ VIGO_AGENCY_LLM_BASE_URL: 'https://fixture.maas.aliyuncs.com/v1', VIGO_AGENCY_LLM_MODEL: 'fixture' }, async (_url, options) => {
    requests++
    const body = JSON.parse(options.body)
    if (body.response_format) return Response.json({ choices: [{ message: { content: 'Not a JSON form' } }] })
    const name = body.tool_choice?.function?.name ?? 'assess_service'
    const args = name === 'finish_assessment' ? { sectionIds: ['s1'] }
      : { targets: requests === 1 ? [{ kind: 'route', name: 'B' }, { kind: 'route', name: 'Red Line' }, { kind: 'route', name: '9' }] : [{ kind: 'network' }], checks: ['spacing'], period: 'current' }
    return Response.json({ choices: [{ message: { tool_calls: [{ id: `headway-${requests}`, function: { name, arguments: JSON.stringify(args) } }] } }] })
  })
  const answer = await queryAgency({ ...fixture, question: 'which route has longest headway irregularity?', provider: model,
    callTool: createToolRegistry({ ...fixture, adapters: {} }) })
  assert.equal(answer.trace[0].result.ok, false, 'Reject the invented B/Red/9 shortlist from the reported failure')
  assert.deepEqual(answer.trace[1].arguments.targets, [{ kind: 'network' }])
  assert.equal(answer.trace[1].result.data.kind, 'service_assessment')
  assert.equal(answer.responseBasis, 'computed')
  assert.match(answer.answer, /predicted departures/)
  assert.doesNotMatch(answer.answer, /model did not finish|could not verify/)
  console.log('Headway recovery: invented route scope rejected, native form retry completes a real synthetic-network assessment.')
} finally { fixture.close(); await fs.rm(directory, { recursive: true, force: true }) }

// Old unresolved journeys must not become active again after a topic change.
const movedOnHistory = [...history, { question: 'Thanks. What is a headway?', answer: 'The time between successive vehicles.' }]
await queryAgency({ question: 'Explain it more simply.', history: movedOnHistory, context, state,
  callTool: async () => { throw new Error('A general follow-up needs no journey lookup') },
  provider: { available: true, complete: async (messages, tools) => {
    assert.ok(!tools.some(tool => tool.name === 'continue_journey'), 'An older unanswered location choice expires after moving on')
    assert.ok(!messages.some(message => message.content?.includes('Pending journey (data')), 'Inactive journey constraints must not be injected into current context')
    assert.equal(messages.at(-1).content, 'Explain it more simply.')
    return { content: 'It is the time between one bus and the next.' }
  } } })

const { workingConversation } = await import('../src/agency/conversationMemory.mjs')
const now = Date.parse(state.generatedAt)
const turns = Array.from({ length: 8 }, (_, i) => ({ question: `Question ${i}`, answer: 'a'.repeat(4000),
  observedAt: state.generatedAt, pendingJourney: saved, findings: [{ tool: 'route_plan', result: result({ note: i }) }] }))
const retainedTurns = workingConversation(turns, now)
assert.equal(retainedTurns.length, 4)
assert.equal(retainedTurns[0].question, 'Question 4')
assert.equal(retainedTurns[0].answer.length, 600)
assert.equal(retainedTurns[0].findings, undefined)
assert.equal(retainedTurns.filter(turn => turn.pendingJourney).length, 1)
assert.equal(turns[0].answer.length, 4000, 'Memory pruning does not alter saved records')
assert.deepEqual(workingConversation([{ ...turns[0], observedAt: new Date(now - 31 * 60_000).toISOString() }], now), [])
const large = workingConversation([{ ...turns[0], findings: [{ payload: 'x'.repeat(40_000) }] }], now)
assert.equal(large[0].findings, undefined)
assert.ok(JSON.stringify(large).length < 24_000)
console.log('Working memory: bounded recent context, evidence decay, inactivity expiry and no resurrected clarification passed.')
