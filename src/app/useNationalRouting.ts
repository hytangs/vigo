import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RealtimeSnapshot, ServiceDay } from '../domain'
import type { RoutingDataMode, RoutingPlan, RoutingPoint, RoutingTimePreference, RoutingTravelMode } from '../routingModel'
import { apiJson, ApiRequestError, type ApiRoutingStatus } from './api'
import { LatestRequestGate } from './latestRequestGate'
import {
  normalizeReceivedRoutingPlan,
  routingServiceDateAvailability,
  routingServiceDateOptions,
  type RoutingServiceCoverage,
  type RoutingServiceDateSuggestion,
} from './routingPlan'
import type { RoutingDepartureWindowMinutes } from './uiOptions'

type EarliestTransitEvidence = {
  status: 'ready' | 'none' | 'unavailable'
  departMinutes?: number
  firstBoardingMinutes?: number
  arriveMinutes?: number
  routeShortName?: string
  transfers?: number
  detail?: string
}

type NationalRouteResponse = {
  choices: RoutingPlan[]
  selectedPlanId: string
  earliestTransit?: EarliestTransitEvidence
}
const noRoutingChoices: RoutingPlan[] = []

/** A saved scenario to route on: its timetables and compiled planned changes. */
export type RouteScenarioRequest = { key: string; feedIds: string[]; scenario: unknown }

type UseNationalRoutingOptions = {
  active: boolean
  projectId: string
  feedId: string
  storeKey: string
  streetKey?: string
  origin: RoutingPoint | null
  waypoints: RoutingPoint[]
  destination: RoutingPoint | null
  mode: RoutingTravelMode
  routingDataMode: RoutingDataMode
  departMinutes: number
  timePreference: RoutingTimePreference
  serviceDay: ServiceDay
  serviceDate: string
  autoExpandWalking?: boolean
  maxWalkKm: number
  maxTransfers?: number
  allowLongWalk: boolean
  allowStreetTransfers: boolean
  wheelchair?: boolean
  minimumTransferBufferMinutes: number
  departureWindowMinutes: RoutingDepartureWindowMinutes
  realtimeSnapshot: RealtimeSnapshot | null
  routeAllowed: boolean
  scenario?: RouteScenarioRequest | null
}

function normalizeChoices({ choices, earliestTransit }: NationalRouteResponse) {
  const normalized = choices.map(normalizeReceivedRoutingPlan)
  return earliestTransit
    ? normalized.map((candidate) => ({
        ...candidate,
        diagnostics: {
          ...candidate.diagnostics,
          earliestTransit,
        },
      }))
    : normalized
}

export function useNationalRouting({
  active,
  projectId,
  feedId,
  storeKey,
  streetKey = '',
  origin,
  waypoints,
  destination,
  mode,
  routingDataMode: preferredDataMode,
  departMinutes,
  timePreference,
  serviceDay,
  serviceDate,
  maxWalkKm,
  autoExpandWalking = false,
  maxTransfers,
  allowLongWalk,
  allowStreetTransfers,
  wheelchair = false,
  minimumTransferBufferMinutes,
  departureWindowMinutes,
  realtimeSnapshot,
  routeAllowed,
  scenario = null,
}: UseNationalRoutingOptions) {
  const [readyKey, setReadyKey] = useState('')
  const [choices, setChoices] = useState<RoutingPlan[]>([])
  const [loading, setLoading] = useState(false)
  const [alternativesLoading, setAlternativesLoading] = useState(false)
  const [serviceCoverage, setServiceCoverage] = useState<RoutingServiceCoverage | null>(null)
  const [serviceDateSuggestions, setServiceDateSuggestions] = useState<RoutingServiceDateSuggestion[] | undefined>()
  const [error, setError] = useState('')
  const [errorStatus, setErrorStatus] = useState<ApiRoutingStatus | undefined>()
  const [runRevision, setRunRevision] = useState(0)
  // Feed polling updates the next run's input, never the current journey.
  const latestSnapshot = useRef(realtimeSnapshot)
  latestSnapshot.current = realtimeSnapshot
  const routeRequestGate = useRef(new LatestRequestGate())
  const streetMode = mode !== 'transit'
  // Scenarios plan service on the published timetable, never on live predictions.
  const routeScenario = streetMode ? null : scenario
  const routingDataMode: RoutingDataMode = routeScenario ? 'scheduled' : preferredDataMode
  const departNow = !streetMode && routingDataMode === 'realtime'
  // The server resolves Depart now in the selected timetable's timezone at
  // dispatch. Retain the research controls without letting them alter live work.
  const requestDepartMinutes = departNow ? undefined : departMinutes
  const requestTimePreference = departNow ? 'depart' : timePreference
  const requestServiceDate = departNow ? undefined : serviceDate
  const requestServiceDay = departNow ? undefined : serviceDay
  const readinessKey = storeKey ? `${storeKey}:${routeScenario?.key ?? feedId}:${wheelchair}:${departNow ? 'depart-now' : `${serviceDate}:${serviceDay}`}` : ''
  const ready = streetMode
    ? Boolean(feedId && storeKey && routeAllowed)
    : Boolean(readinessKey && readyKey === readinessKey)
  const serviceDateAvailability = streetMode || departNow
    ? 'unknown'
    : routingServiceDateAvailability(serviceCoverage, serviceDate)
  const serviceDateOptions = useMemo(
    () => streetMode || departNow ? [] : routingServiceDateOptions(serviceCoverage, serviceDate, serviceDateSuggestions),
    [departNow, serviceCoverage, serviceDate, serviceDateSuggestions, streetMode],
  )

  const request = useMemo(() => ({ projectId, storeKey, streetKey, body: {
    ...(routeScenario ? { feedIds: routeScenario.feedIds, scenario: routeScenario.scenario } : { feedId }),
    mode,
    routingDataMode,
    origin,
    waypoints,
    destination,
    departNow: departNow || undefined,
    departMinutes: requestDepartMinutes,
    arriveMinutes: requestDepartMinutes,
    timePreference: requestTimePreference,
    serviceDay: requestServiceDay,
    serviceDate: requestServiceDate,
    allowServiceDateFallback: false,
    requireTransitRide: mode === 'transit' ? false : undefined,
    maxWalkKm,
    autoExpandWalking,
    maxTransfers: mode === 'transit' && waypoints.length ? undefined : maxTransfers,
    allowLongWalk,
    allowStreetTransfers,
    wheelchair,
    minimumTransferBufferMinutes: mode === 'transit' && waypoints.length ? 0 : minimumTransferBufferMinutes,
    includeEarliestTransit: mode === 'transit' && !waypoints.length,
    sharedLegs: mode === 'transit' && !waypoints.length,
    includeRankedAlternatives: mode === 'transit' && !waypoints.length && requestTimePreference === 'depart' && departureWindowMinutes > 0,
    objective: 'earliest_arrival',
    maxStreetKm: mode === 'drive' ? 750 : 50,
    departureWindowMinutes: streetMode ? 0 : departureWindowMinutes,
    departureWindowDirection: !streetMode && departureWindowMinutes > 0 ? 'forward' : undefined,
  } }), [autoExpandWalking, wheelchair, allowLongWalk, allowStreetTransfers, minimumTransferBufferMinutes, departNow, departureWindowMinutes, destination, feedId, maxWalkKm, maxTransfers, mode, runRevision, origin, projectId, requestDepartMinutes, requestServiceDate, requestServiceDay, requestTimePreference, routeScenario, routingDataMode, storeKey, streetKey, streetMode, waypoints])
  const completedRequest = useRef<typeof request | null>(null)

  const reset = useCallback(() => {
    routeRequestGate.current.cancel()
    completedRequest.current = null
    setRunRevision(revision => revision + 1)
    setChoices([])
    setLoading(false)
    setAlternativesLoading(false)
    setError('')
    setErrorStatus(undefined)
  }, [])

  useEffect(() => {
    setServiceCoverage(null)
    setServiceDateSuggestions(undefined)
  }, [storeKey])

  useEffect(() => () => routeRequestGate.current.cancel(), [])

  useEffect(() => {
    if (streetMode || !active || !feedId || !storeKey || ready) return
    const controller = new AbortController()
    setError('')
    setErrorStatus(undefined)
    setServiceDateSuggestions(undefined)
    apiJson<{ routing: {
      ready: boolean
      serviceCoverage?: RoutingServiceCoverage
      serviceDateOptions?: RoutingServiceDateSuggestion[]
    } }>(`/api/projects/${encodeURIComponent(projectId)}/national-ready`, {
      method: 'POST',
      signal: controller.signal,
      // Transfer settings let readiness activate the timetable the routes use.
      body: JSON.stringify({ wheelchair, ...(routeScenario ? { feedIds: routeScenario.feedIds } : { feedId }), mode, routingDataMode, departNow: departNow || undefined, serviceDate: requestServiceDate, serviceDay: requestServiceDay, allowServiceDateFallback: false, allowStreetTransfers, minimumTransferBufferMinutes, timePreference: requestTimePreference }),
    }).then(({ routing }) => {
      if (controller.signal.aborted) return
      setServiceCoverage(routing.serviceCoverage ?? null)
      setServiceDateSuggestions(routing.serviceDateOptions)
      if (routing.ready) setReadyKey(readinessKey)
    }).catch((reason) => {
      if (controller.signal.aborted) return
      const message = reason instanceof Error ? reason.message : 'Routing database unavailable'
      setError(message)
      setErrorStatus(reason instanceof ApiRequestError ? reason.routingStatus : 'error')
    })
    return () => controller.abort()
  }, [routeScenario, wheelchair, active, allowStreetTransfers, departNow, feedId, minimumTransferBufferMinutes, mode, projectId, readinessKey, ready, requestServiceDate, requestServiceDay, requestTimePreference, routingDataMode, streetMode])

  // Early arrive-by deadlines search the preceding service day's timetable.
  // Readiness opens it while the points are picked; its answer changes nothing here.
  useEffect(() => {
    if (streetMode || !active || !ready || departNow || requestTimePreference !== 'arrive' || routingDataMode !== 'scheduled' || routeScenario) return
    const controller = new AbortController()
    apiJson(`/api/projects/${encodeURIComponent(projectId)}/national-ready`, {
      method: 'POST',
      signal: controller.signal,
      body: JSON.stringify({ wheelchair, feedId, mode, routingDataMode, serviceDate: requestServiceDate, serviceDay: requestServiceDay, allowServiceDateFallback: false, allowStreetTransfers, minimumTransferBufferMinutes, timePreference: 'arrive' }),
    }).catch(() => {})
    return () => controller.abort()
  }, [routeScenario, wheelchair, active, allowStreetTransfers, departNow, feedId, minimumTransferBufferMinutes, mode, projectId, ready, requestServiceDate, requestServiceDay, requestTimePreference, routingDataMode, streetMode])

  useEffect(() => {
    if (completedRequest.current !== request) setChoices(current => current.length ? [] : current)
    if (!feedId || !origin || !destination || (!streetMode && serviceDateAvailability === 'outside')) {
      completedRequest.current = null
      routeRequestGate.current.cancel()
      setChoices((current) => current.length ? [] : current)
      setLoading(false)
      setAlternativesLoading(false)
      if (!origin || !destination) setError('')
      return
    }

    if (!active || !routeAllowed || !ready) {
      routeRequestGate.current.cancel()
      setLoading(false)
      setAlternativesLoading(false)
      return
    }
    // Navigation and readiness checks do not invalidate a completed journey.
    if (completedRequest.current === request) return

    const requestToken = routeRequestGate.current.begin()
    const controller = requestToken.controller
    const ownsCommit = () => routeRequestGate.current.owns(requestToken)
    setChoices([])
    setError('')
    setErrorStatus(undefined)
    setLoading(true)
    setAlternativesLoading(!streetMode && departureWindowMinutes > 0)

    void apiJson<NationalRouteResponse>(
      `/api/projects/${encodeURIComponent(projectId)}/national-route`,
      {
        method: 'POST',
        signal: controller.signal,
        // Capture the newest observation only when dispatching a new request.
        // The server validates its freshness against this run's departure.
        body: JSON.stringify({
          ...request.body,
          realtimeSnapshot: request.body.mode === 'transit' && request.body.routingDataMode === 'realtime'
            ? latestSnapshot.current ?? undefined
            : undefined,
        }),
      },
    ).then((response) => {
      if (!ownsCommit()) return
      const normalized = normalizeChoices(response)
      completedRequest.current = request
      setChoices(normalized)
      setLoading(false)
      setAlternativesLoading(false)
    }).catch((reason) => {
      if (!ownsCommit()) return
      const message = reason instanceof Error ? reason.message : 'National routing failed'
      setChoices([])
      setError(message)
      setErrorStatus(reason instanceof ApiRequestError ? reason.routingStatus : 'error')
      setLoading(false)
      setAlternativesLoading(false)
    }).finally(() => {
      routeRequestGate.current.finish(requestToken)
    })

    return () => {
      routeRequestGate.current.cancel(requestToken)
    }
  }, [active, departureWindowMinutes, destination, feedId, origin, projectId, ready, request, requestTimePreference, routeAllowed, serviceDateAvailability, streetMode])

  return {
    alternativesLoading,
    choices: completedRequest.current === request ? choices : noRoutingChoices,
    error,
    errorStatus,
    loading,
    ready,
    reset,
    serviceCoverage,
    serviceDateAvailability,
    serviceDateOptions,
  }
}
