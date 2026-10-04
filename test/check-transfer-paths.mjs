import assert from 'node:assert/strict'
import { compileNativeTransferPaths } from '../src/server/native-routing-kernel.mjs'
import { prepareServiceTransfers } from '../src/server/gtfs/transfer-paths.mjs'

const typed = (n, edges, forbidden = []) => ({
  eligible: new Uint8Array(n).fill(1),
  from: Uint32Array.from(edges, e => e[0]), to: Uint32Array.from(edges, e => e[1]),
  seconds: Uint32Array.from(edges, e => e[2]), pathway: Uint8Array.from(edges, e => e[3]),
  forbiddenFrom: Uint32Array.from(forbidden, e => e[0]), forbiddenTo: Uint32Array.from(forbidden, e => e[1]),
})
// Independent bounded Bellman-Ford reference over (stop, external edge used).
// Check optimal costs and the retained path, including zero-cost cycles.
let seed = 8843
const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n }
for (let trial = 0; trial < 120; trial++) {
  const n = 3 + random(7), edges = Array.from({ length: random(35) }, () => [random(n), random(n), random(31), random(2)])
  const forbidden = [[random(n), random(n)]]
  const input = typed(n, edges, forbidden), paths = compileNativeTransferPaths(input)
  const blocked = (a, b) => forbidden.some(([x, y]) => x === a && y === b)
  const costs = new Map()
  for (const [a, b, cost] of edges) if (!blocked(a, b)) costs.set(`${a}:${b}`, Math.min(costs.get(`${a}:${b}`) ?? Infinity, cost))
  for (let i = 0; i < paths.from.length; i++) {
    const path = Array.from(paths.pathEdges.subarray(paths.pathOffsets[i], paths.pathOffsets[i + 1]))
    let current = paths.from[i], cost = 0, external = 0
    for (const j of path) {
      const [a, b, seconds, pathway] = edges[j]
      assert.equal(a, current); assert(!blocked(a, b)); current = b; cost += seconds; external += 1 - pathway
    }
    assert.equal(current, paths.to[i]); assert.equal(cost, paths.seconds[i]); assert(external <= 1)
    const key = `${paths.from[i]}:${paths.to[i]}`
    costs.set(key, Math.min(costs.get(key) ?? Infinity, cost))
  }
  for (let source = 0; source < n; source++) {
    const d = new Array(2 * n).fill(Infinity); d[source] = 0
    for (let round = 0; round < 2 * n; round++) for (const [a, b, cost, pathway] of edges) {
      if (blocked(a, b)) continue
      for (let used = 0; used < 2; used++) {
        if (used && !pathway) continue
        const to = b + (used || !pathway ? n : 0)
        d[to] = Math.min(d[to], d[a + used * n] + cost)
      }
    }
    for (let target = 0; target < n; target++) if (source !== target && !blocked(source, target)) {
      assert.equal(costs.get(`${source}:${target}`) ?? Infinity, Math.min(d[target], d[target + n]), `graph ${trial}: ${source}->${target}`)
    }
  }
}
const oneStreet = typed(6, [[0, 1, 10, 0], [1, 2, 20, 1], [2, 3, 30, 1], [3, 4, 10, 0], [4, 5, 20, 1]])
const p = compileNativeTransferPaths(oneStreet)
assert(Array.from(p.from).some((from, i) => from === 0 && p.to[i] === 3 && p.seconds[i] === 60))
assert(!Array.from(p.from).some((from, i) => from === 0 && p.to[i] === 5))
assert(!Array.from(p.from).some((from, i) => from === 3 && p.to[i] === 0))
for (const bad of [{ to: new Uint32Array() }, { pathway: new Uint8Array(5).fill(2) }, { forbiddenTo: Uint32Array.of(6) }]) {
  assert.throws(() => compileNativeTransferPaths({ ...oneStreet, ...bad }), /Invalid transfer path arrays/)
}
const edge = (a, b, s, provenance) => ({ from_stop_id: a, to_stop_id: b, min_transfer_time: s, provenance })
const store = { stopRecords: new Map(['A', 'X', 'B'].map(id => [id, {}])),
  stopAccessIndex: { directServiceStopIds: new Set(['A', 'B']) }, forbiddenTransferPairs: new Set(),
  transfers: new Map([['A', [edge('A', 'X', 20, 'gtfs_pathway'), edge('A', 'B', 300, 'gtfs_transfer')]],
    ['X', [edge('X', 'B', 20, 'gtfs_pathway')]]]) }
assert.equal(prepareServiceTransfers(store).size, 0, 'A faster pathway chain cannot undercut the published transfer minimum.')
console.log('Transfer composition: 120 independent graph checks, directed witnesses, one external edge, published minima and invalid inputs passed.')
