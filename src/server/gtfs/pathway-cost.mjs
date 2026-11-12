// Optional GTFS pathway fields describe different kinds of movement. A stair
// count is usable routing input even when horizontal length is unavailable.
// These are explicit model assumptions, never published traversal times.
export const pathwayCostModel = Object.freeze({
  id: 'stairs-one-second-per-step-gates-five-seconds-v1',
  secondsPerStair: 1,
  gateSeconds: 5,
})
