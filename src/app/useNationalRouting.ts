import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RealtimeSnapshot, ServiceDay } from '../domain'
import type { RoutingPlan, RoutingPoint, RoutingTimePreference, RoutingTravelMode } from '../routingModel'
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

type UseNationalRoutingOptions = {
  active: boolean
  projectId: string
  feedId: string
  storeKey: string
  origin: RoutingPoint | null
  waypoints: RoutingPoint[]
  destination: RoutingPoint | null
  mode: RoutingTravelMode
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
  onError: (message: string) => void
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
  origin,
  waypoints,
  destination,
  mode,
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
  onError,
}: UseNationalRoutingOptions) {
  const [readyKey, setReadyKey] = useState('')
  const [choices, setChoices] = useState<RoutingPlan[]>([])
  const [loading, setLoading] = useState(false)
  const [alternativesLoading, setAlternativesLoading] = useState(false)
  const [serviceCoverage, setServiceCoverage] = useState<RoutingServiceCoverage | null>(null)
  const [serviceDateSuggestions, setServiceDateSuggestions] = useState<RoutingServiceDateSuggestion[] | undefined>()
  const [error, setError] = useState('')
  const [errorStatus, setErrorStatus] = useState<ApiRoutingStatus | undefined>()
  const routeRequestGate = useRef(new LatestRequestGate())
  const streetMode = mode !== 'transit'
  const readinessKey = storeKey ? `${storeKey}:${serviceDate}:${serviceDay}` : ''
  const ready = streetMode
    ? Boolean(active && feedId && storeKey && routeAllowed)
    : Boolean(readinessKey && readyKey === readinessKey)
  const serviceDateAvailability = streetMode
    ? 'unknown'
    : routingServiceDateAvailability(serviceCoverage, serviceDate)
  const serviceDateOptions = useMemo(
    () => streetMode ? [] : routingServiceDateOptions(serviceCoverage, serviceDate, serviceDateSuggestions),
    [serviceCoverage, serviceDate, serviceDateSuggestions, streetMode],
  )

  const reset = useCallback(() => {
    routeRequestGate.current.cancel()
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
      body: JSON.stringify({ feedId, serviceDate, serviceDay, allowServiceDateFallback: false }),
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
      onError(message)
    })
    return () => controller.abort()
  }, [active, feedId, onError, projectId, readinessKey, ready, serviceDate, serviceDay, streetMode])

  useEffect(() => {
    if (!active || !feedId || !origin || !destination || !routeAllowed || !ready || (!streetMode && serviceDateAvailability === 'outside')) {
      routeRequestGate.current.cancel()
      setChoices((current) => current.length ? [] : current)
      setLoading(false)
      setAlternativesLoading(false)
      if (!origin || !destination) setError('')
      return
    }

    const requestToken = routeRequestGate.current.begin()
    const controller = requestToken.controller
    const ownsCommit = () => routeRequestGate.current.owns(requestToken)
    setChoices([])
    setError('')
    setErrorStatus(undefined)
    setLoading(true)
    setAlternativesLoading(!streetMode && timePreference === 'depart' && departureWindowMinutes > 0)

    void apiJson<NationalRouteResponse>(
      `/api/projects/${encodeURIComponent(projectId)}/national-route`,
      {
        method: 'POST',
        signal: controller.signal,
        body: JSON.stringify({
          feedId,
          mode,
          origin,
          waypoints,
          destination,
          departMinutes,
          arriveMinutes: departMinutes,
          timePreference,
          serviceDay,
          serviceDate,
          allowServiceDateFallback: false,
          maxWalkKm,
          maxTransfers,
          allowLongWalk,
          includeEarliestTransit: mode === 'transit',
          objective: 'earliest_arrival',
          maxStreetKm: mode === 'drive' ? 750 : 50,
          departureWindowMinutes: streetMode ? 0 : departureWindowMinutes,
          departureWindowDirection: !streetMode && departureWindowMinutes > 0 ? 'forward' : undefined,
          realtimeSnapshot: !streetMode && realtimeSnapshot
            ? {
                sourceUrl: realtimeSnapshot.sourceUrl,
                sourceUrls: realtimeSnapshot.sourceUrls,
                fetchedAt: realtimeSnapshot.fetchedAt,
                feedTimestamp: realtimeSnapshot.feedTimestamp,
                tripUpdates: realtimeSnapshot.tripUpdates,
              }
            : undefined,
        }),
      },
    ).then((response) => {
      if (!ownsCommit()) return
      setChoices(normalizeChoices(response))
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
      onError(message)
    }).finally(() => {
      routeRequestGate.current.finish(requestToken)
    })

    return () => {
      routeRequestGate.current.cancel(requestToken)
    }
  }, [active, allowLongWalk, departMinutes, departureWindowMinutes, destination, feedId, maxWalkKm, maxTransfers, mode, onError, origin, projectId, ready, realtimeSnapshot, routeAllowed, serviceDate, serviceDateAvailability, serviceDay, streetMode, timePreference, waypoints])

  return {
    alternativesLoading,
    choices,
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
