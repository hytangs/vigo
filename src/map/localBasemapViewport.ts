export type LocalBasemapViewport = { west: number; south: number; east: number; north: number; zoom: number }

export function localBasemapViewport(
  view: LocalBasemapViewport,
  previous: LocalBasemapViewport | null,
): LocalBasemapViewport | null {
  // MapLibre can pan into a repeated world. Query the canonical longitudes;
  // the renderer places the returned geometry in the visible world copy.
  const offset = Math.floor(((view.west + view.east) / 2 + 180) / 360) * 360
  view = { ...view, west: view.west - offset, east: view.east - offset }
  if (view.west < -180 || view.east > 180) view = { ...view, west: -180, east: 180 }
  const zoom = Math.max(0, Math.min(22, Math.floor(view.zoom)))
  if (previous && previous.zoom === zoom && previous.west <= view.west && previous.east >= view.east
    && previous.south <= view.south && previous.north >= view.north) return null
  const lonPad = (view.east - view.west) * 0.18
  const latPad = (view.north - view.south) * 0.18
  return {
    west: Math.max(-180, view.west - lonPad), east: Math.min(180, view.east + lonPad),
    south: Math.max(-85.051129, view.south - latPad), north: Math.min(85.051129, view.north + latPad), zoom,
  }
}
