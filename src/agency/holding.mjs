// Finite-horizon holding comparison. Not a field-validated controller or dispatch command.
export function compareHolding(input, procedure, { signal, deadline = performance.now() + 250 } = {}) {
  const check = () => { signal?.throwIfAborted(); if (performance.now() > deadline) throw new Error('Holding comparison deadline exceeded.') }
  check()
  const unknown = reason => ({ status: 'unavailable', reason, candidates: [], selectedId: null, simulated: true })
  if (procedure.status !== 'applicable') return unknown(procedure.note || 'An applicable procedure is required.')
  if (input.problems.length) return unknown(input.problems.join(' '))
  const p = procedure.records[0].procedure, stops = input.downstream
  if (![input.frontSeconds, input.scheduledHeadwaySeconds].every(value => Number.isFinite(value) && value > 0)
    || ![p.holding.maxHoldSeconds, p.holding.minFollowingHeadwaySeconds, p.holding.maxDownstreamDelaySeconds].every(value => Number.isFinite(value) && value >= 0 && value <= 3600)) return unknown('Headways and control limits must be explicit finite values.')
  if (!stops.length || stops.length > 50 || !Number.isFinite(input.onboardPassengers) || input.onboardPassengers < 0 || input.onboardPassengers > 200) return unknown('Confirmed model inputs for passenger load and downstream stops are missing.')
  if (!stops.every(s => [s.frontSeconds, s.backSeconds, s.currentDelaySeconds, s.arrivalsPerSecond].every(Number.isFinite) && s.frontSeconds > 0 && s.backSeconds > 0 && s.arrivalsPerSecond >= 0 && s.arrivalsPerSecond <= 10)) return unknown('Downstream ordering or passenger arrival inputs cannot be established.')
  const maximum = Math.floor(Math.min(p.holding.maxHoldSeconds, ...stops.map(s => s.backSeconds - p.holding.minFollowingHeadwaySeconds), ...stops.map(s => p.holding.maxDownstreamDelaySeconds - s.currentDelaySeconds)))
  if (maximum < 0) return unknown('Existing predictions already breach the procedure’s following-gap or downstream-delay constraint; holding cannot repair that constraint. Escalate.')
  const arrivalRate = stops.reduce((sum, s) => sum + s.arrivalsPerSecond, 0)
  // Integral of wait over two adjacent headways, with stationary uniform arrivals.
  // J(h)=Σ λ/2 [(front+h)^2+(back-h)^2] + onboard*h. Convex in h.
  const unconstrained = arrivalRate ? (stops.reduce((sum, s) => sum + s.arrivalsPerSecond * (s.backSeconds - s.frontSeconds), 0) - input.onboardPassengers) / (2 * arrivalRate) : 0
  const clamp = h => Math.max(0, Math.min(maximum, h))
  const cost = h => stops.reduce((sum, s) => sum + s.arrivalsPerSecond / 2 * ((s.frontSeconds + h) ** 2 + (s.backSeconds - h) ** 2), input.onboardPassengers * h)
  if (![cost(0), cost(maximum)].every(Number.isFinite)) return unknown('Passenger-time calculation exceeds finite numeric bounds.')
  const optimum = [...new Set([0, maximum, clamp(Math.floor(unconstrained)), clamp(Math.ceil(unconstrained))])].sort((a, b) => cost(a) - cost(b) || a - b)[0]
  const baseline = clamp(Math.max(0, Math.round(input.scheduledHeadwaySeconds - input.frontSeconds)))
  const candidates = [['none', 'No additional hold', 0], ['target-headway', 'Target-headway baseline', baseline], ['minimum-passenger-time', 'Passenger-time comparison', optimum]].map(([id, label, seconds]) => {
    check()
    return { id, label, holdSeconds: seconds, feasible: true, modeledPassengerMinutes: cost(seconds) / 60, changePassengerMinutes: (cost(seconds) - cost(0)) / 60,
      onboardExtraPassengerMinutes: input.onboardPassengers * seconds / 60,
      downstream: stops.map(s => ({ stopId: s.stopId, stopName: s.stopName, frontSeconds: s.frontSeconds + seconds, backSeconds: s.backSeconds - seconds, delaySeconds: s.currentDelaySeconds + seconds })) }
  })
  return { status: 'ready', simulated: true, candidates, selectedId: optimum ? 'minimum-passenger-time' : 'none', maximumHoldSeconds: maximum,
    procedureRefs: procedure.records.map(r => ({ id: r.id, version: r.version, documentId: r.procedure.documentId, revision: r.procedure.revision, section: r.procedure.section })),
    assumptions: input.assumptions, limits: ['Simulated passenger time over two headways at the listed downstream stops; not whole-route or observed benefit.',
      'Holding shifts only the selected bus. Fixed running times, no overtaking, unlimited boarding capacity, no new riders boarding during the control-point hold.',
      'No causal incident explanation, recovery forecast, alternative route or accessible journey is established.'],
    authority: p.authority }
}
