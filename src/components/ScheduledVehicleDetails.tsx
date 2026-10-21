import { Clock3 } from 'lucide-react'
import type { ServiceVehicleCard } from '../serviceVehicles'

/** Timetable estimates stay separate from reported vehicle observations. */
export function ScheduledVehicleDetails({ card, active }: { card: ServiceVehicleCard; active: boolean }) {
  const schedule = card.schedule!
  const progress = Math.max(0, Math.min(100, Math.round(schedule.progress * 100)))
  return <section className="scheduled-vehicle-detail" aria-label={`${card.title} scheduled trip`}>
    <header>
      <span className="scheduled-vehicle-source"><Clock3 size={12} aria-hidden="true" />Schedule estimate</span>
      <h3>{card.title}</h3>
      <p className="scheduled-vehicle-destination">To <strong>{card.journey.destination}</strong></p>
    </header>
    {active ? <>
      <div className="scheduled-vehicle-call">
        <div><span>Next stop</span><strong>{card.journey.nextStop}</strong></div>
        <div><span>Scheduled</span><time>{card.journey.arrival}</time></div>
      </div>
      <p className="scheduled-vehicle-state">{schedule.stateLabel}</p>
      <div className="scheduled-vehicle-progress">
        <div><span>Trip progress</span><strong>{progress}%</strong></div>
        <progress max={100} value={progress} aria-label="Scheduled trip progress" />
        <div><span>{Math.round(schedule.elapsedMinutes)} min elapsed</span><span>{Math.round(schedule.runtimeMinutes)} min total</span></div>
      </div>
    </> : <p className="scheduled-vehicle-inactive" role="status">This trip is not active at the selected time. Choose another vehicle or move the clock back.</p>}
  </section>
}
