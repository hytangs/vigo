import { useCallback, useRef, useSyncExternalStore } from 'react'

/**
 * A small observable state container. Studio workspaces each own one store;
 * components read the slice they show through `useStore`/`useStores`, so a
 * change re-renders only the components whose selection changed.
 */
export type Store<T extends object> = {
  get(): T
  /** Merge a patch. Listeners run only when a field changes identity. */
  set(update: Partial<T> | ((state: T) => Partial<T>)): void
  subscribe(listener: () => void): () => void
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial
  const listeners = new Set<() => void>()
  return {
    get: () => state,
    set(update) {
      const patch = typeof update === 'function' ? update(state) : update
      let next: T | undefined
      for (const key in patch) {
        if (Object.is(patch[key], state[key])) continue
        next ??= { ...state }
        next[key] = patch[key] as T[typeof key]
      }
      if (!next) return
      state = next
      for (const listener of [...listeners]) listener()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

export function shallowEqual<T>(left: T, right: T) {
  if (Object.is(left, right)) return true
  if (typeof left !== 'object' || typeof right !== 'object' || !left || !right) return false
  const leftKeys = Object.keys(left)
  if (leftKeys.length !== Object.keys(right).length) return false
  return leftKeys.every((key) => (
    Object.prototype.hasOwnProperty.call(right, key)
    && Object.is((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key])
  ))
}

type AnyStore = Store<object>

/**
 * Subscribe to one or more stores through a selector. The selector may read
 * any store with `get()`; the component re-renders only when the selection
 * changes under `isEqual` (identity by default, `shallowEqual` for records).
 */
export function useStores<S>(stores: readonly AnyStore[], select: () => S, isEqual: (left: S, right: S) => boolean = Object.is): S {
  const cache = useRef<{ states: object[]; select: () => S; value: S } | null>(null)
  // Stores are module singletons; a component passes the same list each render.
  const subscribe = useCallback((listener: () => void) => {
    const unsubscribes = stores.map((store) => store.subscribe(listener))
    return () => unsubscribes.forEach((unsubscribe) => unsubscribe())
  }, stores)
  const snapshot = () => {
    const states = stores.map((store) => store.get())
    const cached = cache.current
    if (cached && cached.select === select && states.every((state, index) => state === cached.states[index])) return cached.value
    const value = select()
    if (cached && isEqual(cached.value, value)) {
      cache.current = { states, select, value: cached.value }
      return cached.value
    }
    cache.current = { states, select, value }
    return value
  }
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

export function useStore<T extends object, S>(store: Store<T>, select: (state: T) => S, isEqual?: (left: S, right: S) => boolean): S {
  return useStores([store as AnyStore], () => select(store.get()), isEqual)
}

/**
 * Cache the latest result per argument identity. Derived Studio values (the
 * selected City, its scoped preview, routing scope) are shared by actions and
 * every subscribed component, so each is computed once per input change.
 */
export function memoizeLast<A extends unknown[], R>(compute: (...args: A) => R): (...args: A) => R {
  let last: { args: A; value: R } | null = null
  return (...args: A) => {
    if (last && last.args.length === args.length && last.args.every((value, index) => Object.is(value, args[index]))) return last.value
    const value = compute(...args)
    last = { args, value }
    return value
  }
}
