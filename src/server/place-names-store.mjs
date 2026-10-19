// Place names for map points ("Washington St & Massachusetts Ave"). The OSM
// importer writes named streets and named areas to the optional
// `place_streets` and `place_areas` tables of the street index; 0.5 readers
// ignore them, and Cities without them name points from their stops.
// Geometry is zigzag varint deltas of microdegree longitude/latitude pairs,
// read by `place_describe.rs` in the Rust kernel.

// Lower ranks name a place first: "Massachusetts Ave & Tremont St". Paths and
// service roads are left out, so a point in a park reads as the park.
const roadRanks = new Map(Object.entries({
  motorway: 1, motorway_link: 1, trunk: 2, trunk_link: 2, primary: 3, primary_link: 3,
  secondary: 4, secondary_link: 4, tertiary: 5, tertiary_link: 5,
  unclassified: 6, residential: 6, living_street: 6, road: 6, pedestrian: 6,
}))

// Named closed ways a point can be "in".
const areaTags = {
  leisure: new Set(['park', 'garden', 'nature_reserve', 'golf_course', 'stadium', 'common', 'recreation_ground', 'marina']),
  amenity: new Set(['university', 'college', 'hospital', 'school']),
  tourism: new Set(['zoo', 'theme_park', 'museum', 'attraction']),
  aeroway: new Set(['aerodrome']),
  landuse: new Set(['cemetery']),
  place: new Set(['square', 'island', 'islet']),
}

/** The name and rank a way gives a street, or null. A tunnel names nothing above it. */
export function placeStreetName(tags) {
  const rank = roadRanks.get(String(tags.highway ?? ''))
  if (!rank || (tags.tunnel && tags.tunnel !== 'no')) return null
  const name = String(tags.name ?? '').trim() || (rank <= 2 ? String(tags.ref ?? '').trim() : '')
  return name && name.length <= 160 ? { name, rank } : null
}

/** The kind of named area a closed way is, or null. */
export function placeAreaKind(way, tags) {
  if (!String(tags.name ?? '').trim() || way.refs.length < 4 || way.refs[0] !== way.refs.at(-1)) return null
  for (const [key, values] of Object.entries(areaTags)) if (values.has(String(tags[key] ?? ''))) return `${key}:${tags[key]}`
  return null
}

/** True when the importer must resolve this way's nodes for place names. */
export function placeWayNeedsNodes(way, tags) {
  return Boolean(placeStreetName(tags) || placeAreaKind(way, tags))
}

export function encodePlacePolyline(points) {
  const bytes = []
  let previousLon = 0, previousLat = 0
  for (const [lon, lat] of points) {
    const x = Math.round(lon * 1e6), y = Math.round(lat * 1e6)
    for (const delta of [x - previousLon, y - previousLat]) {
      let value = delta < 0 ? -delta * 2 - 1 : delta * 2
      while (value >= 0x80) {
        bytes.push((value % 0x80) | 0x80)
        value = Math.floor(value / 0x80)
      }
      bytes.push(value)
    }
    previousLon = x
    previousLat = y
  }
  return Uint8Array.from(bytes)
}

/** Used by the OSM importer while it resolves way geometry. */
export function createPlaceStreetWriter(db) {
  db.exec(`CREATE TABLE place_streets(id INTEGER PRIMARY KEY, name TEXT NOT NULL, road_class INTEGER NOT NULL, geometry BLOB NOT NULL);
    CREATE TABLE place_areas(id INTEGER PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, geometry BLOB NOT NULL)`)
  const insertStreet = db.prepare('INSERT INTO place_streets(name, road_class, geometry) VALUES(?,?,?)')
  const insertArea = db.prepare('INSERT INTO place_areas(name, kind, geometry) VALUES(?,?,?)')
  return {
    addWay(way, tags, getNode) {
      const street = placeStreetName(tags)
      const area = street ? null : placeAreaKind(way, tags)
      if (!street && !area) return
      const points = []
      for (const nodeId of way.refs) {
        const point = getNode.get(nodeId)
        // Missing nodes must not create a fictional straight link or close an incomplete area.
        if (!point) return
        points.push([point.lon, point.lat])
      }
      if (street && points.length >= 2) insertStreet.run(street.name, street.rank, encodePlacePolyline(points))
      else if (area && points.length >= 4) insertArea.run(String(tags.name).trim(), area, encodePlacePolyline(points))
    },
  }
}
