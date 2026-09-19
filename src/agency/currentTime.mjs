export const currentTimeTool = {
  name: 'current_time',
  description: 'Read the current server clock in one or more IANA timezones, with daylight saving and local dates computed. Use for current time/date questions, including follow-ups about another city. Select zones, never calculate clock offsets yourself. Omit timezones for the current City. answer finishes a clock-only request; continue if other work remains.',
  parameters: { type: 'object', properties: {
    timezones: { type: 'array', minItems: 1, maxItems: 6, items: { type: 'string', minLength: 1, maxLength: 100, description: 'IANA zone, for example Europe/Paris. Do not use an ambiguous abbreviation or a fixed UTC offset.' } },
    resultUse: { type: 'string', enum: ['answer', 'continue'] },
  }, required: ['resultUse'], additionalProperties: false },
}

export function currentTime(timezones, defaultTimezone, now = Date.now()) {
  const instant = new Date(now)
  if (!Number.isFinite(instant.getTime())) throw new Error('The server clock is unavailable.')
  const requested = timezones ?? (defaultTimezone ? [defaultTimezone] : [])
  if (!requested.length) throw new Error('Choose an IANA timezone; this City has no timezone configured.')
  const clocks = [...new Set(requested)].map(timezone => {
    // Intl validates identifiers and applies the runtime's timezone rules.
    // Never fall back to the server or agency zone for an invalid request.
    if (typeof timezone !== 'string' || (timezone !== 'UTC' && !timezone.includes('/'))) throw new Error(`Unknown timezone “${timezone}”. Choose a valid IANA timezone.`)
    let formatter
    try {
      formatter = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: 'long', day: 'numeric', weekday: 'long', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
    } catch { throw new Error(`Unknown timezone “${timezone}”. Choose a valid IANA timezone.`) }
    const parts = Object.fromEntries(formatter.formatToParts(instant).map(part => [part.type, part.value]))
    return { timezone: formatter.resolvedOptions().timeZone, location: timezone.split('/').at(-1).replaceAll('_', ' '), time: `${parts.hour}:${parts.minute} ${parts.dayPeriod}`, zoneLabel: parts.timeZoneName,
      date: `${parts.weekday}, ${parts.month} ${parts.day}, ${parts.year}` }
  })
  return { instant: instant.toISOString(), clocks }
}

export function describeCurrentTime({ clocks }) {
  return clocks.map(clock => `It’s **${clock.time} ${clock.zoneLabel}** in **${clock.location}** — ${clock.date}.`).join('\n\n')
}
