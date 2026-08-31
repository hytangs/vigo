import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Command,
  CornerDownLeft,
  Database,
  FolderOpen,
  MapPin,
  Navigation2,
  Radar,
  Route,
  Search,
  Settings2,
  X,
} from 'lucide-react'
import { classNames } from '../../domain'
import { searchGroupLabels, type SearchResult } from './searchModel'

type IndexedResult = {
  index: number
  result: SearchResult
}

function ResultIcon({ result }: { result: SearchResult }) {
  if (result.kind === 'route') return <Route size={16} />
  if (result.kind === 'stop') return <MapPin size={16} />
  if (result.kind === 'workspace') return <FolderOpen size={16} />
  if (result.id === 'command:pathfinder') return <Navigation2 size={16} />
  if (result.id === 'command:accessibility') return <Radar size={16} />
  if (result.id === 'command:data') return <Database size={16} />
  if (result.id === 'command:preferences') return <Settings2 size={16} />
  if (result.id === 'command:workspaces') return <FolderOpen size={16} />
  if (result.id === 'command:routes') return <Route size={16} />
  return <Command size={16} />
}

function HighlightedText({ text, query }: { text: string; query: string }) {
  const normalizedQuery = query.trim()
  if (!normalizedQuery) return text
  const start = text.toLocaleLowerCase().indexOf(normalizedQuery.toLocaleLowerCase())
  if (start < 0) return text
  const end = start + normalizedQuery.length
  return <>{text.slice(0, start)}<mark>{text.slice(start, end)}</mark>{text.slice(end)}</>
}

function keyboardShortcutLabel() {
  if (typeof navigator === 'undefined') return '⌘ K'
  return /Mac|iPhone|iPad/i.test(navigator.platform) ? '⌘ K' : 'Ctrl K'
}

export function SearchPalette({
  value,
  results,
  onChange,
  onActivate,
  onSubmit,
}: {
  value: string
  results: SearchResult[]
  onChange: (value: string) => void
  onActivate: (result: SearchResult) => void
  onSubmit: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const shortcut = useMemo(keyboardShortcutLabel, [])
  const groupedResults = useMemo(() => {
    const groups = new Map<SearchResult['group'], IndexedResult[]>()
    results.forEach((result, index) => {
      const group = groups.get(result.group)
      if (group) group.push({ result, index })
      else groups.set(result.group, [{ result, index }])
    })
    return [...groups.entries()]
  }, [results])

  useEffect(() => setActiveIndex(0), [results])

  useEffect(() => {
    if (!open || !results[activeIndex]) return
    const frame = window.requestAnimationFrame(() => {
      rootRef.current
        ?.querySelector<HTMLElement>(`#vigo-search-option-${activeIndex}`)
        ?.scrollIntoView({ block: 'nearest' })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [activeIndex, open, results])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.code === 'KeyK') {
        event.preventDefault()
        setOpen(true)
        inputRef.current?.focus()
        inputRef.current?.select()
      } else if (event.key === 'Escape' && open) {
        event.preventDefault()
        setOpen(false)
        inputRef.current?.blur()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open])

  function activate(result: SearchResult) {
    onActivate(result)
    setOpen(false)
  }

  function moveActiveResult(direction: 1 | -1) {
    if (!results.length) return
    setOpen(true)
    setActiveIndex((current) => (current + direction + results.length) % results.length)
  }

  return (
    <div
      ref={rootRef}
      className={classNames('search-palette', open && 'is-open', value && 'has-query')}
      onBlur={(event) => {
        if (!rootRef.current?.contains(event.relatedTarget as Node | null)) setOpen(false)
      }}
    >
      <div className="search-palette__field">
        <Search size={16} aria-hidden="true" />
        <input
          ref={inputRef}
          value={value}
          role="combobox"
          aria-label="Search VIGO"
          aria-controls="vigo-search-results"
          aria-expanded={open}
          aria-autocomplete="list"
          aria-activedescendant={open && results[activeIndex] ? `vigo-search-option-${activeIndex}` : undefined}
          autoComplete="off"
          spellCheck={false}
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            onChange(event.currentTarget.value)
            setOpen(true)
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              moveActiveResult(1)
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              moveActiveResult(-1)
            } else if (event.key === 'Home' && results.length) {
              event.preventDefault()
              setActiveIndex(0)
            } else if (event.key === 'End' && results.length) {
              event.preventDefault()
              setActiveIndex(results.length - 1)
            } else if (event.key === 'Enter') {
              event.preventDefault()
              const activeResult = open ? results[activeIndex] : undefined
              if (activeResult) activate(activeResult)
              else onSubmit()
            } else if (event.key === 'Escape') {
              event.preventDefault()
              setOpen(false)
              inputRef.current?.blur()
            }
          }}
          placeholder="Search VIGO"
        />

        {value ? (
          <button
            type="button"
            className="search-palette__clear"
            aria-label="Clear search"
            title="Clear search"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              onChange('')
              setOpen(true)
              inputRef.current?.focus()
            }}
          >
            <X size={14} />
          </button>
        ) : (
          <kbd aria-label={`Keyboard shortcut ${shortcut}`}>{shortcut}</kbd>
        )}
      </div>

      {open ? (
        <div className="search-palette__results">
          <div
            id="vigo-search-results"
            className="search-palette__scroll"
            role="listbox"
            aria-label={`${results.length} search ${results.length === 1 ? 'result' : 'results'}`}
          >
            {groupedResults.length ? groupedResults.map(([group, items]) => (
              <section
                key={group}
                className="search-palette__group"
                role="group"
                aria-labelledby={`vigo-search-group-${group}`}
              >
                <h2 id={`vigo-search-group-${group}`}>{searchGroupLabels[group]}</h2>
                {items.map(({ result, index }) => {
                  const selected = index === activeIndex
                  return (
                    <button
                      key={result.id}
                      id={`vigo-search-option-${index}`}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      className={classNames('search-palette__option', selected && 'is-active')}
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => activate(result)}
                    >
                      <span className="search-palette__icon" aria-hidden="true">
                        <ResultIcon result={result} />
                      </span>
                      <span className="search-palette__copy">
                        <strong><HighlightedText text={result.title} query={value} /></strong>
                        <small><HighlightedText text={result.subtitle} query={value} /></small>
                      </span>
                      <CornerDownLeft className="search-palette__open-icon" size={14} aria-hidden="true" />
                    </button>
                  )
                })}
              </section>
            )) : (
              <div className="search-palette__empty" role="status">
                <Search size={18} aria-hidden="true" />
                <strong>No results for “{value.trim()}”</strong>
                <span>Try a service number, stop, network, or action.</span>
              </div>
            )}
          </div>

          {results.length ? (
            <div className="search-palette__help" aria-hidden="true">
              <span><kbd>↑↓</kbd> Navigate</span>
              <span><kbd>↵</kbd> Open</span>
              <span><kbd>esc</kbd> Close</span>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
