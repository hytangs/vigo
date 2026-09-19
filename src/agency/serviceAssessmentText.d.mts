import type { QueryAnswer } from './types'
export function retainedNetworkAssessmentText(answer: QueryAnswer): string | null
export function compactNoticeScope(notice: { scopeDescription?: string; routes?: Array<{ name: string }> }): string
