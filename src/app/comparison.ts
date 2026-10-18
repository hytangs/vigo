import { scenarioReachedAreaKm2, type ReachResult } from '../reach'
import { reachTransitStops } from './resultSummary'

/** One network Compare measures against the reference: a saved scenario, a timetable group, or one timetable. */
export type CompareVariant = {
  id: string
  label: string
  kind: 'scenario' | 'group' | 'timetable'
  detail: string
  feedIds: string[]
  /** Planned changes for a saved scenario, as Reach takes them. */
  scenario?: unknown
}

export type CompareVariantStats = {
  areaKm2: number
  areaDeltaKm2: number
  stops: number | null
  stopsDelta: number | null
  fasterPixels: number
  slowerPixels: number
  newPixels: number
  lostPixels: number
  commonPixels: number
  meanSavedMinutes: number
}

export type CompareEntry = { variant: CompareVariant; stats: CompareVariantStats | null; error?: string }

export type ComparisonRun = {
  reference: CompareVariant & { areaKm2: number; stops: number | null }
  cutoffMinutes: number
  serviceDate: string
  departMinutes: number
  entries: CompareEntry[]
  /** The variant shown on the map; only its full surface stays in memory. */
  selectedId: string
}

/**
 * Measures read from one pair result: the reference as the baseline surface,
 * the variant as the scenario surface, on one grid.
 */
export function compareStats(result: ReachResult, cutoffMinutes: number): CompareVariantStats {
  const referenceArea = scenarioReachedAreaKm2(result, 'baseline', cutoffMinutes)
  const areaKm2 = scenarioReachedAreaKm2(result, 'scenario', cutoffMinutes)
  const referenceStops = reachTransitStops(result, 'baseline', cutoffMinutes)
  const stops = reachTransitStops(result, 'scenario', cutoffMinutes)
  const counts = result.summary.changeCountsByCutoff?.find((entry) => entry.cutoffMinutes === cutoffMinutes)
  const change = result.summary.changeStatsByCutoff?.find((entry) => entry.cutoffMinutes === cutoffMinutes)
  return {
    areaKm2,
    areaDeltaKm2: areaKm2 - referenceArea,
    stops,
    stopsDelta: stops === null || referenceStops === null ? null : stops - referenceStops,
    fasterPixels: counts?.improvedPixels ?? 0,
    slowerPixels: counts?.worsenedPixels ?? 0,
    newPixels: change?.newPixels ?? 0,
    lostPixels: change?.lostPixels ?? 0,
    commonPixels: change?.commonPixels ?? 0,
    meanSavedMinutes: change?.meanSavedMinutes ?? 0,
  }
}

/** Variants ordered by reach gained, then by minutes saved where both reach. */
export function rankedCompareEntries(entries: CompareEntry[]) {
  return [...entries].sort((left, right) => {
    if (!left.stats || !right.stats) return left.stats ? -1 : right.stats ? 1 : 0
    return right.stats.areaDeltaKm2 - left.stats.areaDeltaKm2 || right.stats.meanSavedMinutes - left.stats.meanSavedMinutes
  })
}
