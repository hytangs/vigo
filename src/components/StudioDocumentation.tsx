import { useState } from 'react'
import guideUrl from '../../docs/guide.html?url'
import schemaUrl from '../../docs/standalone-openapi.json?url'
import type { Appearance } from '../domain'

export function StudioDocumentation({ appearance }: { appearance: Appearance }) {
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const readerOptions = new URLSearchParams({ embedded: '1', theme: appearance, schema: schemaUrl })
  return <section className="settings-documentation" aria-labelledby="settings-docs-title">
    <div className="settings-section-heading"><div><h2 id="settings-docs-title">Documentation</h2><p>Search and read the VIGO guide offline: Studio, the engine and its HTTP API, Python, and Results.</p></div></div>
    <div className="settings-docs-toolbar">
      <a href={schemaUrl} download="standalone-openapi.json">Download the API schema</a>
    </div>
    {!loaded && !failed ? <p className="settings-note" role="status">Opening documentation…</p> : null}
    {failed ? <p className="form-error" role="alert">The bundled guide could not open. <button type="button" onClick={() => { setFailed(false); setLoaded(false); setAttempt(value => value + 1) }}>Try again</button></p> : null}
    <iframe key={attempt} title="VIGO documentation" className="settings-docs-frame" aria-busy={!loaded}
      src={`${guideUrl}?${readerOptions}`}
      onLoad={event => { setLoaded(true); setFailed(!event.currentTarget.contentDocument?.querySelector('#chapters')) }}
      onError={() => { setFailed(true); setLoaded(false) }} />
  </section>
}
