import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createTransitDepartureLookup } from '../src/server/gtfs/transit-departures.mjs'

const db = new DatabaseSync(':memory:')
try {
  db.exec(`
    CREATE TABLE connections(service_id TEXT, departure REAL);
    CREATE TEMP TABLE active_services(service_id TEXT PRIMARY KEY) WITHOUT ROWID;
    INSERT INTO connections VALUES
      ('weekday', 28800.25), ('weekday', 28801), ('weekday', 115200.5),
      ('weekend', 29000.75), ('overnight', 90000.125),
      ('boundary', 86500.5), ('past-boundary', 86500.5001);
  `)
  const insertService = db.prepare('INSERT INTO active_services VALUES (?)')
  const selectServices = (...services) => {
    db.exec('DELETE FROM active_services')
    for (const service of services) insertService.run(service)
  }
  const oracle = departure => db.prepare(`
    SELECT MIN(departure) AS departure FROM connections
    WHERE service_id IN (SELECT service_id FROM active_services)
      AND departure >= ? AND departure <= ?
  `).get(departure, departure + 86400).departure

  let reads = 0
  const lookup = createTransitDepartureLookup({
    prepare(sql) {
      const statement = db.prepare(sql)
      return { get(...args) { reads += 1; return statement.get(...args) } }
    },
  })
  selectServices('weekday')
  for (const departure of [0, 28800, 28800.25, 28800.251, 28801, 28801.1, 115200.5, 115201]) {
    assert.equal(lookup('weekday', departure), oracle(departure))
    const previousReads = reads
    assert.equal(lookup('weekday', departure), oracle(departure))
    assert.equal(reads, previousReads, 'Repeated clocks, including empty results, reuse schedule metadata')
  }
  assert.equal(lookup('weekday', 28800), 28800.25, 'Preserve fractional SQLite clocks')

  for (const service of ['weekend', 'weekday', 'overnight']) {
    selectServices(service)
    assert.equal(lookup(service, 28800), oracle(28800), 'Changing and revisiting service contexts must not reuse stale values')
  }
  assert.equal(lookup('overnight', 28800), 90000.125, 'Retain GTFS clocks beyond midnight')
  selectServices('boundary')
  assert.equal(lookup('boundary', 100.5), 86500.5, 'The 24-hour upper limit is inclusive')
  selectServices('past-boundary')
  assert.equal(lookup('past-boundary', 100.5), null, 'Exclude departures outside the search horizon')
  selectServices()
  assert.equal(lookup('empty', 28800), null)
  selectServices('weekday')
  assert.equal(lookup('weekday', 28800), 28800.25, 'Recover after an empty service context')

  // A changing departure clock must not accumulate unbounded entries. Frequently
  // reused times survive eviction; evicted times still return the exact answer.
  for (let departure = 0; departure < 64; departure += 1) lookup('weekday', departure)
  let previousReads = reads
  lookup('weekday', 0)
  assert.equal(reads, previousReads)
  lookup('weekday', 64)
  previousReads = reads
  lookup('weekday', 0)
  assert.equal(reads, previousReads, 'Recently read clocks survive eviction')
  assert.equal(lookup('weekday', 1), oracle(1))
  assert.equal(reads, previousReads + 1, 'Oldest unused clock is recomputed after eviction')

  // Replacement stores own fresh lookups even when their service names match.
  db.exec("UPDATE connections SET departure = 28900.5 WHERE service_id = 'weekday' AND departure = 28800.25")
  const replacementLookup = createTransitDepartureLookup(db)
  assert.equal(replacementLookup('weekday', 28800), 28801)
  assert.equal(replacementLookup('weekday', 28800), oracle(28800))
  console.log('Transit departure metadata matches SQL across fractional clocks, horizons, service changes, empty results, eviction, and store replacement.')
} finally {
  db.close()
}
