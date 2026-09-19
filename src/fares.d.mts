import type { RoutingLeg } from './routingModel'
export function farePriceLabel(options?: NonNullable<RoutingLeg['fare']>['options']): string
export function quoteBoardingFare(catalog: unknown, leg: RoutingLeg, serviceDate?: string): NonNullable<RoutingLeg['fare']>
