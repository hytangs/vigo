import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { intelligenceScenario } from '../test/fixtures/intelligence/scenario.mjs'
import { createProvider } from '../src/agency/provider.mjs'
import { createToolRegistry } from '../src/agency/toolRegistry.mjs'
import { networkBriefing } from '../src/agency/briefing.mjs'
import { deriveOperationalState } from '../src/agency/realtimeIntelligence.mjs'

// Opt-in actual-provider evaluation. Never runs in the software test suite.
const args = process.argv.slice(2), option = name => args[args.indexOf(name) + 1]
if (!args.includes('--output')) throw Error('Supply --output <new JSON file> and VIGO_AGENCY_LLM_* settings.')
const variant = args.includes('--variant') ? option('--variant') : 'current'
if (!['current', 'stale'].includes(variant)) throw Error('Choose current or stale.')
const provider = createProvider().forRequest()
if (!provider.available) throw Error('Connect a real model; this evaluation does not substitute mock prose.')
const file = await fs.open(option('--output'), 'wx')
let directory, fixture
try {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-briefing-'))
  fixture = intelligenceScenario(directory)
  const snapshot = variant === 'stale' ? { ...fixture.snapshot, feeds: fixture.snapshot.feeds.map(feed => ({ ...feed, feedTimestamp: feed.feedTimestamp - 600 })) } : fixture.snapshot
  const state = variant === 'stale' ? deriveOperationalState(fixture.context, snapshot, Date.parse(fixture.state.generatedAt) / 1000) : fixture.state
  const startedAt = new Date().toISOString(), start = performance.now()
  const answer = await networkBriefing({ ...fixture, state, snapshot, provider, signal: AbortSignal.timeout(180_000), callTool: createToolRegistry({ ...fixture, state, snapshot, adapters: {} }) })
  await file.write(JSON.stringify({ startedAt, revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()), model: provider.model, variant,
    fixture: 'Synthetic seven-route network, not live Boston observations. Current case has a Route 66 cancellation and wider spacing; Route 39 has closer pairs. Red Line reporting trips match schedule. Stale case has expired feed timestamps.',
    seconds: (performance.now() - start) / 1000, answer }, null, 2) + '\n')
  console.log(JSON.stringify({ aiGenerated: answer.aiGenerated, warnings: answer.warnings, output: option('--output') }))
} finally {
  fixture?.close()
  await file.close()
  if (directory) await fs.rm(directory, { recursive: true, force: true })
}
