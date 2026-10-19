//! Optional, bounded substitutions on the active timetable. These are not
//! Pareto labels: an optimal scan can legitimately dominate another branch.
use super::*;

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedRideQuery {
    pub trip: u32,
    pub board_sequence: f64,
    pub alight_sequence: f64,
    pub earliest_departure: f64,
    pub latest_departure: f64,
    pub latest_arrival: f64,
    pub onward_departure: Option<f64>,
    pub onward_stop: Option<u32>,
    pub onward_walk_seconds: f64,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kernel(count: u32) -> TimetableKernel {
        TimetableKernel::new(TimetableKernelInput {
            stop_count: 2,
            run_count: count,
            departure_seconds: (10..10 + count).collect::<Vec<_>>().into(),
            arrival_seconds: (20..20 + count).collect::<Vec<_>>().into(),
            from_stop: vec![0; count as usize].into(),
            to_stop: vec![1; count as usize].into(),
            sequence: vec![1; count as usize].into(),
            segment_trip: (0..count).collect::<Vec<_>>().into(),
            segment_run: (0..count).collect::<Vec<_>>().into(),
            continuity_break: vec![1; count as usize].into(),
            can_board: vec![1; count as usize].into(),
            can_alight: vec![1; count as usize].into(),
            trip_start: (0..=count).collect::<Vec<_>>().into(),
            departure_offset: vec![0, count, count].into(),
            departure_order: (0..count).collect::<Vec<_>>().into(),
            transfer_offset: vec![0, 0, 0].into(),
            transfer_to: vec![].into(),
            transfer_duration: vec![].into(),
            forbidden_same_stop: vec![0, 0].into(),
            same_stop_transfer_minimum: Some(vec![0, 3].into()),
            minimum_transfer_buffer_seconds: Some(2),
        })
        .unwrap()
    }

    fn query() -> SharedRideQuery {
        SharedRideQuery {
            trip: 0,
            board_sequence: 1.,
            alight_sequence: 1.,
            earliest_departure: 10.,
            latest_departure: 1810.,
            latest_arrival: 2000.,
            onward_departure: None,
            onward_stop: None,
            onward_walk_seconds: 0.,
        }
    }

    #[test]
    fn bounds_are_explicit_and_queries_do_not_mutate_the_timetable() {
        let kernel = kernel(258);
        let result = kernel.shared_ride_options(query()).unwrap();
        assert_eq!(result.options.len(), 256);
        assert!(result.truncated);
        assert_eq!(result.options[0].trip, 1);
        assert_eq!(result.options[255].trip, 256);
        let mut invalid = query();
        invalid.latest_departure += 1.;
        assert!(kernel.shared_ride_options(invalid).is_err());
        let mut invalid = query();
        invalid.board_sequence = f64::NAN;
        assert!(kernel.shared_ride_options(invalid).is_err());
        assert_eq!(
            kernel.shared_ride_options(query()).unwrap().options.len(),
            256
        );
    }

    #[test]
    fn interchange_minimum_and_query_buffer_are_both_preserved() {
        let kernel = kernel(2);
        let mut q = query();
        q.onward_stop = Some(1);
        q.onward_departure = Some(25.);
        assert!(
            kernel
                .shared_ride_options(q.clone())
                .unwrap()
                .options
                .is_empty()
        );
        q.onward_departure = Some(26.);
        assert_eq!(kernel.shared_ride_options(q).unwrap().options.len(), 1);
    }
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedRideOption {
    pub trip: u32,
    pub board_sequence: f64,
    pub alight_sequence: f64,
    pub departure: f64,
    pub arrival: f64,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedRideResult {
    pub options: Vec<SharedRideOption>,
    pub truncated: bool,
}

impl TimetableKernel {
    pub fn shared_ride_options(&self, q: SharedRideQuery) -> Result<SharedRideResult> {
        if q.trip as usize + 1 >= self.trip_start.len()
            || [
                q.board_sequence,
                q.alight_sequence,
                q.earliest_departure,
                q.latest_departure,
                q.latest_arrival,
                q.onward_walk_seconds,
            ]
            .iter()
            .any(|n| !n.is_finite() || *n < 0.)
            || q.latest_departure < q.earliest_departure
            || q.latest_departure - q.earliest_departure > 1800.
            || q.onward_departure.is_some_and(|n| !n.is_finite() || n < 0.)
            || q.onward_stop.is_some_and(|s| s as usize >= self.stop_count)
            || q.onward_departure.is_some() != q.onward_stop.is_some()
        {
            return Err(Error::from_reason("Invalid shared-leg query"));
        }
        let starts = self.trip_start.view();
        let sequence = self.sequence.view();
        let from = self.from_stop.view();
        let to = self.to_stop.view();
        let dep = self.departure_seconds.view();
        let arr = self.arrival_seconds.view();
        let board = self.can_board.view();
        let alight = self.can_alight.view();
        let breaks = self.continuity_break.view();
        let trips = self.segment_trip.view();
        let span = starts[q.trip as usize] as usize..starts[q.trip as usize + 1] as usize;
        let first = span
            .clone()
            .find(|&i| f64::from(sequence[i]) == q.board_sequence);
        let last = span
            .clone()
            .find(|&i| f64::from(sequence[i]) == q.alight_sequence);
        let mut result = SharedRideResult {
            options: vec![],
            truncated: false,
        };
        let (Some(first), Some(last)) = (first, last) else {
            return Ok(result);
        };
        if first > last || (first + 1..=last).any(|i| breaks[i] != 0 || from[i] != to[i - 1]) {
            return Ok(result); // Do not equate untimed gaps with verified stopping patterns.
        }
        let stop = from[first] as usize;
        let latest = if let (Some(departure), Some(stop)) = (q.onward_departure, q.onward_stop) {
            // Conservatively retain the same-stop minimum even with a zero-time
            // transfer leg. Positive transfers already carry their path cost.
            let buffer = boarding_ready_time(
                0.,
                true,
                q.onward_walk_seconds == 0.,
                self.same_stop_transfer_minimum[stop as usize],
                self.minimum_transfer_buffer_seconds,
            );
            q.latest_arrival
                .min(departure - q.onward_walk_seconds - buffer)
        } else {
            q.latest_arrival
        };
        let events = &self.departure_events
            [self.departure_offset[stop] as usize..self.departure_offset[stop + 1] as usize];
        let begin =
            events.partition_point(|event| f64::from(event.departure) < q.earliest_departure);
        let mut seen = std::collections::HashSet::new();
        'events: for event in &events[begin..] {
            if f64::from(event.departure) > q.latest_departure {
                break;
            }
            let run = event.run as usize;
            for start in self.run_start[run] as usize..self.run_end[run] as usize {
                if from[start] != stop as u32 || dep[start] != event.departure || board[start] == 0
                {
                    continue;
                }
                let end = start + (last - first);
                if end >= self.run_end[run] as usize
                    || alight[end] == 0
                    || f64::from(arr[end]) > latest
                    || !seen.insert(start)
                    || (trips[start] == q.trip && sequence[start] as f64 == q.board_sequence)
                {
                    continue;
                }
                if (first..=last).zip(start..=end).any(|(a, b)| {
                    from[a] != from[b]
                        || to[a] != to[b]
                        || board[a] != board[b]
                        || alight[a] != alight[b]
                        || (b > start && (breaks[b] != 0 || from[b] != to[b - 1]))
                }) {
                    continue;
                }
                if result.options.len() == 256 {
                    result.truncated = true;
                    break 'events;
                }
                result.options.push(SharedRideOption {
                    trip: trips[start],
                    board_sequence: sequence[start] as f64,
                    alight_sequence: sequence[end] as f64,
                    departure: dep[start] as f64,
                    arrival: arr[end] as f64,
                });
            }
        }
        result.options.sort_by(|a, b| {
            a.arrival
                .total_cmp(&b.arrival)
                .then(a.departure.total_cmp(&b.departure))
                .then(a.trip.cmp(&b.trip))
                .then(a.board_sequence.total_cmp(&b.board_sequence))
        });
        Ok(result)
    }
}
