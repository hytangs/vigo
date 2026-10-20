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
            let dominates = arrival(other) <= arrival(candidate)
                && number(other, "walkMinutes") <= number(candidate, "walkMinutes")
                && simpler.len() <= candidate_rides.len()
                && (arrival(other) < arrival(candidate)
                    || number(other, "walkMinutes") < number(candidate, "walkMinutes")
                    || simpler.len() < candidate_rides.len());
            if !dominates {
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
    #[test]
    fn different_routes_get_slots_before_repeat_departures() {
        let plans = [
            plan("m1", "M", 504, &["m1"], false),
            plan("m2", "M", 506, &["m2"], false),
            plan("rail", "Rail", 507, &["r"], false),
            plan("bus", "Bus", 508, &["b"], false),
        ];
        assert_eq!(selected_indices(&plans, 3), vec![0, 2, 3]);
    }
}
