//! GTFS Flex journeys retain time windows and booking requirements. Driving
//! estimates come from the same native OSM graph as Drive, never a straight line.
use super::flex_search::{FLEX_PAIR_LIMIT, Integrated, Resolved, Want};
use super::{
    City, Result, fail, flag, number,
    query::{Options, Point},
};
use chrono::NaiveDate;
use serde_json::{Value, json};

fn ring_contains(ring: &[Value], p: [f64; 2]) -> bool {
    let mut inside = false;
    for pair in ring.windows(2) {
        let a = [
            pair[0][0].as_f64().unwrap_or(f64::NAN),
            pair[0][1].as_f64().unwrap_or(f64::NAN),
        ];
        let b = [
            pair[1][0].as_f64().unwrap_or(f64::NAN),
            pair[1][1].as_f64().unwrap_or(f64::NAN),
        ];
        let cross = (p[0] - a[0]) * (b[1] - a[1]) - (p[1] - a[1]) * (b[0] - a[0]);
        if cross.abs() < 1e-12
            && p[0] >= a[0].min(b[0])
            && p[0] <= a[0].max(b[0])
            && p[1] >= a[1].min(b[1])
            && p[1] <= a[1].max(b[1])
        {
            return true;
        }
        if (a[1] > p[1]) != (b[1] > p[1])
            && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]
        {
            inside = !inside;
        }
    }
    inside
}
pub(super) fn contains(geometry: &Value, p: [f64; 2]) -> bool {
    let polygon = |value: &Value| {
        value.as_array().is_some_and(|rings| {
            rings
                .first()
                .and_then(Value::as_array)
                .is_some_and(|r| ring_contains(r, p))
                && !rings
                    .iter()
                    .skip(1)
                    .any(|r| r.as_array().is_some_and(|r| ring_contains(r, p)))
        })
    };
    match geometry["type"].as_str() {
        Some("Polygon") => polygon(&geometry["coordinates"]),
        Some("MultiPolygon") => geometry["coordinates"]
            .as_array()
            .is_some_and(|v| v.iter().any(polygon)),
        _ => false,
    }
}

/// Keep equal-time conditional candidates from displacing a less-walking,
/// simpler scheduled journey. All Flex entry points use the same ordering.
pub(super) fn compare_journeys(arrive: bool, a: &Value, b: &Value) -> std::cmp::Ordering {
    let time = if arrive {
        b["departureMinutes"]
            .as_f64()
            .unwrap_or(0.)
            .total_cmp(&a["departureMinutes"].as_f64().unwrap_or(0.))
    } else {
        a["arrivalMinutes"]
            .as_f64()
            .unwrap_or(f64::INFINITY)
            .total_cmp(&b["arrivalMinutes"].as_f64().unwrap_or(f64::INFINITY))
    };
    let walking = |j: &Value| {
        j["legs"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|l| l["kind"] == "walk")
            .map(|l| l["distanceMeters"].as_f64().unwrap_or(0.))
            .sum::<f64>()
    };
    let conditional = |j: &Value| {
        j["legs"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|l| l["flexEstimate"].is_object())
            .count()
    };
    time.then_with(|| walking(a).total_cmp(&walking(b)))
        .then_with(|| {
            a["transfers"]
                .as_u64()
                .unwrap_or(0)
                .cmp(&b["transfers"].as_u64().unwrap_or(0))
        })
        .then_with(|| conditional(a).cmp(&conditional(b)))
}

fn push_truncation_warning(result: &mut Value) {
    if !result["warnings"].is_array() {
        result["warnings"] = json!([]);
    }
    let warnings = result["warnings"].as_array_mut().unwrap();
    if !warnings
        .iter()
        .any(|w| w["code"] == "flex_search_truncated")
    {
        warnings.push(json!({"code":"flex_search_truncated","detail":format!("Flex search reached its work bound ({FLEX_PAIR_LIMIT} walkable pickup/drop-off pairs, or the interchange and driving limits); other conditional journeys may exist.")}));
    }
}

impl City {
    pub(super) fn route_with_flex(&mut self, q: &Value) -> Result<Value> {
        self.flex_validate(q)?;
        let opt = Options::parse(q)?;
        let origin = self.point(&q["origin"])?;
        let destination = self.point(&q["destination"])?;
        let scheduled_service = self.has_scheduled_connections()?;
        // One hop enumeration serves direct rides and both interchange sides.
        let interchange = scheduled_service && opt.max_boardings != Some(1);
        let mut hops = self.flex_hops(
            q,
            &opt,
            &origin,
            &destination,
            Want {
                direct: true,
                access: interchange,
                egress: interchange,
            },
        )?;
        let mut choices = self.flex_direct(q, &opt, &mut hops, [&origin, &destination], 9)?;
        let mut ordinary = q.clone();
        ordinary.as_object_mut().unwrap().remove("flex");
        // The scheduled search also scans optimistic Flex access and egress.
        // A winner without Flex proves no Flex journey is strictly better, so
        // most requests need no search of their own.
        let mut integrate = interchange && opt.max_boardings.is_some();
        let scheduled = if scheduled_service {
            let fuse = interchange && opt.max_boardings.is_none();
            let buffer = number(q, "minimumTransferBufferMinutes", 0., 0., 60.)? * 60.;
            let mut scheduled: Option<Value> = None;
            // A second fused search runs only when street walks replaced the
            // straight-line bounds of the first winner's rides.
            for attempt in 0..2 {
                if fuse {
                    self.activate(&ordinary)?;
                    let index = hops.index.clone();
                    let extra = move |end: &super::flex_search::End| {
                        if end.stop.is_some_and(|s| index.rule_stops.contains(&s)) {
                            0.
                        } else {
                            buffer
                        }
                    };
                    let (access, egress) = self.flex_seeds(&opt, &hops, true, true, &extra);
                    if !access.seconds.is_empty() || !egress.seconds.is_empty() {
                        self.flex_overlay = Some((access.seconds, egress.seconds));
                    }
                }
                self.flex_witness = None;
                let fused = self.route(&ordinary);
                self.flex_overlay = None;
                let Some(witness) = self.flex_witness.take() else {
                    if scheduled.is_none() {
                        scheduled = Some(fused?);
                    }
                    break;
                };
                if scheduled.is_none() {
                    scheduled = Some(self.route(&ordinary)?);
                }
                let plan = scheduled.as_ref().unwrap();
                let key = if opt.arrive {
                    "departureMinutes"
                } else {
                    "arrivalMinutes"
                };
                let bound = (plan["status"] == "ready")
                    .then(|| plan[key].as_f64().map(|m| m * 60.))
                    .flatten();
                let endpoints = [&origin, &destination];
                match self.flex_resolve(q, &opt, &mut hops, endpoints, witness, bound)? {
                    Resolved::Journey(journey) => choices.push(journey),
                    Resolved::Worse => {}
                    Resolved::Repriced if attempt == 0 => continue,
                    Resolved::Repriced | Resolved::Unresolved => {
                        hops.promising = true;
                        integrate = true;
                    }
                }
                break;
            }
            scheduled.unwrap()
        } else if q["requireTransitRide"] == true {
            json!({"status":"blocked"})
        } else {
            self.flex_direct_walk(q)?
        };
        if integrate {
            let bound = (scheduled["status"] == "ready")
                .then(|| {
                    let key = if opt.arrive {
                        "departureMinutes"
                    } else {
                        "arrivalMinutes"
                    };
                    scheduled[key].as_f64().map(|m| m * 60.)
                })
                .flatten();
            match self.flex_integrated(q, &opt, &mut hops, [&origin, &destination], bound)? {
                Integrated::Journey(journey) => choices.push(journey),
                Integrated::RuleBound => choices.extend(self.flex_transfers(q)?),
                Integrated::None => {}
            }
        }
        let mut result = scheduled;
        if result["status"] == "ready" {
            let extra = result.as_object_mut().unwrap().remove("choices");
            choices.push(result);
            choices.extend(
                extra
                    .and_then(|v| v.as_array().cloned())
                    .unwrap_or_default(),
            );
        }
        choices.sort_by(|a, b| compare_journeys(opt.arrive, a, b));
        choices.dedup_by(|a, b| {
            a["legs"] == b["legs"]
                && a["departureMinutes"] == b["departureMinutes"]
                && a["arrivalMinutes"] == b["arrivalMinutes"]
        });
        let mut result = choices
            .first()
            .cloned()
            .unwrap_or(json!({"status":"blocked","reason":"no_service","mode":"transit"}));
        result["choices"] = json!(choices.into_iter().take(9).collect::<Vec<_>>());
        if hops.truncated {
            push_truncation_warning(&mut result);
        }
        Ok(result)
    }
    pub(super) fn matrix_with_flex(&mut self, q: &Value, evidence: bool) -> Result<Value> {
        let origins = q["origins"].as_array().ok_or("origins required")?;
        let destinations = q["destinations"]
            .as_array()
            .ok_or("destinations required")?;
        if origins.is_empty()
            || destinations.is_empty()
            || origins.len().saturating_mul(destinations.len()) > 4096
        {
            return fail("Flex Matrix must contain 1..4096 cells");
        }
        let mut ordinary = q.clone();
        ordinary.as_object_mut().unwrap().remove("flex");
        let scheduled = self.has_scheduled_connections()?;
        let indexed = self.indexed_matrix_journeys;
        self.indexed_matrix_journeys = false;
        let base = if scheduled {
            self.matrix_with(&ordinary, evidence)
        } else {
            Ok(
                json!({"kind":"matrix","mode":"transit","originCount":origins.len(),"destinationCount":destinations.len(),
                "durationsMinutes":vec![vec![Value::Null;destinations.len()];origins.len()],
                "journeys":if q["includeJourneys"] == true {json!(vec![vec![Value::Null;destinations.len()];origins.len()])} else {Value::Null}}),
            )
        };
        self.indexed_matrix_journeys = indexed;
        let mut result = base?;
        let opt = Options::parse(q)?;
        let mut truncated = false;
        for (i, a) in origins.iter().enumerate() {
            for (j, b) in destinations.iter().enumerate() {
                let mut request = q.clone();
                request["origin"] = a.clone();
                request["destination"] = b.clone();
                let journey = self.route_with_flex(&request)?;
                truncated |= journey["warnings"]
                    .as_array()
                    .is_some_and(|w| w.iter().any(|w| w["code"] == "flex_search_truncated"));
                if journey["status"] != "ready" {
                    continue;
                }
                let minutes = if opt.arrive {
                    opt.time / 60. - journey["departureMinutes"].as_f64().unwrap()
                } else {
                    journey["arrivalMinutes"].as_f64().unwrap() - opt.time / 60.
                };
                if result["durationsMinutes"][i][j]
                    .as_f64()
                    .is_none_or(|old| minutes < old)
                {
                    result["durationsMinutes"][i][j] = json!(minutes);
                    if result["journeys"].is_array() {
                        result["journeys"][i][j] = journey;
                    }
                }
            }
        }
        if !result["warnings"].is_array() {
            result["warnings"] = json!([]);
        }
        result["warnings"].as_array_mut().unwrap().push(json!({"code":"flex_estimate","detail":"Includes conditional Flex journeys; booking and vehicle availability are not confirmed."}));
        if truncated {
            push_truncation_warning(&mut result);
        }
        Ok(result)
    }
    fn flex_direct_walk(&mut self, q: &Value) -> Result<Value> {
        let opt = Options::parse(q)?;
        if !flag(q, "allowLongWalk", true)? && opt.walk_m == 0. {
            return Ok(json!({"status":"blocked"}));
        }
        let origin = self.point(&q["origin"])?;
        let destination = self.point(&q["destination"])?;
        // Keep the transit request when applying direct-walk limits.
        let route = self.street_route(q, &origin, &destination, &opt, "walk")?;
        if route["departureMinutes"]
            .as_f64()
            .is_some_and(|t| t * 60. < opt.start)
            || route["arrivalMinutes"]
                .as_f64()
                .is_some_and(|t| t * 60. > opt.end)
        {
            return Ok(json!({"status":"blocked"}));
        }
        Ok(route)
    }
    pub(super) fn has_scheduled_connections(&self) -> Result<bool> {
        Ok(self.db.query_row(
            "SELECT EXISTS(SELECT 1 FROM connections) OR EXISTS(SELECT 1 FROM headway_connections)",
            [],
            |r| r.get(0),
        )?)
    }
    pub(super) fn flex_catalogs(&mut self) -> Result<std::sync::Arc<Value>> {
        if self.flex_catalog.get().is_none() {
            let exists: bool = self.db.query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='flex_catalog')",
                [],
                |r| r.get(0),
            )?;
            let mut records = vec![];
            if exists {
                let bytes: i64 = self.db.query_row(
                    "SELECT COALESCE(SUM(length(CAST(data AS BLOB))),0) FROM flex_catalog",
                    [],
                    |r| r.get(0),
                )?;
                if bytes > 32 * 1024 * 1024 {
                    return fail("Flex catalog exceeds the 32 MiB resident limit");
                }
                let mut stmt = self
                    .db
                    .prepare("SELECT data FROM flex_catalog ORDER BY scope")?;
                for row in stmt.query_map([], |r| r.get::<_, String>(0))? {
                    let catalog: Value = serde_json::from_str(&row?)?;
                    let trips = catalog["trips"]
                        .as_object()
                        .ok_or("Invalid Flex trip catalog")?;
                    for trip in trips.values() {
                        if ["trip_id", "route_id", "service_id"]
                            .iter()
                            .any(|key| !trip[key].is_string())
                        {
                            return fail("Invalid Flex trip identity");
                        }
                        let calls = trip["calls"].as_array().ok_or("Invalid Flex calls")?;
                        for call in calls {
                            if !call["location"].is_string()
                                || !call["window"].is_boolean()
                                || call["sequence"].as_u64().is_none()
                                || ["start", "end"].iter().any(|key| {
                                    call[key]
                                        .as_f64()
                                        .is_none_or(|n| !(0. ..=3_599_999.).contains(&n))
                                })
                            {
                                return fail("Invalid Flex call in prepared City");
                            }
                        }
                    }
                    records.push(catalog);
                }
            }
            let _ = self
                .flex_catalog
                .set(std::sync::Arc::new(Value::Array(records)));
        }
        Ok(self.flex_catalog.get().unwrap().clone())
    }
    pub(super) fn flex_walk(
        &mut self,
        q: &Value,
        a: &Point,
        b: &Point,
        opt: &Options,
    ) -> Result<Value> {
        if a.coordinate == b.coordinate {
            // A free roadside pickup is not evidence of wheelchair access.
            // Even a zero-length access leg must touch the strict street graph.
            if self.metadata["accessibility"]["profile"] == "wheelchair-strict-v1"
                && (a.stop.is_none() || b.stop.is_none())
            {
                let proof = self.street.route_path(crate::StreetPathInput {
                    origin_lon: a.coordinate[0],
                    origin_lat: a.coordinate[1],
                    destination_lon: b.coordinate[0],
                    destination_lat: b.coordinate[1],
                    maximum_distance_m: 1e-4,
                    maximum_points: 2,
                })?;
                if !proof.found {
                    return Ok(json!({"status":"blocked"}));
                }
            }
            return Ok(json!({"status":"ready","durationMinutes":0,"legs":[]}));
        }
        if opt.walk_m == 0. {
            return Ok(json!({"status":"blocked"}));
        }
        self.street_route(q, a, b, opt, "walk")
    }
    fn flex_validate(&mut self, q: &Value) -> Result<()> {
        for key in [
            "via",
            "waypoints",
            "scenario",
            "windowMinutes",
            "windowChoices",
            "journeyPolicy",
            "sharedLegs",
            "includeEarliestTransit",
            "alternatives",
            "alternativeRanking",
            "alternativeSlackMinutes",
            "expandedWalkKm",
            "realtimeSnapshot",
            "traffic",
        ] {
            if q.get(key).is_some_and(|v| !v.is_null()) {
                return fail(format!("Flex does not yet support {key}; omit it"));
            }
        }
        if q["routingDataMode"] == "realtime" || q["dataMode"] == "realtime" {
            return fail("Flex currently requires scheduled service");
        }
        if !q["flex"].is_object() {
            return fail("flex must be an options object");
        }
        if q["mode"].as_str().unwrap_or("transit") != "transit" {
            return fail("Flex requires transit mode");
        }
        let date = NaiveDate::parse_from_str(
            q["serviceDate"]
                .as_str()
                .ok_or("Flex requires serviceDate")?,
            "%Y-%m-%d",
        )?;
        let scopes = self.selected_scopes(q)?;
        if flag(q, "requireCompleteServiceCoverage", false)?
            && !self.complete_service_coverage(&self.services_on(date)?, &scopes)?
        {
            return fail("Incomplete service coverage across source feeds on the requested date");
        }
        // Validate the option values before any search uses them.
        number(&q["flex"], "durationFactor", 1.5, 1., 10.)?;
        number(&q["flex"], "durationOffsetSeconds", 300., 0., 7200.)?;
        flag(&q["flex"], "bookingConfirmed", false)?;
        Ok(())
    }
    /// Direct conditional journeys between the endpoints, without fixed service.
    pub(super) fn flex_route(&mut self, q: &Value) -> Result<Value> {
        self.flex_validate(q)?;
        let opt = Options::parse(q)?;
        let origin = self.point(&q["origin"])?;
        let destination = self.point(&q["destination"])?;
        let want = Want {
            direct: true,
            access: false,
            egress: false,
        };
        let mut hops = self.flex_hops(q, &opt, &origin, &destination, want)?;
        let choices = self.flex_direct(q, &opt, &mut hops, [&origin, &destination], 9)?;
        let mut result = choices
            .first()
            .cloned()
            .unwrap_or(json!({"status":"blocked","reason":"no_flex_service","mode":"transit"}));
        result["choices"] = json!(choices);
        if hops.truncated {
            result["flexSearchTruncated"] = json!(true);
            push_truncation_warning(&mut result);
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn polygons_respect_holes_and_boundaries() {
        let g = json!({"type":"Polygon","coordinates":[[[0,0],[4,0],[4,4],[0,4],[0,0]],[[1,1],[2,1],[2,2],[1,2],[1,1]]]});
        assert!(contains(&g, [0., 2.]));
        assert!(contains(&g, [3., 3.]));
        assert!(!contains(&g, [1.5, 1.5]));
        assert!(!contains(&g, [1., 1.]));
        assert!(!contains(&g, [5., 1.]));
    }
}
