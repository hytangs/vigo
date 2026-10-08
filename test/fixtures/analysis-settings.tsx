import { useLayoutEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { AnalyzePanel } from '../../src/components/AnalyzePanel'
import { OperationProgress } from '../../src/components/OperationProgress'
import '../../src/App.css'
import '../../src/index.css'

const state = { current: {}, submitted: null }
function Fixture() {
  const [walk, setWalk] = useState(1.2), [speed, setSpeed] = useState(4.8), [limit, setLimit] = useState(45)
  const [transfers, setTransfers] = useState<number | undefined>(), [surface, setSurface] = useState('street')
  const [dark, setDark] = useState(false), [work, setWork] = useState({ completed: 25, total: 100, unit: 'routes' })
  window.setTheme = setDark; window.setWork = setWork
  state.current = { walk, speed, limit, transfers, surface }
  useLayoutEffect(() => {
    document.documentElement.dataset.appearance = dark ? 'dark' : 'light'
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
  }, [dark])
  return <main className={'app-shell page-project ' + (dark ? 'appearance-dark' : 'appearance-light')}>
    <header className="topbar"><strong>VIGO</strong><span>Accessibility</span></header>
    <div className="app-frame"><div className="shell-body">
      <aside className="app-sidebar">
        <nav className="sidebar-rail" aria-label="Navigation"><button className="sidebar-rail-button" aria-current="page">◎</button></nav>
        <section className="sidebar-panel is-analyze">
          <div className="sidebar-panel-head"><h1 className="studio-page-title">Analyze</h1></div>
          <AnalyzePanel mode="single" origin={{ coordinate: [-71.1, 42.36], label: 'Starting point', source: 'map' }}
            serviceDate="2026-10-07" departMinutes={535} maxWalkKm={walk} walkSpeedKph={speed} maxTransfers={transfers}
            cutoffMinutes={limit} surfaceSampling={surface} cases={[]} feeds={[]} comparisonFeedIds={[]} routes={[]} stops={[]}
            analysis={null} preparationTasks={[]} routingStoreAvailable streetGraphAvailable
            onMaxWalkKmChange={setWalk} onWalkSpeedChange={setSpeed} onMaxTransfersChange={setTransfers}
            onCutoffChange={setLimit} onSurfaceSamplingChange={setSurface} onModeChange={() => {}}
            onRun={() => { state.submitted = { ...state.current } }} onServiceDateChange={() => {}} onDepartMinutesChange={() => {}} />
        </section>
      </aside>
      <section style={{ minWidth: 0, overflow: 'hidden', padding: 16 }} aria-label="Progress example">
        <OperationProgress phase="Loading schedules" work={work} />
      </section>
    </div></div>
  </main>
}
flushSync(() => createRoot(document.getElementById('root')).render(<Fixture />))

function field(name) {
  const label = [...document.querySelectorAll('.reach-settings-list label')].find(l => l.querySelector('span')?.textContent === name)
  if (!label) throw Error('Missing field: ' + name)
  return label.querySelector('input,select')
}
function input(name, value) {
  const el = field(name)
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  setter.call(el, String(value))
  flushSync(() => el.dispatchEvent(new Event('input', { bubbles: true })))
}
function select(value) {
  const el = field('Area calculation'); el.value = value
  flushSync(() => el.dispatchEvent(new Event('change', { bubbles: true })))
}
function assert(condition, message) { if (!condition) throw Error(message) }
window.checkSettings = async () => {
  document.querySelector('.reach-advanced').open = true
  input('Time budget', 37.25); input('Final walk limit', 0.35); input('Walking speed', 4.65)
  input('Maximum transit rides', 1)
  assert(state.current.limit === 37.25 && state.current.walk === 0.35 && state.current.speed === 4.65, 'Exact values were rounded')
  assert(state.current.transfers === 0, 'One ride must permit zero transfers')
  document.querySelector('.reach-run').click()
  assert(state.submitted?.limit === 37.25 && state.submitted?.transfers === 0, 'Run did not submit edited limits')
  state.submitted = null
  input('Maximum transit rides', 0); document.querySelector('.reach-run').click()
  assert(state.current.transfers === 0 && state.submitted === null, 'Invalid rides must not enter a request')
  input('Maximum transit rides', 2.5)
  assert(!field('Maximum transit rides').validity.valid && state.current.transfers === 0, 'Fractional rides were accepted')
  input('Maximum transit rides', 3)
  assert(state.current.transfers === 2, 'Ride count must convert to transfer count')
  input('Maximum transit rides', '')
  assert(state.current.transfers === undefined, 'Clearing the ride limit must restore automatic')
  input('Maximum transit rides', 2)
  select('cell-center'); assert(field('Walking speed').disabled, 'Grid walking speed must be fixed')
  select('street'); assert(!field('Walking speed').disabled && state.current.speed === 4.65, 'Street walking speed must remain editable')
  const slider = document.querySelector('.reach-budget-slider')
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(slider, '79.25')
  flushSync(() => slider.dispatchEvent(new Event('input', { bubbles: true })))
  await new Promise(resolve => requestAnimationFrame(resolve))
  assert(state.current.limit === 79.25 && field('Time budget').value === '79.25', 'Slider and precise time disagree')
  input('Time budget', 37.25)
  document.querySelector('.reach-advanced').open = false
  document.querySelector('.reach-advanced').open = true
  assert(field('Final walk limit').value === '0.35', 'Expanding walking settings lost the custom value')
  flushSync(() => window.setWork({ completed: 50, total: 100, unit: 'routes' }))
  assert(document.querySelector('progress').value === 50, 'Measured progress is not advancing')
  flushSync(() => window.setWork(undefined))
  assert(!document.querySelector('progress').hasAttribute('value'), 'Unknown work must be indeterminate')
  flushSync(() => window.setWork({ completed: 25, total: 100, unit: 'routes' }))
  return { exactValues: true, rideLimits: true, validSubmissions: true, progress: true }
}
window.checkLayout = dark => {
  flushSync(() => window.setTheme(dark))
  const panel = document.querySelector('.reach-surface'), list = document.querySelector('.reach-settings-list')
  const sidebar = document.querySelector('.app-sidebar'), expand = document.querySelector('.reach-expand')
  const expanded = expand.getAttribute('aria-expanded') === 'true'
  if (expanded) flushSync(() => expand.click())
  const compact = sidebar.getBoundingClientRect()
  flushSync(() => expand.click())
  const wide = sidebar.getBoundingClientRect()
  assert(innerWidth > 760 ? wide.width > compact.width + 50 : wide.height > compact.height + 50, 'Expand does not increase available space')
  assert(panel.clientHeight > 80 && panel.getBoundingClientRect().bottom <= innerHeight, 'Panel is outside its scroll area')
  assert(panel.scrollWidth <= panel.clientWidth + 1, 'Panel has horizontal overflow')
  for (const el of list.querySelectorAll('input:not([type=range]),select')) {
    const r = el.getBoundingClientRect()
    assert(r.left >= 0 && r.right <= innerWidth + 1, 'Control overflows')
    if (el.tagName === 'SELECT') {
      const c = document.createElement('canvas').getContext('2d'); c.font = getComputedStyle(el).font
      assert(c.measureText(el.selectedOptions[0].textContent).width + 40 <= r.width, 'Selected option is clipped')
    }
  }
  assert(+getComputedStyle(list.querySelector('small')).fontWeight <= 500, 'Helper text is too heavy')
  panel.scrollTop = 0
  const initialRun = document.querySelector('.reach-run').getBoundingClientRect()
  assert(initialRun.bottom <= panel.getBoundingClientRect().bottom, 'Run should stay visible while browsing controls')
  panel.scrollTop = panel.scrollHeight
  const run = document.querySelector('.reach-run').getBoundingClientRect(), bounds = panel.getBoundingClientRect()
  assert(run.top >= bounds.top && run.bottom <= bounds.bottom, 'Run button cannot be reached by scrolling')
  const scrolled = panel.scrollTop
  panel.scrollTop = 0
  return { width: innerWidth, panelWidth: wide.width, compactHeight: compact.height, expandedHeight: wide.height, scrolled, dark }
}
