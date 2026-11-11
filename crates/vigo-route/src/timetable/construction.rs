use super::*;

impl TimetableKernel {
    pub fn new(input: TimetableKernelInput) -> Result<Self> {
        let stop_count = input.stop_count as usize;
        let run_count = input.run_count as usize;
        let segment_count = input.departure_seconds.len();
        let trip_count = input.trip_start.len().saturating_sub(1);
        if !crate::timetable_validation::kernel_input_is_valid(
            &input,
            SCAN_RUN_MASK,
            EXIT_TIME_MASK,
        ) {
            return Err(Error::from_reason(
                "Rust timetable kernel arrays are inconsistent.",
            ));
        }
        let arrival_seconds = input.arrival_seconds.as_ref();
        let can_alight = input.can_alight.as_ref();
        let can_board = input.can_board.as_ref();
        let continuity_break = input.continuity_break.as_ref();
        let departure_seconds = input.departure_seconds.as_ref();
        let from_stop = input.from_stop.as_ref();
        let segment_run = input.segment_run.as_ref();
        let segment_trip = input.segment_trip.as_ref();
        let sequence = input.sequence.as_ref();
        let to_stop = input.to_stop.as_ref();
        let transfer_duration = input.transfer_duration.as_ref();
        let transfer_offset = input.transfer_offset.as_ref();
        let transfer_to = input.transfer_to.as_ref();
        let connection_order = departure_order(departure_seconds);
        let mut scan_events = Vec::with_capacity(segment_count);
        let mut scan_times = Vec::new();
        let mut scan_time_offsets = Vec::new();
        let mut scan_time_needs_closure = Vec::new();
        let mut scan_arrivals = Vec::with_capacity(segment_count);
        let mut scan_journeys = Vec::with_capacity(segment_count);
        let mut prior_departure = None;
        for segment in connection_order {
            let index = segment as usize;
            let departure = departure_seconds[index];
            if prior_departure != Some(departure) {
                scan_times.push(departure);
                scan_time_offsets.push(scan_events.len() as u32);
                scan_time_needs_closure.push(false);
                prior_departure = Some(departure);
            }
            let bridge_exit = index > 0
                && continuity_break[index] == 0
                && segment_run[index - 1] == segment_run[index]
                && to_stop[index - 1] != from_stop[index];
            // Only zero-time arrivals and bridge exits can introduce another
            // boarding at this timestamp. This exact dependency flag avoids
            // revisiting buckets that cannot contain such a dependency.
            if arrival_seconds[index] == departure || bridge_exit {
                *scan_time_needs_closure.last_mut().unwrap() = true;
            }
            let flags = (if can_board[index] == 1 {
                SCAN_CAN_BOARD
            } else {
                0
            }) | (if can_alight[index] == 1 {
                SCAN_CAN_ALIGHT
            } else {
                0
            }) | (if bridge_exit { SCAN_BRIDGE_EXIT } else { 0 });
            let run_flags = segment_run[index] | u32::from(flags) << 29;
            scan_events.push(ScanEvent(
                u64::from(from_stop[index]) | u64::from(run_flags) << 32,
            ));
            scan_arrivals.push(ScanArrival {
                arrival: arrival_seconds[index],
                to: to_stop[index],
            });
            scan_journeys.push(ScanJourney {
                trip: segment_trip[index],
                sequence: sequence[index],
                prior_sequence: if index > 0 { sequence[index - 1] } else { 0 },
            });
        }
        scan_time_offsets.push(scan_events.len() as u32);
        let departure_events = input
            .departure_order
            .iter()
            .map(|segment| {
                let index = *segment as usize;
                DepartureEvent {
                    departure: departure_seconds[index],
                    run: segment_run[index],
                }
            })
            .collect();
        let transfer_edges = input
            .transfer_to
            .iter()
            .zip(input.transfer_duration.iter())
            .map(|(target, duration)| TransferEdge::new(*target, *duration))
            .collect();
        let mut run_start = vec![u32::MAX; run_count];
        let mut run_end = vec![0; run_count];
        for (segment, &run) in segment_run.iter().enumerate() {
            let run = run as usize;
            run_start[run] = run_start[run].min(segment as u32);
            run_end[run] = segment as u32 + 1;
        }
        if run_start.contains(&u32::MAX) {
            return Err(Error::from_reason(
                "Rust timetable kernel contains an empty run.",
            ));
        }
        for run in 0..run_count {
            let start = run_start[run] as usize;
            let end = run_end[run] as usize;
            if (start..end).any(|c| {
                segment_run[c] as usize != run
                    || (c > start
                        && (segment_trip[c] != segment_trip[c - 1]
                            || continuity_break[c] != 0
                            || sequence[c] <= sequence[c - 1]
                            || departure_seconds[c] < arrival_seconds[c - 1]))
            }) {
                return Err(Error::from_reason(
                    "Rust timetable runs must be contiguous, chronological segments of one trip.",
                ));
            }
        }
        if (0..run_count).any(|run| {
            run_end[run]
                .saturating_sub(run_start[run])
                .saturating_sub(1)
                > EXIT_RELATIVE_SEGMENT_MASK
        }) {
            return Err(Error::from_reason(
                "Rust timetable kernel contains a run with too many segments.",
            ));
        }
        let mut reverse_transfer_counts = vec![0_u32; stop_count];
        for target in input.transfer_to.iter() {
            reverse_transfer_counts[*target as usize] += 1;
        }
        let mut reverse_transfer_offset = vec![0_u32; stop_count + 1];
        for stop in 0..stop_count {
            reverse_transfer_offset[stop + 1] =
                reverse_transfer_offset[stop] + reverse_transfer_counts[stop];
        }
        let mut reverse_transfer_cursor = reverse_transfer_offset[..stop_count].to_vec();
        let mut reverse_transfer_edges = vec![TransferEdge(0); input.transfer_to.len()];
        for source in 0..stop_count {
            for edge in transfer_offset[source] as usize..transfer_offset[source + 1] as usize {
                let target = transfer_to[edge] as usize;
                let index = reverse_transfer_cursor[target] as usize;
                reverse_transfer_edges[index] =
                    TransferEdge::new(source as u32, transfer_duration[edge]);
                reverse_transfer_cursor[target] += 1;
            }
        }
        let (exit_event_offset, exit_events) = exit_index(ExitSegments {
            stop_count,
            departure_seconds,
            arrival_seconds,
            from_stop,
            to_stop,
            segment_run,
            continuity_break,
            can_alight,
            run_start: &run_start,
        });
        scan_times.shrink_to_fit();
        scan_time_offsets.shrink_to_fit();
        scan_time_needs_closure.shrink_to_fit();
        Ok(Self {
            stop_count,
            run_count,
            departure_seconds: input.departure_seconds.into(),
            arrival_seconds: input.arrival_seconds.into(),
            from_stop: input.from_stop.into(),
            to_stop: input.to_stop.into(),
            sequence: input.sequence.into(),
            segment_trip: input.segment_trip.into(),
            segment_run: input.segment_run.into(),
            continuity_break: input.continuity_break.into(),
            can_board: input.can_board.into(),
            can_alight: input.can_alight.into(),
            trip_start: input.trip_start.into(),
            departure_offset: input.departure_offset.to_vec(),
            departure_events,
            transfer_offset: input.transfer_offset.to_vec(),
            transfer_edges,
            forbidden_same_stop: input.forbidden_same_stop,
            same_stop_transfer_minimum: input
                .same_stop_transfer_minimum
                .map_or_else(|| vec![0; stop_count], |values| values.to_vec()),
            minimum_transfer_buffer_seconds: input.minimum_transfer_buffer_seconds.unwrap_or(0),
            scan_events,
            scan_times,
            scan_time_offsets,
            scan_time_needs_closure,
            scan_arrivals,
            scan_journeys,
            run_start,
            run_end,
            reverse_transfer_offset,
            reverse_transfer_edges,
            exit_event_offset,
            exit_events,
            query: TimetableQueryWorkspace::new(stop_count, run_count, trip_count),
        })
    }
}

/// Segments in (departure, index) order. Departures are validated to the
/// 20-bit exit time domain, so two stable 10-bit counting passes produce the
/// same order as a comparison sort in linear time. Realtime views rebuild this
/// for every snapshot, so the constant factor matters.
fn departure_order(departures: &[u32]) -> Vec<u32> {
    const DIGIT: u32 = 10;
    const BUCKETS: usize = 1 << DIGIT;
    let mut order: Vec<u32> = (0..departures.len() as u32).collect();
    if departures.len() < BUCKETS {
        order.sort_unstable_by_key(|&segment| (departures[segment as usize], segment));
        return order;
    }
    debug_assert!(departures.iter().all(|&time| time <= EXIT_TIME_MASK));
    let mut sorted = vec![0_u32; order.len()];
    for shift in [0, DIGIT] {
        let digit =
            |segment: u32| ((departures[segment as usize] >> shift) as usize) & (BUCKETS - 1);
        let mut cursor = vec![0_u32; BUCKETS + 1];
        for &segment in &order {
            cursor[digit(segment) + 1] += 1;
        }
        for bucket in 0..BUCKETS {
            cursor[bucket + 1] += cursor[bucket];
        }
        for &segment in &order {
            let bucket = digit(segment);
            sorted[cursor[bucket] as usize] = segment;
            cursor[bucket] += 1;
        }
        std::mem::swap(&mut order, &mut sorted);
    }
    order
}

struct ExitSegments<'a> {
    stop_count: usize,
    departure_seconds: &'a [u32],
    arrival_seconds: &'a [u32],
    from_stop: &'a [u32],
    to_stop: &'a [u32],
    segment_run: &'a [u32],
    continuity_break: &'a [u8],
    can_alight: &'a [u8],
    run_start: &'a [u32],
}
impl ExitSegments<'_> {
    // A same-run segment that starts away from where the previous one ended
    // lets riders leave at the bridge's departure stop.
    fn bridge_exit(&self, segment: usize) -> bool {
        let run = self.segment_run[segment];
        segment > self.run_start[run as usize] as usize
            && self.continuity_break[segment] == 0
            && self.segment_run[segment - 1] == run
            && self.to_stop[segment - 1] != self.from_stop[segment]
    }
    fn for_each_exit(&self, mut visit: impl FnMut(u32, ExitEvent)) {
        for segment in 0..self.departure_seconds.len() {
            let run = self.segment_run[segment];
            let start = self.run_start[run as usize];
            if self.can_alight[segment] == 1 {
                let event =
                    ExitEvent::new(self.arrival_seconds[segment], run, segment as u32, start);
                visit(self.to_stop[segment], event);
            }
            if self.bridge_exit(segment) {
                let event = ExitEvent::new(
                    self.departure_seconds[segment],
                    run,
                    segment as u32 - 1,
                    start,
                );
                visit(self.from_stop[segment], event);
            }
        }
    }
}

/// Exit events grouped by stop, each ordered by (time, run, through segment)
/// without duplicates. Bucketing by stop first keeps every sort local to the
/// events of one stop instead of sorting all exits of the timetable together.
fn exit_index(segments: ExitSegments<'_>) -> (Vec<u32>, Vec<ExitEvent>) {
    let stop_count = segments.stop_count;
    let mut exit_event_offset = vec![0_u32; stop_count + 1];
    segments.for_each_exit(|stop, _| exit_event_offset[stop as usize + 1] += 1);
    for stop in 0..stop_count {
        exit_event_offset[stop + 1] += exit_event_offset[stop];
    }
    let mut cursor = exit_event_offset[..stop_count].to_vec();
    let mut exit_events = vec![ExitEvent(0); exit_event_offset[stop_count] as usize];
    segments.for_each_exit(|stop, event| {
        exit_events[cursor[stop as usize] as usize] = event;
        cursor[stop as usize] += 1;
    });
    let run_start = segments.run_start;
    let mut written = 0;
    let mut start = 0;
    for stop in 0..stop_count {
        let end = exit_event_offset[stop + 1] as usize;
        exit_events[start..end].sort_unstable_by(|left, right| {
            left.time()
                .cmp(&right.time())
                .then_with(|| left.run().cmp(&right.run()))
                .then_with(|| {
                    left.through_segment(run_start)
                        .cmp(&right.through_segment(run_start))
                })
        });
        // Equal (time, run, through segment) keys pack to identical events.
        exit_event_offset[stop] = written as u32;
        for index in start..end {
            if index == start || exit_events[index].0 != exit_events[index - 1].0 {
                exit_events[written] = exit_events[index];
                written += 1;
            }
        }
        start = end;
    }
    exit_event_offset[stop_count] = written as u32;
    exit_events.truncate(written);
    exit_events.shrink_to_fit();
    (exit_event_offset, exit_events)
}

#[cfg(test)]
mod tests {
    use super::*;

    // The previous global sort and dedup, kept as the reference ordering.
    fn reference_exit_index(segments: &ExitSegments<'_>) -> (Vec<u32>, Vec<u64>) {
        let mut records = Vec::new();
        segments.for_each_exit(|stop, event| records.push((stop, event)));
        let run_start = segments.run_start;
        records.sort_unstable_by(|left, right| {
            left.0
                .cmp(&right.0)
                .then_with(|| left.1.time().cmp(&right.1.time()))
                .then_with(|| left.1.run().cmp(&right.1.run()))
                .then_with(|| {
                    left.1
                        .through_segment(run_start)
                        .cmp(&right.1.through_segment(run_start))
                })
        });
        records.dedup_by(|left, right| left.0 == right.0 && left.1.0 == right.1.0);
        let mut offsets = vec![0_u32; segments.stop_count + 1];
        for (stop, _) in &records {
            offsets[*stop as usize + 1] += 1;
        }
        for stop in 0..segments.stop_count {
            offsets[stop + 1] += offsets[stop];
        }
        (
            offsets,
            records.into_iter().map(|(_, event)| event.0).collect(),
        )
    }

    struct Random(u64);
    impl Random {
        fn next(&mut self, bound: u32) -> u32 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            (self.0 % u64::from(bound)) as u32
        }
    }

    #[test]
    fn linear_departure_order_matches_comparison_sort() {
        let mut random = Random(0x9e37_79b9_7f4a_7c15);
        for (count, range) in [
            (0, 1),
            (7, 3),
            (1023, 100),
            (1024, 1),
            (5000, 86_400),
            (70_000, EXIT_TIME_MASK + 1),
        ] {
            let departures: Vec<u32> = (0..count).map(|_| random.next(range)).collect();
            let mut expected: Vec<u32> = (0..count as u32).collect();
            expected.sort_unstable_by_key(|&segment| (departures[segment as usize], segment));
            assert_eq!(departure_order(&departures), expected, "{count} segments");
        }
    }

    #[test]
    fn bucketed_exit_index_matches_global_sort() {
        let mut random = Random(0x2545_f491_4f6c_dd1d);
        for case in 0..200 {
            let stop_count = 1 + random.next(12) as usize;
            let (mut departures, mut arrivals, mut from, mut to) = (vec![], vec![], vec![], vec![]);
            let (mut runs, mut breaks, mut alight, mut run_start) =
                (vec![], vec![], vec![], vec![]);
            for run in 0..1 + random.next(40) {
                run_start.push(departures.len() as u32);
                let mut time = random.next(2_000);
                let mut stop = random.next(stop_count as u32);
                for _ in 0..1 + random.next(6) {
                    // Occasional bridges and duplicate-time exits at loops.
                    if random.next(5) == 0 {
                        stop = random.next(stop_count as u32);
                    }
                    let next = random.next(stop_count as u32);
                    departures.push(time);
                    time += random.next(3);
                    arrivals.push(time);
                    from.push(stop);
                    to.push(next);
                    runs.push(run);
                    breaks.push(0);
                    alight.push(u8::from(random.next(4) != 0));
                    stop = next;
                }
            }
            let segments = ExitSegments {
                stop_count,
                departure_seconds: &departures,
                arrival_seconds: &arrivals,
                from_stop: &from,
                to_stop: &to,
                segment_run: &runs,
                continuity_break: &breaks,
                can_alight: &alight,
                run_start: &run_start,
            };
            let expected = reference_exit_index(&segments);
            let (offsets, events) = exit_index(segments);
            assert_eq!(offsets, expected.0, "case {case}");
            assert_eq!(
                events.iter().map(|e| e.0).collect::<Vec<_>>(),
                expected.1,
                "case {case}"
            );
        }
    }
}
