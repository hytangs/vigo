import type { RoutingLeg } from './routingModel'
export function farePriceLabel(options?: NonNullable<RoutingLeg['fare']>['options']): string
export function parseFareAmount(amount: unknown, currency: string): number | null
