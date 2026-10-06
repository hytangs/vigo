// Optional GTFS pathway fields describe different kinds of movement. A stair
// count is usable routing input even when horizontal length is unavailable.
// These are explicit model assumptions, never published traversal times.
export const pathwayCostModel = Object.freeze({
  id: 'stairs-one-second-per-step-gates-five-seconds-v1',
  secondsPerStair: 1,
  gateSeconds: 5,
})

export function estimatedPathwaySeconds(row) {
  const mode = Number(row.pathway_mode)
  const text = String(row.stair_count ?? '').trim()
  if (mode === 2 && text) {
    const count = Number(text)
    if (!Number.isSafeInteger(count) || count === 0) {
      throw new Error(`Invalid GTFS pathway stair_count: ${row.pathway_id}`)
    }
    return Math.ceil(Math.abs(count) * pathwayCostModel.secondsPerStair)
  }
  if (mode === 6 || mode === 7) return pathwayCostModel.gateSeconds
  return null
}
