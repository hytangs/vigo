use super::{
    City, Result,
    materialize::MatrixMaterializationCache,
    query::{Candidates, Options, Point},
};
use crate::{
    TimetableMatrixJourney,
    shared_legs::{proven_path, shared_leg_paths_match},
};
use serde_json::{Value, json};
use std::collections::HashSet;
use vigo_route::timetable::{SharedRideQuery, shared_departure_frequency};

/// The physical trip and its own stop sequence for a call of a timetable
/// trip. Linked trips ride only as parts of their through run.
fn physical_call(links: &super::linked_trips::Links, trip: u32, sequence: f64) -> (u32, f64) {
    links
        .get(&trip)
        .and_then(|parts| {
            parts.iter().find_map(|part| {
                let offset = sequence - f64::from(part.first);
                (offset >= 0. && (offset as usize) < part.sequences.len())
                    .then(|| (part.trip, f64::from(part.sequences[offset as usize])))
            })
        })
        .unwrap_or((trip, sequence))
}

/// Keep the chosen final ride and work backward through its connections.
/// A later service on the same route and stopping pattern can move waiting
/// back toward the origin without changing arrival, walking or boardings.
pub(super) fn depart_later(
    timetable: &super::city::Timetable,
    journey: &mut TimetableMatrixJourney,
) -> Result<()> {
    if journey.boardings < 2 {
        return Ok(());
    }
    let kernel = &timetable.kernel;
    let rides: Vec<_> = journey
        .legs
        .iter()
        .enumerate()
        .filter_map(|(i, leg)| leg.trip.map(|_| i))
        .collect();
    for pair in rides.windows(2).rev() {
        let (index, next) = (pair[0], pair[1]);
        let leg = &journey.legs[index];
        let (Some(trip), Some(board), Some(alight), Some(from)) = (
            leg.trip,
            leg.board_sequence,
            leg.alight_sequence,
            leg.from_stop,
        ) else {
            continue;
        };
        let onward = &journey.legs[next];
        let Some(target) = onward.from_stop else {
            continue;
        };
        if kernel.is_headway_trip(trip)
            || kernel.is_headway_trip(onward.trip.unwrap())
            || kernel.boarding_needs_transfer_context(target)
            || (index != rides[0] && kernel.boarding_needs_transfer_context(from))
        {
            continue;
        }
        let (vehicle, _) = physical_call(&timetable.links, trip, board);
        if physical_call(&timetable.links, trip, alight).0 != vehicle {
            continue;
        }
        let walks = &journey.legs[index + 1..next];
        if walks.iter().any(|l| l.kind != "walk") {
            continue;
        }
        let walk: f64 = walks.iter().map(|l| l.arrival - l.departure).sum();
        let latest = onward.departure - walk - f64::from(kernel.minimum_transfer_buffer_seconds());
        if latest <= leg.departure {
            continue;
        }
        let candidate = kernel.latest_shared_ride(
            SharedRideQuery {
                trip,
                board_sequence: board,
                alight_sequence: alight,
                earliest_departure: leg.departure,
                latest_departure: latest,
                latest_arrival: latest,
                onward_departure: Some(onward.departure),
                onward_stop: Some(target),
                onward_walk_seconds: walk,
            },
            |candidate| {
                let (other, _) =
                    physical_call(&timetable.links, candidate.trip, candidate.board_sequence);
                physical_call(&timetable.links, candidate.trip, candidate.alight_sequence).0
                    == other
                    && timetable.route_ids[other as usize] == timetable.route_ids[vehicle as usize]
            },
        )?;
        let Some(candidate) = candidate else {
            continue;
        };
        journey.ride_seconds +=
            (candidate.arrival - candidate.departure) - (leg.arrival - leg.departure);
        let leg = &mut journey.legs[index];
        leg.trip = Some(candidate.trip);
        leg.board_sequence = Some(candidate.board_sequence);
        leg.alight_sequence = Some(candidate.alight_sequence);
        leg.departure = candidate.departure;
        leg.arrival = candidate.arrival;
        let mut at = candidate.arrival;
        for walk in &mut journey.legs[index + 1..next] {
            let duration = walk.arrival - walk.departure;
            walk.departure = at;
            at += duration;
            walk.arrival = at;
        }
    }
    journey.waiting_seconds =
        (journey.arrival - journey.departure - journey.walking_seconds - journey.ride_seconds)
            .max(0.);
    Ok(())
}

fn coordinates(leg: &Value) -> Vec<f64> {
    leg["coordinates"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|p| p.as_array().into_iter().flatten().filter_map(Value::as_f64))
        .collect()
}

impl City {
    pub(crate) fn shared_leg_alternatives(
        &mut self,
        primary: &Value,
        journey: &TimetableMatrixJourney,
        endpoints: [&Point; 2],
        opt: &Options,
        access: [&Candidates; 2],
    ) -> Result<Value> {
        let mut options = vec![];
        let mut frequencies = vec![];
        let mut truncated = false;
        let mut cache = MatrixMaterializationCache::default();
        for (index, leg) in journey.legs.iter().enumerate() {
            let Some(trip) = leg.trip else { continue };
            let next_index =
                (index + 1..journey.legs.len()).find(|&i| journey.legs[i].trip.is_some());
            let previous = journey.legs[..index].iter().rev().find_map(|l| l.trip);
            if next_index.is_some_and(|i| journey.legs[i].trip == Some(trip))
                || previous == Some(trip)
            {
                continue;
            }
            let timetable = self.timetable.as_ref().ok_or("Timetable not active")?;
            let board = leg.board_sequence.ok_or("Missing board sequence")?;
            let alight = leg.alight_sequence.ok_or("Missing alight sequence")?;
            let (vehicle, vehicle_board) = physical_call(&timetable.links, trip, board);
            let (alight_vehicle, vehicle_alight) = physical_call(&timetable.links, trip, alight);
            // Staying aboard across linked trips has no single shared segment.
            if vehicle != alight_vehicle {
                continue;
            }
            let trip_id = &timetable.trip_ids[vehicle as usize];
            let Some(leg_index) = primary["legs"].as_array().and_then(|legs| {
                legs.iter().position(|l| {
                    l["tripId"] == *trip_id
                        && l["boardSequence"].as_f64() == Some(vehicle_board)
                        && l["alightSequence"].as_f64() == Some(vehicle_alight)
                })
            }) else {
                continue;
            };
            let displayed = &primary["legs"][leg_index];
            if !proven_path(displayed) {
                continue;
            }
            let following_end = next_index.unwrap_or(journey.legs.len());
            let walk: f64 = journey.legs[index + 1..following_end]
                .iter()
                .map(|l| l.arrival - l.departure)
                .sum();
            let window_end = (leg.departure + 1800.).min(opt.end);
            let result = timetable.kernel.shared_ride_options(SharedRideQuery {
                trip,
                board_sequence: board,
                alight_sequence: alight,
                earliest_departure: leg.departure,
                latest_departure: window_end,
                latest_arrival: (if next_index.is_none() {
                    opt.end - walk
                } else {
                    opt.end
                })
                .min(leg.arrival + 1800.),
                onward_departure: next_index.map(|i| journey.legs[i].departure),
                onward_stop: next_index.and_then(|i| journey.legs[i].from_stop),
                onward_walk_seconds: if next_index.is_some() { walk } else { 0. },
            })?;
            truncated |= result.truncated;
            let mut routes = HashSet::from([timetable.route_ids[vehicle as usize].clone()]);
            // Count each vehicle departure once, however many through runs
            // (for example both branches of a split) carry it.
            let key = |c: &vigo_route::timetable::SharedRideOption| {
                let (vehicle, sequence) = physical_call(&timetable.links, c.trip, c.board_sequence);
                (vehicle, sequence.to_bits())
            };
            let feasible: HashSet<_> = result.options.iter().map(key).collect();
            let candidates: Vec<_> = result
                .options
                .into_iter()
                .chain(result.departures)
                .map(|c| (key(&c), c))
                .collect();
            let own = (vehicle, vehicle_board.to_bits());
            let mut seen = HashSet::new();
            let mut departures = vec![];
            for (candidate_key, candidate) in candidates {
                if !seen.insert(candidate_key) {
                    continue;
                }
                if candidate_key == own {
                    departures.push(candidate.departure);
                    continue;
                }
                let route =
                    self.timetable.as_ref().unwrap().route_ids[candidate_key.0 as usize].clone();
                let mut replacement = journey.clone();
                let ride = &mut replacement.legs[index];
                ride.trip = Some(candidate.trip);
                ride.board_sequence = Some(candidate.board_sequence);
                ride.alight_sequence = Some(candidate.alight_sequence);
                ride.departure = candidate.departure;
                ride.arrival = candidate.arrival;
                // Materialize only the segment for counting. A later departure
                // may miss the fixed onward ride and must never form an invalid journey.
                let segment_ride = ride.clone();
                let mut segment = replacement.clone();
                segment.legs = vec![segment_ride];
                segment.departure = candidate.departure;
                segment.arrival = candidate.arrival;
                segment.ride_seconds = candidate.arrival - candidate.departure;
                segment.walking_seconds = 0.;
                segment.waiting_seconds = 0.;
                let segment_value =
                    self.materialize(&segment, endpoints, true, opt, access, Some(&mut cache))?;
                let replaced = &segment_value["legs"][0];
                if !proven_path(replaced)
                    || !shared_leg_paths_match(coordinates(displayed), coordinates(replaced))
                {
                    continue;
                }
                departures.push(candidate.departure);
                if !feasible.contains(&candidate_key) || !routes.insert(route) {
                    continue;
                }
                if options.len() == 32 {
                    truncated = true;
                    continue;
                }
                let mut end = candidate.arrival;
                for walk in &mut replacement.legs[index + 1..following_end] {
                    let duration = walk.arrival - walk.departure;
                    walk.departure = end;
                    end += duration;
                    walk.arrival = end;
                }
                if next_index.is_none() {
                    replacement.arrival = end
                }
                replacement.ride_seconds +=
                    (candidate.arrival - candidate.departure) - (leg.arrival - leg.departure);
                replacement.waiting_seconds = (replacement.arrival
                    - replacement.departure
                    - replacement.walking_seconds
                    - replacement.ride_seconds)
                    .max(0.);
                let mut value =
                    self.materialize(&replacement, endpoints, true, opt, access, Some(&mut cache))?;
                value["status"] = json!("ready");
                value["mode"] = json!("transit");
                options.push(json!({"legIndex":leg_index,"plan":value}));
            }
            let mut frequency = serde_json::to_value(shared_departure_frequency(
                departures,
                leg.departure,
                window_end,
                result.departures_truncated,
            ))?;
            frequency["legIndex"] = json!(leg_index);
            frequencies.push(frequency);
        }
        Ok(
            json!({"coverage":"single_leg_substitutions","windowMinutes":30,
            "truncated":truncated,"frequency":"active_departures","frequencies":frequencies,"options":options}),
        )
    }
}
