import fs from 'node:fs/promises'
import { AgencyContext } from '../agency/agencyContext.mjs'
import { createObservationHistory, deriveOperationalState, defaultPolicy } from '../agency/realtimeIntelligence.mjs'
import { createSkillRegistry } from '../agency/skillRegistry.mjs'
import { createToolRegistry } from '../agency/toolRegistry.mjs'
import { createProvider } from '../agency/provider.mjs'
import { queryAgency } from '../agency/queryAgent.mjs'

export function createAgencyService(adapters, { provider = createProvider(), clock = () => Date.now(), policy = defaultPolicy, refreshMs = 10_000 } = {}) {
  const sessions = new Map()
  async function sessionFor(projectId) {
    const { storePath, cityName } = await adapters.context(projectId)
    const stat = await fs.stat(storePath)
    let session = sessions.get(projectId)
    if (session && (session.storePath !== storePath || session.modified !== stat.mtimeMs)) {
      clearInterval(session.timer)
      session.generation++
      session.context.close()
      sessions.delete(projectId)
      session = null
    }
    if (!session) {
      if (sessions.size >= 8) {
        const [oldId, old] = [...sessions].sort((a, b) => a[1].lastRead - b[1].lastRead)[0]
        clearInterval(old.timer); old.generation++; old.context.close(); sessions.delete(oldId)
      }
      session = { storePath, modified: stat.mtimeMs, context: new AgencyContext(storePath, cityName), snapshot: null, request: null, generation: 0, inFlight: null, timer: null,
        history: createObservationHistory(policy), skills: createSkillRegistry(), lastRead: clock() }
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
      if (generation === session.generation) { session.snapshot = snapshot; session.history.update(current(session)) }
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
      return { ok: true }
    },
    async state(projectId) {
      const state = current(await sessionFor(projectId))
      const { trips, ...publicState } = state
      return { ...publicState, stopNames: Object.fromEntries(state.events.slice(0, 500).flatMap((event) => event.stopId ? [[event.stopId, sessions.get(projectId).context.stopIndex.get(event.stopId)?.name || event.stopId]] : [])), eventCount: state.events.length, events: state.events.slice(0, 500), warnings: [...state.warnings, ...(state.events.length > 500 ? ['Showing the first 500 current events. Filter with a route tool for a narrower investigation.'] : [])] }
    },
    async handle(projectId, body, signal, onProgress) {
      if (body.action === 'provider-status') return provider.status()
      if (body.action === 'provider-models') return provider.models(body.connection, signal)
      if (body.action === 'provider-connect') return provider.connect(body.connection, signal)
      if (body.action === 'provider-disconnect') return provider.disconnect()
      const session = await sessionFor(projectId)
      const state = current(session)
      const callTool = createToolRegistry({ context: session.context, state, snapshot: session.snapshot, provider, signal,
        adapters: { matrix: (request, abort) => adapters.matrix(projectId, request, abort), route: (request, abort) => adapters.route(projectId, request, abort), reach: (request, abort) => adapters.reach(projectId, request, abort) } })
      switch (body.action) {
        case 'connection': return { request: session.request }
        case 'connect': return { snapshot: await connect(projectId, body.request) }
        case 'disconnect': return this.disconnect(projectId)
        case 'tool': return callTool(body.name, body.arguments ?? {})
        case 'ask': return queryAgency({ question: body.question, context: session.context, state, callTool, provider, signal, onProgress })
        case 'skills': return { skills: session.skills.list() }
        case 'skill-enabled': return { skill: session.skills.setEnabled(body.id, body.enabled) }
        case 'run-skill': return session.skills.run(body.id, body.inputs ?? {}, callTool)
        default: throw Object.assign(new Error('Unknown Agency action.'), { statusCode: 400 })
      }
    },
    close() { for (const session of sessions.values()) { clearInterval(session.timer); session.generation++; session.context.close() } sessions.clear() },
  }
}
