//! Optional compact journeys from shared boarding rounds. Scalar Matrix keeps
//! its smaller CSA workspace. Both time directions use the same label arena;
//! reverse time is negated so dominance and boarding tests stay identical.
use super::*;

#[cfg(all(feature = "standalone", not(feature = "node")))]
impl TimetableKernel {
    // Materialize the active (including realtime) stop sequence without copying
    // the whole resident timetable into a second adapter-owned representation.
    pub(crate) fn ride_stop_sequence(
        &self,
        trip: u32,
        board: f64,
        alight: f64,
    ) -> napi::Result<(Vec<u32>, usize, usize)> {
        let trip = trip as usize;
        if trip + 1 >= self.trip_start.len() {
            return Err(Error::from_reason("Unknown journey trip"));
        }
        let mut stops = Vec::new();
        let (mut first, mut last) = (None, None);
        for i in self.trip_start[trip] as usize..self.trip_start[trip + 1] as usize {
            if stops.last() != Some(&self.from_stop[i]) {
                stops.push(self.from_stop[i]);
            }
            // The kernel represents an alighting at the next segment's origin
            // with the preceding sequence plus 0.5. It is an actual selected
            // continuity bridge, not a missing integer GTFS sequence.
            if i > self.trip_start[trip] as usize
                && self.continuity_break[i] == 0
                && self.segment_run[i] == self.segment_run[i - 1]
                && self.from_stop[i] != self.to_stop[i - 1]
                && f64::from(self.sequence[i - 1]) + 0.5 == alight
            {
                last = Some(stops.len() - 1);
            }
            if self.sequence[i] as f64 == board {
                first = Some(stops.len() - 1);
            }
            stops.push(self.to_stop[i]);
            if self.sequence[i] as f64 == alight {
                last = Some(stops.len() - 1);
            }
        }
        match (first, last) {
            (Some(a), Some(b)) if a < b => Ok((stops, a, b)),
            _ => Err(Error::from_reason(
                "Journey sequence is not present in its active timetable",
            )),
        }
    }
}

#[derive(Clone)]
#[cfg_attr(feature = "node", napi(object))]
#[cfg_attr(not(feature = "node"), derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(not(feature = "node"), serde(rename_all = "camelCase"))]
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
#[cfg_attr(feature = "node", napi(object))]
#[cfg_attr(not(feature = "node"), derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(not(feature = "node"), serde(rename_all = "camelCase"))]
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
    touched_fronts: Vec<usize>,
    reverse: bool,
}

impl Labels {
    fn clear(&mut self) {
        for state in self.touched_fronts.drain(..) {
            self.fronts[state].clear();
        }
        self.arena.clear();
    }

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
        // A frontier can become empty while replacing dominated labels. Mark
        // it before retention so each touched state is recorded only once.
        let first_in_state = self.fronts[state].is_empty();
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
        if first_in_state {
            self.touched_fronts.push(state);
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

/// Scratch belongs to one immutable timetable and is allocated only when a
/// caller requests journeys. No result or endpoint identity is cached here.
pub(super) struct JourneyWorkspace {
    labels: Labels,
    boarding_labels: Vec<Vec<usize>>,
    boarding_stops: Vec<usize>,
    run_generation: Vec<u32>,
    run_epoch: u32,
    runs: Vec<usize>,
}

impl JourneyWorkspace {
    fn new(stops: usize, runs: usize) -> Self {
        Self {
            labels: Labels {
                arena: Vec::new(),
                fronts: vec![Vec::new(); stops * 4],
                touched_fronts: Vec::new(),
                reverse: false,
            },
            boarding_labels: vec![Vec::new(); stops],
            boarding_stops: Vec::new(),
            run_generation: vec![0; runs],
            run_epoch: 0,
            runs: Vec::new(),
        }
    }

    pub(super) fn byte_length(&self) -> usize {
        self.labels.arena.capacity() * std::mem::size_of::<Label>()
            + (self.labels.fronts.capacity() + self.boarding_labels.capacity())
                * std::mem::size_of::<Vec<usize>>()
            + (self.labels.touched_fronts.capacity()
                + self.boarding_stops.capacity()
                + self.runs.capacity()
                + self.labels.fronts.iter().map(Vec::capacity).sum::<usize>()
                + self
                    .boarding_labels
                    .iter()
                    .map(Vec::capacity)
                    .sum::<usize>())
                * std::mem::size_of::<usize>()
            + self.run_generation.capacity() * std::mem::size_of::<u32>()
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
        &mut self,
        input: &TimetableMatrixQueryInput,
        output: TimetableMatrixQueryResult,
    ) -> napi::Result<TimetableMatrixQueryResult> {
        let mut workspace = self
            .journey_workspace
            .take()
            .unwrap_or_else(|| JourneyWorkspace::new(self.stop_count, self.run_count));
        let result = self.matrix_journeys_with_workspace(input, output, &mut workspace);
        // Restore even after a capacity/error return; the next source clears
        // every touched frontier before it can observe a previous query.
        self.journey_workspace = Some(workspace);
        result
    }

    fn matrix_journeys_with_workspace(
        &self,
        input: &TimetableMatrixQueryInput,
        mut output: TimetableMatrixQueryResult,
        workspace: &mut JourneyWorkspace,
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
        let JourneyWorkspace {
            labels,
            boarding_labels,
            boarding_stops,
            run_generation,
            run_epoch,
            runs,
        } = workspace;
        labels.reverse = reverse;
        let coordinate_endpoints = input.allow_pre_ride_transfers.iter().all(|allow| !allow)
            && input
                .allow_post_ride_transfers
                .as_ref()
                .is_some_and(|flags| flags.iter().all(|allow| !allow));
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

            labels.clear();
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
            for round in 1..=maximum {
                // Freeze the previous round: zero-time connections and trip
                // order cannot consume two boardings in a single round.
                for stop in boarding_stops.drain(..) {
                    boarding_labels[stop].clear();
                }
                for i in previous.clone() {
                    if labels.arena[i].active {
                        let stop = labels.arena[i].stop;
                        if boarding_labels[stop].is_empty() {
                            boarding_stops.push(stop);
                        }
                        boarding_labels[stop].push(i);
                    }
                }
                if boarding_stops.is_empty() {
                    break;
                }
                // Only runs with a boardable event at a reached stop can
                // contribute in this round. Every target shares this work.
                runs.clear();
                *run_epoch = run_epoch.wrapping_add(1);
                if *run_epoch == 0 {
                    run_generation.fill(0);
                    *run_epoch = 1;
                }
                let mut mark = |run: usize| {
                    if run_generation[run] != *run_epoch {
                        run_generation[run] = *run_epoch;
                        runs.push(run);
                    }
                };
                for &stop in boarding_stops.iter() {
                    let ready = boarding_labels[stop]
                        .iter()
                        .map(|&i| {
                            let label = &labels.arena[i];
                            boarding_ready_time(
                                label.time,
                                label.boardings > 0,
                                !label.transfer,
                                self.same_stop_transfer_minimum[stop],
                                self.minimum_transfer_buffer_seconds,
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
                for &run in runs.iter() {
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
                                labels,
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
                                labels,
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
                                labels,
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
                                labels,
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
                // The scalar pass proves every target's best time. Finish the
                // entire round, including walking and equal-time ties. When
                // all reachable targets attain their own bounds, later rounds
                // add boardings and cannot improve any selected journey.
                // Selected-stop terminal transfers retain the general path.
                if coordinate_endpoints
                    && (0..target_offsets.len() - 1).all(|target| {
                        let bound = output.times[if reverse {
                            target * destinations + source
                        } else {
                            source * destinations + target
                        }];
                        !bound.is_finite()
                            || (target_offsets[target] as usize
                                ..target_offsets[target + 1] as usize)
                                .any(|seed| {
                                    let stop = target_stops[seed] as usize;
                                    labels.fronts[stop * 4 + 2].iter().any(|&i| {
                                        labels.arena[i].time + target_walks[seed]
                                            <= if reverse { -bound } else { bound }
                                    })
                                })
                    })
                {
                    break;
                }
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
                    let transfer_edges = if reverse && allow_transfer {
                        &self.transfer_edges[self.transfer_offset[stop] as usize
                            ..self.transfer_offset[stop + 1] as usize]
                    } else {
                        &[]
                    };
                    let terminal =
                        std::iter::once((stop, walk, None)).chain(transfer_edges.iter().map(
                            |edge| (edge.stop(), walk + f64::from(edge.duration()), Some(stop)),
                        ));
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
                self.minimum_transfer_buffer_seconds,
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

#[cfg(test)]
mod workspace_tests {
    use super::*;

    fn kernel() -> TimetableKernel {
        TimetableKernel::new(TimetableKernelInput {
            stop_count: 2,
            run_count: 1,
            departure_seconds: vec![10].into(),
            arrival_seconds: vec![20].into(),
            from_stop: vec![0].into(),
            to_stop: vec![1].into(),
            sequence: vec![1].into(),
            segment_trip: vec![0].into(),
            segment_run: vec![0].into(),
            continuity_break: vec![1].into(),
            can_board: vec![1].into(),
            can_alight: vec![1].into(),
            trip_start: vec![0, 1].into(),
            departure_offset: vec![0, 1, 1].into(),
            departure_order: vec![0].into(),
            transfer_offset: vec![0, 0, 0].into(),
            transfer_to: vec![].into(),
            transfer_duration: vec![].into(),
            forbidden_same_stop: vec![0, 0].into(),
            same_stop_transfer_minimum: None,
            minimum_transfer_buffer_seconds: None,
        })
        .unwrap()
    }

    fn query(reverse: bool, journeys: bool) -> TimetableMatrixQueryInput {
        TimetableMatrixQueryInput {
            origin_offsets: vec![0, 1],
            origin_stops: vec![0],
            origin_walk_seconds: vec![0.0],
            allow_pre_ride_transfers: vec![false],
            destination_offsets: vec![0, 1],
            destination_stops: vec![1],
            destination_walk_seconds: vec![0.0],
            allow_post_ride_transfers: Some(vec![false]),
            departure: 0.0,
            horizon: 40.0,
            arrive_by: reverse,
            maximum_boardings: None,
            include_journeys: Some(journeys),
        }
    }

    #[test]
    fn journey_scratch_recovers_after_error_and_generation_wrap() {
        let mut kernel = kernel();
        assert!(kernel.journey_workspace.is_none());
        for reverse in [false, true, false] {
            let mut bound = kernel.route_matrix_csa(query(reverse, false)).unwrap();
            bound.times[0] += if reverse { -1.0 } else { 1.0 };
            assert!(
                kernel
                    .matrix_journeys(&query(reverse, true), bound)
                    .is_err()
            );
            let workspace = kernel.journey_workspace.as_mut().unwrap();
            workspace.run_epoch = u32::MAX;
            workspace.run_generation.fill(1);
            let result = kernel.route_matrix_csa(query(reverse, true)).unwrap();
            assert_eq!(result.times, vec![if reverse { 10.0 } else { 20.0 }]);
            let journey = result.journeys.unwrap().remove(0).unwrap();
            assert_eq!(journey.boardings, 1);
            let ride = journey.legs.iter().find(|leg| leg.kind == "ride").unwrap();
            assert_eq!(
                (ride.trip, ride.departure, ride.arrival),
                (Some(0), 10.0, 20.0)
            );
        }
    }

    #[cfg(all(feature = "standalone", not(feature = "node")))]
    #[test]
    fn selected_continuity_bridge_keeps_its_active_stop_sequence() {
        let mut kernel = TimetableKernel::new(TimetableKernelInput {
            stop_count: 4,
            run_count: 1,
            departure_seconds: vec![10, 30].into(),
            arrival_seconds: vec![20, 40].into(),
            from_stop: vec![0, 2].into(),
            to_stop: vec![1, 3].into(),
            sequence: vec![1, 2].into(),
            segment_trip: vec![0, 0].into(),
            segment_run: vec![0, 0].into(),
            continuity_break: vec![1, 0].into(),
            can_board: vec![1, 1].into(),
            can_alight: vec![1, 1].into(),
            trip_start: vec![0, 2].into(),
            departure_offset: vec![0, 1, 1, 2, 2].into(),
            departure_order: vec![0, 1].into(),
            transfer_offset: vec![0, 0, 0, 0, 0].into(),
            transfer_to: vec![].into(),
            transfer_duration: vec![].into(),
            forbidden_same_stop: vec![0, 0, 0, 0].into(),
            same_stop_transfer_minimum: None,
            minimum_transfer_buffer_seconds: None,
        })
        .unwrap();
        for reverse in [false, true] {
            let mut request = query(reverse, true);
            request.destination_stops = vec![2];
            let result = kernel.route_matrix_csa(request).unwrap();
            let journey = result.journeys.unwrap().remove(0).unwrap();
            assert_eq!(journey.arrival, 30.0);
            let leg = journey.legs.iter().find(|l| l.kind == "ride").unwrap();
            assert_eq!(leg.alight_sequence, Some(1.5));
            let (stops, start, end) = kernel
                .ride_stop_sequence(
                    leg.trip.unwrap(),
                    leg.board_sequence.unwrap(),
                    leg.alight_sequence.unwrap(),
                )
                .unwrap();
            assert_eq!(&stops[start..=end], &[0, 1, 2]);
        }
        assert!(kernel.ride_stop_sequence(0, 1.0, 1.25).is_err());
    }
}
