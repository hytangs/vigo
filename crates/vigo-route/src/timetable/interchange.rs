//! Equal-objective express/local interchanges. Keep both selected vehicles and
//! the endpoint clocks, but stay on the faster service past stops the local
//! serves when a later shared platform still catches that same local train.
use super::*;
use std::collections::HashSet;

impl TimetableKernel {
    pub fn improve_interchanges(&self, journey: &mut TimetableMatrixJourney) -> bool {
        if journey.boardings < 2 {
            return false;
        }
        let mut changed = false;
        let rides: Vec<_> = journey
            .legs
            .iter()
            .enumerate()
            .filter_map(|(i, leg)| leg.trip.map(|_| i))
            .collect();
        let starts = self.trip_start.view();
        let sequence = self.sequence.view();
        let from = self.from_stop.view();
        let to = self.to_stop.view();
        let dep = self.departure_seconds.view();
        let arr = self.arrival_seconds.view();
        let board = self.can_board.view();
        let alight = self.can_alight.view();
        let breaks = self.continuity_break.view();
        for pair in rides.windows(2) {
            let (a, b) = (pair[0], pair[1]);
            let first = &journey.legs[a];
            let next = &journey.legs[b];
            let (Some(trip), Some(exit), Some(onward), Some(enter), Some(end)) = (
                first.trip,
                first.alight_sequence,
                next.trip,
                next.board_sequence,
                next.alight_sequence,
            ) else {
                continue;
            };
            if first.to_stop != next.from_stop
                || first.to_stop.is_none()
                || self.is_headway_trip(trip)
                || self.is_headway_trip(onward)
                || journey.legs[a + 1..b]
                    .iter()
                    .any(|l| l.kind != "walk" || l.arrival != l.departure)
            {
                continue;
            }
            let left = starts[trip as usize] as usize..starts[trip as usize + 1] as usize;
            let right = starts[onward as usize] as usize..starts[onward as usize + 1] as usize;
            let Some(old_exit) = left.clone().find(|&i| f64::from(sequence[i]) == exit) else {
                continue;
            };
            let Some(old_enter) = right.clone().find(|&i| f64::from(sequence[i]) == enter) else {
                continue;
            };
            // Only extend a contiguous, non-looping ride. Do not manufacture
            // continuity across a source gap, cancellation or repeated stop.
            let mut seen = HashSet::from([to[old_exit]]);
            let mut calls = HashMap::new();
            for i in old_exit + 1..left.end {
                if breaks[i] != 0 || from[i] != to[i - 1] || !seen.insert(to[i]) {
                    break;
                }
                if alight[i] == 1 {
                    calls.insert(to[i], i);
                }
            }
            let mut best = None;
            for j in old_enter + 1..right.end {
                if f64::from(sequence[j]) > end || breaks[j] != 0 || from[j] != to[j - 1] {
                    break;
                }
                let Some(&i) = calls.get(&from[j]) else {
                    continue;
                };
                let stop = from[j];
                // Scoped rules and nonzero same-stop minima retain the exact
                // certified transfer. Never infer platform permission from
                // station names, coordinates, or a matching public line.
                if board[j] != 1
                    || self.boarding_needs_transfer_context(stop)
                    || f64::from(arr[i]) + f64::from(self.minimum_transfer_buffer_seconds)
                        > f64::from(dep[j])
                    || i - old_exit >= j - old_enter
                    || f64::from(arr[i]) - first.arrival > f64::from(dep[j]) - next.departure
                {
                    continue;
                }
                best = Some((i, j, stop));
            }
            if let Some((i, j, stop)) = best {
                changed = true;
                journey.ride_seconds +=
                    f64::from(arr[i]) - first.arrival - (f64::from(dep[j]) - next.departure);
                let first = &mut journey.legs[a];
                first.to_stop = Some(stop);
                first.alight_sequence = Some(f64::from(sequence[i]));
                first.arrival = f64::from(arr[i]);
                for walk in &mut journey.legs[a + 1..b] {
                    walk.from_stop = Some(stop);
                    walk.to_stop = Some(stop);
                    walk.departure = f64::from(arr[i]);
                    walk.arrival = walk.departure;
                }
                let next = &mut journey.legs[b];
                next.from_stop = Some(stop);
                next.board_sequence = Some(f64::from(sequence[j]));
                next.departure = f64::from(dep[j]);
            }
        }
        journey.waiting_seconds =
            (journey.arrival - journey.departure - journey.walking_seconds - journey.ride_seconds)
                .max(0.);
        changed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Express O-X-Z, local X-A-B-Z-D. Both selected vehicles are retained.
    fn kernel(
        buffer: u32,
        forbidden: bool,
        minimum: u32,
        pickup: u8,
        dropoff: u8,
        arrival: u32,
    ) -> TimetableKernel {
        TimetableKernel::new(TimetableKernelInput {
            stop_count: 6,
            run_count: 2,
            departure_seconds: vec![0, 10, 12, 20, 30, 40].into(),
            arrival_seconds: vec![10, arrival, 20, 30, 40, 50].into(),
            from_stop: vec![0, 1, 1, 2, 3, 4].into(),
            to_stop: vec![1, 4, 2, 3, 4, 5].into(),
            sequence: vec![1, 2, 1, 2, 3, 4].into(),
            segment_trip: vec![0, 0, 1, 1, 1, 1].into(),
            segment_run: vec![0, 0, 1, 1, 1, 1].into(),
            continuity_break: vec![1, 0, 1, 0, 0, 0].into(),
            can_board: vec![1, 1, 1, 1, 1, pickup].into(),
            can_alight: vec![1, dropoff, 1, 1, 1, 1].into(),
            trip_start: vec![0, 2, 6].into(),
            departure_offset: vec![0, 1, 3, 4, 5, 5 + u32::from(pickup), 5 + u32::from(pickup)]
                .into(),
            departure_order: if pickup == 1 {
                vec![0, 1, 2, 3, 4, 5]
            } else {
                vec![0, 1, 2, 3, 4]
            }
            .into(),
            transfer_offset: vec![0; 7].into(),
            transfer_to: vec![].into(),
            transfer_duration: vec![].into(),
            forbidden_same_stop: vec![0, 0, 0, 0, u8::from(forbidden), 0].into(),
            same_stop_transfer_minimum: Some(vec![0, 0, 0, 0, minimum, 0].into()),
            minimum_transfer_buffer_seconds: Some(buffer),
        })
        .unwrap()
    }
    fn journey() -> TimetableMatrixJourney {
        let ride = |trip, from, to, board, alight, departure, arrival| TimetableMatrixLeg {
            in_seat_seconds: None,
            kind: "ride".into(),
            from_stop: Some(from),
            to_stop: Some(to),
            trip: Some(trip),
            board_sequence: Some(board),
            alight_sequence: Some(alight),
            departure,
            arrival,
        };
        TimetableMatrixJourney {
            departure: 0.,
            arrival: 50.,
            boardings: 2,
            walking_seconds: 0.,
            ride_seconds: 48.,
            waiting_seconds: 2.,
            legs: vec![
                ride(0, 0, 1, 1., 1., 0., 10.),
                ride(1, 1, 5, 1., 4., 12., 50.),
            ],
        }
    }
    #[test]
    fn later_express_interchange_keeps_clocks_vehicles_and_objectives() {
        let mut j = journey();
        kernel(5, false, 0, 1, 1, 35).improve_interchanges(&mut j);
        assert_eq!((j.legs[0].to_stop, j.legs[1].from_stop), (Some(4), Some(4)));
        assert_eq!(
            (j.legs[0].alight_sequence, j.legs[1].board_sequence),
            (Some(2.), Some(4.))
        );
        assert_eq!(
            (j.departure, j.arrival, j.boardings, j.walking_seconds),
            (0., 50., 2, 0.)
        );
        assert_eq!((j.ride_seconds, j.waiting_seconds), (45., 5.));
        assert_eq!((j.legs[0].trip, j.legs[1].trip), (Some(0), Some(1)));
        let before = serde_json::to_value(&j).unwrap();
        kernel(5, false, 0, 1, 1, 35).improve_interchanges(&mut j);
        assert_eq!(serde_json::to_value(j).unwrap(), before);
    }
    #[test]
    fn restrictions_buffers_and_missed_connections_keep_the_certified_transfer() {
        for k in [
            kernel(6, false, 0, 1, 1, 35),
            kernel(0, true, 0, 1, 1, 35),
            kernel(0, false, 10, 1, 1, 35),
            kernel(0, false, 0, 0, 1, 35),
            kernel(0, false, 0, 1, 0, 35),
            kernel(0, false, 0, 1, 1, 41),
        ] {
            let mut j = journey();
            let before = serde_json::to_value(&j).unwrap();
            k.improve_interchanges(&mut j);
            assert_eq!(serde_json::to_value(j).unwrap(), before);
        }
    }
    #[test]
    fn no_extra_ride_time_or_walking_and_no_service_gaps() {
        let k = kernel(0, false, 0, 1, 1, 39);
        let mut j = journey();
        k.improve_interchanges(&mut j);
        assert_eq!(j.legs[0].to_stop, Some(1), "Keep the shorter total ride");
        let mut k = kernel(0, false, 0, 1, 1, 35);
        k.continuity_break = vec![1, 1, 1, 0, 0, 0].into();
        let mut j = journey();
        k.improve_interchanges(&mut j);
        assert_eq!(j.legs[0].to_stop, Some(1), "Never bridge a service gap");
        let mut j = journey();
        let mut walk = j.legs[0].clone();
        walk.trip = None;
        walk.kind = "walk".into();
        walk.departure = 10.;
        walk.arrival = 11.;
        j.legs.insert(1, walk);
        j.walking_seconds = 1.;
        j.waiting_seconds = 1.;
        kernel(0, false, 0, 1, 1, 35).improve_interchanges(&mut j);
        assert_eq!(j.legs[0].to_stop, Some(1), "Retain a real platform walk");
    }
}
