import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { intelligenceScenario } from '../test/fixtures/intelligence/scenario.mjs'
import { createProvider } from '../src/agency/provider.mjs'
import { createToolRegistry } from '../src/agency/toolRegistry.mjs'
import { queryAgency } from '../src/agency/queryAgent.mjs'
import { deriveOperationalState } from '../src/agency/realtimeIntelligence.mjs'

// Opt-in actual-model evaluation; never runs during release/unit checks.
// The output is a review record, not a self-awarded intelligence score.
const args = process.argv.slice(2)
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined
const output = option('--output')
if (!output) throw Error('Supply --output <new JSONL file> and VIGO_AGENCY_LLM_* environment settings.')
const provider = createProvider()
if (!provider.available) throw Error('Configure an actual model endpoint; this evaluation does not substitute mock answers.')
const ids = option('--ids')?.split(',').map(Number)
const corpus = JSON.parse(await fs.readFile(option('--corpus') || new URL('../test/fixtures/intelligence/questions.json', import.meta.url), 'utf8'))
if (new Set(corpus.map(row => row.id)).size !== corpus.length) throw Error('Question IDs must be unique.')
if (ids?.some(id => !corpus.some(row => row.id === id))) throw Error('Choose question IDs from the evaluation corpus.')
const questions = corpus.filter(row => !ids || ids.includes(row.id))
for (const item of questions) {
  if (item.follows && !questions.slice(0, questions.indexOf(item)).some(row => row.id === item.follows)) throw Error(`Question ${item.id} needs its earlier conversation turn ${item.follows}.`)
  if (item.variant && item.variant !== 'stale') throw Error(`Unknown observation variant: ${item.variant}`)
}
const file = await fs.open(output, 'wx')
let directory, fixture
try {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-intelligence-'))
  fixture = intelligenceScenario(directory)
  const status = provider.status()
  await file.write(`${JSON.stringify({ type: 'run', startedAt: new Date().toISOString(), revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()),
    model: status.model, protocol: status.protocol, contextTokens: status.contextTokens, reasoningEffort: status.reasoningEffort, temperature: status.temperature,
    scenario: 'Synthetic evaluation network; not Boston observations. Frozen at 08:00 EDT, September 14. Missing APC, crew, maintenance, fleet, dispatch and historical outcome data are deliberate.', selection: fixture.selection, questions: questions.length, questionIds: questions.map(item => item.id) })}\n`)
  const conversations = new Map()
  let answered = 0, interrupted = false
  for (const item of questions) {
    const signal = AbortSignal.timeout(180_000)
    const snapshot = item.variant === 'stale' ? { ...fixture.snapshot, feeds: fixture.snapshot.feeds.map(feed => ({ ...feed, feedTimestamp: feed.feedTimestamp - 600 })) } : fixture.snapshot
    const state = item.variant === 'stale' ? deriveOperationalState(fixture.context, snapshot, Date.parse(fixture.state.generatedAt) / 1000) : fixture.state
    const history = conversations.get(item.follows) || []
    const callTool = createToolRegistry({ ...fixture, state, snapshot, signal, adapters: {} })
    let result
    try { result = await queryAgency({ ...fixture, state, history, question: item.question, callTool, provider: provider.forRequest(), signal, placesAvailable: false }) }
    catch (error) { result = { error: error.message } }
    conversations.set(item.id, [...history, { question: item.question, answer: result.answer || '', observedAt: result.generatedAt,
      findings: (result.trace || []).filter(call => call.result.ok), requests: (result.trace || []).map(({ tool, arguments: args }) => ({ tool, arguments: args })) }])
    await file.write(`${JSON.stringify({ recordType: 'answer', ...item, result })}\n`)
    answered++
    console.log(JSON.stringify({ id: item.id, seconds: Math.round((result.timing?.totalMs || 0) / 1000), calls: result.trace?.map(call => `${call.tool}:${call.result.ok}`), warnings: result.warnings }))
    if (result.warnings?.some(warning => warning.includes('HTTP 429')) || result.error?.includes('HTTP 429')) {
      interrupted = true
      break // Preserve completed evidence; do not hammer a rate-limited provider.
    }
  }
  await file.write(`${JSON.stringify({ recordType: interrupted ? 'interrupted' : 'complete', finishedAt: new Date().toISOString(), answered,
    ...(interrupted ? { reason: 'Provider rate limited; remaining questions were not attempted.' } : {}) })}\n`)
} finally {
  try { fixture?.close() }
  finally { await file.close(); if (directory) await fs.rm(directory, { recursive: true, force: true }) }
}
