import { HardDrive, RefreshCw, ShieldAlert, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { apiJson } from '../app/api'
import { formatBytes } from '../app/presentation'
import type { VigoProject } from '../domain'

type StorageMeasure = {
  bytes: number
  fileCount: number
}

type CityDataPreview = {
  schemaVersion: 'vigo.city.data.preview.v1'
  city: {
    id: string
    name: string
    region: string
  }
  estimatedFreedBytes: number
  fileCount: number
  managedBytes: number
  activeImport: boolean
  hasData: boolean
  counts: {
    feeds: number
    routes: number
    stops: number
  }
  categories: {
    timetables: StorageMeasure
    streets: StorageMeasure
    activity: StorageMeasure
    other: StorageMeasure
  }
}

type CityDataResult = {
  ok: boolean
  city: VigoProject
  data: CityDataPreview
  reset: {
    completedAt: string
    removedFileCount: number
    freedBytes: number
  }
}

const cleanupCategories: Array<{
  key: keyof CityDataPreview['categories']
  label: string
}> = [
  { key: 'timetables', label: 'Timetables' },
  { key: 'streets', label: 'Street index' },
  { key: 'activity', label: 'Build records' },
  { key: 'other', label: 'Other managed data' },
]

export function CityDataControl({
  projects,
  defaultProjectId,
  onCityReset,
  onCityRemoved,
}: {
  projects: VigoProject[]
  defaultProjectId: string
  onCityReset: (project: VigoProject) => void
  onCityRemoved: (projectId: string) => Promise<boolean>
}) {
  const [targetProjectId, setTargetProjectId] = useState(defaultProjectId)
  const [preview, setPreview] = useState<CityDataPreview | null>(null)
  const [loading, setLoading] = useState(false)
  const [workingAction, setWorkingAction] = useState<'deep-clean' | 'remove' | null>(null)
  const [confirmationAction, setConfirmationAction] = useState<'deep-clean' | 'remove' | null>(null)
  const [confirmation, setConfirmation] = useState('')
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [refresh, setRefresh] = useState(0)

  const targetProject = useMemo(
    () => projects.find((project) => project.id === targetProjectId) ?? null,
    [projects, targetProjectId],
  )

  useEffect(() => {
    setTargetProjectId(defaultProjectId)
  }, [defaultProjectId])

  useEffect(() => {
    if (targetProject) return
    const fallbackId = projects.some((project) => project.id === defaultProjectId)
      ? defaultProjectId
      : projects[0]?.id ?? ''
    setTargetProjectId(fallbackId)
  }, [defaultProjectId, projects, targetProject])

  useEffect(() => {
    if (!targetProjectId) {
      setPreview(null)
      return
    }

    let current = true
    const controller = new AbortController()
    setPreview(null)
    setLoading(true)
    setError('')
    setStatus('')
    setConfirmationAction(null)
    setConfirmation('')
    apiJson<{ data: CityDataPreview }>(
      `/api/projects/${encodeURIComponent(targetProjectId)}/city-data`,
      { signal: controller.signal },
    ).then((result) => {
      if (current) setPreview(result.data)
    }).catch((reason) => {
      if (current) {
        setPreview(null)
        setError(reason instanceof Error ? reason.message : 'Unable to inspect City data.')
      }
    }).finally(() => {
      if (current) setLoading(false)
    })

    return () => {
      current = false
      controller.abort()
    }
  }, [targetProjectId, targetProject?.updatedAt, refresh])

  async function resetCityData() {
    if (!canConfirm || !preview || confirmationAction !== 'deep-clean') return
    setWorkingAction('deep-clean')
    setError('')
    setStatus('')
    try {
      const result = await apiJson<CityDataResult>(
        `/api/projects/${encodeURIComponent(preview.city.id)}/city-data`,
        {
          method: 'POST',
          body: JSON.stringify({ confirmation }),
        },
      )
      setPreview(result.data)
      setConfirmation('')
      setConfirmationAction(null)
      setStatus(
        result.reset.freedBytes > 0
          ? `${formatBytes(result.reset.freedBytes)} removed. ${result.city.name} is ready for a fresh import.`
          : `${result.city.name} is ready for a fresh import.`,
      )
      onCityReset(result.city)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to reset this City.')
    } finally {
      setWorkingAction(null)
    }
  }

  async function removeCity() {
    if (!canConfirm || !preview || confirmationAction !== 'remove') return
    setWorkingAction('remove')
    setError('')
    setStatus('')
    try {
      const removed = await onCityRemoved(preview.city.id)
      if (!removed) {
        setError('The City was not removed.')
        return
      }
      setConfirmation('')
      setConfirmationAction(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to remove this City.')
    } finally {
      setWorkingAction(null)
    }
  }

  const canConfirm = Boolean(preview && preview.city.id === targetProjectId && confirmation === preview.city.name && !workingAction && !loading && !preview.activeImport)

  return (
    <div className="city-data-control">
      <div className="city-storage-picker"><label className="data-control-label" htmlFor="city-data-target">
        <span>City</span>
        <select
          id="city-data-target"
          value={targetProjectId}
          onChange={(event) => setTargetProjectId(event.target.value)}
          disabled={loading || Boolean(workingAction) || !projects.length}
        >
          {projects.map((project) => (
            <option key={project.id} value={project.id}>{project.name}</option>
          ))}
        </select>
      </label><button type="button" className="settings-icon-button" aria-label="Refresh City storage" disabled={loading || Boolean(workingAction)} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={16} /></button></div>

      {loading ? (
        <div className="city-data-loading" role="status">
          <HardDrive size={16} aria-hidden="true" />
          Measuring City data…
        </div>
      ) : preview ? (
        <>
          <div className="city-data-overview" aria-label="City cleanup impact">
            <div>
              <span>Managed data</span>
              <strong>{formatBytes(preview.managedBytes)}</strong>
            </div>
            <div>
              <span>Stored files</span>
              <strong>{preview.fileCount.toLocaleString()}</strong>
            </div>
            <div>
              <span>Imported feeds</span>
              <strong>{preview.counts.feeds.toLocaleString()}</strong>
            </div>
          </div>

          <div className="city-storage-bar" aria-hidden="true">{cleanupCategories.map(({ key }) => <span key={key} data-category={key} style={{ flexGrow: preview.categories[key].bytes }} />)}</div>
          <ul className="city-data-breakdown" aria-label="Managed data breakdown">
            {cleanupCategories.map(({ key, label }) => (
              <li key={key}>
                <span><i data-category={key} aria-hidden="true" />{label}</span>
                <strong>{formatBytes(preview.categories[key].bytes)}</strong>
              </li>
            ))}
          </ul>
          <p className="settings-note">File sizes may differ from disk space used on compressed or shared storage.</p>
          <details className="city-maintenance" key={targetProjectId}>
          <summary>Reset or remove this City</summary>
          <div className="city-data-action">
            <span>
              <strong>Reset imported data</strong>
              <small>
                Removes timetables, streets, and build data. Keeps the City name and your original files outside its data folder.
              </small>
            </span>
            <button
              type="button"
              className="button data-danger-button"
              disabled={!preview.hasData || preview.activeImport || Boolean(workingAction)}
              onClick={() => {
                setConfirmationAction('deep-clean')
                setConfirmation('')
                setError('')
                setStatus('')
              }}
            >
              <Trash2 size={15} aria-hidden="true" />
              {preview.hasData ? 'Reset data…' : 'Already clean'}
            </button>
          </div>

          <div className="city-data-action city-remove-action">
            <span>
              <strong>Remove City</strong>
              <small>
                Deletes this City from the local library, including its identity and managed data.
              </small>
            </span>
            <button
              type="button"
              className="button data-danger-button"
              disabled={preview.activeImport || Boolean(workingAction)}
              onClick={() => {
                setConfirmationAction('remove')
                setConfirmation('')
                setError('')
                setStatus('')
              }}
            >
              <Trash2 size={15} aria-hidden="true" />
              Remove City…
            </button>
          </div>

          {preview.activeImport ? (
            <p className="city-data-note">An import is active. Cleanup unlocks when it finishes.</p>
          ) : null}

          {confirmationAction ? (
            <div
              className="city-data-confirm"
              role="group"
              aria-label={`Confirm ${confirmationAction === 'remove' ? 'City removal' : 'City data reset'}`}
            >
              <ShieldAlert size={18} aria-hidden="true" />
              <div>
                <strong>This cannot be undone</strong>
                <span>
                  Type <b>{preview.city.name}</b> to {confirmationAction === 'remove'
                    ? 'delete this City from the local library.'
                    : 'remove all imported data from this City.'}
                </span>
                <input
                  aria-label="City name confirmation"
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                  autoFocus
                  autoComplete="off"
                  spellCheck={false}
                  disabled={Boolean(workingAction)}
                />
              </div>
              <div className="city-data-confirm-actions">
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={Boolean(workingAction)}
                  onClick={() => {
                    setConfirmationAction(null)
                    setConfirmation('')
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="button data-danger-button"
                  disabled={!canConfirm}
                  onClick={() => void (confirmationAction === 'remove' ? removeCity() : resetCityData())}
                >
                  {workingAction === 'remove'
                    ? 'Removing…'
                    : workingAction === 'deep-clean'
                      ? 'Cleaning…'
                      : confirmationAction === 'remove' ? 'Remove City' : 'Reset City data'}
                </button>
              </div>
            </div>
          ) : null}
          </details>
        </>
      ) : null}

      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {status ? <p className="city-data-status" role="status">{status}</p> : null}
    </div>
  )
}
