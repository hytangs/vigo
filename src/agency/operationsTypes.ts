import type { OperationalEvent } from './types'

export type OperationsRecord = {
  id: string; kind: 'finding' | 'knowledge' | 'message'; version: number; updatedAt: string; title: string; status: string
  event?: OperationalEvent; owner?: string; note?: string; outcome?: { label: string; source: string }
  body?: string; type?: string; source?: string; validUntil?: string; routeIds?: string[]; stopIds?: string[]
  channel?: string; audience?: string; expiresAt?: string; limit?: number; findingId?: string
  approvedBy?: string; delivery?: { receipt: string }; evidenceRefs?: string[]
  knowledge?: Array<{ id: string; version: number; title: string }>
  availability?: { status: string; reason?: string; changed?: boolean }
}
export type OperationsOverview = {
  principal: { id: string; role: string; capabilities: string[] }
  findings: OperationsRecord[]; messages: OperationsRecord[]; knowledge: OperationsRecord[]
  quality: { flags: string[]; alignedReports: number; totalReports: number; alignmentRatio: number | null; comparedRoutes: number; note: string }
  monitoring: { active: boolean; lastStoredAt: string | null; note: string }
  delivery: { note: string }
}
export type HistoricalComparison = {
  routeId: string; weekday: string; hour: string; serviceDays: number; minimumDays: number; baselineSeconds: number | null; currentSeconds: number | null; differenceSeconds: number | null; method: string
  days: Array<{ date: string; value: number; samples: number }>
  evaluation: { cases: number; meanAbsoluteErrorSeconds: number | null }
}
