//! Build the immutable timetable a planned scenario routes on. Removed trips
//! are canceled, planned services are expanded into appended trips over
//! existing and new stops, and walking transfers for new stops join the
//! transfer index. The scheduled arrays are borrowed and never edited, and
//! original trip indices survive, so journeys reconstruct exactly as before.
use super::preparation::departure_index;
use super::{TimetableKernel, TimetableKernelInput};
use crate::types::*;

const MAX_ADDED_STOPS: u32 = 4_096;
const MAX_ADDED_TRIPS: usize = 200_000;
const MAX_EVENT_SECONDS: u32 = (1 << 20) - 1;
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScenarioTimetableInput {
    /// Resident stops; appended stops follow at `stop_count..stop_count + added_stop_count`.
    pub stop_count: u32,
    pub added_stop_count: u32,
    pub departure_seconds: U32Buffer,
    pub arrival_seconds: U32Buffer,
    pub from_stop: U32Buffer,
    pub to_stop: U32Buffer,
    pub sequence: U32Buffer,
    pub segment_run: U32Buffer,
    pub continuity_break: U8Buffer,
    pub can_board: U8Buffer,
    pub can_alight: U8Buffer,
    pub trip_start: U32Buffer,
    pub canceled: U8Buffer,
    /// Inclusive sequence ranges removed from a trip without canceling its
    /// remaining runs. Used for physical trips inside explicit continuations.
    #[serde(default)]
    pub canceled_spans: Option<U32Buffer>,
    pub transfer_offset: U32Buffer,
    pub transfer_to: U32Buffer,
    pub transfer_duration: U32Buffer,
    pub forbidden_same_stop: U8Buffer,
    pub same_stop_transfer_minimum: Option<U32Buffer>,
    /// One stop pattern per planned run; offsets are seconds after the run's departure.
    pub pattern_offsets: U32Buffer,
    pub pattern_stops: U32Buffer,
    pub pattern_departure_offsets: U32Buffer,
    pub pattern_arrival_offsets: U32Buffer,
    pub pattern_can_board: U8Buffer,
    pub pattern_can_alight: U8Buffer,
    /// Departures `start, start + headway, …, ≤ end`; one trip when start equals end.
    pub run_start_seconds: U32Buffer,
    pub run_end_seconds: U32Buffer,
    pub run_headway_seconds: U32Buffer,
    pub added_transfer_from: U32Buffer,
    pub added_transfer_to: U32Buffer,
    pub added_transfer_duration: U32Buffer,
}
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScenarioTimetableResult {
    pub stop_count: u32,
    pub departure_seconds: U32Buffer,
    pub arrival_seconds: U32Buffer,
    pub from_stop: U32Buffer,
    pub to_stop: U32Buffer,
    pub sequence: U32Buffer,
    pub segment_trip: U32Buffer,
    pub segment_run: U32Buffer,
    pub continuity_break: U8Buffer,
    pub can_board: U8Buffer,
    pub can_alight: U8Buffer,
    pub trip_start: U32Buffer,
    pub departure_offset: U32Buffer,
    pub departure_order: U32Buffer,
    pub transfer_offset: U32Buffer,
    pub transfer_to: U32Buffer,
    pub transfer_duration: U32Buffer,
    pub forbidden_same_stop: U8Buffer,
    pub same_stop_transfer_minimum: Option<U32Buffer>,
    pub run_count: u32,
    pub active_segment_count: u32,
    pub canceled_trip_count: u32,
    /// For each appended trip (trip index `base trips + k`): its pattern and first departure.
    pub added_trip_patterns: U32Buffer,
    pub added_trip_departures: U32Buffer,
}

fn invalid(detail: &str) -> Error {
    Error::new(
        ErrorCode::InvalidInput,
        format!("Invalid scenario timetable: {detail}."),
    )
}

fn validate_base(input: &ScenarioTimetableInput) -> Result<()> {
    let segments = input.departure_seconds.len();
    let trips = input.canceled.len();
    let stops = input.stop_count as usize;
    let malformed = segments > i32::MAX as usize
        || input.trip_start.len() != trips + 1
        || input.trip_start.first() != Some(&0)
        || input.trip_start.last().map(|&v| v as usize) != Some(segments)
        || input.trip_start.windows(2).any(|pair| pair[0] > pair[1])
        || [
            &input.arrival_seconds,
            &input.from_stop,
            &input.to_stop,
            &input.sequence,
            &input.segment_run,
        ]
        .iter()
        .any(|values| values.len() != segments)
        || [&input.can_board, &input.can_alight, &input.continuity_break]
            .iter()
            .any(|values| values.len() != segments || values.iter().any(|&flag| flag > 1))
        || input.canceled.iter().any(|&flag| flag > 1)
        || input.canceled_spans.as_ref().is_some_and(|spans| {
            spans.len() % 3 != 0
                || spans
                    .chunks_exact(3)
                    .any(|s| s[0] as usize >= trips || s[1] > s[2])
        })
        || input
            .from_stop
            .iter()
            .chain(input.to_stop.iter())
            .any(|&stop| stop as usize >= stops)
        || input.transfer_offset.len() != stops + 1
        || input.transfer_offset.first() != Some(&0)
        || input.transfer_offset.last().map(|&v| v as usize) != Some(input.transfer_to.len())
        || input
            .transfer_offset
            .windows(2)
            .any(|pair| pair[0] > pair[1])
        || input.transfer_to.len() != input.transfer_duration.len()
        || input.forbidden_same_stop.len() != stops
        || input
            .same_stop_transfer_minimum
            .as_ref()
            .is_some_and(|values| values.len() != stops);
    if malformed {
        return Err(invalid("malformed scheduled arrays"));
    }
    Ok(())
}

fn validate_patterns(input: &ScenarioTimetableInput, total_stops: u32) -> Result<usize> {
    let patterns = input.run_start_seconds.len();
    let calls = input.pattern_stops.len();
    if input.pattern_offsets.len() != patterns + 1
        || input.pattern_offsets.first() != Some(&0)
        || input.pattern_offsets.last().map(|&v| v as usize) != Some(calls)
        || input
            .pattern_offsets
            .windows(2)
            .any(|pair| pair[0] > pair[1])
        || input.run_end_seconds.len() != patterns
        || input.run_headway_seconds.len() != patterns
        || [
            &input.pattern_departure_offsets,
            &input.pattern_arrival_offsets,
        ]
        .iter()
        .any(|values| values.len() != calls)
        || [&input.pattern_can_board, &input.pattern_can_alight]
            .iter()
            .any(|values| values.len() != calls || values.iter().any(|&flag| flag > 1))
        || input.pattern_stops.iter().any(|&stop| stop >= total_stops)
    {
        return Err(invalid("malformed planned service patterns"));
    }
    let mut trips = 0_usize;
    for pattern in 0..patterns {
        let start = input.pattern_offsets[pattern] as usize;
        let end = input.pattern_offsets[pattern + 1] as usize;
        if end - start < 2 {
            return Err(invalid("a planned service needs at least two stops"));
        }
        let departures = &input.pattern_departure_offsets[start..end];
        let arrivals = &input.pattern_arrival_offsets[start..end];
        for call in 0..end - start {
            if arrivals[call] > departures[call]
                || (call > 0 && arrivals[call] < departures[call - 1])
            {
                return Err(invalid("planned stop times must not run backwards"));
            }
        }
        let (first, last, headway) = (
            input.run_start_seconds[pattern],
            input.run_end_seconds[pattern],
            input.run_headway_seconds[pattern],
        );
        if last < first || headway == 0 {
            return Err(invalid(
                "a planned service window or headway is inconsistent",
            ));
        }
        let latest = u64::from(last)
            + u64::from(departures[departures.len() - 1].max(arrivals[arrivals.len() - 1]));
        if latest > u64::from(MAX_EVENT_SECONDS) {
            return Err(invalid(
                "a planned trip runs past the supported service day",
            ));
        }
        trips = trips
            .checked_add(((last - first) / headway) as usize + 1)
            .filter(|&count| count <= MAX_ADDED_TRIPS)
            .ok_or_else(|| invalid("planned services exceed the appended trip limit"))?;
    }
    if input.added_transfer_from.len() != input.added_transfer_to.len()
        || input.added_transfer_from.len() != input.added_transfer_duration.len()
        || input
            .added_transfer_from
            .iter()
            .chain(input.added_transfer_to.iter())
            .any(|&stop| stop >= total_stops)
    {
        return Err(invalid("malformed walking transfers for new stops"));
    }
    Ok(trips)
}
pub fn compile_scenario_timetable(
    input: ScenarioTimetableInput,
) -> Result<ScenarioTimetableResult> {
    validate_base(&input)?;
    if input.added_stop_count > MAX_ADDED_STOPS {
        return Err(invalid("too many new stops"));
    }
    let base_stops = input.stop_count as usize;
    let total_stops = input
        .stop_count
        .checked_add(input.added_stop_count)
        .ok_or_else(|| invalid("stop domain overflowed"))?;
    let added_trips = validate_patterns(&input, total_stops)?;
    let base_trips = input.canceled.len();

    let mut capacity = 0_usize;
    for trip in 0..base_trips {
        if input.canceled[trip] == 0 {
            capacity += (input.trip_start[trip + 1] - input.trip_start[trip]) as usize;
        }
    }
    let mut departure = Vec::with_capacity(capacity);
    let mut arrival = Vec::with_capacity(capacity);
    let mut from = Vec::with_capacity(capacity);
    let mut to = Vec::with_capacity(capacity);
    let mut sequence = Vec::with_capacity(capacity);
    let mut segment_trip = Vec::with_capacity(capacity);
    let mut segment_run = Vec::with_capacity(capacity);
    let mut breaks = Vec::with_capacity(capacity);
    let mut board = Vec::with_capacity(capacity);
    let mut alight = Vec::with_capacity(capacity);
    let mut trip_start = Vec::with_capacity(base_trips + added_trips + 1);
    let mut run_count = 0_u32;
    let mut canceled_trip_count = 0_u32;

    for trip in 0..base_trips {
        trip_start.push(departure.len() as u32);
        if input.canceled[trip] != 0 {
            canceled_trip_count += 1;
            continue;
        }
        let start = input.trip_start[trip] as usize;
        let end = input.trip_start[trip + 1] as usize;
        let spans: Vec<_> = input
            .canceled_spans
            .as_deref()
            .unwrap_or(&[])
            .chunks_exact(3)
            .filter(|s| s[0] as usize == trip)
            .collect();
        let mut previous = None;
        for index in start..end {
            if spans
                .iter()
                .any(|s| (s[1]..=s[2]).contains(&input.sequence[index]))
            {
                continue;
            }
            let new_run = previous != index.checked_sub(1)
                || index == start
                || input.segment_run[index] != input.segment_run[index - 1]
                || input.continuity_break[index] != 0;
            if new_run {
                run_count += 1;
            }
            departure.push(input.departure_seconds[index]);
            arrival.push(input.arrival_seconds[index]);
            from.push(input.from_stop[index]);
            to.push(input.to_stop[index]);
            sequence.push(input.sequence[index]);
            segment_trip.push(trip as u32);
            segment_run.push(run_count - 1);
            breaks.push(u8::from(new_run));
            board.push(input.can_board[index]);
            alight.push(input.can_alight[index]);
            previous = Some(index);
        }
    }

    let mut added_trip_patterns = Vec::with_capacity(added_trips);
    let mut added_trip_departures = Vec::with_capacity(added_trips);
    for pattern in 0..input.run_start_seconds.len() {
        let start = input.pattern_offsets[pattern] as usize;
        let end = input.pattern_offsets[pattern + 1] as usize;
        let headway = input.run_headway_seconds[pattern] as usize;
        for first in
            (input.run_start_seconds[pattern]..=input.run_end_seconds[pattern]).step_by(headway)
        {
            let trip = (base_trips + added_trip_patterns.len()) as u32;
            trip_start.push(departure.len() as u32);
            run_count += 1;
            for call in start..end - 1 {
                departure.push(first + input.pattern_departure_offsets[call]);
                arrival.push(first + input.pattern_arrival_offsets[call + 1]);
                from.push(input.pattern_stops[call]);
                to.push(input.pattern_stops[call + 1]);
                sequence.push((call - start) as u32);
                segment_trip.push(trip);
                segment_run.push(run_count - 1);
                breaks.push(0);
                board.push(input.pattern_can_board[call]);
                alight.push(input.pattern_can_alight[call + 1]);
            }
            added_trip_patterns.push(pattern as u32);
            added_trip_departures.push(first);
        }
    }
    if departure.len() > i32::MAX as usize || run_count > (1 << 29) - 1 {
        return Err(invalid("the scenario exceeds the native segment domain"));
    }
    trip_start.push(departure.len() as u32);
    let (departure_offset, departure_order) =
        departure_index(total_stops as usize, &from, &departure, &board)?;

    // Merge scheduled transfers with the new stops' walking links, grouped by origin stop.
    let total = total_stops as usize;
    let mut transfer_offset = vec![0_u32; total + 1];
    for stop in 0..base_stops {
        transfer_offset[stop + 1] = input.transfer_offset[stop + 1] - input.transfer_offset[stop];
    }
    for &stop in input.added_transfer_from.iter() {
        transfer_offset[stop as usize + 1] += 1;
    }
    for stop in 0..total {
        transfer_offset[stop + 1] += transfer_offset[stop];
    }
    let edges = transfer_offset[total] as usize;
    let mut transfer_to = vec![0_u32; edges];
    let mut transfer_duration = vec![0_u32; edges];
    let mut cursor = transfer_offset[..total].to_vec();
    for (stop, next) in cursor.iter_mut().enumerate().take(base_stops) {
        for edge in input.transfer_offset[stop] as usize..input.transfer_offset[stop + 1] as usize {
            let slot = *next as usize;
            transfer_to[slot] = input.transfer_to[edge];
            transfer_duration[slot] = input.transfer_duration[edge];
            *next += 1;
        }
    }
    for edge in 0..input.added_transfer_from.len() {
        let stop = input.added_transfer_from[edge] as usize;
        let slot = cursor[stop] as usize;
        transfer_to[slot] = input.added_transfer_to[edge];
        transfer_duration[slot] = input.added_transfer_duration[edge];
        cursor[stop] += 1;
    }

    let mut forbidden_same_stop = input.forbidden_same_stop.to_vec();
    forbidden_same_stop.resize(total, 0);
    let same_stop_transfer_minimum = input.same_stop_transfer_minimum.as_ref().map(|values| {
        let mut extended = values.to_vec();
        extended.resize(total, 0);
        U32Buffer::from(extended)
    });
    let active_segment_count = departure.len() as u32;
    Ok(ScenarioTimetableResult {
        stop_count: total_stops,
        departure_seconds: departure.into(),
        arrival_seconds: arrival.into(),
        from_stop: from.into(),
        to_stop: to.into(),
        sequence: sequence.into(),
        segment_trip: segment_trip.into(),
        segment_run: segment_run.into(),
        continuity_break: breaks.into(),
        can_board: board.into(),
        can_alight: alight.into(),
        trip_start: trip_start.into(),
        departure_offset: departure_offset.into(),
        departure_order: departure_order.into(),
        transfer_offset: transfer_offset.into(),
        transfer_to: transfer_to.into(),
        transfer_duration: transfer_duration.into(),
        forbidden_same_stop: forbidden_same_stop.into(),
        same_stop_transfer_minimum,
        run_count,
        active_segment_count,
        canceled_trip_count,
        added_trip_patterns: added_trip_patterns.into(),
        added_trip_departures: added_trip_departures.into(),
    })
}

/// A planned scenario on a resident timetable: the trips it removes, the
/// stops it adds after the resident ones, its stop patterns and runs, and the
/// walking links of its new stops. Fields mean what they mean in
/// [`ScenarioTimetableInput`].
pub struct ScenarioPlan {
    pub added_stop_count: u32,
    pub canceled: U8Buffer,
    pub canceled_spans: Option<U32Buffer>,
    pub pattern_offsets: U32Buffer,
    pub pattern_stops: U32Buffer,
    pub pattern_departure_offsets: U32Buffer,
    pub pattern_arrival_offsets: U32Buffer,
    pub pattern_can_board: U8Buffer,
    pub pattern_can_alight: U8Buffer,
    pub run_start_seconds: U32Buffer,
    pub run_end_seconds: U32Buffer,
    pub run_headway_seconds: U32Buffer,
    pub added_transfer_from: U32Buffer,
    pub added_transfer_to: U32Buffer,
    pub added_transfer_duration: U32Buffer,
}

/// A scenario view and, for each trip it appends, its pattern and first
/// departure (appended trips follow the resident ones).
pub struct ScenarioView {
    pub kernel: TimetableKernel,
    pub added_trip_patterns: U32Buffer,
    pub added_trip_departures: U32Buffer,
}

fn column<T: Copy>(column: &super::SourceColumn<T>) -> Buffer<T> {
    let view = column.view();
    (0..column.len())
        .map(|index| view[index])
        .collect::<Vec<_>>()
        .into()
}

impl TimetableKernel {
    /// The timetable `plan` routes on, derived from this resident one. Its
    /// stops, trips and transfers keep their indices; this one is unchanged.
    pub fn scenario_view(&self, plan: ScenarioPlan) -> Result<ScenarioView> {
        let compiled = compile_scenario_timetable(ScenarioTimetableInput {
            stop_count: self.stop_count as u32,
            added_stop_count: plan.added_stop_count,
            departure_seconds: column(&self.departure_seconds),
            arrival_seconds: column(&self.arrival_seconds),
            from_stop: column(&self.from_stop),
            to_stop: column(&self.to_stop),
            sequence: column(&self.sequence),
            segment_run: column(&self.segment_run),
            continuity_break: column(&self.continuity_break),
            can_board: column(&self.can_board),
            can_alight: column(&self.can_alight),
            trip_start: column(&self.trip_start),
            canceled: plan.canceled,
            canceled_spans: plan.canceled_spans,
            transfer_offset: self.transfer_offset.clone().into(),
            transfer_to: self
                .transfer_edges
                .iter()
                .map(|edge| edge.stop() as u32)
                .collect::<Vec<_>>()
                .into(),
            transfer_duration: self
                .transfer_edges
                .iter()
                .map(|edge| edge.duration())
                .collect::<Vec<_>>()
                .into(),
            forbidden_same_stop: self.forbidden_same_stop.to_vec().into(),
            same_stop_transfer_minimum: Some(self.same_stop_transfer_minimum.clone().into()),
            pattern_offsets: plan.pattern_offsets,
            pattern_stops: plan.pattern_stops,
            pattern_departure_offsets: plan.pattern_departure_offsets,
            pattern_arrival_offsets: plan.pattern_arrival_offsets,
            pattern_can_board: plan.pattern_can_board,
            pattern_can_alight: plan.pattern_can_alight,
            run_start_seconds: plan.run_start_seconds,
            run_end_seconds: plan.run_end_seconds,
            run_headway_seconds: plan.run_headway_seconds,
            added_transfer_from: plan.added_transfer_from,
            added_transfer_to: plan.added_transfer_to,
            added_transfer_duration: plan.added_transfer_duration,
        })?;
        let added_trip_patterns = compiled.added_trip_patterns.clone();
        let added_trip_departures = compiled.added_trip_departures.clone();
        let mut kernel = compiled_kernel(compiled, self.minimum_transfer_buffer_seconds)?;
        if let Some(service) = &self.service {
            kernel.set_service_semantics((*service.data).clone())?;
        }
        Ok(ScenarioView {
            kernel,
            added_trip_patterns,
            added_trip_departures,
        })
    }
}

fn compiled_kernel(
    compiled: ScenarioTimetableResult,
    minimum_transfer_buffer_seconds: u32,
) -> Result<TimetableKernel> {
    TimetableKernel::new(TimetableKernelInput {
        stop_count: compiled.stop_count,
        run_count: compiled.run_count,
        departure_seconds: compiled.departure_seconds,
        arrival_seconds: compiled.arrival_seconds,
        from_stop: compiled.from_stop,
        to_stop: compiled.to_stop,
        sequence: compiled.sequence,
        segment_trip: compiled.segment_trip,
        segment_run: compiled.segment_run,
        continuity_break: compiled.continuity_break,
        can_board: compiled.can_board,
        can_alight: compiled.can_alight,
        trip_start: compiled.trip_start,
        departure_offset: compiled.departure_offset,
        departure_order: compiled.departure_order,
        transfer_offset: compiled.transfer_offset,
        transfer_to: compiled.transfer_to,
        transfer_duration: compiled.transfer_duration,
        forbidden_same_stop: compiled.forbidden_same_stop,
        same_stop_transfer_minimum: compiled.same_stop_transfer_minimum,
        minimum_transfer_buffer_seconds: Some(minimum_transfer_buffer_seconds),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u32s(values: &[u32]) -> U32Buffer {
        U32Buffer::from(values.to_vec())
    }
    fn u8s(values: &[u8]) -> U8Buffer {
        U8Buffer::from(values.to_vec())
    }

    /// Two scheduled trips over stops 0→1→2 and one new stop (3) reached by walking from stop 2.
    fn input() -> ScenarioTimetableInput {
        ScenarioTimetableInput {
            stop_count: 3,
            added_stop_count: 1,
            departure_seconds: u32s(&[100, 200, 1_000, 1_100]),
            arrival_seconds: u32s(&[150, 250, 1_050, 1_150]),
            from_stop: u32s(&[0, 1, 0, 1]),
            to_stop: u32s(&[1, 2, 1, 2]),
            sequence: u32s(&[1, 2, 1, 2]),
            segment_run: u32s(&[0, 0, 1, 1]),
            continuity_break: u8s(&[0, 0, 0, 0]),
            can_board: u8s(&[1, 1, 1, 1]),
            can_alight: u8s(&[1, 1, 1, 1]),
            trip_start: u32s(&[0, 2, 4]),
            canceled: u8s(&[0, 1]),
            canceled_spans: None,
            transfer_offset: u32s(&[0, 0, 1, 1]),
            transfer_to: u32s(&[2]),
            transfer_duration: u32s(&[60]),
            forbidden_same_stop: u8s(&[0, 0, 0]),
            same_stop_transfer_minimum: Some(u32s(&[0, 30, 0])),
            pattern_offsets: u32s(&[0, 2]),
            pattern_stops: u32s(&[2, 3]),
            pattern_departure_offsets: u32s(&[0, 300]),
            pattern_arrival_offsets: u32s(&[0, 300]),
            pattern_can_board: u8s(&[1, 1]),
            pattern_can_alight: u8s(&[1, 1]),
            run_start_seconds: u32s(&[600]),
            run_end_seconds: u32s(&[1_800]),
            run_headway_seconds: u32s(&[600]),
            added_transfer_from: u32s(&[3, 2]),
            added_transfer_to: u32s(&[2, 3]),
            added_transfer_duration: u32s(&[90, 90]),
        }
    }

    #[test]
    fn cancels_removed_trips_and_appends_planned_runs() {
        let result = compile_scenario_timetable(input()).unwrap();
        assert_eq!(result.stop_count, 4);
        assert_eq!(result.canceled_trip_count, 1);
        // Trip 0 keeps its two segments; trip 1 is canceled; three runs at 600, 1200 and 1800.
        assert_eq!(result.trip_start.to_vec(), vec![0, 2, 2, 3, 4, 5]);
        assert_eq!(
            result.departure_seconds.to_vec(),
            vec![100, 200, 600, 1_200, 1_800]
        );
        assert_eq!(
            result.arrival_seconds.to_vec(),
            vec![150, 250, 900, 1_500, 2_100]
        );
        assert_eq!(result.segment_trip.to_vec(), vec![0, 0, 2, 3, 4]);
        assert_eq!(result.from_stop.to_vec(), vec![0, 1, 2, 2, 2]);
        assert_eq!(result.to_stop.to_vec(), vec![1, 2, 3, 3, 3]);
        assert_eq!(result.run_count, 4);
        assert_eq!(result.added_trip_patterns.to_vec(), vec![0, 0, 0]);
        assert_eq!(
            result.added_trip_departures.to_vec(),
            vec![600, 1_200, 1_800]
        );
        // Stop 2 boards three planned runs in time order.
        let offsets = result.departure_offset.to_vec();
        let order = result.departure_order.to_vec();
        assert_eq!(&order[offsets[2] as usize..offsets[3] as usize], &[2, 3, 4]);
    }

    #[test]
    fn merges_new_stop_transfers_into_the_index() {
        let result = compile_scenario_timetable(input()).unwrap();
        assert_eq!(result.transfer_offset.to_vec(), vec![0, 0, 1, 2, 3]);
        assert_eq!(result.transfer_to.to_vec(), vec![2, 3, 2]);
        assert_eq!(result.transfer_duration.to_vec(), vec![60, 90, 90]);
        assert_eq!(result.forbidden_same_stop.to_vec(), vec![0, 0, 0, 0]);
        assert_eq!(
            result.same_stop_transfer_minimum.unwrap().to_vec(),
            vec![0, 30, 0, 0]
        );
    }

    #[test]
    fn derives_a_scenario_view_from_the_resident_kernel() {
        let mut resident = input();
        resident.added_stop_count = 0;
        resident.canceled = u8s(&[0, 0]);
        resident.pattern_offsets = u32s(&[0]);
        for column in [
            &mut resident.pattern_stops,
            &mut resident.pattern_departure_offsets,
            &mut resident.pattern_arrival_offsets,
            &mut resident.run_start_seconds,
            &mut resident.run_end_seconds,
            &mut resident.run_headway_seconds,
            &mut resident.added_transfer_from,
            &mut resident.added_transfer_to,
            &mut resident.added_transfer_duration,
        ] {
            *column = u32s(&[]);
        }
        resident.pattern_can_board = u8s(&[]);
        resident.pattern_can_alight = u8s(&[]);
        let base = compiled_kernel(compile_scenario_timetable(resident).unwrap(), 45).unwrap();
        let plan = input();
        let view = base
            .scenario_view(ScenarioPlan {
                added_stop_count: plan.added_stop_count,
                canceled: plan.canceled,
                canceled_spans: plan.canceled_spans,
                pattern_offsets: plan.pattern_offsets,
                pattern_stops: plan.pattern_stops,
                pattern_departure_offsets: plan.pattern_departure_offsets,
                pattern_arrival_offsets: plan.pattern_arrival_offsets,
                pattern_can_board: plan.pattern_can_board,
                pattern_can_alight: plan.pattern_can_alight,
                run_start_seconds: plan.run_start_seconds,
                run_end_seconds: plan.run_end_seconds,
                run_headway_seconds: plan.run_headway_seconds,
                added_transfer_from: plan.added_transfer_from,
                added_transfer_to: plan.added_transfer_to,
                added_transfer_duration: plan.added_transfer_duration,
            })
            .unwrap();
        // The same timetable as compiling the scenario from source columns.
        let expected = compile_scenario_timetable(input()).unwrap();
        let kernel = &view.kernel;
        assert_eq!(kernel.stop_count, 4);
        assert_eq!(
            column(&kernel.departure_seconds).to_vec(),
            expected.departure_seconds.to_vec()
        );
        assert_eq!(
            column(&kernel.arrival_seconds).to_vec(),
            expected.arrival_seconds.to_vec()
        );
        assert_eq!(column(&kernel.to_stop).to_vec(), expected.to_stop.to_vec());
        assert_eq!(
            column(&kernel.trip_start).to_vec(),
            expected.trip_start.to_vec()
        );
        assert_eq!(view.added_trip_departures.to_vec(), vec![600, 1_200, 1_800]);
        assert_eq!(kernel.minimum_transfer_buffer_seconds, 45);
        // The resident kernel is unchanged.
        assert_eq!(base.stop_count, 3);
        assert_eq!(
            column(&base.departure_seconds).to_vec(),
            vec![100, 200, 1_000, 1_100]
        );
    }

    #[test]
    fn rejects_inconsistent_plans() {
        let mut backwards = input();
        backwards.pattern_arrival_offsets = u32s(&[0, 400]);
        backwards.pattern_departure_offsets = u32s(&[500, 600]);
        assert!(compile_scenario_timetable(backwards).is_err());
        let mut unknown = input();
        unknown.pattern_stops = u32s(&[2, 9]);
        assert!(compile_scenario_timetable(unknown).is_err());
        let mut stalled = input();
        stalled.run_headway_seconds = u32s(&[0]);
        assert!(compile_scenario_timetable(stalled).is_err());
        let mut late = input();
        late.run_end_seconds = u32s(&[MAX_EVENT_SECONDS]);
        late.run_start_seconds = u32s(&[MAX_EVENT_SECONDS]);
        assert!(compile_scenario_timetable(late).is_err());
    }
}
