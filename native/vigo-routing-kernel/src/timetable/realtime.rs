//! Build one immutable realtime view. The scheduled arrays remain borrowed and
//! unchanged; original trip indices survive cancellations and skipped calls.
use super::preparation::departure_index;
use napi::bindgen_prelude::*;
use napi_derive::napi;

#[napi(object)]
pub struct RealtimeCallInput {
    pub stop: u32,
    pub arrival: f64,
    pub departure: f64,
    pub sequence: f64,
    pub can_board: bool,
    pub can_alight: bool,
}
#[napi(object)]
pub struct RealtimeTripInput {
    pub trip: u32,
    pub stops: Vec<RealtimeCallInput>,
}
#[napi(object)]
pub struct RealtimeTimetableInput {
    pub stop_count: u32,
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
    pub replacements: Vec<RealtimeTripInput>,
}
#[napi(object)]
pub struct RealtimeTimetableResult {
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
    pub run_count: u32,
    pub active_segment_count: u32,
    pub realtime_trip_indices: Uint32Array,
}
fn invalid(trip: usize, detail: &str) -> Error {
    Error::new(
        Status::InvalidArg,
        format!("Invalid realtime timetable trip {trip}: {detail}."),
    )
}
fn malformed() -> Error {
    Error::new(
        Status::InvalidArg,
        "Malformed base realtime timetable arrays",
    )
}

#[napi]
pub fn compile_realtime_timetable(
    input: RealtimeTimetableInput,
) -> Result<RealtimeTimetableResult> {
    let segments = input.departure_seconds.len();
    let trips = input.canceled.len();
    if segments > i32::MAX as usize
        || trips > u32::MAX as usize
        || input.trip_start.len() != trips + 1
        || input.trip_start.first() != Some(&0)
        || input.trip_start.last().copied().map(|v| v as usize) != Some(segments)
        || input.trip_start.windows(2).any(|p| p[0] > p[1])
        || [
            &input.arrival_seconds,
            &input.from_stop,
            &input.to_stop,
            &input.sequence,
            &input.segment_run,
        ]
        .iter()
        .any(|v| v.len() != segments)
        || [&input.can_board, &input.can_alight, &input.continuity_break]
            .iter()
            .any(|v| v.len() != segments || v.iter().any(|&b| b > 1))
        || input.canceled.iter().any(|&v| v > 1)
        || input
            .from_stop
            .iter()
            .chain(input.to_stop.iter())
            .any(|&s| s >= input.stop_count)
    {
        return Err(malformed());
    }
    let mut replacements = vec![None; trips];
    for replacement in &input.replacements {
        let trip = replacement.trip as usize;
        if trip >= trips || replacements[trip].is_some() {
            return Err(invalid(trip, "unknown or duplicate original trip index"));
        }
        replacements[trip] = Some(replacement);
    }
    let mut count = 0_usize;
    let mut realtime_trip_indices = Vec::new();
    for (trip, replacement) in replacements.iter().enumerate() {
        if input.canceled[trip] != 0 {
            continue;
        }
        let added = if let Some(replacement) = replacement {
            let calls = &replacement.stops;
            if calls.len() > (1 << 15) + 1 {
                return Err(invalid(trip, "unsupported stop count"));
            }
            for (i, call) in calls.iter().enumerate() {
                if call.stop >= input.stop_count {
                    return Err(invalid(trip, "unknown stop index"));
                }
                if [call.arrival, call.departure].iter().any(|&t| {
                    !t.is_finite() || t.fract() != 0.0 || t < 0.0 || t > ((1 << 20) - 1) as f64
                }) || call.departure < call.arrival
                    || (i > 0 && call.arrival < calls[i - 1].departure)
                {
                    return Err(invalid(trip, "non-monotonic or unsupported event time"));
                }
                if !call.sequence.is_finite()
                    || call.sequence.fract() != 0.0
                    || call.sequence < 0.0
                    || call.sequence > u32::MAX as f64
                    || (i > 0 && call.sequence <= calls[i - 1].sequence)
                {
                    return Err(invalid(trip, "non-increasing or unsupported stop sequence"));
                }
            }
            realtime_trip_indices.push(trip as u32);
            calls.len().saturating_sub(1)
        } else {
            (input.trip_start[trip + 1] - input.trip_start[trip]) as usize
        };
        count = count
            .checked_add(added)
            .filter(|&v| v <= i32::MAX as usize)
            .ok_or_else(|| invalid(trip, "native segment domain exceeded"))?;
    }
    let mut departure = Vec::with_capacity(count);
    let mut arrival = Vec::with_capacity(count);
    let mut from = Vec::with_capacity(count);
    let mut to = Vec::with_capacity(count);
    let mut sequence = Vec::with_capacity(count);
    let mut segment_trip = Vec::with_capacity(count);
    let mut segment_run = Vec::with_capacity(count);
    let mut breaks = Vec::with_capacity(count);
    let mut board = Vec::with_capacity(count);
    let mut alight = Vec::with_capacity(count);
    let mut trip_start = Vec::with_capacity(trips + 1);
    let mut run_count = 0_u32;
    for (trip, replacement) in replacements.iter().enumerate() {
        trip_start.push(departure.len() as u32);
        if input.canceled[trip] != 0 {
            continue;
        }
        if let Some(replacement) = replacement {
            if replacement.stops.len() < 2 {
                continue;
            }
            run_count += 1;
            for pair in replacement.stops.windows(2) {
                departure.push(pair[0].departure as u32);
                arrival.push(pair[1].arrival as u32);
                from.push(pair[0].stop);
                to.push(pair[1].stop);
                sequence.push(pair[0].sequence as u32);
                segment_trip.push(trip as u32);
                segment_run.push(run_count - 1);
                breaks.push(0);
                board.push(u8::from(pair[0].can_board));
                alight.push(u8::from(pair[1].can_alight));
            }
        } else {
            let start = input.trip_start[trip] as usize;
            let end = input.trip_start[trip + 1] as usize;
            for i in start..end {
                if i == start
                    || input.segment_run[i] != input.segment_run[i - 1]
                    || input.continuity_break[i] != 0
                {
                    run_count += 1;
                }
                departure.push(input.departure_seconds[i]);
                arrival.push(input.arrival_seconds[i]);
                from.push(input.from_stop[i]);
                to.push(input.to_stop[i]);
                sequence.push(input.sequence[i]);
                segment_trip.push(trip as u32);
                segment_run.push(run_count - 1);
                breaks.push(input.continuity_break[i]);
                board.push(input.can_board[i]);
                alight.push(input.can_alight[i]);
            }
        }
        if run_count > (1 << 29) - 1 {
            return Err(invalid(trip, "native run domain exceeded"));
        }
    }
    trip_start.push(departure.len() as u32);
    let (departure_offset, departure_order) =
        departure_index(input.stop_count as usize, &from, &departure, &board)?;
    Ok(RealtimeTimetableResult {
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
        run_count,
        active_segment_count: count as u32,
        realtime_trip_indices: realtime_trip_indices.into(),
    })
}
