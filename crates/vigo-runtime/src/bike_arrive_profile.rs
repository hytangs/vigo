//! Forward departure profiles preserve the existing via-way automaton. Each
//! label covers an interval with constant prefix cost. The first unavoidable
//! wait fixes departure and reduces that interval to a point. No time-expanded
//! graph or reverse turn automaton is retained.
use super::*;

const LABEL_LIMIT: usize = 262_144;

#[derive(Clone)]
struct ProfileLabel {
    base: Label,
    low: f64,
    high: f64,
    wait: f64,
}

#[derive(Default)]
struct MovementRanges {
    first: Option<(f64, f64, f64, TurnState)>,
    later: Vec<(f64, f64, f64, TurnState)>,
}
impl MovementRanges {
    fn push(&mut self, low: f64, high: f64, wait: f64, state: TurnState) {
        if low > high {
            return;
        }
        let value = (low, high, wait, state);
        if self.first.is_none() {
            self.first = Some(value);
        } else {
            self.later.push(value);
        }
    }
    fn into_iter(self) -> impl Iterator<Item = (f64, f64, f64, TurnState)> {
        self.first.into_iter().chain(self.later)
    }
}

impl BikeKernel {
    #[expect(
        clippy::too_many_arguments,
        reason = "Keep routing bounds and attachment policy explicit at the search boundary."
    )]
    fn movement_ranges(
        &self,
        state: &TurnState,
        incoming: Option<u32>,
        node: u32,
        outgoing: u32,
        clock: BikeClock,
        low: f64,
        high: f64,
        waiting: bool,
    ) -> Result<MovementRanges, String> {
        let mut result = MovementRanges::default();
        if low > high {
            return Ok(result);
        }
        let mut time = low;
        for change in 0..=4096 {
            if change == 4096 {
                return Err("Bicycle arrival profile exceeded its movement change limit".into());
            }
            let next = self.movement_next_change(state, incoming, node, outgoing, clock, time);
            let end = next.filter(|&t| t <= high).map_or(high, |t| {
                // Schedules are half-open in absolute time, including DST folds.
                (clock.epoch + t).next_down() - clock.epoch
            });
            if let Some((_, state)) = self
                .movements(
                    state,
                    incoming,
                    node,
                    outgoing,
                    Some(BikeClock {
                        epoch: clock.epoch + time,
                        ..clock
                    }),
                    0.,
                    SearchKind::Frozen,
                    false,
                )?
                .first
            {
                result.push(time, end, 0., state);
            }
            let Some(next) = next.filter(|&t| t <= high) else {
                break;
            };
            if next <= time {
                return Err("Bicycle arrival profile did not advance its clock".into());
            }
            time = next;
        }
        if waiting {
            for (departure, state) in self
                .movements(
                    state,
                    incoming,
                    node,
                    outgoing,
                    Some(clock),
                    high,
                    SearchKind::Normal,
                    true,
                )?
                .into_iter()
            {
                if departure > high {
                    result.push(departure, departure, departure - high, state);
                }
            }
        }
        Ok(result)
    }

    /// Prove or improve a feasible dated arrival candidate. Every improving
    /// route starts no earlier than -upper/factor, since each physical second
    /// costs at least factor. Times are relative to the requested deadline.
    #[expect(
        clippy::too_many_arguments,
        reason = "Keep routing bounds and attachment policy explicit at the search boundary."
    )]
    pub(super) fn arrival_profile(
        &self,
        origin: [f64; 2],
        destination: [f64; 2],
        opt: BikeOptions,
        starts: &Attachment,
        ends: &Attachment,
        max_distance: f64,
        clock: BikeClock,
        candidate: BikeResult,
        max_elapsed: Option<f64>,
    ) -> Result<BikeResult, String> {
        let factor = if matches!(opt.profile, Profile::Fast) {
            1.
        } else {
            0.8
        };
        let upper = candidate.cost.unwrap_or(f64::INFINITY);
        let horizon = (upper / factor * (1. + 1e-12)).min(max_elapsed.unwrap_or(f64::INFINITY));
        if !horizon.is_finite()
            || chrono::DateTime::from_timestamp((clock.epoch - horizon).floor() as i64, 0).is_none()
        {
            return Err("Bicycle arrival profile exceeded the supported calendar range".into());
        }
        // A distance cap cannot bind if even the fastest possible travel
        // over the entire improving horizon stays below it. Avoid keeping
        // distance trade-offs in that common case, without weakening the cap.
        let mut max_speed = (opt.speed_kph * 1.24).clamp(3., 45.).max(4.) / 3.6;
        for attachment in [starts, ends] {
            for i in 0..attachment.candidates.len() {
                let c = attachment.candidate(&self.graph(), i);
                if c.walk_seconds > 0. {
                    max_speed = max_speed.max(c.walk_meters / c.walk_seconds);
                }
            }
        }
        let remaining_time = self.costs_to(
            ends,
            BikeOptions {
                profile: Profile::Fast,
                ..opt
            },
            false,
        );
        let remaining_excess = self.costs_to(ends, opt, true);
        let destination_access: HashSet<_> = starts
            .candidates
            .iter()
            .chain(&ends.candidates)
            .filter(|c| self.attributes[c.edge as usize] & (1 << 22) != 0)
            .map(|c| self.destination_components[self.source(c.edge) as usize])
            .collect();
        let mut ending = HashMap::<u32, Vec<usize>>::new();
        for (i, b) in ends.candidates.iter().enumerate() {
            ending.entry(b.node).or_default().push(i);
        }
        let mut labels = Vec::<ProfileLabel>::new();
        let mut frontier = HashMap::<(u32, Option<u32>, u32), Vec<usize>>::new();
        let mut queue = BinaryHeap::new();
        let mut states = vec![TurnState::new()];
        let mut state_ids = HashMap::from([(TurnState::new(), 0u32)]);
        let mut intern = |state: TurnState| {
            if state.is_empty() {
                0
            } else {
                *state_ids.entry(state.clone()).or_insert_with(|| {
                    let id = states.len() as u32;
                    states.push(state);
                    id
                })
            }
        };
        // Keep immutable path records: inactive labels may still be parents.
        // Subtract the union of intervals dominated by existing prefixes. An
        // earlier prefix can wait, at factor per second, to emulate a later one.
        let insert = |mut label: ProfileLabel,
                      labels: &mut Vec<ProfileLabel>,
                      frontier: &mut HashMap<(u32, Option<u32>, u32), Vec<usize>>,
                      queue: &mut BinaryHeap<Queue>,
                      best: f64|
         -> Result<(), String> {
            label.high = label
                .high
                .min(-remaining_time[label.base.node as usize] * (1. - 1e-12));
            if label.low > label.high || label.base.meters > max_distance {
                return Ok(());
            }
            let incoming = label
                .base
                .incoming()
                .filter(|&edge| self.attributes[edge as usize] & (NODE_TURN | WAY_TURN) != 0);
            let key = (label.base.node, incoming, label.base.state);
            let known = frontier.entry(key).or_default();
            let constrained =
                max_distance < (best / factor).min(horizon) * max_speed * (1. + 1e-12);
            let mut pieces = vec![(label.low, label.high)];
            for &id in known.iter() {
                let old = &labels[id];
                if old.base.cost > label.base.cost
                    || (constrained && old.base.meters > label.base.meters)
                {
                    continue;
                }
                let left = old.low;
                let right = old.high + (label.base.cost - old.base.cost) / factor;
                let mut next = Vec::new();
                for (lo, hi) in pieces {
                    if hi < left || lo > right {
                        next.push((lo, hi));
                        continue;
                    }
                    if lo < left {
                        next.push((lo, left.next_down()));
                    }
                    if hi > right {
                        next.push((right.next_up(), hi));
                    }
                }
                pieces = next;
                if pieces.is_empty() {
                    return Ok(());
                }
            }
            for (low, high) in pieces {
                let bound = label.base.cost - factor * high
                    + remaining_excess[label.base.node as usize] * (1. - 1e-12);
                if bound >= best {
                    continue;
                }
                if labels.len() >= LABEL_LIMIT {
                    return Err("Bicycle arrival profile exceeded its 262144-label work limit; shorten the route or distance limit".into());
                }
                let id = labels.len();
                known.retain(|&i| {
                    let old = &labels[i];
                    let dominated = label.base.cost <= old.base.cost
                        && (!constrained || label.base.meters <= old.base.meters)
                        && low <= old.low
                        && high + (old.base.cost - label.base.cost) / factor >= old.high;
                    if dominated {
                        labels[i].base.active = false;
                    }
                    !dominated
                });
                known.push(id);
                labels.push(ProfileLabel {
                    low,
                    high,
                    ..label.clone()
                });
                queue.push(Queue(bound, id));
            }
            Ok(())
        };
        let mut best = upper;
        // label, start, end, arrival at final partial edge, final wait, end slack
        let mut winner: Option<(Option<usize>, usize, usize, f64, f64, f64)> = None;
        for i in 0..starts.candidates.len() {
            let a = starts.candidate(&self.graph(), i);
            // Same-edge routes may end before reaching any graph node.
            if let Some(ids) = ending.get(&self.source(a.edge)) {
                for &j in ids {
                    let b = ends.candidate(&self.graph(), j);
                    if a.edge != b.edge || b.fraction < a.fraction {
                        continue;
                    }
                    let meters =
                        (b.fraction - a.fraction) * self.distances[a.edge as usize] as f64 / 100.;
                    if a.walk_meters + meters + b.walk_meters > max_distance {
                        continue;
                    }
                    let tail = meters * self.metric(a.edge, opt).0 + b.walk_seconds;
                    let ranges = if meters > 1e-7 {
                        self.movement_ranges(
                            &TurnState::new(),
                            None,
                            self.source(a.edge),
                            a.edge,
                            clock,
                            -horizon + a.walk_seconds,
                            -tail,
                            false,
                        )?
                    } else {
                        let mut r = MovementRanges::default();
                        r.push(-horizon + a.walk_seconds, -tail, 0., vec![]);
                        r
                    };
                    for (_, high, _, _) in ranges.into_iter() {
                        let slack = (-high - tail).max(0.);
                        let cost = a.walk_seconds
                            + b.walk_seconds
                            + meters * self.metric(a.edge, opt).1
                            + factor * slack;
                        if cost < best {
                            best = cost;
                            winner = Some((None, i, j, high, 0., slack));
                        }
                    }
                }
            }
            let (seconds, cost) = self.metric(a.edge, opt);
            let ranges = if a.drive_meters > 1e-7 {
                self.movement_ranges(
                    &TurnState::new(),
                    None,
                    self.source(a.edge),
                    a.edge,
                    clock,
                    -horizon + a.walk_seconds,
                    -a.drive_meters * seconds,
                    false,
                )?
            } else {
                let mut r = MovementRanges::default();
                r.push(-horizon + a.walk_seconds, 0., 0., vec![]);
                r
            };
            for (low, high, _, state) in ranges.into_iter() {
                insert(
                    ProfileLabel {
                        base: Label {
                            node: a.node,
                            incoming: if a.drive_meters > 1e-7 {
                                a.edge
                            } else {
                                u32::MAX
                            },
                            state: intern(state),
                            cost: a.walk_seconds + a.drive_meters * cost,
                            meters: a.walk_meters + a.drive_meters,
                            parent: u32::MAX,
                            start: i as u32,
                            active: true,
                        },
                        low: low + a.drive_meters * seconds,
                        high: high + a.drive_meters * seconds,
                        wait: 0.,
                    },
                    &mut labels,
                    &mut frontier,
                    &mut queue,
                    best,
                )?;
            }
        }
        let mut settled = 0;
        while let Some(Queue(bound, id)) = queue.pop() {
            if bound >= best {
                break;
            }
            let label = labels[id].clone();
            if !label.base.active {
                continue;
            }
            settled += 1;
            let state = states[label.base.state as usize].clone();
            if let Some(ids) = ending.get(&label.base.node) {
                for &j in ids {
                    let b = ends.candidate(&self.graph(), j);
                    if label.base.meters + b.walk_meters + b.drive_meters > max_distance {
                        continue;
                    }
                    let tail = b.drive_meters * self.metric(b.edge, opt).0 + b.walk_seconds;
                    let ranges = if b.drive_meters > 1e-7 {
                        self.movement_ranges(
                            &state,
                            label.base.incoming(),
                            label.base.node,
                            b.edge,
                            clock,
                            label.low,
                            label.high,
                            true,
                        )?
                    } else {
                        let mut r = MovementRanges::default();
                        r.push(label.low, label.high, 0., vec![]);
                        r
                    };
                    for (low, high, wait, _) in ranges.into_iter() {
                        let departure = high.min(-tail);
                        if departure < low {
                            continue;
                        }
                        let slack = (-departure - tail).max(0.);
                        let cost = label.base.cost
                            + b.walk_seconds
                            + b.drive_meters * self.metric(b.edge, opt).1
                            + factor * (wait + slack);
                        if cost < best {
                            best = cost;
                            winner = Some((
                                Some(id),
                                label.base.start as usize,
                                j,
                                departure - wait,
                                wait,
                                slack,
                            ));
                        }
                    }
                }
            }
            for edge in
                self.offsets[label.base.node as usize]..self.offsets[label.base.node as usize + 1]
            {
                if !self.allowed_edge(edge, opt)
                    || (self.attributes[edge as usize] & (1 << 22) != 0
                        && !destination_access
                            .contains(&self.destination_components[label.base.node as usize]))
                {
                    continue;
                }
                let meters = self.distances[edge as usize] as f64 / 100.;
                let (seconds, cost) = self.metric(edge, opt);
                if label.base.meters + meters > max_distance {
                    continue;
                }
                for (low, high, wait, next) in self
                    .movement_ranges(
                        &state,
                        label.base.incoming(),
                        label.base.node,
                        edge,
                        clock,
                        label.low,
                        label.high,
                        true,
                    )?
                    .into_iter()
                {
                    let next = if next.is_empty() {
                        0
                    } else {
                        *state_ids.entry(next.clone()).or_insert_with(|| {
                            let id = states.len() as u32;
                            states.push(next);
                            id
                        })
                    };
                    insert(
                        ProfileLabel {
                            base: Label {
                                node: self.targets[edge as usize],
                                incoming: edge,
                                state: next,
                                cost: label.base.cost + meters * cost + factor * wait,
                                meters: label.base.meters + meters,
                                parent: id as u32,
                                start: label.base.start,
                                active: true,
                            },
                            low: low + meters * seconds,
                            high: high + meters * seconds,
                            wait,
                        },
                        &mut labels,
                        &mut frontier,
                        &mut queue,
                        best,
                    )?;
                }
            }
        }
        let mut result = candidate;
        result.settled_labels += settled;
        result.timing_policy = "dated_arrive_by_verified";
        result.temporal_valid = true;
        if result.status != "ready" {
            result.reason = Some("no_path");
        }
        let Some((label, start, end, mut time, final_wait, slack)) = winner else {
            return Ok(result);
        };
        let a = starts.candidate(&self.graph(), start);
        let b = ends.candidate(&self.graph(), end);
        let mut parts = Vec::new();
        if let Some(mut id) = label {
            parts.push((
                b.edge,
                b.drive_meters,
                self.point(b.node),
                b.road,
                final_wait,
            ));
            while labels[id].base.parent != u32::MAX {
                let parent = labels[id].base.parent;
                let edge = labels[id].base.incoming().unwrap();
                let meters = self.distances[edge as usize] as f64 / 100.;
                let wait = labels[id].wait;
                parts.push((
                    edge,
                    meters,
                    self.point(self.source(edge)),
                    self.point(self.targets[edge as usize]),
                    wait,
                ));
                time -= meters * self.metric(edge, opt).0 + wait;
                id = parent as usize;
            }
            parts.push((a.edge, a.drive_meters, a.road, self.point(a.node), 0.));
            time -= a.drive_meters * self.metric(a.edge, opt).0;
            parts.reverse();
        } else {
            parts.push((
                a.edge,
                (b.fraction - a.fraction) * self.distances[a.edge as usize] as f64 / 100.,
                a.road,
                b.road,
                0.,
            ));
        }
        // Independently replay at absolute instants before publishing a proof.
        let mut incoming = None;
        let mut state = TurnState::new();
        for &(edge, meters, _, _, wait) in &parts {
            if meters < 1e-7 {
                continue;
            }
            time += wait;
            let Some((_, next)) = self
                .movements(
                    &state,
                    incoming,
                    self.source(edge),
                    edge,
                    Some(BikeClock {
                        epoch: clock.epoch + time,
                        ..clock
                    }),
                    0.,
                    SearchKind::Frozen,
                    false,
                )?
                .first
            else {
                return Err("Bicycle arrival profile failed dated path verification".into());
            };
            time += meters * self.metric(edge, opt).0;
            incoming = Some(edge);
            state = next;
        }
        if time + b.walk_seconds > 1e-6 {
            return Err("Bicycle arrival profile exceeded its arrival deadline".into());
        }
        result.status = "ready";
        result.reason = None;
        result.cost = Some(best);
        result.end_wait_seconds = slack;
        result.legs = self.path_legs(origin, destination, opt, a, b, parts)?;
        Ok(result)
    }
}
