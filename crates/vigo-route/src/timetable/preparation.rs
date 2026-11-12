//! Cold timetable indexing. Preserve source insertion order for equal-cost
//! transfers, so moving preparation across Node-API does not change witnesses.
use crate::types::*;
use std::collections::{HashMap, HashSet};
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimetablePreparationInput {
    pub departure_seconds: U32Buffer,
    pub from_stop: U32Buffer,
    pub can_board: U8Buffer,
    pub retained_stops: U8Buffer,
    pub coordinates: F64Buffer,
    pub transfer_from: U32Buffer,
    pub transfer_to: U32Buffer,
    pub transfer_seconds: F64Buffer,
    pub forbidden_from: U32Buffer,
    pub forbidden_to: U32Buffer,
    pub station_offset: U32Buffer,
    pub station_members: U32Buffer,
    pub walking_speed_kph: f64,
}
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimetablePreparationResult {
    pub departure_offset: U32Buffer,
    pub departure_order: U32Buffer,
    pub transfer_offset: U32Buffer,
    pub transfer_to: U32Buffer,
    pub transfer_duration: U32Buffer,
    pub source_expanded_transfer_edges: f64,
    pub excluded_non_service_transfer_edges: f64,
    pub excluded_non_service_station_members: f64,
}

fn invalid(message: &str) -> Error {
    Error::new(
        ErrorCode::InvalidInput,
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
    let km = crate::geo::haversine_km([lon1, lat1], [lon2, lat2]);
    let seconds = (km / speed * 3600.0).ceil();
    if seconds.is_finite() {
        seconds.max(120.0)
    } else {
        0.0
    }
}
pub fn prepare_timetable_indexes(
    input: TimetablePreparationInput,
) -> Result<TimetablePreparationResult> {
    prepare_timetable_indexes_view(TimetablePreparationView {
        departure_seconds: &input.departure_seconds,
        from_stop: &input.from_stop,
        can_board: &input.can_board,
        retained_stops: &input.retained_stops,
        coordinates: &input.coordinates,
        transfer_from: &input.transfer_from,
        transfer_to: &input.transfer_to,
        transfer_seconds: &input.transfer_seconds,
        forbidden_from: &input.forbidden_from,
        forbidden_to: &input.forbidden_to,
        station_offset: &input.station_offset,
        station_members: &input.station_members,
        walking_speed_kph: input.walking_speed_kph,
    })
}

pub struct TimetablePreparationView<'a> {
    pub departure_seconds: &'a [u32],
    pub from_stop: &'a [u32],
    pub can_board: &'a [u8],
    pub retained_stops: &'a [u8],
    pub coordinates: &'a [f64],
    pub transfer_from: &'a [u32],
    pub transfer_to: &'a [u32],
    pub transfer_seconds: &'a [f64],
    pub forbidden_from: &'a [u32],
    pub forbidden_to: &'a [u32],
    pub station_offset: &'a [u32],
    pub station_members: &'a [u32],
    pub walking_speed_kph: f64,
}

pub fn prepare_timetable_indexes_view(
    input: TimetablePreparationView<'_>,
) -> Result<TimetablePreparationResult> {
    validate(&input)?;
    let transfers = transfer_index(&input)?;
    departure_indexes(&input, &transfers)
}

/// Walking transfers between retained stops: the part of
/// [`prepare_timetable_indexes_view`] that does not depend on departures, so
/// views with the same stops, transfers and walking speed can share it.
pub struct TransferIndex {
    pub transfer_offset: U32Buffer,
    pub transfer_to: U32Buffer,
    pub transfer_duration: U32Buffer,
    pub source_expanded_transfer_edges: f64,
    pub excluded_non_service_transfer_edges: f64,
    pub excluded_non_service_station_members: f64,
}

pub fn prepare_transfer_index_view(input: &TimetablePreparationView<'_>) -> Result<TransferIndex> {
    validate(input)?;
    transfer_index(input)
}

/// [`prepare_timetable_indexes_view`] with a [`TransferIndex`] prepared for
/// the same stops, transfers and walking speed.
pub fn prepare_departure_indexes_view(
    input: &TimetablePreparationView<'_>,
    transfers: &TransferIndex,
) -> Result<TimetablePreparationResult> {
    validate(input)?;
    departure_indexes(input, transfers)
}

fn departure_indexes(
    input: &TimetablePreparationView<'_>,
    transfers: &TransferIndex,
) -> Result<TimetablePreparationResult> {
    let (departure_offset, departure_order) = departure_index(
        input.retained_stops.len(),
        input.from_stop,
        input.departure_seconds,
        input.can_board,
    )?;
    Ok(TimetablePreparationResult {
        departure_offset: departure_offset.into(),
        departure_order: departure_order.into(),
        transfer_offset: transfers.transfer_offset.clone(),
        transfer_to: transfers.transfer_to.clone(),
        transfer_duration: transfers.transfer_duration.clone(),
        source_expanded_transfer_edges: transfers.source_expanded_transfer_edges,
        excluded_non_service_transfer_edges: transfers.excluded_non_service_transfer_edges,
        excluded_non_service_station_members: transfers.excluded_non_service_station_members,
    })
}

fn validate(input: &TimetablePreparationView<'_>) -> Result<()> {
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

    Ok(())
}

fn transfer_index(input: &TimetablePreparationView<'_>) -> Result<TransferIndex> {
    let stops = input.retained_stops.len();
    let edges = input.transfer_from.len();
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
                        input.coordinates,
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
    Ok(TransferIndex {
        transfer_offset: crate::Buffer::from_owner(transfer_offset),
        transfer_to: crate::Buffer::from_owner(transfer_to),
        transfer_duration: crate::Buffer::from_owner(transfer_duration),
        source_expanded_transfer_edges: source_edges as f64,
        excluded_non_service_transfer_edges: excluded_edges as f64,
        excluded_non_service_station_members: excluded_members as f64,
    })
}

/// Boardable departures grouped by stop in departure-time order, as offsets
/// and segment indexes. Shared by scheduled preparation and realtime views.
pub fn departure_index(
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
    // Distributing segments in global (time, index) order leaves every stop's
    // run sorted the same way, without sorting each stop.
    if times.iter().all(|&time| time <= super::EXIT_TIME_MASK) {
        for index in super::construction::departure_order(times) {
            let i = index as usize;
            if board[i] == 1 {
                departure_order[cursor[from[i] as usize] as usize] = index;
                cursor[from[i] as usize] += 1;
            }
        }
        return Ok((departure_offset, departure_order));
    }
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

#[cfg(test)]
mod index_reuse_tests {
    use super::*;

    #[test]
    fn linear_departure_index_matches_per_stop_sorting() {
        let mut seed = 11_u64;
        let mut next = |bound: u64| {
            seed = seed
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (seed >> 33) % bound
        };
        for segments in [0_usize, 5, 1500, 40_000] {
            let stops = 1 + segments / 30;
            let from: Vec<u32> = (0..segments).map(|_| next(stops as u64) as u32).collect();
            // Few distinct times, so ties between segments are common.
            let times: Vec<u32> = (0..segments)
                .map(|_| 18_000 + 60 * next(400) as u32)
                .collect();
            let board: Vec<u8> = (0..segments).map(|_| u8::from(next(10) > 0)).collect();
            let (offsets, order) = departure_index(stops, &from, &times, &board).unwrap();
            let mut expected = vec![Vec::new(); stops];
            for i in 0..segments {
                if board[i] == 1 {
                    expected[from[i] as usize].push(i as u32);
                }
            }
            for (stop, list) in expected.iter_mut().enumerate() {
                list.sort_unstable_by_key(|&i| (times[i as usize], i));
                let range = offsets[stop] as usize..offsets[stop + 1] as usize;
                assert_eq!(&order[range], list.as_slice());
            }
        }
    }

    #[test]
    fn shared_transfer_index_matches_full_preparation() {
        let view = TimetablePreparationView {
            departure_seconds: &[100, 50, 70, 50],
            from_stop: &[0, 1, 2, 1],
            can_board: &[1, 1, 1, 0],
            retained_stops: &[1, 1, 1, 0],
            coordinates: &[0., 0., 0.001, 0., 0.002, 0., 0.003, 0.],
            transfer_from: &[0, 1, 0, 2, u32::MAX],
            transfer_to: &[1, 2, 1, 3, 0],
            transfer_seconds: &[90., 60., 30., 10., 5.],
            forbidden_from: &[1],
            forbidden_to: &[2],
            station_offset: &[0, 3],
            station_members: &[0, 1, 2],
            walking_speed_kph: 4.8,
        };
        let full = prepare_timetable_indexes_view(TimetablePreparationView { ..view }).unwrap();
        let index = prepare_transfer_index_view(&view).unwrap();
        let shared = prepare_departure_indexes_view(&view, &index).unwrap();
        for (a, b) in [
            (&full.departure_offset, &shared.departure_offset),
            (&full.departure_order, &shared.departure_order),
            (&full.transfer_offset, &shared.transfer_offset),
            (&full.transfer_to, &shared.transfer_to),
            (&full.transfer_duration, &shared.transfer_duration),
        ] {
            assert_eq!(a[..], b[..]);
        }
        assert_eq!(
            full.excluded_non_service_transfer_edges,
            shared.excluded_non_service_transfer_edges
        );
    }
}
