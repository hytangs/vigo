import assert from 'node:assert/strict'
import { mkdtempSync, cpSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createReplayService } from '../src/agency/replayService.mjs'
import { loadReplay, replayEvidence, replayDirectory } from '../src/agency/incidentReplay.mjs'
import { compareHolding } from '../src/agency/holding.mjs'
import { applicableProcedures, procedureResult } from '../src/agency/procedures.mjs'

import { createOperationsStore } from '../src/agency/operationsStore.mjs'

const directory = mkdtempSync(path.join(os.tmpdir(), 'vigo-replay-check-'))
const bundle = loadReplay(), principal = { id: 'test-supervisor', role: 'admin' }
let service = createReplayService(path.join(directory, 'store'), 'city', bundle)
let state
const command = async (action, fields = {}, actor = principal) => {
  const value = await service.handle({ action, runId: state?.run?.id, version: state?.run?.version, ...fields }, actor)
  state = value; return value
}
const selection = (input, records = bundle.procedures.filter(p => p.id === 'control-sop')) => {
  const chosen = applicableProcedures(records, { at: input.clock, routeId: input.routeId, stopId: input.stopId, prerequisites: input.prerequisites })
  return procedureResult(chosen, chosen.applicable)
}
try {
  cpSync(replayDirectory, path.join(directory, 'portable'), { recursive: true })
  const portable = loadReplay(path.join(directory, 'portable'))
  assert.equal(portable.identity, bundle.identity, 'Moving the package cannot change evidence identity')
  for (const scenario of bundle.manifest.cases) {
    await command('replay-start', { caseId: scenario.id })
    assert.equal(state.run.comparison.status, scenario.expected.status, scenario.id)
    assert.deepEqual(replayEvidence(portable, scenario.id), replayEvidence(bundle, scenario.id))
    if (scenario.expected.status === 'ready') {
      const candidate = state.run.comparison.candidates.find(c => c.id === state.run.comparison.selectedId)
      assert.ok(scenario.expected.acceptableHoldSeconds.includes(candidate.holdSeconds), scenario.id)
    } else await assert.rejects(command('replay-prepare', { candidateId: 'none' }), /No feasible/)
  }
  await command('replay-start', { caseId: 'disruption' })
  assert.equal(state.run.procedure.records.length, 1)
  assert.deepEqual(state.run.procedure.rejected.map(r => r.reason).sort(), ['outside-control-scope', 'outside-effective-period'])
  await assert.rejects(command('replay-prepare', { candidateId: 'invent-a-300-second-hold' }), /No feasible/)
  await command('replay-prepare', { candidateId: 'minimum-passenger-time' })
  assert.equal(state.run.decision.candidate.holdSeconds, 120)
  assert.equal(state.run.decision.cause, null, 'No model-written cause is in the public decision')
  const staleVersion = state.run.version
  await assert.rejects(command('replay-deliver'), /Approve/)
  await assert.rejects(command('replay-approve', {}, { id: 'operator', role: 'operator' }), /cannot perform/)
  await command('replay-approve')
  await assert.rejects(command('replay-prepare', { version: staleVersion, candidateId: 'none' }), /changed/)
  await command('replay-deliver')
  assert.equal(state.run.message.status, 'released'); assert.equal(state.run.attempts[0].status, 'retryable')
  await command('replay-deliver')
  const delivered = state
  assert.equal(delivered.run.message.status, 'delivered')
  await command('replay-deliver', { version: staleVersion })
  assert.deepEqual(state.run.attempts, delivered.run.attempts, 'Lost-response retry cannot duplicate delivery')
  await command('replay-advance', { to: 'changed' }, { id: 'operator', role: 'operator' })
  assert.equal(state.run.message.status, 'withdrawn'); assert.equal(state.run.decision.current, false)
  await assert.rejects(command('replay-deliver'), /changed or expired/)
  await assert.rejects(command('replay-advance', { to: 'changed' }), /only moves forward/)
  const savedId = state.run.id
  service.close(); service = createReplayService(path.join(directory, 'store'), 'city', bundle)
  await command('replay-state'); assert.equal(state.run.id, savedId)
  assert.equal(state.run.message.status, 'withdrawn', 'Withdrawal survives restart')
  const exported = await service.handle({ action: 'replay-export' }, principal)
  assert.ok(exported.records.some(item => item.record.kind === 'message' && item.revisions.some(r => r.action === 'message-delivery')))
  assert.equal(exported.package.timetable.feed_info[0].feed_version, 'SYN-HOLD-1')
  await command('replay-start', { caseId: 'disruption' })
  await command('replay-prepare', { candidateId: 'none' }); await command('replay-approve'); await command('replay-advance', { to: 'expired' })
  await assert.rejects(command('replay-deliver'), /expired/)
  // Exact matching: no guesses when reports conflict, use another service day or skip a stop.
  for (const mutate of [
    data => data.observations.disruption.initial.trip_updates.entity.push(structuredClone(data.observations.disruption.initial.trip_updates.entity[0])),
    data => { data.observations.disruption.initial.trip_updates.entity[0].trip_update.trip.direction_id = 1 },
    data => { data.observations.disruption.initial.trip_updates.entity[0].trip_update.trip.start_date = '20260915' },
    data => { data.observations.disruption.initial.trip_updates.entity[0].trip_update.stop_time_update[1].schedule_relationship = 'SKIPPED' },
  ]) { const adversarial = structuredClone(bundle); mutate(adversarial); assert.throws(() => replayEvidence(adversarial, 'disruption')) }
  const input = replayEvidence(bundle, 'disruption'), sop = selection(input)
  const future = structuredClone(bundle); future.observations.disruption.initial.vehicle_positions.entity[0].vehicle.timestamp += 100
  assert.match(compareHolding(replayEvidence(future, 'disruption'), sop).reason, /future/)
  const missingClock = structuredClone(bundle); delete missingClock.observations.disruption.initial.trip_updates.header.timestamp
  assert.equal(replayEvidence(missingClock, 'disruption').sourceAt, null)
  assert.equal(compareHolding(replayEvidence(missingClock, 'disruption'), sop).status, 'unavailable')
  assert.equal(compareHolding({ ...input, scheduledHeadwaySeconds: NaN }, sop).status, 'unavailable')
  assert.equal(compareHolding({ ...input, onboardPassengers: null }, sop).status, 'unavailable')
  assert.equal(compareHolding({ ...input, downstream: input.downstream.map(s => ({ ...s, backSeconds: 10 })) }, sop).status, 'unavailable')
  assert.throws(() => compareHolding(input, sop, { signal: AbortSignal.abort() }), /abort/i)
  assert.throws(() => compareHolding(input, sop, { deadline: 0 }), /deadline/)
  for (const load of [0, 10, 40, 100]) {
    const result = compareHolding({ ...input, onboardPassengers: load }, sop)
    const best = result.candidates.find(c => c.id === result.selectedId)
    const objective = h => input.downstream.reduce((sum, s) => sum + s.arrivalsPerSecond / 2 * ((s.frontSeconds + h) ** 2 + (s.backSeconds - h) ** 2), load * h) / 60
    assert.ok(Math.abs(best.modeledPassengerMinutes - Math.min(...Array.from({ length: 181 }, (_, h) => objective(h)))) < 1e-8, 'Closed-form choice matches exhaustive integer search')
  }
  const base = bundle.procedures[0]
  for (const change of [{ status: 'draft' }, { procedure: { ...base.procedure, effectiveFrom: '2027-01-01' } }, { stopIds: [] }, { procedure: { ...base.procedure, prerequisites: ['unconfirmed'] } }]) assert.equal(selection(input, [{ ...base, ...change }]).status, 'unavailable')
  const replacement = { ...base, id: 'revised', procedure: { ...base.procedure, revision: '2', supersedes: ['SYN-HOLD@1'] } }
  assert.deepEqual(selection(input, [base, replacement]).records.map(r => r.id), ['revised'])
  assert.equal(selection(input, [base, bundle.procedures.find(p => p.id === 'conflicting-sop')]).status, 'conflict')
  const ledger = createOperationsStore(path.join(directory, 'rollback'), 'rollback')
  assert.throws(() => ledger.transaction(() => { ledger.transaction(() => ledger.save('knowledge', null, null, base, principal, 'test')); throw Error('interrupt transaction') }))
  assert.equal(ledger.health().recordCount, 0); assert.equal(ledger.health().auditCount, 0)
  ledger.transaction(() => {
    for (let i = 0; i < 105; i++) ledger.save('knowledge', null, null, { ...base, visibility: 'internal', body: 'PRIVATE-STAFF-NOTE holding control' }, principal, 'test')
  })
  const publicRecord = ledger.save('knowledge', null, null, base, principal, 'test')
  ledger.save('knowledge', null, null, { ...base, status: 'draft' }, principal, 'test')
  ledger.save('knowledge', null, null, { ...base, procedure: { ...base.procedure, effectiveFrom: '2027-01-01' } }, principal, 'test')
  ledger.save('knowledge', null, null, { ...base, validUntil: input.clock }, principal, 'test')
  assert.deepEqual(ledger.publicKnowledge('holding', input.clock).map(r => r.id), [publicRecord.id], 'Disclosure filters precede the result limit')
  assert.doesNotMatch(JSON.stringify(ledger.publicKnowledge('PRIVATE STAFF NOTE OR holding', input.clock)), /PRIVATE-STAFF-NOTE/)
  const archivedAnswer = { answer: 'Previously leaked internal note', generatedAt: input.clock, trace: [{ tool: 'operational_context', result: { ok: true } }] }
  const { createNotebook } = await import('../src/agency/notebook.mjs')
  const notebook = createNotebook(path.join(directory, 'privacy'))
  const entry = notebook.save({ title: 'Legacy internal answer', answer: archivedAnswer })
  assert.deepEqual(notebook.recall({ entryId: entry.id }), [], 'Legacy internal answers cannot be retransmitted through retrieval')
  const permitted = notebook.save({ title: 'Public-context answer', answer: { ...archivedAnswer, answer: 'Approved public evidence', dataPolicyVersion: 1 } })
  assert.equal(notebook.recall({ entryId: permitted.id })[0].excerpt, 'Approved public evidence', 'The current policy preserves permitted conversation recall')
  notebook.close(); ledger.close()
  await command('replay-start', { caseId: 'disruption' })
  console.log('Operational replay computation, approvals, persistence and privacy passed.')
} finally { service.close(); rmSync(directory, { recursive: true, force: true }) }
