import type { SetStateAction } from 'react'
import { emptyScenarios, parseStoredScenarios, type StoredScenarios } from '../app/scenarioDraftStorage'
import { createStore } from '../app/store'
import type { ScenarioDraft } from '../reach'

/**
 * Scenario drafts for the open City, persisted per City in local storage.
 * Only one City's drafts are open at a time; an update addressed to another
 * City (a late callback after switching) is ignored.
 */
export type ScenarioDraftState = {
  key: string
  value: StoredScenarios
  error: string
  saveError: string
}

function readDraft(key: string): Omit<ScenarioDraftState, 'saveError'> {
  try {
    return { key, value: parseStoredScenarios(key ? window.localStorage.getItem(key) : null), error: '' }
  } catch (error) {
    return { key, value: emptyScenarios(), error: error instanceof Error ? error.message : 'Saved Scenario drafts could not be read.' }
  }
}

const initialDrafts = (): ScenarioDraftState => ({ key: '', value: emptyScenarios(), error: '', saveError: '' })

export const scenarioDrafts = createStore<ScenarioDraftState>(initialDrafts())

export const resetScenarioDrafts = () => scenarioDrafts.set(initialDrafts())

export function openScenarioDrafts(key: string) {
  if (scenarioDrafts.get().key === key) return
  scenarioDrafts.set({ ...readDraft(key), saveError: '' })
}

export function updateScenarioDrafts<K extends keyof StoredScenarios>(key: string, field: K, action: SetStateAction<StoredScenarios[K]>) {
  const current = scenarioDrafts.get()
  // A callback from an old City must never modify the newly selected City.
  if (current.key !== key) return
  const fieldValue = typeof action === 'function'
    ? (action as (previous: StoredScenarios[K]) => StoredScenarios[K])(current.value[field])
    : action
  const value = { ...current.value, [field]: fieldValue }
  let saveError = current.saveError
  if (key) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value))
      saveError = ''
    } catch {
      saveError = 'Scenario drafts could not be saved. Keep Studio open until local storage is available.'
    }
  }
  scenarioDrafts.set({ value, error: '', saveError })
}

/** Setters bound to one City's drafts. */
export function scenarioDraftSetters(key: string) {
  return {
    setScenarioDrafts: (action: SetStateAction<ScenarioDraft[]>) => updateScenarioDrafts(key, 'cases', action),
    setActiveScenarioId: (action: SetStateAction<string>) => updateScenarioDrafts(key, 'activeCaseId', action),
    setActiveScenarioChangeId: (action: SetStateAction<string>) => updateScenarioDrafts(key, 'activeChangeId', action),
  }
}
