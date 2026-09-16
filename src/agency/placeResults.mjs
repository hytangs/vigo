export function placeMapLocation(place) {
  if (place?.kind !== 'place' || !Number.isFinite(place.lat) || !Number.isFinite(place.lon)
    || Math.abs(place.lat) > 90 || Math.abs(place.lon) > 180) return null
  return { id: place.id, label: place.label || place.name, coordinate: [place.lon, place.lat] }
}

export function retainedPlaces(trace) {
  const seen = new Set()
  return trace.flatMap((call, index) => {
    if (call.tool !== 'place_search' || !call.result.ok) return []
    return (call.result.data?.matches || []).filter(place => {
      if (!placeMapLocation(place) || seen.has(place.id)) return false
      seen.add(place.id)
      return true
    }).map(place => ({ ...place, source: index + 1 }))
  })
}

export function placeEvidenceText(trace) {
  const places = retainedPlaces(trace)
  if (!places.length) return ''
  return `Place search returned ${places.length === 1 ? 'this location' : 'these locations; choose the intended match'}:\n\n${places.map(place => `${place.name}${place.address ? ` — ${place.address}` : ''}; latitude ${place.lat}, longitude ${place.lon}. [${place.source}]`).join('\n\n')}`
}
