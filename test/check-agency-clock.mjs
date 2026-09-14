import assert from 'node:assert/strict'
import { mock } from 'node:test'
import { currentTime, describeCurrentTime } from '../src/agency/currentTime.mjs'
import { createToolRegistry } from '../src/agency/toolRegistry.mjs'
import { discoverableTools } from '../src/agency/toolDiscovery.mjs'
import { queryAgency } from '../src/agency/queryAgent.mjs'

// Chicago switches at 08:00 UTC in March and 07:00 UTC in November.
for (const [instant, time, zone] of [
  ['2026-03-08T07:59:00Z', '1:59 AM', 'CST'],
  ['2026-03-08T08:00:00Z', '3:00 AM', 'CDT'],
  ['2026-11-01T06:59:00Z', '1:59 AM', 'CDT'],
  ['2026-11-01T07:00:00Z', '1:00 AM', 'CST'],
]) {
  const clock = currentTime(['America/Chicago'], 'America/New_York', instant).clocks[0]
  assert.equal(clock.time, time)
  assert.equal(clock.zoneLabel, zone)
}
const international = currentTime(['Asia/Kathmandu', 'Pacific/Auckland', 'America/Los_Angeles'], undefined, '2026-09-14T00:30:00Z')
assert.equal(international.clocks[0].time, '6:15 AM', 'Fractional offsets are computed, not rounded to hours')
assert.match(international.clocks[1].date, /Monday, September 14/)
assert.match(international.clocks[2].date, /Sunday, September 13/, 'The same instant can fall on the preceding local date')
assert.equal(currentTime(undefined, 'UTC', '2026-09-14T00:30:00Z').clocks[0].time, '12:30 AM')
assert.equal(currentTime(['Europe/Paris', 'Europe/Paris']).clocks.length, 1)
for (const zone of ['CST', '-06:00', 'America/Invented', '']) assert.throws(() => currentTime([zone], 'America/New_York'), /Unknown timezone/)
assert.throws(() => currentTime(), /no timezone configured/)
assert.throws(() => currentTime(['UTC'], undefined, 'invalid'), /server clock/)

const state = { generatedAt: '2026-09-13T12:00:00Z' }
const context = { timezone: 'America/New_York', overview: () => ({ cityName: 'City X' }), routeIndex: new Map(), stopIndex: new Map() }
let clockReads = 0
const callTool = createToolRegistry({ context, state, now: () => { clockReads++; return Date.parse('2026-09-14T11:24:00Z') } })
for (const args of [{ timezones: [], resultUse: 'answer' }, { timezones: Array(7).fill('UTC'), resultUse: 'answer' }, { timezones: ['UTC'], resultUse: 'invented' }, { query: 'Chicago', resultUse: 'answer' }]) {
  await assert.rejects(callTool('current_time', args))
}
assert.equal(clockReads, 0, 'Invalid model arguments do not execute the clock')
let modelCalls = 0
const progress = []
const answer = await queryAgency({ question: 'when is it now in Chicago', context, state, callTool,
  history: [{ question: 'What time is it?', answer: 'It is 03:36 EDT in Boston.', observedAt: state.generatedAt,
    findings: [{ tool: 'current_time', arguments: { resultUse: 'answer' }, result: { ok: true, data: currentTime(undefined, context.timezone, state.generatedAt), generatedAt: state.generatedAt, warnings: [], provenance: [] } }] }],
  onProgress: item => progress.push(item),
  provider: { available: true, model: 'fixture', complete: async (messages, tools, _signal, options) => {
    modelCalls++
    assert.match(JSON.stringify(messages), /Historical clock reading/, 'Follow-up context marks earlier time results as historical')
    assert.ok(discoverableTools(tools).definitions().some(tool => tool.name === 'current_time'), 'Clock needs no discovery turn')
    options.onActivity('decision')
    return { tool_calls: [{ id: 'clock', function: { name: 'current_time', arguments: '{"timezones":["America/Chicago"],"resultUse":"answer"}' } }] }
  } },
})
assert.equal(modelCalls, 1, 'A clock-only reply does not need another model generation')
assert.equal(clockReads, 1)
assert.match(answer.answer, /6:24 AM CDT/)
assert.match(answer.answer, /Chicago/)
assert.doesNotMatch(answer.answer, /03:36|Boston|America\//)
assert.equal(answer.trace[0].result.generatedAt, '2026-09-14T11:24:00.000Z', 'Clock is read at execution, not from the old network snapshot or chat')
assert.equal(answer.generatedAt, answer.trace[0].result.generatedAt, 'The displayed As of time describes the clock read, even if model startup crossed a minute or date')
assert.equal(answer.aiGenerated, false, 'The rendered time is a server computation')
assert.deepEqual(answer.citations, [1])
assert.deepEqual(answer.runtime.networkToolCalls, [], 'A clock check requires no network-capable tool')
assert.ok(progress.some(item => item.detail === 'Preparing a response…'), 'Structured model activity updates the waiting status without exposing its form')
assert.equal(describeCurrentTime(answer.trace[0].result.data) + ' [1]', answer.answer)

let multipartCalls = 0
const multipart = await queryAgency({ question: 'What time is it here, and explain daylight saving?', context, state, callTool,
  provider: { available: true, complete: async () => ++multipartCalls === 1
    ? { tool_calls: [{ id: 'clock', function: { name: 'current_time', arguments: '{"resultUse":"continue"}' } }] }
    : { content: 'It is 7:24 AM EDT. Daylight saving advances local clocks seasonally. [1]' } },
})
assert.equal(multipartCalls, 2, 'A clock result does not prematurely end a multipart question')
assert.match(multipart.answer, /seasonally/)

mock.timers.enable({ apis: ['setTimeout'] })
try {
  const waiting = []
  let finish
  const pending = queryAgency({ question: 'Hello', context, state, onProgress: item => waiting.push(item),
    provider: { available: true, complete: () => new Promise(resolve => { finish = resolve }) } })
  mock.timers.tick(8000)
  assert.equal(waiting.at(-1).detail, 'Waiting for the model…')
  finish({ content: 'Hello.' })
  await pending
  const count = waiting.length
  mock.timers.tick(8000)
  assert.equal(waiting.length, count, 'Completed requests leave no pending status update')
  const completed = []
  await queryAgency({ question: 'Hello', context, state, onProgress: item => completed.push(item),
    provider: { available: true, complete: async () => ({ content: 'Hello.' }) } })
  mock.timers.tick(8000)
  assert.equal(completed.length, 1, 'A prompt reply cancels the waiting timer before it fires')
} finally { mock.timers.reset() }
console.log('Agency clock checks passed: daylight saving, local dates, fresh clock evidence, one-turn replies and waiting status.')
