import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createSsrTestServer as createServer } from './helpers/ssr-test-server.mjs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const directory = await mkdtemp(path.join(tmpdir(), 'vigo-depart-now-ui-'))
const server = await createServer({ configFile: false, cacheDir: path.join(directory, 'vite-cache'), server: { host: '127.0.0.1', port: 0 } })
try {
  const { SidebarPathfinderBox } = await server.ssrLoadModule('/src/components/PathfinderPanel.tsx')
  const props = {
    routingEnabled: false, routingOrigin: null, routingWaypoints: [], routingDestination: null,
    routingPlan: null, routingChoices: [], routingScopeStatus: 'ready', routingStoreReady: true,
    routingTimePreference: 'arrive', routingMode: 'transit', routingDataMode: 'realtime',
    routingDepartureWindowMinutes: 20, routingMaxWalkKm: 1.2, routingAllowLongWalk: false,
    routingActivity: { kind: 'idle', title: '', detail: '' }, routingAlternativesLoading: false,
    routingServiceDate: '2026-09-15', routingServiceCoverage: null,
    routingServiceDateAvailability: 'outside', routingServiceDateOptions: [{ date: '2026-09-16', label: 'September 16' }],
    storeBackedRouting: true, scheduleTimeMinutes: 480, routingPickIndex: null,
  }
  const render = patch => renderToStaticMarkup(createElement(SidebarPathfinderBox, { ...props, ...patch }))
  const live = render()
  assert.match(live, /Depart now/)
  assert.doesNotMatch(live, /type="(?:date|time)"|Time preference|Arrive by|September 16|Date outside timetable/,
    'Realtime exposes no stale clock, arrive-by, or historical date correction')
  assert.match(live, /Departure search window/, 'Retained arrive-by does not hide the live departure search control')

  const research = render({ routingDataMode: 'scheduled', routingServiceDateAvailability: 'covered' })
  assert.doesNotMatch(research, /Depart now/)
  assert.match(research, /aria-label="Routing service date"[^>]*value="2026-09-15"/)
  assert.match(research, /aria-label="Routing time"[^>]*value="08:00"/)
  assert.match(research, /aria-pressed="true"[^>]*>Arrive<\/button>/, 'Research retains the original arrive-by selection')
  const capped = render({ routingMaxTransfers: 1 })
  assert.match(capped, /option value="1" selected=""/, 'Two-point routes retain the requested transfer limit')
  const via = render({ routingMaxTransfers: 1, routingWaypoints: [{ id: 'via', label: 'Via', lat: 0, lon: 0, source: 'map' }] })
  assert.match(via, /id="pathfinder-max-transfers"[^>]*disabled=""/, 'Via-point routes cannot select the unsupported transfer cap')
  assert.match(via, /option value="" selected=""/, 'Disabled control shows the effective unlimited search')
  assert.match(via, /Transfer limits are available for routes without via points/)
  assert.doesNotMatch(via, /≤1 transfers/, 'The summary cannot claim a cap that was not applied')
  const unavailable = render({ routingPlan: { status: 'blocked', title: 'No timetable service', detail: 'No complete timetable for this service date.' } })
  assert.match(unavailable, /Timetable unavailable for now/)
  assert.match(unavailable, /Use Scheduled/)
  assert.doesNotMatch(unavailable, /September 16|type="date"/, 'A missing current timetable cannot silently redirect realtime to historical service')
  for (const routingMode of ['walk', 'drive']) {
    const street = render({ routingMode })
    assert.doesNotMatch(street, /Depart now/)
    assert.match(street, /aria-label="Routing time"[^>]*value="08:00"/, 'Street mode retains its clock')
  }
  console.log('Depart now presentation passed: fixed realtime clock, retained research date/time and arrive-by, current-date failure, and unchanged street controls.')
} finally { await server.close(); await rm(directory, { recursive: true, force: true }) }
