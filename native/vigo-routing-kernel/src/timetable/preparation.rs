//! Cold timetable indexing. Preserve source insertion order for equal-cost
//! transfers, so moving preparation across Node-API does not change witnesses.
use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::collections::{HashMap, HashSet};

#[napi(object)]
pub struct TimetablePreparationInput {
    pub departure_seconds: Uint32Array,
    pub from_stop: Uint32Array,
    pub can_board: Uint8Array,
    pub retained_stops: Uint8Array,
    pub coordinates: Float64Array,
    pub transfer_from: Uint32Array,
    pub transfer_to: Uint32Array,
    pub transfer_seconds: Float64Array,
    pub forbidden_from: Uint32Array,
    pub forbidden_to: Uint32Array,
    pub station_offset: Uint32Array,
    pub station_members: Uint32Array,
    pub walking_speed_kph: f64,
}

#[napi(object)]
pub struct TimetablePreparationResult {
    pub departure_offset: Uint32Array,
    pub departure_order: Uint32Array,
    pub transfer_offset: Uint32Array,
    pub transfer_to: Uint32Array,
    pub transfer_duration: Uint32Array,
    pub source_expanded_transfer_edges: f64,
    pub excluded_non_service_transfer_edges: f64,
    pub excluded_non_service_station_members: f64,
}

fn invalid(message: &str) -> Error {
    Error::new(
        Status::InvalidArg,
        format!("Timetable preparation: {message}"),
    )
}

// Match the existing Float64 -> Uint32 snapshot conversion, including truncation.
fn snapshot_seconds(seconds: f64) -> u32 {
    if seconds.is_finite() {
        seconds.max(0.0).trunc().rem_euclid(4_294_967_296.0) as u32
    } else {
        0
    }
}

fn fallback_seconds(coordinates: &[f64], from: usize, to: usize, speed: f64) -> f64 {
    let (lon1, lat1, lon2, lat2) = (
        coordinates[2 * from],
        coordinates[2 * from + 1],
        coordinates[2 * to],
        coordinates[2 * to + 1],
    );
    // Match the shared JS station fallback's order of arithmetic, including its
    // 120-second floor. Invalid source coordinates previously normalized to zero.
    let radians = |value: f64| value * std::f64::consts::PI / 180.0;
    let value = (radians(lat2 - lat1) / 2.0).sin().powi(2)
        + radians(lat1).cos() * radians(lat2).cos() * (radians(lon2 - lon1) / 2.0).sin().powi(2);
    let km = 6371.0088 * 2.0 * value.sqrt().atan2((1.0 - value).sqrt());
    let seconds = (km / speed * 3600.0).ceil();
    if seconds.is_finite() {
        seconds.max(120.0)
    } else {
        0.0
    }
}

#[napi]
pub fn prepare_timetable_indexes(
    input: TimetablePreparationInput,
) -> Result<TimetablePreparationResult> {
    let stops = input.retained_stops.len();
    let segments = input.departure_seconds.len();
    if stops >= u32::MAX as usize
        || segments > u32::MAX as usize
        || input.coordinates.len()
            != stops
                .checked_mul(2)
                .ok_or_else(|| invalid("stop count overflow"))?
        || input.from_stop.len() != segments
        || input.can_board.len() != segments
    {
        return Err(invalid("inconsistent stop or departure arrays"));
    }
    if !input.walking_speed_kph.is_finite() || input.walking_speed_kph <= 0.0 {
        return Err(invalid("walking speed must be finite and positive"));
    }
    if input
        .retained_stops
        .iter()
        .chain(input.can_board.iter())
        .any(|&v| v > 1)
        || input.from_stop.iter().any(|&s| s as usize >= stops)
    {
        return Err(invalid("invalid stop index or permission mask"));
    }
    let edges = input.transfer_from.len();
    if input.transfer_to.len() != edges
        || input.transfer_seconds.len() != edges
        || input.forbidden_from.len() != input.forbidden_to.len()
    {
        return Err(invalid("inconsistent transfer arrays"));
    }
    // u32::MAX denotes a source ID absent from the active stop dictionary.
    if input
        .transfer_from
        .iter()
        .chain(input.transfer_to.iter())
        .any(|&s| s != u32::MAX && s as usize >= stops)
        || input
            .forbidden_from
            .iter()
            .chain(input.forbidden_to.iter())
            .chain(input.station_members.iter())
            .any(|&s| s as usize >= stops)
    {
        return Err(invalid("transfer stop index out of range"));
    }
    if input.station_offset.first() != Some(&0)
        || input.station_offset.last().copied().map(|v| v as usize)
            != Some(input.station_members.len())
        || input
            .station_offset
            .windows(2)
            .any(|pair| pair[0] > pair[1])
    {
        return Err(invalid("invalid station membership offsets"));
    }

    let (departure_offset, departure_order) = departure_index(
        stops,
        &input.from_stop,
        &input.departure_seconds,
        &input.can_board,
    )?;

    let forbidden: HashSet<(u32, u32)> = input
        .forbidden_from
        .iter()
        .copied()
        .zip(input.forbidden_to.iter().copied())
        .collect();
    let mut adjacency: Vec<Vec<(u32, f64)>> = vec![Vec::new(); stops];
    let mut positions: HashMap<(u32, u32), usize> = HashMap::new();
    let mut source_edges = 0_u64;
    let mut excluded_edges = 0_u64;
    let mut excluded_members = 0_u64;
    for index in 0..edges {
        let (from, to) = (input.transfer_from[index], input.transfer_to[index]);
        if forbidden.contains(&(from, to)) {
            continue;
        }
        source_edges += 1;
        if to == u32::MAX || input.retained_stops[to as usize] == 0 {
            excluded_edges += 1;
            continue;
        }
        if from == u32::MAX || from == to {
            continue;
        }
        let raw = input.transfer_seconds[index];
        let duration = if raw.is_finite() { raw.max(0.0) } else { 0.0 };
        let row = &mut adjacency[from as usize];
        if let Some(&position) = positions.get(&(from, to)) {
            row[position].1 = row[position].1.min(duration);
        } else {
            positions.insert((from, to), row.len());
            row.push((to, duration));
        }
    }
    for offsets in input.station_offset.windows(2) {
        let mut seen = HashSet::new();
        let mut members = Vec::new();
        for &stop in &input.station_members[offsets[0] as usize..offsets[1] as usize] {
            if !seen.insert(stop) {
                continue;
            }
            if input.retained_stops[stop as usize] == 0 {
                excluded_members += 1;
            } else {
                members.push(stop);
            }
        }
        for &from in &members {
            for &to in &members {
                if from == to
                    || forbidden.contains(&(from, to))
                    || positions.contains_key(&(from, to))
                {
                    continue;
                }
                let row = &mut adjacency[from as usize];
                positions.insert((from, to), row.len());
                row.push((
                    to,
                    fallback_seconds(
                        &input.coordinates,
                        from as usize,
                        to as usize,
                        input.walking_speed_kph,
                    ),
                ));
            }
        }
    }
    let mut transfer_offset = Vec::with_capacity(stops + 1);
    transfer_offset.push(0_u32);
    for row in &adjacency {
        let count = u32::try_from(row.len()).map_err(|_| invalid("transfer count overflow"))?;
        transfer_offset.push(
            transfer_offset
                .last()
                .unwrap()
                .checked_add(count)
                .ok_or_else(|| invalid("transfer count overflow"))?,
        );
    }
    let count = transfer_offset[stops] as usize;
    let mut transfer_to = Vec::with_capacity(count);
    let mut transfer_duration = Vec::with_capacity(count);
    for row in adjacency {
        for (to, seconds) in row {
            transfer_to.push(to);
            transfer_duration.push(snapshot_seconds(seconds));
        }
    }
    Ok(TimetablePreparationResult {
        departure_offset: departure_offset.into(),
        departure_order: departure_order.into(),
        transfer_offset: transfer_offset.into(),
        transfer_to: transfer_to.into(),
        transfer_duration: transfer_duration.into(),
        source_expanded_transfer_edges: source_edges as f64,
        excluded_non_service_transfer_edges: excluded_edges as f64,
        excluded_non_service_station_members: excluded_members as f64,
    })
}

// Shared by scheduled preparation and immutable realtime reconstruction.
pub(super) fn departure_index(
    stops: usize,
    from: &[u32],
    times: &[u32],
    board: &[u8],
) -> Result<(Vec<u32>, Vec<u32>)> {
    if from.len() != times.len()
        || board.len() != times.len()
        || times.len() > u32::MAX as usize
        || from.iter().any(|&s| s as usize >= stops)
        || board.iter().any(|&v| v > 1)
    {
        return Err(invalid("invalid departure arrays"));
    }
    let mut departure_offset = vec![0_u32; stops + 1];
    for (&from, &board) in from.iter().zip(board.iter()) {
        if board == 1 {
            departure_offset[from as usize + 1] += 1;
        }
    }
    for stop in 0..stops {
        departure_offset[stop + 1] += departure_offset[stop];
    }
    let mut departure_order = vec![0; departure_offset[stops] as usize];
    let mut cursor = departure_offset[..stops].to_vec();
    for (index, (&from, &board)) in from.iter().zip(board.iter()).enumerate() {
        if board == 1 {
            departure_order[cursor[from as usize] as usize] = index as u32;
            cursor[from as usize] += 1;
        }
    }
    for stop in 0..stops {
        departure_order[departure_offset[stop] as usize..departure_offset[stop + 1] as usize]
            .sort_unstable_by_key(|&index| (times[index as usize], index));
    }
    Ok((departure_offset, departure_order))
}
