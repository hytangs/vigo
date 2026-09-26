export type RealtimeSource = { url: string; kind?: 'feed' | 'vehicles' | 'tripUpdates' | 'alerts'; sourceScope?: string }
export const maximumRealtimeSources: number
export function realtimeSources(request: unknown): RealtimeSource[]
