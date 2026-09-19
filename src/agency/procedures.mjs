import { fail, isoDate, textField } from './operations.mjs'

// Operational applicability precedes relevance. Missing metadata never implies permission.
export function procedureMetadata(value) {
  if (!value) return null
  const list = (items, name) => {
    if (!Array.isArray(items) || items.length > 20) fail(`${name} must be a list of at most 20 values.`)
    return [...new Set(items.map(item => textField(item, name, 120)))]
  }
  const limits = value.holding
  if (!limits || !['maxHoldSeconds', 'minFollowingHeadwaySeconds', 'maxDownstreamDelaySeconds'].every(key => Number.isFinite(limits[key]) && limits[key] >= 0 && limits[key] <= 3600)) fail('Holding limits must be explicit seconds between 0 and 3600.')
  return { documentId: textField(value.documentId, 'Document ID', 120), revision: textField(value.revision, 'Document revision', 80), section: textField(value.section, 'Section or page', 120),
    effectiveFrom: isoDate(value.effectiveFrom, 'Effective from'), authority: textField(value.authority, 'Escalation authority', 120),
    prerequisites: list(value.prerequisites, 'Prerequisites'), supersedes: list(value.supersedes ?? [], 'Superseded document revisions'), holding: {
      maxHoldSeconds: limits.maxHoldSeconds, minFollowingHeadwaySeconds: limits.minFollowingHeadwaySeconds, maxDownstreamDelaySeconds: limits.maxDownstreamDelaySeconds } }
}

export function applicableProcedures(records, { at, routeId, stopId, prerequisites = [] }) {
  const time = Date.parse(at)
  if (!Number.isFinite(time) || !routeId || !stopId) fail('Procedure selection needs a clock, route and control point.')
  const rejected = []
  const eligible = records.filter(record => {
    const p = record.procedure
    const reason = record.status !== 'approved' ? 'not-approved' : !p ? 'missing-procedure-metadata'
      : !(Date.parse(p.effectiveFrom) <= time && time < Date.parse(record.validUntil)) ? 'outside-effective-period'
        : !record.routeIds?.length || !record.stopIds?.length || !record.routeIds.includes(routeId) || !record.stopIds.includes(stopId) ? 'outside-control-scope'
          : !p.prerequisites.every(key => prerequisites.includes(key)) ? 'unconfirmed-prerequisite' : null
    if (reason) rejected.push({ id: record.id, reason })
    return !reason
  })
  const superseded = new Set(eligible.flatMap(record => record.procedure.supersedes))
  const applicable = eligible.filter(record => {
    if (!superseded.has(`${record.procedure.documentId}@${record.procedure.revision}`)) return true
    rejected.push({ id: record.id, reason: 'superseded' }); return false
  })
  const key = record => JSON.stringify([record.procedure.holding, record.procedure.authority, [...record.procedure.prerequisites].sort()])
  return { applicable, rejected, conflict: new Set(applicable.map(key)).size > 1 }
}

export function procedureResult(selection, ranked) {
  return { status: selection.conflict ? 'conflict' : ranked.length ? 'applicable' : 'unavailable',
    records: ranked.slice(0, 5).map(record => ({ ...record, appliesBecause: 'Approved, effective at this replay time, covers this route and control point; all recorded prerequisites are confirmed.' })),
    rejected: selection.rejected, conflictIds: selection.conflict ? selection.applicable.map(record => record.id) : [],
    note: selection.conflict ? 'Applicable procedures disagree. Escalate to the named authority before selecting a hold.' : 'Text relevance cannot override scope, effective period or approval.' }
}
