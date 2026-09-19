import { useEffect, useRef } from 'react'
import { Activity, AlertCircle, CheckCircle2, Clock3, LoaderCircle, X } from 'lucide-react'
import { isActiveTask, taskPercent, type PreparationTask } from '../app/preparation'

export function BackgroundTasks({ tasks, open, onOpenChange, onOpenData, onReconnect }: {
  tasks: PreparationTask[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onOpenData: () => void
  onReconnect: (task: PreparationTask) => void
}) {
  const container = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const active = tasks.filter(isActiveTask)
  const attention = tasks.some((task) => task.status === 'failed' || task.statusError)
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) onOpenChange(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { onOpenChange(false); trigger.current?.focus() }
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape) }
  }, [open, onOpenChange])
  return (
    <div className="background-tasks" ref={container}>
      <button ref={trigger} type="button" className="background-tasks-trigger" aria-expanded={open} aria-controls="background-task-list" aria-label={`Background tasks${active.length ? `, ${active.length} active` : attention ? ', needs attention' : ''}`} onClick={() => onOpenChange(!open)}>
        {attention ? <AlertCircle size={15} /> : active.length ? <LoaderCircle size={15} className="task-spinner" /> : <Activity size={15} />}
        <span>{active.length ? 'Preparing data' : 'Background tasks'}</span>
        {active.length ? <b>{active.length}</b> : null}
      </button>
      {open ? (
        <section id="background-task-list" className="background-tasks-panel" aria-label="Background tasks">
          <header><strong>Background tasks</strong><button type="button" aria-label="Close background tasks" onClick={() => { onOpenChange(false); trigger.current?.focus() }}><X size={15} /></button></header>
          <p>Data preparation continues while you use other views.</p>
          {!tasks.length ? <p>No data preparation tasks yet. Add GTFS schedules and OSM streets in City.</p> : (
            <ul>{tasks.map((task) => {
              const working = isActiveTask(task)
              const percent = taskPercent(task)
              const status = task.statusError ? 'Updates paused' : task.status === 'complete' ? 'Complete' : task.status === 'failed' ? 'Failed' : task.status === 'cancelled' ? 'Cancelled' : task.status === 'queued' ? 'Queued' : 'Processing'
              return <li key={task.id} className={`background-task ${task.status === 'failed' ? 'is-failed' : task.status === 'complete' ? 'is-complete' : ''}`}>
                <div className="background-task-heading">
                  {task.statusError || task.status === 'failed' ? <AlertCircle size={16} /> : task.status === 'complete' ? <CheckCircle2 size={16} /> : working ? <LoaderCircle size={16} className="task-spinner" /> : <Clock3 size={16} />}
                  <strong>{task.kind === 'vehicle-schedules' ? 'Static vehicle schedules' : task.kind === 'street-runtime-prepare' ? 'Walking and driving' : task.kind === 'city-data-load' ? 'Loading City' : task.kind === 'national-osm-import' ? 'OSM street networks' : task.kind === 'national-gtfs-merge' ? 'Combining transit feeds' : 'GTFS schedules'}</strong>
                  <span>{status}{working && !task.statusError && percent !== undefined ? ` · ${percent}%` : ''}</span>
                </div>
                <small className="background-task-source">{task.label}</small>
                <p>{task.statusError || task.error || task.phase || status}</p>
                {working && !task.statusError ? <progress max={100} value={percent} aria-label={`${task.label} preparation progress`} /> : null}
                {task.detail && task.detail !== task.error ? <small>{task.detail}</small> : null}
                {task.statusError ? <button type="button" onClick={() => onReconnect(task)}>Reconnect to task</button> : null}
                {!task.statusError && ['street-runtime-prepare', 'vehicle-schedules'].includes(task.kind) && task.status === 'failed' ? <button type="button" onClick={() => onReconnect(task)}>Retry preparation</button> : null}
              </li>
            })}</ul>
          )}
          <button type="button" className="background-tasks-data" onClick={() => { onOpenChange(false); onOpenData() }}>Open City data</button>
        </section>
      ) : null}
    </div>
  )
}
