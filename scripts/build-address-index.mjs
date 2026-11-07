import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createAddressIndexWriter } from '../src/server/address-index.mjs'
import { validBounds } from '../src/server/address-search.mjs'

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, i, all) => value.startsWith('--') ? [...pairs, [value.slice(2), all[i + 1]]] : pairs, []))
if (!args.osm || !args.output || !args.name || !args.bounds) throw Error('Usage: node scripts/build-address-index.mjs --osm source.osm.pbf --output addresses.sqlite --name City --bounds "[west,south,east,north]"')
const bounds = JSON.parse(args.bounds)
if (!validBounds(bounds)) throw Error('Invalid City bounds.')
if (await fs.stat(args.output).catch(() => null)) throw Error('Output already exists. Build to a new path before replacing the deployed index.')
const hash = createHash('sha256')
for await (const chunk of createReadStream(args.osm)) hash.update(chunk)
const supplement = args.places ? await fs.readFile(args.places) : null
const places = supplement ? JSON.parse(supplement) : null
if (places && (places.remark || !Array.isArray(places.elements))) throw Error('Incomplete place supplement.')
const staging = `${args.output}.${process.pid}.tmp`
const config = `${staging}.json`
await fs.writeFile(config, JSON.stringify({ area_tags: ['building', 'landuse', 'leisure', 'amenity', 'tourism', 'shop', 'aeroway', 'natural', 'place'], linear_tags: null,
  include_tags: ['name', 'name:en', 'alt_name', 'short_name', 'official_name', 'brand', 'addr:*', 'is_in:city', 'highway', 'power', 'man_made', 'access', 'tourism', 'amenity', 'railway', 'public_transport', 'shop', 'leisure', 'wikipedia', 'wikidata', 'place'] }))
const writer = createAddressIndexWriter(staging, { name: args.name, bounds, sourceSha256: hash.digest('hex'),
  supplementSha256: supplement ? createHash('sha256').update(supplement).digest('hex') : '', osmTimestamp: places?.osm3s?.timestamp_osm_base ?? '' })
const child = spawn('osmium', ['export', args.osm, '--config', config, '--output-format', 'geojsonseq'], { stdio: ['ignore', 'pipe', 'inherit'] })
const completion = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(Error(`osmium export failed (${code})`))) })
// Avoid unhandled rejection if exporting fails while the stream is being read.
completion.catch(() => {})
try {
  if (places) {
    for (const element of places.elements) {
      const coordinate = element.center ? [element.center.lon, element.center.lat] : [element.lon, element.lat]
      writer.add({ properties: element.tags, geometry: { type: 'Point', coordinates: coordinate } })
    }
  }
  // RFC 8142 is delimited by RS, not line breaks (OSM tags can contain them).
  // Older osmium versions leave some tag control characters unescaped.
  const addRecord = record => {
    if (!record.trim()) return
    const json = record.replace(/"(?:\\.|[^"\\])*"/gs, value => value.replace(/[\x00-\x1f]/g, char => JSON.stringify(char).slice(1, -1)))
    writer.add(JSON.parse(json))
  }
  child.stdout.setEncoding('utf8')
  let pending = ''
  for await (const chunk of child.stdout) {
    pending += chunk
    const records = pending.split('\x1e'); pending = records.pop()
    for (const record of records) addRecord(record)
    if (pending.length > 64 * 1024 * 1024) throw Error('OSM feature exceeds the index builder size limit.')
  }
  addRecord(pending)
  await completion
  const metadata = writer.finish()
  await fs.rename(staging, args.output)
  console.log(JSON.stringify(metadata))
} catch (error) {
  child.kill(); writer.close(); await fs.rm(staging, { force: true }); throw error
} finally { await fs.rm(config, { force: true }) }
