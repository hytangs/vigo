import { PbfWriter } from 'pbf'
import { writeFileSync } from 'node:fs'

const message = (write, data) => { const pbf = new PbfWriter(); write(data, pbf); return Buffer.from(pbf.finish()) }
const deltas = (values) => values.map((value, i) => value - (values[i - 1] ?? 0))

export function writeBasemapFixture(filePath) {
  const strings = ['']
  const string = (value) => { let i = strings.indexOf(value); if (i === -1) { i = strings.length; strings.push(value) }; return i }
  const nodes = [], ways = [], relations = []
  const node = (point) => { const id = nodes.length + 1; nodes.push({ id, lon: Math.round(point[0] * 1e7), lat: Math.round(point[1] * 1e7) }); return id }
  const tags = (value) => ({ keys: Object.keys(value).map(string), vals: Object.values(value).map(string) })
  const way = (points, values = {}) => {
    const refs = points.map(node)
    if (String(points[0]) === String(points.at(-1))) refs[refs.length - 1] = refs[0]
    const id = ways.length + 1
    ways.push({ id, refs, ...tags(values) }); return id
  }
  // A northbound mainland shore: ocean is east; the island is counterclockwise.
  way([[0, -0.1], [0, 0], [0, 0.1]], { natural: 'coastline' })
  way([[0.025, -0.01], [0.04, -0.01], [0.04, 0.01], [0.025, 0.01], [0.025, -0.01]], { natural: 'coastline' })
  for (const [i, highway] of ['motorway', 'primary', 'secondary', 'tertiary', 'residential', 'service', 'footway'].entries()) {
    way([[-0.09, 0.01 + i * 0.007], [-0.01, 0.012 + i * 0.007]], { highway })
  }
  way([[-0.09, -0.06], [-0.055, -0.025], [0, -0.025]], { waterway: 'river' })
  way([[-0.05, -0.01], [-0.025, -0.01], [-0.025, 0.01], [-0.05, 0.01], [-0.05, -0.01]], { natural: 'water' })
  // Untagged, reversed multipolygon members and a retained island hole.
  const outerA = way([[-0.095, -0.045], [-0.065, -0.045], [-0.065, -0.015]])
  const outerB = way([[-0.095, -0.045], [-0.095, -0.015], [-0.065, -0.015]])
  const inner = way([[-0.085, -0.035], [-0.075, -0.035], [-0.075, -0.025], [-0.085, -0.025], [-0.085, -0.035]])
  relations.push({ id: 100, refs: [outerB, inner, outerA], roles: [string('outer'), string('inner'), string('outer')], types: [1, 1, 1], ...tags({ type: 'multipolygon', natural: 'water' }) })
  const writeTags = (value, pbf) => { pbf.writePackedVarint(2, value.keys); pbf.writePackedVarint(3, value.vals) }
  const data = message((_value, pbf) => {
    pbf.writeMessage(1, (values, p) => { for (const value of values) p.writeStringField(1, value) }, strings)
    pbf.writeMessage(2, (_, p) => {
      p.writeMessage(2, (_, dense) => {
        dense.writePackedSVarint(1, deltas(nodes.map((n) => n.id)))
        dense.writePackedSVarint(8, deltas(nodes.map((n) => n.lat)))
        dense.writePackedSVarint(9, deltas(nodes.map((n) => n.lon)))
      }, null)
      for (const value of ways) p.writeMessage(3, (w, wp) => {
        wp.writeVarintField(1, w.id); writeTags(w, wp); wp.writePackedSVarint(8, deltas(w.refs))
      }, value)
      for (const value of relations) p.writeMessage(4, (r, rp) => {
        rp.writeVarintField(1, r.id); writeTags(r, rp)
        rp.writePackedVarint(8, r.roles); rp.writePackedSVarint(9, deltas(r.refs)); rp.writePackedVarint(10, r.types)
      }, value)
    }, null)
  }, null)
  const frame = (type, raw) => {
    const blob = message((value, p) => { p.writeBytesField(1, value); p.writeVarintField(2, value.length) }, raw)
    const header = message((value, p) => { p.writeStringField(1, value); p.writeVarintField(3, blob.length) }, type)
    const size = Buffer.alloc(4); size.writeUInt32BE(header.length)
    return Buffer.concat([size, header, blob])
  }
  writeFileSync(filePath, Buffer.concat([
    frame('OSMHeader', message((_, p) => { p.writeStringField(4, 'OsmSchema-V0.6'); p.writeStringField(4, 'DenseNodes') }, null)),
    frame('OSMData', data),
  ]))
}
