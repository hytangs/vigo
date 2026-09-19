import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AgencyContext } from '../src/agency/agencyContext.mjs'
import { deriveOperationalState } from '../src/agency/realtimeIntelligence.mjs'
import { createAgencyFixture, observationTime, realtimeFixture, tripUpdate } from '../test/fixtures/agency.mjs'

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agency-figure-'))
const file = path.join(directory, 'city.sqlite')
createAgencyFixture(file)
const context = new AgencyContext(file, 'City X')
try {
  const cases = [
    { title: 'Matches the timetable', snapshot: realtimeFixture(), description: 'All three trips report. The measured intervals match the schedule.' },
    { title: 'A wider interval', snapshot: realtimeFixture([tripUpdate('T1'), tripUpdate('T2', 600)]), description: 'These two adjacent departures both report. Their interval is twice the scheduled interval.' },
    { title: 'An unanswered question', snapshot: realtimeFixture([tripUpdate('T1'), tripUpdate('T3', 600)]), description: 'The trip in between does not report. A long gap between reports cannot establish a service gap.' },
  ].map((item) => ({ ...item, state: deriveOperationalState(context, item.snapshot, observationTime) }))
  const wider = cases[1].state.events.find((event) => event.type === 'service-gap').evidence
  const departures = context.expectedDepartures(context.trips[0], 'A', '2026-09-13', 43200, 45000)
  const normalInterval = (departures[1].departure - departures[0].departure) / 60
  const missingInterval = (departures[2].departure - departures[0].departure) / 60
  const panels = cases.map((item, index) => {
    const x = 30 + index * 324
    const values = index === 0 ? [normalInterval, normalInterval] : index === 1 ? [wider.scheduledHeadwaySeconds / 60, wider.observedHeadwaySeconds / 60] : [missingInterval, null]
    return `<g transform="translate(${x},140)"><rect width="306" height="327" rx="15" fill="#171c20" stroke="#30373e"/><text x="20" y="34" class="eyebrow">0${index + 1}</text><text x="20" y="66" class="title">${item.title}</text><text x="20" y="105" class="label">Scheduled interval</text><rect x="20" y="117" width="${values[0] * 10}" height="7" rx="3" fill="#58636b"/><text x="20" y="151" class="value">${values[0]} min</text><text x="20" y="194" class="label">${index === 2 ? 'Comparable departure interval' : 'Predicted interval'}</text>${values[1] == null ? '<path d="M20 210 H220" stroke="#58636b" stroke-dasharray="5 6"/><text x="20" y="243" class="value">Unknown</text>' : `<rect x="20" y="206" width="${values[1] * 10}" height="7" rx="3" fill="#b5c568"/><text x="20" y="240" class="value accent">${values[1]} min</text>`}<text x="20" y="289" class="label">${index === 0 ? '3 of 3 trips reporting' : index === 1 ? '2 of 2 departures in this pair report' : 'The middle departure is missing'}</text></g>`
  }).join('')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1032" height="556" viewBox="0 0 1032 556" role="img" aria-labelledby="title description"><title id="title">Why Agency compares departures with the timetable</title><desc id="description">Three synthetic City X cases: a ten-minute interval that matches the timetable, a twenty-minute interval instead of ten, and an unknown interval because the middle trip does not report.</desc><style>text{font-family:Inter,Arial,sans-serif;fill:#edf0ed}.eyebrow{font-size:11px;letter-spacing:2px;fill:#b5c568}.title{font-size:18px;font-weight:600}.label{font-size:12px;fill:#a3adb4}.value{font-size:30px;font-weight:500}.accent{fill:#c2d17f}</style><rect width="1032" height="556" rx="20" fill="#101418"/><text x="30" y="38" class="eyebrow">VIGO AGENCY · CITY X</text><text x="30" y="78" font-size="29" font-weight="600">A gap between reports is not enough.</text><text x="30" y="108" class="label">Compare the same scheduled departures at the same stop. Keep missing evidence visible.</text>${panels}<text x="30" y="505" class="label">Synthetic example · Values computed by the same departure-comparison code used in Live.</text><text x="30" y="530" class="label">These are predictions, not observed vehicle passages or proof of route-wide reliability.</text></svg>`
  await fs.mkdir('docs/images', { recursive: true })
  await fs.mkdir('docs/examples', { recursive: true })
  await fs.writeFile('docs/images/departure-comparison.svg', svg)
  await fs.writeFile('docs/examples/city-x.json', JSON.stringify({ kind: 'synthetic fixture', serviceDate: '2026-09-13', cases: cases.map(({ title, description, state }) => ({ title, description, counts: state.counts, events: state.events, warnings: state.warnings })) }, null, 2) + '\n')
  console.log('Rendered docs/images/departure-comparison.svg and its computed City X evidence.')
} finally { context.close(); await fs.rm(directory, { recursive: true, force: true }) }
