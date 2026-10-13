import { useState } from 'react'
import guideUrl from '../../docs/guide.html?url'
import nativeUrl from '../../docs/standalone.html?url'
import schemaUrl from '../../docs/standalone-openapi.json?url'
import type { Appearance } from '../domain'

export function StudioDocumentation({ appearance }: { appearance: Appearance }) {
  const [reader, setReader] = useState<'guide' | 'native'>('guide')
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const readerOptions = new URLSearchParams({ embedded: '1', theme: appearance, guide: guideUrl, reference: nativeUrl, schema: schemaUrl })
  return <section className="settings-documentation" aria-labelledby="settings-docs-title">
    <div className="settings-section-heading"><div><h2 id="settings-docs-title">Documentation</h2><p>Search and read the bundled guide offline.</p></div></div>
    <div className="settings-docs-toolbar">
      <div role="group" aria-label="Documentation guide">
        {(['guide', 'native'] as const).map(value => <button type="button" key={value} aria-pressed={reader === value} onClick={() => { if (reader !== value) { setReader(value); setLoaded(false); setFailed(false) } }}>{value === 'guide' ? 'Studio & engine' : 'CLI & HTTP reference'}</button>)}
      </div>
      {reader === 'native' ? <a href={schemaUrl} download="standalone-openapi.json">API schema</a> : null}
    </div>
    {!loaded && !failed ? <p className="settings-note" role="status">Opening documentation…</p> : null}
    {failed ? <p className="form-error" role="alert">The bundled guide could not open. <button type="button" onClick={() => { setFailed(false); setLoaded(false); setAttempt(value => value + 1) }}>Try again</button></p> : null}
    <iframe key={`${reader}-${attempt}`} title="VIGO documentation" className="settings-docs-frame" aria-busy={!loaded}
      src={`${reader === 'guide' ? guideUrl : nativeUrl}?${readerOptions}`}
      onLoad={event => { setLoaded(true); setFailed(!event.currentTarget.contentDocument?.querySelector('#chapters')) }}
      onError={() => { setFailed(true); setLoaded(false) }} />
  </section>
}
