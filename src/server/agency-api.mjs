import fs from 'node:fs/promises'
import path from 'node:path'
import { createNotebook } from '../agency/notebook.mjs'
import { networkBriefing, synthesizeEvidence } from '../agency/briefing.mjs'
import { AgencyContext } from '../agency/agencyContext.mjs'
import { createObservationHistory, deriveOperationalState, defaultPolicy } from '../agency/realtimeIntelligence.mjs'
import { createSkillRegistry } from '../agency/skillRegistry.mjs'
import { createToolRegistry } from '../agency/toolRegistry.mjs'
import { createProvider } from '../agency/provider.mjs'
import { queryAgency, summarizeEvidence } from '../agency/queryAgent.mjs'

export function createAgencyService(adapters, { provider = createProvider(), clock = () => Date.now(), policy = defaultPolicy, refreshMs = 10_000 } = {}) {
  const sessions = new Map()
  async function sessionFor(projectId) {
    const { storePath, cityName, agencyDirectory } = await adapters.context(projectId)
    const stat = await fs.stat(storePath)
    let session = sessions.get(projectId)
    if (session && (session.storePath !== storePath || session.modified !== stat.mtimeMs)) {
      clearInterval(session.timer)
      session.generation++
      session.context.close()
      session.notebook.close()
      sessions.delete(projectId)
      session = null
    }
    if (!session) {
      if (sessions.size >= 8) {
        const [oldId, old] = [...sessions].sort((a, b) => a[1].lastRead - b[1].lastRead)[0]
        clearInterval(old.timer); old.generation++; old.context.close(); old.notebook.close(); sessions.delete(oldId)
      }
      const notebook = createNotebook(agencyDirectory || path.join(path.dirname(storePath), 'agency'))
      const retained = notebook.get('observation') ?? {}
      session = { notebook, storePath, modified: stat.mtimeMs, context: new AgencyContext(storePath, cityName), snapshot: retained.snapshot ?? null, request: retained.request ?? null, generation: 0, inFlight: null, timer: null,
        history: createObservationHistory(policy, retained), skills: createSkillRegistry({ directory: adapters.skillDirectory, installedDirectory: path.join(notebook.directory, 'skills'), preferences: notebook.get('skills') ?? {} }), lastRead: clock() }
      sessions.set(projectId, session)
    }
    session.lastRead = clock()
    session.context.cityName = cityName
    return session
  }

  function current(session) {
    const state = deriveOperationalState(session.context, session.snapshot, clock() / 1000, policy)
    return { ...state, ...session.history.update(state), provider: provider.status?.() ?? { available: provider.available, model: provider.model } }
  }

  async function refresh(session) {
    if (!session.request) return session.snapshot
    if (session.inFlight) return session.inFlight
    const generation = session.generation
    const request = session.request
    session.inFlight = (async () => {
      const snapshot = await adapters.inspectRealtime(request)
      if (generation === session.generation) { session.snapshot = snapshot; const retained = session.history.update(current(session)); session.notebook.set('observation', { request: session.request, snapshot, ...retained }) }
      return session.snapshot
    })().finally(() => { session.inFlight = null })
    return session.inFlight
  }

  async function connect(projectId, request) {
    const session = await sessionFor(projectId)
    const coverage = session.context.coverage(clock() / 1000)
    if (!coverage.valid) throw Object.assign(new Error(coverage.message), { statusCode: 409 })
    const sameRequest = JSON.stringify(session.request) === JSON.stringify(request)
    if (!sameRequest) { session.generation++; session.request = request; if (session.inFlight) await session.inFlight }
    if (!sameRequest || !session.snapshot || clock() - Date.parse(session.snapshot.fetchedAt) >= refreshMs - 1000) await refresh(session)
    if (!session.timer) {
      session.timer = setInterval(() => {
        if (clock() - session.lastRead > 5 * 60_000) { clearInterval(session.timer); session.timer = null; return }
        void refresh(session).catch(() => {}) // Failed feeds are recorded by the existing inspector; previous timestamps continue aging.
      }, refreshMs)
      session.timer.unref?.()
    }
    return session.snapshot
  }

  return {
    connect,
    async disconnect(projectId) {
      const session = await sessionFor(projectId)
      session.generation++; clearInterval(session.timer); session.timer = null; session.request = null; session.snapshot = null
      session.history = createObservationHistory(policy)
      session.notebook.set('observation', null)
      return { ok: true }
    },
    async state(projectId, { routeId = '', eventType = '' } = {}) {
      const session = await sessionFor(projectId)
      if (routeId && !session.context.routeIndex.has(routeId)) throw Object.assign(new Error('Unknown route filter.'), { statusCode: 400 })
      if (session.request && !session.timer && session.context.coverage(clock() / 1000).valid) await connect(projectId, session.request)
      const state = current(session)
      const { trips, ...publicState } = state
      const selected = state.events.filter((event) => (!routeId || event.routeId === routeId || event.routeIds?.includes(routeId)) && (!eventType || eventType === 'all' || event.type === eventType))
      return { ...publicState, filters: { routeId, eventType }, filteredEventCount: selected.length,
        stopLocations: Object.fromEntries(selected.slice(0, 500).flatMap((event) => { const stop = session.context.stopIndex.get(event.stopId); return stop ? [[stop.stop_id, { label: stop.name, coordinate: [stop.lon, stop.lat] }]] : [] })),
        stopNames: Object.fromEntries(selected.slice(0, 500).flatMap((event) => event.stopId ? [[event.stopId, session.context.stopIndex.get(event.stopId)?.name || event.stopId]] : [])),
        eventCount: state.events.length, events: selected.slice(0, 500), warnings: [...state.warnings, ...(selected.length > 500 ? ['Showing the first 500 matching events. Choose a route or event type to narrow the view.'] : [])] }
    },
    async handle(projectId, body, signal, onProgress) {
      if (body.action === 'provider-status') return provider.status()
      if (body.action === 'provider-models') return provider.models(body.connection, signal)
      if (body.action === 'provider-connect') return provider.connect(body.connection, signal)
      if (body.action === 'provider-disconnect') return provider.disconnect()
      const session = await sessionFor(projectId)
      switch (body.action) {
        case 'connection': return { request: session.request }
        case 'notebook': return { entries: session.notebook.list(body.query ?? {}) }
        case 'notebook-entry': { const entries = []; let id = body.id; while (id && entries.length < 30) { const entry = session.notebook.read(id); entries.unshift(entry); id = entry.parentId } return { entries } }
        case 'notebook-note': return session.notebook.annotate(body.id, body.notes)
        case 'briefing-latest': return { entry: session.notebook.latest('briefing') }
        case 'skills': return { skills: session.skills.list() }
        case 'skill-install': return { skills: session.skills.install(body.skill) }
        case 'skill-enabled': { const skill = session.skills.setEnabled(body.id, body.enabled); session.notebook.set('skills', Object.fromEntries(session.skills.list().map((item) => [item.id, item.enabled]))); return { skill } }
      }
      const state = current(session)
      const activities = []
      const progress = (item) => { const previous = activities.findIndex((entry) => entry.phase === item.phase); if (previous < 0) activities.push(item); else activities[previous] = item; onProgress?.(item) }
      const retain = (title, answer, kind = 'ask') => { const entry = session.notebook.save({ title, answer, activities, kind, parentId: body.parentId ?? null }); return { ...answer, entryId: entry.id } }
      const callTool = createToolRegistry({ context: session.context, state, snapshot: session.snapshot, provider, signal,
        adapters: { matrix: (request, abort) => adapters.matrix(projectId, request, abort), route: (request, abort) => adapters.route(projectId, request, abort), reach: (request, abort) => adapters.reach(projectId, request, abort) } })
      switch (body.action) {
        case 'connect': return { snapshot: await connect(projectId, body.request) }
        case 'disconnect': return this.disconnect(projectId)
        case 'tool': return callTool(body.name, body.arguments ?? {})
        case 'briefing': { if (!session.briefingJob) session.briefingJob = networkBriefing({ state, callTool, provider, signal, onProgress: progress }).then((answer) => retain('Network briefing', answer, 'briefing')).finally(() => { session.briefingJob = null }); return session.briefingJob }
        case 'ask': {
          const history = []
          let parentId = body.parentId
          while (parentId && history.length < 6) { const previous = session.notebook.read(parentId); history.unshift({ question: previous.title, answer: previous.answer.answer, observedAt: previous.answer.generatedAt }); parentId = previous.parentId }
          return retain(body.question, await queryAgency({ question: body.question, context: session.context, state, callTool, provider, signal, onProgress: progress, history }))
        }
        case 'run-skill': {
          const result = await session.skills.run(body.id, body.inputs ?? {}, callTool, progress)
          const trace = result.results
          let summary = { text: summarizeEvidence(trace), aiGenerated: false }, warning
          try { summary = await synthesizeEvidence({ trace, provider, signal, instructions: result.skill.instructions, onProgress: progress }) }
          catch (error) { if (signal?.aborted) throw error; warning = error.message }
          const rows = trace.flatMap(({ tool, result }) => result.data.rows ?? (tool === 'anomaly_scan' ? (result.data.events ?? []).filter((event) => event.evidence.observedHeadwaySeconds != null).map((event) => ({ route: event.routeName || event.routeId, reference_stop: event.stopName || event.stopId, observed_at: event.observedAt, predicted_minutes: event.evidence.observedHeadwaySeconds / 60, scheduled_minutes: event.evidence.scheduledHeadwaySeconds / 60, difference_minutes: (event.evidence.observedHeadwaySeconds - event.evidence.scheduledHeadwaySeconds) / 60 })) : []))
          const answer = { answer: summary.text, aiGenerated: summary.aiGenerated, model: summary.model, citations: summary.citations, trace, report: { title: result.skill.name, method: result.skill.instructions, inputs: body.inputs ?? {}, rows }, generatedAt: state.generatedAt, evidenceRefs: [...new Set(trace.flatMap((call) => call.result.provenance))], warnings: [...new Set(trace.flatMap((call) => call.result.warnings)), ...(warning ? [warning] : [])], providerAvailable: provider.available }
          return retain(result.skill.name, answer, 'research')
        }
        default: throw Object.assign(new Error('Unknown Agency action.'), { statusCode: 400 })
      }
    },
    close() { for (const session of sessions.values()) { clearInterval(session.timer); session.generation++; session.context.close(); session.notebook.close() } sessions.clear() },
  }
}
