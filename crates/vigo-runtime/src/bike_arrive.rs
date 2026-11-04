//! Dated arrival search on the shared forward graph. A certificate
//! must replay the entire forward turn history, including conditional only_*
//! alternatives; reversing a list of edges does not prove legal movement.
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
        self.validate_request(
            origin,
            destination,
            opt,
            max_walk,
            walk_speed,
            max_distance,
            clock,
        )?;
        let Some(clock) = clock.filter(|_| self.has_timing()) else {
            return self.route_at(
                origin,
                destination,
                opt,
                max_walk,
                walk_speed,
                max_distance,
                None,
            );
        };
        let graph = self.graph();
        let eligible = |edge| self.allowed_edge(edge, opt);
        let mut starts = self.attach_bicycle_matching(
            &graph,
            origin,
            max_walk,
            walk_speed / 3.6,
            true,
            false,
            &eligible,
        )?;
        let mut ends = self.attach_bicycle_matching(
            &graph,
            destination,
            max_walk,
            walk_speed / 3.6,
            false,
            false,
            &eligible,
        )?;
        let solve = |starts: &Attachment, ends: &Attachment, kind: SearchKind<'_>| {
            let mut result = self.search_with_limit(
                origin,
                destination,
                opt,
                starts,
                ends,
                max_distance,
                Some(clock),
                kind,
                SearchBounds::default(),
                None,
                false,
            )?;
            if result.status == "ready"
                && max_elapsed.is_some_and(|limit| result.elapsed_seconds() > limit)
            {
                result.temporal_valid = false;
            }
            Ok::<_, String>(result)
        };
        let verified = |mut result: BikeResult, work| {
            result.settled_labels = work;
            result.timing_policy = "dated_arrive_by_verified";
            result
        };
        let mut scope = vec![None; self.windows.schedules.len() + 1];
        scope[0] = Some(true);
        let first = solve(&starts, &ends, SearchKind::ArriveScoped(&scope))?;
        let mut work = first.settled_labels;
        if first.status == "ready" && first.temporal_valid {
            return Ok(verified(first, work));
        }
        // As in departure routing, a timed-invalid nearest path authorizes
        // wider endpoint matching. This is query-local compact scratch.
        let wider = self
            .attach_bicycle_fallback(&graph, origin, max_walk, walk_speed / 3.6, true, &eligible)
            .and_then(|a| {
                self.attach_bicycle_fallback(
                    &graph,
                    destination,
                    max_walk,
                    walk_speed / 3.6,
                    false,
                    &eligible,
                )
                .map(|b| (a, b))
            });
        let fallback = |starts: &Attachment, ends: &Attachment| -> Result<BikeResult, String> {
            let mut candidate = solve(starts, ends, SearchKind::ArriveConservative)?;
            candidate.timing_policy = "conservative_arrive_by";
            if !candidate.temporal_valid {
                // All-active only-turn alternatives are not necessarily legal
                // at a dated instant. They cannot establish a feasible bound.
                candidate.status = "blocked";
                candidate.reason = Some("arrive_by_unverified");
                candidate.cost = None;
                candidate.legs.clear();
            }
            Ok(candidate)
        };
        let (wider_starts, wider_ends) = wider?;
        if wider_starts.candidates.len() != starts.candidates.len()
            || wider_ends.candidates.len() != ends.candidates.len()
        {
            starts = wider_starts;
            ends = wider_ends;
            let relaxed = solve(&starts, &ends, SearchKind::ArriveScoped(&scope))?;
            work += relaxed.settled_labels;
            if relaxed.temporal_valid {
                // Exhaustion on this fully relaxed, full-radius graph also
                // proves no dated route exists under the requested constraints.
                return Ok(verified(relaxed, work));
            }
        } else if first.temporal_valid {
            return Ok(verified(first, work));
        }
        let mut candidate = fallback(&starts, &ends)?;
        work += candidate.settled_labels;
        candidate.timing_policy = "conservative_arrive_by";
        let snapshot = solve(
            &starts,
            &ends,
            SearchKind::ArriveScoped(&self.windows.scope_before(clock, 0.)),
        )?;
        work += snapshot.settled_labels;
        if snapshot.status == "ready"
            && snapshot.temporal_valid
            && snapshot.cost.unwrap() < candidate.cost.unwrap_or(f64::INFINITY)
        {
            candidate = snapshot;
            candidate.timing_policy = "dated_arrive_by_feasible";
        }
        if let Some(upper) = candidate.cost.filter(|_| candidate.status == "ready") {
            let factor = if matches!(opt.profile, Profile::Fast) {
                1.
            } else {
                0.8
            };
            // Every route cheaper than this feasible candidate fits inside
            // the backwards horizon because cost >= factor * physical time.
            let scoped = solve(
                &starts,
                &ends,
                SearchKind::ArriveScoped(
                    &self
                        .windows
                        .scope_before(clock, upper / factor * (1. + 1e-12)),
                ),
            )?;
            work += scoped.settled_labels;
            if scoped.status == "ready" && scoped.temporal_valid && scoped.cost.unwrap() <= upper {
                return Ok(verified(scoped, work));
            }
        }
        if candidate.status != "ready" && max_elapsed.is_none() {
            candidate = self.arrival_bound(
                origin,
                destination,
                opt,
                &starts,
                &ends,
                max_distance,
                clock,
            )?;
            work += candidate.settled_labels;
        }
        candidate.settled_labels = work;
        self.arrival_profile(
            origin,
            destination,
            opt,
            &starts,
            &ends,
            max_distance,
            clock,
            candidate,
            max_elapsed,
        )
    }

    // Find a finite bound without treating a work limit as proof of no route.
    // Earliest-arrival search keeps the forward conditional-turn automaton.
    // Moving its departure back establishes a legal route before the deadline;
    // only then may cost bound the exact departure-profile horizon.
    #[expect(
        clippy::too_many_arguments,
        reason = "Keep routing bounds and attachment policy explicit at the search boundary."
    )]
    fn arrival_bound(
        &self,
        origin: [f64; 2],
        destination: [f64; 2],
        opt: BikeOptions,
        starts: &Attachment,
        ends: &Attachment,
        max_distance: f64,
        clock: BikeClock,
    ) -> Result<BikeResult, String> {
        let factor = if matches!(opt.profile, Profile::Fast) {
            1.
        } else {
            0.8
        };
        let mut lookback = 0.;
        let mut work = 0;
        for _ in 0..32 {
            let departure = BikeClock {
                epoch: clock.epoch - lookback,
                ..clock
            };
            if chrono::DateTime::from_timestamp(departure.epoch.floor() as i64, 0).is_none() {
                return Err("Bicycle arrival bound exceeded the supported calendar range".into());
            }
            let mut result = self.search_with_limit(
                origin,
                destination,
                opt,
                starts,
                ends,
                max_distance,
                Some(departure),
                SearchKind::Earliest,
                SearchBounds::default(),
                None,
                false,
            )?;
            work += result.settled_labels;
            if result.status != "ready" {
                return Err(
                    "Bicycle arrival search could not establish a feasible temporal bound".into(),
                );
            }
            let duration = result.elapsed_seconds();
            if duration <= lookback {
                result.end_wait_seconds = lookback - duration;
                result.cost = result
                    .cost
                    .map(|cost| cost + factor * result.end_wait_seconds);
                result.settled_labels = work;
                return Ok(result);
            }
            if work >= 262_144 {
                break;
            }
            lookback = (lookback * 2.).max(duration) + 1e-6;
        }
        Err("Bicycle arrival search exceeded its feasible-bound work limit".into())
    }
}
