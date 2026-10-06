use super::{City, Result, capabilities, fail, flag, number};
use crate::*;
use serde_json::{Value, json};
use std::time::Instant;

#[derive(Clone)]
pub(crate) struct Point {
    pub coordinate: [f64; 2],
    pub stop: Option<String>,
}
pub(crate) struct Candidates {
    pub stops: Vec<u32>,
    pub seconds: Vec<f64>,
    pub terminal_transfers: bool,
    // Native evidence is consumed directly by walking materialization. Batch
    // endpoints are unique before this object is built; no shared allocation
    // or intermediate JSON tree is needed.
    pub evidence: Option<EndpointRoleResult>,
}
impl Candidates {
    fn diagnostics(&self, point: &Point) -> Result<Value> {
        self.evidence.as_ref().map_or_else(
            || Ok(json!({"stopId":point.stop,"exactStopAccess":true})),
            |evidence| Ok(serde_json::to_value(evidence)?),
        )
    }
}
pub(crate) struct Options {
    pub time: f64,
    pub start: f64,
    pub end: f64,
    pub arrive: bool,
    pub walk_m: f64,
    pub street_m: f64,
    pub max_boardings: Option<u32>,
    pub disable_cache: bool,
    pub walk_speed: Option<f64>,
}
impl Options {
    pub fn parse(q: &Value) -> Result<Self> {
        let time = if let Some(s) = q["time"].as_str() {
            let pieces: Vec<_> = s.split(':').collect();
            if !(2..=3).contains(&pieces.len()) {
                return fail("time must be HH:MM or HH:MM:SS");
            }
            let hour: u32 = pieces[0].parse()?;
            let minute: u32 = pieces[1].parse()?;
            let second: u32 = if pieces.len() == 3 {
                pieces[2].parse()?
            } else {
                0
            };
            if hour > 71 || minute > 59 || second > 59 {
                return fail("Invalid time");
            }
            f64::from(hour * 3600 + minute * 60 + second)
        } else if q.get("timeMinutes").is_some() {
            number(q, "timeMinutes", 0., 0., 4319.)? * 60.
        } else if q["time"].is_number() {
            number(q, "time", 0., 0., 4319.)? * 60.
        } else {
            return fail("time (HH:MM) or timeMinutes is required");
        };
        let arrive = match q["timePreference"].as_str().unwrap_or("depart_at") {
            "depart_at" | "depart" => false,
            "arrive_by" | "arrive" => true,
            _ => return fail("timePreference must be depart_at or arrive_by"),
        };
        let horizon = number(q, "horizonMinutes", 480., 1., 2880.)? * 60.;
        let max_boardings = match q.get("maxTransfers") {
            None => None,
            Some(v) => {
                let n = v
                    .as_u64()
                    .filter(|&n| n <= 31)
                    .ok_or("maxTransfers must be an integer 0..31")?;
                Some(n as u32 + 1)
            }
        };
        Ok(Self {
            time,
            start: if arrive {
                (time - horizon).max(0.)
            } else {
                time
            },
            end: if arrive { time } else { time + horizon },
            arrive,
            walk_m: number(q, "maxWalkKm", 1.2, 0., 100.)? * 1000.,
            street_m: number(q, "maxStreetKm", 50., 0.05, 1000.)? * 1000.,
            max_boardings,
            disable_cache: flag(q, "disableCache", false)?,
            walk_speed: q
                .get("walkSpeedKph")
                .map(|_| number(q, "walkSpeedKph", 4.8, 1., 8.))
                .transpose()?,
        })
    }
}
impl City {
    fn direct_walk_limit(&self, q: &Value, opt: &Options) -> Result<f64> {
        let distance = if flag(q, "allowLongWalk", true)? {
            opt.street_m
        } else {
            opt.walk_m
        };
        Ok(distance
            .min((opt.end - opt.start) / 3600. * opt.walk_speed.unwrap_or(self.speed) * 1000.))
    }
    pub fn execute_public(&mut self, command: &str, request: &Value) -> Result<Value> {
        crate::presentation::validate(request)?;
        let mut query = request.clone();
        crate::presentation::normalize_points(&mut query)?;
        if let Some(o) = query.as_object_mut() {
            o.remove("diagnostics");
            o.remove("includeLimitations");
            if command != "matrix" {
                o.remove("includeGeometry");
            }
        }
        if command == "compare" && request["before"]["schema"].is_string() {
            return Ok(crate::presentation::compare(
                &request["before"],
                &request["after"],
            )?);
        }
        let mut raw = self.execute(command, &query)?;
        if request["includeLimitations"] == true {
            raw["warnings"] = self.metadata["routingLimitations"].clone();
        }
        Ok(crate::presentation::format(command, request, &raw))
    }
    pub fn execute(&mut self, command: &str, request: &Value) -> Result<Value> {
        if !request.is_object() {
            return fail("Request must be a JSON object");
        }
        validate_request(command, request)?;
        let started = Instant::now();
        let reserved = arrival_reserve(command, request)?;
        let effective = reserved.as_ref().map_or(request, |(query, _)| query);
        let mut result = match command {
            "info" => self.info(),
            "capabilities" => capabilities(),
            "route" => self.route(effective)?,
            "matrix" => self.matrix(effective)?,
            "reach" | "isochrone" => self.reach(effective)?,
            "compare" => super::compare(&request["before"], &request["after"])?,
            "native" => self.native(request)?,
            _ => return fail(format!("Unknown command: {command}")),
        };
        if let Some((_, diagnostics)) = reserved {
            if command == "matrix" {
                let minutes = diagnostics["arrivalBufferMinutes"].as_f64().unwrap();
                for row in result["durationsMinutes"].as_array_mut().unwrap() {
                    for duration in row.as_array_mut().unwrap() {
                        if let Some(value) = duration.as_f64() {
                            *duration = json!(value + minutes);
                        }
                    }
                }
            }
            result["diagnostics"]["timeReserves"] = diagnostics;
        }
        result["runtime"] = json!("rust");
        result["cityRevision"] = self.manifest["revisionId"].clone();
        result["timing"] = json!({"totalMs":started.elapsed().as_secs_f64()*1000.});
        if request["mode"].as_str().unwrap_or("transit") == "transit"
            && matches!(command, "route" | "matrix" | "reach" | "isochrone")
            && let Some(timetable) = &self.timetable
        {
            result["timing"]["timetableSource"] = json!(timetable.preparation);
        }
        if result.get("schemaVersion").is_none() {
            result["schemaVersion"] = json!("vigo.standalone.result.v1");
        }
        Ok(result)
    }
    pub(crate) fn point(&self, value: &Value) -> Result<Point> {
        if let Some(object) = value.as_object() {
            for key in object.keys() {
                if ![
                    "stopId",
                    "coordinate",
                    "id",
                    "name",
                    "label",
                    "source",
                    "editStatus",
                    "baselineStopId",
                    "baselineStopIndex",
                ]
                .contains(&key.as_str())
                {
                    return fail(format!("Unknown point field: {key}"));
                }
            }
            if value.get("stopId").is_some_and(|id| !id.is_string()) {
                return fail("stopId must be a string");
            }
        }
        if value["source"] != "map"
            && let Some(id) = value["stopId"].as_str().or_else(|| value.as_str())
        {
            let s = self.stop(id)?;
            if !s.lon.is_finite() || !s.lat.is_finite() {
                return fail("Selected stop has no source coordinate");
            }
            return Ok(Point {
                coordinate: [s.lon, s.lat],
                stop: Some(id.to_owned()),
            });
        }
        let coordinate = if value.is_array() {
            value
        } else {
            &value["coordinate"]
        };
        let a = coordinate
            .as_array()
            .filter(|a| a.len() == 2)
            .ok_or("Point must contain stopId or coordinate: [longitude, latitude]")?;
        let lon = a[0]
            .as_f64()
            .filter(|v| v.is_finite() && v.abs() <= 180.)
            .ok_or("Invalid longitude")?;
        let lat = a[1]
            .as_f64()
            .filter(|v| v.is_finite() && v.abs() <= 90.)
            .ok_or("Invalid latitude")?;
        Ok(Point {
            coordinate: [lon, lat],
            stop: None,
        })
    }
    pub(crate) fn candidates(
        &mut self,
        point: &Point,
        role: &str,
        opt: &Options,
    ) -> Result<Candidates> {
        if let Some(id) = &point.stop {
            let t = self.timetable.as_ref().ok_or("Timetable is not active")?;
            let selected = self.stop(id)?;
            let station = if selected.location == 1 {
                id.as_str()
            } else {
                &selected.parent
            };
            let mut ids = vec![if station.is_empty() {
                id.as_str()
            } else {
                station
            }];
            if !station.is_empty() {
                for (id, members) in &self.access.materialized.station_members {
                    if id == station {
                        ids.extend(members.iter().map(String::as_str));
                    }
                }
            }
            let mut stops: Vec<u32> = ids
                .iter()
                .filter_map(|id| t.index.get(*id).copied())
                .collect();
            stops.sort_unstable();
            stops.dedup();
            if stops.is_empty() {
                return fail("Stop missing from timetable");
            }
            return Ok(Candidates {
                seconds: vec![0.; stops.len()],
                stops,
                terminal_transfers: true,
                evidence: None,
            });
        }
        self.street_candidates(point, role, opt, self.padding, self.overhead)
    }
    pub(crate) fn street_candidates(
        &mut self,
        point: &Point,
        role: &str,
        opt: &Options,
        padding: f64,
        overhead: f64,
    ) -> Result<Candidates> {
        let result = self.street.route_endpoint(EndpointRoleInput {
            longitude: point.coordinate[0],
            latitude: point.coordinate[1],
            maximum_walk_m: opt.walk_m,
            walking_speed_kph: Some(opt.walk_speed.unwrap_or(self.speed)),
            access_padding_factor: Some(padding),
            access_overhead_seconds: Some(overhead),
            role: role.into(),
            disable_cache: Some(opt.disable_cache),
        })?;
        self.project_candidates(result)
    }
    fn project_candidates(&self, result: EndpointRoleResult) -> Result<Candidates> {
        let t = self.timetable.as_ref().ok_or("Timetable is not active")?;
        let mut stops = vec![];
        let mut seconds = vec![];
        for (i, &member) in result.member_indices.iter().enumerate() {
            if let Some(&s) = self
                .members
                .get(member as usize)
                .and_then(|id| t.index.get(id))
            {
                stops.push(s);
                seconds.push(result.access_seconds[i] as f64);
            }
        }
        Ok(Candidates {
            stops,
            seconds,
            terminal_transfers: false,
            evidence: Some(result),
        })
    }
    fn point_candidates(
        &mut self,
        origin: &Point,
        destination: &Point,
        opt: &Options,
    ) -> Result<(Candidates, Candidates)> {
        if origin.stop.is_some() || destination.stop.is_some() {
            return Ok((
                self.candidates(origin, "origin", opt)?,
                self.candidates(destination, "destination", opt)?,
            ));
        }
        // Both roles are independent and share the native kernel's bounded
        // two-thread executor, just like the Node coordinate entry point.
        let r = self.street.route_endpoints(EndpointRouteInput {
            origin_lon: origin.coordinate[0],
            origin_lat: origin.coordinate[1],
            destination_lon: destination.coordinate[0],
            destination_lat: destination.coordinate[1],
            maximum_walk_m: opt.walk_m,
            walking_speed_kph: Some(opt.walk_speed.unwrap_or(self.speed)),
            access_padding_factor: Some(self.padding),
            access_overhead_seconds: Some(self.overhead),
            disable_cache: Some(opt.disable_cache),
        })?;
        let origin = self.project_candidates(EndpointRoleResult {
            query_token: r.query_token,
            cache_hit: r.origin_cache_hit,
            member_indices: r.origin_member_indices,
            path_member_indices: r.origin_path_member_indices,
            distances_m: r.origin_distances_m,
            access_seconds: r.origin_access_seconds,
            candidate_kinds: r.origin_candidate_kinds,
            link_from_stop_keys: r.origin_link_from_stop_keys,
            link_to_stop_keys: r.origin_link_to_stop_keys,
            link_durations: r.origin_link_durations,
            link_path_distances_m: r.origin_link_path_distances_m,
            link_street_verified: r.origin_link_street_verified,
            query_ns: r.query_ns,
            access_reduction_ns: r.origin_access_reduction_ns,
            snap_ns: r.snap_ns,
            search_ns: r.origin_search_ns,
            settled_nodes: r.origin_settled_nodes,
            relaxed_edges: r.origin_relaxed_edges,
            raw_candidates: r.origin_raw_candidates,
            linked_stations: r.origin_linked_stations,
            cch_accelerated: r.origin_cch_accelerated,
        })?;
        let destination = self.project_candidates(EndpointRoleResult {
            query_token: r.query_token,
            cache_hit: r.destination_cache_hit,
            member_indices: r.destination_member_indices,
            path_member_indices: r.destination_path_member_indices,
            distances_m: r.destination_distances_m,
            access_seconds: r.destination_access_seconds,
            candidate_kinds: r.destination_candidate_kinds,
            link_from_stop_keys: r.destination_link_from_stop_keys,
            link_to_stop_keys: r.destination_link_to_stop_keys,
            link_durations: r.destination_link_durations,
            link_path_distances_m: r.destination_link_path_distances_m,
            link_street_verified: r.destination_link_street_verified,
            query_ns: r.query_ns,
            access_reduction_ns: r.destination_access_reduction_ns,
            snap_ns: r.snap_ns,
            search_ns: r.destination_search_ns,
            settled_nodes: r.destination_settled_nodes,
            relaxed_edges: r.destination_relaxed_edges,
            raw_candidates: r.destination_raw_candidates,
            linked_stations: r.destination_linked_stations,
            cch_accelerated: r.destination_cch_accelerated,
        })?;
        Ok((origin, destination))
    }
    pub(crate) fn matrix_input(
        origins: &[Candidates],
        destinations: &[Candidates],
        opt: &Options,
        journeys: bool,
    ) -> TimetableMatrixQueryInput {
        let pack = |c: &[Candidates]| {
            let mut offsets = vec![0];
            let mut stops = vec![];
            let mut seconds = vec![];
            for p in c {
                stops.extend(&p.stops);
                seconds.extend(&p.seconds);
                offsets.push(stops.len() as u32);
            }
            (offsets, stops, seconds)
        };
        let (origin_offsets, origin_stops, origin_walk_seconds) = pack(origins);
        let (destination_offsets, destination_stops, destination_walk_seconds) = pack(destinations);
        TimetableMatrixQueryInput {
            origin_offsets,
            origin_stops,
            origin_walk_seconds,
            allow_pre_ride_transfers: origins.iter().map(|c| c.terminal_transfers).collect(),
            destination_offsets,
            destination_stops,
            destination_walk_seconds,
            departure: opt.start,
            horizon: opt.end,
            arrive_by: opt.arrive,
            allow_post_ride_transfers: Some(
                destinations.iter().map(|c| c.terminal_transfers).collect(),
            ),
            maximum_boardings: opt.max_boardings,
            include_journeys: Some(journeys),
        }
    }
    fn distinct_points(points: &[Point]) -> (Vec<Point>, Vec<usize>) {
        // Endpoint labels do not affect routing. Stop identity and exact
        // coordinates do: never merge co-located platforms with different IDs.
        let mut seen = std::collections::HashMap::new();
        let mut unique = Vec::new();
        let mut indices = Vec::with_capacity(points.len());
        for point in points {
            let key = (
                point.stop.as_deref(),
                point.coordinate[0].to_bits(),
                point.coordinate[1].to_bits(),
            );
            let index = *seen.entry(key).or_insert_with(|| {
                unique.push(point.clone());
                unique.len() - 1
            });
            indices.push(index);
        }
        (unique, indices)
    }
    pub fn route(&mut self, q: &Value) -> Result<Value> {
        let opt = Options::parse(q)?;
        let origin = self.point(&q["origin"])?;
        let destination = self.point(&q["destination"])?;
        let mode = q["mode"].as_str().unwrap_or("transit");
        if let Some(via) = q.get("via").or_else(|| q.get("waypoints"))
            && !via.as_array().ok_or("via must be an array")?.is_empty()
        {
            return self.route_via(q, via);
        }
        let window = number(q, "windowMinutes", 0., 0., 240.)?;
        if window > 0. {
            return self.route_window(q, window);
        }
        if mode != "transit" {
            return self.street_route(q, &origin, &destination, &opt, mode);
        }
        self.activate(q)?;
        let (a, b) = self.point_candidates(&origin, &destination, &opt)?;
        let input = Self::matrix_input(
            std::slice::from_ref(&a),
            std::slice::from_ref(&b),
            &opt,
            true,
        );
        // Neither direction can board and alight without both frontiers. Keep
        // the optional direct-walk comparison below, but avoid a timetable scan
        // that cannot produce a transit witness.
        let mut result = if a.stops.is_empty() || b.stops.is_empty() {
            TimetableMatrixQueryResult {
                journeys: None,
                times: vec![if opt.arrive {
                    f64::NEG_INFINITY
                } else {
                    f64::INFINITY
                }],
                forward_searches: 0,
                reverse_searches: 0,
                query_ns: 0.,
                scanned_departures: 0.,
                relaxed_stops: 0.,
                expanded_trip_runs: 0.,
                dominated_trip_boardings: 0.,
                explicit_transfer_checks: 0.,
            }
        } else {
            let kernel = &mut self.timetable.as_mut().unwrap().kernel;
            match super::point::route(kernel, &input)? {
                Some(result) => result,
                None => kernel.route_matrix_csa(input)?,
            }
        };
        // Move the witness out before serializing diagnostics: the complete
        // materialized journey already belongs to the high-level response.
        let journey = result
            .journeys
            .take()
            .and_then(|mut rows| rows.pop().flatten());
        let mut output = if let Some(j) = journey.as_ref() {
            let mut j = self.materialize(j, [&origin, &destination], true, &opt, [&a, &b], None)?;
            j["status"] = json!("ready");
            j["mode"] = json!("transit");
            j
        } else {
            json!({"status":"blocked","reason":if a.stops.is_empty() || b.stops.is_empty() {"no_access"}else{"no_path"},"mode":"transit"})
        };
        if !flag(q, "requireTransitRide", true)?
            && (output["status"] == "ready"
                || (origin.stop.is_none() && destination.stop.is_none()))
        {
            let walk = self.street_route(q, &origin, &destination, &opt, "walk")?;
            let wins = walk["status"] == "ready"
                && (output["status"] != "ready"
                    || if opt.arrive {
                        walk["departureMinutes"].as_f64() > output["departureMinutes"].as_f64()
                    } else {
                        walk["arrivalMinutes"].as_f64() < output["arrivalMinutes"].as_f64()
                    });
            if wins {
                output = walk;
            }
        }
        output["diagnostics"] = json!({"search":{"startSeconds":opt.start,"endSeconds":opt.end,"horizonScope":"timetable_scan","maxTransfers":q["maxTransfers"],"allowStreetTransfers":q.get("allowStreetTransfers").unwrap_or(&Value::Bool(true)),"minimumTransferBufferMinutes":q.get("minimumTransferBufferMinutes").unwrap_or(&json!(0))},"native":result});
        output["diagnostics"]["originAccess"] = a.diagnostics(&origin)?;
        output["diagnostics"]["destinationAccess"] = b.diagnostics(&destination)?;
        output["serviceDate"] = q["serviceDate"].clone();
        output["diagnostics"]["realtime"] = self.timetable.as_ref().unwrap().realtime.clone();
        output["warnings"] = self.metadata["routingLimitations"].clone();
        output["dataMode"] = json!(if q.get("realtimeSnapshot").is_some() {
            "realtime"
        } else {
            "scheduled"
        });
        Ok(output)
    }
    fn route_via(&mut self, q: &Value, via: &Value) -> Result<Value> {
        let via = via.as_array().ok_or("via must be an array")?;
        if via.len() > 16 {
            return fail("At most 16 via points are supported");
        }
        if q["mode"].as_str().unwrap_or("transit") == "transit"
            && (q.get("maxTransfers").is_some()
                || number(q, "minimumTransferBufferMinutes", 0., 0., 60.)? > 0.)
        {
            return fail(
                "Transit via points cannot certify a global transfer cap or boundary buffer",
            );
        }
        let opt = Options::parse(q)?;
        let mut points = vec![q["origin"].clone()];
        points.extend(via.iter().cloned());
        points.push(q["destination"].clone());
        let mut pieces = vec![];
        let mut time = opt.time / 60.;
        let indices: Vec<usize> = if opt.arrive {
            (0..points.len() - 1).rev().collect()
        } else {
            (0..points.len() - 1).collect()
        };
        for i in indices {
            let mut request = q.clone();
            let m = request.as_object_mut().unwrap();
            for k in ["via", "waypoints", "time", "windowMinutes"] {
                m.remove(k);
            }
            m.insert("timeMinutes".into(), json!(time));
            m.insert("origin".into(), points[i].clone());
            m.insert("destination".into(), points[i + 1].clone());
            let r = self.route(&request)?;
            if r["status"] != "ready" {
                return Ok(
                    json!({"status":"blocked","reason":"via_leg_blocked","legIndex":i,"leg":r}),
                );
            }
            time = r[if opt.arrive {
                "departureMinutes"
            } else {
                "arrivalMinutes"
            }]
            .as_f64()
            .ok_or("Missing route time")?;
            pieces.push(r);
        }
        if opt.arrive {
            pieces.reverse();
        }
        let departure = pieces[0]["departureMinutes"].as_f64().unwrap();
        let arrival = pieces.last().unwrap()["arrivalMinutes"].as_f64().unwrap();
        Ok(
            json!({"status":"ready","mode":q.get("mode").unwrap_or(&json!("transit")),"departureMinutes":departure,"arrivalMinutes":arrival,"durationMinutes":arrival-departure,"segments":pieces,"via":via}),
        )
    }
    fn route_window(&mut self, q: &Value, window: f64) -> Result<Value> {
        let opt = Options::parse(q)?;
        if opt.arrive {
            return fail("Departure windows require depart_at");
        }
        let step = number(q, "windowStepMinutes", 1., 1., 60.)?;
        let mut choices = vec![];
        let mut signatures = std::collections::HashSet::new();
        let mut minute = 0.;
        while minute <= window {
            let mut request = q.clone();
            request.as_object_mut().unwrap().remove("time");
            request["timeMinutes"] = json!(opt.time / 60. + minute);
            request["windowMinutes"] = json!(0);
            let result = self.route(&request)?;
            if result["status"] == "ready" {
                let signature = serde_json::to_string(&json!([
                    result["legs"].as_array().map(|legs| legs
                        .iter()
                        .map(|l| json!([l["tripId"], l["fromStop"], l["toStop"]]))
                        .collect::<Vec<_>>()),
                    result["arrivalMinutes"]
                ]))?;
                if signatures.insert(signature) {
                    choices.push(result);
                }
            }
            minute += step;
        }
        choices.sort_by(|a, b| {
            a["arrivalMinutes"]
                .as_f64()
                .partial_cmp(&b["arrivalMinutes"].as_f64())
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        choices.truncate(5);
        let mut result = choices
            .first()
            .cloned()
            .unwrap_or(json!({"status":"blocked","reason":"no_path"}));
        result["choices"] = json!(choices);
        result["window"] =
            json!({"minutes":window,"stepMinutes":step,"searches":(window/step).floor() as u32+1});
        Ok(result)
    }
    pub fn matrix(&mut self, q: &Value) -> Result<Value> {
        let opt = Options::parse(q)?;
        let origins = q["origins"]
            .as_array()
            .ok_or("origins must be an array")?
            .iter()
            .map(|p| self.point(p))
            .collect::<Result<Vec<_>>>()?;
        let destinations = q["destinations"]
            .as_array()
            .ok_or("destinations must be an array")?
            .iter()
            .map(|p| self.point(p))
            .collect::<Result<Vec<_>>>()?;
        if origins.is_empty()
            || destinations.is_empty()
            || origins.len().saturating_mul(destinations.len()) > 65_536
        {
            return fail("Matrix must contain 1..65536 pairs");
        }
        let mode = q["mode"].as_str().unwrap_or("transit");
        if mode != "transit" {
            return self.street_matrix(q, &origins, &destinations, &opt, mode);
        }
        self.activate(q)?;
        let (search_origins, origin_indices) = Self::distinct_points(&origins);
        let (search_destinations, destination_indices) = Self::distinct_points(&destinations);
        let search_width = search_destinations.len();
        let cells = (search_origins.len() != origins.len()
            || search_destinations.len() != destinations.len())
        .then(|| {
            origin_indices
                .iter()
                .flat_map(|&a| {
                    destination_indices
                        .iter()
                        .map(move |&b| a * search_width + b)
                })
                .collect::<Vec<_>>()
        });
        let a = search_origins
            .iter()
            .map(|p| self.candidates(p, "origin", &opt))
            .collect::<Result<Vec<_>>>()?;
        let b = search_destinations
            .iter()
            .map(|p| self.candidates(p, "destination", &opt))
            .collect::<Result<Vec<_>>>()?;
        let include = flag(q, "includeJourneys", false)?;
        let mut result = self
            .timetable
            .as_mut()
            .unwrap()
            .kernel
            .route_matrix_csa(Self::matrix_input(&a, &b, &opt, include))?;
        if let Some(cells) = &cells {
            result.times = cells.iter().map(|&i| result.times[i]).collect();
        }
        let mut durations: Vec<f64> = result
            .times
            .iter()
            .map(|t| {
                if opt.arrive {
                    (opt.time - t) / 60.
                } else {
                    (t - opt.time) / 60.
                }
            })
            .collect();
        let include_geometry = flag(q, "includeGeometry", false)?;
        let compact = q["journeyFormat"] == "compact";
        let mut materialization = super::materialize::MatrixMaterializationCache::default();
        let mut journeys = result
            .journeys
            .take()
            .map(|rows| {
                rows.into_iter()
                    .enumerate()
                    .map(|(i, j)| {
                        j.as_ref().map_or(Ok(Value::Null), |j| {
                            if compact {
                                return self.compact_journey(j);
                            }
                            self.materialize(
                                j,
                                [
                                    &search_origins[i / search_destinations.len()],
                                    &search_destinations[i % search_destinations.len()],
                                ],
                                include_geometry,
                                &opt,
                                [
                                    &a[i / search_destinations.len()],
                                    &b[i % search_destinations.len()],
                                ],
                                Some(&mut materialization),
                            )
                        })
                    })
                    .collect::<Result<Vec<_>>>()
            })
            .transpose()?;
        if let (Some(cells), Some(rows)) = (&cells, &mut journeys) {
            let mut uses = vec![0usize; rows.len()];
            for &i in cells {
                uses[i] += 1;
            }
            *rows = cells
                .iter()
                .map(|&i| {
                    uses[i] -= 1;
                    if uses[i] == 0 {
                        std::mem::take(&mut rows[i])
                    } else {
                        rows[i].clone()
                    }
                })
                .collect();
        }
        if !flag(q, "requireTransitRide", true)? {
            let walk = self.street.route_street_matrix(StreetMatrixInput {
                origin_coordinates: origins.iter().flat_map(|p| p.coordinate).collect(),
                destination_coordinates: destinations.iter().flat_map(|p| p.coordinate).collect(),
                maximum_distance_m: self.direct_walk_limit(q, &opt)?,
                disable_cache: Some(opt.disable_cache),
            })?;
            for (i, &distance) in walk.distances_m.iter().enumerate() {
                let minutes = distance / self.speed * 3.6 / 60.;
                let exact = origins[i / destinations.len()].stop.is_some()
                    || destinations[i % destinations.len()].stop.is_some();
                if !(exact && !durations[i].is_finite())
                    && minutes < durations[i]
                    && minutes <= (opt.end - opt.start) / 60.
                {
                    durations[i] = minutes;
                    if let Some(ref mut journeys) = journeys {
                        let departure = if opt.arrive {
                            opt.time / 60. - minutes
                        } else {
                            opt.time / 60.
                        };
                        journeys[i] = json!({"mode":"walk","departureMinutes":departure,"arrivalMinutes":departure+minutes,"durationMinutes":minutes,"distanceMeters":distance,"transfers":0});
                    }
                }
            }
        }
        let mut output = json!({"kind":"matrix","mode":mode,"originCount":origins.len(),"destinationCount":destinations.len(),"durationsMinutes":durations.chunks(destinations.len()).collect::<Vec<_>>(),"diagnostics":result,"warnings":self.metadata["routingLimitations"]});
        // Moving Values into rows avoids cloning every leg twice (once for
        // chunking and once through json!'s borrowed serializer).
        output["journeys"] = journeys.map_or(Value::Null, |journeys| {
            let mut values = journeys.into_iter();
            Value::Array(
                (0..origins.len())
                    .map(|_| Value::Array(values.by_ref().take(destinations.len()).collect()))
                    .collect(),
            )
        });
        Ok(output)
    }
    fn street_route(
        &mut self,
        q: &Value,
        origin: &Point,
        destination: &Point,
        opt: &Options,
        mode: &str,
    ) -> Result<Value> {
        let (seconds, distance, coordinates, diagnostics) = match mode {
            "walk" => {
                let speed = opt.walk_speed.unwrap_or(self.speed);
                let limit = self.direct_walk_limit(q, opt)?;
                let r = self.street.route_path(StreetPathInput {
                    origin_lon: origin.coordinate[0],
                    origin_lat: origin.coordinate[1],
                    destination_lon: destination.coordinate[0],
                    destination_lat: destination.coordinate[1],
                    maximum_distance_m: limit,
                    maximum_points: 512,
                })?;
                if !r.found {
                    return Ok(json!({"status":"blocked","reason":"no_path","mode":mode}));
                }
                (
                    r.distance_m / speed * 3.6,
                    r.distance_m,
                    r.coordinates
                        .chunks_exact(2)
                        .map(|p| [p[0], p[1]])
                        .collect::<Vec<_>>(),
                    serde_json::to_value(&r)?,
                )
            }
            "drive" => {
                self.load_drive()?;
                let d = self.drive.as_mut().unwrap();
                let (origin_nodes, origin_snap_meters) = d.snap(origin.coordinate)?;
                let (target_nodes, target_snap_meters) = d.snap(destination.coordinate)?;
                let traffic = d.traffic(q.get("traffic"))?;
                let r = d.kernel.route_exact(DriveQueryInput {
                    origin_nodes,
                    origin_snap_meters,
                    target_nodes,
                    target_snap_meters,
                    maximum_distance_meters: opt.street_m,
                    traffic,
                })?;
                if r.status != "ready" {
                    return Ok(
                        json!({"status":"blocked","reason":r.reason,"mode":mode,"diagnostics":r}),
                    );
                }
                (
                    r.duration_seconds.ok_or("Missing drive duration")?,
                    r.distance_meters.ok_or("Missing drive distance")?,
                    r.node_indices
                        .iter()
                        .map(|&i| [d.lons[i as usize], d.lats[i as usize]])
                        .collect(),
                    serde_json::to_value(r)?,
                )
            }
            _ => return fail("mode must be transit, walk, or drive"),
        };
        let (departure, arrival) = if opt.arrive {
            (opt.time - seconds, opt.time)
        } else {
            (opt.time, opt.time + seconds)
        };
        if departure < 0. {
            return Ok(json!({"status":"blocked","reason":"before_service_day","mode":mode}));
        }
        Ok(
            json!({"status":"ready","mode":mode,"departureMinutes":departure/60.,"arrivalMinutes":arrival/60.,"durationMinutes":seconds/60.,"distanceMeters":distance,"transfers":0,"legs":[{"kind":mode,"departureMinutes":departure/60.,"arrivalMinutes":arrival/60.,"durationMinutes":seconds/60.,"distanceMeters":distance,"coordinates":coordinates}],"diagnostics":diagnostics}),
        )
    }
    fn street_matrix(
        &mut self,
        q: &Value,
        origins: &[Point],
        destinations: &[Point],
        opt: &Options,
        mode: &str,
    ) -> Result<Value> {
        let (distances, durations, diagnostics) = match mode {
            "walk" => {
                let speed = opt.walk_speed.unwrap_or(self.speed);
                let r = self.street.route_street_matrix(StreetMatrixInput {
                    origin_coordinates: origins.iter().flat_map(|p| p.coordinate).collect(),
                    destination_coordinates: destinations
                        .iter()
                        .flat_map(|p| p.coordinate)
                        .collect(),
                    maximum_distance_m: self.direct_walk_limit(q, opt)?,
                    disable_cache: Some(opt.disable_cache),
                })?;
                (
                    r.distances_m.clone(),
                    r.distances_m
                        .iter()
                        .map(|d| d / speed * 3.6 / 60.)
                        .collect::<Vec<_>>(),
                    serde_json::to_value(r)?,
                )
            }
            "drive" => {
                self.load_drive()?;
                let d = self.drive.as_mut().unwrap();
                let a = d.pack(origins)?;
                let b = d.pack(destinations)?;
                let traffic = d.traffic(q.get("traffic"))?;
                let r = d.kernel.route_matrix(DriveMatrixInput {
                    origin_offsets: a.0,
                    origin_nodes: a.1,
                    origin_snap_meters: a.2,
                    target_offsets: b.0,
                    target_nodes: b.1,
                    target_snap_meters: b.2,
                    maximum_distance_meters: opt.street_m,
                    traffic,
                })?;
                (
                    r.distances_m.clone(),
                    r.durations_s.iter().map(|v| v / 60.).collect(),
                    serde_json::to_value(r)?,
                )
            }
            _ => return fail("mode must be transit, walk, or drive"),
        };
        Ok(
            json!({"kind":"matrix","mode":mode,"originCount":origins.len(),"destinationCount":destinations.len(),"durationsMinutes":durations.chunks(destinations.len()).collect::<Vec<_>>(),"distancesMeters":distances.chunks(destinations.len()).collect::<Vec<_>>(),"diagnostics":diagnostics}),
        )
    }
    fn native(&mut self, q: &Value) -> Result<Value> {
        let mut input = q["input"].clone();
        macro_rules! call {
            ($kernel:expr,$method:ident) => {
                serde_json::to_value($kernel.$method(serde_json::from_value(input)?)?)?
            };
        }
        let operation = q["operation"].as_str().ok_or("native requires operation")?;
        if ["drive.route", "drive.matrix"].contains(&operation)
            && input.get("traffic").is_some_and(|v| !v.is_null())
        {
            if !input["traffic"].is_object() {
                return fail("Native drive traffic must be an object");
            }
            input["traffic"]["snapshotKey"] = json!(traffic_identity(&input["traffic"])?);
        }
        let result = match operation {
            "street.path" => call!(self.street, route_path),
            "street.matrix" => call!(self.street, route_street_matrix),
            "street.surface" => call!(self.street, street_surface),
            "street.connectors" => call!(self.street, timed_connectors),
            "access.endpoint" => call!(self.street, route_endpoint),
            "access.endpoints" => call!(self.street, route_endpoints),
            "drive.route" | "drive.matrix" => {
                self.load_drive()?;
                let k = &mut self.drive.as_mut().unwrap().kernel;
                if operation == "drive.route" {
                    call!(k, route_exact)
                } else {
                    call!(k, route_matrix)
                }
            }
            "realtime.compile" => {
                serde_json::to_value(compile_realtime_timetable(serde_json::from_value(input)?)?)?
            }
            _ => {
                self.activate(q)?;
                let t = self.timetable.as_mut().unwrap();
                match operation {
                    "timetable.identifiers" => {
                        json!({"stopIds":t.stop_ids,"tripIds":t.trip_ids,"routeIds":t.route_ids,"accessMemberStopIds":self.members})
                    }
                    "timetable.route" => call!(t.kernel, route_scalar_csa),
                    "timetable.arrive_by" => call!(t.kernel, route_arrive_by_csa),
                    "timetable.matrix" => call!(t.kernel, route_matrix_csa),
                    "timetable.many" => call!(t.kernel, route_many_csa),
                    "timetable.arrive_by_many" => call!(t.kernel, route_arrive_by_many_csa),
                    "timetable.pareto" => call!(t.kernel, route_pareto_round_csa),
                    "timetable.overlay" => call!(t.kernel, route_overlay_many_csa),
                    _ => return fail("Unknown native operation"),
                }
            }
        };
        Ok(json!({"operation":operation,"result":result}))
    }
}

impl super::city::Drive {
    fn nearby(&self, p: [f64; 2], radius: f64) -> Result<Vec<(u32, f64)>> {
        let h = &self.image.header;
        let cell = h["spatialCellDegrees"]
            .as_f64()
            .ok_or("Invalid drive cell size")?;
        let rows = h["spatialRows"].as_u64().ok_or("Invalid drive grid")? as i64;
        let columns = h["spatialColumns"].as_u64().ok_or("Invalid drive grid")? as i64;
        let x = ((p[0] - h["spatialMinLon"].as_f64().ok_or("Invalid drive bounds")?) / cell).floor()
            as i64;
        let y = ((p[1] - h["spatialMinLat"].as_f64().ok_or("Invalid drive bounds")?) / cell).floor()
            as i64;
        let mut candidates = vec![];
        let dy = (radius / 111_000. / cell).ceil() as i64 + 1;
        let dx = (radius / (111_000. * p[1].to_radians().cos().abs().max(0.01)) / cell).ceil()
            as i64
            + 1;
        for r in (y - dy).max(0)..=(y + dy).min(rows - 1) {
            for c in (x - dx).max(0)..=(x + dx).min(columns - 1) {
                let i = (r * columns + c) as usize;
                let start = *self
                    .spatial_offsets
                    .get(i)
                    .ok_or("Invalid drive spatial index")?;
                let end = *self
                    .spatial_offsets
                    .get(i + 1)
                    .ok_or("Invalid drive spatial index")?;
                for &node in self
                    .spatial_nodes
                    .get(start as usize..end as usize)
                    .ok_or("Invalid drive spatial offsets")?
                {
                    let n = node as usize;
                    let distance = haversine(
                        p,
                        [*self.lons.get(n).ok_or("Invalid drive node")?, self.lats[n]],
                    );
                    if distance <= radius {
                        candidates.push((node, distance));
                    }
                }
            }
        }
        candidates.sort_by(|a, b| a.1.total_cmp(&b.1).then(a.0.cmp(&b.0)));
        Ok(candidates)
    }
    fn snap(&self, p: [f64; 2]) -> Result<(Vec<u32>, Vec<f64>)> {
        let mut candidates = vec![];
        for radius in [60., 120., 350.] {
            candidates = self.nearby(p, radius)?;
            if !candidates.is_empty() {
                break;
            }
        }
        if candidates.first().is_none_or(|c| c.1 > 25.) {
            for radius in [350., 1000., 3000., 5000.] {
                candidates = self.nearby(p, radius)?;
                if candidates.len() >= 48 {
                    break;
                }
            }
            candidates.truncate(48);
        } else {
            candidates.truncate(6);
        }
        Ok(candidates.into_iter().unzip())
    }
    fn pack(&self, points: &[Point]) -> Result<(Vec<u32>, Vec<u32>, Vec<f64>)> {
        let mut offsets = vec![0];
        let mut nodes = vec![];
        let mut meters = vec![];
        for p in points {
            let (n, m) = self.snap(p.coordinate)?;
            nodes.extend(n);
            meters.extend(m);
            offsets.push(nodes.len() as u32);
        }
        Ok((offsets, nodes, meters))
    }
    fn traffic(&self, value: Option<&Value>) -> Result<Option<DriveTrafficInput>> {
        let Some(value) = value else { return Ok(None) };
        if value.get("edgeTimeUnits").is_some() {
            if value["streetSourceFingerprint"]
                != self.image.header["identity"]["sourceFingerprint"]
            {
                return fail("traffic edge indices require the current streetSourceFingerprint");
            }
            let mut input: DriveTrafficInput = serde_json::from_value(value.clone())?;
            if input.edge_indices.len() > 200_000 {
                return fail("Too many traffic updates");
            }
            input.snapshot_key = traffic_identity(value)?;
            return Ok(Some(input));
        }
        let observations = value
            .get("observations")
            .or_else(|| value.get("segments"))
            .or_else(|| value.get("edgeUpdates"))
            .and_then(Value::as_array)
            .ok_or("traffic requires observations or native edgeTimeUnits")?;
        if observations.is_empty() || observations.len() > 100_000 {
            return fail("traffic requires 1..100000 observations");
        }
        let observed = epoch(
            value
                .get("observedAt")
                .or_else(|| value.get("fetchedAt"))
                .or_else(|| value.get("timestamp"))
                .ok_or("traffic requires observedAt")?,
        )?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_secs_f64();
        let ttl = number(value, "ttlSeconds", 300., 1., 1800.)?;
        let expires = value
            .get("expiresAt")
            .map(epoch)
            .transpose()?
            .unwrap_or(observed + ttl);
        if observed > now + 60.
            || expires <= observed
            || expires - observed > 1800.
            || expires <= now
        {
            return fail("Traffic snapshot is expired or its timestamps are invalid");
        }
        let radius = number(value, "snapRadiusMeters", 120., 1., 1000.)?;
        let offsets = self.image.u32("edgeOffsets")?;
        let targets = self.image.u32("edgeTargets")?;
        let times = self.image.u32("edgeTimeUnits")?;
        let distances = self.image.u32("edgeDistanceUnits")?;
        let mut updated = std::collections::BTreeMap::<u32, u32>::new();
        for observation in observations {
            let mut edges = if let Some(indices) = observation.get("edgeIndices") {
                indices
                    .as_array()
                    .ok_or("edgeIndices must be an array")?
                    .iter()
                    .map(|v| {
                        v.as_u64()
                            .filter(|&i| i < times.len() as u64)
                            .map(|i| i as u32)
                            .ok_or_else(|| "Invalid traffic edge index".into())
                    })
                    .collect::<Result<Vec<_>>>()?
            } else if let Some(index) = observation.get("edgeIndex") {
                vec![
                    index
                        .as_u64()
                        .filter(|&i| i < times.len() as u64)
                        .ok_or("Invalid traffic edgeIndex")? as u32,
                ]
            } else {
                vec![]
            };
            if edges.len() > 4096 {
                return fail("An observation may reference at most 4096 edges");
            }
            if !edges.is_empty()
                && value["streetSourceFingerprint"]
                    != self.image.header["identity"]["sourceFingerprint"]
            {
                return fail("Traffic edge indices require the current streetSourceFingerprint");
            }
            let coordinates = if let Some(c) = observation.get("coordinates") {
                c.as_array()
                    .ok_or("traffic coordinates must be an array")?
                    .iter()
                    .map(coordinate_value)
                    .collect::<Result<Vec<_>>>()?
            } else if observation.get("fromCoordinate").is_some() {
                vec![
                    coordinate_value(&observation["fromCoordinate"])?,
                    coordinate_value(&observation["toCoordinate"])?,
                ]
            } else {
                vec![]
            };
            if coordinates.len() > 512 {
                return fail("Traffic geometry exceeds 512 points");
            }
            for pair in coordinates.windows(2) {
                let mut best: Option<(u32, f64)> = None;
                for (node, snap) in self.nearby(pair[0], radius)?.into_iter().take(16) {
                    for edge in offsets[node as usize]..offsets[node as usize + 1] {
                        let target = targets[edge as usize] as usize;
                        let distance = haversine(pair[1], [self.lons[target], self.lats[target]]);
                        if distance <= radius
                            && best.is_none_or(|b| {
                                snap + distance < b.1 || (snap + distance == b.1 && edge < b.0)
                            })
                        {
                            best = Some((edge, snap + distance));
                        }
                    }
                }
                if let Some((edge, _)) = best {
                    edges.push(edge);
                }
            }
            if edges.is_empty() && coordinates.len() < 2 {
                return fail(
                    "Traffic observation requires directed edges or at least two coordinates",
                );
            }
            let closed = flag(observation, "closed", false)?;
            let explicit = observation.get("travelTimeSeconds");
            let speed = observation.get("speedKph");
            let factor = observation
                .get("delayFactor")
                .or_else(|| observation.get("factor"))
                .or_else(|| observation.get("multiplier"));
            if usize::from(closed)
                + usize::from(explicit.is_some())
                + usize::from(speed.is_some())
                + usize::from(factor.is_some())
                != 1
            {
                return fail(
                    "Each traffic observation needs exactly one of closed, travelTimeSeconds, speedKph, delayFactor",
                );
            }
            let metric = if closed {
                None
            } else if explicit.is_some() {
                Some((
                    0,
                    number(observation, "travelTimeSeconds", 0., 0.01, 86400.)?,
                ))
            } else if speed.is_some() {
                Some((1, number(observation, "speedKph", 0., 1., 200.)?))
            } else {
                Some((
                    2,
                    factor
                        .and_then(Value::as_f64)
                        .filter(|n| n.is_finite() && (1. ..=100.).contains(n))
                        .ok_or("delayFactor must be 1..100")?,
                ))
            };
            for edge in edges {
                let i = edge as usize;
                let weight = match metric {
                    None => 0x7fff_ffff,
                    Some((kind, n)) => {
                        let seconds = match kind {
                            0 => n,
                            1 => distances[i] as f64 / 100. / (n / 3.6),
                            _ => times[i] as f64 / 100. * n,
                        };
                        let units = (seconds * 100.).round();
                        if units >= 0x7fff_ffffu32 as f64 {
                            return fail("Traffic weight exceeds native domain");
                        }
                        (units as u32).max(times[i])
                    }
                };
                updated
                    .entry(edge)
                    .and_modify(|w| *w = (*w).max(weight))
                    .or_insert(weight);
                if updated.len() > 200_000 {
                    return fail("Traffic snapshot exceeds 200000 edge updates");
                }
            }
        }
        use sha2::{Digest, Sha256};
        let snapshot_key = format!("{:x}", Sha256::digest(serde_json::to_vec(value)?));
        let (edge_indices, edge_time_units) = updated.into_iter().unzip();
        Ok(Some(DriveTrafficInput {
            snapshot_key,
            edge_indices,
            edge_time_units,
        }))
    }
}
fn traffic_identity(value: &Value) -> Result<String> {
    use sha2::{Digest, Sha256};
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&json!([
            value["edgeIndices"],
            value["edgeTimeUnits"]
        ]))?)
    ))
}
pub(crate) fn haversine(a: [f64; 2], b: [f64; 2]) -> f64 {
    let v = ((b[1] - a[1]).to_radians() / 2.).sin().powi(2)
        + a[1].to_radians().cos()
            * b[1].to_radians().cos()
            * ((b[0] - a[0]).to_radians() / 2.).sin().powi(2);
    6371008.8 * 2. * v.sqrt().atan2((1. - v).max(0.).sqrt())
}
fn coordinate_value(v: &Value) -> Result<[f64; 2]> {
    let a = v
        .as_array()
        .filter(|a| a.len() == 2)
        .ok_or("Coordinate must have two numbers")?;
    let x = a[0]
        .as_f64()
        .filter(|n| n.abs() <= 180.)
        .ok_or("Invalid longitude")?;
    let y = a[1]
        .as_f64()
        .filter(|n| n.abs() <= 90.)
        .ok_or("Invalid latitude")?;
    Ok([x, y])
}
fn epoch(v: &Value) -> Result<f64> {
    if let Some(n) = v.as_f64() {
        return Ok(if n >= 1e12 { n / 1000. } else { n });
    }
    Ok(chrono::DateTime::parse_from_rfc3339(
        v.as_str().ok_or("Timestamp must be RFC3339 or Unix time")?,
    )?
    .timestamp_millis() as f64
        / 1000.)
}
// Reserve time at the final destination without modifying vehicle events or
// moving the query's earliest departure. This is deliberately not a calibrated
// probability model. Matrix durations retain deadline minus departure.
fn arrival_reserve(command: &str, q: &Value) -> Result<Option<(Value, Value)>> {
    let Some(value) = q.get("arrivalBufferMinutes") else {
        return Ok(None);
    };
    let minutes = value
        .as_u64()
        .filter(|&n| n <= 60)
        .ok_or("arrivalBufferMinutes must be an integer from 0 to 60")?;
    if minutes == 0 {
        return Ok(None);
    }
    if !["route", "matrix"].contains(&command)
        || q["mode"].as_str().unwrap_or("transit") != "transit"
        || !matches!(q["timePreference"].as_str(), Some("arrive" | "arrive_by"))
    {
        return fail("arrivalBufferMinutes requires an arrive-by Transit Route or Matrix");
    }
    if ["via", "waypoints"].iter().any(|key| {
        q.get(key)
            .is_some_and(|v| v.as_array().is_none_or(|v| !v.is_empty()))
    }) {
        return fail("arrivalBufferMinutes with transit waypoints is not supported");
    }
    let opt = Options::parse(q)?;
    let seconds = minutes as f64 * 60.;
    let horizon = number(q, "horizonMinutes", 480., 1., 2880.)?;
    if opt.time < seconds {
        return fail("The arrival deadline must be at least arrivalBufferMinutes");
    }
    if horizon - (minutes as f64) < 1. {
        return fail("horizonMinutes must exceed arrivalBufferMinutes by at least one minute");
    }
    let mut effective = q.clone();
    if q["time"].is_string() {
        // Keep an integral-second clock exact. Converting 08:32:03 through
        // floating-point minutes can turn its deadline into 30722.999999999996
        // and incorrectly exclude a vehicle arriving at that very second.
        let target = (opt.time - seconds) as u32;
        effective["time"] = json!(format!(
            "{}:{:02}:{:02}",
            target / 3600,
            target / 60 % 60,
            target % 60
        ));
    } else {
        effective.as_object_mut().unwrap().remove("time");
        let time = q.get("timeMinutes").unwrap_or(&q["time"]).as_f64().unwrap();
        effective["timeMinutes"] = json!(time - minutes as f64);
    }
    effective["horizonMinutes"] = json!(horizon - minutes as f64);
    effective["arrivalBufferMinutes"] = json!(0);
    let diagnostics = json!({"method":"explicit_time_reserves","calibratedProbability":false,
        "arrivalBufferMinutes":minutes,"minimumTransferBufferMinutes":q.get("minimumTransferBufferMinutes").unwrap_or(&json!(0)),
        "requestedArrivalMinutes":opt.time/60.,"planningArrivalMinutes":(opt.time-seconds)/60.});
    Ok(Some((effective, diagnostics)))
}

fn validate_request(command: &str, q: &Value) -> Result<()> {
    let common = [
        "kind",
        "id",
        "serviceDate",
        "serviceDay",
        "time",
        "timeMinutes",
        "timePreference",
        "mode",
        "maxWalkKm",
        "maxStreetKm",
        "maxTransfers",
        "horizonMinutes",
        "allowStreetTransfers",
        "minimumTransferBufferMinutes",
        "arrivalBufferMinutes",
        "disableCache",
        "requireTransitRide",
        "allowLongWalk",
        "walkSpeedKph",
        "routingDataMode",
        "dataMode",
        "realtimeSnapshot",
        "traffic",
        "requireCompleteServiceCoverage",
    ];
    let specific: &[&str] = match command {
        "route" => &[
            "origin",
            "destination",
            "via",
            "waypoints",
            "windowMinutes",
            "windowStepMinutes",
        ],
        "matrix" => &[
            "origins",
            "destinations",
            "includeJourneys",
            "includeGeometry",
            "journeyFormat",
        ],
        "reach" | "isochrone" => &[
            "origin",
            "cutoffsMinutes",
            "rasterSize",
            "extentRadiusKm",
            "bounds",
            "walkSpeedKph",
            "includeStreetEdges",
            "includeNodes",
            "scenario",
        ],
        "native" => &["operation", "input"],
        "compare" => &["before", "after"],
        _ => &[],
    };
    for key in q.as_object().unwrap().keys() {
        if !common.contains(&key.as_str()) && !specific.contains(&key.as_str()) {
            return fail(format!("Unknown {command} option: {key}"));
        }
    }
    for (left, right) in [
        ("time", "timeMinutes"),
        ("via", "waypoints"),
        ("dataMode", "routingDataMode"),
    ] {
        if q.get(left).is_some() && q.get(right).is_some() {
            return fail(format!("Supply {left} or {right}, not both"));
        }
    }
    for key in ["mode", "timePreference", "serviceDate", "serviceDay"] {
        if q.get(key).is_some_and(|v| !v.is_string()) {
            return fail(format!("{key} must be a string"));
        }
    }
    if q.get("mode")
        .is_some_and(|v| !["transit", "walk", "drive"].iter().any(|m| v == *m))
    {
        return fail("mode must be transit, walk, or drive");
    }
    if q.get("timePreference").is_some_and(|v| {
        !["depart_at", "arrive_by", "depart", "arrive"]
            .iter()
            .any(|m| v == *m)
    }) {
        return fail("timePreference must be depart_at or arrive_by");
    }
    if !["route", "matrix", "reach", "isochrone", "native"].contains(&command) {
        for key in q.as_object().unwrap().keys() {
            if !["kind", "id"].contains(&key.as_str()) && !specific.contains(&key.as_str()) {
                return fail(format!("{key} does not apply to {command}"));
            }
        }
    }
    for name in [
        "allowStreetTransfers",
        "disableCache",
        "requireTransitRide",
        "allowLongWalk",
        "requireCompleteServiceCoverage",
    ] {
        flag(q, name, true)?;
    }
    let mode = q["mode"].as_str().unwrap_or("transit");
    if command == "matrix" {
        let journeys = flag(q, "includeJourneys", false)?;
        let geometry = flag(q, "includeGeometry", false)?;
        if journeys && mode != "transit" {
            return fail("Matrix journeys require transit mode");
        }
        if geometry && !journeys {
            return fail("includeGeometry requires includeJourneys");
        }
        if let Some(format) = q.get("journeyFormat") {
            if format != "full" && format != "compact" {
                return fail("journeyFormat must be full or compact");
            }
            if !journeys || mode != "transit" {
                return fail("journeyFormat requires transit includeJourneys");
            }
            if geometry && format == "compact" {
                return fail("Compact journeys do not include geometry; use journeyFormat full");
            }
        }
    }
    if mode != "walk"
        && !["reach", "isochrone"].contains(&command)
        && q.get("walkSpeedKph").is_some()
    {
        return fail("walkSpeedKph applies to Walk Route/Matrix and Reach");
    }
    if ["reach", "isochrone"].contains(&command) {
        for key in [
            "horizonMinutes",
            "maxStreetKm",
            "requireTransitRide",
            "allowLongWalk",
        ] {
            if q.get(key).is_some() {
                return fail(format!("{key} does not apply to Reach"));
            }
        }
    }
    if q.get("realtimeSnapshot").is_some() && (command != "route" || mode != "transit") {
        return fail("Realtime transit snapshots are supported by Transit Route");
    }
    if q.get("traffic").is_some() && (mode != "drive" || !["route", "matrix"].contains(&command)) {
        return fail("Traffic is supported by Drive Route and Drive Matrix");
    }
    let data_mode = q.get("routingDataMode").or_else(|| q.get("dataMode"));
    if let Some(value) = data_mode {
        if value != "scheduled" && value != "realtime" {
            return fail("dataMode must be scheduled or realtime");
        }
        if value == "scheduled"
            && (q.get("realtimeSnapshot").is_some() || q.get("traffic").is_some())
        {
            return fail("Scheduled mode cannot apply realtime or traffic input");
        }
        if value == "realtime" && q.get("realtimeSnapshot").is_none() && q.get("traffic").is_none()
        {
            return fail("Realtime mode requires a supplied snapshot");
        }
    }
    Ok(())
}

#[cfg(test)]
mod reserve_tests {
    use super::*;

    #[test]
    fn arrival_reserves_preserve_second_precision_and_original_start() {
        for clock in ["08:37:03", "08:37:01", "24:37:59", "71:59:59"] {
            let q = json!({"time":clock,"timePreference":"arrive_by","horizonMinutes":120,"arrivalBufferMinutes":5});
            let before = Options::parse(&q).unwrap();
            let (effective, _) = arrival_reserve("route", &q).unwrap().unwrap();
            let after = Options::parse(&effective).unwrap();
            assert_eq!(after.end, before.end - 300.);
            assert_eq!(after.start, before.start);
        }
    }
}
