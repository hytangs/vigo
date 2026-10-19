//! Build one immutable realtime view. The scheduled arrays remain borrowed and
//! unchanged; original trip indices survive cancellations and skipped calls.
use super::preparation::departure_index;
use crate::types::*;
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RealtimeCallInput {
    pub stop: u32,
    pub arrival: f64,
    pub departure: f64,
    pub sequence: f64,
    pub can_board: bool,
    pub can_alight: bool,
}
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RealtimeTripInput {
    pub trip: u32,
    pub stops: Vec<RealtimeCallInput>,
}
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RealtimeTimetableInput {
    pub stop_count: u32,
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
    pub replacements: Vec<RealtimeTripInput>,
}
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RealtimeTimetableResult {
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
    pub run_count: u32,
    pub active_segment_count: u32,
    pub realtime_trip_indices: U32Buffer,
}
fn invalid(trip: usize, detail: &str) -> Error {
    Error::new(
        ErrorCode::InvalidInput,
        format!("Invalid realtime timetable trip {trip}: {detail}."),
    )
}
fn malformed() -> Error {
    Error::new(
        ErrorCode::InvalidInput,
        "Malformed base realtime timetable arrays",
    )
}
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
            departure.extend_from_slice(&input.departure_seconds[start..end]);
            arrival.extend_from_slice(&input.arrival_seconds[start..end]);
            from.extend_from_slice(&input.from_stop[start..end]);
            to.extend_from_slice(&input.to_stop[start..end]);
            sequence.extend_from_slice(&input.sequence[start..end]);
            segment_trip.resize(segment_trip.len() + end - start, trip as u32);
            breaks.extend_from_slice(&input.continuity_break[start..end]);
            board.extend_from_slice(&input.can_board[start..end]);
            alight.extend_from_slice(&input.can_alight[start..end]);
            for i in start..end {
                if i == start
                    || input.segment_run[i] != input.segment_run[i - 1]
                    || input.continuity_break[i] != 0
                {
                    run_count += 1;
                }
                segment_run.push(run_count - 1);
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
