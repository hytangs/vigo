//! Query-local lower-bound tree for one-to-many bicycle times. A tree path is
//! used only after proving it satisfies the point router's access and timing
//! policy. Uncertified targets use the existing exact router on the same graph.
use super::*;

// Label, start attachment, end attachment, cost, tied.
type FieldCandidate = (Option<usize>, usize, usize, f64, bool);

// A dense node lookup is smaller than sparse hash entries once a regional
// query reaches hundreds of thousands of ordinary nodes. Bound both the lookup
// and label arena by resident memory, rather than by the City's node count.
pub(super) fn field_node_slots(nodes: usize) -> usize {
    if nodes <= crate::resources::cache_budget(64 * 1024 * 1024, 128) / 4 {
        nodes
    } else {
        0
    }
}
pub(super) fn field_label_limit() -> usize {
    // Includes frontier, queue and turn-state overhead, not just FieldLabel.
    crate::resources::cache_budget(128 * 1024 * 1024, 16) / 128
}

pub(crate) struct BikeManyResult {
    pub seconds: Vec<f64>,
    // Matrix requests need distance as well; Reach allocates no second output.
    pub meters: Vec<f64>,
    pub settled_labels: usize,
    pub certified_targets: usize,
    pub fallback_targets: usize,
    pub tree_limited: bool,
    pub fallback_reasons: std::collections::BTreeMap<&'static str, usize>,
    pub scoped_trees: usize,
    pub attachment_certificates: usize,
    pub access_groups: usize,
    pub access_group_key_bytes: usize,
    pub access_group_limit_targets: usize,
}

impl BikeManyResult {
    pub(super) fn record(&mut self, index: usize, seconds: f64, meters: f64, cutoff: f64) {
        if seconds <= cutoff {
            self.seconds[index] = seconds;
            if !self.meters.is_empty() {
                self.meters[index] = meters;
            }
        }
    }
}

// Fields replay selected paths for distance, so they do not need the point
// router's distance accumulator. Edge and parent ids use the same absent-id
// sentinel as the CSR links; valid edges and bounded label ids are below it.
#[derive(Clone, Copy)]
struct FieldLabel {
    node: u32,
    incoming: u32,
    state: u32,
    cost: f64,
    parent: u32,
    start: u32,
    active: bool,
}
impl FieldLabel {
    fn incoming(&self) -> Option<u32> {
        (self.incoming != u32::MAX).then_some(self.incoming)
    }
}

struct Field {
    starts: Attachment,
    start_edges: Vec<u32>,
    labels: Vec<FieldLabel>,
    direct: Vec<u32>,
    special: HashMap<u32, Vec<usize>>,
    certified_cost: f64,
    settled: usize,
    limited: bool,
    access: Option<HashSet<u32>>,
    states: Vec<TurnState>,
    scope: Option<Vec<Option<bool>>>,
    // Only Matrix needs provenance ties for its additional distance metric.
    ties: Vec<bool>,
    distances: bool,
}

// One stack-local field per request; boxing would add a heap allocation.
#[expect(
    clippy::large_enum_variant,
    reason = "This is a single query-local value, not an array of variants."
)]
enum ExtendedField {
    Wider(Field),
    Unavailable,
}

impl BikeKernel {
    /// Same preference optimum and physical-duration policy as point routing.
    /// No target paths, graph copies, or field survive beyond this request.
    #[cfg(any(feature = "standalone", test))]
    #[expect(
        clippy::too_many_arguments,
        reason = "Keep routing bounds and attachment policy explicit at the search boundary."
    )]
    pub(crate) fn many_from(
        &self,
        origin: [f64; 2],
        targets: &[[f64; 2]],
        opt: BikeOptions,
        max_walk: f64,
        walk_speed: f64,
        max_distance: f64,
        clock: Option<BikeClock>,
        maximum_seconds: f64,
    ) -> Result<BikeManyResult, String> {
        self.many_from_metrics(
            origin,
            targets,
            opt,
            max_walk,
            walk_speed,
            max_distance,
            clock,
            maximum_seconds,
            false,
        )
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "Keep routing bounds and attachment policy explicit at the search boundary."
    )]
    pub(crate) fn many_from_metrics(
        &self,
        origin: [f64; 2],
        targets: &[[f64; 2]],
        opt: BikeOptions,
        max_walk: f64,
        walk_speed: f64,
        max_distance: f64,
        clock: Option<BikeClock>,
        maximum_seconds: f64,
        distances: bool,
    ) -> Result<BikeManyResult, String> {
        opt.validate()?;
        if opt.max_lts.is_some() && !self.stress_prepared {
            return Err("Bicycle traffic stress is not prepared in this City; rebuild from OSM to use bike.maxLts".into());
        }
        if std::iter::once(&origin).chain(targets).any(|p| {
            !p[0].is_finite() || !p[1].is_finite() || p[0].abs() > 180. || p[1].abs() > 90.
        }) || !max_walk.is_finite()
            || max_walk < 0.
            || !walk_speed.is_finite()
            || walk_speed <= 0.
            || !max_distance.is_finite()
            || max_distance <= 0.
            || !maximum_seconds.is_finite()
            || maximum_seconds <= 0.
            || clock.is_some_and(|c| !c.epoch.is_finite())
        {
            return Err("Invalid bicycle routing coordinates or limits".into());
        }
        let graph = self.graph();
        let eligible = |edge| {
            self.allowed_edge(edge, opt)
                && (clock.is_some() || self.attributes[edge as usize] & TIMED_EDGE == 0)
        };
        let starts = self.attach_bicycle_matching(
            &graph,
            origin,
            max_walk,
            walk_speed / 3.6,
            true,
            false,
            &eligible,
        )?;
        // Any path taking <= T physical seconds costs <= T * max(cost/time).
        // Include endpoint walking (ratio 1) and waiting (ratio <= 1).
        let ratio = (0..self.targets.len()).fold(1f64, |max, edge| {
            let (seconds, cost) = self.metric(edge as u32, opt);
            max.max(cost / seconds)
        });
        let ceiling = maximum_seconds * ratio * (1. + 1e-12);
        // Legacy nearest-road attachments need a complete primary relaxation.
        // A cutoff-truncated tree cannot prove that the primary attachment has
        // no path: a longer primary route would prevent the point router from
        // trying a nearer-in-time road farther from the endpoint.
        // Network walking can reach many endpoint-only road components. A
        // single all-access lower bound avoids rebuilding the same bicycle
        // search for each of them. Replay below certifies only paths whose
        // restricted roads belong to the actual endpoint permission set.
        // With network walking, both point-router passes use the same complete
        // attachments. No path below the cost ceiling proves no result within
        // the physical cutoff; exhausting the whole regional graph is needless
        // and can hit the label limit, forcing thousands of exact searches.
        let primary_ceiling = if self.walking.is_some() {
            ceiling
        } else {
            f64::INFINITY
        };
        // Every path below this cost ceiling lasts at most cost/min_factor.
        // Enforce permissions fixed throughout that horizon in the shared
        // search, rather than sending each cell through a closed-road shortcut
        // and then repeating a timed point search to reject it.
        let bounded_scope = || {
            clock.filter(|_| self.walking.is_some()).map(|clock| {
                let factor = if matches!(opt.profile, Profile::Fast) {
                    1.
                } else {
                    0.8
                };
                self.windows.scope(clock, ceiling / factor * (1. + 1e-12))
            })
        };
        let primary_access = self.walking.is_none().then_some(&[][..]);
        let field = self.bike_field_metrics(
            starts,
            opt,
            clock,
            primary_ceiling,
            primary_access,
            bounded_scope(),
            distances,
        )?;

        let mut extended = None;
        let mut waiting = Vec::new();
        let mut fallback = Vec::new();
        let mut absent = Vec::new();
        let mut origin_access = None;
        let mut access_groups = std::collections::BTreeMap::<Vec<u32>, Vec<usize>>::new();
        let mut access_key_bytes = 0usize;
        let mut result = BikeManyResult {
            seconds: vec![f64::INFINITY; targets.len()],
            meters: if distances {
                vec![f64::INFINITY; targets.len()]
            } else {
                Vec::new()
            },
            settled_labels: field.settled,
            certified_targets: 0,
            fallback_targets: 0,
            tree_limited: field.limited,
            fallback_reasons: Default::default(),
            scoped_trees: 0,
            attachment_certificates: 0,
            access_groups: 0,
            access_group_key_bytes: 0,
            access_group_limit_targets: 0,
        };
        for (target, &destination) in targets.iter().enumerate() {
            let ends = self.attach_bicycle_matching(
                &graph,
                destination,
                max_walk,
                walk_speed / 3.6,
                false,
                false,
                &eligible,
            )?;
            let (mut certified, reason) =
                self.field_duration(&field, &ends, opt, max_distance, clock)?;
            // A missing primary path can still use the point router's wider
            // endpoint attachments. Prove absence against that superset, or
            // verify its path after proving primary absence. The extra field
            // is lazy and query-local.
            if certified.is_none()
                && !field.limited
                && self.field_candidate(&field, &ends, opt, clock)?.is_none()
            {
                if self.walking.is_some() {
                    // Both endpoint passes have the same complete bounded
                    // walking attachments, and this field already relaxes all
                    // road access. No repeated attachment/search is necessary.
                    certified = Some((f64::INFINITY, f64::INFINITY, f64::INFINITY));
                } else {
                    if extended.is_none() {
                        extended = Some(
                            match self.attach_bicycle_fallback(
                                &graph,
                                origin,
                                max_walk,
                                walk_speed / 3.6,
                                true,
                                &eligible,
                            ) {
                                Ok(starts) => {
                                    let wider = self.bike_field_metrics(
                                        starts, opt, clock, ceiling, None, None, distances,
                                    )?;
                                    result.settled_labels += wider.settled;
                                    result.tree_limited |= wider.limited;
                                    ExtendedField::Wider(wider)
                                }
                                // Accelerator limits must not cause a new point-query
                                // error. Let the exact router decide whether it needs
                                // these wider attachments.
                                Err(_) => ExtendedField::Unavailable,
                            },
                        );
                    }
                    let wider = match extended.as_ref().unwrap() {
                        ExtendedField::Wider(wider) => Some(wider),
                        ExtendedField::Unavailable => None,
                    };
                    if let Some(wider) = wider.filter(|f| !f.limited)
                        && let Ok(ends) = self.attach_bicycle_fallback(
                            &graph,
                            destination,
                            max_walk,
                            walk_speed / 3.6,
                            false,
                            &eligible,
                        )
                    {
                        if self.field_candidate(wider, &ends, opt, clock)?.is_none() {
                            certified = Some((f64::INFINITY, f64::INFINITY, f64::INFINITY));
                        } else if reason == "no_tree_path" {
                            // The complete primary relaxation proved absence
                            // under this destination's access permissions, so
                            // the point router must widen its attachments. A
                            // legal optimum of the wider relaxation now proves
                            // the same route cost, including full turn history,
                            // endpoint access, distance and actual entry clocks.
                            certified = self
                                .field_duration(wider, &ends, opt, max_distance, clock)?
                                .0;
                        }
                    }
                }
            }
            if certified.is_none() && reason == "waiting" && clock.is_some() {
                let lower = self.field_candidate(&field, &ends, opt, clock)?.unwrap().3;
                waiting.push((target, lower));
                continue;
            }
            if certified.is_none()
                && reason == "no_tree_path"
                && !distances
                && self.walking.is_some()
            {
                absent.push(target);
                continue;
            }
            if certified.is_none()
                && reason == "destination_access"
                && self.walking.is_some()
                && !distances
            {
                // Verified walking uses the same bounded attachments in both
                // point-router passes. Equal endpoint permission sets can thus
                // share a restricted relaxation without changing that policy.
                // Matrix's distance ties and timed waits often still need its
                // point searches, so keep this extra field specific to Reach.
                let origin_access =
                    origin_access.get_or_insert_with(|| self.endpoint_access(&field.starts));
                let mut extra: Vec<_> = self
                    .endpoint_access(&ends)
                    .difference(origin_access)
                    .copied()
                    .collect();
                extra.sort_unstable();
                let bytes = extra.capacity() * std::mem::size_of::<u32>()
                    + std::mem::size_of::<(Vec<u32>, Vec<usize>)>();
                if let Some(members) = access_groups.get_mut(&extra) {
                    members.push(target);
                    continue;
                } else if access_key_bytes + bytes <= 512 * 1024 {
                    access_key_bytes += bytes;
                    access_groups.insert(extra, vec![target]);
                    continue;
                }
                result.access_group_limit_targets += 1;
            }
            if let Some((seconds, _, meters)) = certified {
                result.certified_targets += 1;
                result.record(target, seconds, meters, maximum_seconds);
            } else {
                result.fallback_targets += 1;
                *result.fallback_reasons.entry(reason).or_default() += 1;
                fallback.push(target);
            }
        }
        result.access_group_key_bytes = access_key_bytes;
        let grouped_starts = (!access_groups.is_empty()).then(|| field.starts.clone());
        // Retain only one search field at a time. Group keys and target indices
        // replace repeated searches, never an enduring graph or endpoint cache.
        drop(field);
        drop(extended);
        drop(origin_access);
        for (extra_access, members) in access_groups {
            if members.len() < 2 {
                result.fallback_targets += members.len();
                *result
                    .fallback_reasons
                    .entry("destination_access")
                    .or_default() += members.len();
                fallback.extend(members);
                continue;
            }
            let group_ends =
                self.field_target_attachments(targets, &members, opt, max_walk, walk_speed, clock)?;
            let field = self.bike_field_for_targets(
                grouped_starts.as_ref().unwrap().clone(),
                opt,
                clock,
                ceiling,
                Some(&extra_access),
                bounded_scope(),
                distances,
                &group_ends,
            )?;
            result.settled_labels += field.settled;
            result.tree_limited |= field.limited;
            for (member, target) in members.into_iter().enumerate() {
                let ends = if !group_ends.is_empty() {
                    group_ends[member].clone()
                } else {
                    self.attach_bicycle_matching(
                        &graph,
                        targets[target],
                        max_walk,
                        walk_speed / 3.6,
                        false,
                        false,
                        &eligible,
                    )?
                };
                let (mut certified, reason) =
                    self.field_duration(&field, &ends, opt, max_distance, clock)?;
                if reason == "no_tree_path" && !field.limited {
                    // The complete relaxation has exactly this target's road
                    // permissions and point attachments. Timed constraints can
                    // only remove paths; absence also proves the timed result.
                    certified = Some((f64::INFINITY, f64::INFINITY, f64::INFINITY));
                }
                if let Some((seconds, _, meters)) = certified {
                    result.certified_targets += 1;
                    result.record(target, seconds, meters, maximum_seconds);
                } else if reason == "waiting" && clock.is_some() {
                    waiting.push((
                        target,
                        self.field_candidate(&field, &ends, opt, clock)?.unwrap().3,
                    ));
                } else if reason == "no_tree_path" && !distances {
                    absent.push(target);
                } else {
                    result.fallback_targets += 1;
                    *result.fallback_reasons.entry(reason).or_default() += 1;
                    fallback.push(target);
                }
            }
        }
        drop(grouped_starts);
        if !absent.is_empty() {
            // One physical-time relaxation can prove that all these cells are
            // outside the budget, even when the preference tree hit its work
            // limit. Relax road permissions; only absence is used as evidence.
            let fast = BikeOptions {
                profile: Profile::Fast,
                ..opt
            };
            let starts = self.attach_bicycle_matching(
                &graph,
                origin,
                max_walk,
                walk_speed / 3.6,
                true,
                false,
                &eligible,
            )?;
            let horizon = maximum_seconds * (1. + 1e-12);
            let field = self.bike_field_metrics(
                starts,
                fast,
                clock,
                horizon,
                None,
                clock.map(|clock| self.windows.scope(clock, horizon)),
                false,
            )?;
            result.settled_labels += field.settled;
            result.tree_limited |= field.limited;
            for target in absent {
                let ends = self.attach_bicycle_matching(
                    &graph,
                    targets[target],
                    max_walk,
                    walk_speed / 3.6,
                    false,
                    false,
                    &eligible,
                )?;
                if !field.limited && self.field_candidate(&field, &ends, fast, clock)?.is_none() {
                    result.certified_targets += 1;
                } else {
                    result.fallback_targets += 1;
                    *result.fallback_reasons.entry("no_tree_path").or_default() += 1;
                    fallback.push(target);
                }
            }
        }
        // No field or attachment scratch overlaps the exact point fallbacks.

        for target in fallback {
            let route = self.reach_fallback(
                origin,
                targets[target],
                opt,
                max_walk,
                walk_speed,
                max_distance,
                clock,
                maximum_seconds,
                if distances { f64::INFINITY } else { ceiling },
            )?;
            result.settled_labels += route.settled_labels;
            if route.status == "ready" {
                result.record(
                    target,
                    route.elapsed_seconds(),
                    route.legs.iter().map(|l| l.meters).sum(),
                    maximum_seconds,
                );
            }
        }
        if !waiting.is_empty() {
            self.resolve_scoped_targets(
                origin,
                targets,
                &waiting,
                opt,
                max_walk,
                walk_speed,
                max_distance,
                clock.unwrap(),
                maximum_seconds,
                &mut result,
            )?;
        }
        Ok(result)
    }

    fn field_target_attachments(
        &self,
        targets: &[[f64; 2]],
        members: &[usize],
        opt: BikeOptions,
        max_walk: f64,
        walk_speed: f64,
        clock: Option<BikeClock>,
    ) -> Result<Vec<Attachment>, String> {
        if self.walking.is_none() {
            return Ok(Vec::new());
        }
        let graph = self.graph();
        let eligible = |edge| {
            self.allowed_edge(edge, opt)
                && (clock.is_some() || self.attributes[edge as usize] & TIMED_EDGE == 0)
        };
        let mut ends = Vec::new();
        let mut bytes = 0;
        for &target in members {
            let end = self.attach_bicycle_matching(
                &graph,
                targets[target],
                max_walk,
                walk_speed / 3.6,
                false,
                false,
                &eligible,
            )?;
            bytes += end.candidates.capacity()
                * std::mem::size_of::<crate::drive_attachment::BikeCandidate>()
                + std::mem::size_of::<Attachment>();
            if bytes > crate::resources::cache_budget(8 * 1024 * 1024, 128) {
                return Ok(Vec::new());
            }
            ends.push(end);
        }
        Ok(ends)
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "Keep routing bounds and attachment policy explicit at the search boundary."
    )]
    fn resolve_scoped_targets(
        &self,
        origin: [f64; 2],
        targets: &[[f64; 2]],
        waiting: &[(usize, f64)],
        opt: BikeOptions,
        max_walk: f64,
        walk_speed: f64,
        max_distance: f64,
        clock: BikeClock,
        maximum_seconds: f64,
        result: &mut BikeManyResult,
    ) -> Result<(), String> {
        let graph = self.graph();
        let eligible = |edge| self.allowed_edge(edge, opt);
        let starts = self.attach_bicycle_matching(
            &graph,
            origin,
            max_walk,
            walk_speed / 3.6,
            true,
            false,
            &eligible,
        )?;
        // Network-walking attachments are identical in both point passes.
        // First try a shared timed certificate with relaxed endpoint permissions;
        // replay proves permissions for each target. This avoids building a pair
        // of regional trees per small endpoint-access group when the chosen path
        // does not use those roads at all.
        let remaining = if self.walking.is_some() && result.meters.is_empty() {
            self.certify_timed_reach(
                &starts,
                targets,
                waiting,
                opt,
                max_walk,
                walk_speed,
                max_distance,
                clock,
                maximum_seconds,
                result,
            )?
        } else {
            waiting.to_vec()
        };
        let waiting = &remaining;
        let mut confirmed = Vec::new();
        let mut fallback = Vec::new();
        let physical = |r: &BikeResult| {
            r.legs
                .iter()
                .map(|l| l.seconds + l.wait_before_seconds)
                .sum::<f64>()
        };
        let distances = !result.meters.is_empty();
        let factor = if matches!(opt.profile, Profile::Fast) {
            1.
        } else {
            0.8
        };
        let events = self.windows.scope_events(clock);
        if self.walking.is_some() && !distances {
            // Both point-router passes use the same complete walking-network
            // attachments. No per-target search is needed to authorize the
            // second pass; the scoped fields still prove its timed optimum.
            confirmed.extend(waiting.iter().map(|&(target, _)| target));
        } else {
            let mut checks = std::collections::BTreeMap::<usize, Vec<(usize, f64)>>::new();
            for &(target, lower) in waiting {
                let horizon = lower / factor * (1. + 1e-12);
                checks
                    .entry(events.partition_point(|&event| event <= horizon))
                    .or_default()
                    .push((target, lower));
            }
            for (_, checks) in checks {
                let maximum = checks.iter().map(|&(_, cost)| cost).fold(0., f64::max);
                let scope = self.windows.scope(clock, maximum / factor * (1. + 1e-12));
                let proof = self.bike_field_metrics(
                    starts.clone(),
                    opt,
                    Some(clock),
                    maximum * (1. + 2e-12),
                    self.walking.is_none().then_some(&[][..]),
                    Some(scope),
                    distances,
                )?;
                result.settled_labels += proof.settled;
                result.tree_limited |= proof.limited;
                result.scoped_trees += 1;
                for (target, lower) in checks {
                    let ends = self.attach_bicycle_matching(
                        &graph,
                        targets[target],
                        max_walk,
                        walk_speed / 3.6,
                        false,
                        false,
                        &eligible,
                    )?;
                    // Every original optimum costs `lower` and, without waiting, lasts
                    // at most lower / factor. If enforcing its fixed windows raises
                    // even the relaxed optimum, ALL original optima require waiting
                    // or fail replay. This proves the point router will widen endpoints
                    // regardless of ties, without repeating its initial search.
                    // These targets passed access/distance replay. Network-walking
                    // fields retain the same all-access relaxation for this proof;
                    // relaxing additional roads can only lower the scoped optimum.
                    let scoped_lower = self
                        .field_candidate(&proof, &ends, opt, Some(clock))?
                        .map(|c| c.3)
                        .unwrap_or(proof.certified_cost);
                    if scoped_lower > lower * (1. + 1e-12) {
                        confirmed.push(target);
                        result.attachment_certificates += 1;
                        continue;
                    }
                    // Preserve the point router's attachment policy even when equal-
                    // cost static paths differ in temporal validity. Only its own
                    // invalid initial relaxation authorizes the wider timed search.
                    let initial = self.search_with_limit(
                        origin,
                        targets[target],
                        opt,
                        &starts,
                        &ends,
                        max_distance,
                        Some(clock),
                        SearchKind::Relaxed,
                        SearchBounds::default(),
                        None,
                        false,
                    )?;
                    result.settled_labels += initial.settled_labels;
                    if initial.temporal_valid && initial.status == "ready" {
                        result.record(
                            target,
                            physical(&initial),
                            initial.legs.iter().map(|l| l.meters).sum(),
                            maximum_seconds,
                        );
                        result.certified_targets += 1;
                    } else if !initial.temporal_valid {
                        confirmed.push(target);
                    } else {
                        fallback.push(target);
                    }
                }
            }
        }
        if !confirmed.is_empty() {
            let wide_starts = self.attach_bicycle_fallback(
                &graph,
                origin,
                max_walk,
                walk_speed / 3.6,
                true,
                &eligible,
            )?;
            let origin_access = self.endpoint_access(&wide_starts);
            let mut access_groups = std::collections::BTreeMap::<Vec<u32>, Vec<usize>>::new();
            let mut key_bytes = 0usize;
            for target in confirmed {
                let ends = self.attach_bicycle_fallback(
                    &graph,
                    targets[target],
                    max_walk,
                    walk_speed / 3.6,
                    false,
                    &eligible,
                )?;
                let mut extra: Vec<_> = self
                    .endpoint_access(&ends)
                    .difference(&origin_access)
                    .copied()
                    .collect();
                extra.sort_unstable();
                let bytes = extra.capacity() * std::mem::size_of::<u32>()
                    + std::mem::size_of::<(Vec<u32>, Vec<usize>)>();
                if let Some(members) = access_groups.get_mut(&extra) {
                    members.push(target);
                } else if key_bytes + bytes <= 512 * 1024 {
                    key_bytes += bytes;
                    access_groups.insert(extra, vec![target]);
                } else {
                    result.access_group_limit_targets += 1;
                    fallback.push(target);
                }
            }
            result.access_group_key_bytes = result.access_group_key_bytes.max(key_bytes);
            for (extra_access, members) in access_groups {
                if !extra_access.is_empty() && members.len() < 2 {
                    fallback.extend(members);
                    continue;
                }
                result.access_groups += 1;
                let copy_starts = || wide_starts.clone();
                // This small group can stop its snapshot once every target is
                // settled. Cap attachment scratch; larger groups keep the
                // original bounded field and per-target attachment path.
                let group_ends = if distances {
                    Vec::new()
                } else {
                    self.field_target_attachments(
                        targets,
                        &members,
                        opt,
                        max_walk,
                        walk_speed,
                        Some(clock),
                    )?
                };
                let current = self.windows.scope(clock, 0.);
                let snapshot = self.bike_field_for_targets(
                    copy_starts(),
                    opt,
                    Some(clock),
                    f64::INFINITY,
                    Some(&extra_access),
                    Some(current),
                    distances,
                    &group_ends,
                )?;
                result.settled_labels += snapshot.settled;
                result.tree_limited |= snapshot.limited;
                result.scoped_trees += 1;
                let mut groups = std::collections::BTreeMap::<usize, Vec<(usize, f64)>>::new();
                for (member, target) in members.into_iter().enumerate() {
                    let ends = if !group_ends.is_empty() {
                        group_ends[member].clone()
                    } else {
                        self.attach_bicycle_fallback(
                            &graph,
                            targets[target],
                            max_walk,
                            walk_speed / 3.6,
                            false,
                            &eligible,
                        )?
                    };
                    let (candidate, _) =
                        self.field_duration(&snapshot, &ends, opt, max_distance, Some(clock))?;
                    if let Some((_, upper, _)) = candidate.filter(|&(_, cost, _)| cost.is_finite())
                    {
                        let horizon = upper / factor * (1. + 1e-12);
                        let group = events.partition_point(|&event| event <= horizon);
                        groups.entry(group).or_default().push((target, upper));
                    } else {
                        fallback.push(target);
                    }
                }
                drop(snapshot);
                drop(group_ends);
                // Targets with the same changing windows share one scalar search.
                // Retain only small target/cost pairs, never all attachments or a
                // collection of graph trees. Their original order is restored by
                // writing to the existing output vector.
                for (_, group) in groups {
                    let upper = group.iter().map(|&(_, cost)| cost).fold(0., f64::max);
                    let ceiling = upper * (1. + 1e-12);
                    let scope = self.windows.scope(clock, upper / factor * (1. + 1e-12));
                    let field = self.bike_field_metrics(
                        copy_starts(),
                        opt,
                        Some(clock),
                        ceiling,
                        Some(&extra_access),
                        Some(scope),
                        distances,
                    )?;
                    result.settled_labels += field.settled;
                    result.tree_limited |= field.limited;
                    result.scoped_trees += 1;
                    for (target, upper) in group {
                        let ends = self.attach_bicycle_fallback(
                            &graph,
                            targets[target],
                            max_walk,
                            walk_speed / 3.6,
                            false,
                            &eligible,
                        )?;
                        let (candidate, _) =
                            self.field_duration(&field, &ends, opt, max_distance, Some(clock))?;
                        if let Some((seconds, _, meters)) =
                            candidate.filter(|&(_, cost, _)| cost <= upper)
                        {
                            result.record(target, seconds, meters, maximum_seconds);
                            result.certified_targets += 1;
                        } else {
                            fallback.push(target);
                        }
                    }
                }
            }
        }
        drop(starts);
        let ceiling = if distances || fallback.is_empty() {
            f64::INFINITY
        } else {
            let ratio = (0..self.targets.len()).fold(1f64, |max, edge| {
                let (seconds, cost) = self.metric(edge as u32, opt);
                max.max(cost / seconds)
            });
            maximum_seconds * ratio * (1. + 1e-12)
        };
        for target in fallback {
            let route = self.reach_fallback(
                origin,
                targets[target],
                opt,
                max_walk,
                walk_speed,
                max_distance,
                Some(clock),
                maximum_seconds,
                ceiling,
            )?;
            result.settled_labels += route.settled_labels;
            result.fallback_targets += 1;
            *result.fallback_reasons.entry("waiting").or_default() += 1;
            if route.status == "ready" {
                result.record(
                    target,
                    physical(&route),
                    route.legs.iter().map(|l| l.meters).sum(),
                    maximum_seconds,
                );
            }
        }
        Ok(())
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "Keep shared temporal proof bounds explicit."
    )]
    fn certify_timed_reach(
        &self,
        starts: &Attachment,
        targets: &[[f64; 2]],
        waiting: &[(usize, f64)],
        opt: BikeOptions,
        max_walk: f64,
        walk_speed: f64,
        max_distance: f64,
        clock: BikeClock,
        maximum_seconds: f64,
        result: &mut BikeManyResult,
    ) -> Result<Vec<(usize, f64)>, String> {
        let graph = self.graph();
        let eligible = |edge| self.allowed_edge(edge, opt);
        let ratio = (0..self.targets.len()).fold(1f64, |max, edge| {
            let (seconds, cost) = self.metric(edge as u32, opt);
            max.max(cost / seconds)
        });
        let ceiling = maximum_seconds * ratio * (1. + 1e-12);
        let factor = if matches!(opt.profile, Profile::Fast) {
            1.
        } else {
            0.8
        };
        let snapshot = self.bike_field_metrics(
            starts.clone(),
            opt,
            Some(clock),
            ceiling,
            None,
            Some(self.windows.scope(clock, 0.)),
            false,
        )?;
        result.settled_labels += snapshot.settled;
        result.tree_limited |= snapshot.limited;
        result.scoped_trees += 1;
        let events = self.windows.scope_events(clock);
        let mut groups = std::collections::BTreeMap::<usize, Vec<(usize, f64, f64)>>::new();
        let mut remaining = Vec::new();
        for &(target, lower) in waiting {
            let ends = self.attach_bicycle_matching(
                &graph,
                targets[target],
                max_walk,
                walk_speed / 3.6,
                false,
                false,
                &eligible,
            )?;
            let (candidate, _) =
                self.field_duration(&snapshot, &ends, opt, max_distance, Some(clock))?;
            if let Some((_, upper, _)) = candidate.filter(|&(_, cost, _)| cost.is_finite()) {
                let horizon = upper / factor * (1. + 1e-12);
                groups
                    .entry(events.partition_point(|&event| event <= horizon))
                    .or_default()
                    .push((target, lower, upper));
            } else {
                remaining.push((target, lower));
            }
        }
        drop(snapshot);
        // Start with the largest shared horizon. Most global window changes
        // are unrelated to these paths; split only targets whose replay fails.
        let mut batches = std::collections::VecDeque::new();
        if groups.len() > 1 {
            batches.push_back((true, groups.into_values().flatten().collect::<Vec<_>>()));
        } else {
            batches.extend(groups.into_values().map(|group| (false, group)));
        }
        while let Some((split, group)) = batches.pop_front() {
            let mut retry = std::collections::BTreeMap::<usize, Vec<(usize, f64, f64)>>::new();
            let upper = group.iter().map(|&(_, _, cost)| cost).fold(0., f64::max);
            let field = self.bike_field_metrics(
                starts.clone(),
                opt,
                Some(clock),
                upper * (1. + 1e-12),
                None,
                Some(self.windows.scope(clock, upper / factor * (1. + 1e-12))),
                false,
            )?;
            result.settled_labels += field.settled;
            result.tree_limited |= field.limited;
            result.scoped_trees += 1;
            for (target, lower, upper) in group {
                let ends = self.attach_bicycle_matching(
                    &graph,
                    targets[target],
                    max_walk,
                    walk_speed / 3.6,
                    false,
                    false,
                    &eligible,
                )?;
                let (candidate, _) =
                    self.field_duration(&field, &ends, opt, max_distance, Some(clock))?;
                if let Some((seconds, _, meters)) = candidate.filter(|&(_, cost, _)| cost <= upper)
                {
                    result.record(target, seconds, meters, maximum_seconds);
                    result.certified_targets += 1;
                } else if split {
                    let horizon = upper / factor * (1. + 1e-12);
                    retry
                        .entry(events.partition_point(|&event| event <= horizon))
                        .or_default()
                        .push((target, lower, upper));
                } else {
                    remaining.push((target, lower));
                }
            }
            batches.extend(retry.into_values().map(|group| (false, group)));
        }
        Ok(remaining)
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "Keep Reach's proof bounds explicit."
    )]
    fn reach_fallback(
        &self,
        origin: [f64; 2],
        destination: [f64; 2],
        opt: BikeOptions,
        max_walk: f64,
        walk_speed: f64,
        max_distance: f64,
        clock: Option<BikeClock>,
        maximum_seconds: f64,
        ceiling: f64,
    ) -> Result<BikeResult, String> {
        if !ceiling.is_finite() || self.walking.is_none() {
            return self.route_at(
                origin,
                destination,
                opt,
                max_walk,
                walk_speed,
                max_distance,
                clock,
            );
        }
        let graph = self.graph();
        let eligible = |edge| {
            self.allowed_edge(edge, opt)
                && (clock.is_some() || self.attributes[edge as usize] & TIMED_EDGE == 0)
        };
        let starts = self.attach_bicycle_matching(
            &graph,
            origin,
            max_walk,
            walk_speed / 3.6,
            true,
            false,
            &eligible,
        )?;
        let ends = self.attach_bicycle_matching(
            &graph,
            destination,
            max_walk,
            walk_speed / 3.6,
            false,
            false,
            &eligible,
        )?;
        // Absence within the physical budget is sufficient for a blank Reach
        // cell. A point query would instead search for an arbitrarily late
        // opening of a restricted road, which can exhaust its work budget.
        let fastest = self.search(
            origin,
            destination,
            opt,
            &starts,
            &ends,
            max_distance,
            false,
            clock,
            SearchKind::Earliest,
            SearchBounds {
                upper_cost: maximum_seconds * (1. + 1e-12),
                earliest_arrival: 0.,
            },
            None,
            false,
        )?;
        if fastest.status != "ready" {
            return Ok(fastest);
        }
        let mut result = self.route_from(
            origin,
            destination,
            opt,
            max_walk,
            walk_speed,
            max_distance,
            clock,
            None,
            false,
            ceiling,
        )?;
        result.settled_labels += fastest.settled_labels;
        Ok(result)
    }

    fn endpoint_access(&self, endpoint: &Attachment) -> HashSet<u32> {
        endpoint
            .candidates
            .iter()
            .filter(|c| self.attributes[c.edge as usize] & (1 << 22) != 0)
            .map(|c| self.destination_components[self.source(c.edge) as usize])
            .collect()
    }

    #[cfg(test)]
    fn bike_field(
        &self,
        starts: Attachment,
        opt: BikeOptions,
        clock: Option<BikeClock>,
        ceiling: f64,
        additional_access: Option<&[u32]>,
        scope: Option<Vec<Option<bool>>>,
    ) -> Result<Field, String> {
        self.bike_field_metrics(starts, opt, clock, ceiling, additional_access, scope, false)
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "Keep routing bounds and attachment policy explicit at the search boundary."
    )]
    fn bike_field_metrics(
        &self,
        starts: Attachment,
        opt: BikeOptions,
        clock: Option<BikeClock>,
        ceiling: f64,
        additional_access: Option<&[u32]>,
        scope: Option<Vec<Option<bool>>>,
        distances: bool,
    ) -> Result<Field, String> {
        self.bike_field_for_targets(
            starts,
            opt,
            clock,
            ceiling,
            additional_access,
            scope,
            distances,
            &[],
        )
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "Keep the field bounds and target certificate explicit."
    )]
    fn bike_field_for_targets(
        &self,
        starts: Attachment,
        opt: BikeOptions,
        clock: Option<BikeClock>,
        ceiling: f64,
        additional_access: Option<&[u32]>,
        scope: Option<Vec<Option<bool>>>,
        distances: bool,
        ends: &[Attachment],
    ) -> Result<Field, String> {
        let mut start_edges: Vec<u32> = (0..starts.candidates.len() as u32).collect();
        start_edges.sort_unstable_by_key(|&i| starts.candidates[i as usize].edge);
        // Exact permission sets are shared only by targets with the same
        // additional components. None deliberately relaxes all access rules.
        let access = additional_access.map(|extra| {
            let mut access = self.endpoint_access(&starts);
            access.extend(extra.iter().copied());
            access
        });
        let mut field = Field {
            starts,
            start_edges,
            labels: vec![],
            direct: vec![u32::MAX; field_node_slots(self.lons.len())],
            special: HashMap::new(),
            certified_cost: ceiling,
            settled: 0,
            limited: false,
            access,
            states: vec![],
            scope: scope.clone(),
            ties: Vec::new(),
            distances,
        };
        let mut frontier = HashMap::<(u32, Option<u32>, u32), usize>::new();
        let mut states = vec![TurnState::new()];
        let mut state_ids = HashMap::from([(TurnState::new(), 0u32)]);
        let mut queue = BinaryHeap::new();
        let kind = if let Some(scope) = &scope {
            SearchKind::Scoped(scope)
        } else if clock.is_some() {
            SearchKind::Relaxed
        } else {
            SearchKind::Normal
        };
        let insert = |label: FieldLabel,
                      field: &mut Field,
                      frontier: &mut HashMap<_, usize>,
                      queue: &mut BinaryHeap<Queue>| {
            if label.cost >= ceiling {
                return;
            }
            let incoming = label
                .incoming()
                .filter(|&e| self.attributes[e as usize] & (NODE_TURN | WAY_TURN) != 0);
            let ordinary = !field.direct.is_empty() && incoming.is_none() && label.state == 0;
            let previous = if ordinary {
                field.direct[label.node as usize] as usize
            } else {
                *frontier
                    .get(&(label.node, incoming, label.state))
                    .unwrap_or(&usize::MAX)
            };
            let mut tied = false;
            if previous < field.labels.len() {
                let old = &field.labels[previous];
                tied = distances
                    && (old.cost - label.cost).abs() <= 1e-12 * old.cost.max(label.cost).max(1.)
                    && (old.parent != label.parent
                        || old.start != label.start
                        || old.incoming != label.incoming);
                if field.labels[previous].cost <= label.cost {
                    if tied {
                        field.ties[previous] = true;
                    }
                    return;
                }
                field.labels[previous].active = false;
            }
            let id = field.labels.len();
            if ordinary {
                field.direct[label.node as usize] = id as u32;
            } else {
                frontier.insert((label.node, incoming, label.state), id);
                field.special.entry(label.node).or_default().push(id);
            }
            queue.push(Queue(label.cost, id));
            field.labels.push(label);
            if distances {
                field.ties.push(tied);
            }
        };
        for i in 0..field.starts.candidates.len() {
            let a = field.starts.candidate(&self.graph(), i);
            for (_, state) in self
                .start_movements(&a, a.drive_meters, None, clock, kind, true)?
                .into_iter()
            {
                let state = if state.is_empty() {
                    0
                } else {
                    *state_ids.entry(state.clone()).or_insert_with(|| {
                        let id = states.len() as u32;
                        states.push(state);
                        id
                    })
                };
                insert(
                    FieldLabel {
                        node: a.node,
                        incoming: if a.drive_meters > 1e-7 {
                            a.edge
                        } else {
                            u32::MAX
                        },
                        state,
                        cost: a.walk_seconds + a.drive_meters * self.metric(a.edge, opt).1,
                        parent: u32::MAX,
                        start: i as u32,
                        active: true,
                    },
                    &mut field,
                    &mut frontier,
                    &mut queue,
                );
            }
        }
        let label_limit = if distances {
            262_144
        } else {
            field_label_limit()
        };
        'search: while let Some(Queue(cost, id)) = queue.pop() {
            if !field.labels[id].active {
                continue;
            }
            // A bounded accelerator must not turn exhaustion into no-route.
            // Only paths cheaper than this unfinished frontier remain certified.
            if field.labels.len() >= label_limit {
                field.certified_cost = cost;
                field.limited = true;
                break;
            }
            // A target's full relaxed optimum is fixed once its best candidate
            // is cheaper than every unsettled label. Check in bounded batches;
            // retain all equal-cost labels and the existing tie order. A missing
            // candidate never authorizes early termination.
            if !ends.is_empty() && field.settled.is_multiple_of(4096) {
                std::mem::swap(&mut field.states, &mut states);
                let done = ends.iter().try_fold(true, |done, end| {
                    if !done || end.candidates.is_empty() {
                        return Ok::<_, String>(done);
                    }
                    Ok(self
                        .field_candidate(&field, end, opt, clock)?
                        .is_some_and(|c| c.3 < cost))
                })?;
                std::mem::swap(&mut field.states, &mut states);
                if done {
                    field.certified_cost = cost.min(field.certified_cost);
                    break;
                }
            }
            field.settled += 1;
            let label = field.labels[id];
            for edge in self.offsets[label.node as usize]..self.offsets[label.node as usize + 1] {
                if !self.allowed_edge(edge, opt) {
                    continue;
                }
                if self.attributes[edge as usize] & (1 << 22) != 0
                    && field.access.as_ref().is_some_and(|access| {
                        !access.contains(&self.destination_components[label.node as usize])
                    })
                {
                    continue;
                }
                for (_, state) in self
                    .movements(
                        &states[label.state as usize],
                        label.incoming(),
                        label.node,
                        edge,
                        clock,
                        0.,
                        kind,
                        true,
                    )?
                    .into_iter()
                {
                    if field.labels.len() >= label_limit {
                        field.certified_cost = cost;
                        field.limited = true;
                        break 'search;
                    }
                    let state = if state.is_empty() {
                        0
                    } else {
                        *state_ids.entry(state.clone()).or_insert_with(|| {
                            let id = states.len() as u32;
                            states.push(state);
                            id
                        })
                    };
                    let meters = self.distances[edge as usize] as f64 / 100.;
                    insert(
                        FieldLabel {
                            node: self.targets[edge as usize],
                            incoming: edge,
                            state,
                            cost: cost + meters * self.metric(edge, opt).1,
                            parent: id as u32,
                            start: label.start,
                            active: true,
                        },
                        &mut field,
                        &mut frontier,
                        &mut queue,
                    );
                }
            }
        }
        field.states = states;
        field.scope = scope;

        Ok(field)
    }

    fn field_candidate(
        &self,
        field: &Field,
        ends: &Attachment,
        opt: BikeOptions,
        clock: Option<BikeClock>,
    ) -> Result<Option<FieldCandidate>, String> {
        let mut best = field.certified_cost;
        let mut winner: Option<(Option<usize>, usize, usize)> = None;
        let mut tied = false;
        let kind = if let Some(scope) = &field.scope {
            SearchKind::Scoped(scope)
        } else if clock.is_some() {
            SearchKind::Relaxed
        } else {
            SearchKind::Normal
        };
        // Same-edge paths need no traversal of the edge's far endpoint.
        for j in 0..ends.candidates.len() {
            let b = ends.candidate(&self.graph(), j);
            let first = field
                .start_edges
                .partition_point(|&i| field.starts.candidates[i as usize].edge < b.edge);
            for &start in field.start_edges[first..]
                .iter()
                .take_while(|&&i| field.starts.candidates[i as usize].edge == b.edge)
            {
                let i = start as usize;
                let a = field.starts.candidate(&self.graph(), i);
                if b.fraction < a.fraction {
                    continue;
                }
                let meters =
                    (b.fraction - a.fraction) * self.distances[a.edge as usize] as f64 / 100.;
                if self
                    .start_movements(&a, meters, None, clock, kind, false)?
                    .first
                    .is_none()
                {
                    continue;
                }
                let cost = a.walk_seconds + b.walk_seconds + meters * self.metric(a.edge, opt).1;
                let near =
                    winner.is_some() && (best - cost).abs() <= 1e-12 * best.max(cost).max(1.);
                if field.distances && near {
                    tied = true;
                }
                // Vertex walks and direct projections can share an edge.
                // Compare every match, preserving point routing's tie order.
                if cost < best
                    || (cost == best
                        && winner
                            .is_some_and(|(id, start, end)| id.is_none() && (i, j) < (start, end)))
                {
                    if !near {
                        tied = false;
                    }
                    best = cost;
                    winner = Some((None, i, j));
                }
            }
        }
        for j in 0..ends.candidates.len() {
            let b = ends.candidate(&self.graph(), j);
            let ordinary = field
                .direct
                .get(b.node as usize)
                .copied()
                .unwrap_or(u32::MAX) as usize;
            let labels = (ordinary < field.labels.len())
                .then_some(ordinary)
                .into_iter()
                .chain(field.special.get(&b.node).into_iter().flatten().copied());
            for id in labels {
                let label = &field.labels[id];
                if !label.active {
                    continue;
                }
                let cost =
                    label.cost + b.walk_seconds + b.drive_meters * self.metric(b.edge, opt).1;
                let near =
                    winner.is_some() && (best - cost).abs() <= 1e-12 * best.max(cost).max(1.);
                if cost < best || (field.distances && near) {
                    // Static final-turn legality belongs to the relaxed search
                    // too. Otherwise a forbidden final turn can mask another
                    // valid frontier label and force a redundant point query.
                    if b.drive_meters > 1e-7
                        && self
                            .movements(
                                &field.states[label.state as usize],
                                label.incoming(),
                                label.node,
                                b.edge,
                                clock,
                                0.,
                                kind,
                                false,
                            )?
                            .first
                            .is_none()
                    {
                        continue;
                    }
                    if field.distances && near {
                        tied = true;
                    }
                    if cost < best {
                        if !near {
                            tied = false;
                        }
                        best = cost;
                        winner = Some((Some(id), label.start as usize, j));
                    }
                }
            }
        }
        Ok(winner.map(|(id, start, end)| (id, start, end, best, tied)))
    }

    fn field_duration(
        &self,
        field: &Field,
        ends: &Attachment,
        opt: BikeOptions,
        max_distance: f64,
        clock: Option<BikeClock>,
    ) -> CertifiedMetrics<(f64, f64, f64)> {
        if field.starts.candidates.is_empty() || ends.candidates.is_empty() {
            return Ok((
                Some((f64::INFINITY, f64::INFINITY, f64::INFINITY)),
                "no_attachment",
            ));
        }
        if field.access.as_ref().is_some_and(|access| {
            ends.candidates.iter().any(|c| {
                self.attributes[c.edge as usize] & (1 << 22) != 0
                    && !access.contains(&self.destination_components[self.source(c.edge) as usize])
            })
        }) {
            return Ok((None, "additional_destination_access"));
        }
        let Some((id, start, end, cost, tied)) = self.field_candidate(field, ends, opt, clock)?
        else {
            return Ok((None, "no_tree_path"));
        };
        if tied {
            return Ok((None, "metric_tie"));
        }
        let a = field.starts.candidate(&self.graph(), start);
        let b = ends.candidate(&self.graph(), end);
        let mut parts = Vec::new();
        if let Some(mut id) = id {
            parts.push((b.edge, b.drive_meters));
            if field.ties.get(id) == Some(&true) {
                return Ok((None, "metric_tie"));
            }
            while field.labels[id].parent != u32::MAX {
                let parent = field.labels[id].parent;
                let edge = field.labels[id].incoming().unwrap();
                parts.push((edge, self.distances[edge as usize] as f64 / 100.));
                id = parent as usize;
                if field.ties.get(id) == Some(&true) {
                    return Ok((None, "metric_tie"));
                }
            }
            parts.push((a.edge, a.drive_meters));
            parts.reverse();
        } else {
            parts.push((
                a.edge,
                (b.fraction - a.fraction) * self.distances[a.edge as usize] as f64 / 100.,
            ));
        }
        let meters = a.walk_meters + b.walk_meters + parts.iter().map(|p| p.1).sum::<f64>();
        if meters > max_distance {
            return Ok((None, "distance_limit"));
        }
        let access: HashSet<_> = field
            .starts
            .candidates
            .iter()
            .chain(&ends.candidates)
            .filter(|c| self.attributes[c.edge as usize] & (1 << 22) != 0)
            .map(|c| self.destination_components[self.source(c.edge) as usize])
            .collect();
        // Check the whole path before classifying a timed wait. With relaxed
        // access, a later unauthorized road would invalidate that certificate.
        if parts.iter().any(|&(edge, meters)| {
            meters >= 1e-7
                && self.attributes[edge as usize] & (1 << 22) != 0
                && !access.contains(&self.destination_components[self.source(edge) as usize])
        }) {
            return Ok((None, "destination_access"));
        }
        let mut elapsed = a.walk_seconds;
        let mut state = TurnState::new();
        let mut incoming = None;
        for (edge, meters) in parts {
            if meters < 1e-7 {
                continue;
            }
            let Some((departure, next)) = self
                .movements(
                    &state,
                    incoming,
                    self.source(edge),
                    edge,
                    clock,
                    elapsed,
                    SearchKind::Normal,
                    false,
                )?
                .first
            else {
                return Ok((None, "timed_permission"));
            };
            // Any wait invalidates the lower-bound proof, even if a legal
            // journey remains: another path may avoid it at lower cost.
            if departure != elapsed {
                return Ok((None, "waiting"));
            }
            elapsed += meters * self.metric(edge, opt).0;
            incoming = Some(edge);
            state = next;
        }
        Ok((Some((elapsed + b.walk_seconds, cost, meters)), "verified"))
    }
}

#[cfg(test)]
mod walk_attachment_tests {
    use super::*;
    use crate::drive_attachment::BikeCandidate;
    #[test]
    fn target_completion_preserves_full_field_results_and_unreachable_targets() {
        let nodes: Vec<_> = (0..10002).map(|i| [i as f64 * 0.000001, 0.]).collect();
        let edges: Vec<_> = (0..10000)
            .map(|i| (i, i + 1, 100, i as i64, (2 << 3) | (30 << 8) | (15 << 14)))
            .collect();
        let bike = super::super::tests::fixture(&nodes, &edges, &[]);
        let opt = BikeOptions::default();
        let start = Attachment::from_candidates(
            vec![BikeCandidate {
                node: 1,
                edge: 0,
                fraction: 0.,
                walk_meters: 0.,
            }],
            1.,
            true,
        );
        let end = |node| {
            Attachment::from_candidates(
                vec![BikeCandidate {
                    node,
                    edge: node,
                    fraction: 2.,
                    walk_meters: 0.,
                }],
                1.,
                false,
            )
        };
        let ends = [end(100), end(6000)];
        let full = bike
            .bike_field_metrics(start.clone(), opt, None, f64::INFINITY, None, None, false)
            .unwrap();
        let stopped = bike
            .bike_field_for_targets(
                start.clone(),
                opt,
                None,
                f64::INFINITY,
                None,
                None,
                false,
                &ends,
            )
            .unwrap();
        assert!(stopped.settled < full.settled);
        assert!(!stopped.limited);
        for end in &ends {
            assert_eq!(
                bike.field_duration(&stopped, end, opt, 100000., None)
                    .unwrap(),
                bike.field_duration(&full, end, opt, 100000., None).unwrap()
            );
        }
        let missing = Attachment::from_candidates(
            vec![BikeCandidate {
                node: 10001,
                edge: 9999,
                fraction: 2.,
                walk_meters: 0.,
            }],
            1.,
            false,
        );
        let exhausted = bike
            .bike_field_for_targets(
                start,
                opt,
                None,
                f64::INFINITY,
                None,
                None,
                false,
                &[missing],
            )
            .unwrap();
        assert_eq!(
            exhausted.settled, full.settled,
            "Unsettled targets must not authorize stopping"
        );
    }

    #[test]
    fn compact_field_labels_preserve_edge_zero_and_the_largest_valid_edge() {
        assert_eq!(std::mem::size_of::<FieldLabel>(), 32);
        let mut label = FieldLabel {
            node: 0,
            incoming: u32::MAX,
            state: 0,
            cost: 0.,
            parent: u32::MAX,
            start: 0,
            active: true,
        };
        assert_eq!(label.incoming(), None);
        for edge in [0, u32::MAX - 1] {
            label.incoming = edge;
            assert_eq!(label.incoming(), Some(edge));
        }
    }
    #[test]
    fn relaxed_access_checks_later_roads_before_certifying_a_timed_wait() {
        let cycle = (2 << 3) | (30 << 8) | (15 << 14);
        let nodes = [
            [0., 0.],
            [0.001, 0.],
            [0.002, 0.],
            [0.003, 0.],
            [0.001, 0.002],
        ];
        let mut bike = super::super::tests::fixture(
            &nodes,
            &[
                (0, 1, 10000, 1, cycle),
                (1, 2, 10000, 2, cycle | (1 << 22)),
                (2, 3, 10000, 3, cycle),
                (0, 4, 50000, 4, cycle),
                (4, 3, 50000, 5, cycle),
            ],
            &[],
        );
        bike.windows.schedules = vec![vec![(540, 1440)]];
        let timed = bike.ways.iter().position(|&w| w == 1).unwrap();
        bike.attributes[timed] |= TIMED_EDGE;
        bike.edge_windows.insert(timed as u32, 1);
        let clock = BikeClock::service("2026-11-02", "America/New_York", 28800.).unwrap();
        let opt = BikeOptions {
            profile: Profile::Fast,
            ..Default::default()
        };
        let graph = bike.graph();
        let starts =
            bike.index
                .attach_bicycle_matching(&graph, nodes[0], 0., 1., true, false, &|_| true);
        let field = bike
            .bike_field(starts, opt, Some(clock), f64::INFINITY, None, None)
            .unwrap();
        let ends =
            bike.index
                .attach_bicycle_matching(&graph, nodes[3], 0., 1., false, false, &|_| true);
        assert_eq!(
            bike.field_duration(&field, &ends, opt, 10000., Some(clock))
                .unwrap(),
            (None, "destination_access"),
            "An earlier wait cannot authorize a later restricted shortcut"
        );
        let point = bike
            .route_at(nodes[0], nodes[3], opt, 0., 3.6, 10000., Some(clock))
            .unwrap();
        assert_eq!(point.elapsed_seconds(), 200.);
        let ends =
            bike.index
                .attach_bicycle_matching(&graph, [0.0015, 0.], 0., 1., false, false, &|_| true);
        assert_eq!(
            bike.field_duration(&field, &ends, opt, 10000., Some(clock))
                .unwrap(),
            (None, "waiting"),
            "A destination inside the restricted road grants access but still requires a wait"
        );
    }
    #[test]
    fn field_handles_network_vertices_and_multiple_matches_on_one_edge() {
        let bike = super::super::tests::fixture(
            &[[0., 0.], [0.0008, 0.]],
            &[(0, 1, 10000, 1, (2 << 3) | (30 << 8) | (15 << 14))],
            &[],
        );
        let opt = BikeOptions {
            profile: Profile::Fast,
            ..Default::default()
        };
        let starts = Attachment::from_candidates(
            vec![BikeCandidate {
                node: 1,
                edge: 0,
                fraction: 0.8,
                walk_meters: 0.,
            }],
            1.,
            true,
        );
        let field = bike
            .bike_field(starts, opt, None, f64::INFINITY, None, None)
            .unwrap();
        let ends = Attachment::from_candidates(
            vec![BikeCandidate {
                node: 0,
                edge: 0,
                fraction: 2.,
                walk_meters: 10.,
            }],
            1.,
            false,
        );
        assert!(
            bike.field_candidate(&field, &ends, opt, None)
                .unwrap()
                .is_none(),
            "A network walk ending at the source cannot ride backward from 80% along a one-way edge"
        );
        let starts = Attachment::from_candidates(
            vec![
                BikeCandidate {
                    node: 1,
                    edge: 0,
                    fraction: 0.2,
                    walk_meters: 20.,
                },
                BikeCandidate {
                    node: 1,
                    edge: 0,
                    fraction: 0.8,
                    walk_meters: 0.,
                },
                BikeCandidate {
                    node: 1,
                    edge: 0,
                    fraction: 2.,
                    walk_meters: 100.,
                },
            ],
            1.,
            true,
        );
        let ends = Attachment::from_candidates(
            vec![BikeCandidate {
                node: 0,
                edge: 0,
                fraction: 0.5,
                walk_meters: 0.,
            }],
            1.,
            false,
        );
        let field = bike
            .bike_field(starts, opt, None, f64::INFINITY, None, None)
            .unwrap();
        let result = bike
            .field_candidate(&field, &ends, opt, None)
            .unwrap()
            .unwrap();
        assert!(
            (result.3 - 26.).abs() < 1e-9,
            "20 seconds walking + 30 meters cycling at 5 m/s"
        );
    }
}
