import { authorize, permissions, workflow, channelLimits, fail, textField, isoDate, recordIdentity, eventVersion, eventAvailability, composeMessage, qualitySummary, historicalComparison } from './operations.mjs'
import { procedureMetadata } from './procedures.mjs'

const capabilities = { 'operations-track': 'finding', 'operations-transition': 'finding', 'operations-refresh': 'finding', 'knowledge-save': 'knowledge', 'knowledge-approve': 'approve',
  'message-draft': 'draft', 'message-edit': 'draft', 'message-approve': 'approve', 'message-release': 'publish', 'message-delivery': 'publish', 'message-withdraw': 'publish' }
export const operationsActions = new Set(['operations-overview', 'operations-list', 'operations-record', 'operations-audit', 'operations-history', 'operations-baseline', 'operations-health', 'knowledge-select', ...Object.keys(capabilities)])

export function handleOperations({ store, state, context, scheduleIdentity, principal, body, monitoring }) {
  authorize(principal, capabilities[body.action] || 'read')
  const at = state.generatedAt
  const read = (id, kind) => store.read(id, kind)
  const current = finding => eventAvailability(finding, state, scheduleIdentity)
  const evidence = finding => {
    const available = current(finding)
    if (available.status !== 'current') fail(available.reason, 409)
    if (available.changed) fail('The evidence changed. Refresh this finding and review the message again.', 409)
    return available.event
  }
  const save = (kind, id, value, action = body.action) => store.save(kind, id, body.version, value, principal, action)
  const linkKnowledge = (links = [], event) => {
    if (!Array.isArray(links) || links.length > 8 || links.some(id => typeof id !== 'string')) fail('Link at most eight knowledge records.')
    return [...new Set(links)].map(id => {
      const record = read(id, 'knowledge')
      if (record.status !== 'approved' || Date.parse(record.validUntil) <= Date.parse(at)) fail('Linked knowledge must be approved and within its review period.', 409)
      if (record.procedure && Date.parse(record.procedure.effectiveFrom) > Date.parse(at)) fail('This procedure is not effective yet.', 409)
      if (event) {
        const routes = event.routeIds || (event.routeId ? [event.routeId] : []), stops = event.stopIds || (event.stopId ? [event.stopId] : [])
        if (record.routeIds.length && !record.routeIds.some(id => routes.includes(id)) || record.stopIds.length && !record.stopIds.some(id => stops.includes(id))) fail('Knowledge scope does not match this finding.', 409)
      }
      return { id: record.id, version: record.version, title: record.title }
    })
  }
  const validateCopy = record => {
    textField(record.body, 'Rider message', channelLimits[record.channel])
    if ([...record.body].length > channelLimits[record.channel]) fail('Shorten the message for its channel.')
    if (Date.parse(record.expiresAt) <= Date.parse(at)) fail('The message expired. Create a fresh draft.', 409)
    const finding = read(record.findingId, 'finding')
    if (!['acting', 'monitoring'].includes(finding.status)) fail('Record an operational action before approving rider guidance.', 409)
    evidence(finding)
    if (finding.fingerprint !== record.fingerprint) fail('Message evidence changed. Create a new draft.', 409)
    for (const link of record.knowledge) {
      const latest = linkKnowledge([link.id], finding.event)[0]
      if (latest.version !== link.version) fail('Linked knowledge changed. Create a new draft.', 409)
    }
    return finding
  }
  switch (body.action) {
    case 'knowledge-select': return store.procedures({ ...body.query, at })
    case 'operations-overview': return { principal: { id: principal.id, role: principal.role, capabilities: permissions[principal.role] }, quality: qualitySummary(state),
      findings: store.list('finding').map(finding => ({ ...finding, availability: current(finding) })), messages: store.list('message'), knowledge: store.list('knowledge'),
      monitoring: { ...monitoring, lastStoredAt: store.meta('lastStoredAt'), note: 'Observations are retained while Agency is open and active. A stopped application cannot monitor service.' },
      delivery: { destination: 'local-outbox', automatic: false, note: 'Release creates an approved local handoff. Record delivery only after the agency channel confirms it.' } }
    case 'operations-list': {
      if (!['finding', 'knowledge', 'message'].includes(body.kind)) fail('Choose a supported record kind.')
      return { records: store.list(body.kind, body.query).map(record => record.kind === 'finding' ? { ...record, availability: current(record) } : record) }
    }
    case 'operations-record': return read(body.id)
    case 'operations-audit': return { revisions: store.audit(body.id, body.before) }
    case 'operations-history': return { samples: store.samplePage(body.before) }
    case 'operations-baseline': {
      if (typeof body.routeId !== 'string' || !context.routeIndex.has(body.routeId)) fail('Choose a current indexed route.')
      return historicalComparison(store.routeSamples(body.routeId, scheduleIdentity), state, body.routeId, scheduleIdentity)
    }
    case 'operations-health': return { ...store.health(), monitoring }
  }
  return store.transaction(() => {
    switch (body.action) {
      case 'operations-track': {
        const event = state.events.find(event => event.id === body.eventId)
        if (!event) fail('Choose a finding from the current observation.', 409)
        const eventKey = recordIdentity([scheduleIdentity, event.id])
        const existing = store.finding(eventKey)
        if (existing) return existing
        return save('finding', null, { title: event.title, eventKey, event, fingerprint: eventVersion(event), scheduleIdentity, status: 'new', owner: null, note: '', outcome: null,
          firstSeenAt: at, evidenceUpdatedAt: at, quality: qualitySummary(state), knowledge: [] })
      }
      case 'operations-refresh': {
        const record = read(body.id, 'finding'), available = current(record)
        if (available.status !== 'current') fail(available.reason, 409)
        return save('finding', record.id, { ...record, event: available.event, fingerprint: eventVersion(available.event), evidenceUpdatedAt: at, quality: qualitySummary(state) })
      }
      case 'operations-transition': {
        const record = read(body.id, 'finding')
        if (!workflow[record.status]?.includes(body.status)) fail('That workflow transition is not available.', 409)
        const note = textField(body.note, 'Investigation or action note')
        const knowledge = body.knowledge === undefined ? record.knowledge : linkKnowledge(body.knowledge, record.event)
        let outcome = null
        if (body.status === 'resolved') {
          if (!['confirmed-recovery', 'false-positive', 'unable-to-confirm'].includes(body.outcome)) fail('Choose an explicit resolution outcome.')
          textField(body.resolutionSource, 'Resolution evidence or reference', 2000)
          outcome = { label: body.outcome, source: body.resolutionSource, at, actor: principal.id }
        }
        return save('finding', record.id, { ...record, status: body.status, owner: record.owner || principal.id, note, knowledge, outcome })
      }
      case 'knowledge-save': {
        const previous = body.id ? read(body.id, 'knowledge') : null
        if (!['sop', 'maintenance', 'document', 'operating-note'].includes(body.kind)) fail('Choose a supported knowledge kind.')
        const routeIds = body.routeIds ?? [], stopIds = body.stopIds ?? []
        if (!Array.isArray(routeIds) || routeIds.length > 20 || routeIds.some(id => !context.routeIndex.has(id)) || !Array.isArray(stopIds) || stopIds.length > 20 || stopIds.some(id => !context.stopIndex.has(id))) fail('Knowledge scope must use current City route and stop identities.')
        const validUntil = isoDate(body.validUntil, 'Review date')
        if (Date.parse(validUntil) <= Date.parse(at) || Date.parse(validUntil) > Date.parse(at) + 366 * 86_400_000) fail('Set a review date within the next year.')
        const procedure = procedureMetadata(body.procedure === undefined ? previous?.procedure : body.procedure)
        if (procedure && Date.parse(procedure.effectiveFrom) >= Date.parse(validUntil)) fail('Procedure validity must begin before the review date.')
        return save('knowledge', previous?.id, { title: textField(body.title, 'Title', 160), type: body.kind, body: textField(body.text, 'Knowledge text', 20_000),
          source: textField(body.source, 'Source reference', 2000), routeIds, stopIds, validUntil, procedure,
          visibility: body.visibility === 'public' ? 'public' : 'internal', status: 'draft', author: principal.id, approvedBy: null })
      }
      case 'knowledge-approve': {
        const record = read(body.id, 'knowledge')
        if (record.status !== 'draft' || Date.parse(record.validUntil) <= Date.parse(at)) fail('Only an unexpired draft can be approved.', 409)
        if (record.author === principal.id && principal.role !== 'admin') fail('A different reviewer must approve this context.', 403)
        return save('knowledge', record.id, { ...record, status: 'approved', approvedBy: principal.id, approvedAt: at })
      }
      case 'message-draft': {
        const finding = read(body.findingId, 'finding'), event = evidence(finding)
        const copy = composeMessage(event, context, body)
        const knowledge = linkKnowledge(finding.knowledge.map(link => link.id), finding.event)
        return save('message', null, { ...copy, title: event.title, findingId: finding.id, fingerprint: finding.fingerprint, event, knowledge, status: 'draft',
          author: principal.id, approvedBy: null, approvedAt: null, expiresAt: new Date(Date.parse(at) + 15 * 60_000).toISOString(), evidenceRefs: event.sourceRefs })
      }
      case 'message-edit': {
        const record = read(body.id, 'message')
        if (!['draft', 'approved'].includes(record.status)) fail('Create a new draft to change a released message.', 409)
        const expiresAt = isoDate(body.expiresAt ?? record.expiresAt, 'Message expiry')
        if (Date.parse(expiresAt) <= Date.parse(at) || Date.parse(expiresAt) > Date.parse(at) + 86_400_000) fail('Message expiry must be within the next 24 hours.')
        return save('message', record.id, { ...record, body: textField(body.text, 'Rider message', channelLimits[record.channel]), expiresAt,
          needsShortening: false, status: 'draft', author: principal.id, approvedBy: null, approvedAt: null })
      }
      case 'message-approve': {
        const record = read(body.id, 'message')
        if (record.status !== 'draft') fail('Only a draft can be approved.', 409)
        if (record.author === principal.id && principal.role !== 'admin') fail('A different reviewer must approve this copy.', 403)
        validateCopy(record)
        return save('message', record.id, { ...record, status: 'approved', approvedBy: principal.id, approvedAt: at })
      }
      case 'message-release': {
        const record = read(body.id, 'message')
        if (['released', 'delivered'].includes(record.status)) return record // Safe retry after a lost response.
        if (record.status !== 'approved') fail('Approve this exact message version before release.', 409)
        validateCopy(record)
        return save('message', record.id, { ...record, status: 'released', releasedAt: at, destination: 'local-outbox', delivery: null })
      }
      case 'message-delivery': {
        const record = read(body.id, 'message')
        if (record.status !== 'released') fail('Only a released message can be marked delivered.', 409)
        validateCopy(record)
        return save('message', record.id, { ...record, status: 'delivered', delivery: { receipt: textField(body.receipt, 'Channel receipt or public URL', 2000), at, recordedBy: principal.id } })
      }
      case 'message-withdraw': {
        const record = read(body.id, 'message')
        if (!['released', 'delivered'].includes(record.status)) fail('Only a released message can be withdrawn.', 409)
        return save('message', record.id, { ...record, status: 'withdrawn', withdrawal: { reason: textField(body.note, 'Withdrawal reason'), at, actor: principal.id },
          withdrawalNote: 'Local handoff withdrawn. Any external copy must be removed in its agency channel.' })
      }
      default: fail('Unknown operations action.')
    }
  })
}
