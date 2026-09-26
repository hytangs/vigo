import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { AgencyContext } from '../src/agency/agencyContext.mjs'
import { deriveOperationalState } from '../src/agency/realtimeIntelligence.mjs'
import { handleOperations } from '../src/agency/operationsService.mjs'
import { createOperationsStore } from '../src/agency/operationsStore.mjs'
import { historicalComparison, qualitySummary, operationsPolicy } from '../src/agency/operations.mjs'
import { createAgencyFixture, realtimeFixture, tripUpdate, observationTime } from './fixtures/agency.mjs'

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agency-operations-'))
const file = path.join(directory, 'schedule.sqlite')
createAgencyFixture(file)
let now = observationTime * 1000, principal = { id: 'dispatcher', role: 'operator' }
let snapshot = realtimeFixture([tripUpdate('T1', 300), tripUpdate('T2', 900), tripUpdate('T3', 300)])
const context = new AgencyContext(file, 'Test City')
const ledgerDirectory = path.join(directory, 'city-x')
let ledger = createOperationsStore(ledgerDirectory, 'city-x')
let currentState = deriveOperationalState(context, snapshot, now / 1000)
const command = async body => handleOperations({ store: ledger, state: currentState, context, scheduleIdentity: 'fixture-v1', principal, body })
const change = (record, action, fields = {}) => command({ action, id: record.id, version: record.version, ...fields })
const rejects = (promise, status) => assert.rejects(promise, error => error.statusCode === status)
try {
  principal = { id: 'local-owner', role: 'admin' }
  const state = currentState
  ledger.observe(state, 'fixture-v1')
  const firstStoredAt = ledger.health().lastStoredAt
  assert.equal(qualitySummary(state).alignmentRatio, 1)
  assert.equal(qualitySummary({ ...state, counts: { ...state.counts, trips: 0, matchedTrips: 0 } }).alignmentRatio, null)
  const event = state.events.find(event => event.type === 'service-gap')
  assert.ok(event)
  principal = { id: 'dispatcher', role: 'operator' }
  let finding = await command({ action: 'operations-track', eventId: event.id })
  assert.equal((await command({ action: 'operations-track', eventId: event.id })).id, finding.id, 'Repeated tracking is idempotent')
  assert.equal(finding.status, 'new')
  await rejects(change(finding, 'operations-transition', { status: 'resolved', note: 'skip steps' }), 409)
  finding = await change(finding, 'operations-transition', { status: 'acknowledged', note: 'Dispatch is checking this predicted gap.' })
  await rejects(command({ action: 'operations-transition', id: finding.id, version: 1, status: 'investigating', note: 'outdated tab' }), 409)
  assert.equal((await command({ action: 'operations-audit', id: finding.id })).revisions.length, 2, 'A conflict must not leave an audit row')

  let knowledge = await command({ action: 'knowledge-save', kind: 'sop', title: 'Predicted gap review', text: 'Verify reports before attributing a cause.', source: 'Synthetic operations handbook, section 2', routeIds: ['R'], validUntil: '2026-10-01' })
  await rejects(change(knowledge, 'knowledge-approve'), 403)
  await rejects(change(finding, 'operations-transition', { status: 'investigating', note: 'Check guide', knowledge: [knowledge.id] }), 409)
  await rejects(command({ action: 'knowledge-save', kind: 'sop', title: 'bad', text: 'bad', source: 'fixture', routeIds: ['WRONG'], validUntil: '2026-10-01' }), 400)
  await rejects(command({ action: 'knowledge-save', kind: 'sop', title: 'bad', text: 'bad', source: 'fixture', validUntil: 'not a date' }), 400)
  principal = { id: 'supervisor', role: 'reviewer' }
  knowledge = await change(knowledge, 'knowledge-approve')
  assert.deepEqual(ledger.publicKnowledge('gap', state.generatedAt), [], 'Approved private procedures stay out of model context')
  finding = await change(finding, 'operations-transition', { status: 'investigating', note: 'Reviewed consecutive trip evidence.', knowledge: [knowledge.id] })
  let message = await command({ action: 'message-draft', findingId: finding.id, channel: 'app', audience: 'accessible-travel' })
  assert.match(message.body, /agency staff/)
  await rejects(change(message, 'message-release'), 409)
  await rejects(change(message, 'message-approve'), 403, 'No self approval by a reviewer')
  principal = { id: 'another-supervisor', role: 'reviewer' }
  await rejects(change(message, 'message-approve'), 409, 'Act before approval')
  finding = await change(finding, 'operations-transition', { status: 'acting', note: 'Requested verification from the route controller.' })
  message = await change(message, 'message-approve')
  message = await change(message, 'message-edit', { text: 'Route R: wider predicted departure spacing at River. Please check the latest departures.' })
  assert.equal(message.status, 'draft'); assert.equal(message.approvedBy, null)
  principal = { id: 'supervisor', role: 'reviewer' }
  message = await change(message, 'message-approve')
  const approvedVersion = message.version
  message = await change(message, 'message-release')
  const retry = await command({ action: 'message-release', id: message.id, version: approvedVersion })
  assert.equal(retry.version, message.version)
  assert.equal(message.destination, 'local-outbox'); assert.equal(message.delivery, null)
  await rejects(change(message, 'message-edit', { text: 'Change already released copy.' }), 409)
  await rejects(change(message, 'message-delivery', { receipt: '' }), 400)
  message = await change(message, 'message-delivery', { receipt: 'Synthetic channel receipt fixture-001; not a real publication' })
  assert.equal(message.status, 'delivered')
  finding = await change(finding, 'operations-transition', { status: 'monitoring', note: 'Monitor the next reports.' })
  message = await change(message, 'message-withdraw', { note: 'Synthetic withdrawal test' })
  assert.equal(message.status, 'withdrawn')

  principal = { id: 'reader', role: 'viewer' }
  for (const action of ['operations-track', 'operations-transition', 'knowledge-save', 'message-draft', 'message-approve', 'message-release']) await rejects(command({ action, eventId: event.id, principal: { id: 'forged', role: 'admin' } }), 403)
  assert.equal((await command({ action: 'operations-record', id: finding.id })).version, finding.version)
  principal = { id: 'invalid-role', role: '__proto__' }
  await rejects(command({ action: 'operations-overview' }), 403)
  principal = { id: 'reader', role: 'viewer' }
  const ledgerFile = path.join(directory, 'city-x', 'operations.sqlite')
  assert.throws(() => createOperationsStore(path.dirname(ledgerFile), 'impostor'), error => error.statusCode === 403)

  principal = { id: 'local-owner', role: 'admin' }
  let pending = await command({ action: 'message-draft', findingId: finding.id, channel: 'social', audience: 'at-stop' })
  if (pending.needsShortening) pending = await change(pending, 'message-edit', { text: 'Route R: wider predicted departure spacing at River. Check the departure display before boarding.' })
  pending = await change(pending, 'message-approve')
  // New source time alone is not a different claim; changed measurements invalidate the approval.
  now += 11_000
  snapshot = realtimeFixture([tripUpdate('T1', 300), tripUpdate('T2', 800), tripUpdate('T3', 300)])
  snapshot.fetchedAt = new Date(now).toISOString()
  currentState = deriveOperationalState(context, snapshot, now / 1000)
  await rejects(change(pending, 'message-release'), 409)
  finding = await change(finding, 'operations-refresh')
  await rejects(change(pending, 'message-release'), 409)
  let currentDraft = await command({ action: 'message-draft', findingId: finding.id, channel: 'app', audience: 'all-riders' })
  currentDraft = await change(currentDraft, 'message-approve')
  knowledge = await change(knowledge, 'knowledge-save', { kind: 'sop', title: knowledge.title, text: 'Revised review steps.', source: knowledge.source, routeIds: ['R'], validUntil: '2026-10-01' })
  await rejects(change(currentDraft, 'message-release'), 409, 'Knowledge edits invalidate old message approval')
  now += 181_000
  currentState = deriveOperationalState(context, snapshot, now / 1000)
  const aged = await command({ action: 'operations-overview' })
  assert.equal(aged.findings[0].status, 'monitoring')
  assert.equal(aged.findings[0].availability.status, 'unknown')
  await rejects(change(currentDraft, 'message-release'), 409)
  await rejects(change(finding, 'operations-transition', { status: 'resolved', note: 'No reports.' }), 400)
  finding = await change(finding, 'operations-transition', { status: 'resolved', note: 'Reports expired; recovery was not observed.', outcome: 'unable-to-confirm', resolutionSource: 'Synthetic fixture: no fresh reports.' })
  assert.equal(finding.outcome.label, 'unable-to-confirm')
  const beforeRestart = await command({ action: 'operations-health' })
  assert.equal(beforeRestart.integrity, 'ok'); assert.equal(beforeRestart.sampleCount, 1, 'Repeated reads do not multiply historical samples')
  assert.equal(beforeRestart.lastStoredAt, firstStoredAt, 'Skipped samples must not advance the last retained timestamp')
  ledger.close(); ledger = createOperationsStore(ledgerDirectory, 'city-x')
  assert.equal((await command({ action: 'operations-record', id: finding.id })).outcome.label, 'unable-to-confirm')
  principal = { id: 'reader', role: 'viewer' }
  const revisions = (await command({ action: 'operations-audit', id: finding.id })).revisions
  assert.equal(revisions.at(-1).data.status, 'new')
  assert.equal(revisions[0].data.status, 'resolved')
  assert.equal((await command({ action: 'operations-audit', id: finding.id, before: revisions[1].sequence })).revisions[0].version, revisions[1].version - 1)
  const db = new DatabaseSync(ledgerFile)
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1)
  db.close()

  // Same local weekday/hour, one value per independent service day, no future leakage.
  const history = ['2026-08-16', '2026-08-23', '2026-08-30', '2026-09-06', '2026-09-13', '2026-09-20'].map((serviceDate, index) => ({ serviceDate, weekday: 'Sun', hour: '12', scheduleIdentity: 'fixture-v1', coverageValid: true, routes: [{ id: 'R', maxDelaySeconds: [60, 120, 180, 240, 9999, 9999][index], reportingTrips: 2 }] }))
  const comparison = historicalComparison([...history, { ...history[0], scheduleIdentity: 'different-timetable', routes: [{ id: 'R', maxDelaySeconds: 9999, reportingTrips: 2 }] }], state, 'R', 'fixture-v1')
  assert.equal(comparison.serviceDays, 4); assert.equal(comparison.baselineSeconds, 150)
  assert.equal(comparison.evaluation.cases, 1); assert.equal(comparison.evaluation.meanAbsoluteErrorSeconds, 120)
  assert.equal(historicalComparison(history.slice(0, 2), state, 'R', 'fixture-v1').baselineSeconds, null)
  assert.equal(historicalComparison(history, state, 'R', 'other-import').serviceDays, 0)
  assert.equal(historicalComparison(history, { ...state, coverage: { ...state.coverage, valid: false, serviceDate: null } }, 'R', 'fixture-v1').serviceDays, 0)
  assert.equal(historicalComparison([...history, ...Array(50).fill(history[0])], state, 'R', 'fixture-v1').baselineSeconds, 150)
  const retained = createOperationsStore(path.join(directory, 'retention'), 'retention')
  try {
    retained.observe(state, 'fixture-v1')
    assert.equal(retained.routeSamples('R', 'fixture-v1').length, 1)
    assert.equal(retained.routeSamples('R', 'different-import').length, 0)
    const agedRows = new DatabaseSync(path.join(directory, 'retention', 'operations.sqlite'))
    agedRows.prepare('UPDATE samples SET bucket=?').run(Math.floor((Date.now() - (operationsPolicy.retentionDays + 1) * 86_400_000) / 300000))
    agedRows.close()
    now += 1000
    retained.observe({ ...state, generatedAt: new Date(now).toISOString(), observedAt: new Date(now).toISOString() }, 'fixture-v1')
    assert.equal(retained.samples().length, 1)
    const old = retained.health().recordCount
    assert.throws(() => retained.transaction(() => { retained.save('knowledge', null, null, { title: 'rollback test' }, principal, 'test'); retained.read('missing-record') }))
    assert.equal(retained.health().recordCount, old); assert.equal(retained.health().auditCount, 0)
  } finally { retained.close() }
  const future = new DatabaseSync(path.join(directory, 'retention', 'operations.sqlite'))
  future.exec('PRAGMA user_version=2'); future.close()
  assert.throws(() => createOperationsStore(path.join(directory, 'retention'), 'retention'), error => error.statusCode === 409)
  console.log('Agency operations: workflow, immutable audit, restart, City ownership, RBAC, approval invalidation, handoff retry, receipts, unknown recovery, bounded history and chronological baseline evaluation passed.')
} finally { ledger.close(); context.close(); await fs.rm(directory, { recursive: true, force: true }) }
