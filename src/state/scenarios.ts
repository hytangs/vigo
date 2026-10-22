import { createStore, memoizeLast } from '../app/store'
import { initialScenarioLibrary } from '../app/scenarioLibrary'
import type { ScenarioLibraryState } from '../app/useScenarioLibrary'
import type { VigoProject } from '../domain'
import { selectedProject } from './scope'

/** The City-folder library is loaded and saved by ScenarioRuntime. Selectors
 * share its current value; an old City's callbacks never become the new City's. */
export const scenarios = createStore<{ projectId: string; library: ScenarioLibraryState | null }>({ projectId: '', library: null })
export const resetScenarios = () => scenarios.set({ projectId: '', library: null })
const noop = () => {}
const pendingLibrary = memoizeLast((project: VigoProject): ScenarioLibraryState => {
  const library = initialScenarioLibrary(project)
  return {
    scenarioDrafts: library.scenarios, activeScenarioId: library.scenarios[0]?.id ?? '', activeScenarioChangeId: '',
    setScenarioNetworkFeed: noop, setScenarioDrafts: noop, setActiveScenarioId: noop, setActiveScenarioChangeId: noop,
    draftStorageError: '', saveState: 'loading', retrySave: noop,
    grouping: {
      value: { groups: library.groups, cases: Object.fromEntries(library.scenarios.map(s => [s.id, s.groupId ?? ''])), caseScope: project.id },
      error: '', readFailed: false, retry: noop, saveGroup: noop, removeGroup: noop, toggleFeed: noop, assignCase: noop,
    },
  }
})
export function scenarioLibrary() {
  const project = selectedProject()
  const state = scenarios.get()
  return state.projectId === project.id && state.library ? state.library : pendingLibrary(project)
}
export const scenarioDraftValues = memoizeLast((library: ScenarioLibraryState) => ({
  cases: library.scenarioDrafts, activeCaseId: library.activeScenarioId, activeChangeId: library.activeScenarioChangeId,
}))
export const scenarioValues = () => scenarioDraftValues(scenarioLibrary())
