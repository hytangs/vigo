import { createOperationsStore } from './operationsStore.mjs'
import { handleOperations } from './operationsService.mjs'
import { authorize, fail } from './operations.mjs'
import { loadReplay, replayEvidence } from './incidentReplay.mjs'
import { compareHolding } from './holding.mjs'

export function createReplayService(directory, projectId, bundle = loadReplay()) {
  let clock = Date.parse(bundle.manifest.cases[0].clock)
  const store = createOperationsStore(directory, `replay:${projectId}`, () => clock)
  const active = () => store.meta('active') ? store.read(store.meta('active'), 'replay') : null
  const context = { routeIndex: new Map(bundle.timetable.routes.map(r => [r.route_id, { short_name: r.route_short_name }])), stopIndex: new Map(bundle.timetable.stops.map(s => [s.stop_id, { name: s.stop_name }])) }
  const getEvidence = run => replayEvidence(bundle, run.caseId, run.frame, run.clock)
  function procedure(run, input) { return store.procedures({ at: input.clock, routeId: input.routeId, stopId: input.stopId, prerequisites: input.prerequisites, recordIds: run.knowledgeIds, search: 'holding control point' }) }
  function analysis(run, signal) {
    const input = getEvidence(run), sop = procedure(run, input)
    return { input, sop, comparison: compareHolding(input, sop, { signal }) }
  }
  function operation(run, principal, body) {
    const input = getEvidence(run)
    const event = { id: `replay-${run.id}`, type: 'headway-review', title: 'Control-point departure review', observedAt: input.sourceAt, routeId: input.routeId, stopId: input.stopId, tripId: input.tripId,
      evidence: { scheduledHeadwaySeconds: input.scheduledHeadwaySeconds, observedHeadwaySeconds: input.backSeconds }, sourceRefs: input.refs }
    const state = { generatedAt: input.clock, observedAt: input.sourceAt, connected: !input.problems.length, coverage: { valid: true }, policy: { freshnessSeconds: bundle.manifest.freshnessSeconds },
      events: [event], feeds: [{ kind: 'replay', status: input.problems.length ? 'stale' : 'fresh' }], counts: { matchedTrips: 3, trips: 3 }, routes: [{ widestInterval: {} }] }
    return handleOperations({ store, context, state, scheduleIdentity: `${bundle.manifest.id}@${bundle.manifest.timetableVersion}`, principal, body, monitoring: { active: false } })
  }
  function validDecision(run) {
    const { input, sop, comparison } = analysis(run)
    const d = run.decision
    if (!d || d.evidenceVersion !== input.evidenceVersion || Date.parse(input.clock) >= Date.parse(d.expiresAt) || comparison.status !== 'ready'
      || JSON.stringify(d.procedureRefs) !== JSON.stringify(comparison.procedureRefs)) fail('Evidence or procedure changed or expired. Compare the current observation and approve a new message.', 409)
    return input
  }
  function view(run = active()) {
    if (!run) return { package: summary(), run: null }
    const { input, sop, comparison } = analysis(run)
    let current = true
    if (run.decision) { try { validDecision(run) } catch { current = false } }
    const { evidenceVersion: _version, ...publicInput } = input
    const { evidenceVersion: _decisionVersion, ...decision } = run.decision || {}
    return { package: summary(), run: { id: run.id, version: run.version, caseId: run.caseId, clock: run.clock, frame: run.frame, input: publicInput, procedure: sop, comparison,
      decision: run.decision ? { ...decision, current } : null, message: run.messageId ? store.read(run.messageId) : null, attempts: run.attempts || [], ai: run.ai || null } }
  }
  const summary = () => ({ id: bundle.manifest.id, title: bundle.manifest.title, synthetic: true, agency: bundle.manifest.agency, reviewer: bundle.manifest.reviewer,
    timetableVersion: bundle.manifest.timetableVersion, knownUnknowns: bundle.manifest.knownUnknowns, cases: bundle.manifest.cases.map(({ id, label, split }) => ({ id, label, split })) })
  const saveRun = (run, principal, action) => store.save('replay', run.id, run.version, run, principal, action)
  return {
    close: () => store.close(), view,
    compare(caseId, signal) {
      const run = active()
      if (!run || run.caseId !== caseId) fail('Open this synthetic replay case in Operations first.', 409)
      const { input, sop, comparison } = analysis(run, signal)
      if (sop.records.some(record => record.visibility !== 'public')) return { status: 'unavailable', reason: 'Internal procedures may be inspected in Operations only.', candidates: [] }
      return { synthetic: true, ...comparison, caseId, clock: input.clock, evidenceRefs: input.refs, procedure: sop.records.map(({ body, procedure, source }) => ({ passage: body, procedure, source })) }
    },
    async handle(body, principal, signal, provider) {
      authorize(principal, ['replay-approve', 'replay-deliver', 'replay-withdraw'].includes(body.action) ? body.action === 'replay-approve' ? 'approve' : 'publish' : ['replay-state', 'replay-export'].includes(body.action) ? 'read' : 'finding')
      signal?.throwIfAborted()
      if (body.action === 'replay-state') return view()
      if (body.action === 'replay-start') {
        const scenario = bundle.manifest.cases.find(row => row.id === body.caseId)
        if (!scenario) fail('Choose a packaged replay case.')
        clock = Date.parse(scenario.clock)
        return store.transaction(() => {
          const knowledgeIds = bundle.procedures.filter(p => scenario.procedureIds.includes(p.id)).map(p => store.save('knowledge', null, null, p, { id: 'synthetic-fixture', role: 'admin' }, 'replay-import').id)
          const run = store.save('replay', null, null, { title: scenario.label, caseId: scenario.id, frame: 'initial', clock: scenario.clock, knowledgeIds, packageIdentity: bundle.identity }, principal, 'replay-start')
          store.setMeta('active', run.id)
          return view(run)
        })
      }
      let run = active()
      if (!run) fail('Open a replay case first.', 409)
      clock = Date.parse(run.clock)
      if (run.packageIdentity !== bundle.identity) fail('The package changed. Open a new replay run.', 409)
      if (body.action === 'replay-export') return { package: bundle, run, records: [...run.knowledgeIds, run.findingId, run.messageId].filter(Boolean).map(id => ({ record: store.read(id), revisions: store.audit(id) })), audit: store.audit(run.id) }
      // Retry of a completed delivery is idempotent, including after a lost HTTP response.
      if (body.action === 'replay-deliver' && run.messageId && store.read(run.messageId).status === 'delivered') { validDecision(run); return view(run) }
      if (body.runId !== run.id || body.version !== run.version) fail('The replay changed. Reload before continuing.', 409)
      if (body.action === 'replay-ai') {
        const { reviewReplay } = await import('./replayAgent.mjs')
        const ai = await reviewReplay({ provider, signal, run: view(run).run })
        signal?.throwIfAborted()
        if (active().id !== run.id || active().version !== run.version) fail('The replay changed during model review. Its suggestion was not applied.', 409)
        run = saveRun({ ...run, ai }, principal, body.action)
        return view(run)
      }
      return store.transaction(() => {
      if (body.action === 'replay-advance') {
        const scenario = bundle.manifest.cases.find(row => row.id === run.caseId)
        if (!['changed', 'expired'].includes(body.to)) fail('Choose the changed or expired observation.')
        const nextClock = body.to === 'changed' ? scenario.changedClock : new Date(Date.parse(scenario.clock) + (bundle.manifest.freshnessSeconds + 1) * 1000).toISOString()
        if (Date.parse(nextClock) <= Date.parse(run.clock)) fail('Replay time only moves forward. Open a new run to restart.', 409)
        run = { ...run, frame: body.to === 'changed' ? 'changed' : run.frame, clock: nextClock, ai: null }
        clock = Date.parse(nextClock)
        if (run.messageId && ['released', 'delivered'].includes(store.read(run.messageId).status)) {
          const message = store.read(run.messageId)
          operation(run, { id: 'sandbox-evidence-monitor', role: 'admin' }, { action: 'message-withdraw', id: message.id, version: message.version, note: 'Replay evidence changed or expired; sandbox copy withdrawn automatically.' })
        }
        run = saveRun(run, principal, body.action)
        return view(run)
      }
      if (body.action === 'replay-prepare') {
        const { input, comparison } = analysis(run, signal)
        const candidate = comparison.candidates.find(c => c.id === body.candidateId)
        if (!candidate?.feasible || comparison.status !== 'ready') fail('No feasible candidate can be established. Inspect the procedure and evidence first.', 409)
        if (run.messageId && ['released', 'delivered'].includes(store.read(run.messageId).status)) fail('Withdraw the prior sandbox copy before replacing this decision.', 409)
        let finding = operation(run, principal, { action: 'operations-track', eventId: `replay-${run.id}` })
        if (finding.status === 'new') for (const status of ['acknowledged', 'investigating', 'acting']) finding = operation(run, principal, { action: 'operations-transition', id: finding.id, version: finding.version, status, note: 'Synthetic replay: candidate prepared for supervisor review; no dispatch.', knowledge: comparison.procedureRefs.map(r => r.id) })
        finding = operation(run, principal, { action: 'operations-refresh', id: finding.id, version: finding.version })
        const message = operation(run, principal, { action: 'message-draft', findingId: finding.id, channel: 'app', audience: 'at-stop' })
        const copy = `SANDBOX · Route ${input.routeName} at ${input.stopName}, toward ${input.destination}: ${candidate.holdSeconds ? `a ${candidate.holdSeconds}-second hold is proposed for this bus.` : 'no additional hold is proposed.'} ${candidate.holdSeconds ? 'We’re sorry for the extra wait. ' : ''}This is a simulated decision, not a dispatch or live departure announcement.`
        operation(run, principal, { action: 'message-edit', id: message.id, version: message.version, text: copy, expiresAt: input.expiresAt })
        run = saveRun({ ...run, findingId: finding.id, messageId: message.id, attempts: [], decision: { candidate, evidenceVersion: input.evidenceVersion, evidenceRefs: input.refs,
          procedureRefs: comparison.procedureRefs, assumptions: comparison.assumptions, expiresAt: input.expiresAt, status: 'draft', approvedBy: null, cause: null, recoveryAt: null } }, principal, body.action)
        return view(run)
      }
      if (body.action === 'replay-approve') {
        validDecision(run)
        const message = store.read(run.messageId)
        operation(run, principal, { action: 'message-approve', id: message.id, version: message.version })
        run = saveRun({ ...run, decision: { ...run.decision, status: 'approved', approvedBy: principal.id } }, principal, body.action)
        return view(run)
      }
      if (body.action === 'replay-deliver') {
        validDecision(run)
        if (run.decision.status !== 'approved') fail('Approve the candidate and its exact rider message first.', 409)
        let message = store.read(run.messageId)
        if (message.status === 'approved') message = operation(run, principal, { action: 'message-release', id: message.id, version: message.version })
        if (message.status !== 'released') fail('This sandbox copy is not available for delivery.', 409)
        const attempts = [...(run.attempts || [])]
        // A deterministic transport fault is part of the replay, not an external publication.
        if (!attempts.length) attempts.push({ attempt: 1, at: run.clock, status: 'retryable', detail: 'Simulated temporary transport failure. Nothing delivered.' })
        else {
          const receipt = `sandbox:${run.id}:${message.id}`
          operation(run, principal, { action: 'message-delivery', id: message.id, version: message.version, receipt })
          attempts.push({ attempt: attempts.length + 1, at: run.clock, status: 'delivered', receipt })
        }
        run = saveRun({ ...run, attempts }, principal, body.action)
        return view(run)
      }
      if (body.action === 'replay-withdraw') {
        if (!run.messageId) fail('No sandbox message to withdraw.')
        const message = store.read(run.messageId)
        operation(run, principal, { action: 'message-withdraw', id: message.id, version: message.version, note: 'Staff withdrew the sandbox copy.' })
        run = saveRun({ ...run, decision: { ...run.decision, status: 'withdrawn' } }, principal, body.action)
        return view(run)
      }
      fail('Unknown replay action.')
      })
    },
  }
}
