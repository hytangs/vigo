// Display triage thresholds, not agency dispatch rules or measured passenger impact.
export function delayAlert(seconds) {
  const severity = seconds >= 900 ? 'critical' : seconds >= 300 ? 'warning' : 'info'
  return { severity, alertReason: severity === 'critical' ? 'Predicted departure is at least 15 minutes late.' : severity === 'warning' ? 'Predicted departure is at least 5 minutes late.' : 'Predicted departure differs from the timetable by less than 5 minutes.' }
}
export function spacingAlert(scheduled, predicted) {
  const extra = predicted - scheduled
  const ratio = predicted / scheduled
  if (!(scheduled > 0) || !(predicted >= 0)) return { severity: 'info', alertReason: 'No valid spacing comparison.' }
  if (extra > 0) {
    const severity = predicted >= 1200 && ratio >= 3 && extra >= 600 ? 'critical' : ratio >= 1.5 && extra >= 300 ? 'warning' : 'info'
    return { severity, alertReason: severity === 'critical' ? 'Gap is at least 3× scheduled, 20 minutes total, and 10 minutes extra.' : severity === 'warning' ? 'Gap is at least 1.5× scheduled and 5 minutes extra.' : 'Wider predicted spacing is below the gap alert threshold.' }
  }
  const severity = ratio <= .25 && predicted <= 120 && -extra >= 300 ? 'critical' : ratio <= .5 && -extra >= 180 ? 'warning' : 'info'
  return { severity, alertReason: severity === 'critical' ? 'Predicted spacing is at most 25% of scheduled, 2 minutes apart, and compressed by at least 5 minutes.' : severity === 'warning' ? 'Predicted spacing is at most half of scheduled and compressed by at least 3 minutes.' : 'Predicted spacing is below the compression alert threshold.' }
}
