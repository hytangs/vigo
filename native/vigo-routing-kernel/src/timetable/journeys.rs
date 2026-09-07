//! Optional compact journeys from shared boarding rounds. Scalar Matrix keeps
//! its smaller CSA workspace. Both time directions use the same label arena;
//! reverse time is negated so dominance and boarding tests stay identical.
use super::*;

#[derive(Clone)]
#[napi(object)]
pub struct TimetableMatrixLeg {
    pub kind: String,
    pub from_stop: Option<u32>,
    pub to_stop: Option<u32>,
    pub trip: Option<u32>,
    pub board_sequence: Option<f64>,
    pub alight_sequence: Option<f64>,
    pub departure: f64,
    pub arrival: f64,
}

#[derive(Clone)]
#[napi(object)]
pub struct TimetableMatrixJourney {
    pub departure: f64,
    pub arrival: f64,
    pub boardings: u32,
    pub walking_seconds: f64,
    pub ride_seconds: f64,
    pub waiting_seconds: f64,
    pub legs: Vec<TimetableMatrixLeg>,
}

#[derive(Clone, Copy)]
struct Step {
    ride: bool,
    from_stop: Option<u32>,
    to_stop: Option<u32>,
    trip: Option<u32>,
    board_sequence: Option<f64>,
    alight_sequence: Option<f64>,
    departure: f64,
    arrival: f64,
}

impl From<Step> for TimetableMatrixLeg {
    fn from(step: Step) -> Self {
        Self {
            kind: if step.ride { "ride" } else { "walk" }.to_owned(),
            from_stop: step.from_stop,
            to_stop: step.to_stop,
            trip: step.trip,
            board_sequence: step.board_sequence,
            alight_sequence: step.alight_sequence,
            departure: step.departure,
            arrival: step.arrival,
        }
    }
}

#[derive(Clone, Copy)]
struct Label {
    stop: usize,
    time: f64,
    walking: f64,
    boardings: u32,
    // In reverse search, actual destination arrival breaks equal-walk ties.
    end: f64,
    transfer: bool,
    parent: Option<usize>,
    leg: Step,
    active: bool,
}

struct Labels {
    arena: Vec<Label>,
    fronts: Vec<Vec<usize>>,
    reverse: bool,
}

impl Labels {
    fn offer(&mut self, candidate: Label) -> napi::Result<()> {
        let state = candidate.stop * 4
            + usize::from(candidate.boardings > 0) * 2
            + usize::from(candidate.transfer);
        let dominates = |a: &Label, b: &Label| {
            a.time <= b.time
                && a.boardings <= b.boardings
                && a.walking <= b.walking
                && (!self.reverse
                    || a.boardings < b.boardings
                    || a.walking < b.walking
                    || a.end <= b.end)
        };
        if self.fronts[state]
            .iter()
            .any(|&i| dominates(&self.arena[i], &candidate))
        {
            return Ok(());
        }
        self.fronts[state].retain(|&i| {
            if dominates(&candidate, &self.arena[i]) {
                self.arena[i].active = false;
                false
            } else {
                true
            }
        });
        if self.arena.len() >= MAX_PARETO_LABELS {
            return Err(Error::from_reason(
                "Shared Matrix journey label capacity exceeded.",
            ));
        }
        self.fronts[state].push(self.arena.len());
        self.arena.push(candidate);
        Ok(())
    }

    fn transfer(
        &mut self,
        kernel: &TimetableKernel,
        index: usize,
        initial: bool,
        horizon: f64,
    ) -> napi::Result<()> {
        let source = self.arena[index];
        // In reverse, this is the next original boarding stop. A forbidden
        // interchange can still be a terminal access target, handled below.
        if self.reverse && !initial && kernel.forbidden_same_stop[source.stop] != 0 {
            return Ok(());
        }
        let (offsets, edges) = if self.reverse {
            (
                &kernel.reverse_transfer_offset,
                &kernel.reverse_transfer_edges,
            )
        } else {
            (&kernel.transfer_offset, &kernel.transfer_edges)
        };
        for edge in &edges[offsets[source.stop] as usize..offsets[source.stop + 1] as usize] {
            let walk = f64::from(edge.duration());
            if source.time + walk > horizon {
                continue;
            }
            self.offer(Label {
                stop: edge.stop(),
                time: source.time + walk,
                walking: source.walking + walk,
                transfer: true,
                parent: Some(index),
                leg: walk_leg(Some(source.stop as u32), Some(edge.stop() as u32), walk),
                ..source
            })?;
        }
        Ok(())
    }
}

fn walk_leg(from: Option<u32>, to: Option<u32>, seconds: f64) -> Step {
    Step {
        ride: false,
        from_stop: from,
        to_stop: to,
        trip: None,
        board_sequence: None,
        alight_sequence: None,
        departure: 0.0,
        arrival: seconds,
    }
}

impl TimetableKernel {
    pub(super) fn matrix_journeys(
        &self,
        input: &TimetableMatrixQueryInput,
        mut output: TimetableMatrixQueryResult,
    ) -> napi::Result<TimetableMatrixQueryResult> {
        let reverse = input.arrive_by;
        let origins = input.origin_offsets.len() - 1;
        let destinations = input.destination_offsets.len() - 1;
        let (
            source_offsets,
            source_stops,
            source_walks,
            target_offsets,
            target_stops,
            target_walks,
        ) = if reverse {
            (
                &input.destination_offsets,
                &input.destination_stops,
                &input.destination_walk_seconds,
                &input.origin_offsets,
                &input.origin_stops,
                &input.origin_walk_seconds,
            )
        } else {
            (
                &input.origin_offsets,
                &input.origin_stops,
                &input.origin_walk_seconds,
                &input.destination_offsets,
                &input.destination_stops,
                &input.destination_walk_seconds,
            )
        };
        output.journeys = Some(vec![None; origins * destinations]);
        let mut labels = Labels {
            arena: Vec::new(),
            fronts: vec![Vec::new(); self.stop_count * 4],
            reverse,
        };
        for source in 0..source_offsets.len() - 1 {
            // The scalar Matrix supplies exact primary bounds for this group.
            // No optimal witness needs an earlier AM departure or a later PM
            // arrival than the most distant reachable requested endpoint.
            let bound = (0..target_offsets.len() - 1)
                .map(|target| {
                    output.times[if reverse {
                        target * destinations + source
                    } else {
                        source * destinations + target
                    }]
                })
                .filter(|time| time.is_finite())
                .reduce(|a, b| if reverse { a.min(b) } else { a.max(b) });
            let Some(bound) = bound else {
                continue;
            };
            let minimum_time = if reverse { bound } else { input.departure };
            let maximum_time = if reverse {
                input.horizon
            } else {
                bound.min(input.horizon)
            };
            let start_time = if reverse { -maximum_time } else { minimum_time };
            let end_time = if reverse { -minimum_time } else { maximum_time };

            labels.arena.clear();
            for front in &mut labels.fronts {
                front.clear();
            }
            let initial_transfers = if reverse {
                input
                    .allow_post_ride_transfers
                    .as_ref()
                    .is_none_or(|flags| flags[source])
            } else {
                input.allow_pre_ride_transfers[source]
            };
            for seed in source_offsets[source] as usize..source_offsets[source + 1] as usize {
                labels.offer(Label {
                    stop: source_stops[seed] as usize,
                    time: start_time + source_walks[seed],
                    walking: source_walks[seed],
                    boardings: 0,
                    end: 0.0,
                    transfer: false,
                    parent: None,
                    leg: walk_leg(None, Some(source_stops[seed]), source_walks[seed]),
                    active: true,
                })?;
            }
            if initial_transfers {
                for seed in 0..labels.arena.len() {
                    if labels.arena[seed].active {
                        labels.transfer(self, seed, true, end_time)?;
                    }
                }
            }
            let maximum = input.maximum_boardings.unwrap_or(u32::MAX);
            let mut previous = 0..labels.arena.len();
            let mut run_generation = vec![0; self.run_count];
            let mut boarding_labels = vec![Vec::new(); self.stop_count];
            for round in 1..=maximum {
                // Freeze the previous round: zero-time connections and trip
                // order cannot consume two boardings in a single round.
                for frontier in &mut boarding_labels {
                    frontier.clear();
                }
                for i in previous.clone() {
                    if labels.arena[i].active {
                        boarding_labels[labels.arena[i].stop].push(i);
                    }
                }
                if boarding_labels.iter().all(Vec::is_empty) {
                    break;
                }
                // Only runs with a boardable event at a reached stop can
                // contribute in this round. Every target shares this work.
                let mut runs = Vec::new();
                let mut mark = |run: usize| {
                    if run_generation[run] != round {
                        run_generation[run] = round;
                        runs.push(run);
                    }
                };
                for (stop, frontier) in boarding_labels.iter().enumerate() {
                    let ready = frontier
                        .iter()
                        .map(|&i| {
                            let label = &labels.arena[i];
                            boarding_ready_time(
                                label.time,
                                label.boardings > 0,
                                !label.transfer,
                                self.same_stop_transfer_minimum[stop],
                            )
                        })
                        .fold(f64::INFINITY, f64::min);
                    if !ready.is_finite() {
                        continue;
                    }
                    if reverse {
                        let start = self.exit_event_offset[stop] as usize;
                        let end = self.exit_event_offset[stop + 1] as usize;
                        let first = exit_event_lower_bound(
                            &self.exit_events,
                            start,
                            end,
                            minimum_time.ceil() as u32,
                        );
                        for event in &self.exit_events[first..end] {
                            if f64::from(event.time()) > -ready {
                                break;
                            }
                            mark(event.run());
                        }
                    } else {
                        let start = departure_event_lower_bound(
                            &self.departure_events,
                            self.departure_offset[stop] as usize,
                            self.departure_offset[stop + 1] as usize,
                            ready,
                        );
                        for event in
                            &self.departure_events[start..self.departure_offset[stop + 1] as usize]
                        {
                            if f64::from(event.departure) > end_time {
                                break;
                            }
                            mark(event.run as usize);
                        }
                    }
                }
                runs.sort_unstable();
                let round_start = labels.arena.len();
                output.expanded_trip_runs += runs.len() as f64;
                for run in runs {
                    let first = self.run_start[run] as usize;
                    let last = self.run_end[run] as usize;
                    let mut boarding: Option<(usize, usize, f64, f64)> = None;
                    for step in 0..last - first {
                        let c = if reverse {
                            last - step - 1
                        } else {
                            first + step
                        };
                        let dep = f64::from(self.departure_seconds[c]);
                        let arr = f64::from(self.arrival_seconds[c]);
                        if dep < minimum_time || dep > maximum_time {
                            continue;
                        }
                        output.scanned_departures += 1.0;
                        let bridge = c > first
                            && self.continuity_break[c] == 0
                            && self.to_stop[c - 1] != self.from_stop[c];
                        if !reverse && bridge {
                            self.journey_exit(
                                &mut labels,
                                boarding,
                                self.from_stop[c] as usize,
                                dep,
                                f64::from(self.sequence[c - 1]) + 0.5,
                                round,
                                false,
                            )?;
                        }
                        let (stop, time, seq, allowed) = if reverse {
                            (
                                self.to_stop[c] as usize,
                                -arr,
                                f64::from(self.sequence[c]),
                                self.can_alight[c] != 0 && arr <= maximum_time,
                            )
                        } else {
                            (
                                self.from_stop[c] as usize,
                                dep,
                                f64::from(self.sequence[c]),
                                self.can_board[c] != 0,
                            )
                        };
                        if allowed {
                            self.journey_board(
                                &labels,
                                &boarding_labels[stop],
                                stop,
                                time,
                                seq,
                                c,
                                &mut boarding,
                            );
                        }
                        let (exit, time, allowed) = if reverse {
                            (self.from_stop[c] as usize, dep, self.can_board[c] != 0)
                        } else {
                            (
                                self.to_stop[c] as usize,
                                arr,
                                self.can_alight[c] != 0 && arr <= maximum_time,
                            )
                        };
                        if allowed {
                            self.journey_exit(
                                &mut labels,
                                boarding,
                                exit,
                                time,
                                f64::from(self.sequence[c]),
                                round,
                                reverse,
                            )?;
                        }
                        if reverse && bridge {
                            let stop = self.from_stop[c] as usize;
                            self.journey_board(
                                &labels,
                                &boarding_labels[stop],
                                stop,
                                -dep,
                                f64::from(self.sequence[c - 1]) + 0.5,
                                c - 1,
                                &mut boarding,
                            );
                        }
                    }
                }
                let direct_end = labels.arena.len();
                for i in round_start..direct_end {
                    if labels.arena[i].active && labels.arena[i].time <= end_time {
                        // A terminal transfer may finish after the ride horizon.
                        // The exact destination bound still limits that walk;
                        // run marking never boards beyond maximum_time.
                        labels.transfer(self, i, false, if reverse { end_time } else { bound })?;
                    }
                }
                previous = round_start..labels.arena.len();
            }
            output.relaxed_stops += labels.arena.len() as f64;
            for target in 0..target_offsets.len() - 1 {
                let allow_transfer = if reverse {
                    input.allow_pre_ride_transfers[target]
                } else {
                    input
                        .allow_post_ride_transfers
                        .as_ref()
                        .is_none_or(|v| v[target])
                };
                let mut best: Option<(usize, f64, Option<usize>, f64)> = None;
                for seed in target_offsets[target] as usize..target_offsets[target + 1] as usize {
                    let stop = target_stops[seed] as usize;
                    let walk = target_walks[seed];
                    let mut terminal = vec![(stop, walk, None)];
                    if reverse && allow_transfer {
                        for edge in &self.transfer_edges[self.transfer_offset[stop] as usize
                            ..self.transfer_offset[stop + 1] as usize]
                        {
                            terminal.push((
                                edge.stop(),
                                walk + f64::from(edge.duration()),
                                Some(stop),
                            ));
                        }
                    }
                    for (stop, access, transfer_stop) in terminal {
                        for phase in 0..=usize::from(!reverse && allow_transfer) {
                            for &i in &labels.fronts[stop * 4 + 2 + phase] {
                                let label = &labels.arena[i];
                                let time = label.time + access;
                                if reverse && time > end_time {
                                    continue;
                                }
                                let better = best.is_none_or(|(old, old_access, _, _)| {
                                    let previous = &labels.arena[old];
                                    time.total_cmp(&(previous.time + old_access))
                                        .then(label.boardings.cmp(&previous.boardings))
                                        .then(
                                            (label.walking + access)
                                                .total_cmp(&(previous.walking + old_access)),
                                        )
                                        .then(label.end.total_cmp(&previous.end))
                                        .is_lt()
                                });
                                if better {
                                    best = Some((i, access, transfer_stop, walk));
                                }
                            }
                        }
                    }
                }
                if let Some((index, access, transfer_stop, endpoint_walk)) = best {
                    let label = &labels.arena[index];
                    let time = label.time + access;
                    let cell = if reverse {
                        target * destinations + source
                    } else {
                        source * destinations + target
                    };
                    let selected_time = if reverse { -time } else { time };
                    if !output.times[cell].is_finite()
                        || (output.times[cell] - selected_time).abs() > 1e-7
                    {
                        return Err(Error::from_reason(
                            "Matrix journey disagrees with its exact scalar bound.",
                        ));
                    }
                    let mut legs = Vec::new();
                    let mut cursor = Some(index);
                    while let Some(i) = cursor {
                        let entry = &labels.arena[i];
                        let mut leg = entry.leg;
                        if reverse && !leg.ride {
                            std::mem::swap(&mut leg.from_stop, &mut leg.to_stop);
                        }
                        legs.push(leg);
                        cursor = entry.parent;
                    }
                    if reverse {
                        if let Some(stop) = transfer_stop {
                            legs.insert(
                                0,
                                walk_leg(
                                    Some(stop as u32),
                                    Some(label.stop as u32),
                                    access - endpoint_walk,
                                ),
                            );
                        }
                        legs.insert(
                            0,
                            walk_leg(
                                None,
                                Some(transfer_stop.unwrap_or(label.stop) as u32),
                                endpoint_walk,
                            ),
                        );
                    } else {
                        legs.reverse();
                        legs.push(walk_leg(Some(label.stop as u32), None, access));
                    }
                    let departure = if reverse { -time } else { input.departure };
                    let mut arrival = departure;
                    let mut walking = 0.0;
                    let mut riding = 0.0;
                    for leg in &mut legs {
                        if !leg.ride {
                            let duration = leg.arrival - leg.departure;
                            walking += duration;
                            leg.departure = arrival;
                            leg.arrival = arrival + duration;
                        } else {
                            riding += leg.arrival - leg.departure;
                        }
                        if leg.departure + 1e-7 < arrival {
                            return Err(Error::from_reason(
                                "Matrix journey has an infeasible connection.",
                            ));
                        }
                        arrival = leg.arrival;
                    }
                    output.journeys.as_mut().unwrap()[cell] = Some(TimetableMatrixJourney {
                        departure,
                        arrival,
                        boardings: label.boardings,
                        walking_seconds: walking,
                        ride_seconds: riding,
                        waiting_seconds: (arrival - departure - walking - riding).max(0.0),
                        legs: legs.into_iter().map(TimetableMatrixLeg::from).collect(),
                    });
                }
            }
            for target in 0..target_offsets.len() - 1 {
                let cell = if reverse {
                    target * destinations + source
                } else {
                    source * destinations + target
                };
                if output.times[cell].is_finite()
                    && output.journeys.as_ref().unwrap()[cell].is_none()
                {
                    return Err(Error::from_reason(
                        "Matrix scalar bound has no matching journey witness.",
                    ));
                }
            }
            if reverse {
                output.reverse_searches += 1;
            } else {
                output.forward_searches += 1;
            }
        }
        Ok(output)
    }

    #[allow(clippy::too_many_arguments)]
    fn journey_board(
        &self,
        labels: &Labels,
        candidates: &[usize],
        stop: usize,
        time: f64,
        sequence: f64,
        connection: usize,
        boarding: &mut Option<(usize, usize, f64, f64)>,
    ) {
        for &i in candidates {
            let label = &labels.arena[i];
            if label.boardings > 0
                && self.forbidden_same_stop[stop] != 0
                && (!labels.reverse || !label.transfer)
            {
                continue;
            }
            let ready = boarding_ready_time(
                label.time,
                label.boardings > 0,
                !label.transfer,
                self.same_stop_transfer_minimum[stop],
            );
            if ready > time {
                continue;
            }
            let end = if labels.reverse && label.boardings == 0 {
                -time + label.walking
            } else {
                label.end
            };
            if boarding.is_none_or(|(old, _, old_time, _)| {
                let previous = &labels.arena[old];
                let old_end = if labels.reverse && previous.boardings == 0 {
                    -old_time + previous.walking
                } else {
                    previous.end
                };
                label.walking < previous.walking
                    || (labels.reverse && label.walking == previous.walking && end < old_end)
            }) {
                *boarding = Some((i, connection, time, sequence));
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn journey_exit(
        &self,
        labels: &mut Labels,
        boarding: Option<(usize, usize, f64, f64)>,
        stop: usize,
        time: f64,
        sequence: f64,
        round: u32,
        reverse: bool,
    ) -> napi::Result<()> {
        let Some((parent, connection, board_time, board_sequence)) = boarding else {
            return Ok(());
        };
        let previous = &labels.arena[parent];
        let leg = Step {
            ride: true,
            from_stop: Some(if reverse { stop } else { previous.stop } as u32),
            to_stop: Some(if reverse { previous.stop } else { stop } as u32),
            trip: Some(self.segment_trip[connection]),
            board_sequence: Some(if reverse { sequence } else { board_sequence }),
            alight_sequence: Some(if reverse { board_sequence } else { sequence }),
            departure: if reverse { time } else { board_time },
            arrival: if reverse { -board_time } else { time },
        };
        labels.offer(Label {
            stop,
            time: if reverse { -time } else { time },
            walking: previous.walking,
            boardings: round,
            end: if reverse && previous.boardings == 0 {
                -board_time + previous.walking
            } else {
                previous.end
            },
            transfer: false,
            parent: Some(parent),
            leg,
            active: true,
        })
    }
}
