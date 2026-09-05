import { type SetStateAction, useLayoutEffect, useState } from 'react'
import type { ScenarioDraft } from '../reach'
import { emptyScenarios, parseStoredScenarios, type StoredScenarios } from './scenarioDraftStorage'

function readDraft(key: string) {
  try {
    return { key, value: parseStoredScenarios(key ? window.localStorage.getItem(key) : null), dirty: false, error: '' }
  } catch (error) {
    return { key, value: emptyScenarios(), dirty: false, error: error instanceof Error ? error.message : 'Saved Scenario drafts could not be read.' }
  }
}

export function useScenarioDrafts(key: string) {
  const [state, setState] = useState(() => readDraft(key))
  const [saveError, setSaveError] = useState('')
  useLayoutEffect(() => {
    if (state.key !== key) {
      setState(readDraft(key))
      setSaveError('')
    }
  }, [key, state.key])
  useLayoutEffect(() => {
    if (!key || state.key !== key || !state.dirty) return
    try {
      window.localStorage.setItem(key, JSON.stringify(state.value))
      setSaveError('')
    } catch {
      setSaveError('Scenario drafts could not be saved. Keep Studio open until local storage is available.')
    }
  }, [key, state])
  function update<K extends keyof StoredScenarios>(field: K, action: SetStateAction<StoredScenarios[K]>) {
    setState((current) => {
      // A callback from an old City must never modify the newly selected City.
      if (current.key !== key) return current
      const value = typeof action === 'function'
        ? (action as (previous: StoredScenarios[K]) => StoredScenarios[K])(current.value[field])
        : action
      return { ...current, value: { ...current.value, [field]: value }, dirty: true, error: '' }
    })
  }
  return {
    scenarioDrafts: state.value.cases,
    setScenarioDrafts: (action: SetStateAction<ScenarioDraft[]>) => update('cases', action),
    activeScenarioId: state.value.activeCaseId,
    setActiveScenarioId: (action: SetStateAction<string>) => update('activeCaseId', action),
    activeScenarioChangeId: state.value.activeChangeId,
    setActiveScenarioChangeId: (action: SetStateAction<string>) => update('activeChangeId', action),
    draftStorageError: state.error || saveError,
  }
}
