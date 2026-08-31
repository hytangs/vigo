import { HardDrive, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { apiJson } from '../app/api'
import { requestNativeWebCacheCleanup } from '../app/nativeBridge'
import { formatBytes } from '../app/presentation'

type CacheMaintenancePreview = {
  schemaVersion: 'vigo.cache_maintenance.preview.v1'
  automatic: boolean
  estimatedFreedBytes: number
  fileCount: number
  memory: {
    entries: number
    estimatedBytes: number
  }
  disk: {
    staging: {
      bytes: number
      fileCount: number
    }
    projectCount: number
    skippedActiveProjectIds: string[]
  }
  preserved: string[]
}

type CacheMaintenanceResult = {
  schemaVersion: 'vigo.cache_maintenance.result.v1'
  reason: 'manual' | 'automatic-startup'
  cleanedAt: string
  freedBytes: number
  removedFileCount: number
  removedMemoryEntries: number
  skippedActiveProjectIds: string[]
  cache: CacheMaintenancePreview
}

export function CacheMaintenanceControl({
  automatic,
  disabled,
  onAutomaticChange,
}: {
  automatic: boolean
  disabled: boolean
  onAutomaticChange: (enabled: boolean) => void
}) {
  const [preview, setPreview] = useState<CacheMaintenancePreview | null>(null)
  const [loading, setLoading] = useState(true)
  const [cleaning, setCleaning] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')

  useEffect(() => {
    let current = true
    setLoading(true)
    apiJson<{ cache: CacheMaintenancePreview }>('/api/cache-maintenance')
      .then((result) => {
        if (current) setPreview(result.cache)
      })
      .catch((reason) => {
        if (current) setError(reason instanceof Error ? reason.message : 'Unable to inspect cache usage.')
      })
      .finally(() => {
        if (current) setLoading(false)
      })
    return () => {
      current = false
    }
  }, [])

  async function cleanNow() {
    if (cleaning) return
    setCleaning(true)
    setError('')
    setStatus('')
    try {
      const [result, webCacheCleaned] = await Promise.all([
        apiJson<CacheMaintenanceResult>('/api/cache-maintenance', {
          method: 'POST',
          body: JSON.stringify({}),
        }),
        requestNativeWebCacheCleanup(),
      ])
      setPreview(result.cache)
      const removed = result.freedBytes > 0 || result.removedFileCount > 0 || result.removedMemoryEntries > 0
      const summary = removed
        ? `${formatBytes(result.freedBytes)} and ${result.removedMemoryEntries.toLocaleString()} memory entries cleared.`
        : 'No regenerable VIGO cache was waiting.'
      setStatus(`${summary}${webCacheCleaned ? ' Desktop web cache cleared.' : ''}`)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to clean the application cache.')
    } finally {
      setCleaning(false)
    }
  }

  return (
    <div className="cache-maintenance-control">
      <div className="data-setting-row">
        <span>
          <strong>Automatic cache cleanup</strong>
          <small>Clear abandoned import staging and desktop web caches when VIGO starts.</small>
        </span>
        <label className="data-cache-switch">
          <input
            type="checkbox"
            checked={automatic}
            disabled={disabled || cleaning}
            onChange={(event) => onAutomaticChange(event.target.checked)}
          />
          <span aria-hidden="true" />
          <b>{automatic ? 'On' : 'Off'}</b>
        </label>
      </div>

      <div className="data-setting-row">
        <span>
          <strong>Application cache</strong>
          <small>Route responses, analysis lookups, abandoned staging, and WebKit disk/memory cache.</small>
        </span>
        <button
          type="button"
          className="button button-secondary data-cache-clean-button"
          disabled={disabled || loading || cleaning}
          onClick={() => void cleanNow()}
        >
          <RefreshCw size={15} aria-hidden="true" className={cleaning ? 'is-spinning' : undefined} />
          {cleaning ? 'Cleaning…' : 'Clean now'}
        </button>
      </div>

      <div className="data-cache-summary" aria-live="polite">
        <HardDrive size={15} aria-hidden="true" />
        {loading ? (
          <span>Measuring regenerable cache…</span>
        ) : preview ? (
          <span>
            {formatBytes(preview.estimatedFreedBytes)} reclaimable · {preview.fileCount.toLocaleString()} staging files · {preview.memory.entries.toLocaleString()} memory entries
          </span>
        ) : (
          <span>Cache usage unavailable.</span>
        )}
      </div>

      <p className="data-system-note">
        Projects, GTFS timetables, OSM street indexes, jobs, evidence, and user files are always preserved.
      </p>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {status ? <p className="workspace-cleanup-status" role="status">{status}</p> : null}
    </div>
  )
}
