/** Presentation only. The public gateway independently enforces read-only access. */
export const publicRoutingCity = typeof document === 'undefined' ? '' : document.documentElement.dataset.vigoPublicCity ?? ''
export const publicRouting = Boolean(publicRoutingCity)
