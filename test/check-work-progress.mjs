import assert from 'node:assert/strict'
import { remainingStepMs, workFraction, workLabel, durationLabel } from '../src/app/workProgress.ts'
import { jobProgressUpdate } from '../src/server/runtime/job-progress.mjs'

const work = { completed: 30, total: 100, unit: 'rows' }
const samples = [{ at: 0, completed: 0 }, { at: 1000, completed: 10 }, { at: 3000, completed: 30 }]
assert.equal(workFraction(work), .3)
for (const value of [undefined, { completed: 2, unit: 'rows' }, { completed: -1, total: 2 }, { completed: 2, total: 0 }, { completed: NaN, total: 2 }]) assert.equal(workFraction(value), undefined)
assert.equal(remainingStepMs(work, samples, 3000, 3000), 7000)
assert.equal(remainingStepMs(work, samples.slice(0, 1), 3000, 3000), undefined, 'No ETA from a single milestone')
assert.equal(remainingStepMs(work, samples, 20_000, 20_000), undefined, 'A stale rate cannot keep showing a countdown')
assert.equal(remainingStepMs(work, samples, 20_000, 20_000, [{ ms: 30_000, total: 100 }, { ms: 31_000, total: 100 }, { ms: 32_000, total: 100 }]), undefined, 'Stalled measured work must not fall back to a historical countdown')
assert.equal(remainingStepMs({ ...work, completed: 100 }, samples, 3000, 3000), undefined, 'A finished step does not mean the whole task finished')
assert.equal(remainingStepMs(undefined, [], 3000, 3000, [{ ms: 9000 }, { ms: 10_000 }, { ms: 11_000 }]), 7000)
assert.equal(remainingStepMs(undefined, [], 20_000, 20_000, [{ ms: 9000 }, { ms: 10_000 }, { ms: 11_000 }]), undefined, 'Overdue history must stop forecasting')
assert.equal(remainingStepMs(undefined, [], 1000, 1000, [{ ms: 1000 }, { ms: 2000 }, { ms: 10_000 }]), undefined, 'Variable past steps do not support an ETA')
assert.equal(remainingStepMs(work, [], 1000, 1000, [{ ms: 1000, total: 1 }, { ms: 2000, total: 1 }, { ms: 2100, total: 1 }]), undefined, 'Different workload sizes are not comparable')
assert.equal(workLabel(work), '30 of 100 rows')
assert.equal(workLabel({ completed: 1024 ** 2, total: 2 * 1024 ** 2, unit: 'bytes' }), '1.0 of 2.0 MiB')
assert.equal(durationLabel(65_000), '1 min 5 s')
const first = jobProgressUpdate({ phase: 'Reading', bytesRead: 50, totalBytes: 100, progress: .93 })
assert.equal(first.work.completed, 50)
assert.equal(jobProgressUpdate({ phase: 'Reading', progress: .95 }, first).work.completed, 50)
assert.equal(jobProgressUpdate({ phase: 'Building index', progress: .99 }, first).work, undefined, 'A new unmeasured stage must drop the old byte counter')
assert.equal(jobProgressUpdate({ phase: 'Reading', work: { completed: NaN, unit: 'bytes' } }).work, undefined)
console.log('Measured work, rate estimates, bounded historical estimates, stale rates, new stages and unknown durations passed.')
