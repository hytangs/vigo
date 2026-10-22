import { createStore, memoizeLast } from '../app/store'
import { caseFeedSelection, type CityDataGroups } from '../app/cityDataGroups'
import { initialScenarioLibrary } from '../app/scenarioLibrary'
import type { ScenarioLibraryState } from '../app/useScenarioLibrary'
import type { RouteMetric, VigoProject } from '../domain'
import type { ScenarioDraft } from '../reach'
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

export const cityGrouping = () => scenarioLibrary().grouping
/** Feed groups for the selected City; stable while its stored copy is unchanged. */
export const cityGroupsValue = (): CityDataGroups => cityGrouping().value

const activeScenarioOf = memoizeLast((cases: ScenarioDraft[], activeCaseId: string) => cases.find((entry) => entry.id === activeCaseId) ?? cases[0])
/** The scenario open in Scenarios, which Reach also compares against its baseline. */
export const activeScenario = () => activeScenarioOf(scenarioValues().cases, scenarioValues().activeCaseId)

const activeScenarioChangeOf = memoizeLast((scenario: ScenarioDraft | undefined, activeChangeId: string) => (
  scenario?.interventions.find((entry) => entry.id === activeChangeId) ?? scenario?.interventions[0]
))
export const activeScenarioChange = () => activeScenarioChangeOf(activeScenario(), scenarioValues().activeChangeId)

const activeCaseFeedsOf = memoizeLast(caseFeedSelection)
/** The timetables the active scenario runs on. */
export const activeCaseFeeds = () => activeCaseFeedsOf(cityGroupsValue(), scenarioValues().activeCaseId, selectedProject())

export const findScenarioRoute = (routes: RouteMetric[], routeId: string | undefined) => routeId
  ? routes.find((candidate) => candidate.id === routeId || candidate.patternId === routeId)
  : undefined
