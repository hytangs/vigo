import { useEffect, type Dispatch, type SetStateAction } from 'react'
import type { ScenarioChangeDraft, ScenarioDraft } from '../reach'
import { buildRoutingPointFromMap } from '../routingUi'
import { lookupPlaceNames } from './usePlaceNames'

type NamedStop = { id: string; coordinate: [number, number]; label: string }

/** Name metadata must never retrace geometry or overwrite a moved/deleted stop. */
export function applyScenarioStopNames(drafts: ScenarioDraft[], changeId: string, names: NamedStop[]) {
  let changed = false
  const next = drafts.map(scenario => ({ ...scenario, interventions: scenario.interventions.map(change => {
    if (change.id !== changeId) return change
    return { ...change, stops: change.stops.map(stop => {
      const name = names.find(entry => entry.id === stop.id && entry.coordinate[0] === stop.coordinate[0] && entry.coordinate[1] === stop.coordinate[1])
      if (!name || stop.source !== 'map' || stop.label === name.label) return stop
      changed = true
      return { ...stop, label: name.label }
    }) }
  }) }))
  return changed ? next : drafts
}

/** Reuse Route/Reach's local address lookup, including for older saved pins. */
export function useScenarioStopNames(projectId: string, change: ScenarioChangeDraft,
  setDrafts: Dispatch<SetStateAction<ScenarioDraft[]>>) {
  const key = JSON.stringify(change.kind === 'flex-zone' ? [] : change.stops
    .filter(stop => stop.source === 'map').map(({ id, coordinate }) => ({ id, coordinate })))
  useEffect(() => {
    const stops = JSON.parse(key) as Array<Omit<NamedStop, 'label'>>
    if (!projectId || !stops.length) return
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), 10_000)
    void (async () => {
      for (let start = 0; start < stops.length && !controller.signal.aborted; start += 16) {
        const batch = stops.slice(start, start + 16)
        const labels = await lookupPlaceNames(projectId, batch.map(stop => buildRoutingPointFromMap(stop.coordinate, '')), controller.signal)
        if (controller.signal.aborted) return
        const names = batch.flatMap((stop, index) => labels[index] ? [{ ...stop, label: labels[index]! }] : [])
        if (names.length) setDrafts(current => applyScenarioStopNames(current, change.id, names))
      }
    })().catch(() => { /* Keep usable coordinates when local place data is unavailable. */ })
      .finally(() => window.clearTimeout(timer))
    return () => { controller.abort(); window.clearTimeout(timer) }
  }, [projectId, change.id, key, setDrafts])
}
