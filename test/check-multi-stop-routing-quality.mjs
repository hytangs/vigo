import assert from 'node:assert/strict'
import { maxRoutingPointCount } from '../src/routingPointSequence.ts'

// Multi-stop journeys are composed by the Rust runtime (standalone/ordered.rs,
// with its own unit tests). Studio still bounds a request to eight ordered
// points before it reaches the runtime.
assert.equal(maxRoutingPointCount, 8)
console.log('Multi-stop routing: eight-point request bound passed.')
