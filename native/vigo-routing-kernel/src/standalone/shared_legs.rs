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
use vigo_route::timetable::SharedRideQuery;

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
            let trip_id = &timetable.trip_ids[trip as usize];
            let Some(leg_index) = primary["legs"].as_array().and_then(|legs| {
                legs.iter().position(|l| {
                    l["tripId"] == *trip_id
                        && l["boardSequence"].as_f64() == leg.board_sequence
                        && l["alightSequence"].as_f64() == leg.alight_sequence
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
            let result = timetable.kernel.shared_ride_options(SharedRideQuery {
                trip,
                board_sequence: leg.board_sequence.ok_or("Missing board sequence")?,
                alight_sequence: leg.alight_sequence.ok_or("Missing alight sequence")?,
                earliest_departure: leg.departure,
                latest_departure: leg.departure + 1800.,
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
            let mut routes = HashSet::from([timetable.route_ids[trip as usize].clone()]);
            for candidate in result.options {
                let route =
                    self.timetable.as_ref().unwrap().route_ids[candidate.trip as usize].clone();
                if routes.contains(&route) {
                    continue;
                }
                let mut replacement = journey.clone();
                let ride = &mut replacement.legs[index];
                ride.trip = Some(candidate.trip);
                ride.board_sequence = Some(candidate.board_sequence);
                ride.alight_sequence = Some(candidate.alight_sequence);
                ride.departure = candidate.departure;
                ride.arrival = candidate.arrival;
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
                let replaced = &value["legs"][leg_index];
                if !proven_path(replaced)
                    || !shared_leg_paths_match(coordinates(displayed), coordinates(replaced))
                {
                    continue;
                }
                routes.insert(route);
                value["status"] = json!("ready");
                value["mode"] = json!("transit");
                options.push(json!({"legIndex":leg_index,"plan":value}));
                if options.len() == 32 {
                    truncated = true;
                    break;
                }
            }
            if options.len() == 32 {
                break;
            }
        }
        Ok(
            json!({"coverage":"single_leg_substitutions","windowMinutes":30,
            "truncated":truncated,"frequency":"not_calculated","options":options}),
        )
    }
}
