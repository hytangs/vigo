// Recognize explicit numeric clocks without guessing departure versus arrival.
export function explicitClocks(question) {
  const clocks = []
  for (const match of String(question).matchAll(/\b(\d{1,2})(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)?(?!\w)/gi)) {
    if (!match[2] && !match[3]) continue
    let hour = Number(match[1])
    if (match[3]) {
      if (hour < 1 || hour > 12) continue
      hour = hour % 12 + (match[3].toLowerCase().startsWith('p') ? 12 : 0)
    }
    if (hour > 48 || hour === 48 && Number(match[2] || 0)) continue
    clocks.push(`${String(hour).padStart(2, '0')}:${match[2] || '00'}`)
  }
  return [...new Set(clocks)]
}

export function assertRequestedClock(question, args) {
  const clocks = explicitClocks(question)
  if (!clocks.length) return
  const requested = args.departTime || args.arriveBy
  if (!requested || !clocks.includes(requested)) throw new Error(`The user explicitly supplied ${clocks.join(' / ')}. Use that clock in when.departTime or when.arriveBy; do not use now or omit the time. If departure versus arrival is unclear, ask which they mean.`)
}

const minutes = clock => clock ? clock.split(':').reduce((hours, part) => hours * 60 + Number(part), 0) : null
export function journeyTimeFacts(plan, request) {
  let cursor = plan.departMinutes, initialWaitMinutes = null, firstVehicleDepartureMinutes = null
  for (const leg of plan.legs || []) {
    if (leg.type === 'ride') {
      firstVehicleDepartureMinutes = leg.startMinutes
      initialWaitMinutes = Number.isFinite(cursor) && Number.isFinite(leg.startMinutes) ? Math.max(0, leg.startMinutes - cursor) : null
      break
    }
    cursor = leg.endMinutes
  }
  return { requestedDeparture: request.departTime, requestedArrival: request.arriveBy,
    actualDepartureMinutes: plan.departMinutes, actualArrivalMinutes: plan.arriveMinutes,
    firstVehicleDepartureMinutes, initialWaitMinutes,
    ...(initialWaitMinutes > 60 ? { warning: `Unusually long initial wait: ${Math.round(initialWaitMinutes)} minutes. Check the requested time and timetable coverage before relying on this itinerary.` } : {}) }
}

export function journeyTimeIssue(plan, request = {}) {
  if (!plan?.legs?.length) return null
  if (request.departTime && request.arriveBy) return 'A journey cannot have both a departure time and an arrival deadline.'
  const departure = minutes(request.departTime), arrival = minutes(request.arriveBy)
  if (departure !== null && [plan.departMinutes, ...plan.legs.map(leg => leg.startMinutes)].some(time => Number.isFinite(time) && time < departure - .002)) return `The itinerary starts before the requested departure ${request.departTime}. Calculate it again with the correct time.`
  if (arrival !== null && [plan.arriveMinutes, ...plan.legs.map(leg => leg.endMinutes)].some(time => Number.isFinite(time) && time > arrival + .002)) return `The itinerary misses the requested arrival deadline ${request.arriveBy}. Calculate it again with the correct time.`
  return null
}
