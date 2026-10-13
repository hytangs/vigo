// Compare corresponding raw cells before their display quantization. Preserve
// the existing 0.05-minute improvement tolerance at every requested cutoff.
export function reachChangeCounts(baseline, scenario, cutoffsMinutes) {
  if (baseline.length !== scenario.length) throw new Error('Reach comparison rasters must have equal lengths')
  return cutoffsMinutes.map(cutoffMinutes => {
    let improvedPixels = 0
    let worsenedPixels = 0
    for (let index = 0; index < baseline.length; index += 1) {
      const before = baseline[index]
      const after = scenario[index]
      if (Number.isFinite(after) && after <= cutoffMinutes
        && (!Number.isFinite(before) || after < before - 0.05)) improvedPixels++
      if (Number.isFinite(before) && before <= cutoffMinutes
        && (!Number.isFinite(after) || after > before + 0.05)) worsenedPixels++
    }
    return { cutoffMinutes, improvedPixels, worsenedPixels }
  })
}
