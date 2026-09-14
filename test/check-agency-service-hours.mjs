import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { AgencyContext } from '../src/agency/agencyContext.mjs'
import { deriveOperationalState } from '../src/agency/realtimeIntelligence.mjs'
import { diagnoseNetwork, compactDiagnosis } from '../src/agency/networkDiagnosis.mjs'
import { networkNarrative } from '../src/agency/networkNarrative.mjs'
import { briefingStatus } from '../src/agency/briefingSchedule.mjs'
import { inspectOperationalService, inspectionFacts } from '../src/agency/serviceInspection.mjs'
import { createAgencyFixture, realtimeFixture, tripUpdate } from './fixtures/agency.mjs'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agency-service-hours-'))
const epoch = date => Date.parse(date) / 1000
async function fixture(name, sql, check) {
  const file = path.join(root, `${name}.sqlite`)
  createAgencyFixture(file)
  const db = new DatabaseSync(file)
  db.exec(sql); db.close()
  const context = new AgencyContext(file, 'City X')
  try {
    const assess = date => diagnoseNetwork(context, deriveOperationalState(context, null, epoch(date)))
    await check(context, assess)
  } finally { context.close() }
}

try {
  await fixture('local-clock', `UPDATE metadata SET value='["America/New_York"]' WHERE key='agencyTimezones';`, async (context, assess) => {
    const night = assess('2026-09-14T07:00:00Z')
    assert.equal(night.status, 'no_scheduled_service')
    assert.equal(night.serviceContext.clock.time, '03:00', 'The City clock, not the host clock or UTC hour, describes the window')
    assert.equal(night.serviceContext.phase, 'between_runs')
    assert.equal(night.serviceContext.nextScheduledTrip.time, '12:05')
    assert.equal(night.coverage.unknownTrips, 0, 'Unscheduled daytime trips are not missing overnight service')
    assert.match(networkNarrative(night).overview, /between scheduled runs.*12:05 EDT/)
    assert.doesNotMatch(networkNarrative(night).overview, /disrupt|normal|healthy|unknown/)
    assert.deepEqual(compactDiagnosis(night).serviceContext, night.serviceContext, 'Ask receives the same service-hours facts')

    const day = assess('2026-09-14T16:06:00Z')
    assert.equal(day.serviceContext.phase, 'scheduled_service')
    assert.equal(day.status, 'prediction_coverage_unavailable')
    assert.equal(day.coverage.unknownTrips, 3, 'Scheduled but unreported trips remain unknown during service')
    assert.doesNotMatch(networkNarrative(day).overview, /between scheduled runs/)

    const before = assess('2026-09-14T15:55:00Z')
    const answer = { generatedAt: before.generatedAt, diagnosis: before, scheduleIdentity: 'fixture' }
    const settings = { intervalMinutes: 60, automatic: true }
    assert.equal(briefingStatus({ answer }, settings, Date.parse(before.generatedAt), 'fixture').refreshAt, '2026-09-14T16:05:00.000Z')
    assert.equal(briefingStatus({ answer }, settings, Date.parse('2026-09-14T16:05:00Z'), 'fixture').current, false, 'An hourly overnight briefing expires when service begins')
    assert.equal(briefingStatus({ answer: { ...answer, diagnosis: { ...before, version: 1 } } }, settings, Date.parse(before.generatedAt), 'fixture').current, false)

    const outside = assess('2026-10-02T07:00:00Z')
    assert.equal(outside.serviceContext, null)
    assert.equal(outside.status, 'timetable_unavailable', 'Expired GTFS cannot establish an overnight shutdown')
    const end = assess('2026-10-01T03:00:00Z')
    assert.equal(end.serviceContext.referenceComplete, false)
    assert.match(networkNarrative(end).overview, /next service start is not established/)
    assert.doesNotMatch(networkNarrative(end).overview, /No timed trips.*next 24 hours/)
  })

  await fixture('previous-service-date', 'UPDATE connections SET departure=departure+43200,arrival=arrival+43200;', (context, assess) => {
    const overnight = assess('2026-09-14T00:06:00Z')
    assert.equal(overnight.serviceContext.phase, 'scheduled_service')
    assert.equal(overnight.serviceContext.activeTrips, 1, '24:00+ trips on the preceding GTFS date are still scheduled now')
    assert.equal(overnight.coverage.scheduledTrips, 3)
    assert.equal(overnight.status, 'prediction_coverage_unavailable')
    const at = epoch('2026-09-14T00:35:00Z')
    const snapshot = realtimeFixture([tripUpdate('T3', 1800, { timestamp: at })])
    snapshot.feeds[0].feedTimestamp = at
    snapshot.fetchedAt = new Date(at * 1000).toISOString()
    const delayed = diagnoseNetwork(context, deriveOperationalState(context, snapshot, at))
    assert.equal(delayed.coverage.scheduledTrips, 0)
    assert.equal(delayed.status, 'measured', 'Late-running last trips remain visible after scheduled service ends')
    assert.equal(delayed.network.laterTrips, 1)
    assert.match(networkNarrative(delayed).overview, /Live predictions still show service outside its scheduled window/)
    assert.ok(networkNarrative(delayed).sections.some(section => section.id === 'delay'))
  })

  await fixture('dst-clock', `
    UPDATE metadata SET value='["America/New_York"]' WHERE key='agencyTimezones';
    UPDATE calendar SET start_date=20261101,end_date=20261103;
    UPDATE connections SET departure=departure-39900,arrival=arrival-39900;
  `, (_context, assess) => {
    const before = assess('2026-11-01T05:55:00Z')
    assert.equal(before.serviceContext.clock.time, '01:55')
    assert.equal(before.serviceContext.clock.zoneLabel, 'EDT')
    assert.equal(before.serviceContext.nextScheduledTrip.time, '01:00')
    assert.equal(before.serviceContext.nextScheduledTrip.zoneLabel, 'EST')
    assert.equal(before.serviceContext.nextScheduledTripAt, '2026-11-01T06:00:00.000Z', 'DST fallback uses the GTFS noon-minus-12-hours service clock')
    assert.equal(assess('2026-11-01T06:02:00Z').serviceContext.phase, 'scheduled_service')
  })

  await fixture('night-and-day-routes', `
    INSERT INTO routes VALUES('N','N','Night',3,'000000'),('D','D','Day',3,'000000');
    INSERT INTO trips VALUES('N1','N','S','0'),('D1','D','S','0');
    INSERT INTO connections VALUES(10800,12000,'N1','N','S','0','A','B',10),(45000,46200,'D1','D','S','0','A','B',10);
  `, async (context, assess) => {
    const at = '2026-09-14T03:05:00Z', night = assess(at)
    assert.equal(night.serviceContext.phase, 'scheduled_service')
    assert.equal(night.serviceContext.windowRoutes, 1)
    assert.equal(night.serviceContext.referenceRoutes, 3)
    assert.match(networkNarrative(night).overview, /^Most routes have no trips scheduled.*1 route.*unknown/)
    assert.equal(night.coverage.unknownTrips, 1, 'A real overnight trip without a prediction is not excused by the hour')
    const packet = await inspectOperationalService({ context, state: deriveOperationalState(context, null, epoch(at)), snapshot: null, directory: root }, {})
    assert.deepEqual(packet.serviceContext, night.serviceContext)
    assert.match(inspectionFacts(packet).facts.join(' '), /Most routes have no trips scheduled/)
  })

  await fixture('continuous-service', 'UPDATE connections SET departure=0,arrival=86400;', (_context, assess) => {
    const night = assess('2026-09-14T03:05:00Z')
    assert.equal(night.serviceContext.phase, 'scheduled_service', 'A continuous-service network is not classified inactive because it is night')
    assert.doesNotMatch(networkNarrative(night).overview, /between scheduled runs|Most routes/)
  })

  await fixture('frequency-service', "INSERT INTO frequencies VALUES('T1',0,86400,600,0);", (_context, assess) => {
    const night = assess('2026-09-14T03:05:00Z')
    assert.equal(night.serviceContext.phase, 'incomplete')
    assert.equal(night.status, 'prediction_coverage_unavailable')
    assert.match(networkNarrative(night).overview, /Frequency-based service.*unknown/)
    assert.doesNotMatch(networkNarrative(night).overview, /between scheduled runs/)
  })
  console.log('Service hours: local clock, planned overnight gaps, prior-date trips, night service, missing predictions, frequency limits, expired calendars, shared Ask context and service-start expiry passed.')
} finally { await fs.rm(root, { recursive: true, force: true }) }
