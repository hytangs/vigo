import { AttributionControl, NavigationControl, type Map } from './mapRuntime'

export function addMapControls(map: Map) {
  map.addControl(new NavigationControl({ visualizePitch: true }), 'top-left')
  map.addControl(new AttributionControl({ compact: true }), 'bottom-left')
}
