import assert from 'node:assert/strict'
import { routeOrderedRoutingSegments } from '../src/server/ordered-route-composition.mjs'

const points = Array.from({ length: 8 }, (_, i) => ({ label: `Point ${i}`, coordinate: [-77 + i * 0.01, 38] }))
const tuple = (plan, reverse) => [reverse ? -plan.departMinutes : plan.arriveMinutes,
  plan.legs.filter(leg => leg.type === 'ride').length, plan.walkMinutes]
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]

function candidates(edge, request, index) {
  assert.notEqual(request.requireTransitRide, true, 'Transit must admit a walking waypoint segment')
  assert.equal(request.departureWindowMinutes, 0, 'Do not resample a departure window at every waypoint')
  assert.equal(request.includeEarliestTransit, false, 'Do not launch discarded transit-only probes')
  const reverse = request.timePreference === 'arrive'
  const clock = reverse ? request.arriveMinutes : request.departMinutes
  const plans = []
  function add(type, start, end, id) {
    const departure = reverse ? start : clock
    plans.push({ id: `${index}-${id}-${departure}-${end}`, status: 'ready', travelMode: type === 'ride' ? 'transit' : 'walk',
      origin: request.origin, destination: request.destination, departMinutes: departure, arriveMinutes: end,
      durationMinutes: end - departure, walkMinutes: type === 'walk' ? end - start : 0,
      legs: [{ type, startMinutes: start, endMinutes: end, durationMinutes: end - start, distanceKm: 1,
        fromName: request.origin.label, toName: request.destination.label,
        routeId: `${index}-${id}`, tripId: `${index}-${id}`, coordinates: [request.origin.coordinate, request.destination.coordinate] }],
      diagnostics: {},
    })
  }
  if (Number.isFinite(edge.walk)) add('walk', reverse ? clock - edge.walk : clock, reverse ? clock : clock + edge.walk, 'walk')
  for (const [id, [start, end]] of edge.rides.entries()) {
    if (reverse ? end <= clock : start >= clock) add('ride', start, end, id)
  }
  plans.sort((a, b) => compare(tuple(a, reverse), tuple(b, reverse)))
  return { plan: plans[0] ?? { status: 'blocked', detail: 'No connection', legs: [] }, choices: plans }
}

async function route(edges, reverse = false, clock = reverse ? 40 : 0) {
  let calls = 0
  const seen = new Set()
  const result = await routeOrderedRoutingSegments(points.slice(0, edges.length + 1), {
    mode: 'transit', timePreference: reverse ? 'arrive' : 'depart', departMinutes: clock, arriveMinutes: clock,
  }, (request, index) => {
    const key = `${index}:${reverse ? request.arriveMinutes : request.departMinutes}`
    assert(!seen.has(key), 'Identical continuation clocks must reuse the same segment query')
    seen.add(key); calls += 1
    return candidates(edges[index], request, index)
  })
  assert(calls <= 1 + 8 * (edges.length - 1), 'Work must stay bounded with eight ordered points')
  return result
}

const waits = [{ walk: 5, rides: [[1, 4]] }, { walk: 100, rides: [[10, 20]] }]
const lessBoarding = await route(waits)
assert.deepEqual(tuple(lessBoarding.choices[0], false), [20, 1, 5], 'A later walk catches the same onward bus and removes a boarding')
assert.deepEqual(lessBoarding.choices[0].legs.map(leg => leg.type), ['walk', 'ride'])
assert(lessBoarding.choices.some(plan => plan.legs.length === 2 && plan.legs.every(leg => leg.type === 'ride')),
  'Retain the less-walking alternative alongside the one-boarding recommendation')

const backwards = await route([{ walk: 100, rides: [[5, 10]] }, { walk: 5, rides: [[12, 14]] }], true, 20)
assert.deepEqual(tuple(backwards.choices[0], true), [-5, 1, 5], 'A reverse search also retains a walk after the fixed incoming bus')
const fractional = await route([{ walk: 5.125, rides: [] }, { walk: 4.375, rides: [] }])
assert.deepEqual(tuple(fractional.choices[0], false), [9.5, 0, 9.5])
assert.equal(fractional.choices[0].travelMode, 'walk')
assert.equal(fractional.choices[0].title, 'Walk via 1 stop')
assert.equal(fractional.choices[0].legs[1].startMinutes, 5.125)
assert.equal((await route([{ walk: 1, rides: [] }, { walk: Infinity, rides: [] }])).failedIndex, 1)

// Exhaustive raw schedule enumeration is independent of production frontier
// pruning. Both directions must match all time/boarding/walking ties here.
function oracle(edges, reverse, clock) {
  let best
  function visit(index, time, boardings, walking) {
    if (index < 0 || index === edges.length) {
      const value = [reverse ? -time : time, boardings, walking]
      if (!best || compare(value, best) < 0) best = value
      return
    }
    const edge = edges[index], next = index + (reverse ? -1 : 1)
    visit(next, time + (reverse ? -edge.walk : edge.walk), boardings, walking + edge.walk)
    for (const [departure, arrival] of edge.rides) {
      if (reverse ? arrival <= time : departure >= time) visit(next, reverse ? departure : arrival, boardings + 1, walking)
    }
  }
  visit(reverse ? edges.length - 1 : 0, clock, 0, 0)
  return best
}
let seed = 500
const random = maximum => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % maximum }
for (let fixture = 0; fixture < 100; fixture += 1) {
  const edges = Array.from({ length: 2 }, () => ({ walk: 2 + random(12), rides: Array.from({ length: 3 }, () => {
    const departure = random(25); return [departure, departure + 1 + random(10)]
  }) }))
  for (const reverse of [false, true]) {
    const clock = reverse ? 40 : 0
    const result = await route(edges, reverse, clock)
    assert.deepEqual(tuple(result.choices[0], reverse), oracle(edges, reverse, clock), `Independent oracle ${fixture}, reverse=${reverse}`)
  }
}
for (const reverse of [false, true]) {
  const result = await route(Array.from({ length: 7 }, (_, i) => ({ walk: 5, rides: [[i * 5 + 1, i * 5 + 4], [i * 5 + 2, i * 5 + 4]] })), reverse)
  assert(result.choices.length <= 5)
  assert(result.choices[0].diagnostics.orderedSearch.peakCandidates <= 8)
  assert.equal(result.choices[0].waypoints.length, 6)
}
console.log('Multi-stop routing: walking, shared onward rides, both clock directions, 200 independent oracle comparisons, eight-point query bounds passed.')
