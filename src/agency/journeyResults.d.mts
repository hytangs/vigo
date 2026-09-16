import type { RoutingPlan } from '../routingModel'

export type JourneyMode = 'transit' | 'drive'
export type Journey = { mode: JourneyMode; status: 'ready' | 'unavailable'; plan?: RoutingPlan; reason?: string; realtime?: { applied: boolean } }
export type JourneyData = { journeys?: Journey[]; plan?: RoutingPlan; resolved?: Array<{ label: string }>; realtime?: { applied: boolean }; request?: { serviceDate?: string; departTime?: string; arriveBy?: string; timezone?: string } }
export const journeyModeNames: Record<JourneyMode, string>
export function journeyDuration(minutes: number): string
export function isJourneyReady(plan: RoutingPlan | undefined, mode: JourneyMode): boolean
export function journeyBreakdown(plan: RoutingPlan): { walk: number; ride: number; drive: number; wait: number; longestWait: { minutes: number; stop: string; route?: string } | null }
export function verifyJourneyModes(modes?: JourneyMode[], data?: JourneyData): { complete: boolean; missing: JourneyMode[] }
export function describeJourneys(data: JourneyData): string
