import { useLayoutEffect, useState } from 'react'
import type { VigoProject } from '../domain'
import type { ScenarioDraft } from '../reach'

export type CityDataGroup = { id: string; name: string; feedIds: string[] }
export type CityDataGroups = { groups: CityDataGroup[]; cases: Record<string, string>; caseScope: string }

export function cityDataGroupsKey(project: VigoProject) {
  return `vigo.data-groups.v1:${JSON.stringify([project.storagePath, project.id])}`
}

function initial(caseScope: string, feeds: string[], cases: string[]): CityDataGroups {
  return { groups: [{ id: 'baseline', name: 'Baseline', feedIds: feeds }],
    cases: Object.fromEntries(cases.map(id => [id, 'baseline'])), caseScope }
}

function read(key: string, caseScope: string, feeds: string[], cases: string[]) {
  try {
    const text = localStorage.getItem(key)
    if (!text) return { key, value: initial(caseScope, feeds, cases), dirty: false, error: '' }
    if (text.length > 128_000) throw Error('Group list is too large.')
    const data = JSON.parse(text)
    if (data.version !== 1 || !Array.isArray(data.groups) || data.groups.length > 64
      || !data.groups.every((g: CityDataGroup) => typeof g?.id === 'string' && g.id && typeof g.name === 'string'
        && g.name.trim() && g.name.length <= 80 && Array.isArray(g.feedIds) && g.feedIds.every(id => typeof id === 'string'))
      || new Set(data.groups.map((g: CityDataGroup) => g.id)).size !== data.groups.length
      || !data.cases || typeof data.cases !== 'object' || Array.isArray(data.cases)
      || !Object.values(data.cases).every(id => typeof id === 'string')) throw Error('Invalid group list.')
    return { key, value: { groups: data.groups as CityDataGroup[],
      // Keep missing group/feed references visible; never silently widen a case.
      cases: data.caseScope === caseScope ? data.cases as Record<string, string> : {}, caseScope }, dirty: false, error: '' }
  } catch {
    return { key, value: { groups: [], cases: {}, caseScope }, dirty: false,
      error: 'Saved groups could not be read. Your stored copy is unchanged.' }
  }
}

export function caseFeedSelection(value: CityDataGroups, caseId: string, project: VigoProject) {
  const group = value.groups.find(entry => entry.id === value.cases[caseId])
  const feedIds = [...new Set(group?.feedIds ?? [])]
  const error = !group ? 'Choose a feed group for this case in City data.'
    : !feedIds.length ? `Add a timetable to ${group.name} in City data.`
    : feedIds.some(id => !project.feeds.some(feed => feed.id === id)) ? `${group.name} contains a removed timetable. Update it in City data.`
    : feedIds.some(id => project.feeds.find(feed => feed.id === id)?.routingStore?.status !== 'ready') ? `Wait for the timetables in ${group.name} to finish preparing.`
    : ''
  return { group, feedIds, error }
}

export function useCityDataGroups(project: VigoProject, caseScope: string, cases: ScenarioDraft[]) {
  const key = cityDataGroupsKey(project)
  const readCurrent = () => read(key, caseScope, project.feeds.map(feed => feed.id), cases.map(entry => entry.id))
  const [state, setState] = useState(readCurrent)
  const [saveError, setSaveError] = useState('')
  useLayoutEffect(() => {
    if (state.key !== key || state.value.caseScope !== caseScope) {
      setState(readCurrent())
      setSaveError('')
    }
  })
  useLayoutEffect(() => {
    if (!state.dirty || state.key !== key || state.value.caseScope !== caseScope) return
    try {
      localStorage.setItem(key, JSON.stringify({ version: 1, ...state.value }))
      setSaveError('')
    } catch { setSaveError('Groups could not be saved. Keep Studio open and try again.') }
  }, [key, caseScope, state])
  function update(change: (value: CityDataGroups) => CityDataGroups) {
    setState(current => current.key !== key || current.value.caseScope !== caseScope || current.error
      ? current : { ...current, value: change(current.value), dirty: true })
  }
  return {
    value: state.key === key && state.value.caseScope === caseScope ? state.value : initial(caseScope, [], []),
    error: state.error || saveError,
    readFailed: Boolean(state.error),
    retry: () => state.error ? setState(readCurrent()) : setState(current => ({ ...current, dirty: true })),
    saveGroup: (id: string, name: string, feedIds?: string[]) => {
      if (!name.trim()) return
      update(value => ({ ...value, groups: value.groups.some(g => g.id === id)
        ? value.groups.map(g => g.id === id ? { ...g, name: name.trim().slice(0, 80), feedIds: feedIds ?? g.feedIds } : g)
        : value.groups.length < 64 ? [...value.groups, { id, name: name.trim().slice(0, 80), feedIds: feedIds ?? [] }] : value.groups }))
    },
    removeGroup: (id: string) => update(value => ({ ...value, groups: value.groups.filter(g => g.id !== id) })),
    toggleFeed: (groupId: string, feedId: string) => update(value => ({ ...value,
      groups: value.groups.map(group => group.id !== groupId ? group : { ...group,
        feedIds: group.feedIds.includes(feedId) ? group.feedIds.filter(id => id !== feedId) : [...group.feedIds, feedId] }) })),
    assignCase: (caseId: string, groupId: string) => update(value => ({ ...value, cases: { ...value.cases, [caseId]: groupId } })),
  }
}

export type CityDataGrouping = ReturnType<typeof useCityDataGroups>
