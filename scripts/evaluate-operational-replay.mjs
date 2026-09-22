import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createReplayService } from '../src/agency/replayService.mjs'
import { loadReplay } from '../src/agency/incidentReplay.mjs'
import { createProvider } from '../src/agency/provider.mjs'

const args = process.argv.slice(2), useAI = args.includes('--ai')
if (args.some(arg => arg !== '--ai')) throw Error('Usage: node scripts/evaluate-operational-replay.mjs [--ai]')
const bundle = loadReplay(), provider = useAI ? createProvider() : null
if (useAI && !provider.available) throw Error('Configure the model endpoint explicitly before running --ai.')
const directory = mkdtempSync(path.join(os.tmpdir(), 'vigo-replay-evaluation-')), rows = []
const principal = { id: 'automated-test-reviewer', role: 'admin' }
const service = createReplayService(directory, 'evaluation', bundle)
try {
  for (const scenario of bundle.manifest.cases) for (const mode of ['deterministic', ...(useAI ? ['ai-orchestration'] : [])]) {
    const started = performance.now()
    let state, row = { caseId: scenario.id, split: scenario.split, mode, synthetic: true, humanApproval: false }
    const command = async (action, fields = {}) => { state = await service.handle({ action, runId: state?.run?.id, version: state?.run?.version, ...fields }, principal, undefined, provider); return state }
    try {
      await command('replay-start', { caseId: scenario.id })
      const expected = scenario.expected, comparison = state.run.comparison
      row.comparison = comparison
      row.correctEvidenceStatus = comparison.status === expected.status
      row.procedureStatus = state.run.procedure.status
      let choice = comparison.selectedId
      if (mode === 'ai-orchestration') {
        await command('replay-ai')
        row.ai = state.run.ai; choice = state.run.ai.candidateId
        if (state.run.ai.status !== 'complete') throw Error(state.run.ai.reason || 'AI review incomplete')
      }
      const candidate = comparison.candidates.find(c => c.id === choice)
      row.correctAction = expected.status === 'unavailable' ? mode === 'deterministic' ? !choice : choice === 'escalate' : Boolean(candidate && expected.acceptableHoldSeconds.includes(candidate.holdSeconds))
      row.assessmentMs = performance.now() - started
      if (candidate) {
        await command('replay-prepare', { candidateId: candidate.id }); await command('replay-approve')
        await command('replay-deliver'); await command('replay-deliver')
        const receipt = state.run.message.delivery.receipt
        await command('replay-deliver')
        row.singleReceipt = state.run.message.delivery.receipt === receipt && state.run.attempts.length === 2
        await command('replay-advance', { to: 'changed' })
        row.withdrawnAfterChange = state.run.message.status === 'withdrawn' && !state.run.decision.current
        let refused = false
        try { await command('replay-deliver') } catch { refused = true }
        row.staleDeliveryRefused = refused
      } else {
        let refused = false
        try { await command('replay-prepare', { candidateId: 'none' }) } catch { refused = true }
        row.infeasiblePreparationRefused = refused
      }
      row.complete = row.correctEvidenceStatus && row.correctAction && (candidate ? row.singleReceipt && row.withdrawnAfterChange && row.staleDeliveryRefused : row.infeasiblePreparationRefused)
    } catch (error) { row.complete = false; row.error = error.message }
    row.endToEndMs = performance.now() - started; rows.push(row)
    console.log(`${scenario.id} · ${mode}: ${row.complete ? 'passed' : 'incomplete'} · ${(row.endToEndMs / 1000).toFixed(2)} s`)
  }
  const quantile = (values, q) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * q) - 1] ?? null
  const result = { generatedAt: new Date().toISOString(), packageId: bundle.manifest.id, timetableVersion: bundle.manifest.timetableVersion,
    platform: { os: process.platform, architecture: process.arch, node: process.version }, evaluation: 'Developer-authored synthetic expectations, five scenarios. Two scenario variants held out of the development set. No agency expert or manual user study.',
    timer: 'Per case: opening an isolated persisted replay through assessment, simulated approval/delivery, duplicate retry and changed-evidence withdrawal. AI mode includes two inference calls. First case includes cold SQLite work; model cache state is not controlled.',
    manual: { status: 'not-run', reviewer: null, taskTimeMs: null, corrections: null, messageEditing: null }, observedServiceImpact: null, inferenceCost: null,
    summary: ['deterministic', ...(useAI ? ['ai-orchestration'] : [])].map(mode => { const group = rows.filter(r => r.mode === mode); return { mode, cases: group.length, complete: group.filter(r => r.complete).length, correctActions: group.filter(r => r.correctAction).length, medianAssessmentMs: quantile(group.map(r => r.assessmentMs).filter(Number.isFinite), .5), p90EndToEndMs: quantile(group.map(r => r.endToEndMs), .9) } }), rows }
  const out = path.resolve('output/replay/evaluations', result.generatedAt.replaceAll(':', '-'))
  mkdirSync(out, { recursive: true }); writeFileSync(path.join(out, 'results.json'), `${JSON.stringify(result, null, 2)}\n`)
  console.log(`Saved all outcomes: ${path.join(out, 'results.json')}`)
  if (rows.some(r => !r.complete)) process.exitCode = 1
} finally { service.close(); rmSync(directory, { recursive: true, force: true }) }
