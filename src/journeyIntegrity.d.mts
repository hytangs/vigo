import type { RoutingPlan } from './routingModel'
export function journeyContinuityIssue(plan?: Pick<RoutingPlan, 'legs' | 'departMinutes'> | null): string | null
