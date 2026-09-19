import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createSsrTestServer as createServer } from './helpers/ssr-test-server.mjs'
import react from '@vitejs/plugin-react'

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-activity-'))
const server = await createServer({ configFile: false, plugins: [react()], cacheDir: path.join(directory, 'cache'), server: { middlewareMode: true }, appType: 'custom' })
try {
  const { AgencyActivity } = await server.ssrLoadModule('/src/components/AgencyActivity.tsx')
  const call = (tool, ok = true) => ({ tool, arguments: {}, result: { ok, warnings: ok ? [] : ['Feed unavailable'] } })
  const activities = [
    { phase: 'planning', progress: 0, detail: 'Working on your request…' },
    { phase: 'tool-0', progress: 1, detail: 'The check is complete.' },
    { phase: 'response', progress: 0, detail: 'Putting the findings together…' },
  ]
  const render = (trace, extra = {}) => renderToStaticMarkup(createElement(AgencyActivity, { activities, busy: false, trace, ...extra }))
  let html = render([call('assess_service')])
  assert.match(html, /Service assessment · complete/)
  assert.match(html, /Service assessment: Complete/)
  assert.doesNotMatch(html, /1 check completed|The check is complete|Putting the findings together/,
    'A completed saved response exposes the tool actually called, not generic or unfinished progress')
  assert.match(html, /Download technical record/)
  html = render([call('assess_service'), call('service_alerts')])
  assert.match(html, /2 tools used/)
  assert.match(html, /Agency alerts: Complete/)
  html = render([call('assess_service', false)])
  assert.match(html, /Service assessment · failed/)
  assert.match(html, /Feed unavailable/)
  assert.doesNotMatch(html, /Service assessment · complete/)
  html = render([call('assess_service'), call('service_alerts', false)])
  assert.match(html, /1 of 2 tools completed/)
  assert.match(render([], { busy: true }), /Putting the findings together/)
  assert.equal(render([], { activities: [] }), '', 'An answer without a tool call must not claim a completed check')
  assert.match(render([call('assess_service')], { activities: [{ phase: 'stopped', progress: 1, detail: 'Stopped' }] }), /Stopped · saved for later/)
  assert.match(render([call('assess_service')], { activities: [{ phase: 'provider-error', progress: 1, detail: 'Unavailable' }] }), /Response interrupted/)
} finally {
  await server.close()
  await fs.rm(directory, { recursive: true, force: true })
}
console.log('Agency activity: actual tool names, saved generic progress, failure counts, interrupted responses, and no-tool answers passed.')
