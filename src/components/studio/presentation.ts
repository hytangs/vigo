import { formatNumber } from '../../domain'
import { scheduledVehicleDiagnostics } from '../../scheduledVehicles'

export type MapScope = 'network' | 'route'

export function quietMapLabel(value: string) {
  return value
    .replace(/\bGTFS[-\s]*/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim() || value
}

export function liveVehicleDiagnostics(vehicleCount: number, connected = false): ReturnType<typeof scheduledVehicleDiagnostics> {
  return {
    tone: vehicleCount > 0 ? 'good' : connected ? 'watch' : 'empty',
    title: vehicleCount > 0 ? `${formatNumber(vehicleCount)} live vehicles` : connected ? 'Live · 0 positions' : 'Live layer idle',
    detail: vehicleCount > 0
      ? `Rendering all ${formatNumber(vehicleCount)} positioned GTFS-RT vehicles in the live service frame.`
      : connected
        ? 'The Vehicle Positions feed returned no valid coordinates. The live frame stays empty and explicit.'
        : 'No live vehicle positions are being rendered.',
  }
}
