//! Build the immutable timetable a planned scenario routes on. Removed trips
//! are canceled, planned services are expanded into appended trips over
//! existing and new stops, and walking transfers for new stops join the
//! transfer index. The scheduled arrays are borrowed and never edited, and
//! original trip indices survive, so journeys reconstruct exactly as before.
use super::preparation::departure_index;
#[cfg(not(feature = "node"))]
use crate::standalone_types as napi;
use napi::bindgen_prelude::*;
#[cfg(feature = "node")]
use napi_derive::napi;

const MAX_ADDED_STOPS: u32 = 4_096;
const MAX_ADDED_TRIPS: usize = 200_000;
const MAX_EVENT_SECONDS: u32 = (1 << 20) - 1;

#[cfg_attr(feature = "node", napi(object))]
#[cfg_attr(not(feature = "node"), derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(not(feature = "node"), serde(rename_all = "camelCase"))]
pub struct ScenarioTimetableInput {
    /// Resident stops; appended stops follow at `stop_count..stop_count + added_stop_count`.
    pub stop_count: u32,
    pub added_stop_count: u32,
    pub departure_seconds: Uint32Array,
    pub arrival_seconds: Uint32Array,
    pub from_stop: Uint32Array,
    pub to_stop: Uint32Array,
    pub sequence: Uint32Array,
    pub segment_run: Uint32Array,
    pub continuity_break: Uint8Array,
    pub can_board: Uint8Array,
    pub can_alight: Uint8Array,
    pub trip_start: Uint32Array,
    pub canceled: Uint8Array,
    pub transfer_offset: Uint32Array,
    pub transfer_to: Uint32Array,
    pub transfer_duration: Uint32Array,
    pub forbidden_same_stop: Uint8Array,
    pub same_stop_transfer_minimum: Option<Uint32Array>,
    /// One stop pattern per planned run; offsets are seconds after the run's departure.
    pub pattern_offsets: Uint32Array,
    pub pattern_stops: Uint32Array,
    pub pattern_departure_offsets: Uint32Array,
    pub pattern_arrival_offsets: Uint32Array,
    pub pattern_can_board: Uint8Array,
    pub pattern_can_alight: Uint8Array,
    /// Departures `start, start + headway, …, ≤ end`; one trip when start equals end.
    pub run_start_seconds: Uint32Array,
    pub run_end_seconds: Uint32Array,
    pub run_headway_seconds: Uint32Array,
    pub added_transfer_from: Uint32Array,
    pub added_transfer_to: Uint32Array,
    pub added_transfer_duration: Uint32Array,
}

#[cfg_attr(feature = "node", napi(object))]
#[cfg_attr(not(feature = "node"), derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(not(feature = "node"), serde(rename_all = "camelCase"))]
pub struct ScenarioTimetableResult {
    pub stop_count: u32,
    pub departure_seconds: Uint32Array,
    pub arrival_seconds: Uint32Array,
    pub from_stop: Uint32Array,
    pub to_stop: Uint32Array,
    pub sequence: Uint32Array,
    pub segment_trip: Uint32Array,
    pub segment_run: Uint32Array,
    pub continuity_break: Uint8Array,
    pub can_board: Uint8Array,
    pub can_alight: Uint8Array,
    pub trip_start: Uint32Array,
    pub departure_offset: Uint32Array,
    pub departure_order: Uint32Array,
    pub transfer_offset: Uint32Array,
    pub transfer_to: Uint32Array,
    pub transfer_duration: Uint32Array,
    pub forbidden_same_stop: Uint8Array,
    pub same_stop_transfer_minimum: Option<Uint32Array>,
    pub run_count: u32,
    pub active_segment_count: u32,
    pub canceled_trip_count: u32,
    /// For each appended trip (trip index `base trips + k`): its pattern and first departure.
    pub added_trip_patterns: Uint32Array,
    pub added_trip_departures: Uint32Array,
}

fn invalid(detail: &str) -> Error {
    Error::new(
        Status::InvalidArg,
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

#[cfg_attr(feature = "node", napi)]
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
        departure.extend_from_slice(&input.departure_seconds[start..end]);
        arrival.extend_from_slice(&input.arrival_seconds[start..end]);
        from.extend_from_slice(&input.from_stop[start..end]);
        to.extend_from_slice(&input.to_stop[start..end]);
        sequence.extend_from_slice(&input.sequence[start..end]);
        segment_trip.resize(segment_trip.len() + end - start, trip as u32);
        breaks.extend_from_slice(&input.continuity_break[start..end]);
        board.extend_from_slice(&input.can_board[start..end]);
        alight.extend_from_slice(&input.can_alight[start..end]);
        for index in start..end {
            if index == start
                || input.segment_run[index] != input.segment_run[index - 1]
                || input.continuity_break[index] != 0
            {
                run_count += 1;
            }
            segment_run.push(run_count - 1);
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
        Uint32Array::from(extended)
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

#[cfg(test)]
mod tests {
    use super::*;

    fn u32s(values: &[u32]) -> Uint32Array {
        Uint32Array::from(values.to_vec())
    }
    fn u8s(values: &[u8]) -> Uint8Array {
        Uint8Array::from(values.to_vec())
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
