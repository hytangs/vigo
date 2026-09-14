import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { intelligenceScenario } from '../test/fixtures/intelligence/scenario.mjs'
import { createProvider } from '../src/agency/provider.mjs'
import { createToolRegistry } from '../src/agency/toolRegistry.mjs'
import { queryAgency } from '../src/agency/queryAgent.mjs'

// Opt-in actual-model evaluation; never runs during release/unit checks.
// The output is a review record, not a self-awarded intelligence score.
const args = process.argv.slice(2)
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined
const output = option('--output')
if (!output) throw Error('Supply --output <new JSONL file> and VIGO_AGENCY_LLM_* environment settings.')
const provider = createProvider()
if (!provider.available) throw Error('Configure an actual model endpoint; this evaluation does not substitute mock answers.')
const ids = option('--ids')?.split(',').map(Number)
const corpus = JSON.parse(await fs.readFile(new URL('../test/fixtures/intelligence/questions.json', import.meta.url), 'utf8'))
if (ids?.some(id => !corpus.some(row => row.id === id))) throw Error('Choose question IDs from the evaluation corpus.')
const questions = corpus.filter(row => !ids || ids.includes(row.id))
const file = await fs.open(output, 'wx')
let directory, fixture
try {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-intelligence-'))
  fixture = intelligenceScenario(directory)
  const status = provider.status()
  await file.write(`${JSON.stringify({ type: 'run', startedAt: new Date().toISOString(), revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()),
    model: status.model, protocol: status.protocol, contextTokens: status.contextTokens, reasoningEffort: status.reasoningEffort, temperature: status.temperature,
    scenario: 'Synthetic evaluation network; not Boston observations. Frozen at 08:00 EDT, September 14. Missing APC, crew, maintenance, fleet, dispatch and historical outcome data are deliberate.', selection: fixture.selection, questions: questions.length, questionIds: questions.map(item => item.id) })}\n`)
  for (const item of questions) {
    const signal = AbortSignal.timeout(180_000)
    const callTool = createToolRegistry({ ...fixture, signal, adapters: {} })
    let result
    try { result = await queryAgency({ ...fixture, question: item.question, callTool, provider: provider.forRequest(), signal, placesAvailable: false }) }
    catch (error) { result = { error: error.message } }
    await file.write(`${JSON.stringify({ recordType: 'answer', ...item, result })}\n`)
    console.log(JSON.stringify({ id: item.id, seconds: Math.round((result.timing?.totalMs || 0) / 1000), calls: result.trace?.map(call => `${call.tool}:${call.result.ok}`), warnings: result.warnings, answer: result.answer }))
  }
  await file.write(`${JSON.stringify({ recordType: 'complete', finishedAt: new Date().toISOString(), answered: questions.length })}\n`)
} finally {
  try { fixture?.close() }
  finally { await file.close(); if (directory) await fs.rm(directory, { recursive: true, force: true }) }
}
