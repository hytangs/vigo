//! GTFS Flex journeys retain time windows and booking requirements. Driving
//! estimates come from the same native OSM graph as Drive, never a straight line.
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

// Earliest departure / latest arrival obey both endpoint windows. Intermediate
// window locations are optional stops, not mandatory detours.
fn clocks(a: &Value, b: &Value, seconds: f64, opt: &Options) -> Option<(f64, f64)> {
    let start = a["start"].as_f64()?;
    let end = if a["window"] == false {
        start
    } else {
        a["end"].as_f64()?
    };
    let de = b["end"].as_f64()?;
    let ds = if b["window"] == false {
        de
    } else {
        b["start"].as_f64()?
    };
    let lower = start.max(ds - seconds).max(opt.start);
    let upper = end.min(de - seconds).min(opt.end - seconds);
    let departure = if opt.arrive {
        upper.min(opt.time - seconds)
    } else {
        lower.max(opt.time)
    };
    (departure >= lower && departure <= upper).then_some((departure, departure + seconds))
}

impl City {
    pub(super) fn route_with_flex(&mut self, q: &Value) -> Result<Value> {
        let flex = self.flex_route(q)?;
        let mut ordinary = q.clone();
        ordinary.as_object_mut().unwrap().remove("flex");
        let scheduled = if self.has_scheduled_connections()? {
            self.route(&ordinary)?
        } else if q["requireTransitRide"] == true {
            json!({"status":"blocked"})
        } else {
            self.flex_direct_walk(q)?
        };
        let mut choices = self.flex_transfers(q)?;
        for mut result in [scheduled, flex] {
            if result["status"] != "ready" {
                continue;
            }
            let extra = result.as_object_mut().unwrap().remove("choices");
            choices.push(result);
            choices.extend(
                extra
                    .and_then(|v| v.as_array().cloned())
                    .unwrap_or_default(),
            );
        }
        let arrive = Options::parse(q)?.arrive;
        choices.sort_by(|a, b| {
            if arrive {
                b["departureMinutes"]
                    .as_f64()
                    .unwrap_or(0.)
                    .total_cmp(&a["departureMinutes"].as_f64().unwrap_or(0.))
            } else {
                a["arrivalMinutes"]
                    .as_f64()
                    .unwrap_or(f64::INFINITY)
                    .total_cmp(&b["arrivalMinutes"].as_f64().unwrap_or(f64::INFINITY))
            }
        });
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
        for (i, a) in origins.iter().enumerate() {
            for (j, b) in destinations.iter().enumerate() {
                let mut request = q.clone();
                request["origin"] = a.clone();
                request["destination"] = b.clone();
                let journey = self.route_with_flex(&request)?;
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
    fn flex_points(&self, catalog: &Value, location: &str, point: &Point) -> Result<Vec<Point>> {
        if let Some(zone) = catalog["locations"].get(location) {
            return Ok(if contains(&zone["geometry"], point.coordinate) {
                vec![point.clone()]
            } else {
                vec![]
            });
        }
        let stops: Vec<&str> = if let Some(group) = catalog["groups"].get(location) {
            group["stops"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect()
        } else {
            vec![location]
        };
        let mut points = Vec::new();
        for id in stops {
            if self.metadata["accessibility"]["profile"] == "wheelchair-strict-v1" {
                let accessible = self.db.query_row(
                    "SELECT EXISTS(SELECT 1 FROM wheelchair_stops WHERE stop_id=? AND boarding=1)",
                    [id],
                    |r| r.get::<_, bool>(0),
                )?;
                if !accessible {
                    continue;
                }
            }
            points.push(self.point(&json!({"stopId":id}))?);
        }
        Ok(points)
    }
    fn flex_walk(&mut self, q: &Value, a: &Point, b: &Point, opt: &Options) -> Result<Value> {
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
    pub(super) fn flex_route(&mut self, q: &Value) -> Result<Value> {
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
        let opt = Options::parse(q)?;
        let date = NaiveDate::parse_from_str(
            q["serviceDate"]
                .as_str()
                .ok_or("Flex requires serviceDate")?,
            "%Y-%m-%d",
        )?;
        let origin = self.point(&q["origin"])?;
        let destination = self.point(&q["destination"])?;
        let zone: chrono_tz::Tz = self.metadata["agencyTimezones"]
            .as_array()
            .and_then(|a| a.first())
            .and_then(Value::as_str)
            .unwrap_or("UTC")
            .parse()?;
        let epoch = super::calendar::service_epoch(zone, date)?;
        let scopes = self.selected_scopes(q)?;
        if flag(q, "requireCompleteServiceCoverage", false)?
            && !self.complete_service_coverage(&self.services_on(date)?, &scopes)?
        {
            return fail("Incomplete service coverage across source feeds on the requested date");
        }
        let catalogs = self.flex_catalogs()?;
        let maximum_clock = catalogs
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|catalog| {
                catalog["trips"]
                    .as_object()
                    .into_iter()
                    .flat_map(|trips| trips.values())
            })
            .flat_map(|trip| trip["calls"].as_array().into_iter().flatten())
            .filter_map(|call| call["end"].as_f64())
            .fold(0_f64, f64::max);
        let first_day = ((opt.start - maximum_clock) / 86400.).floor() as i64 - 1;
        let last_day = (opt.end / 86400.).ceil() as i64 + 1;
        let mut days = vec![];
        for delta in first_day..=last_day {
            let day = date
                .checked_add_signed(chrono::Duration::days(delta))
                .ok_or("Flex service date overflow")?;
            let offset = (super::calendar::service_epoch(zone, day)? - epoch) as f64;
            days.push((day, offset, self.services_on(day)?));
        }
        let confirmed = flag(&q["flex"], "bookingConfirmed", false)?;
        let fallback_factor = number(&q["flex"], "durationFactor", 1.5, 1., 10.)?;
        let fallback_offset = number(&q["flex"], "durationOffsetSeconds", 300., 0., 7200.)?;
        let mut choices = vec![];
        let mut evaluated = 0usize;
        for catalog in catalogs.as_array().into_iter().flatten() {
            for (service_date, offset, active) in &days {
                for trip in catalog["trips"]
                    .as_object()
                    .into_iter()
                    .flat_map(|o| o.values())
                {
                    if self.metadata["accessibility"]["profile"] == "wheelchair-strict-v1"
                        && trip["wheelchair"] != 1
                    {
                        continue;
                    }
                    let service = trip["service_id"].as_str().ok_or("Invalid Flex service")?;
                    if !active.contains(service) {
                        continue;
                    }
                    if scopes.as_ref().is_some_and(|scopes| {
                        service
                            .split_once('\u{1f}')
                            .is_none_or(|(scope, _)| !scopes.contains(scope))
                    }) {
                        continue;
                    }
                    if q["excludedTripIds"]
                        .as_array()
                        .is_some_and(|ids| ids.contains(&trip["trip_id"]))
                        || q["excludedRouteIds"]
                            .as_array()
                            .is_some_and(|ids| ids.contains(&trip["route_id"]))
                    {
                        continue;
                    }
                    let mut calls = trip["calls"]
                        .as_array()
                        .ok_or("Invalid Flex calls")?
                        .clone();
                    for call in &mut calls {
                        for key in ["start", "end"] {
                            call[key] =
                                json!(call[key].as_f64().ok_or("Invalid Flex clock")? + offset);
                        }
                    }
                    if calls.iter().all(|c| {
                        c["end"].as_f64().unwrap() < opt.start
                            || c["start"].as_f64().unwrap() > opt.end
                    }) {
                        continue;
                    }
                    let shape = trip["shapeId"]
                        .as_str()
                        .and_then(|id| catalog["shapes"].get(id))
                        .unwrap_or(&Value::Null);
                    self.continuous_calls(shape, &mut calls, &origin, &destination)?;
                    for (i, a) in calls.iter().enumerate() {
                        if a["pickup"] == 1 {
                            continue;
                        }
                        for b in calls.iter().skip(i + 1) {
                            if b["dropoff"] == 1 {
                                continue;
                            }
                            // Fixed intermediate calls remain mandatory: do not
                            // silently turn a deviated fixed route into a taxi.
                            if trip["onDemand"] == true
                                && calls[i + 1..]
                                    .iter()
                                    .take_while(|c| c["sequence"] != b["sequence"])
                                    .any(|c| c["window"] != true)
                            {
                                continue;
                            }
                            let from = if a["continuous"] == true {
                                vec![self.point(&json!({"coordinate":a["coordinate"]}))?]
                            } else {
                                self.flex_points(
                                    catalog,
                                    a["location"].as_str().ok_or("Invalid Flex location")?,
                                    &origin,
                                )?
                            };
                            let to = if b["continuous"] == true {
                                vec![self.point(&json!({"coordinate":b["coordinate"]}))?]
                            } else {
                                self.flex_points(
                                    catalog,
                                    b["location"].as_str().ok_or("Invalid Flex location")?,
                                    &destination,
                                )?
                            };
                            for board in &from {
                                for alight in &to {
                                    if board.coordinate == alight.coordinate {
                                        continue;
                                    }
                                    evaluated += 1;
                                    if evaluated > 4096 {
                                        return fail(
                                            "Flex endpoint pairs exceed the 4096 query limit",
                                        );
                                    }
                                    let (mut road, duration, factor, offset) = if trip["onDemand"]
                                        == true
                                    {
                                        let mut roadq = q.clone();
                                        roadq["mode"] = json!("drive");
                                        let road = self
                                            .street_route(&roadq, board, alight, &opt, "drive")?;
                                        if road["status"] != "ready" {
                                            continue;
                                        }
                                        let factor =
                                            trip["factor"].as_f64().unwrap_or(fallback_factor);
                                        let offset =
                                            trip["offset"].as_f64().unwrap_or(fallback_offset);
                                        let duration =
                                            (road["durationMinutes"].as_f64().unwrap_or(0.)
                                                * 60.
                                                * factor
                                                + offset)
                                                .ceil();
                                        (road, duration, factor, offset)
                                    } else {
                                        if a["continuous"] != true
                                            && b["continuous"] != true
                                            && a["pickup"] != 2
                                            && b["dropoff"] != 2
                                            && !a["pickupBooking"].is_string()
                                            && !b["dropoffBooking"].is_string()
                                        {
                                            continue;
                                        }
                                        let duration = b["end"].as_f64().unwrap()
                                            - a["start"].as_f64().unwrap();
                                        if duration < 0. {
                                            continue;
                                        }
                                        let coordinates =
                                            super::flex_continuous::geometry(shape, a, b)
                                                .unwrap_or_else(|| {
                                                    calls[i..]
                                                        .iter()
                                                        .take_while(|c| {
                                                            c["sequence"].as_f64()
                                                                <= b["sequence"].as_f64()
                                                        })
                                                        .filter_map(|c| {
                                                            self.stop(c["location"].as_str()?).ok()
                                                        })
                                                        .map(|s| [s.lon, s.lat])
                                                        .collect()
                                                });
                                        (
                                            json!({"legs":[{"coordinates":coordinates}]}),
                                            duration,
                                            1.,
                                            0.,
                                        )
                                    };
                                    let mut walkq = q.clone();
                                    walkq["allowLongWalk"] = json!(false);
                                    let mut access =
                                        self.flex_walk(&walkq, &origin, board, &opt)?;
                                    let mut egress =
                                        self.flex_walk(&walkq, alight, &destination, &opt)?;
                                    if access["status"] != "ready" || egress["status"] != "ready" {
                                        continue;
                                    }
                                    let access_s =
                                        access["durationMinutes"].as_f64().unwrap_or(0.) * 60.;
                                    let egress_s =
                                        egress["durationMinutes"].as_f64().unwrap_or(0.) * 60.;
                                    let mut adjusted = Options::parse(q)?;
                                    adjusted.time += if opt.arrive { -egress_s } else { access_s };
                                    adjusted.start += access_s;
                                    adjusted.end -= egress_s;
                                    let Some((departure, arrival)) =
                                        clocks(a, b, duration, &adjusted)
                                    else {
                                        continue;
                                    };
                                    let mut requirements = vec![];
                                    for (call, key, permission) in [
                                        (a, "pickupBooking", "pickup"),
                                        (b, "dropoffBooking", "dropoff"),
                                    ] {
                                        if call[permission] == 2 || call[key].is_string() {
                                            let rule = call[key].as_str().and_then(|id|catalog["bookings"].get(id)).cloned().unwrap_or(json!({"message":"Contact the operator to arrange this trip"}));
                                            requirements.push(rule);
                                        }
                                    }
                                    let mut legs = vec![];
                                    let retime = |result: &mut Value, start: f64| -> Vec<Value> {
                                        let mut clock = start;
                                        result["legs"]
                                            .as_array_mut()
                                            .map(|items| {
                                                items
                                                    .iter_mut()
                                                    .map(|leg| {
                                                        let seconds = leg["durationMinutes"]
                                                            .as_f64()
                                                            .unwrap_or(0.)
                                                            * 60.;
                                                        leg["departureMinutes"] =
                                                            json!(clock / 60.);
                                                        clock += seconds;
                                                        leg["arrivalMinutes"] = json!(clock / 60.);
                                                        leg.clone()
                                                    })
                                                    .collect()
                                            })
                                            .unwrap_or_default()
                                    };
                                    if access_s > 0. {
                                        legs.extend(retime(&mut access, departure - access_s));
                                    }
                                    let coordinates: Vec<Value> = road["legs"]
                                        .as_array_mut()
                                        .into_iter()
                                        .flatten()
                                        .flat_map(|l| {
                                            l["coordinates"].as_array().cloned().unwrap_or_default()
                                        })
                                        .collect();
                                    let route_id =
                                        trip["route_id"].as_str().ok_or("Invalid Flex route")?;
                                    let route: Value = self.db.query_row("SELECT short_name,long_name,route_type,color FROM routes WHERE route_id=?", [route_id], |r| Ok(json!({"shortName":r.get::<_,String>(0)?,"longName":r.get::<_,String>(1)?,"type":r.get::<_,i64>(2)?,"color":r.get::<_,String>(3)?})))?;
                                    legs.push(json!({"kind":"ride","routeId":route_id,"route":route,"tripId":trip["trip_id"],"serviceId":service,"serviceDate":service_date.to_string(),
                                "fromStopId":board.stop,"toStopId":alight.stop,"from":{"coordinate":board.coordinate},"to":{"coordinate":alight.coordinate},
                                "departureMinutes":departure/60.,"arrivalMinutes":arrival/60.,"durationMinutes":duration/60.,"distanceMeters":road["distanceMeters"],"coordinates":coordinates,"geometrySource":if trip["onDemand"] == true {"osm"} else if shape.is_array() {"gtfs_shape"} else {"stop_sequence"},
                                "flexEstimate":{"durationFactor":factor,"durationOffsetSeconds":offset,"driverCoordination":a["driverCoordination"] == true || b["driverCoordination"] == true,"assumption":if a["continuous"] == true || b["continuous"] == true {"interpolated_shape"} else if trip["onDemand"] != true {"published_timetable"} else if trip["factor"].is_number() && trip["offset"].is_number(){"gtfs_safe_duration"}else{"configured_driving_estimate"},
                                "bookingStatus":if confirmed {"caller_confirmed"} else if requirements.is_empty(){"not_required"} else {"required"},"bookingRequirements":requirements}}));
                                    if egress_s > 0. {
                                        legs.extend(retime(&mut egress, arrival));
                                    }
                                    choices.push(json!({"status":"ready","mode":"transit","clockDate":q["serviceDate"],"departureMinutes":(departure-access_s)/60.,"arrivalMinutes":(arrival+egress_s)/60.,"durationMinutes":(duration+access_s+egress_s)/60.,"transfers":0,"legs":legs,
                                "warnings":[{"code":"flex_estimate","detail":"Conditional on operator availability and booking. Consult each leg for its timing assumption; no booking has been made."}]}));
                                }
                            }
                        }
                    }
                }
            }
        }
        choices.sort_by(|a, b| {
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
        choices.dedup_by(|a, b| {
            a["legs"] == b["legs"]
                && a["departureMinutes"] == b["departureMinutes"]
                && a["arrivalMinutes"] == b["arrivalMinutes"]
        });
        let mut result = choices
            .first()
            .cloned()
            .unwrap_or(json!({"status":"blocked","reason":"no_flex_service","mode":"transit"}));
        result["choices"] = json!(choices.into_iter().take(9).collect::<Vec<_>>());
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
    #[test]
    fn windows_include_waiting_and_reject_late_dropoff() {
        let a = json!({"start":28800,"end":36000});
        let b = json!({"start":29400,"end":36000});
        let opt = Options::parse(&json!({"time":"08:00"})).unwrap();
        assert_eq!(clocks(&a, &b, 300., &opt), Some((29100., 29400.)));
        assert_eq!(clocks(&a, &b, 8000., &opt), None);
        let opt = Options::parse(&json!({"time":"09:00","timePreference":"arrive_by"})).unwrap();
        assert_eq!(clocks(&a, &b, 300., &opt), Some((32100., 32400.)));
    }
}
