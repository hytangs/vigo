import { DatabaseSync } from 'node:sqlite'
import { readerBusyTimeoutMs } from './sqlite-readers.mjs'

const schema = 'vigo.address-search.v1'
const abbreviations = new Map(Object.entries({ st: 'street', ave: 'avenue', av: 'avenue', rd: 'road', blvd: 'boulevard', dr: 'drive', ln: 'lane', ct: 'court', pl: 'place', pkwy: 'parkway', hwy: 'highway', sq: 'square', ctr: 'center', n: 'north', s: 'south', e: 'east', w: 'west', ne: 'northeast', nw: 'northwest', se: 'southeast', sw: 'southwest' }))
function normalizeAddressQuery(value) {
  return String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/)
    .map(word => abbreviations.get(word) ?? word).join(' ')
}
const inBounds = (point, bounds) => point?.length === 2 && point.every(Number.isFinite)
  && (!bounds || point[0] >= bounds[0] && point[0] <= bounds[2] && point[1] >= bounds[1] && point[1] <= bounds[3])
const distance = (a, b) => Math.hypot((a[0] - b[0]) * Math.cos(b[1] * Math.PI / 180), a[1] - b[1]) * 111.2
const text = value => typeof value === 'string' ? value.trim().slice(0, 300) : ''
const initialsFor = label => label.split(/\s+/).filter(word => !/^(of|the|and|at|in)$/i.test(word)).map(word => word[0]).join('').toLowerCase()

function representativePoint(geometry) {
  if (geometry?.type === 'Point') return geometry.coordinates
  if (geometry?.type === 'LineString') {
    const points = geometry.coordinates
    // A point on the street, not the center of an unrelated enclosing box.
    return points[Math.floor(points.length / 2)]
  }
  const ring = geometry?.type === 'Polygon' ? geometry.coordinates[0]
    : geometry?.type === 'MultiPolygon' ? geometry.coordinates[0]?.[0] : null
  if (!ring?.length) return null
  const origin = ring[0]
  let x = 0, y = 0, area = 0
  for (let i = 0; i < ring.length - 1; i++) {
    const a = [ring[i][0] - origin[0], ring[i][1] - origin[1]], b = [ring[i + 1][0] - origin[0], ring[i + 1][1] - origin[1]]
    const cross = a[0] * b[1] - b[0] * a[1]
    area += cross; x += (a[0] + b[0]) * cross; y += (a[1] + b[1]) * cross
  }
  return Math.abs(area) > 1e-16 ? [origin[0] + x / (3 * area), origin[1] + y / (3 * area)] : origin
}

/** A separate, disposable geocoder index; prepared routing Cities are never modified. */
export function createAddressIndexWriter(filename, { name, bounds, sourceSha256 = '', supplementSha256 = '', osmTimestamp = '' }) {
  const db = new DatabaseSync(filename)
  db.exec(`PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-8192; PRAGMA temp_store=FILE;
    CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE places(id INTEGER PRIMARY KEY,label TEXT,address TEXT,locality TEXT,postcode TEXT,kind TEXT,lon REAL,lat REAL,importance INTEGER,aliases TEXT);
    CREATE VIRTUAL TABLE addresses USING fts5(name,address,locality,aliases,content='',prefix='2 3 4',tokenize='unicode61 remove_diacritics 2');
    CREATE VIRTUAL TABLE vocabulary USING fts5vocab(addresses,'row');`)
  const insert = db.prepare('INSERT INTO places VALUES(NULL,?,?,?,?,?,?,?,?,?)')
  const index = db.prepare('INSERT INTO addresses(rowid,name,address,locality,aliases) VALUES(?,?,?,?,?)')
  let count = 0, closed = false
  db.exec('BEGIN')
  return {
    add(feature) {
      const p = feature.properties ?? {}, coordinate = representativePoint(feature.geometry)
      if (!inBounds(coordinate, bounds)) return
      const address = [text(p['addr:housenumber']), text(p['addr:street'] || p['addr:place'])].filter(Boolean).join(' ')
      const label = text(p['name:en'] || p.name || p.brand)
      if (!label && !address) return
      // Utility labels and private entrances are poor routing destinations.
      if (!address && (p.power || p.man_made === 'survey_point' || p.highway === 'traffic_signals' || p.access === 'private')) return
      const locality = text(p['addr:city'] || p['is_in:city'] || p['addr:suburb'])
      const stop = ['station', 'halt', 'stop', 'tram_stop'].includes(p.railway) || ['station', 'stop_position', 'platform'].includes(p.public_transport)
      const kind = stop ? 'station' : address && !label ? 'address' : p.highway && !p.amenity && !p.shop ? 'street' : 'place'
      const importance = (p.tourism === 'attraction' || p.tourism === 'museum' ? 30 : 0)
        + (['university', 'hospital', 'library', 'townhall', 'theatre'].includes(p.amenity) ? 20 : 0)
        + (p.railway === 'station' || p.public_transport === 'station' ? 20 : 0)
        + (p.leisure === 'park' ? 10 : 0) + (p.wikipedia || p.wikidata ? 10 : 0)
      const aliases = [p.name, p.alt_name, p.short_name, p.official_name, p['name:en'], p.brand].filter(Boolean).join(';')
      const initials = initialsFor(label)
      const row = insert.run(label || address, address, locality, text(p['addr:postcode']), kind, coordinate[0], coordinate[1], importance, aliases)
      index.run(row.lastInsertRowid, normalizeAddressQuery(label), normalizeAddressQuery(address), normalizeAddressQuery(locality),
        normalizeAddressQuery(`${aliases} ${text(p['addr:postcode'])} ${initials.length >= 3 && initials.length <= 6 ? initials : ''}`))
      count++
      if (count % 10000 === 0) db.exec('COMMIT; BEGIN')
    },
    finish() {
      db.exec("COMMIT; INSERT INTO addresses(addresses) VALUES('optimize')")
      const metadata = { schema, name, bounds, sourceSha256, supplementSha256, osmTimestamp, count, builtAt: new Date().toISOString() }
      db.prepare("INSERT INTO metadata VALUES('index',?)").run(JSON.stringify(metadata))
      if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw Error('Address index integrity check failed.')
      db.close(); closed = true
      return metadata
    },
    close() { if (!closed) { db.close(); closed = true } },
  }
}

// One missing/extra/substituted letter or adjacent transposition. Only used
// after exact token-prefix lookup found no destinations.
function nearWord(a, b) {
  if (a === b || Math.abs(a.length - b.length) > 1) return a === b
  let i = 0; while (i < a.length && a[i] === b[i]) i++
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1)
    || a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2)
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1)
}

/** Rank names and complete street addresses before weak nearby matches. */
export function rankAddressResults(candidates, query, { center, limit = 6 } = {}) {
  const normalized = normalizeAddressQuery(query), tokens = normalized.split(' ')
  const numbered = /^\d+[a-z]?(?:-\d+)?(?:\s|$)/i.test(query.trim())
  const scored = candidates.filter(item => !numbered || tokens.length === 1 || normalizeAddressQuery(item.address).split(' ')[0] === tokens[0]).map((item, order) => {
    const label = normalizeAddressQuery(item.label), address = normalizeAddressQuery(item.address)
    let score = numbered ? 0 : label === normalized ? 250 : label.startsWith(normalized) ? 150 : label.includes(normalized) ? 90 : 0
    if (!numbered && (String(item.aliases ?? '').split(';').some(alias => normalizeAddressQuery(alias) === normalized)
      || normalized.length >= 3 && normalized.length <= 6 && initialsFor(item.label) === normalized)) score = Math.max(score, 250)
    if (numbered) score += address === normalized ? 260 : address.startsWith(normalized) ? 140 : address.includes(normalized) ? 60 : 0
    else if (label !== address) score += address === normalized ? 60 : address.startsWith(normalized) ? 25 : address.includes(normalized) ? 15 : 0
    score += tokens.filter(token => label.split(' ').some(word => word.startsWith(token))).length * 12
    if (item.kind === 'station' && tokens.some(token => ['station', 'terminal', 'stop'].includes(token))) score += 100
    if (numbered && address.split(' ')[0] !== tokens[0]) score -= 220
    score += item.importance ?? 0
    if (item.address) score += 6
    if (center) score -= Math.min(45, distance(item.coordinate, center))
    score -= order * 0.04
    return { item, score }
  }).sort((a, b) => b.score - a.score)
  const unique = []
  for (const { item } of scored) {
    const identity = normalizeAddressQuery(numbered && item.address ? item.address : item.label)
    if (unique.some(other => (item.kind === 'station') === (other.kind === 'station') && normalizeAddressQuery(numbered && other.address ? other.address : other.label) === identity
      && (item.kind === 'street' && other.kind === 'street' ? item.locality === other.locality : distance(item.coordinate, other.coordinate) < 0.18))) continue
    unique.push(item)
    if (unique.length === limit) break
  }
  return unique.map(item => ({ label: numbered && item.address ? item.address : item.label,
    detail: [...new Set([item.kind === 'station' ? 'Transit stop' : '', numbered && item.address ? item.label !== item.address ? item.label : '' : item.address !== item.label ? item.address : '', item.locality, item.postcode].filter(Boolean))].join(' · '),
    coordinate: item.coordinate, kind: item.kind ?? 'place' }))
}

export function openAddressIndex(filename, { bounds, center, name } = {}) {
  const db = new DatabaseSync(filename, { readOnly: true, timeout: readerBusyTimeoutMs })
  db.exec('PRAGMA query_only=ON; PRAGMA cache_size=-4096')
  const metadata = JSON.parse(db.prepare("SELECT value FROM metadata WHERE key='index'").get()?.value ?? '{}')
  if (metadata.schema !== schema || !metadata.count) { db.close(); throw Error('Invalid local address index.') }
  const select = db.prepare(`SELECT p.*,a.rank FROM addresses a JOIN places p ON p.id=a.rowid
    WHERE addresses MATCH ? AND p.lon BETWEEN ? AND ? AND p.lat BETWEEN ? AND ? ORDER BY a.rank LIMIT 120`)
  const words = db.prepare('SELECT term,doc FROM vocabulary WHERE term >= ? AND term < ? ORDER BY doc DESC LIMIT 500')
  const recent = new Map()
  let closed = false
  const lookup = expression => select.all(expression, bounds?.[0] ?? -180, bounds?.[2] ?? 180, bounds?.[1] ?? -90, bounds?.[3] ?? 90)
  return {
    metadata,
    search(query) {
      const normalized = normalizeAddressQuery(query), tokens = normalized.split(' ').filter(Boolean).slice(0, 12)
      if (!tokens.length) return []
      if (recent.has(normalized)) return recent.get(normalized)
      // A broad city prefix must not scan every address's locality column.
      const field = tokens.length === 1 || normalizeAddressQuery(name ?? metadata.name).startsWith(normalized) ? '{name address aliases}: ' : ''
      const exact = lookup(field + tokens.map(token => `"${token}"`).join(' AND '))
      const exactIds = new Set(exact.map(row => row.id))
      const prefix = tokens.map((token, i) => `"${token}"${tokens.length > 1 && i === 0 && /^\d+[a-z]?$/.test(token) || [...abbreviations.values()].includes(token) ? '' : '*'}`).join(' AND ')
      let rows = [...exact, ...lookup(field + prefix).filter(row => !exactIds.has(row.id))]
      if (!rows.length && tokens.some(token => token.length >= 4)) {
        const terms = tokens.map(token => {
          if (token.length < 4 || /\d/.test(token)) return `"${token}"*`
          const prefix = token.slice(0, 2)
          const alternatives = words.all(prefix, prefix + '\uffff').filter(row => nearWord(token, row.term)).slice(0, 3).map(row => row.term)
          return `(${[token, ...alternatives].map(word => `"${word}"*`).join(' OR ')})`
        })
        rows = lookup(field + terms.join(' AND '))
      }
      const results = rankAddressResults(rows.map(row => ({ ...row, coordinate: [row.lon, row.lat], locality: row.locality || `${name ?? metadata.name} area` })), query, { center })
      if (recent.size >= 128) recent.delete(recent.keys().next().value)
      recent.set(normalized, results)
      return results
    },
    close() { if (!closed) { db.close(); closed = true } },
  }
}
