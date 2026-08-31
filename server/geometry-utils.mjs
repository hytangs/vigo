function radians(degrees) {
  return degrees * Math.PI / 180
}

function haversineCoordinateKm(leftLon, leftLat, rightLon, rightLat) {
  const dLat = radians(rightLat - leftLat)
  const dLon = radians(rightLon - leftLon)
  const latitude1 = radians(leftLat)
  const latitude2 = radians(rightLat)
  const value = Math.sin(dLat / 2) ** 2
    + Math.cos(latitude1) * Math.cos(latitude2) * Math.sin(dLon / 2) ** 2
  return 6371.0088 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value))
}

export function haversineKm(left, right) {
  return haversineCoordinateKm(left[0], left[1], right[0], right[1])
}

export function lineDistanceKm(coordinates) {
  let distanceKm = 0
  for (let index = 1; index < coordinates.length; index += 1) {
    distanceKm += haversineKm(coordinates[index - 1], coordinates[index])
  }
  return distanceKm
}

export function appendDistinctCoordinates(left, right) {
  const coordinates = []
  for (const coordinate of [...(left ?? []), ...(right ?? [])]) {
    const previous = coordinates.at(-1)
    if (!previous || previous[0] !== coordinate[0] || previous[1] !== coordinate[1]) coordinates.push(coordinate)
  }
  return coordinates
}
