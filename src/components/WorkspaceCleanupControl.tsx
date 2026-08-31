import { HardDrive, ShieldAlert, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { apiJson } from '../app/api'
import { formatBytes } from '../app/presentation'
import type { VigoProject } from '../domain'

type StorageMeasure = {
  bytes: number
  fileCount: number
}

type WorkspaceCleanupPreview = {
  schemaVersion: 'vigo.workspace_cleanup.preview.v1'
  project: {
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

type WorkspaceCleanupResult = {
  ok: boolean
  project: VigoProject
  workspace: WorkspaceCleanupPreview
  cleanup: {
    cleanedAt: string
    removedFileCount: number
    freedBytes: number
  }
}

const cleanupCategories: Array<{
  key: keyof WorkspaceCleanupPreview['categories']
  label: string
}> = [
  { key: 'timetables', label: 'Timetables' },
  { key: 'streets', label: 'Street index' },
  { key: 'activity', label: 'Jobs & evidence' },
  { key: 'other', label: 'Other managed data' },
]

export function WorkspaceCleanupControl({
  projects,
  defaultProjectId,
  onWorkspaceCleaned,
  onWorkspaceRemoved,
}: {
  projects: VigoProject[]
  defaultProjectId: string
  onWorkspaceCleaned: (project: VigoProject) => void
  onWorkspaceRemoved: (projectId: string) => Promise<boolean>
}) {
  const [targetProjectId, setTargetProjectId] = useState(defaultProjectId)
  const [preview, setPreview] = useState<WorkspaceCleanupPreview | null>(null)
  const [loading, setLoading] = useState(false)
  const [workingAction, setWorkingAction] = useState<'deep-clean' | 'remove' | null>(null)
  const [confirmationAction, setConfirmationAction] = useState<'deep-clean' | 'remove' | null>(null)
  const [confirmation, setConfirmation] = useState('')
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')

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
    setLoading(true)
    setError('')
    setStatus('')
    setConfirmationAction(null)
    setConfirmation('')
    apiJson<{ workspace: WorkspaceCleanupPreview }>(
      `/api/projects/${encodeURIComponent(targetProjectId)}/workspace-cleanup`,
    ).then((result) => {
      if (current) setPreview(result.workspace)
    }).catch((reason) => {
      if (current) {
        setPreview(null)
        setError(reason instanceof Error ? reason.message : 'Unable to inspect workspace storage.')
      }
    }).finally(() => {
      if (current) setLoading(false)
    })

    return () => {
      current = false
    }
  }, [targetProjectId])

  async function deepCleanWorkspace() {
    if (!preview || confirmationAction !== 'deep-clean' || confirmation !== preview.project.name || workingAction) return
    setWorkingAction('deep-clean')
    setError('')
    setStatus('')
    try {
      const result = await apiJson<WorkspaceCleanupResult>(
        `/api/projects/${encodeURIComponent(preview.project.id)}/workspace-cleanup`,
        {
          method: 'POST',
          body: JSON.stringify({ confirmation }),
        },
      )
      setPreview(result.workspace)
      setConfirmation('')
      setConfirmationAction(null)
      setStatus(
        result.cleanup.freedBytes > 0
          ? `${formatBytes(result.cleanup.freedBytes)} removed. ${result.project.name} is ready for a fresh import.`
          : `${result.project.name} is ready for a fresh import.`,
      )
      onWorkspaceCleaned(result.project)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to clean this workspace.')
    } finally {
      setWorkingAction(null)
    }
  }

  async function removeWorkspace() {
    if (!preview || confirmationAction !== 'remove' || confirmation !== preview.project.name || workingAction) return
    setWorkingAction('remove')
    setError('')
    setStatus('')
    try {
      const removed = await onWorkspaceRemoved(preview.project.id)
      if (!removed) {
        setError('The workspace was not removed.')
        return
      }
      setConfirmation('')
      setConfirmationAction(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to remove this workspace.')
    } finally {
      setWorkingAction(null)
    }
  }

  const canConfirm = Boolean(preview && confirmation === preview.project.name && !workingAction)

  return (
    <div className="workspace-cleanup-control">
      <label className="data-control-label" htmlFor="workspace-cleanup-target">
        <span>Workspace</span>
        <select
          id="workspace-cleanup-target"
          value={targetProjectId}
          onChange={(event) => setTargetProjectId(event.target.value)}
          disabled={loading || Boolean(workingAction) || !projects.length}
        >
          {projects.map((project) => (
            <option key={project.id} value={project.id}>{project.name}</option>
          ))}
        </select>
      </label>

      {loading ? (
        <div className="workspace-cleanup-loading" role="status">
          <HardDrive size={16} aria-hidden="true" />
          Measuring workspace data…
        </div>
      ) : preview ? (
        <>
          <div className="workspace-cleanup-overview" aria-label="Workspace cleanup impact">
            <div>
              <span>Managed data</span>
              <strong>{formatBytes(preview.managedBytes)}</strong>
            </div>
            <div>
              <span>Files to remove</span>
              <strong>{preview.fileCount.toLocaleString()}</strong>
            </div>
            <div>
              <span>Imported feeds</span>
              <strong>{preview.counts.feeds.toLocaleString()}</strong>
            </div>
          </div>

          <ul className="workspace-cleanup-breakdown" aria-label="Managed data breakdown">
            {cleanupCategories.map(({ key, label }) => (
              <li key={key}>
                <span>{label}</span>
                <strong>{formatBytes(preview.categories[key].bytes)}</strong>
              </li>
            ))}
          </ul>

          <div className="workspace-cleanup-action">
            <span>
              <strong>Deep clean workspace</strong>
              <small>
                Removes every VIGO-managed timetable, street index, job, artifact, and staging file.
                The workspace identity and files outside its hidden .vigo folder stay in place.
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
              {preview.hasData ? 'Deep clean…' : 'Already clean'}
            </button>
          </div>

          <div className="workspace-cleanup-action workspace-remove-action">
            <span>
              <strong>Remove workspace</strong>
              <small>
                Deletes this workspace from the local Library, including its identity, managed data, and files inside its workspace folder.
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
              Remove workspace…
            </button>
          </div>

          {preview.activeImport ? (
            <p className="workspace-cleanup-note">An import is active. Cleanup unlocks when it finishes.</p>
          ) : null}

          {confirmationAction ? (
            <div
              className="workspace-cleanup-confirm"
              role="group"
              aria-label={`Confirm ${confirmationAction === 'remove' ? 'workspace removal' : 'workspace deep clean'}`}
            >
              <ShieldAlert size={18} aria-hidden="true" />
              <div>
                <strong>This cannot be undone</strong>
                <span>
                  Type <b>{preview.project.name}</b> to {confirmationAction === 'remove'
                    ? 'delete this workspace from the local Library.'
                    : 'remove all VIGO-managed data from this workspace.'}
                </span>
                <input
                  aria-label="Workspace name confirmation"
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                  autoFocus
                  autoComplete="off"
                  spellCheck={false}
                  disabled={Boolean(workingAction)}
                />
              </div>
              <div className="workspace-cleanup-confirm-actions">
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
                  onClick={() => void (confirmationAction === 'remove' ? removeWorkspace() : deepCleanWorkspace())}
                >
                  {workingAction === 'remove'
                    ? 'Removing…'
                    : workingAction === 'deep-clean'
                      ? 'Cleaning…'
                      : confirmationAction === 'remove' ? 'Remove workspace' : 'Deep clean workspace'}
                </button>
              </div>
            </div>
          ) : null}
        </>
      ) : null}

      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {status ? <p className="workspace-cleanup-status" role="status">{status}</p> : null}
    </div>
  )
}
