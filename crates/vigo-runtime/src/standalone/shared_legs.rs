use super::walking::MissingAccessWitness;
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
use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use vigo_route::timetable::{SharedRideQuery, shared_departure_frequency};

/// A collected choice's index among journeys whose shared services wait
/// until its window or sample has selected its choices.
pub(super) const DEFERRED_SHARED_LEGS: &str = "\u{0}deferredSharedLegs";

/// One search's endpoints and access, kept for its deferred choices.
pub(super) struct SharedLegsContext {
    pub origin: Point,
    pub destination: Point,
    pub access: [Candidates; 2],
    /// The journeys' trip indices belong to this active timetable.
    pub timetable: Option<(String, Option<u32>)>,
    /// An otherwise eager policy search must restore its endpoint witnesses.
    pub refresh_access: bool,
}

/// A journey whose shared services wait, with the options of the clock it
/// was searched at.
/// Options a journey's shared legs list at most.
const MAXIMUM_OPTIONS: usize = 32;

#[derive(Debug, Default, PartialEq)]
struct Acceptance {
    /// Substitutions not rebuildable from the supplied endpoint evidence.
    omitted: usize,
    /// The option bound was reached.
    truncated: bool,
}

/// Accept materialized substitutions in candidate order, at most one per
/// route and `MAXIMUM_OPTIONS` in all. A route is taken only by a
/// substitution that materializes, so a later departure of the same route
/// stays eligible after an earlier one fails. A substitution whose endpoint
/// walk has no witness in the supplied evidence is counted and skipped,
/// never failing the journey it would only annotate; other errors propagate.
fn accept_substitutions<R: Eq + std::hash::Hash, J>(
    eligible: Vec<(R, J)>,
    routes: &mut HashSet<R>,
    options: &mut Vec<Value>,
    mut materialize: impl FnMut(J) -> Result<Value>,
) -> Result<Acceptance> {
    let mut accepted = Acceptance::default();
    for (route, journey) in eligible {
        if routes.contains(&route) {
            continue;
        }
        if options.len() >= MAXIMUM_OPTIONS {
            accepted.truncated = true;
            continue;
        }
        match materialize(journey) {
            Ok(option) => {
                routes.insert(route);
                options.push(option);
            }
            Err(error) if error.downcast_ref::<MissingAccessWitness>().is_some() => {
                accepted.omitted += 1;
            }
            Err(error) => return Err(error),
        }
    }
    Ok(accepted)
}

pub(super) struct DeferredSharedLegs {
    pub journey: TimetableMatrixJourney,
    pub opt: Options,
    pub context: Rc<SharedLegsContext>,
}

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
        if kernel.boarding_needs_transfer_context(target)
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
    pub(super) fn timetable_identity(&self) -> Option<(String, Option<u32>)> {
        self.timetable
            .as_ref()
            .map(|t| (t.key.clone(), t.coverage_end))
    }

    /// Search the shared services of each value still marked as deferred.
    /// A journey marked in several values is searched once.
    pub(super) fn resolve_shared_legs<'a>(
        &mut self,
        values: impl IntoIterator<Item = &'a mut Value>,
        deferred: &[DeferredSharedLegs],
    ) -> Result<()> {
        let mut found: HashMap<usize, Value> = HashMap::new();
        let mut frontiers: HashMap<usize, (Candidates, Candidates)> = HashMap::new();
        for value in values {
            let Some(index) = value
                .as_object_mut()
                .and_then(|fields| fields.remove(DEFERRED_SHARED_LEGS))
                .and_then(|index| index.as_u64())
                .map(|index| index as usize)
            else {
                continue;
            };
            if let Some(saved) = found.get(&index) {
                value["sharedLegAlternatives"] = saved.clone();
                continue;
            }
            let DeferredSharedLegs {
                journey,
                opt,
                context,
            } = &deferred[index];
            debug_assert!(self.timetable_identity() == context.timetable);
            // Supplemental policy searches replace the street frontiers. A
            // retained candidate's token must match before its priced endpoint
            // walk can be reconstructed, rather than falling back to a new path.
            let token = self.street.query_token;
            let current =
                |a: &Candidates| a.evidence.as_ref().is_none_or(|e| e.query_token == token);
            let refreshed = if context.refresh_access && !context.access.iter().all(current) {
                let key = Rc::as_ptr(context) as usize;
                // Consecutive retained choices share their restored frontiers,
                // only while no intervening coordinate query has replaced them.
                if !frontiers
                    .get(&key)
                    .is_some_and(|(a, b)| current(a) && current(b))
                {
                    let pair = self.point_candidates(&context.origin, &context.destination, opt)?;
                    frontiers.insert(key, pair);
                }
                frontiers.get(&key)
            } else {
                None
            };
            let access =
                refreshed.map_or([&context.access[0], &context.access[1]], |(a, b)| [a, b]);
            let shared = self.shared_leg_alternatives(
                value,
                journey,
                [&context.origin, &context.destination],
                opt,
                access,
            )?;
            value["sharedLegAlternatives"] = shared.clone();
            found.insert(index, shared);
        }
        Ok(())
    }

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
        // Substitutions found but not rebuildable from the supplied endpoint
        // evidence; reported, never silently dropped.
        let mut omitted = 0usize;
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
            let mut eligible = vec![];
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
                if !feasible.contains(&candidate_key) {
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
                eligible.push((route, replacement));
            }
            let accepted =
                accept_substitutions(eligible, &mut routes, &mut options, |replacement| {
                    let mut value = self.materialize(
                        &replacement,
                        endpoints,
                        true,
                        opt,
                        access,
                        Some(&mut cache),
                    )?;
                    value["status"] = json!("ready");
                    value["mode"] = json!("transit");
                    Ok(json!({"legIndex":leg_index,"plan":value}))
                })?;
            omitted += accepted.omitted;
            truncated |= accepted.truncated;
            let mut frequency = serde_json::to_value(shared_departure_frequency(
                departures,
                leg.departure,
                window_end,
                result.departures_truncated,
            ))?;
            frequency["legIndex"] = json!(leg_index);
            frequencies.push(frequency);
        }
        let mut result = json!({"coverage":"single_leg_substitutions","windowMinutes":30,
            "truncated":truncated,"frequency":"active_departures","frequencies":frequencies,"options":options});
        if omitted > 0 {
            result["omitted"] = json!({"count":omitted,"reason":"access_evidence_unavailable"});
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn witness_missing() -> Result<Value> {
        Err(Box::new(MissingAccessWitness))
    }

    #[test]
    fn a_failed_substitution_leaves_its_route_to_a_later_departure() {
        let mut routes = HashSet::from(["own"]);
        let mut options = vec![];
        let eligible = vec![("R", 1), ("R", 2), ("S", 3), ("own", 4)];
        let accepted = accept_substitutions(eligible, &mut routes, &mut options, |n| {
            if n == 1 {
                witness_missing()
            } else {
                Ok(json!(n))
            }
        })
        .unwrap();
        // R's first departure cannot be rebuilt; its second is offered.
        assert_eq!(options, vec![json!(2), json!(3)]);
        assert_eq!(
            accepted,
            Acceptance {
                omitted: 1,
                truncated: false
            }
        );
        assert!(routes.contains("R") && routes.contains("S"));
    }

    #[test]
    fn omissions_are_reported_and_other_failures_propagate() {
        let mut routes = HashSet::new();
        let mut options = vec![];
        let accepted =
            accept_substitutions(vec![("R", 1), ("S", 2)], &mut routes, &mut options, |_| {
                witness_missing()
            })
            .unwrap();
        assert!(options.is_empty() && routes.is_empty());
        assert_eq!(
            accepted,
            Acceptance {
                omitted: 2,
                truncated: false
            }
        );
        let failed = accept_substitutions(vec![("R", 1)], &mut routes, &mut options, |_| {
            Err("Timetable not active".into())
        });
        assert!(failed.is_err());
    }

    #[test]
    fn the_option_bound_is_truncation_not_omission() {
        let mut routes = HashSet::new();
        let mut options = vec![json!(0); MAXIMUM_OPTIONS - 1];
        let accepted =
            accept_substitutions(vec![("R", 1), ("S", 2)], &mut routes, &mut options, |n| {
                Ok(json!(n))
            })
            .unwrap();
        assert_eq!(options.len(), MAXIMUM_OPTIONS);
        assert_eq!(
            accepted,
            Acceptance {
                omitted: 0,
                truncated: true
            }
        );
    }
}
