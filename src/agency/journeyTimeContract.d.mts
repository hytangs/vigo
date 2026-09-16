import type { RoutingPlan } from '../routingModel'
type Request = { departTime?: string; arriveBy?: string }
export function explicitClocks(question: string): string[]
export function assertRequestedClock(question: string, args: Request): void
export function journeyTimeIssue(plan: RoutingPlan | undefined, request?: Request): string | null
export function journeyTimeFacts(plan: RoutingPlan, request: Request): { requestedDeparture?: string; requestedArrival?: string; actualDepartureMinutes: number; actualArrivalMinutes?: number; firstVehicleDepartureMinutes: number | null; initialWaitMinutes: number | null; warning?: string }
