//! Select distinct, useful Studio alternatives after exact chain materialization.
//! Feasibility remains owned by the timetable search; this ranks its witnesses.
use serde_json::Value;
use std::collections::HashSet;

fn rides(plan: &Value) -> Vec<&Value> {
    plan["legs"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|leg| leg["type"] == "ride")
        .collect()
}
fn number(plan: &Value, key: &str) -> f64 {
    plan[key].as_f64().unwrap_or(f64::INFINITY)
}
fn arrival(plan: &Value) -> f64 {
    plan["arriveMinutes"]
        .as_f64()
        .unwrap_or_else(|| number(plan, "departMinutes") + number(plan, "durationMinutes"))
}
/// The time a rider leaves, as Studio shows it: an initial walk is deferred to
/// reach the first vehicle just in time rather than waiting at the stop.
fn leave(plan: &Value) -> f64 {
    let depart = number(plan, "departMinutes");
    let legs = plan["legs"].as_array();
    match legs.map(|legs| (legs.first(), legs.get(1))) {
        Some((Some(walk), Some(ride))) if walk["type"] == "walk" && ride["type"] == "ride" => {
            match (
                ride["startMinutes"].as_f64(),
                walk["durationMinutes"].as_f64(),
            ) {
                (Some(start), Some(minutes)) => depart.max(start - minutes.max(0.0)),
                _ => depart,
            }
        }
        _ => depart,
    }
}
/// Burdens in the whole minutes Studio shows, lower is better: arrival, the
/// negated leave time, and walking. A difference a person cannot see is not a
/// reason to offer a journey.
fn shown_burden(plan: &Value) -> [f64; 3] {
    [
        arrival(plan).round(),
        -leave(plan).round(),
        number(plan, "walkMinutes").round(),
    ]
}
fn no_worse(other: &Value, candidate: &Value, burdens: &[usize]) -> (bool, bool) {
    let (better, worse) = (shown_burden(other), shown_burden(candidate));
    let (other_rides, candidate_rides) = (rides(other).len(), rides(candidate).len());
    let no_worse = burdens.iter().all(|&k| better[k] <= worse[k]) && other_rides <= candidate_rides;
    let strictly = burdens.iter().any(|&k| better[k] < worse[k]) || other_rides < candidate_rides;
    (no_worse, strictly)
}
fn identity(plan: &Value, family: bool) -> String {
    let legs: Vec<_> = rides(plan)
        .iter()
        .map(|leg| {
            if family {
                serde_json::json!([leg["routeId"], leg["fromStopId"], leg["toStopId"]])
            } else {
                serde_json::json!([
                    leg["tripId"],
                    leg["fromStopId"],
                    leg["toStopId"],
                    leg["startMinutes"],
                    leg["endMinutes"]
                ])
            }
        })
        .collect();
    if legs.is_empty() {
        return plan["id"].to_string();
    }
    serde_json::to_string(&legs).unwrap()
}
fn selected_indices(plans: &[Value], limit: usize) -> Vec<usize> {
    let mut candidates: Vec<_> = (0..plans.len())
        .filter(|&i| plans[i]["status"] == "ready")
        .collect();
    candidates.retain(|&i| {
        if i == 0 {
            return true;
        } // Never remove the exact primary witness.
        let candidate = &plans[i];
        let candidate_rides = rides(candidate);
        !plans.iter().enumerate().any(|(j, other)| {
            if i == j || other["status"] != "ready" {
                return false;
            }
            let simpler = rides(other);
            // Another journey that leaves no earlier, arrives no later, walks no
            // more and boards no more vehicles, and is better at one, is the
            // better choice. A later departure is a real option and stays.
            let (no_worse_anywhere, better_somewhere) = no_worse(other, candidate, &[0, 1, 2]);
            if no_worse_anywhere && better_somewhere {
                return true;
            }
            let (no_worse_arrival, better_arrival) = no_worse(other, candidate, &[0, 2]);
            if !(no_worse_arrival && better_arrival) {
                return false;
            }
            // A station return may be required by directed platforms. Drop it
            // only with a feasible dominating witness, never on geometry alone.
            let returns = candidate["diagnostics"]["returnedStationCycle"].is_object();
            let needless_change = !simpler.is_empty()
                && simpler.len() < candidate_rides.len()
                && simpler.last().unwrap()["tripId"].is_string()
                && simpler.last().unwrap()["tripId"] == candidate_rides.last().unwrap()["tripId"]
                && simpler.iter().all(|leg| {
                    leg["tripId"].is_string()
                        && candidate_rides
                            .iter()
                            .any(|ride| ride["tripId"] == leg["tripId"])
                });
            returns || needless_change
        })
    });
    candidates.sort_by(|&a, &b| {
        arrival(&plans[a])
            .total_cmp(&arrival(&plans[b]))
            .then(rides(&plans[a]).len().cmp(&rides(&plans[b]).len()))
            .then(number(&plans[a], "walkMinutes").total_cmp(&number(&plans[b], "walkMinutes")))
            .then(a.cmp(&b))
    });
    let mut trips = HashSet::new();
    candidates.retain(|&i| trips.insert(identity(&plans[i], false)));
    let mut families = HashSet::new();
    let mut selected = Vec::new();
    // Distinct line/boarding/alighting combinations get slots before repeated
    // departures. The UI can then group services with identical proven paths.
    for &i in &candidates {
        if families.insert(identity(&plans[i], true)) && selected.len() < limit {
            selected.push(i);
        }
    }
    for &i in &candidates {
        if selected.len() >= limit {
            break;
        }
        if !selected.contains(&i) {
            selected.push(i);
        }
    }
    selected.sort_by_key(|i| {
        candidates
            .iter()
            .position(|candidate| candidate == i)
            .unwrap()
    });
    selected
}

#[napi_derive::napi]
pub fn select_studio_journey_indices(plans: String, limit: u32) -> napi::Result<Vec<u32>> {
    let plans: Vec<Value> = serde_json::from_str(&plans)
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    Ok(selected_indices(&plans, (limit as usize).clamp(1, 10))
        .into_iter()
        .map(|i| i as u32)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn plan(id: &str, route: &str, arrival: u32, trips: &[&str], cycle: bool) -> Value {
        json!({"id":id,"status":"ready","arriveMinutes":arrival,"walkMinutes":3,
            "legs":trips.iter().map(|trip| json!({"type":"ride","tripId":trip,"routeId":route,"fromStopId":"A","toStopId":"B","startMinutes":480,"endMinutes":arrival})).collect::<Vec<_>>(),
            "diagnostics":if cycle {json!({"returnedStationCycle":{"advisory":true}})} else {json!({})}})
    }
    #[test]
    fn rejects_dominated_backtracking_but_keeps_required_returns() {
        let direct = plan("direct", "M", 504, &["m"], false);
        let detour = plan("detour", "E", 511, &["m", "e"], true);
        assert_eq!(
            selected_indices(&[direct.clone(), detour.clone()], 10),
            vec![0]
        );
        assert_eq!(selected_indices(&[detour], 10), vec![0]);
        let faster = plan("faster-return", "E", 503, &["m", "e"], true);
        assert_eq!(selected_indices(&[direct, faster], 10), vec![1, 0]);
    }
    fn walking(mut plan: Value, minutes: f64) -> Value {
        plan["walkMinutes"] = json!(minutes);
        plan
    }
    #[test]
    fn different_routes_get_slots_before_repeat_departures() {
        let plans = [
            plan("m1", "M", 504, &["m1"], false),
            plan("m2", "M", 506, &["m2"], false),
            walking(plan("rail", "Rail", 507, &["r"], false), 2.0),
            walking(plan("bus", "Bus", 508, &["b"], false), 1.0),
        ];
        assert_eq!(selected_indices(&plans, 3), vec![0, 2, 3]);
    }
    #[test]
    fn drops_other_routes_that_are_no_better_anywhere() {
        let leaving = |mut plan: Value, minutes: u32| {
            plan["departMinutes"] = json!(minutes);
            plan
        };
        let direct = leaving(plan("direct", "M", 504, &["m"], false), 480);
        let slower = leaving(plan("slower", "S", 510, &["s"], false), 480);
        let unseen = leaving(walking(plan("unseen", "U", 510, &["u"], false), 2.8), 480);
        let later = leaving(plan("later", "M", 512, &["m2"], false), 488);
        assert_eq!(
            selected_indices(&[direct, slower, unseen, later], 10),
            vec![0, 3]
        );
    }
    #[test]
    fn compares_the_time_a_rider_actually_leaves() {
        let journey = |id: &str, route: &str, depart: u32, board: u32, arrival: u32| {
            json!({"id": id, "status": "ready", "departMinutes": depart, "arriveMinutes": arrival, "walkMinutes": 3.0,
                "legs": [{"type": "walk", "durationMinutes": 3.0, "startMinutes": depart, "endMinutes": depart + 3},
                    {"type": "ride", "tripId": format!("{id}-trip"), "routeId": route, "fromStopId": "A", "toStopId": "B",
                        "startMinutes": board, "endMinutes": arrival}]})
        };
        // Out at 08:03 once the first walk is just in time, in at 08:52.
        let first = journey("first", "71", 480, 486, 532);
        // Another route out at 08:08, in at 08:57: later out, later in, a real choice.
        let later = journey("later", "73", 488, 491, 537);
        // Line 16 out at 08:03 arrives with its 08:12 departure: no reason to leave early.
        let early = journey("early", "16", 480, 486, 541);
        let next = journey("next", "16", 492, 495, 541);
        assert_eq!(
            selected_indices(&[first, later, early, next], 10),
            vec![0, 1, 3]
        );
    }
}
