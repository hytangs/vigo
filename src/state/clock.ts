import { localCalendarDate, serviceDayForCalendarDate } from '../app/routingPlan'
import { createStore } from '../app/store'
import { route } from './route'

const initialClock = () => ({
  scheduleTimeMinutes: 8 * 60,
  serviceDate: localCalendarDate(),
})

/**
 * The service clock shared by Network, Route and Analyze: the scheduled time
 * of day and the calendar date whose timetable every workspace reads.
 */
export const clock = createStore(initialClock())

export const resetClock = () => clock.set(initialClock())

export const serviceDay = () => serviceDayForCalendarDate(clock.get().serviceDate)

export const setScheduleTime = (scheduleTimeMinutes: number) => clock.set({ scheduleTimeMinutes })

export function changeServiceDate(serviceDate: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(serviceDate)) return
  try {
    serviceDayForCalendarDate(serviceDate)
  } catch {
    return
  }
  clock.set({ serviceDate })
  route.set({ selectedRoutingPlanId: '' })
}
