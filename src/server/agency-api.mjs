import { queryRuntimeFacts, withRuntimeActivity } from '../agency/runtimeFacts.mjs'
import { indexedEntityId, workspaceSelection, selectedStopIds, eventInSelection } from '../agency/workspaceSelection.mjs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createNotebook } from '../agency/notebook.mjs'
import { networkBriefing, synthesizeEvidence } from '../agency/briefing.mjs'
import { AgencyContext } from '../agency/agencyContext.mjs'
import { createObservationHistory, deriveOperationalState, defaultPolicy } from '../agency/realtimeIntelligence.mjs'
import { createSkillRegistry } from '../agency/skillRegistry.mjs'
import { createToolRegistry } from '../agency/toolRegistry.mjs'
import { createProvider } from '../agency/provider.mjs'
import { queryAgency } from '../agency/queryAgent.mjs'
import { createPlaceSearch } from '../agency/placeSearch.mjs'
import { routeOperations, vehicleDetails } from '../agency/routeOperations.mjs'
import { stopBoard } from '../agency/stopBoard.mjs'
import { createWebResearch } from '../agency/webResearch.mjs'
import { readPublicPage } from './agency-web.mjs'
import { createOperationsStore } from '../agency/operationsStore.mjs'
import { operationsActions, handleOperations } from '../agency/operationsService.mjs'
import { authorize, recordIdentity } from '../agency/operations.mjs'
import { createReplayService } from '../agency/replayService.mjs'
import { briefingPreferences, defaultBriefingPreferences, briefingStatus } from '../agency/briefingSchedule.mjs'

export function createAgencyService(adapters, { provider = createProvider(), web = createWebResearch({ readPage: readPublicPage }), clock = () => Date.now(), policy = defaultPolicy, refreshMs = 10_000,
  access = async () => ({ id: 'local-owner', role: 'admin' }) } = {}) {
  const sessions = new Map()
  let closed = false
  function retire(session) {
    clearInterval(session.timer)
    session.timer = null
    session.generation++
    session.retired = true
    if (!session.active && !session.disposed) {
      session.disposed = true
      session.context.close()
      session.notebook.close()
      session.operations.close()
      session.replay?.close()
    }
  }
  async function withSession(projectId, run) {
    const session = await sessionFor(projectId)
    try { return await run(session) }
    finally { session.active--; if (session.retired) retire(session) }
  }
  async function sessionFor(projectId) {
    const { storePath, cityName, agencyDirectory, feedIds = [] } = await adapters.context(projectId)
    const stat = await fs.stat(storePath)
    if (closed) throw new Error('Agency service is closed.')
    let session = sessions.get(projectId)
    if (session && (session.storePath !== storePath || session.modified !== stat.mtimeMs)) {
      retire(session)
      sessions.delete(projectId)
      session = null
    }
    if (!session) {
      if (sessions.size >= 8) {
        const [oldId, old] = [...sessions].sort((a, b) => a[1].lastRead - b[1].lastRead)[0]
        retire(old); sessions.delete(oldId)
      }
      const notebook = createNotebook(agencyDirectory || path.join(path.dirname(storePath), 'agency'))
      let context, operations
      try {
        context = new AgencyContext(storePath, cityName)
        operations = createOperationsStore(notebook.directory, projectId, clock)
        const retained = notebook.get('observation') ?? {}
        session = { notebook, storePath, modified: stat.mtimeMs, context, snapshot: retained.snapshot ?? null, request: retained.request ?? null, generation: 0, inFlight: null, timer: null,
          active: 0, retired: false, disposed: false, history: createObservationHistory(policy, retained), skills: createSkillRegistry({ directory: adapters.skillDirectory, installedDirectory: path.join(notebook.directory, 'skills'), preferences: notebook.get('skills') ?? {} }), lastRead: clock() }
        session.places = createPlaceSearch({ stops: session.context.stops })
        session.operations = operations
        session.scheduleIdentity = recordIdentity([storePath, stat.size, stat.mtimeMs])
      } catch (error) { operations?.close(); context?.close(); notebook.close(); throw error }
      sessions.set(projectId, session)
    }
    session.lastRead = clock()
    session.context.cityName = cityName
    session.feedIds = feedIds
    session.active++
    return session
  }

  function current(session) {
    const state = deriveOperationalState(session.context, session.snapshot, clock() / 1000, policy)
    try { session.operations.observe(state, session.scheduleIdentity); session.storageError = null }
    catch (error) { session.storageError = `Operations history could not be retained: ${error.message}` }
    return { ...state, ...session.history.update(state), warnings: [...state.warnings, ...session.skills.warnings(), ...(session.storageError ? [session.storageError] : []), ...(session.refreshError ? [session.refreshError] : [])], provider: { ...(provider.status?.() ?? { available: provider.available, model: provider.model }), web: web.status() } }
  }

  async function refresh(session) {
    if (!session.request) return session.snapshot
    if (session.inFlight) return session.inFlight
    const generation = session.generation
    const request = session.request
    session.inFlight = (async () => {
      let snapshot
      try { snapshot = await adapters.inspectRealtime(request); if (generation === session.generation) session.refreshError = null }
      catch (error) { if (generation === session.generation) session.refreshError = `Realtime refresh failed: ${error.message}`; throw error }
      if (generation === session.generation) { session.snapshot = snapshot; const { history, tripHistory } = current(session); session.notebook.set('observation', { request: session.request, snapshot, history, tripHistory }) }
      return session.snapshot
    })().finally(() => { session.inFlight = null })
    return session.inFlight
  }

  async function resume(projectId, request) {
    return withSession(projectId, async session => {
      const coverage = session.context.coverage(clock() / 1000)
      if (!coverage.valid) throw Object.assign(new Error(coverage.message), { statusCode: 409 })
      const sameRequest = JSON.stringify(session.request) === JSON.stringify(request)
      if (!sameRequest) {
        session.generation++; session.request = request; session.snapshot = null; session.refreshError = null
        session.history = createObservationHistory(policy)
        // Commit the new source before its fetch. A failed replacement must never
        // present or restore an observation from the previously connected feed.
        session.notebook.set('observation', { request, snapshot: null, history: [], tripHistory: {} })
      }
      const generation = session.generation
      const assertCurrent = () => {
        if (session.retired || generation !== session.generation) throw Object.assign(new Error('This realtime connection was superseded or closed.'), { statusCode: 409 })
      }
      if (session.inFlight) {
        try { await session.inFlight }
        catch (error) { assertCurrent(); if (sameRequest) throw error }
        assertCurrent()
      }
      if (!sameRequest || !session.snapshot || clock() - Date.parse(session.snapshot.fetchedAt) >= refreshMs - 1000) {
        try { await refresh(session) }
        catch (error) { assertCurrent(); throw error }
      }
      assertCurrent()
      if (!session.timer) {
        session.timer = setInterval(() => {
          if (clock() - session.lastRead > 5 * 60_000) { clearInterval(session.timer); session.timer = null; return }
          void refresh(session).catch(() => {}) // Failed feeds are recorded by the existing inspector; previous timestamps continue aging.
        }, refreshMs)
        session.timer.unref?.()
      }
      return session.snapshot
    })
  }

  return {
    async connect(projectId, request) { authorize(await access(projectId), 'configure'); return resume(projectId, request) },
    async disconnect(projectId) {
      authorize(await access(projectId), 'configure')
      return withSession(projectId, async session => {
        session.generation++; clearInterval(session.timer); session.timer = null; session.request = null; session.snapshot = null; session.refreshError = null
        session.history = createObservationHistory(policy)
        session.notebook.set('observation', null)
        return { ok: true }
      })
    },
    async state(projectId, { routeId = '', stopId = '', eventType = '' } = {}) {
      authorize(await access(projectId), 'read')
      return withSession(projectId, async session => {
        const selection = workspaceSelection(session.context, { routeId, stopId }, session.feedIds)
        const stops = selectedStopIds(session.context, selection)
        if (session.request && !session.timer && session.context.coverage(clock() / 1000).valid) {
          try { await resume(projectId, session.request) } catch { /* Current reports keep aging; refresh failure is included below. */ }
        }
        const state = current(session)
        const { trips, measurements, ...publicState } = state
        const selected = state.events.filter((event) => eventInSelection(event, selection, stops) && (!eventType || eventType === 'all' || event.type === eventType))
        return { ...publicState, scheduleIdentity: session.scheduleIdentity, selection, filters: { routeId, stopId, eventType }, filteredEventCount: selected.length,
          stopLocations: Object.fromEntries(selected.slice(0, 500).flatMap((event) => { const stop = session.context.stopIndex.get(event.stopId); return stop ? [[stop.stop_id, { label: stop.name, coordinate: [stop.lon, stop.lat] }]] : [] })),
          stopNames: Object.fromEntries(selected.slice(0, 500).flatMap((event) => event.stopId ? [[event.stopId, session.context.stopIndex.get(event.stopId)?.name || event.stopId]] : [])),
          eventCount: state.events.length, events: selected.slice(0, 500), warnings: [...state.warnings, ...(selected.length > 500 ? ['Showing the first 500 matching events. Choose a route or event type to narrow the view.'] : [])] }
      })
    },
    async handle(projectId, body, signal, onProgress) {
      if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.action !== 'string') throw Object.assign(new Error('Choose an Agency action.'), { statusCode: 400 })
      // Principal comes from the trusted host, never from request JSON or a model tool.
      const principal = await access(projectId)
      authorize(principal, ['briefing-settings', 'web-connect', 'provider-models', 'provider-connect', 'provider-disconnect', 'skill-install', 'skill-enabled'].includes(body.action) ? 'configure' : body.action === 'notebook-note' ? 'finding' : 'read')
      if (body.action === 'web-status') return web.status()
      if (body.action === 'web-connect') return web.connect(body.connection, signal)
      if (body.action === 'provider-status') return provider.status()
      if (body.action === 'provider-models') return provider.models(body.connection, signal)
      if (body.action === 'provider-connect') return provider.connect(body.connection, signal)
      if (body.action === 'provider-disconnect') return provider.disconnect()
      return withSession(projectId, async session => {
        if (body.action.startsWith('replay-')) {
          session.replay ??= createReplayService(path.join(session.notebook.directory, 'replay'), projectId)
          return session.replay.handle(body, principal, signal, provider.forRequest?.() ?? provider)
        }
        if (operationsActions.has(body.action)) {
          const state = current(session)
          return handleOperations({ store: session.operations, state, context: session.context, scheduleIdentity: session.scheduleIdentity, principal, body,
            monitoring: { active: Boolean(session.timer), refreshing: Boolean(session.inFlight), refreshError: session.refreshError || null, storageError: session.storageError || null } })
        }
        const briefingSettings = body.action === 'briefing' ? session.notebook.get('briefing-preferences') ?? defaultBriefingPreferences : null
        switch (body.action) {
          case 'briefing': {
            const entry = body.force === true ? null : session.notebook.latest('briefing')
            if (body.force !== true && entry && (!briefingSettings.automatic || briefingStatus(entry, briefingSettings, clock(), session.scheduleIdentity).current)) return { ...entry.answer, entryId: entry.id, briefingPreferences: briefingSettings }
            // Sharing a retained or in-flight briefing needs no new assessment.
            // Expired and forced requests continue below with current evidence.
            if (session.briefingJob) return { ...await session.briefingJob, briefingPreferences: briefingSettings }
            break
          }
          case 'route-line': return routeOperations(session.context, session.snapshot, { ...body, routeId: indexedEntityId(session.context, 'route', body.routeId, session.feedIds) }, clock() / 1000, policy)
          case 'stop-board': return stopBoard(session.context, session.snapshot, { ...body, feedIds: session.feedIds }, clock() / 1000, policy)
          case 'vehicle': return vehicleDetails(session.context, session.snapshot, body, clock() / 1000, policy)
          case 'connection': return { request: session.request }
          case 'notebook': return { entries: session.notebook.list(body.query ?? {}) }
          case 'notebook-entry': { const entries = []; let id = body.id; while (id && entries.length < 30) { const entry = session.notebook.read(id); entries.unshift(entry); id = entry.parentId } return { entries } }
          case 'notebook-note': return session.notebook.annotate(body.id, body.notes, body.previousNotes)
          case 'briefing-settings': { const preferences = briefingPreferences(body.preferences); session.notebook.set('briefing-preferences', preferences); return { preferences } }
          case 'briefing-latest': {
            const entry = session.notebook.latest('briefing'), preferences = session.notebook.get('briefing-preferences') ?? defaultBriefingPreferences
            return { entry, ...briefingStatus(entry, preferences, clock(), session.scheduleIdentity) }
          }
          case 'skills': return { skills: session.skills.list() }
          case 'skill-install': return { skills: session.skills.install(body.skill) }
          case 'skill-enabled': { const skill = session.skills.setEnabled(body.id, body.enabled); session.notebook.set('skills', Object.fromEntries(session.skills.list().map((item) => [item.id, item.enabled]))); return { skill } }
        }
        const state = current(session)
        const activities = []
        const inference = provider.forRequest?.() ?? provider
        const research = web.forRequest()
        const progress = (item) => { if (item.preliminary) { onProgress?.(item); return }; const previous = activities.findIndex((entry) => entry.phase === item.phase); if (previous < 0) activities.push(item); else activities[previous] = item; onProgress?.(item) }
        const retain = (title, answer, kind = 'ask') => { const entry = session.notebook.save({ title, answer, activities, kind, parentId: body.parentId ?? null }); return { ...answer, entryId: entry.id } }
        const callTool = createToolRegistry({ context: session.context, state, snapshot: session.snapshot, notebook: session.notebook, operations: session.operations, scheduleIdentity: session.scheduleIdentity, places: session.places, web: research, signal, now: clock,
          adapters: { compareHolding: (caseId, abort) => { session.replay ??= createReplayService(path.join(session.notebook.directory, 'replay'), projectId); return session.replay.compare(caseId, abort) }, runtimeStudy: adapters.runtimeStudy, streetMatrix: adapters.streetMatrix ? (request, abort) => adapters.streetMatrix(projectId, request, abort) : undefined, matrix: (request, abort) => adapters.matrix(projectId, request, abort), route: (request, abort) => adapters.route(projectId, request, abort), reach: (request, abort) => adapters.reach(projectId, request, abort) } })
        switch (body.action) {
          case 'connect': return { snapshot: await this.connect(projectId, body.request) }
          case 'disconnect': return this.disconnect(projectId)
          case 'tool': return callTool(body.name, body.arguments ?? {})
          case 'briefing': {
            session.briefingJob = networkBriefing({ context: session.context, state, provider: inference, callTool, signal, scheduleIdentity: session.scheduleIdentity, onProgress: progress })
              .then(answer => retain('Network briefing', { ...answer, scheduleIdentity: session.scheduleIdentity }, 'briefing'))
              .finally(() => { session.briefingJob = null })
            return { ...await session.briefingJob, briefingPreferences: briefingSettings }
          }
          case 'ask': {
            const selection = workspaceSelection(session.context, body.selection, session.feedIds)
            const history = []
            let parentId = body.parentId
            while (parentId && history.length < 6) {
              const previous = session.notebook.read(parentId)
              // Retain the most recent journey inputs, even across intervening
              // explanations. Older plans must not overwrite a later revision.
              const categories = [['route_plan', 'walk_route', 'walk_compare', 'find_walk', 'reach'], ['place_search'], ['web_search', 'web_read', 'reference_lookup'], ['inspect_service', 'service_timing', 'stop_arrivals', 'realtime_status', 'anomaly_scan', 'service_alerts', 'draft_rider_message']]
              const retained = categories.flatMap(tools => history.some(item => item.requests?.some(call => tools.includes(call.tool))) ? [] : (previous.answer.trace ?? []).filter(call => call.result.ok && tools.includes(call.tool)).slice(-2))
              if (!history.some(item => item.pendingJourney || item.requests?.some(call => call.tool === 'route_plan'))) {
                for (const slot of previous.answer.pendingJourney?.slots ?? []) {
                  session.places.restore(slot.choices)
                  if (slot.fixed?.placeId) session.places.restore([{ ...slot.fixed, id: slot.fixed.placeId, name: slot.fixed.label, sourceUrl: `https://www.openstreetmap.org/${slot.fixed.placeId.slice(4)}` }])
                }
              }
              for (const call of retained) {
                if (call.tool === 'place_search') session.places.restore(call.result.data.matches)
                if (call.tool === 'find_walk') session.places.restore(call.result.data.visits)
                if (call.tool === 'route_plan') for (const endpoint of call.result.data?.clarification?.endpoints ?? []) session.places.restore(endpoint.matches)
              }
              const requests = retained.map(call => ({ tool: call.tool, arguments: call.arguments }))
              const findings = retained.filter(call => ['route_plan', 'walk_route', 'place_search', 'web_search', 'web_read', 'reference_lookup', 'find_walk', 'walk_compare', 'inspect_service', 'service_timing', 'stop_arrivals', 'realtime_status', 'anomaly_scan', 'service_alerts', 'draft_rider_message'].includes(call.tool))
              history.unshift({ pendingJourney: previous.answer.pendingJourney, selection: previous.answer.selection, question: previous.title, answer: previous.answer.answer, privateContext: previous.answer.dataPolicyVersion !== 1 && (previous.answer.trace ?? []).some(call => ['operational_context', 'recall_notebook'].includes(call.tool)), observedAt: previous.answer.generatedAt, requests, findings })
              parentId = previous.parentId
            }
            return retain(body.question, await queryAgency({ question: body.question, selection, context: session.context, state, callTool, provider: inference, signal, onProgress: progress, history, placesAvailable: session.places.enabled, placeEndpoint: session.places.endpoint, placeDetailsEndpoint: session.places.detailsEndpoint, webStatus: research }))
          }
          case 'run-skill': {
            const result = await session.skills.run(body.id, body.inputs ?? {}, callTool, progress, { signal, generatedAt: state.generatedAt })
            const trace = result.results
            const fallback = await synthesizeEvidence({ trace, provider: { available: false } })
            let summary = fallback, warning
            try { if (result.status === 'complete') summary = await synthesizeEvidence({ trace, provider: inference, signal, instructions: result.skill.instructions, onProgress: progress }) }
            catch (error) { warning = error.message }
            if (result.status !== 'complete' || signal?.aborted) {
              const completed = trace.filter((call) => call.result.ok).length
              warning = `${signal?.aborted ? 'Study stopped' : 'Study incomplete'}. ${completed} of ${result.skill.steps.length} checks completed. Completed evidence is saved.`
              summary = { text: `${warning}${completed ? `\n\n${fallback.text}` : ''}`, aiGenerated: false }
            }
            const rows = trace.flatMap(({ tool, result }) => result.data.rows ?? (tool === 'anomaly_scan' ? (result.data.events ?? []).filter((event) => event.evidence.observedHeadwaySeconds != null).map((event) => ({ route: event.routeName || event.routeId, reference_stop: event.stopName || event.stopId, observed_at: event.observedAt, predicted_minutes: event.evidence.observedHeadwaySeconds / 60, scheduled_minutes: event.evidence.scheduledHeadwaySeconds / 60, difference_minutes: (event.evidence.observedHeadwaySeconds - event.evidence.scheduledHeadwaySeconds) / 60 })) : []))
            const answer = { answer: summary.text, scopeNote: fallback.scopeNote, aiGenerated: summary.aiGenerated, model: summary.model, citations: summary.citations, trace, report: { title: result.skill.name, method: result.skill.instructions, inputs: body.inputs ?? {}, rows }, generatedAt: state.generatedAt, evidenceRefs: [...new Set(trace.flatMap((call) => call.result.provenance))], warnings: [...new Set(trace.flatMap((call) => call.result.warnings)), ...(warning ? [warning] : [])], providerAvailable: provider.available }
            answer.runtime = withRuntimeActivity(queryRuntimeFacts({ provider: inference, webStatus: research, placesAvailable: session.places.enabled, placeEndpoint: session.places.endpoint, placeDetailsEndpoint: session.places.detailsEndpoint, runtimeStudyAvailable: Boolean(adapters.runtimeStudy), generatedAt: state.generatedAt }), trace)
            return retain(result.skill.name, answer, 'research')
          }
          default: throw Object.assign(new Error('Unknown Agency action.'), { statusCode: 400 })
        }
      })
    },
    close() { closed = true; for (const session of sessions.values()) retire(session); sessions.clear() },
  }
}
