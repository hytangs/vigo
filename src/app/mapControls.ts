import { AttributionControl, type Map } from './mapRuntime'

export function addMapControls(map: Map) {
  map.addControl(new AttributionControl({ compact: true }), 'bottom-left')
}
