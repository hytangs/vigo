import { realtimeSources } from '../shared/realtime-sources.mjs'
import { indexedEntityId, workspaceSelection, selectedStopIds, eventInSelection } from '../agency/workspaceSelection.mjs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createObservationStore } from '../agency/observationStore.mjs'

import { AgencyContext } from '../agency/agencyContext.mjs'
import { createObservationHistory, deriveOperationalState, defaultPolicy } from '../agency/realtimeIntelligence.mjs'
import { routeOperations, vehicleDetails } from '../agency/routeOperations.mjs'
import { stopBoard } from '../agency/stopBoard.mjs'

function authorize(principal, configure = false) {
  if (!principal || typeof principal.id !== 'string' || !principal.id.trim() || principal.id.length > 120
    || !['viewer', 'operator', 'reviewer', 'admin'].includes(principal.role) || configure && principal.role !== 'admin') {
    throw Object.assign(new Error('This account cannot perform this action.'), { statusCode: 403 })
  }
}

export function createAgencyService(adapters, { clock = () => Date.now(), policy = defaultPolicy, refreshMs = 10_000,
  access = async () => ({ id: 'local-owner', role: 'admin' }) } = {}) {
  const sessions = new Map()
  const revisions = new Map()
  let closed = false
  function retire(session) {
    clearInterval(session.timer)
    session.timer = null
    session.generation++
    session.retired = true
    if (!session.active && !session.disposed) {
      session.disposed = true
      session.context.close()
      session.observation.close()
    }
  }
  async function withSession(projectId, run) {
    const session = await sessionFor(projectId)
    try { return await run(session) }
    finally { session.active--; if (session.retired) retire(session) }
  }
  async function sessionFor(projectId) {
    const revision = revisions.get(projectId)
    const { storePath, cityName, agencyDirectory, feedIds = [] } = await adapters.context(projectId)
    const stat = await fs.stat(storePath)
    if (closed) throw new Error('Network service is closed.')
    if (revision !== revisions.get(projectId)) throw Object.assign(new Error('City data changed. Please retry.'), { statusCode: 409 })
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
      const observation = createObservationStore(agencyDirectory || path.join(path.dirname(storePath), 'agency'))
      let context
      try {
        context = new AgencyContext(storePath, cityName)
        const saved = observation.get() ?? {}
        const scheduleIdentity = JSON.stringify([storePath, stat.size, stat.mtimeMs])
        // A retained raw-ID snapshot belongs to the timetable it was resolved
        // against. Reimport/merge must obtain new source-scoped observations.
        const retained = saved.scheduleIdentity === scheduleIdentity ? saved : { request: saved.request }
        session = { observation, storePath, modified: stat.mtimeMs, context, snapshot: retained.snapshot ?? null, request: retained.request ?? null, generation: 0, inFlight: null, timer: null,
          active: 0, retired: false, disposed: false, history: createObservationHistory(policy, retained), lastRead: clock() }
        session.scheduleIdentity = scheduleIdentity
      } catch (error) { context?.close(); observation.close(); throw error }
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
    return { ...state, ...session.history.update(state), warnings: [...state.warnings, ...(session.refreshError ? [session.refreshError] : [])] }
  }

  async function refresh(session) {
    if (!session.request) return session.snapshot
    if (session.inFlight) return session.inFlight
    const generation = session.generation
    const request = session.request
    session.inFlight = (async () => {
      let snapshot
      try { snapshot = await adapters.inspectRealtime(request, { feedIds: session.feedIds, sourceScopes: session.context.scopes }); if (generation === session.generation) session.refreshError = null }
      catch (error) { if (generation === session.generation) session.refreshError = `Realtime refresh failed: ${error.message}`; throw error }
      if (generation === session.generation) { session.snapshot = snapshot; const { history, tripHistory } = current(session); session.observation.set({ request: session.request, snapshot, history, tripHistory, scheduleIdentity: session.scheduleIdentity }) }
      return session.snapshot
    })().finally(() => { session.inFlight = null })
    return session.inFlight
  }

  async function resume(projectId, request) {
    return withSession(projectId, async session => {
      request = { sources: realtimeSources(request).map(source => ({ ...source,
        ...(!source.sourceScope && session.feedIds.length === 1 ? { sourceScope: session.feedIds[0] } : {}),
      })) }
      const coverage = session.context.coverage(clock() / 1000)
      if (!coverage.valid) throw Object.assign(new Error(coverage.message), { statusCode: 409 })
      const sameRequest = JSON.stringify(session.request) === JSON.stringify(request)
      if (!sameRequest) {
        session.generation++; session.request = request; session.snapshot = null; session.refreshError = null
        session.history = createObservationHistory(policy)
        // Commit the new source before its fetch. A failed replacement must never
        // present or restore an observation from the previously connected feed.
        session.observation.set({ request, snapshot: null, history: [], tripHistory: {} })
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
    async connect(projectId, request) { authorize(await access(projectId), true); return resume(projectId, request) },
    async disconnect(projectId) {
      authorize(await access(projectId), true)
      return withSession(projectId, async session => {
        session.generation++; clearInterval(session.timer); session.timer = null; session.request = null; session.snapshot = null; session.refreshError = null
        session.history = createObservationHistory(policy)
        session.observation.set(null)
        return { ok: true }
      })
    },
    async state(projectId, { routeId = '', stopId = '', eventType = '' } = {}) {
      authorize(await access(projectId))
      return withSession(projectId, async session => {
        const selection = workspaceSelection(session.context, { routeId, stopId }, session.feedIds)
        const stops = selectedStopIds(session.context, selection)
        if (session.request && !session.timer && session.context.coverage(clock() / 1000).valid) {
          try { await resume(projectId, session.request) } catch { /* Current reports keep aging; refresh failure is included below. */ }
        }
        const state = current(session)
        const { trips, measurements, ...publicState } = state
        const mapAlerts = new Map()
        const magnitude = item => ({ critical: 2, warning: 1, info: 0 }[item.severity] * 1e9) + Math.abs((item.evidence.observedHeadwaySeconds ?? 0) - (item.evidence.scheduledHeadwaySeconds ?? 0) || item.evidence.delaySeconds || 0)
        for (const event of state.events) {
          if (!['service-gap', 'bunching', 'delay'].includes(event.type) || !event.vehicleId) continue
          const key = JSON.stringify([event.type, event.tripId, event.vehicleId, event.serviceDate, event.evidence.tripStartTime,
            ...(event.type === 'bunching' ? [event.evidence.tripIds?.[0], event.evidence.leadingVehicleId, event.evidence.leadingTripStartTime] : [])])
          if (!mapAlerts.has(key) || magnitude(mapAlerts.get(key)) < magnitude(event)) mapAlerts.set(key, { ...event, stopName: session.context.stopIndex.get(event.stopId)?.name || event.stopId })
        }
        const selected = state.events.filter((event) => eventInSelection(event, selection, stops) && (!eventType || eventType === 'all' || event.type === eventType))
        return { ...publicState, mapOperationalEvents: [...mapAlerts.values()], scheduleIdentity: session.scheduleIdentity, selection, filters: { routeId, stopId, eventType }, filteredEventCount: selected.length,
          stopLocations: Object.fromEntries(selected.slice(0, 500).flatMap((event) => { const stop = session.context.stopIndex.get(event.stopId); return stop ? [[stop.stop_id, { label: stop.name, coordinate: [stop.lon, stop.lat] }]] : [] })),
          stopNames: Object.fromEntries(selected.slice(0, 500).flatMap((event) => event.stopId ? [[event.stopId, session.context.stopIndex.get(event.stopId)?.name || event.stopId]] : [])),
          eventCount: state.events.length, events: selected.slice(0, 500), warnings: [...state.warnings, ...(selected.length > 500 ? ['Showing the first 500 matching events. Choose a route or event type to narrow the view.'] : [])] }
      })
    },
    async handle(projectId, body) {
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || !['route-line', 'stop-board', 'vehicle', 'connection', 'connect', 'disconnect'].includes(body.action)) {
        throw Object.assign(new Error('Unknown Network action.'), { statusCode: 400 })
      }
      authorize(await access(projectId), ['connect', 'disconnect'].includes(body.action))
      if (body.action === 'connect') return { snapshot: await this.connect(projectId, body.request) }
      if (body.action === 'disconnect') return this.disconnect(projectId)
      return withSession(projectId, async session => {
        switch (body.action) {
          case 'route-line': return routeOperations(session.context, session.snapshot, { ...body, routeId: indexedEntityId(session.context, 'route', body.routeId, session.feedIds) }, clock() / 1000, policy)
          case 'stop-board': return stopBoard(session.context, session.snapshot, { ...body, feedIds: session.feedIds }, clock() / 1000, policy)
          case 'vehicle': return vehicleDetails(session.context, session.snapshot, body, clock() / 1000, policy)
          case 'connection': return { request: session.request }
        }
      })
    },
    invalidate(projectId) {
      const session = sessions.get(projectId)
      if (session?.active) throw Object.assign(new Error('Wait for the active Network request to finish before deleting a source.'), { statusCode: 409 })
      revisions.set(projectId, (revisions.get(projectId) ?? 0) + 1)
      if (session) retire(session)
      sessions.delete(projectId)
    },
    close() { closed = true; for (const session of sessions.values()) retire(session); sessions.clear(); revisions.clear() },
  }
}
