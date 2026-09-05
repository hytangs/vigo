use crate::timetable::TimetableKernelInput;

pub(crate) fn kernel_input_is_valid(
    input: &TimetableKernelInput,
    scan_run_mask: u32,
    exit_time_mask: u32,
) -> bool {
    let stop_count = input.stop_count as usize;
    let run_count = input.run_count as usize;
    let segment_count = input.departure_seconds.len();
    let trip_count = input.trip_start.len().saturating_sub(1);
    stop_count != 0
        && run_count != 0
        && segment_count != 0
        && run_count <= scan_run_mask as usize
        && segment_count <= i32::MAX as usize
        && input.arrival_seconds.len() == segment_count
        && input.from_stop.len() == segment_count
        && input.to_stop.len() == segment_count
        && input.sequence.len() == segment_count
        && input.segment_trip.len() == segment_count
        && input.segment_run.len() == segment_count
        && input.continuity_break.len() == segment_count
        && input.can_board.len() == segment_count
        && input.can_alight.len() == segment_count
        && input.forbidden_same_stop.len() == stop_count
        && input
            .same_stop_transfer_minimum
            .as_ref()
            .is_none_or(|values| values.len() == stop_count)
        && input
            .from_stop
            .iter()
            .chain(input.to_stop.iter())
            .all(|stop| (*stop as usize) < stop_count)
        && input
            .segment_trip
            .iter()
            .all(|trip| (*trip as usize) < trip_count)
        && input
            .segment_run
            .iter()
            .all(|run| (*run as usize) < run_count)
        && input
            .departure_seconds
            .iter()
            .chain(input.arrival_seconds.iter())
            .all(|time| *time <= exit_time_mask)
        && scalar_invariants_are_valid(
            stop_count,
            &input.departure_seconds,
            &input.arrival_seconds,
            &input.transfer_to,
            &input.continuity_break,
            &input.can_board,
            &input.can_alight,
        )
        && trip_index_is_valid(segment_count, &input.trip_start, &input.segment_trip)
        && departure_index_is_valid(
            stop_count,
            segment_count,
            &input.departure_offset,
            &input.departure_order,
            &input.from_stop,
            &input.departure_seconds,
            &input.can_board,
        )
        && transfer_index_is_valid(
            stop_count,
            &input.transfer_offset,
            &input.transfer_to,
            &input.transfer_duration,
        )
}

pub(crate) fn scalar_invariants_are_valid(
    stop_count: usize,
    departure_seconds: &[u32],
    arrival_seconds: &[u32],
    transfer_to: &[u32],
    continuity_break: &[u8],
    can_board: &[u8],
    can_alight: &[u8],
) -> bool {
    transfer_to
        .iter()
        .all(|target| (*target as usize) < stop_count)
        && departure_seconds
            .iter()
            .zip(arrival_seconds)
            .all(|(departure, arrival)| arrival >= departure)
        && continuity_break.iter().all(|value| *value <= 1)
        && can_board.iter().all(|value| *value <= 1)
        && can_alight.iter().all(|value| *value <= 1)
}

pub(crate) fn trip_index_is_valid(
    segment_count: usize,
    trip_start: &[u32],
    segment_trip: &[u32],
) -> bool {
    if trip_start.len() < 2
        || trip_start.first() != Some(&0)
        || trip_start.last().copied() != Some(segment_count as u32)
        || trip_start.windows(2).any(|range| range[0] > range[1])
    {
        return false;
    }
    for trip in 0..trip_start.len() - 1 {
        let start = trip_start[trip] as usize;
        let end = trip_start[trip + 1] as usize;
        if end > segment_count
            || segment_trip[start..end]
                .iter()
                .any(|segment_trip| *segment_trip as usize != trip)
        {
            return false;
        }
    }
    true
}

pub(crate) fn departure_index_is_valid(
    stop_count: usize,
    segment_count: usize,
    departure_offset: &[u32],
    departure_order: &[u32],
    from_stop: &[u32],
    departure_seconds: &[u32],
    can_board: &[u8],
) -> bool {
    let boardable_count = can_board.iter().filter(|value| **value == 1).count();
    if departure_offset.len() != stop_count.saturating_add(1)
        || can_board.len() != segment_count
        || departure_order.len() != boardable_count
        || departure_offset.first() != Some(&0)
        || departure_offset.last().copied() != Some(boardable_count as u32)
        || departure_offset.windows(2).any(|range| range[0] > range[1])
    {
        return false;
    }
    let mut seen = vec![false; segment_count];
    for stop in 0..stop_count {
        let start = departure_offset[stop] as usize;
        let end = departure_offset[stop + 1] as usize;
        if end > departure_order.len() {
            return false;
        }
        let mut prior_departure = None;
        for &segment in &departure_order[start..end] {
            let index = segment as usize;
            if index >= segment_count
                || seen[index]
                || from_stop[index] as usize != stop
                || can_board[index] != 1
                || prior_departure.is_some_and(|prior| prior > departure_seconds[index])
            {
                return false;
            }
            seen[index] = true;
            prior_departure = Some(departure_seconds[index]);
        }
    }
    seen.into_iter()
        .zip(can_board)
        .all(|(present, boardable)| present == (*boardable == 1))
}

pub(crate) fn transfer_index_is_valid(
    stop_count: usize,
    transfer_offset: &[u32],
    transfer_to: &[u32],
    transfer_duration: &[u32],
) -> bool {
    transfer_offset.len() == stop_count.saturating_add(1)
        && transfer_to.len() == transfer_duration.len()
        && transfer_offset.first() == Some(&0)
        && transfer_offset.last().copied() == Some(transfer_to.len() as u32)
        && transfer_offset.windows(2).all(|range| range[0] <= range[1])
        && transfer_to
            .iter()
            .all(|target| (*target as usize) < stop_count)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_out_of_range_transfer_without_indexing_it() {
        assert!(!scalar_invariants_are_valid(
            2,
            &[10],
            &[20],
            &[u32::MAX],
            &[1],
            &[1],
            &[1],
        ));
        assert!(!transfer_index_is_valid(2, &[0, 1, 1], &[2], &[60]));
    }

    #[test]
    fn rejects_invalid_times_and_binary_flags() {
        assert!(!scalar_invariants_are_valid(
            2,
            &[20],
            &[10],
            &[1],
            &[0],
            &[2],
            &[1],
        ));
    }

    #[test]
    fn rejects_non_monotonic_or_mismatched_trip_ranges() {
        assert!(!trip_index_is_valid(2, &[0, 2, 1], &[0, 0]));
        assert!(!trip_index_is_valid(2, &[0, 1, 2], &[0, 0]));
        assert!(trip_index_is_valid(2, &[0, 1, 2], &[0, 1]));
    }

    #[test]
    fn rejects_incomplete_duplicate_or_unsorted_departure_indexes() {
        assert!(!departure_index_is_valid(
            2,
            2,
            &[0, 2, 2],
            &[0, 0],
            &[0, 0],
            &[10, 20],
            &[1, 1],
        ));
        assert!(!departure_index_is_valid(
            2,
            2,
            &[0, 2, 2],
            &[1, 0],
            &[0, 0],
            &[10, 20],
            &[1, 1],
        ));
        assert!(departure_index_is_valid(
            2,
            2,
            &[0, 2, 2],
            &[0, 1],
            &[0, 0],
            &[10, 20],
            &[1, 1],
        ));
        assert!(departure_index_is_valid(
            2,
            3,
            &[0, 1, 2],
            &[0, 2],
            &[0, 0, 1],
            &[10, 15, 20],
            &[1, 0, 1],
        ));
    }
}
