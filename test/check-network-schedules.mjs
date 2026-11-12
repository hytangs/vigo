// Full-day vehicle schedules wait for each feed's timetable store and count
// failed routes without stopping the rest of the day.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { transformWithOxc } from 'vite'

const source = new URL('../src/app/networkSchedule.ts', import.meta.url)
const code = (await transformWithOxc(await readFile(source, 'utf8'), source.pathname, { target: 'es2022' })).code
const { readyScheduleFeeds, scheduleFeedReady, loadNetworkSchedules } = await import(`data:text/javascript,${encodeURIComponent(code)}`)

const feeds = [
  { id: 'mbta', routingStore: { status: 'ready' } },
  { id: 'ferry', routingStore: { status: 'building' } },
  { id: 'commuter' },
]
// An importing City: only the feed whose store is written can be read.
const importing = readyScheduleFeeds({ feeds, routingStore: { status: 'building' } })
assert.equal(importing, 'mbta')
assert.equal(scheduleFeedReady(importing, 'mbta'), true)
assert.equal(scheduleFeedReady(importing, 'ferry'), false)
assert.equal(scheduleFeedReady(importing, 'commuter'), false)
assert.equal(readyScheduleFeeds({ feeds: feeds.slice(1) }), '', 'No ready store: nothing to load yet')
assert.equal(scheduleFeedReady('', 'mbta'), false)
// The combined City timetable answers every feed.
const combined = readyScheduleFeeds({ feeds, routingStore: { status: 'ready' } })
assert.equal(combined, '*')
assert.equal(scheduleFeedReady(combined, 'ferry'), true)
// The key does not depend on feed order.
assert.equal(readyScheduleFeeds({ feeds: [{ id: 'b', routingStore: { status: 'ready' } }, { id: 'a', routingStore: { status: 'ready' } }] }), 'a\nb')

// A failed route is counted; the others still load.
const progress = []
await loadNetworkSchedules([1, 2, 3, 4, 5], async n => {
  if (n % 2 === 0) throw new Error(`route ${n} unavailable`)
  return n * 10
}, (results, completed, failures) => progress.push({ results, completed, failures }), new AbortController().signal, 2)
assert.deepEqual(progress, [
  { results: [10], completed: 2, failures: 1 },
  { results: [30], completed: 4, failures: 2 },
  { results: [50], completed: 5, failures: 2 },
])

console.log('Network schedules passed: loads wait for ready timetable stores and failed routes are counted.')
