import assert from 'node:assert/strict'
import { LatestRequestGate } from '../src/app/latestRequestGate.ts'

const gate = new LatestRequestGate()
const older = gate.begin()
const current = gate.begin()
assert(older.controller.signal.aborted)
assert.equal(gate.owns(older), false)
assert.equal(gate.owns(current), true)
gate.finish(older)
assert.equal(gate.owns(current), true, 'Finishing obsolete work cannot release the current request')
gate.cancel()
assert(current.controller.signal.aborted)
assert.equal(gate.owns(current), false)
const next = gate.begin()
assert.equal(gate.owns(next), true)
gate.finish(next)
console.log('Request gate: supersession, obsolete completion, cancellation and reuse passed.')
