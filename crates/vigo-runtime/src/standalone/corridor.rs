//! Stay-aboard turnaround detours. A published in-seat continuation lets a
//! journey stay on a vehicle through its terminal layover. That is a real
//! choice when it moves the rider onward, and a detour when the vehicle only
//! brings the rider back to where they already were.
//!
//! The test uses the journey's own stops and clocks, the linked trips' own
//! boundaries, and the City's stop-to-stop walks with the request's transfer
//! buffer. After a continuation boundary, the journey is a detour when the
//! vehicle reaches a stop the rider could already have reached sooner: the same
//! stop, or one a transfer walk away from a stop they were at. It is also a
//! detour when leaving the vehicle before the boundary reaches the
//! destination no later, or when walking from the origin to a stop after the
//! boundary catches the vehicle there. Direction, headsign and trip changes
//! alone never decide it.
use super::{Result, city::Timetable, linked_trips::Links};
use crate::{
    TimetableKernel, TimetableMatrixJourney, TimetableMatrixLeg, TimetableMatrixQueryInput,
};
use std::collections::HashMap;
use vigo_route::timetable::RideVisit;

struct Reach<'a> {
    kernel: &'a TimetableKernel,
    buffer: f64,
    earliest: HashMap<u32, f64>,
}

impl Reach<'_> {
    fn put(&mut self, stop: u32, time: f64) {
        let entry = self.earliest.entry(stop).or_insert(f64::INFINITY);
        *entry = entry.min(time);
    }
    /// The rider was at `stop` at `time`, and may walk on from there.
    fn visit(&mut self, stop: u32, time: f64) {
        self.put(stop, time);
        for (to, seconds) in self.kernel.transfer_walks(stop) {
            self.put(to, time + f64::from(seconds) + self.buffer);
        }
    }
    fn reached_by(&self, stop: u32, time: f64) -> bool {
        self.earliest.get(&stop).is_some_and(|&t| t <= time)
    }
}

/// A linked ride's stops split at its continuation boundaries: each piece
/// starts where the previous one ends, at the stop where staying aboard
/// begins. A ride within one source trip is a single piece.
fn ride_pieces(
    kernel: &TimetableKernel,
    links: &Links,
    trip: u32,
    board: f64,
    alight: f64,
) -> Vec<Vec<RideVisit>> {
    let visits = kernel.ride_visits(trip, board, alight);
    // Visit i is the vehicle at the end of segment `board + i - 1`, so the
    // boundary before source trip part `first` is visit `first - board`.
    let mut boundaries: Vec<usize> = links
        .get(&trip)
        .into_iter()
        .flatten()
        .map(|part| f64::from(part.first))
        .filter(|&first| first > board && first <= alight)
        .map(|first| (first - board) as usize)
        .filter(|&i| i < visits.len())
        .collect();
    boundaries.sort_unstable();
    let mut pieces = vec![];
    let mut start = 0;
    for boundary in boundaries {
        pieces.push(visits[start..=boundary].to_vec());
        start = boundary;
    }
    pieces.push(visits[start..].to_vec());
    pieces
}

fn minimum_by_stop(stops: &[u32], seconds: &[f64]) -> HashMap<u32, f64> {
    let mut out = HashMap::new();
    for (&stop, &walk) in stops.iter().zip(seconds) {
        let entry = out.entry(stop).or_insert(f64::INFINITY);
        *entry = f64::min(*entry, walk);
    }
    out
}

/// Board a linked ride where the vehicle passes again after a continuation
/// boundary: at the boarding stop itself, or, for the first ride, at a stop
/// the origin reaches by walking in time. Arrival and boardings are
/// unchanged; the rider waits or walks instead of riding the loop. The same
/// stop wins over a new walk, then the shortest walk, then the latest pass.
pub(super) fn board_last_pass(
    kernel: &TimetableKernel,
    links: &Links,
    input: &TimetableMatrixQueryInput,
    journey: &mut TimetableMatrixJourney,
) -> Result<()> {
    let access = minimum_by_stop(&input.origin_stops, &input.origin_walk_seconds);
    let mut i = 0;
    while i < journey.legs.len() {
        let leg = &journey.legs[i];
        let first_ride = journey.legs[..i].iter().all(|l| l.trip.is_none());
        let (Some(trip), Some(board), Some(alight), Some(stop)) = (
            leg.trip,
            leg.board_sequence,
            leg.alight_sequence,
            leg.from_stop,
        ) else {
            i += 1;
            continue;
        };
        i += 1;
        let Some(parts) = links.get(&trip) else {
            continue;
        };
        if kernel.is_headway_trip(trip) {
            continue;
        }
        // Only source trips after the one boarded follow a boundary.
        let mut boarded = false;
        // (walk seconds, -sequence): ordered by the preference above.
        let mut best: Option<(f64, f64, u32)> = None;
        for part in parts {
            let first = f64::from(part.first);
            if boarded {
                for j in 0..part.sequences.len() {
                    let sequence = first + j as f64;
                    let at = part.from[j];
                    let walk = if at == stop {
                        Some(-1.)
                    } else if first_ride {
                        access.get(&at).copied().filter(|&walk| {
                            journey.departure + walk <= f64::from(part.departures[j])
                        })
                    } else {
                        None
                    };
                    let Some(walk) = walk else {
                        continue;
                    };
                    if sequence <= alight
                        && kernel.ride_can_board(trip, sequence)
                        && best.is_none_or(|(w, s, _)| (walk, -sequence) < (w, s))
                    {
                        best = Some((walk, -sequence, at));
                    }
                }
            }
            boarded |= first <= board && board < first + part.sequences.len() as f64;
        }
        let Some((walk, sequence, at)) = best else {
            continue;
        };
        let sequence = -sequence;
        let departure = kernel.ride_departure(trip, sequence)?;
        let mut ride = i - 1;
        if walk >= 0. {
            // The new access walk replaces every walk before the first ride.
            let before: f64 = journey.legs[..ride]
                .iter()
                .map(|l| l.arrival - l.departure)
                .sum();
            journey.walking_seconds += walk - before;
            journey.legs.splice(
                ..ride,
                [TimetableMatrixLeg {
                    in_seat_seconds: None,
                    kind: "walk".into(),
                    from_stop: None,
                    to_stop: Some(at),
                    trip: None,
                    board_sequence: None,
                    alight_sequence: None,
                    departure: journey.departure,
                    arrival: journey.departure + walk,
                }],
            );
            ride = 1;
            i = 2;
        }
        let leg = &mut journey.legs[ride];
        journey.ride_seconds -= departure - leg.departure;
        leg.from_stop = Some(at);
        leg.board_sequence = Some(sequence);
        leg.departure = departure;
        journey.waiting_seconds =
            (journey.arrival - journey.departure - journey.walking_seconds - journey.ride_seconds)
                .max(0.);
    }
    Ok(())
}

/// Whether `journey` stays aboard through a turnaround and returns to its own
/// corridor; see the module documentation.
pub(super) fn detours(
    kernel: &TimetableKernel,
    links: &Links,
    input: &TimetableMatrixQueryInput,
    journey: &TimetableMatrixJourney,
) -> bool {
    if links.is_empty() {
        return false;
    }
    let access = minimum_by_stop(&input.origin_stops, &input.origin_walk_seconds);
    let egress = minimum_by_stop(&input.destination_stops, &input.destination_walk_seconds);
    let mut reach = Reach {
        kernel,
        buffer: f64::from(kernel.minimum_transfer_buffer_seconds()),
        earliest: HashMap::new(),
    };
    for leg in &journey.legs {
        let (Some(trip), Some(board), Some(alight)) =
            (leg.trip, leg.board_sequence, leg.alight_sequence)
        else {
            for (stop, time) in [(leg.from_stop, leg.departure), (leg.to_stop, leg.arrival)] {
                if let Some(stop) = stop {
                    reach.visit(stop, time);
                }
            }
            continue;
        };
        let pieces = ride_pieces(kernel, links, trip, board, alight);
        for (k, calls) in pieces.iter().enumerate() {
            if k > 0 {
                // The boundary stop itself is where staying aboard begins.
                // Reaching a later stop sooner only helps where the rider may
                // board there, or where the ride ends anyway.
                for v in calls[1..].iter().filter(|v| v.board) {
                    let from_origin = access
                        .get(&v.stop)
                        .is_some_and(|&walk| journey.departure + walk <= v.time);
                    if reach.reached_by(v.stop, v.time) || from_origin {
                        return true;
                    }
                }
            }
            // The rider is at the boarding stop, and may leave only where the
            // vehicle lets passengers off.
            let present = |i: usize, v: &RideVisit| v.leave || (k == 0 && i == 0);
            if k + 1 < pieces.len() {
                if calls.iter().enumerate().any(|(i, v)| {
                    present(i, v)
                        && egress
                            .get(&v.stop)
                            .is_some_and(|&walk| v.time + walk <= journey.arrival)
                }) {
                    return true;
                }
                let (boundary, before) = calls.split_last().unwrap();
                for (i, v) in before.iter().enumerate() {
                    if present(i, v) {
                        reach.visit(v.stop, v.time);
                    }
                }
                // Walking on from the boundary is not a return to the corridor.
                reach.put(boundary.stop, boundary.time);
            } else {
                for (i, v) in calls.iter().enumerate() {
                    if present(i, v) {
                        reach.visit(v.stop, v.time);
                    }
                }
            }
        }
    }
    false
}

/// Alternatives without turnaround detours, each boarded on its last pass.
pub(super) fn settle(
    t: &Timetable,
    input: &TimetableMatrixQueryInput,
    journeys: &mut Vec<TimetableMatrixJourney>,
) -> Result<()> {
    for journey in journeys.iter_mut() {
        board_last_pass(&t.kernel, &t.links, input, journey)?;
    }
    journeys.retain(|journey| !detours(&t.kernel, &t.links, input, journey));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::linked_trips::Part;
    use super::*;
    use crate::TimetableKernelInput;

    /// One vehicle runs `stops` as a single linked run: the first two
    /// segments are the outbound source trip, the last two the inbound one,
    /// after a ten-second layover at the turnaround.
    fn block(stops: [u32; 5], walks: &[(u32, u32, u32)]) -> (TimetableKernel, Links) {
        block_with(stops, walks, [1; 4])
    }

    /// `block` where `alight[i]` permits leaving at the end of segment `i`.
    fn block_with(
        stops: [u32; 5],
        walks: &[(u32, u32, u32)],
        alight: [u8; 4],
    ) -> (TimetableKernel, Links) {
        let departures = [10, 20, 40, 50];
        let arrivals = [20, 30, 50, 60];
        let stop_count = 6;
        let mut departure_offset = vec![0u32];
        let mut departure_order = vec![];
        for stop in 0..stop_count {
            for (segment, &from) in stops[..4].iter().enumerate() {
                if from == stop {
                    departure_order.push(segment as u32);
                }
            }
            departure_offset.push(departure_order.len() as u32);
        }
        let mut transfer_offset = vec![0u32];
        let (mut transfer_to, mut transfer_duration) = (vec![], vec![]);
        for stop in 0..stop_count {
            for &(from, to, seconds) in walks {
                if from == stop {
                    transfer_to.push(to);
                    transfer_duration.push(seconds);
                }
            }
            transfer_offset.push(transfer_to.len() as u32);
        }
        let kernel = TimetableKernel::new(TimetableKernelInput {
            stop_count,
            run_count: 1,
            departure_seconds: departures.to_vec().into(),
            arrival_seconds: arrivals.to_vec().into(),
            from_stop: stops[..4].to_vec().into(),
            to_stop: stops[1..].to_vec().into(),
            sequence: vec![0, 1, 2, 3].into(),
            segment_trip: vec![0; 4].into(),
            segment_run: vec![0; 4].into(),
            continuity_break: vec![1, 0, 0, 0].into(),
            can_board: vec![1; 4].into(),
            can_alight: alight.to_vec().into(),
            trip_start: vec![0, 4].into(),
            departure_offset: departure_offset.into(),
            departure_order: departure_order.into(),
            transfer_offset: transfer_offset.into(),
            transfer_to: transfer_to.into(),
            transfer_duration: transfer_duration.into(),
            forbidden_same_stop: vec![0; stop_count as usize].into(),
            same_stop_transfer_minimum: None,
            minimum_transfer_buffer_seconds: None,
        })
        .unwrap();
        let part = |first: usize| Part {
            trip: first as u32 / 2 + 1,
            first: first as u32,
            sequences: vec![1, 2],
            departures: departures[first..first + 2].to_vec(),
            arrivals: arrivals[first..first + 2].to_vec(),
            from: stops[first..first + 2].to_vec(),
            to: stops[first + 1..first + 3].to_vec(),
        };
        (
            kernel,
            Links::new(HashMap::from([(0, vec![part(0), part(2)])])),
        )
    }

    fn input(origin: u32, destination: u32) -> TimetableMatrixQueryInput {
        TimetableMatrixQueryInput {
            origin_offsets: vec![0, 1],
            origin_stops: vec![origin],
            origin_walk_seconds: vec![0.],
            allow_pre_ride_transfers: vec![false],
            destination_offsets: vec![0, 1],
            destination_stops: vec![destination],
            destination_walk_seconds: vec![0.],
            allow_post_ride_transfers: Some(vec![false]),
            departure: 0.,
            horizon: 100.,
            arrive_by: false,
            maximum_boardings: None,
            include_journeys: Some(true),
        }
    }

    fn ride(from: u32, to: u32, board: f64, departure: f64) -> TimetableMatrixJourney {
        let walk = |from: Option<u32>, to: Option<u32>, at: f64| TimetableMatrixLeg {
            in_seat_seconds: None,
            kind: "walk".into(),
            from_stop: from,
            to_stop: to,
            trip: None,
            board_sequence: None,
            alight_sequence: None,
            departure: at,
            arrival: at,
        };
        TimetableMatrixJourney {
            departure: 0.,
            arrival: 60.,
            boardings: 1,
            walking_seconds: 0.,
            ride_seconds: 60. - departure,
            waiting_seconds: departure,
            legs: vec![
                walk(None, Some(from), 0.),
                TimetableMatrixLeg {
                    in_seat_seconds: None,
                    kind: "ride".into(),
                    from_stop: Some(from),
                    to_stop: Some(to),
                    trip: Some(0),
                    board_sequence: Some(board),
                    alight_sequence: Some(3.),
                    departure,
                    arrival: 60.,
                },
                walk(Some(to), None, 60.),
            ],
        }
    }

    #[test]
    fn returning_past_an_opposite_stop_is_a_detour() {
        // 0 -> 1 -> turnaround 2 -> 3 (across the street from 1) -> 4.
        let (kernel, links) = block([0, 1, 2, 3, 4], &[(1, 3, 20)]);
        assert!(detours(&kernel, &links, &input(0, 4), &ride(0, 4, 0., 10.)));
        // Without the walk, staying aboard is how the rider reaches stop 3.
        let (kernel, links) = block([0, 1, 2, 3, 4], &[]);
        assert!(!detours(
            &kernel,
            &links,
            &input(0, 4),
            &ride(0, 4, 0., 10.)
        ));
    }

    #[test]
    fn a_stop_without_drop_off_is_not_a_place_the_rider_was() {
        // Riders may not leave at stop 1, so they cannot walk across to 3.
        let (kernel, links) = block_with([0, 1, 2, 3, 4], &[(1, 3, 20)], [0, 1, 1, 1]);
        assert!(!detours(
            &kernel,
            &links,
            &input(0, 4),
            &ride(0, 4, 0., 10.)
        ));
    }

    #[test]
    fn leaving_before_the_turnaround_reaches_the_destination_no_later() {
        // Stop 1 is a destination stop: the overshoot through 2 adds nothing.
        let (kernel, links) = block([0, 1, 2, 3, 4], &[]);
        let mut journey_input = input(0, 4);
        journey_input.destination_stops = vec![4, 1];
        journey_input.destination_walk_seconds = vec![0., 30.];
        journey_input.destination_offsets = vec![0, 2];
        assert!(detours(
            &kernel,
            &links,
            &journey_input,
            &ride(0, 4, 0., 10.)
        ));
    }

    #[test]
    fn a_return_through_the_boarding_stop_boards_on_that_pass() {
        // 0 -> 1 -> turnaround 2 -> back through 0 -> 4.
        let (kernel, links) = block([0, 1, 2, 0, 4], &[]);
        let mut journey = ride(0, 4, 0., 10.);
        board_last_pass(&kernel, &links, &input(0, 4), &mut journey).unwrap();
        let leg = &journey.legs[1];
        assert_eq!((leg.board_sequence, leg.departure), (Some(3.), 50.));
        assert_eq!((journey.ride_seconds, journey.waiting_seconds), (10., 50.));
        assert!(!detours(&kernel, &links, &input(0, 4), &journey));
    }

    #[test]
    fn a_forward_continuation_is_kept() {
        let (kernel, links) = block([0, 1, 2, 3, 4], &[(2, 3, 5)]);
        let mut journey = ride(0, 4, 0., 10.);
        board_last_pass(&kernel, &links, &input(0, 4), &mut journey).unwrap();
        assert_eq!(journey.legs[1].board_sequence, Some(0.));
        assert!(!detours(&kernel, &links, &input(0, 4), &journey));
    }
}
