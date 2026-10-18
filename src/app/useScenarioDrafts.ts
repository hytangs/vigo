import { useLayoutEffect } from 'react'
import { openScenarioDrafts, scenarioDrafts, scenarioDraftSetters } from '../state/scenarios'
import { useStore } from './store'

/** One City's Scenario drafts; setters stay bound to the City they came from. */
export function useScenarioDrafts(key: string) {
  useLayoutEffect(() => { openScenarioDrafts(key) }, [key])
  const state = useStore(scenarioDrafts, (current) => current)
  return {
    scenarioDrafts: state.value.cases,
    activeScenarioId: state.value.activeCaseId,
    activeScenarioChangeId: state.value.activeChangeId,
    ...scenarioDraftSetters(key),
    draftStorageError: state.error || state.saveError,
  }
}
