import { useEffect, useRef, useState, type RefObject } from 'react'
import { CheckCircle2, Server, XCircle } from 'lucide-react'
import { requestDesktopHomeFolder } from '../app/desktopBridge'
import type {
  ProjectDialogState,
  ProjectDraft,
  SetupDraft,
  VigoRuntimeConfig,
} from '../app/runtimeConfig'
import { basemapDescriptions, basemapLabels, classNames } from '../domain'
import { basemapOptions } from '../app/uiOptions'

function useDialogKeyboard({
  open,
  canDismiss,
  onClose,
  dialogRef,
  initialFocusRef,
}: {
  open: boolean
  canDismiss: boolean
  onClose: () => void
  dialogRef: RefObject<HTMLElement | null>
  initialFocusRef: RefObject<HTMLElement | null>
}) {
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const canDismissRef = useRef(canDismiss)
  const onCloseRef = useRef(onClose)
  canDismissRef.current = canDismiss
  onCloseRef.current = onClose

  useEffect(() => {
    if (!open) return
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const frame = window.requestAnimationFrame(() => initialFocusRef.current?.focus())
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && canDismissRef.current) {
        event.preventDefault()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab' || !dialogRef.current) return
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
      )).filter((element) => !element.hidden && element.getClientRects().length > 0)
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('keydown', onKeyDown)
      previousFocusRef.current?.focus()
    }
  }, [dialogRef, initialFocusRef, open])
}

export function ProjectEditorDialog({
  state,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  state: ProjectDialogState | null
  busy: boolean
  error: string
  onClose: () => void
  onSubmit: (draft: ProjectDraft) => void
}) {
  const nameRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLFormElement>(null)
  const [draft, setDraft] = useState<ProjectDraft>({ name: '', region: '' })
  const dialogKey = state?.mode === 'rename' ? `rename:${state.projectId}` : state?.mode ?? ''

  useEffect(() => {
    if (!state) {
      setDraft({ name: '', region: '' })
      return
    }

    setDraft({ name: state.name, region: state.region })
  }, [dialogKey])

  useDialogKeyboard({
    open: Boolean(state),
    canDismiss: !busy,
    onClose,
    dialogRef,
    initialFocusRef: nameRef,
  })

  if (!state) return null

  const isCreate = state.mode === 'create'

  return (
    <div className="project-dialog-layer" role="presentation">
      <button type="button" className="project-dialog-backdrop" aria-label="Close City editor" onClick={onClose} disabled={busy} />
      <form
        ref={dialogRef}
        className="project-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-editor-title"
        aria-describedby={error ? 'project-editor-error' : undefined}
        onSubmit={(event) => {
          event.preventDefault()
          onSubmit(draft)
        }}
      >
        <header>
          <span>{isCreate ? 'New City' : 'City identity'}</span>
          <h2 id="project-editor-title">{isCreate ? 'Create City' : 'Rename City'}</h2>
          <button type="button" aria-label="Close City editor" onClick={onClose} disabled={busy}>
            <XCircle size={16} />
          </button>
        </header>

        <label>
          <span>City name</span>
          <input
            ref={nameRef}
            value={draft.name}
            onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
            placeholder="Regional Signal Lab"
            disabled={busy}
          />
        </label>

        <label>
          <span>Region</span>
          <input
            value={draft.region}
            onChange={(event) => setDraft((current) => ({ ...current, region: event.target.value }))}
            placeholder="Sample transit corridor"
            disabled={busy}
          />
        </label>

        {error ? <p id="project-editor-error" className="project-dialog-error" role="alert">{error}</p> : null}

        <footer>
          <button type="button" className="project-dialog-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="project-dialog-primary" disabled={busy || !draft.name.trim()}>
            {busy ? 'Saving...' : isCreate ? 'Create City' : 'Save identity'}
          </button>
        </footer>
      </form>
    </div>
  )
}

export function FirstRunSetupDialog({
  open,
  config,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  open: boolean
  config: VigoRuntimeConfig | null
  busy: boolean
  error: string
  onClose: () => void
  onSubmit: (draft: SetupDraft) => void
}) {
  const dialogRef = useRef<HTMLFormElement>(null)
  const storageRootRef = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState<SetupDraft>({
    storageRoot: '',
    appearance: 'dark',
    accent: 'blue',
    basemap: 'streets',
  })
  const [desktopHint, setDesktopHint] = useState('')
  const setupKey = `${config?.storageRoot ?? ''}:${config?.appearance ?? ''}:${config?.accent ?? ''}:${config?.basemap ?? ''}`

  useEffect(() => {
    if (!config) return
    setDraft({
      storageRoot: config.storageRoot || config.defaultStorageRoot,
      appearance: config.appearance,
      accent: config.accent,
      basemap: config.basemap,
    })
    setDesktopHint('')
  }, [setupKey])

  const canDismiss = Boolean(config && !config.setupRequired)
  useDialogKeyboard({
    open: Boolean(open && config),
    canDismiss: canDismiss && !busy,
    onClose,
    dialogRef,
    initialFocusRef: storageRootRef,
  })

  if (!open || !config) return null

  const lockedStorage = !config.canChangeStorageRoot
  const offline = config.offline

  return (
    <div className="project-dialog-layer setup-dialog-layer" role="presentation">
      <button type="button" className="project-dialog-backdrop" aria-label="Close setup" onClick={canDismiss ? onClose : undefined} disabled={busy || !canDismiss} />
      <form
        ref={dialogRef}
        className="project-dialog setup-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="setup-dialog-title"
        aria-describedby={error ? 'setup-dialog-error' : undefined}
        onSubmit={(event) => {
          event.preventDefault()
          onSubmit(draft)
        }}
      >
        <header>
          <span>{config.setupRequired ? 'First run' : 'Settings'}</span>
          <h2 id="setup-dialog-title">Configure VIGO</h2>
          {canDismiss ? (
            <button type="button" aria-label="Close setup" onClick={onClose} disabled={busy}>
              <XCircle size={16} />
            </button>
          ) : null}
        </header>

        <section className="setup-hero">
          <Server size={18} />
          <span>
            <strong>VIGO runs as a private local app.</strong>
            <small>Static GTFS and OSM data, routing, and network review stay on this machine. Only optional GTFS-Realtime and remote map tiles use the network.</small>
          </span>
        </section>

        <label>
          <span>VIGO home folder</span>
          <div className="setup-path-row">
            <input
              ref={storageRootRef}
              value={draft.storageRoot}
              onChange={(event) => setDraft((current) => ({ ...current, storageRoot: event.target.value }))}
              placeholder={config.defaultStorageRoot}
              disabled={busy || lockedStorage}
            />
            <button
              type="button"
              className="project-dialog-secondary"
              disabled={busy || lockedStorage}
              onClick={() => {
                const openedDesktop = requestDesktopHomeFolder((path) => {
                  setDraft((current) => ({ ...current, storageRoot: path }))
                  setDesktopHint('Folder selected from VIGO Studio.')
                })
                if (!openedDesktop) setDesktopHint('Type a folder path, or use the default Documents folder in browser mode.')
              }}
            >
              Choose
            </button>
          </div>
          <small>{lockedStorage ? 'The City library location is fixed by local configuration.' : desktopHint || 'Each City is stored as one complete folder.'}</small>
        </label>

        <div className="setup-choice-grid">
          <fieldset>
            <legend>Appearance</legend>
            {(['dark', 'light'] as const).map((option) => (
              <button
                key={option}
                type="button"
                className={classNames(draft.appearance === option && 'is-selected')}
                onClick={() => setDraft((current) => ({ ...current, appearance: option }))}
                disabled={busy}
              >
                {option === 'dark' ? 'Dark' : 'Light'}
              </button>
            ))}
          </fieldset>

          <fieldset>
            <legend>Accent</legend>
            {([
              ['blue', 'VIGO blue'],
              ['teal', 'Transit teal'],
              ['graphite', 'Graphite'],
            ] as const).map(([option, label]) => (
              <button
                key={option}
                type="button"
                className={classNames(`accent-dot-${option}`, draft.accent === option && 'is-selected')}
                onClick={() => setDraft((current) => ({ ...current, accent: option }))}
                disabled={busy}
              >
                {label}
              </button>
            ))}
          </fieldset>
        </div>

        <label className="setup-basemap-choice">
          <span>Map base</span>
          <select
            value={draft.basemap}
            onChange={(event) => setDraft((current) => ({ ...current, basemap: event.target.value as SetupDraft['basemap'] }))}
            disabled={busy}
          >
            {basemapOptions.map((option) => (
              <option key={option} value={option}>{basemapLabels[option]}</option>
            ))}
          </select>
          <small>{basemapDescriptions[draft.basemap]}</small>
        </label>

        <div className="setup-offline-card">
          <div>
            <span className="eyebrow">Offline readiness</span>
            <strong>{offline.localServer && offline.gtfsImport && offline.offlineBasemap ? 'Core app works offline' : 'Offline setup needs review'}</strong>
          </div>
          <div className="setup-status-grid">
            <span className={classNames(offline.localServer && 'is-ok')}><CheckCircle2 size={13} />Local runtime</span>
            <span className={classNames(offline.storageWritable && 'is-ok')}><CheckCircle2 size={13} />Writable library</span>
            <span className={classNames(offline.gtfsImport && 'is-ok')}><CheckCircle2 size={13} />GTFS ZIP import</span>
            <span className={classNames(offline.offlineBasemap && 'is-ok')}><CheckCircle2 size={13} />Offline map canvas</span>
          </div>
          <small>Static GTFS/OSM analysis and routing work offline. Optional GTFS-RT live vehicles and remote map tiles require network access.</small>
        </div>

        {error ? <p id="setup-dialog-error" className="project-dialog-error" role="alert">{error}</p> : null}

        <footer>
          <button
            type="button"
            className="project-dialog-secondary"
            onClick={() => setDraft((current) => ({ ...current, storageRoot: config.defaultStorageRoot }))}
            disabled={busy || lockedStorage}
          >
            Use Documents
          </button>
          <button type="submit" className="project-dialog-primary" disabled={busy || !draft.storageRoot.trim()}>
            {busy ? 'Saving...' : config.setupRequired ? 'Finish setup' : 'Save setup'}
          </button>
        </footer>
      </form>
    </div>
  )
}
