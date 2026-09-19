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
  plan: RoutingPlan
  choices?: RoutingPlan[]
  earliestTransit?: EarliestTransitEvidence
}
const noRoutingChoices: RoutingPlan[] = []

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
  maxWalkKm: number
  maxTransfers?: number
  allowLongWalk: boolean
  departureWindowMinutes: RoutingDepartureWindowMinutes
  realtimeSnapshot: RealtimeSnapshot | null
  routeAllowed: boolean
}

function normalizeChoices({ plan, choices, earliestTransit }: NationalRouteResponse) {
  const normalized = choices?.length
    ? choices.map(normalizeReceivedRoutingPlan)
    : [normalizeReceivedRoutingPlan(plan)]
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
  routingDataMode,
  departMinutes,
  timePreference,
  serviceDay,
  serviceDate,
  maxWalkKm,
  maxTransfers,
  allowLongWalk,
  departureWindowMinutes,
  realtimeSnapshot,
  routeAllowed,
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
  const departNow = !streetMode && routingDataMode === 'realtime'
  // The server resolves Depart now in the selected timetable's timezone at
  // dispatch. Retain the research controls without letting them alter live work.
  const requestDepartMinutes = departNow ? undefined : departMinutes
  const requestTimePreference = departNow ? 'depart' : timePreference
  const requestServiceDate = departNow ? undefined : serviceDate
  const requestServiceDay = departNow ? undefined : serviceDay
  const readinessKey = storeKey ? `${storeKey}:${departNow ? 'depart-now' : `${serviceDate}:${serviceDay}`}` : ''
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
    feedId,
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
    maxWalkKm,
    maxTransfers: mode === 'transit' && waypoints.length ? undefined : maxTransfers,
    allowLongWalk,
    includeEarliestTransit: mode === 'transit',
    objective: 'earliest_arrival',
    maxStreetKm: mode === 'drive' ? 750 : 50,
    departureWindowMinutes: streetMode ? 0 : departureWindowMinutes,
    departureWindowDirection: !streetMode && departureWindowMinutes > 0 ? 'forward' : undefined,
  } }), [allowLongWalk, departNow, departureWindowMinutes, destination, feedId, maxWalkKm, maxTransfers, mode, runRevision, origin, projectId, requestDepartMinutes, requestServiceDate, requestServiceDay, requestTimePreference, routingDataMode, storeKey, streetKey, streetMode, waypoints])
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
      body: JSON.stringify({ feedId, mode, routingDataMode, departNow: departNow || undefined, serviceDate: requestServiceDate, serviceDay: requestServiceDay, allowServiceDateFallback: false }),
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
  }, [active, departNow, feedId, mode, projectId, readinessKey, ready, requestServiceDate, requestServiceDay, routingDataMode, streetMode])

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
    setAlternativesLoading(!streetMode && requestTimePreference === 'depart' && departureWindowMinutes > 0)

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
