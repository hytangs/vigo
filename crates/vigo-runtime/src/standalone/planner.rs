//! Versioned client policy: all supplemental searches stay in the resident engine.
use super::{City, Result, fail, flag, number};
use serde_json::{Value, json};
use std::collections::HashSet;

fn plans(mut result: Value) -> Vec<Value> {
    let choices = result.as_object_mut().and_then(|o| o.remove("choices"));
    std::iter::once(result)
        .chain(
            choices
                .and_then(|v| v.as_array().cloned())
                .unwrap_or_default(),
        )
        .filter(|v| v["status"] == "ready")
        .collect()
}
fn clock(v: &Value, key: &str) -> f64 {
    v[key].as_f64().unwrap_or(f64::INFINITY)
}
// Match the rider's elapsed trip after waiting at the origin for the first ride.
fn travel_minutes(v: &Value) -> f64 {
    let mut access = 0.;
    for leg in v["legs"].as_array().into_iter().flatten() {
        if leg["kind"] == "ride" {
            let initial_wait =
                (clock(leg, "departureMinutes") - clock(v, "departureMinutes") - access).max(0.);
            return clock(v, "durationMinutes") - initial_wait;
        }
        access += leg["durationMinutes"].as_f64().unwrap_or(0.);
    }
    clock(v, "durationMinutes")
}
fn transit(v: &Value) -> bool {
    v["legs"]
        .as_array()
        .is_some_and(|legs| legs.iter().any(|l| l["kind"] == "ride"))
}
impl City {
    pub(super) fn planner_route(&mut self, q: &Value) -> Result<Value> {
        if q["journeyPolicy"] != "alternatives-v1" {
            return fail("Unknown journeyPolicy; supported: alternatives-v1");
        }
        if q["mode"].as_str().unwrap_or("transit") != "transit" {
            return fail("journeyPolicy requires transit mode");
        }
        for key in [
            "via",
            "waypoints",
            "windowChoices",
            "windowMinutes",
            "windowStepMinutes",
            "alternativeSlackMinutes",
            "alternatives",
            "alternativeRanking",
            "includeEarliestTransit",
        ] {
            if q.get(key).is_some() {
                return fail(format!("journeyPolicy owns {key}; omit it"));
            }
        }
        let arrive = matches!(q["timePreference"].as_str(), Some("arrive" | "arrive_by"));
        let expanded = q
            .get("expandedWalkKm")
            .map(|_| number(q, "expandedWalkKm", 2.4, 0.2, 5.))
            .transpose()?;
        let walk = number(q, "maxWalkKm", 1.2, 0., 100.)?;
        if expanded.is_some_and(|km| km <= walk) {
            return fail("expandedWalkKm must exceed maxWalkKm");
        }
        let mut base = q.clone();
        let object = base.as_object_mut().ok_or("Request must be an object")?;
        object.remove("journeyPolicy");
        object.remove("expandedWalkKm");
        if !arrive {
            base["alternatives"] = json!(9);
            base["alternativeRanking"] = json!("ranked");
        } else {
            base["windowMinutes"] = json!(15);
            base["windowStepMinutes"] = json!(5);
        }
        base["requireTransitRide"] = json!(true);
        let primary = self.route(&base)?;
        let mut pool = plans(primary.clone());
        let mut direct = base.clone();
        direct["maxTransfers"] = json!(0);
        direct["requireTransitRide"] = json!(true);
        if base["maxTransfers"] != 0 {
            pool.extend(plans(self.route(&direct)?));
        }
        if !flag(q, "requireTransitRide", false)? {
            let limit = if flag(q, "allowLongWalk", false)? {
                number(q, "maxStreetKm", 50., 0.05, 1000.)?
            } else {
                walk.min(number(q, "maxStreetKm", 50., 0.05, 1000.)?)
            };
            // Street queries require 50 m; never widen a smaller explicit limit.
            if limit >= 0.05 {
                let mut walking = base.clone();
                let o = walking.as_object_mut().unwrap();
                for key in [
                    "alternatives",
                    "alternativeRanking",
                    "sharedLegs",
                    "windowMinutes",
                    "windowStepMinutes",
                ] {
                    o.remove(key);
                }
                walking["mode"] = json!("walk");
                walking["requireTransitRide"] = json!(false);
                walking["maxStreetKm"] = json!(limit);
                pool.extend(plans(self.route(&walking)?));
            }
        }
        if let Some(km) = expanded.filter(|_| q["wheelchair"] != true) {
            let best_arrival = pool
                .iter()
                .map(|p| clock(p, "arrivalMinutes"))
                .fold(f64::INFINITY, f64::min);
            let best_departure = pool
                .iter()
                .map(|p| clock(p, "departureMinutes"))
                .fold(f64::NEG_INFINITY, f64::max);
            let mut wider = base.clone();
            wider["maxWalkKm"] = json!(km);
            wider["requireTransitRide"] = json!(true);
            wider["allowLongWalk"] = json!(false);
            for direct in [false, true] {
                if direct && base["maxTransfers"] == 0 {
                    continue;
                }
                let mut probe = wider.clone();
                if direct {
                    probe["maxTransfers"] = json!(0);
                }
                if let Ok(result) = self.route(&probe) {
                    for mut p in plans(result) {
                        // More walking must buy a strictly better time, by at
                        // least the displayed minute; shorter alone is not enough.
                        let improves = if arrive {
                            clock(&p, "departureMinutes") >= best_departure + 1.
                        } else {
                            clock(&p, "arrivalMinutes") <= best_arrival - 1.
                        };
                        if transit(&p) && improves {
                            p["expandedWalkingLimitKm"] = json!(km);
                            pool.push(p);
                        }
                    }
                }
            }
        }
        // Searches at the requested minute miss a journey that leaves later
        // for the same arrival. One reverse search to the earliest arrival
        // finds the latest such departure.
        if !arrive {
            let requested = clock(&primary, "departureMinutes");
            let best_arrival = pool
                .iter()
                .filter(|p| transit(p))
                .map(|p| clock(p, "arrivalMinutes"))
                .fold(f64::INFINITY, f64::min);
            if best_arrival.is_finite() && requested.is_finite() {
                let mut latest = base.clone();
                let o = latest.as_object_mut().unwrap();
                for key in ["alternatives", "alternativeRanking", "time", "serviceDay"] {
                    o.remove(key);
                }
                latest["timePreference"] = json!("arrive_by");
                latest["timeMinutes"] = json!(best_arrival);
                if let Ok(result) = self.route(&latest) {
                    pool.extend(plans(result).into_iter().filter(|p| {
                        transit(p)
                            && clock(p, "departureMinutes") > requested
                            && clock(p, "arrivalMinutes") <= best_arrival
                    }));
                }
            }
        }
        pool.sort_by(|a, b| {
            let time = if arrive {
                clock(b, "departureMinutes").total_cmp(&clock(a, "departureMinutes"))
            } else {
                // Equal arrivals: within the walking limit, then the shorter
                // trip, which leaves later.
                clock(a, "arrivalMinutes")
                    .total_cmp(&clock(b, "arrivalMinutes"))
                    .then_with(|| {
                        a.get("expandedWalkingLimitKm")
                            .is_some()
                            .cmp(&b.get("expandedWalkingLimitKm").is_some())
                    })
                    .then_with(|| travel_minutes(a).total_cmp(&travel_minutes(b)))
            };
            time.then_with(|| {
                super::alternatives::walking(a).total_cmp(&super::alternatives::walking(b))
            })
            .then_with(|| {
                super::alternatives::boardings(a).total_cmp(&super::alternatives::boardings(b))
            })
        });
        // Bundle the same boarding/alighting stations within each mode and
        // access policy. GTFS parent IDs are authoritative; no agency naming rules.
        let mut seen = HashSet::new();
        let station = |id: &Value| {
            let id = id.as_str().unwrap_or("");
            self.stop(id)
                .ok()
                .filter(|stop| !stop.parent.is_empty())
                .map_or_else(|| id.to_owned(), |stop| stop.parent.clone())
        };
        pool.retain(|p| {
            let rides: Vec<_> = p["legs"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|leg| leg["kind"] == "ride")
                .map(|leg| {
                    json!([
                        station(&leg["fromStopId"]),
                        station(&leg["toStopId"]),
                        leg["route"]["type"]
                    ])
                })
                .collect();
            seen.insert(
                serde_json::to_string(&json!([rides, p["expandedWalkingLimitKm"]])).unwrap(),
            )
        });
        let mut result = pool.first().cloned().unwrap_or(primary);
        result.as_object_mut().unwrap().remove("alternativeSearch");
        result["choices"] = json!(pool.into_iter().skip(1).collect::<Vec<_>>());
        Ok(result)
    }
}
