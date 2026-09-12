import type { Dispatch, SetStateAction } from 'react'
import type { ScenarioDraft } from '../reach'

export function createScenarioRoadGeometryRequest(
  interventionId: string,
  setScenarioDrafts: Dispatch<SetStateAction<ScenarioDraft[]>>,
) {
  const controller = new AbortController()
  // Keep the setter belonging to the request's City. A later City switch must
  // not let cancellation modify another City's interventions.
  controller.signal.addEventListener('abort', () => {
    setScenarioDrafts((current) => current.map((entry) => ({
      ...entry,
      interventions: entry.interventions.map((change) => (
        change.id === interventionId && change.geometryStatus === 'loading'
          ? { ...change, geometryStatus: 'idle', geometryError: '' }
          : change
      )),
    })))
  }, { once: true })
  return controller
}
