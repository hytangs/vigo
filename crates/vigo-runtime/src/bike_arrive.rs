// Arrival point queries share the forward turn-aware hierarchy.
use super::*;

impl BikeKernel {
    #[cfg(any(feature = "node", test))]
    #[expect(
        clippy::too_many_arguments,
        reason = "Keep routing bounds and attachment policy explicit at the search boundary."
    )]
    pub fn route_arrive_at(
        &self,
        origin: [f64; 2],
        destination: [f64; 2],
        opt: BikeOptions,
        max_walk: f64,
        walk_speed: f64,
        max_distance: f64,
        clock: Option<BikeClock>,
    ) -> Result<BikeResult, String> {
        self.route_arrive_limited(
            origin,
            destination,
            opt,
            max_walk,
            walk_speed,
            max_distance,
            clock,
            None,
        )
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "Keep routing bounds and attachment policy explicit at the search boundary."
    )]
    pub fn route_arrive_limited(
        &self,
        origin: [f64; 2],
        destination: [f64; 2],
        opt: BikeOptions,
        max_walk: f64,
        walk_speed: f64,
        max_distance: f64,
        clock: Option<BikeClock>,
        max_elapsed: Option<f64>,
    ) -> Result<BikeResult, String> {
        if max_elapsed.is_some_and(|seconds| !seconds.is_finite() || seconds < 0.) {
            return Err("Invalid bicycle arrival horizon".into());
        }
        surface::hierarchy::point::route(
            self,
            origin,
            destination,
            opt,
            max_walk,
            walk_speed,
            max_distance,
            clock,
            true,
            max_elapsed,
        )
    }
}
