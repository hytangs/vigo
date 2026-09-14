import type { BriefingPreferences, NetworkDiagnosis } from './networkAssessmentTypes'

export function briefingRefreshAt(answer: { generatedAt: string; diagnosis?: NetworkDiagnosis } | null, preferences: BriefingPreferences): number | null
