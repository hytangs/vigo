import type { QueryAnswer, ToolResult } from './types'

export type RetainedPlace = {
  kind: 'place'
  id: string
  name: string
  label?: string
  address?: string
  lat: number
  lon: number
  source: number
}

export function placeMapLocation(place: unknown): NonNullable<ToolResult['presentation']>['location'] | null
export function retainedPlaces(trace: QueryAnswer['trace']): RetainedPlace[]
export function placeEvidenceText(trace: QueryAnswer['trace']): string
