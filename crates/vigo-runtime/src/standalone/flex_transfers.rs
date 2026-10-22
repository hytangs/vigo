//! Compose conditional service with native scheduled searches at GTFS stops.
//! Both halves retain their native witnesses; transfer rules resolve using the
//! same specificity implementation as the scheduled service search.
use super::{City, Result, fail, flag, number, query::Options};
use crate::TransferRule;
use serde_json::{Value, json};
use std::collections::{BTreeSet, VecDeque};

fn clock_request(q: &Value, time: f64, arrive: bool) -> Value {
    let mut q = q.clone();
    q.as_object_mut().unwrap().remove("time");
    q["timeMinutes"] = json!(time);
    q["timePreference"] = json!(if arrive { "arrive_by" } else { "depart_at" });
    q
}
fn choices(mut result: Value) -> Vec<Value> {
    if result["status"] != "ready" {
        return vec![];
    }
    let alternatives = result.as_object_mut().unwrap().remove("choices");
    let mut choices = alternatives
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default();
    if choices.is_empty() {
        choices.push(result);
    }
    choices
}
impl City {
    fn flex_transfer_minimum(&self, from: &Value, to: &Value) -> Result<Option<f64>> {
        let (Some(a), Some(b)) = (from["toStopId"].as_str(), to["fromStopId"].as_str()) else {
            return Ok(Some(0.));
        };
        let matches_stop = |selector: &str, initial: &str| {
            let mut id = initial.to_owned();
            let mut seen = BTreeSet::new();
            loop {
                if selector == id {
                    return true;
                }
                if !seen.insert(id.clone()) {
                    return false;
                }
                let Ok(stop) = self.stop(&id) else {
                    return false;
                };
                if stop.parent.is_empty() {
                    return false;
                }
                id = stop.parent.clone();
            }
        };
        let exists: bool = self.db.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='transfer_rules')",
            [],
            |r| r.get(0),
        )?;
        if !exists {
            return Ok(Some(0.));
        }
        let mut statement = self.db.prepare("SELECT from_stop_id,to_stop_id,from_route_id,to_route_id,from_trip_id,to_trip_id,transfer_type,min_transfer_time FROM transfer_rules WHERE transfer_type<4")?;
        let mut matching = vec![];
        for row in statement.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, Option<String>>(4)?,
                r.get::<_, Option<String>>(5)?,
                r.get::<_, u8>(6)?,
                r.get::<_, u32>(7)?,
            ))
        })? {
            let (s, t, fr, tr, ft, tt, kind, minimum) = row?;
            if !matches_stop(&s, a) || !matches_stop(&t, b) {
                continue;
            }
            if [
                (&fr, &from["routeId"]),
                (&tr, &to["routeId"]),
                (&ft, &from["tripId"]),
                (&tt, &to["tripId"]),
            ]
            .iter()
            .any(|(selector, id)| selector.as_deref().is_some_and(|s| Some(s) != id.as_str()))
            {
                continue;
            }
            matching.push(TransferRule {
                from_stop: 0,
                to_stop: 0,
                from_route: fr.map(|_| 0),
                to_route: tr.map(|_| 0),
                from_trip: ft.map(|_| 0),
                to_trip: tt.map(|_| 0),
                kind,
                minimum,
            });
        }
        let rule = TransferRule::select_most_specific(&matching)?;
        Ok(match rule {
            Some(r) if r.kind == 3 => None,
            Some(r) if r.kind == 2 => Some(f64::from(r.minimum) / 60.),
            Some(r) if r.kind == 1 => Some(-1.),
            _ => Some(0.),
        })
    }
    fn flex_side(&mut self, q: &Value, flexible: bool) -> Result<Vec<Value>> {
        if flexible {
            return Ok(choices(self.flex_route(q)?));
        }
        let mut request = q.clone();
        request.as_object_mut().unwrap().remove("flex");
        if let Some(excluded) = request.as_object_mut().unwrap().remove("excludedTripIds") {
            request["scenario"] = json!({"excludedTripIds":excluded});
            return Ok(choices(self.scenario_route(&request)?));
        }
        Ok(choices(self.route_options(&request, true)?))
    }
    pub(super) fn flex_transfers(&mut self, q: &Value) -> Result<Vec<Value>> {
        let opt = Options::parse(q)?;
        if opt.max_boardings == Some(1) || !self.has_scheduled_connections()? {
            return Ok(vec![]);
        }
        let catalogs = self.flex_catalogs()?;
        let mut hubs = BTreeSet::new();
        for catalog in catalogs.as_array().into_iter().flatten() {
            for trip in catalog["trips"]
                .as_object()
                .into_iter()
                .flat_map(|t| t.values())
            {
                for call in trip["calls"].as_array().into_iter().flatten() {
                    let id = call["location"].as_str().ok_or("Invalid Flex location")?;
                    if let Some(zone) = catalog["locations"].get(id) {
                        for stop in &self.stops {
                            if stop.location == 0
                                && super::flex::contains(&zone["geometry"], [stop.lon, stop.lat])
                            {
                                hubs.insert(stop.id.clone());
                            }
                        }
                    } else if let Some(group) = catalog["groups"].get(id) {
                        for id in group["stops"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(Value::as_str)
                        {
                            hubs.insert(id.to_owned());
                        }
                    } else {
                        hubs.insert(id.to_owned());
                    }
                }
            }
        }
        if hubs.len() > 4096 {
            return fail("Flex interchange stops exceed the 4096 query limit");
        }
        let buffer = number(q, "minimumTransferBufferMinutes", 0., 0., 60.)?;
        let mut results = vec![];
        for hub in hubs {
            for flex_first in [true, false] {
                let mut left = q.clone();
                let mut right = q.clone();
                left["destination"] = json!({"stopId":hub});
                right["origin"] = json!({"stopId":hub});
                left["requireTransitRide"] = json!(true);
                right["requireTransitRide"] = json!(true);
                if let Some(boardings) = opt.max_boardings {
                    left["maxTransfers"] = json!(boardings - 2);
                    right["maxTransfers"] = json!(boardings - 2);
                }
                let (first_q, second_q, first_flex) = if opt.arrive {
                    (&right, &left, !flex_first)
                } else {
                    (&left, &right, flex_first)
                };
                for first in self.flex_side(first_q, first_flex)? {
                    let time = if opt.arrive {
                        first["departureMinutes"].as_f64().unwrap()
                    } else {
                        first["arrivalMinutes"].as_f64().unwrap()
                    };
                    if !(0. ..=5759.).contains(&time) {
                        continue;
                    }
                    let request = clock_request(second_q, time, opt.arrive);
                    let mut pending: VecDeque<_> = self
                        .flex_side(&request, !first_flex)?
                        .into_iter()
                        .map(|journey| (request.clone(), journey))
                        .collect();
                    let mut retried = BTreeSet::new();
                    while let Some((request, second)) = pending.pop_front() {
                        let (a, b) = if opt.arrive {
                            (&second, &first)
                        } else {
                            (&first, &second)
                        };
                        let al = a["legs"].as_array().ok_or("Missing Flex transfer legs")?;
                        let bl = b["legs"]
                            .as_array()
                            .ok_or("Missing transit transfer legs")?;
                        let Some(ai) = al.iter().rposition(|l| l["kind"] == "ride") else {
                            continue;
                        };
                        let Some(bi) = bl.iter().position(|l| l["kind"] == "ride") else {
                            continue;
                        };
                        if al[ai]["tripId"] == bl[bi]["tripId"] {
                            continue;
                        }
                        let minimum = self
                            .flex_transfer_minimum(&al[ai], &bl[bi])?
                            .map(|m| if m < 0. { 0. } else { m.max(buffer) });
                        let gap = bl[bi]["departureMinutes"].as_f64().unwrap()
                            - al[ai]["arrivalMinutes"].as_f64().unwrap();
                        if minimum.is_none_or(|m| gap < m) {
                            let mut retry = request.clone();
                            if let Some(minimum) = minimum {
                                let shift = minimum - gap;
                                let time = request["timeMinutes"].as_f64().unwrap()
                                    + if opt.arrive { -shift } else { shift };
                                if !(0. ..=5759.).contains(&time) {
                                    continue;
                                }
                                retry = clock_request(&retry, time, opt.arrive);
                            } else {
                                let trip = if opt.arrive {
                                    &al[ai]["tripId"]
                                } else {
                                    &bl[bi]["tripId"]
                                };
                                if !retry["excludedTripIds"].is_array() {
                                    retry["excludedTripIds"] = json!([]);
                                }
                                let excluded = retry["excludedTripIds"].as_array_mut().unwrap();
                                if excluded.contains(trip) {
                                    continue;
                                }
                                excluded.push(trip.clone());
                            }
                            let key = serde_json::to_string(&retry)?;
                            if retried.insert(key) {
                                if retried.len() > 4096 {
                                    return fail(
                                        "Flex interchange searches exceed the 4096 query limit",
                                    );
                                }
                                for next in self.flex_side(&retry, !first_flex)? {
                                    pending.push_back((retry.clone(), next));
                                }
                            }
                            continue;
                        }
                        let walking: Vec<_> = al[ai + 1..]
                            .iter()
                            .chain(&bl[..bi])
                            .filter(|l| l["kind"] == "walk")
                            .collect();
                        if walking
                            .iter()
                            .map(|l| l["distanceMeters"].as_f64().unwrap_or(0.))
                            .sum::<f64>()
                            > opt.street_m
                        {
                            continue;
                        }
                        if !flag(q, "allowStreetTransfers", true)?
                            && walking.iter().any(|l| l["geometrySource"] == "osm")
                        {
                            continue;
                        }
                        // A through-service continuation can contain several
                        // physical ride legs while remaining one boarding.
                        let count = |j: &Value| {
                            j["boardings"]
                                .as_u64()
                                .unwrap_or_else(|| j["transfers"].as_u64().unwrap_or(0) + 1)
                        };
                        let boardings = count(a) + count(b);
                        if opt.max_boardings.is_some_and(|n| boardings > u64::from(n)) {
                            continue;
                        }
                        let departure = a["departureMinutes"].as_f64().unwrap();
                        let arrival = b["arrivalMinutes"].as_f64().unwrap();
                        if departure * 60. < opt.start || arrival * 60. > opt.end {
                            continue;
                        }
                        results.push(json!({"status":"ready","mode":"transit","clockDate":q["serviceDate"],"departureMinutes":departure,"arrivalMinutes":arrival,"durationMinutes":arrival-departure,"transfers":boardings-1,"legs":al.iter().chain(bl).collect::<Vec<_>>(),"warnings":[{"code":"flex_estimate","detail":"Conditional service: booking and vehicle availability are not confirmed."}]}));
                        results.sort_by(|a, b| {
                            if opt.arrive {
                                b["departureMinutes"]
                                    .as_f64()
                                    .unwrap()
                                    .total_cmp(&a["departureMinutes"].as_f64().unwrap())
                            } else {
                                a["arrivalMinutes"]
                                    .as_f64()
                                    .unwrap()
                                    .total_cmp(&b["arrivalMinutes"].as_f64().unwrap())
                            }
                        });
                        results.dedup_by(|a, b| a["legs"] == b["legs"]);
                        results.truncate(9);
                    }
                }
            }
        }
        Ok(results)
    }
}
