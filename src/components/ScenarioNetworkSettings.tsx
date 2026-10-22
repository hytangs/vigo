import { useStudio } from '../state/hooks'
import { scenarioLibrary } from '../state/scenarios'
import { selectedProject } from '../state/scope'
import { invalidateAnalyzeResult } from '../state/analyze'

/** The timetables a scenario combines; Route and Reach run on the same mix. */
export function ScenarioNetworkSettings({ scenarioId }: { scenarioId: string }) {
  const library = useStudio(scenarioLibrary)
  const project = useStudio(selectedProject)
  const scenario = library.scenarioDrafts.find(entry => entry.id === scenarioId)
  const group = library.grouping.value.groups.find(entry => entry.id === scenario?.groupId)
  if (!scenario || !group) return null
  function toggle(feedId: string, checked: boolean) {
    if (!scenario || !group) return
    invalidateAnalyzeResult()
    library.setScenarioNetworkFeed(scenarioId, feedId, checked)
  }
  const needsNewGroup = group.id === 'baseline' || library.scenarioDrafts.some(entry => entry.id !== scenarioId && entry.groupId === group.id)
  const groupLimitReached = needsNewGroup && library.grouping.value.groups.length >= 64

  return <fieldset className="scenario-network-settings" disabled={library.saveState === 'loading'}>
    <legend>Included timetables</legend>
    {project.feeds.map(feed => <label key={feed.id}>
      <span>{feed.name}</span>
      <input type="checkbox" role="switch" checked={group.feedIds.includes(feed.id)}
        disabled={(group.feedIds.length === 1 && group.feedIds.includes(feed.id)) || groupLimitReached}
        title={group.feedIds.length === 1 && group.feedIds.includes(feed.id) ? 'A scenario keeps at least one timetable.' : undefined}
        onChange={event => toggle(feed.id, event.currentTarget.checked)} />
    </label>)}
    {groupLimitReached ? <p>Remove an unused timetable group in City data before creating another network combination.</p> : null}
    {library.draftStorageError ? <p role="alert">{library.draftStorageError}</p> : null}
  </fieldset>
}
