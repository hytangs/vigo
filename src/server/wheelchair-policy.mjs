// This profile describes source constraints, not a survey or live facility check.
// The profile fixes transit semantics: unknown vehicle and boarding
// accessibility is excluded. Street evidence is chosen at preparation:
// `inferred` can use ordinary pedestrian ways without a surface or wheelchair tag;
// `verified` uses only ways tagged wheelchair=yes, which is sparse in most cities.
export const wheelchairProfile = 'wheelchair-strict-v1'
const wheelchairStreetPolicies = Object.freeze({
  inferred: 'inferred-step-free-v1',
  verified: 'wheelchair-yes-only',
})
export function wheelchairStreetPolicy(value = 'inferred') {
  if (!Object.hasOwn(wheelchairStreetPolicies, value)) throw new Error('--wheelchair-streets must be inferred or verified')
  return value
}
export function wheelchairDescriptionFor(streets = 'inferred') {
  wheelchairStreetPolicy(streets)
  return Object.freeze({
    profile: wheelchairProfile, unknownData: 'exclude',
    streetEvidence: wheelchairStreetPolicies[streets],
    stationPaths: 'published-wheelchair-time-or-dimensioned-step-free',
    fareGates: 'accessible-endpoints-with-published-time-or-five-second-estimate',
    sameLevelWalkways: 'zero-wheelchair-length-with-published-walk-length-and-accessible-endpoints',
    minimumWidthMeters: 0.9, maximumSlope: 0.083,
    limitations: Object.freeze([
      'Unknown vehicle and boarding accessibility is excluded; coverage may be sparse.',
      'Fare gates between accessible nodes use published crossing time or a five-second estimate.',
      'Same-level walkways with accessible endpoints and a zero wheelchair length use their positive published walk length.',
      streets === 'verified'
        ? 'Unknown street accessibility is excluded; only ways tagged wheelchair=yes are used.'
        : 'Inferred streets can lack wheelchair or surface tags. An explicit wheelchair=yes overrides surface and trail filters; mapped dimensions and some barriers are still checked.',
      'Coordinate attachments are geometric; door-to-street access is not verified.',
      'Elevator outages, temporary obstructions and individual chair dimensions are not modeled.',
    ]),
  })
}
export function validateWheelchairRequest(profile, request) {
  if (request.wheelchair !== undefined && typeof request.wheelchair !== 'boolean') throw new Error('wheelchair must be boolean')
  if (request.wheelchairAccessible !== undefined) throw new Error('Use wheelchair, not wheelchairAccessible')
  const active = profile === wheelchairProfile
  if (request.wheelchair === true && !active) throw new Error('Wheelchair routing requires a City built with --wheelchair')
  if (!active) return
  if (request.scenario != null) throw new Error('Wheelchair routing requires a prepared City; query-time scenario accessibility is not modeled')
  if (request.wheelchair === false) throw new Error('This wheelchair City cannot provide unrestricted routes')
  if (request.mode === 'drive' || request.mode === 'bike') throw new Error('Wheelchair routing supports transit and walk')
  if ((request.routingDataMode ?? request.dataMode ?? 'scheduled') !== 'scheduled') throw new Error('Wheelchair routing currently requires scheduled service; live accessibility changes are not modeled')
}
