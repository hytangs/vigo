# Reach

Reach computes where the represented network can travel within stated time limits.

VIGO 0.3 Reach uses scheduled transit with walking access and egress. Walk-only and Drive Reach are unavailable.

A Reach Query includes an origin, date, departure time, walking assumptions, time cutoffs, and computation extent. `extentRadiusKm` limits the area computed around the origin; it is not a display-only option. A Reach Result contains the computed travel-time surface and contours. VIGO Studio can also show reached streets.

Reach is not an opportunity-weighted measure. It does not by itself measure jobs, people, schools, healthcare, demand, welfare, or observed behavior.
