import { useLayoutEffect } from 'react'
import { shallowEqual, useStores, type Store } from '../app/store'
import { analyze } from './analyze'
import { city } from './city'
import { clock } from './clock'
import { network } from './network'
import { route } from './route'
import { scenarioEditor } from './scenarioEditor'
import { scenarios } from './scenarios'
import { shell } from './shell'

const studioStores = [shell, city, clock, network, route, analyze, scenarios, scenarioEditor] as readonly Store<object>[]

/**
 * Read derived Studio state. The selector may combine any stores (usually
 * through the getters in `scope`, `network`, `route`, `analyze` and
 * `scenarioEditor`); the component re-renders only when its selection changes.
 */
export function useStudio<S>(select: () => S, isEqual?: (left: S, right: S) => boolean): S {
  return useStores(studioStores, select, isEqual)
}

export const useStudioRecord = <S extends object>(select: () => S) => useStudio(select, shallowEqual)

/** Publish a value computed by a runtime hook into a store field. */
export function usePublish<T extends object, K extends keyof T>(store: Store<T>, key: K, value: T[K]) {
  useLayoutEffect(() => {
    if (!shallowEqual(store.get()[key], value)) store.set({ [key]: value } as unknown as Partial<T>)
  })
}
