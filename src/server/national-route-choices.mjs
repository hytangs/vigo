import { numeric } from './number-utils.mjs'

export function nationalRideBoardingSummary(planOrLegs) {
  const legs = Array.isArray(planOrLegs) ? planOrLegs : planOrLegs?.legs ?? []
  const routeSequence = []
  const publicLabels = []
  let boardingCount = 0
  for (const leg of legs) {
    if (leg?.type !== 'ride') continue
    boardingCount += 1
    const routeId = String(leg.routeId || leg.routeShortName || leg.routeFeatureId || '').trim()
    if (routeId) routeSequence.push(routeId)
    const publicLabel = String(leg.routeShortName || leg.routeId || leg.routeFeatureId || '').trim()
    if (publicLabel) publicLabels.push(publicLabel)
  }
  return {
    boardingCount,
    transfers: Math.max(0, boardingCount - 1),
    routeSequence,
    publicLabels,
    title: publicLabels.join(' -> '),
  }
}

export function nationalPublicRouteSequence(plan) {
  const sequence = nationalRideBoardingSummary(plan).routeSequence
  if (sequence.length) return sequence.join('>')
  const mode = String(plan?.travelMode || '').trim()
  if (mode) return mode
  return `unknown:${String(plan?.id || '')}`
}

function nationalChoicePublicFamily(plan) {
  const labels = nationalRideBoardingSummary(plan).publicLabels
    .filter((label, index, all) => index === 0 || label !== all[index - 1])
  return labels.length ? labels.join('>') : nationalPublicRouteSequence(plan)
}

export function nationalChoiceIdentity(plan) {
  const rides = (plan?.legs ?? [])
    .filter((leg) => leg?.type === 'ride')
    .map((leg) => [
      String(leg.routeId || leg.routeShortName || leg.routeFeatureId || '').trim(),
      String(leg.fromStopId || leg.fromName || '').trim(),
      String(leg.toStopId || leg.toName || '').trim(),
    ].join(':'))
    .join('|')
  return rides || nationalPublicRouteSequence(plan)
}

export function selectNationalAlternativeWaypointGroups(candidates, options = {}) {
  const preferredWalkKm = Math.max(0, numeric(options.preferredWalkKm, 0))
  const alternativeWalkKm = Math.max(preferredWalkKm, numeric(options.alternativeWalkKm, preferredWalkKm))
  const limit = Math.max(0, Math.min(24, Math.floor(numeric(options.limit, 6))))
  const includeInsidePreferred = options.includeInsidePreferred === true
  if (!limit || alternativeWalkKm <= preferredWalkKm + 0.01) return []
  const groups = new Map()
  for (const candidate of candidates ?? []) {
    const distanceKm = numeric(candidate?.distanceKm, Number.POSITIVE_INFINITY)
    if (
      !Number.isFinite(distanceKm)
      || (!includeInsidePreferred && distanceKm <= preferredWalkKm + 0.01)
      || distanceKm > alternativeWalkKm + 1e-9
    ) continue
    const priority = String(candidate?.accessPriority ?? '').trim()
    const parentStation = String(candidate?.parent_station ?? '').trim()
    if (!priority && !parentStation) continue
    const key = priority || `station:${parentStation}`
    const current = groups.get(key) ?? { key, candidates: [], distanceKm }
    current.candidates.push(candidate)
    current.distanceKm = Math.min(current.distanceKm, distanceKm)
    groups.set(key, current)
  }
  return [...groups.values()]
    .sort((left, right) => left.distanceKm - right.distanceKm || left.key.localeCompare(right.key))
    .slice(0, limit)
    .map((group) => {
      const ranked = group.candidates
        .sort((left, right) => numeric(left.distanceKm) - numeric(right.distanceKm) || String(left.stop_id).localeCompare(String(right.stop_id)))
      const candidate = ranked[0]
      return {
        key: group.key,
        name: candidate?.name || candidate?.stop_id || group.key,
        distanceKm: group.distanceKm,
        stopIds: ranked.map((item) => item.stop_id),
        candidate,
        candidates: ranked,
      }
    })
}

function choiceMetric(plan, field, fallback = Number.POSITIVE_INFINITY) {
  const value = Number(plan?.[field])
  return Number.isFinite(value) ? value : fallback
}

function compareChoiceIdentity(left, right) {
  return String(left?.id ?? '').localeCompare(String(right?.id ?? ''))
}

function choiceJourneyMinutes(plan) {
  const departMinutes = choiceMetric(plan, 'departMinutes')
  const arriveMinutes = Number(plan?.arriveMinutes)
  if (Number.isFinite(arriveMinutes) && arriveMinutes >= departMinutes) return arriveMinutes - departMinutes
  return choiceMetric(plan, 'durationMinutes')
}

function choiceTotalElapsedMinutes(plan, centerMinutes) {
  const startWaitMinutes = Math.max(0, choiceMetric(plan, 'departMinutes') - centerMinutes)
  return choiceJourneyMinutes(plan) + startWaitMinutes
}

function rideEndpointGroup(leg, side, stationGroupForStopId) {
  const explicitGroup = String(leg?.[`${side}StationGroupId`] ?? '').trim()
  if (explicitGroup) return explicitGroup
  const stopId = String(leg?.[`${side}StopId`] ?? '').trim()
  if (!stopId) return ''
  const resolvedGroup = typeof stationGroupForStopId === 'function'
    ? String(stationGroupForStopId(stopId) ?? '').trim()
    : ''
  return resolvedGroup || stopId
}

export function nationalRoutingReturnedRideCycle(plan, { stationGroupForStopId } = {}) {
  const seen = new Map()
  let previousGroup = null, rideIndex = -1
  for (const [legIndex, leg] of (plan?.legs ?? []).entries()) {
    if (leg?.type !== 'ride') continue
    rideIndex += 1
    const stops = leg.stopIds?.length ? leg.stopIds : [leg.fromStopId, leg.toStopId]
    for (const [index, rawStopId] of stops.entries()) {
      const stopId = String(rawStopId ?? '').trim()
      const group = (stopId && stationGroupForStopId?.(stopId))
        || (index === 0 ? rideEndpointGroup(leg, 'from', stationGroupForStopId)
          : index === stops.length - 1 ? rideEndpointGroup(leg, 'to', stationGroupForStopId) : stopId)
      if (!group || group === previousGroup) continue
      const first = seen.get(group)
      if (first) return {
        firstLegIndex: first.legIndex, lastLegIndex: legIndex,
        firstRideIndex: first.rideIndex, lastRideIndex: rideIndex,
        departureStopId: first.stopId, returnedStopId: stopId,
        stationGroupId: group, exactStopReturn: Boolean(stopId && first.stopId === stopId),
        cycleBoardings: rideIndex - first.rideIndex + 1,
        ...(first.rideIndex === rideIndex ? { withinSingleRide: true } : {}),
      }
      seen.set(group, { stopId, legIndex, rideIndex })
      previousGroup = group
    }
  }
  return null
}

function compareFastestChoice(left, right, centerMinutes) {
  return choiceTotalElapsedMinutes(left, centerMinutes) - choiceTotalElapsedMinutes(right, centerMinutes)
    || choiceJourneyMinutes(left) - choiceJourneyMinutes(right)
    || choiceMetric(left, 'transfers') - choiceMetric(right, 'transfers')
    || choiceMetric(left, 'walkMinutes') - choiceMetric(right, 'walkMinutes')
    || Math.abs(choiceMetric(left, 'departMinutes') - centerMinutes) - Math.abs(choiceMetric(right, 'departMinutes') - centerMinutes)
    || choiceMetric(right, 'departMinutes') - choiceMetric(left, 'departMinutes')
    || compareChoiceIdentity(left, right)
}

function compareFewestTransfersChoice(left, right, centerMinutes) {
  return choiceMetric(left, 'transfers') - choiceMetric(right, 'transfers')
    || choiceTotalElapsedMinutes(left, centerMinutes) - choiceTotalElapsedMinutes(right, centerMinutes)
    || choiceJourneyMinutes(left) - choiceJourneyMinutes(right)
    || choiceMetric(left, 'walkMinutes') - choiceMetric(right, 'walkMinutes')
    || Math.abs(choiceMetric(left, 'departMinutes') - centerMinutes) - Math.abs(choiceMetric(right, 'departMinutes') - centerMinutes)
    || compareChoiceIdentity(left, right)
}

function compareLeastWalkingChoice(left, right, centerMinutes) {
  return choiceMetric(left, 'walkMinutes') - choiceMetric(right, 'walkMinutes')
    || choiceTotalElapsedMinutes(left, centerMinutes) - choiceTotalElapsedMinutes(right, centerMinutes)
    || choiceJourneyMinutes(left) - choiceJourneyMinutes(right)
    || choiceMetric(left, 'transfers') - choiceMetric(right, 'transfers')
    || Math.abs(choiceMetric(left, 'departMinutes') - centerMinutes) - Math.abs(choiceMetric(right, 'departMinutes') - centerMinutes)
    || compareChoiceIdentity(left, right)
}

export function nationalChoiceStrictlyDominates(left, right, centerMinutes) {
  const leftDuration = choiceTotalElapsedMinutes(left, centerMinutes)
  const rightDuration = choiceTotalElapsedMinutes(right, centerMinutes)
  const leftJourney = choiceJourneyMinutes(left)
  const rightJourney = choiceJourneyMinutes(right)
  const leftTransfers = choiceMetric(left, 'transfers')
  const rightTransfers = choiceMetric(right, 'transfers')
  const leftWalk = choiceMetric(left, 'walkMinutes')
  const rightWalk = choiceMetric(right, 'walkMinutes')
  const noWorse = (
    leftDuration <= rightDuration
    && leftJourney <= rightJourney
    && leftTransfers <= rightTransfers
    && leftWalk <= rightWalk
  )
  const meaningfullyBetter = (
    leftDuration < rightDuration
    || leftJourney < rightJourney
    || leftTransfers < rightTransfers
    || leftWalk < rightWalk
  )
  return noWorse && meaningfullyBetter
}

function satisfiesLinearChoiceConstraints(point, constraints) {
  if (
    !point
    || point.journeyWeight < 0
    || point.transferPenaltyMinutes < 0
    || point.walkingReluctance < 0
  ) return false
  for (const { journeyCoefficient, transferCoefficient, walkCoefficient, upperBound } of constraints) {
    const value = journeyCoefficient * point.journeyWeight
      + transferCoefficient * point.transferPenaltyMinutes
      + walkCoefficient * point.walkingReluctance
    const numericalTolerance = Number.EPSILON * 64 * Math.max(
      1,
      Math.abs(value),
      Math.abs(upperBound),
    )
    if (!(value <= upperBound + numericalTolerance)) return false
  }
  return true
}

function intersectionOfChoiceConstraints(left, middle, right) {
  const { journeyCoefficient: a, transferCoefficient: b, walkCoefficient: c, upperBound: x } = left
  const { journeyCoefficient: d, transferCoefficient: e, walkCoefficient: f, upperBound: y } = middle
  const { journeyCoefficient: g, transferCoefficient: h, walkCoefficient: i, upperBound: z } = right
  // Cramer's rule, with the same operation order and tolerance as the matrix
  // form. Avoid allocating four matrices for every candidate intersection.
  const determinant = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
  if (Math.abs(determinant) <= Number.EPSILON * 128) return null
  const point = {
    journeyWeight: (x * (e * i - f * h) - b * (y * i - f * z) + c * (y * h - e * z)) / determinant,
    transferPenaltyMinutes: (a * (y * i - f * z) - x * (d * i - f * g) + c * (d * z - y * g)) / determinant,
    walkingReluctance: (a * (e * z - y * h) - b * (d * z - y * g) + x * (d * h - e * g)) / determinant,
  }
  return Number.isFinite(point.journeyWeight)
    && Number.isFinite(point.transferPenaltyMinutes)
    && Number.isFinite(point.walkingReluctance) ? point : null
}

/**
 * Return a witness showing that `candidate` minimizes
 *
 *   elapsed
 *     + journeyWeight * journey
 *     + transferPenalty * transfers
 *     + walkingReluctance * walk
 *
 * over the supplied exact Pareto set for at least one nonnegative weight
 * vector. Feasibility is an exact three-variable half-space intersection:
 * the origin and every triple boundary intersection are tested. No city,
 * duration, transfer, or walking threshold enters the decision.
 */
export function nationalChoiceSupportedBurdenWeights(candidate, choices, centerMinutes) {
  const constraints = [
    { journeyCoefficient: -1, transferCoefficient: 0, walkCoefficient: 0, upperBound: 0 },
    { journeyCoefficient: 0, transferCoefficient: -1, walkCoefficient: 0, upperBound: 0 },
    { journeyCoefficient: 0, transferCoefficient: 0, walkCoefficient: -1, upperBound: 0 },
  ]
  const candidateElapsed = choiceTotalElapsedMinutes(candidate, centerMinutes)
  const candidateJourney = choiceJourneyMinutes(candidate)
  const candidateTransfers = choiceMetric(candidate, 'transfers')
  const candidateWalk = choiceMetric(candidate, 'walkMinutes')
  for (const other of choices ?? []) {
    if (other === candidate) continue
    constraints.push({
      journeyCoefficient: candidateJourney - choiceJourneyMinutes(other),
      transferCoefficient: candidateTransfers - choiceMetric(other, 'transfers'),
      walkCoefficient: candidateWalk - choiceMetric(other, 'walkMinutes'),
      upperBound: choiceTotalElapsedMinutes(other, centerMinutes) - candidateElapsed,
    })
  }

  const origin = { journeyWeight: 0, transferPenaltyMinutes: 0, walkingReluctance: 0 }
  if (satisfiesLinearChoiceConstraints(origin, constraints)) return origin
  for (let leftIndex = 0; leftIndex < constraints.length; leftIndex += 1) {
    const left = constraints[leftIndex]
    for (let middleIndex = leftIndex + 1; middleIndex < constraints.length; middleIndex += 1) {
      const middle = constraints[middleIndex]
      for (let rightIndex = middleIndex + 1; rightIndex < constraints.length; rightIndex += 1) {
        const right = constraints[rightIndex]
        const point = intersectionOfChoiceConstraints(left, middle, right)
        // Keep the same deterministic witness order, but stop as soon as a
        // supporting weight is found instead of allocating every intersection.
        if (satisfiesLinearChoiceConstraints(point, constraints)) return point
      }
    }
  }

  return null
}

export function selectNationalDepartureWindowChoices(plans, { centerMinutes, limit = 5 } = {}) {
  const selectedMinutes = Number.isFinite(Number(centerMinutes)) ? Number(centerMinutes) : 0
  const choiceLimit = Math.max(1, Math.min(5, Math.floor(Number(limit) || 5)))
  const readyPlans = (plans ?? []).filter((plan) => plan?.status === 'ready')
  const representativeBySequence = new Map()
  for (const plan of readyPlans) {
    const sequence = nationalChoiceIdentity(plan)
    const current = representativeBySequence.get(sequence)
    if (!current) {
      representativeBySequence.set(sequence, plan)
      continue
    }
    const planIsExact = Math.abs(choiceMetric(plan, 'departMinutes') - selectedMinutes) < 1e-6
    const currentIsExact = Math.abs(choiceMetric(current, 'departMinutes') - selectedMinutes) < 1e-6
    if ((planIsExact && !currentIsExact)
      || (planIsExact === currentIsExact && compareFastestChoice(plan, current, selectedMinutes) < 0)) {
      representativeBySequence.set(sequence, plan)
    }
  }

  const allRepresentatives = [...representativeBySequence.values()]
    .sort((left, right) => compareFastestChoice(left, right, selectedMinutes))
  // Re-entering a station can be required by directed platforms, transfer
  // prohibitions or a scheduled circulator. Only dominance removes a journey;
  // a geometric or station-name cycle is not a feasibility rule.
  const paretoRepresentatives = allRepresentatives.filter((candidate) => (
    !allRepresentatives.some((other) => (
      other !== candidate
      && nationalChoiceStrictlyDominates(other, candidate, selectedMinutes)
    ))
  ))
  const supportWeights = new Map()
  for (const candidate of paretoRepresentatives) {
    const weights = nationalChoiceSupportedBurdenWeights(
      candidate,
      paretoRepresentatives,
      selectedMinutes,
    )
    if (weights) supportWeights.set(candidate, weights)
  }
  const representatives = paretoRepresentatives.filter((candidate) => supportWeights.has(candidate))
  representatives.sort((left, right) => compareFastestChoice(left, right, selectedMinutes))
  if (!representatives.length) return []

  const fastest = representatives[0]
  const shortestJourney = [...representatives]
    .sort((left, right) => choiceJourneyMinutes(left) - choiceJourneyMinutes(right)
      || compareFastestChoice(left, right, selectedMinutes))[0]
  const fewestTransfers = [...representatives]
    .sort((left, right) => compareFewestTransfersChoice(left, right, selectedMinutes))[0]
  const leastWalking = [...representatives]
    .sort((left, right) => compareLeastWalkingChoice(left, right, selectedMinutes))[0]
  const exact = representatives.find((plan) => Math.abs(choiceMetric(plan, 'departMinutes') - selectedMinutes) < 1e-6)
  const selected = []
  const addDistinctPublicFamily = (plan) => {
    if (!plan || selected.includes(plan) || selected.length >= choiceLimit) return
    const family = nationalChoicePublicFamily(plan)
    if (selected.some((choice) => nationalChoicePublicFamily(choice) === family)) return
    selected.push(plan)
  }
  for (const plan of [fastest, shortestJourney, fewestTransfers, leastWalking]) {
    addDistinctPublicFamily(plan)
  }
  if (exact && !selected.includes(exact)) {
    const sameFamilyIndex = selected.findIndex((plan) => nationalChoicePublicFamily(plan) === nationalChoicePublicFamily(exact))
    if (sameFamilyIndex >= 0) selected[sameFamilyIndex] = exact
    else if (selected.length >= choiceLimit) selected[selected.length - 1] = exact
    else selected.push(exact)
  }
  for (const plan of representatives) {
    addDistinctPublicFamily(plan)
  }
  // Never refill the product list from the pre-dominance pool merely to reach
  // the display limit. Different boarding stations on the same public line may
  // still be real choices, but only when each one survives the measured
  // elapsed-time / journey-time / transfer / walking frontier.
  for (const plan of representatives) {
    if (selected.length >= choiceLimit) break
    if (!selected.includes(plan)) selected.push(plan)
  }

  const orderedSelected = [...selected]
    .sort((left, right) => compareFastestChoice(left, right, selectedMinutes))
  const recommendedPlan = orderedSelected[0]
  // Metric labels describe the nondominated choices the user can actually see.
  const visibleFastest = [...orderedSelected]
    .sort((left, right) => compareFastestChoice(left, right, selectedMinutes))[0]
  const visibleShortestJourney = [...orderedSelected]
    .sort((left, right) => choiceJourneyMinutes(left) - choiceJourneyMinutes(right)
      || compareFastestChoice(left, right, selectedMinutes))[0]
  const visibleFewestTransfers = [...orderedSelected]
    .sort((left, right) => compareFewestTransfersChoice(left, right, selectedMinutes))[0]
  const visibleLeastWalking = [...orderedSelected]
    .sort((left, right) => compareLeastWalkingChoice(left, right, selectedMinutes))[0]
  let alternate = 0
  return orderedSelected.map((plan) => {
    let choiceLabel
    if (plan?.travelMode === 'walk') choiceLabel = 'Walk only'
    else if (plan === visibleFastest) choiceLabel = 'Fastest'
    else if (plan === visibleShortestJourney) choiceLabel = 'Shortest journey'
    else if (plan === visibleFewestTransfers) choiceLabel = 'Fewest transfers'
    else if (plan === visibleLeastWalking) choiceLabel = 'Least walking'
    else if (plan === recommendedPlan) choiceLabel = 'Best balance'
    else {
      alternate += 1
      choiceLabel = alternate === 1 ? 'Alternate' : `Alternate ${alternate}`
    }
    const selectedTimeChoice = Math.abs(choiceMetric(plan, 'departMinutes') - selectedMinutes) < 1e-6
    return {
      ...plan,
      choiceLabel,
      recommended: plan === recommendedPlan,
      diagnostics: {
        ...plan.diagnostics,
        selectedTimeChoice,
        choiceSupport: {
          objective: 'elapsed_plus_journey_plus_weighted_transfers_plus_weighted_walking',
          elapsedWeight: 1,
          journeyWeight: supportWeights.get(plan)?.journeyWeight ?? 0,
          transferPenaltyMinutesPerTransfer:
            supportWeights.get(plan)?.transferPenaltyMinutes ?? 0,
          walkingReluctance: supportWeights.get(plan)?.walkingReluctance ?? 0,
          nonnegativeWeightFeasibility: 'exact_half_plane_intersection',
        },
      },
    }
  })
}
