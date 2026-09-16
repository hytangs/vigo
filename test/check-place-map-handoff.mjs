import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createAgencyService } from '../src/server/agency-api.mjs'
import { createNotebook } from '../src/agency/notebook.mjs'
import { createPlaceSearch } from '../src/agency/placeSearch.mjs'
import { createAgencyFixture } from './fixtures/agency.mjs'
import { loadNetworkSchedules } from '../src/app/networkSchedule.ts'

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'place-map-handoff-'))
let service
try {
  const storePath = path.join(directory, 'schedule.sqlite')
  createAgencyFixture(storePath)
  const notebook = createNotebook(directory)
  const saved = notebook.save({ title: 'Find the restaurant', answer: {
    dataPolicyVersion: 1, answer: 'A public source was found.', generatedAt: '2026-09-16T12:00:00Z',
    trace: [{ tool: 'web_search', arguments: { query: 'Fixture Restaurant' }, result: {
      ok: true, data: { matches: [{ title: 'Fixture Restaurant', url: 'https://example.org/restaurant', excerpt: '17 Market Street, City X' }] }, warnings: [], provenance: [],
    } }],
  } })
  notebook.close()
  let checked = false
  service = createAgencyService({ context: async () => ({ storePath, cityName: 'City X', agencyDirectory: directory }) }, {
    provider: { available: true, complete: async messages => {
      const context = messages.find(message => message.content?.includes('Conversation metadata'))?.content
      assert.match(context, /17 Market Street, City X/, 'The source address survives into a show-it-on-map follow-up')
      assert.match(context, /https:\/\/example.org\/restaurant/)
      checked = true
      return { content: 'The retained source has an address to geocode.' }
    } },
  })
  await service.handle('city', { action: 'ask', question: 'Show it on map', parentId: saved.id })
  assert.ok(checked)

  const feature = (id, name, house = '') => ({ type: 'Feature', properties: { osm_type: 'N', osm_id: id, name, housenumber: house, street: 'Market Street', city: 'City X' }, geometry: { type: 'Point', coordinates: [10, 20] } })
  const places = createPlaceSearch({ fetchImpl: async () => Response.json({ features: [feature(1, 'Unrelated Seafood'), feature(2, 'Another tenant', '17'), feature(3, '', '17')] }) })
  assert.deepEqual((await places.search({ query: 'Fixture Seafood City X', name: 'Fixture Seafood' })).matches, [], 'Similar-category businesses do not become matches for a named business')
  const address = await places.search({ query: '17 Market Street City X' })
  const located = address.matches.filter(match => match.addressLocation)
  assert.equal(located.length, 1, 'Deduplicate tenants at the same address')
  assert.equal(located[0].name, '17 Market Street', 'Do not label another tenant as the requested business')
  assert.equal(located[0].lat, 20)

  let active = 0, maximum = 0
  const batches = []
  await loadNetworkSchedules(Array.from({length: 11}, (_, index) => index), async request => {
    active++; maximum = Math.max(maximum, active)
    await Promise.resolve(); active--
    if (request === 3) throw new Error('Unavailable route')
    return request
  }, (results, completed, failures) => batches.push({results, completed, failures}), new AbortController().signal)
  assert.equal(maximum, 4)
  assert.equal(batches.at(-1).completed, 11)
  assert.equal(batches.at(-1).failures, 1)
  assert.equal(batches.flatMap(batch => batch.results).length, 10, 'A failed route does not hide the rest of the network')
  const abort = new AbortController()
  await loadNetworkSchedules([1,2,3,4,5], async () => { abort.abort(); return 1 }, () => assert.fail('Do not merge a stale date or City'), abort.signal)
  console.log('Place follow-up sources, unrelated business rejection, address map identity, network schedule loading and cancellation passed.')
} finally { service?.close(); await fs.rm(directory, {recursive:true, force:true}) }

const { queryAgency } = await import('../src/agency/queryAgent.mjs')
const { chooseSourceAddress } = await import('../src/agency/placeRecovery.mjs')
const sources = [{ title: 'Fixture Seafood', url: 'https://example.org/seafood', excerpt: 'Find Fixture Seafood at 17 Market Street, City X.' }]
assert.equal(await chooseSourceAddress({ complete: async () => ({ tool_calls: [{ function: { name: 'geocode_address', arguments: '{"source":1,"address":"999 Invented Street"}' } }] }) }, 'Show it', 'Fixture Seafood', sources), null, 'Reject addresses absent from the actual source')
for (const retained of [false, true]) {
  let rounds = 0
  const calls = []
  const result = data => ({ ok: true, data, warnings: [], provenance: [], generatedAt: '2026-09-16T12:00:00Z' })
  const answer = await queryAgency({ question: 'Show Fixture Seafood on map',
    context: { routeIndex: new Map(), stopIndex: new Map(), overview: () => ({ cityName: 'City X' }) },
    state: { generatedAt: '2026-09-16T12:00:00Z', feeds: [], events: [] },
    history: retained ? [{ question: 'Find the restaurant', answer: 'Found a source.', findings: [{ tool: 'web_search', arguments: {query:'Fixture Seafood'}, result: result({matches:sources}) }] }] : [],
    webStatus: { searchAvailable: true, provider: 'duckduckgo' },
    callTool: async (name, args) => {
      calls.push({name, args})
      return result(name === 'web_search' ? {matches:sources} : {matches: /17 Market/.test(args.query) ? [{kind:'place', id:'osm:node/1',name:'17 Market Street',lat:20,lon:10}] : []})
    },
    provider: { available: true, complete: async (_messages, definitions) => {
      if (definitions.some(tool => tool.name === 'geocode_address')) return {tool_calls:[{id:'address',function:{name:'geocode_address',arguments:'{"source":1,"address":"17 Market Street, City X"}'}}]}
      if (++rounds === 1) return {tool_calls:[{id:'search',function:{name:'place_search',arguments:'{"query":"Fixture Seafood City X","name":"Fixture Seafood"}'}}]}
      return {content:'Would you like me to try another approach?'}
    } },
  })
  assert.ok(calls.some(call => call.name === 'place_search' && call.args.query === '17 Market Street, City X'), 'Finish by geocoding the sourced address even when the model tries to stop early')
  assert.equal(calls.filter(call => call.name === 'web_search').length, retained ? 0 : 1)
  assert.ok(answer.trace.at(-1).result.data.matches.length)
}
console.log('Automatic web/address recovery, retained-source reuse and invented-address rejection passed.')
