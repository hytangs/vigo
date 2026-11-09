//! Many-to-one arrival certificates. Reverse cost search retains node-turn
//! alternatives; full forward replay certifies via-way history and dated entry.
//! Exact point routing handles every path the relaxed field cannot prove.
use super::many::BikeManyResult;
use super::*;

// Label, start attachment, end attachment, cost, seconds, tied, meters.
type ReverseCandidate = (Option<usize>, usize, usize, f64, f64, bool, f64);

#[derive(Clone, Copy)]
struct ReverseLabel {
    node: u32,
    // CSR edge ids and bounded label ids leave u32::MAX available as absent.
    edge: u32,
    parent: u32,
    end: u32,
    cost: f64,
    seconds: f64,
    meters: f64,
    settled: bool,
    tied: bool,
}
impl ReverseLabel {
    fn edge(&self) -> Option<u32> {
        (self.edge != u32::MAX).then_some(self.edge)
    }
}
struct ReverseField {
    ends: Attachment,
    end_edges: Vec<u32>,
    labels: Vec<ReverseLabel>,
    direct: Vec<u32>,
    by_node: HashMap<u32, Vec<usize>>,
    certified_cost: f64,
    settled: usize,
    queued: usize,
    limited: bool,
    distances: bool,
}
struct ReverseLinks {
    head: Vec<u32>,
    next: Vec<u32>,
}

impl BikeKernel {
    #[cfg(any(feature = "standalone", test))]
    #[expect(
        clippy::too_many_arguments,
        reason = "Keep routing bounds and attachment policy explicit at the search boundary."
    )]
    pub(crate) fn many_to(
        &self,
        origins: &[[f64; 2]],
        destination: [f64; 2],
        opt: BikeOptions,
        max_walk: f64,
        walk_speed: f64,
        max_distance: f64,
        clock: Option<BikeClock>,
        maximum_seconds: f64,
        max_elapsed: Option<f64>,
    ) -> Result<BikeManyResult, String> {
        self.surface_to(
            destination,
            origins,
            opt,
            max_walk,
            walk_speed,
            max_distance,
            clock,
            maximum_seconds,
            max_elapsed,
        )
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "Keep routing bounds and attachment policy explicit at the search boundary."
    )]
    pub(crate) fn many_to_metrics(
        &self,
        origins: &[[f64; 2]],
        destination: [f64; 2],
        opt: BikeOptions,
        max_walk: f64,
        walk_speed: f64,
        max_distance: f64,
        clock: Option<BikeClock>,
        maximum_seconds: f64,
        max_elapsed: Option<f64>,
        distances: bool,
    ) -> Result<BikeManyResult, String> {
        self.validate_request(
            destination,
            destination,
            opt,
            max_walk,
            walk_speed,
            max_distance,
            clock,
        )?;
        if origins.iter().any(|p| {
            !p[0].is_finite() || !p[1].is_finite() || p[0].abs() > 180. || p[1].abs() > 90.
        }) || !maximum_seconds.is_finite()
            || maximum_seconds <= 0.
            || max_elapsed.is_some_and(|v| !v.is_finite() || v < 0.)
        {
            return Err("Invalid bicycle arrival grid coordinates or limits".into());
        }
        let mut result = BikeManyResult {
            seconds: vec![f64::INFINITY; origins.len()],
            meters: if distances {
                vec![f64::INFINITY; origins.len()]
            } else {
                Vec::new()
            },
            settled_labels: 0,
            certified_targets: 0,
            fallback_targets: 0,
            tree_limited: false,
            fallback_reasons: Default::default(),
            scoped_trees: 0,
            attachment_certificates: 0,
            access_groups: 0,
            access_group_key_bytes: 0,
            access_group_limit_targets: 0,
        };
        let graph = self.graph();
        let eligible = |edge| {
            self.allowed_edge(edge, opt)
                && (clock.is_some() || self.attributes[edge as usize] & TIMED_EDGE == 0)
        };
        let ratio = (0..self.targets.len()).fold(1f64, |maximum, edge| {
            let (seconds, cost) = self.metric(edge as u32, opt);
            maximum.max(cost / seconds)
        });
        let ceiling = maximum_seconds * ratio * (1. + 1e-12);
        let field = self
            .reverse_links()
            .map(|links| {
                let ends = self.attach_bicycle_matching(
                    &graph,
                    destination,
                    max_walk,
                    walk_speed / 3.6,
                    false,
                    false,
                    &eligible,
                )?;
                Ok::<_, String>(
                    self.reverse_field_metrics(ends, opt, clock, ceiling, &links, distances),
                )
            })
            .transpose()?;
        if let Some(field) = &field {
            result.settled_labels += field.settled;
            result.tree_limited |= field.limited;
        } else {
            result.tree_limited = true;
        }
        let mut missing = Vec::new();
        let mut fallback = Vec::new();
        for (target, &origin) in origins.iter().enumerate() {
            let mut reason = "reverse_index_limit";
            let mut certified = None;
            if let Some(field) = &field {
                let starts = self.attach_bicycle_matching(
                    &graph,
                    origin,
                    max_walk,
                    walk_speed / 3.6,
                    true,
                    false,
                    &eligible,
                )?;
                (certified, reason) =
                    self.reverse_duration(field, &starts, opt, max_distance, clock, max_elapsed)?;
                if certified.is_none() && reason == "no_tree_path" && !field.limited {
                    missing.push(target);
                    continue;
                }
            }
            if let Some((seconds, meters)) = certified {
                result.certified_targets += 1;
                result.record(target, seconds, meters, maximum_seconds);
            } else {
                result.fallback_targets += 1;
                *result.fallback_reasons.entry(reason).or_default() += 1;
                fallback.push(target);
            }
        }
        // Neither shared field overlaps the exact router's temporary search
        // allocations. Only origin indices survive into the fallback phase.
        drop(field);
        if !missing.is_empty() {
            let wider = self
                .attach_bicycle_fallback(
                    &graph,
                    destination,
                    max_walk,
                    walk_speed / 3.6,
                    false,
                    &eligible,
                )
                .ok()
                .and_then(|ends| {
                    self.reverse_links().map(|links| {
                        self.reverse_field_metrics(ends, opt, clock, ceiling, &links, distances)
                    })
                });
            if let Some(field) = &wider {
                result.settled_labels += field.settled;
                result.tree_limited |= field.limited;
            }
            for target in missing {
                let absent = wider.as_ref().filter(|f| !f.limited).is_some_and(|field| {
                    self.attach_bicycle_fallback(
                        &graph,
                        origins[target],
                        max_walk,
                        walk_speed / 3.6,
                        true,
                        &eligible,
                    )
                    .ok()
                    .is_some_and(|starts| {
                        self.reverse_candidate(field, &starts, opt, clock).is_none()
                    })
                });
                if absent {
                    result.certified_targets += 1;
                } else {
                    result.fallback_targets += 1;
                    *result.fallback_reasons.entry("no_tree_path").or_default() += 1;
                    fallback.push(target);
                }
            }
        }
        for target in fallback {
            let route = self.route_arrive_limited(
                origins[target],
                destination,
                opt,
                max_walk,
                walk_speed,
                max_distance,
                clock,
                max_elapsed,
            )?;
            result.settled_labels += route.settled_labels;
            let seconds = route.elapsed_seconds();
            if route.status == "ready" && seconds <= maximum_seconds {
                result.record(
                    target,
                    seconds,
                    route.legs.iter().map(|l| l.meters).sum(),
                    maximum_seconds,
                );
            }
        }
        Ok(result)
    }

    fn reverse_links(&self) -> Option<ReverseLinks> {
        // Bound auxiliary reverse links independently of the label budget.
        // Large graphs retain their exact point path rather than allocating an
        // unbounded second adjacency index for this optional accelerator.
        (self.lons.len().saturating_add(self.targets.len()) <= 8 * 1024 * 1024).then(|| {
            let mut head = vec![u32::MAX; self.lons.len()];
            let mut next = vec![u32::MAX; self.targets.len()];
            for (edge, &node) in self.targets.iter().enumerate() {
                next[edge] = head[node as usize];
                head[node as usize] = edge as u32;
            }
            ReverseLinks { head, next }
        })
    }

    fn reverse_needs_turn_state(&self, node: u32, links: &ReverseLinks) -> bool {
        if self.turns.is_empty() {
            return false;
        }
        // Reuse the incoming-edge flags instead of duplicating the turn-node
        // set in query scratch. Ordinary junctions have only a few in-edges.
        let mut edge = links.head[node as usize];
        while edge != u32::MAX {
            if self.attributes[edge as usize] & NODE_TURN != 0 {
                return true;
            }
            edge = links.next[edge as usize];
        }
        false
    }

    fn reverse_node_turn(
        &self,
        incoming: Option<u32>,
        node: u32,
        outgoing: Option<u32>,
        dated: bool,
    ) -> bool {
        let Some(outgoing) = outgoing else {
            return true;
        };
        let turns = incoming
            .filter(|&edge| self.attributes[edge as usize] & NODE_TURN != 0)
            .and_then(|edge| self.turns.get(&(node, self.ways[edge as usize])))
            .map_or(&[][..], |turns| &turns[..]);
        // A conditional only-turn may permit another branch of an OR group;
        // all such alternatives must remain available in this lower bound.
        (dated && turns.iter().any(|turn| turn.window != 0))
            || self.allowed_turns_at(turns, incoming, outgoing, None, 0.)
    }

    #[cfg(test)]
    fn reverse_field(
        &self,
        ends: Attachment,
        opt: BikeOptions,
        clock: Option<BikeClock>,
        ceiling: f64,
        links: &ReverseLinks,
    ) -> ReverseField {
        self.reverse_field_metrics(ends, opt, clock, ceiling, links, false)
    }

    fn reverse_field_metrics(
        &self,
        ends: Attachment,
        opt: BikeOptions,
        clock: Option<BikeClock>,
        ceiling: f64,
        links: &ReverseLinks,
        distances: bool,
    ) -> ReverseField {
        let mut end_edges: Vec<_> = (0..ends.candidates.len() as u32).collect();
        end_edges.sort_unstable_by_key(|&i| ends.candidates[i as usize].edge);
        let mut field = ReverseField {
            ends,
            end_edges,
            labels: vec![],
            direct: vec![u32::MAX; super::many::field_node_slots(self.lons.len())],
            by_node: HashMap::new(),
            certified_cost: ceiling,
            settled: 0,
            queued: 0,
            limited: false,
            distances,
        };
        let mut frontier = HashMap::<(u32, Option<u32>), usize>::new();
        let mut queue = BinaryHeap::new();
        let insert = |mut label: ReverseLabel,
                      field: &mut ReverseField,
                      frontier: &mut HashMap<_, usize>,
                      queue: &mut BinaryHeap<Queue>| {
            if label.cost >= ceiling {
                return;
            }
            let key = (
                label.node,
                label
                    .edge()
                    .filter(|_| self.reverse_needs_turn_state(label.node, links)),
            );
            let ordinary = !field.direct.is_empty() && key.1.is_none();
            let previous = if ordinary {
                field.direct[label.node as usize] as usize
            } else {
                *frontier.get(&key).unwrap_or(&usize::MAX)
            };
            if previous < field.labels.len() {
                let old = &mut field.labels[previous];
                let tied = (old.cost - label.cost).abs()
                    <= 1e-12 * old.cost.max(label.cost).max(1.)
                    && (old.tied
                        || label.tied
                        || (old.seconds - label.seconds).abs() > 1e-7
                        || (distances && (old.meters - label.meters).abs() > 1e-7));
                if old.cost <= label.cost {
                    old.tied |= tied;
                    return;
                }
                // Only settled labels become parents. Positive edge costs mean
                // an unsettled record can be improved in place without changing
                // any existing child path; stale heap entries carry the old cost.
                // Count every replacement toward the work budget as well, so
                // the heap stays bounded even when a state improves repeatedly.
                debug_assert!(!old.settled);
                label.tied |= tied;
                field.queued += 1;
                queue.push(Queue(label.cost, previous));
                *old = label;
                return;
            }
            let id = field.labels.len();
            if ordinary {
                field.direct[label.node as usize] = id as u32;
            } else {
                frontier.insert(key, id);
                field.by_node.entry(label.node).or_default().push(id);
            }
            field.queued += 1;
            queue.push(Queue(label.cost, id));
            field.labels.push(label);
        };
        for i in 0..field.ends.candidates.len() {
            let b = field.ends.candidate(&self.graph(), i);
            let (seconds, cost) = self.metric(b.edge, opt);
            insert(
                ReverseLabel {
                    node: b.node,
                    edge: if b.drive_meters > 1e-7 {
                        b.edge
                    } else {
                        u32::MAX
                    },
                    parent: u32::MAX,
                    end: i as u32,
                    cost: b.walk_seconds + b.drive_meters * cost,
                    seconds: b.walk_seconds + b.drive_meters * seconds,
                    meters: b.walk_meters + b.drive_meters,
                    settled: false,
                    tied: false,
                },
                &mut field,
                &mut frontier,
                &mut queue,
            );
        }
        let label_limit = if distances {
            262_144
        } else {
            super::many::field_label_limit()
        };
        'search: while let Some(Queue(cost, id)) = queue.pop() {
            if field.labels[id].settled || cost > field.labels[id].cost {
                continue;
            }
            if field.queued >= label_limit {
                field.certified_cost = cost;
                field.limited = true;
                break;
            }
            field.settled += 1;
            field.labels[id].settled = true;
            let label = field.labels[id];
            let mut edge = links.head[label.node as usize];
            while edge != u32::MAX {
                if self.allowed_edge(edge, opt)
                    && (clock.is_some() || self.attributes[edge as usize] & TIMED_EDGE == 0)
                    && self.reverse_node_turn(Some(edge), label.node, label.edge(), clock.is_some())
                {
                    if field.queued >= label_limit {
                        field.certified_cost = cost;
                        field.limited = true;
                        break 'search;
                    }
                    let meters = self.distances[edge as usize] as f64 / 100.;
                    let (seconds, cost) = self.metric(edge, opt);
                    insert(
                        ReverseLabel {
                            node: self.source(edge),
                            edge,
                            parent: id as u32,
                            end: label.end,
                            cost: label.cost + meters * cost,
                            seconds: label.seconds + meters * seconds,
                            meters: label.meters + meters,
                            settled: false,
                            tied: label.tied,
                        },
                        &mut field,
                        &mut frontier,
                        &mut queue,
                    );
                }
                edge = links.next[edge as usize];
            }
        }
        field
    }

    // (field label, start attachment, end attachment, cost, seconds, tied)
    fn reverse_candidate(
        &self,
        field: &ReverseField,
        starts: &Attachment,
        opt: BikeOptions,
        clock: Option<BikeClock>,
    ) -> Option<ReverseCandidate> {
        let mut best = field.certified_cost;
        let mut winner = None;
        let mut consider = |label, start, end, cost: f64, seconds: f64, tied, meters: f64| {
            let near = (best - cost).abs() <= 1e-12 * best.max(cost).max(1.);
            let ambiguous = near
                && winner.is_some_and(
                    |(_, _, _, _, old_seconds, old_tied, old_meters): (
                        Option<usize>,
                        usize,
                        usize,
                        f64,
                        f64,
                        bool,
                        f64,
                    )| {
                        old_tied
                            || tied
                            || (old_seconds - seconds).abs() > 1e-7
                            || (field.distances && (old_meters - meters).abs() > 1e-7)
                    },
                );
            if cost < best {
                best = cost;
                winner = Some((label, start, end, cost, seconds, tied || ambiguous, meters));
            } else if ambiguous && let Some(winner) = &mut winner {
                winner.5 = true;
            }
        };
        for i in 0..starts.candidates.len() {
            let a = starts.candidate(&self.graph(), i);
            let first = field
                .end_edges
                .partition_point(|&j| field.ends.candidates[j as usize].edge < a.edge);
            for &end in field.end_edges[first..]
                .iter()
                .take_while(|&&j| field.ends.candidates[j as usize].edge == a.edge)
            {
                let j = end as usize;
                let b = field.ends.candidate(&self.graph(), j);
                if b.fraction >= a.fraction {
                    let meters =
                        (b.fraction - a.fraction) * self.distances[a.edge as usize] as f64 / 100.;
                    let (seconds, cost) = self.metric(a.edge, opt);
                    consider(
                        None,
                        i,
                        j,
                        a.walk_seconds + b.walk_seconds + meters * cost,
                        a.walk_seconds + b.walk_seconds + meters * seconds,
                        false,
                        a.walk_meters + b.walk_meters + meters,
                    );
                }
            }
            let ordinary = field
                .direct
                .get(a.node as usize)
                .copied()
                .unwrap_or(u32::MAX) as usize;
            for id in (ordinary < field.labels.len())
                .then_some(ordinary)
                .into_iter()
                .chain(field.by_node.get(&a.node).into_iter().flatten().copied())
            {
                let label = &field.labels[id];
                if self.reverse_node_turn(
                    (a.drive_meters > 1e-7).then_some(a.edge),
                    a.node,
                    label.edge(),
                    clock.is_some(),
                ) {
                    let (seconds, cost) = self.metric(a.edge, opt);
                    consider(
                        Some(id),
                        i,
                        label.end as usize,
                        a.walk_seconds + a.drive_meters * cost + label.cost,
                        a.walk_seconds + a.drive_meters * seconds + label.seconds,
                        label.tied,
                        a.walk_meters + a.drive_meters + label.meters,
                    );
                }
            }
        }
        winner
    }

    fn reverse_duration(
        &self,
        field: &ReverseField,
        starts: &Attachment,
        opt: BikeOptions,
        max_distance: f64,
        clock: Option<BikeClock>,
        max_elapsed: Option<f64>,
    ) -> CertifiedMetrics<(f64, f64)> {
        if starts.candidates.is_empty() || field.ends.candidates.is_empty() {
            return Ok((Some((f64::INFINITY, f64::INFINITY)), "no_attachment"));
        }
        let Some((label, start, end, _, seconds, tied, meters)) =
            self.reverse_candidate(field, starts, opt, clock)
        else {
            return Ok((None, "no_tree_path"));
        };
        if tied {
            return Ok((None, "duration_tie"));
        }
        if max_elapsed.is_some_and(|limit| seconds > limit) {
            return Ok((None, "service_clock"));
        }
        let a = starts.candidate(&self.graph(), start);
        let b = field.ends.candidate(&self.graph(), end);
        let mut parts = Vec::new();
        if let Some(mut id) = label {
            if a.walk_meters + a.drive_meters + field.labels[id].meters > max_distance {
                return Ok((None, "distance_limit"));
            }
            parts.push((a.edge, a.drive_meters));
            while field.labels[id].parent != u32::MAX {
                let parent = field.labels[id].parent;
                let edge = field.labels[id].edge().unwrap();
                parts.push((edge, self.distances[edge as usize] as f64 / 100.));
                id = parent as usize;
            }
            parts.push((b.edge, b.drive_meters));
        } else {
            let meters = (b.fraction - a.fraction) * self.distances[a.edge as usize] as f64 / 100.;
            if a.walk_meters + b.walk_meters + meters > max_distance {
                return Ok((None, "distance_limit"));
            }
            parts.push((a.edge, meters));
        }
        let access: HashSet<_> = starts
            .candidates
            .iter()
            .chain(&field.ends.candidates)
            .filter(|c| self.attributes[c.edge as usize] & (1 << 22) != 0)
            .map(|c| self.destination_components[self.source(c.edge) as usize])
            .collect();
        let clock = clock.map(|c| BikeClock {
            epoch: c.epoch - seconds,
            ..c
        });
        let mut elapsed = a.walk_seconds;
        let mut incoming = None;
        let mut state = TurnState::new();
        for (edge, meters) in parts {
            if meters < 1e-7 {
                continue;
            }
            if self.attributes[edge as usize] & (1 << 22) != 0
                && !access.contains(&self.destination_components[self.source(edge) as usize])
            {
                return Ok((None, "destination_access"));
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
                return Ok((None, "turn_or_timed_permission"));
            };
            if departure != elapsed {
                return Ok((None, "waiting"));
            }
            elapsed += meters * self.metric(edge, opt).0;
            incoming = Some(edge);
            state = next;
        }
        Ok((Some((elapsed + b.walk_seconds, meters)), "verified"))
    }
}

#[cfg(test)]
mod walk_attachment_tests {
    use super::*;
    use crate::drive_attachment::BikeCandidate;
    #[test]
    fn compact_reverse_labels_preserve_edge_zero_and_the_largest_valid_edge() {
        assert_eq!(std::mem::size_of::<ReverseLabel>(), 48);
        let mut label = ReverseLabel {
            node: 0,
            edge: u32::MAX,
            parent: u32::MAX,
            end: 0,
            cost: 0.,
            seconds: 0.,
            meters: 0.,
            settled: false,
            tied: false,
        };
        assert_eq!(label.edge(), None);
        for edge in [0, u32::MAX - 1] {
            label.edge = edge;
            assert_eq!(label.edge(), Some(edge));
        }
    }
    #[test]
    fn reverse_field_checks_every_match_on_the_same_edge() {
        let bike = super::super::tests::fixture(
            &[[0., 0.], [0.0008, 0.]],
            &[(0, 1, 10000, 1, (2 << 3) | (30 << 8) | (15 << 14))],
            &[],
        );
        let opt = BikeOptions {
            profile: Profile::Fast,
            ..Default::default()
        };
        let ends = Attachment::from_candidates(
            vec![
                BikeCandidate {
                    node: 0,
                    edge: 0,
                    fraction: 0.5,
                    walk_meters: 20.,
                },
                BikeCandidate {
                    node: 0,
                    edge: 0,
                    fraction: 0.1,
                    walk_meters: 0.,
                },
                BikeCandidate {
                    node: 0,
                    edge: 0,
                    fraction: 3.,
                    walk_meters: 100.,
                },
            ],
            1.,
            false,
        );
        let starts = Attachment::from_candidates(
            vec![BikeCandidate {
                node: 1,
                edge: 0,
                fraction: 0.2,
                walk_meters: 0.,
            }],
            1.,
            true,
        );
        let links = bike.reverse_links().unwrap();
        let field = bike.reverse_field(ends, opt, None, f64::INFINITY, &links);
        let result = bike
            .reverse_candidate(&field, &starts, opt, None)
            .expect("A directed same-edge route exists");
        assert!(
            (result.3 - 26.).abs() < 1e-9,
            "30 meters cycling at 5 m/s + 20 seconds walking"
        );
    }
}
