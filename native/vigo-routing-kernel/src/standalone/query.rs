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
    fn diagnostics(&self, point: &Point, full: bool) -> Result<Value> {
        let Some(evidence) = &self.evidence else {
            return Ok(json!({"stopId":point.stop,"exactStopAccess":true}));
        };
        if full {
            return Ok(serde_json::to_value(evidence)?);
        }
        // What public summaries and profiles read: candidates and timings.
        Ok(json!({"memberIndices":evidence.member_indices,"cacheHit":evidence.cache_hit,
            "cchAccelerated":evidence.cch_accelerated,"queryNs":evidence.query_ns,
            "accessReductionNs":evidence.access_reduction_ns,"snapNs":evidence.snap_ns,
            "searchNs":evidence.search_ns}))
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
        // A validated arrival request may be rebased onto an earlier service
        // date. The largest supported horizon, reserve and window fit here.
        Self::parse_limited(q, 5759.)
    }
    fn parse_limited(q: &Value, maximum_minutes: f64) -> Result<Self> {
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
            if f64::from(hour) > (maximum_minutes / 60.).floor() || minute > 59 || second > 59 {
                return fail("Invalid time");
            }
            f64::from(hour * 3600 + minute * 60 + second)
        } else if q.get("timeMinutes").is_some() {
            number(q, "timeMinutes", 0., 0., maximum_minutes)? * 60.
        } else if q["time"].is_number() {
            number(q, "time", 0., 0., maximum_minutes)? * 60.
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
        self.execute_output(command, request, false)
    }
    pub fn execute_detailed(&mut self, command: &str, request: &Value) -> Result<Value> {
        self.execute_output(command, request, true)
    }
    fn execute_output(&mut self, command: &str, request: &Value, detailed: bool) -> Result<Value> {
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
        // A reverse search can start on the preceding civil date. Use a
        // nonnegative internal clock, and expose its date alongside the times.
        if matches!(command, "route" | "matrix" | "reach" | "isochrone") {
            Options::parse_limited(&query, 4319.)?;
        }
        let clock_date = if matches!(command, "route" | "matrix") {
            self.shift_early_arrival(&mut query)?
        } else {
            None
        };
        let previous_preparations = self.timetable_preparations;
        let previous_evictions = self.timetable_cache.evictions;
        // Realtime updates without a startDate still describe the requested
        // date when the search clock starts on the preceding one.
        self.query_start_date = clock_date
            .as_ref()
            .and(request["serviceDate"].as_str())
            .map(str::to_owned);
        self.full_access_evidence = detailed || request["diagnostics"] == "trace";
        let execution = self.execute(command, &query);
        self.query_start_date = None;
        self.full_access_evidence = false;
        let release_memory = previous_preparations != self.timetable_preparations
            || previous_evictions != self.timetable_cache.evictions
            || matches!(command, "reach" | "isochrone" | "matrix");
        let mut raw = match execution {
            Ok(raw) => raw,
            Err(error) => {
                if release_memory {
                    super::release_preparation_memory();
                }
                return Err(error);
            }
        };
        if matches!(command, "route" | "matrix" | "reach" | "isochrone")
            && matches!(request["diagnostics"].as_str(), Some("profile" | "trace"))
        {
            raw["timing"]["timetableActivationMs"] = json!(self.timetable_activation_ms);
            if !self.timetable_preparation_profile.is_null() {
                raw["timing"]["timetablePreparation"] = self.timetable_preparation_profile.clone();
            }
        }
        if let Some(date) = clock_date {
            raw["clockDate"] = json!(date);
        }
        if request["includeLimitations"] == true {
            raw["warnings"] = self.metadata["routingLimitations"].clone();
        }
        if detailed {
            let mut result = json!({"schema":"vigo.stream.detail.v1","status":"ok"});
            result["trace"] = raw;
            super::memory::record_output(command, &Value::Null, &result);
            if release_memory {
                super::release_preparation_memory();
            }
            return Ok(result);
        }
        // The trace is an owned result, not a second tree to retain beside
        // it. Project its public fields first, then move the raw tree once.
        let trace = request["diagnostics"] == "trace"
            && matches!(command, "route" | "matrix" | "reach" | "isochrone");
        let mut projection_request;
        let projection = if trace {
            projection_request = request.clone();
            projection_request["diagnostics"] = json!("profile");
            &projection_request
        } else {
            request
        };
        let (mut result, retained) = if trace {
            (
                crate::presentation::format(command, projection, &raw),
                Some(raw),
            )
        } else {
            // Move the raw tree's geometry into the public result; account for
            // both trees as they existed at formatting time.
            let raw_bytes =
                super::memory::output_accounting().then(|| super::memory::Heap::heap_bytes(&raw));
            let result = crate::presentation::format_owned(command, projection, raw);
            if let Some(raw_bytes) = raw_bytes {
                super::memory::record_output_bytes(command, raw_bytes, &result);
            }
            (result, None)
        };
        if !self.metadata["accessibility"].is_null() {
            result["accessibility"] = self.metadata["accessibility"].clone();
        }
        if let Some(raw) = retained {
            result["trace"] = raw;
            super::memory::record_output(command, &Value::Null, &result);
        }
        if release_memory {
            super::release_preparation_memory();
        }
        Ok(result)
    }
    fn shift_early_arrival(&self, query: &mut Value) -> Result<Option<String>> {
        use chrono::NaiveDate;
        let opt = Options::parse(query)?;
        if !opt.arrive {
            return Ok(None);
        }
        let horizon = number(query, "horizonMinutes", 480., 1., 2880.)? * 60.;
        let reserve = number(query, "arrivalBufferMinutes", 0., 0., 120.)? * 60.;
        let window = number(query, "windowMinutes", 0., 0., 240.)? * 60.;
        if opt.time >= horizon + reserve + window {
            return Ok(None);
        }
        if !query["serviceDate"].is_string() {
            return Ok(None);
        }
        let mut date = Self::validated_service_date(query)?;
        let zone: chrono_tz::Tz = self.metadata["agencyTimezones"]
            .as_array()
            .and_then(|a| a.first())
            .and_then(Value::as_str)
            .unwrap_or("UTC")
            .parse()?;
        let epoch = |day: NaiveDate| super::calendar::service_epoch(zone, day);
        let initial = epoch(date)?;
        let mut time = opt.time;
        while time < horizon + reserve + window {
            date = date
                .pred_opt()
                .ok_or("Arrival search precedes supported dates")?;
            time = opt.time + (initial - epoch(date)?) as f64;
        }
        let object = query.as_object_mut().unwrap();
        object.remove("time");
        object.remove("serviceDay");
        object.insert("timeMinutes".into(), json!(time / 60.));
        object.insert("serviceDate".into(), json!(date.to_string()));
        Ok(Some(date.to_string()))
    }
    fn validate_wheelchair_request(&self, request: &Value) -> Result<()> {
        if request.get("wheelchair").is_some_and(|v| !v.is_boolean()) {
            return fail("wheelchair must be boolean");
        }
        let active = self.metadata["accessibility"]["profile"] == "wheelchair-strict-v1";
        if request["wheelchair"] == true && !active {
            return fail("Wheelchair routing requires a City built with --wheelchair");
        }
        if active {
            if request
                .get("scenario")
                .is_some_and(|value| !value.is_null())
            {
                return fail(
                    "Wheelchair routing requires a prepared City; query-time scenario accessibility is not modeled",
                );
            }
            if request["wheelchair"] == false {
                return fail("This wheelchair City cannot provide unrestricted routes");
            }
            if request["mode"] == "drive" {
                return fail("Wheelchair routing supports transit and walk, not drive");
            }
            if request
                .get("routingDataMode")
                .or_else(|| request.get("dataMode"))
                .is_some_and(|mode| mode != "scheduled")
            {
                return fail(
                    "Wheelchair routing currently requires scheduled service; live accessibility changes are not modeled",
                );
            }
        }
        Ok(())
    }
    pub fn execute(&mut self, command: &str, request: &Value) -> Result<Value> {
        if !request.is_object() {
            return fail("Request must be a JSON object");
        }
        validate_request(command, request, self.polling_enabled, self.live.is_some())?;
        self.validate_wheelchair_request(request)?;
        let started = Instant::now();
        self.timetable_activation_ms = 0.;
        self.timetable_preparation_profile = Value::Null;
        let reserved = arrival_reserve(command, request)?;
        let effective = reserved.as_ref().map_or(request, |(query, _)| query);
        // The live snapshot installed when this query was admitted applies to
        // every search it runs; a newer one waits for the next query.
        if uses_live_snapshot(command, request) {
            self.query_live = self.live.clone();
            // Activation reads only scalar options; places can be large.
            let activation = effective.as_object().map(|o| {
                o.iter()
                    .filter(|(_, v)| !v.is_array() && !v.is_object())
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect::<serde_json::Map<_, _>>()
            });
            self.live_request =
                activation.map(|o| (Value::Object(o), self.query_start_date.clone()));
        }
        let dispatched = self.dispatch(command, request, effective);
        let live = self.query_live.take().is_some();
        let mut result = dispatched?;
        // Matrix and Reach search the same realtime view as Route and report it
        // the same way. Route reports its own data mode.
        if matches!(command, "matrix" | "reach" | "isochrone")
            && (live || request.get("realtimeSnapshot").is_some())
            && let Some(timetable) = &self.timetable
        {
            result["diagnostics"]["realtime"] = timetable.realtime.clone();
            result["dataMode"] = json!("realtime");
        }
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
    fn dispatch(&mut self, command: &str, request: &Value, effective: &Value) -> Result<Value> {
        Ok(match command {
            "info" => self.info(),
            "capabilities" => capabilities(),
            "route" => self.route(effective)?,
            "matrix" => self.matrix(effective)?,
            "reach" | "isochrone" => self.reach(effective)?,
            "compare" => super::compare(&request["before"], &request["after"])?,
            "native" => self.native(request)?,
            _ => return fail(format!("Unknown command: {command}")),
        })
    }
    /// Installs the server's newest live snapshot. With `warm`, it derives the
    /// realtime view of the last live query now, so that a similar query
    /// finds it ready instead of compiling it on the query path.
    pub(crate) fn install_realtime(&mut self, message: &mut Value) -> Result<()> {
        let snapshot = message["snapshot"].take();
        if !snapshot["tripUpdates"].is_array() {
            return fail("Live GTFS-RT snapshot requires tripUpdates");
        }
        self.live = Some(std::sync::Arc::new(super::realtime_poll::LiveSnapshot {
            generation: message["generation"]
                .as_u64()
                .ok_or("Missing live generation")?,
            id: message["id"]
                .as_str()
                .ok_or("Missing live snapshot id")?
                .to_owned(),
            snapshot,
        }));
        if message["warm"] == true
            && let Some((request, start_date)) =
                self.live_request.clone().or_else(|| self.now_request())
        {
            self.query_live = self.live.clone();
            self.query_start_date = start_date;
            // Best effort: a failure here reappears on the query itself.
            let _ = self.activate(&request);
            self.query_live = None;
            self.query_start_date = None;
        }
        Ok(())
    }
    /// Until a live query arrives, warm the view a departure now would use:
    /// the current local date and time in the City's timezone.
    fn now_request(&self) -> Option<(Value, Option<String>)> {
        let zone: chrono_tz::Tz = self.metadata["agencyTimezones"][0]
            .as_str()
            .unwrap_or("UTC")
            .parse()
            .ok()?;
        let seconds = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()?
            .as_secs() as i64;
        let local = chrono::DateTime::from_timestamp(seconds, 0)?.with_timezone(&zone);
        let request = json!({"serviceDate":local.format("%Y-%m-%d").to_string(),
            "time":local.format("%H:%M").to_string(),"routingDataMode":"realtime"});
        Some((request, None))
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
            if selected.location == 1 {
                return self.street_candidates(point, role, opt, self.padding, self.overhead);
            }
            let stops: Vec<u32> = t.index.get(id).copied().into_iter().collect();
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
    fn access_status(
        &mut self,
        point: &Point,
        role: &str,
        candidates: &Candidates,
        opt: &Options,
        probe: bool,
    ) -> Result<Value> {
        let mut status = json!({"coordinate":point.coordinate,"role":role,"maximumWalkMeters":opt.walk_m,
            "candidateCount":candidates.stops.len(),"code":"available"});
        if !candidates.stops.is_empty() {
            return Ok(status);
        }
        if point.stop.is_some() {
            status["code"] = json!("station_access_unavailable");
            return Ok(status);
        }
        let b = &self.street_bounds;
        let bounds =
            ["west", "south", "east", "north"].map(|key| b[key].as_f64().unwrap_or(f64::NAN));
        let code = self.street.diagnose_endpoint_street_access(
            point.coordinate[0],
            point.coordinate[1],
            bounds.to_vec(),
        )?;
        status["code"] = json!(code);
        if code == "outside_coverage" {
            status["coverageBounds"] = b.clone();
        }
        if code != "none_within_walk_budget" {
            return Ok(status);
        }
        if probe && opt.walk_m < 5000. {
            let mut wider = Options::parse(
                &json!({"timeMinutes":opt.time/60.,"maxWalkKm":(opt.walk_m*2.).max(opt.walk_m+500.).min(5000.)/1000.}),
            )?;
            wider.disable_cache = opt.disable_cache;
            wider.walk_speed = opt.walk_speed;
            let result =
                self.street_candidates(point, role, &wider, self.padding, self.overhead)?;
            status["probeWalkMeters"] = json!(wider.walk_m);
            if !result.stops.is_empty() {
                status["code"] = json!("outside_selected_budget");
                status["suggestedWalkMeters"] = json!(
                    result
                        .evidence
                        .as_ref()
                        .unwrap()
                        .distances_m
                        .iter()
                        .copied()
                        .fold(f64::INFINITY, f64::min)
                );
            }
        }
        Ok(status)
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
    fn matrix_candidates(
        &mut self,
        points: &[Point],
        role: &str,
        opt: &Options,
    ) -> Result<Vec<Candidates>> {
        if points.iter().any(|point| point.stop.is_some()) {
            return points
                .iter()
                .map(|point| self.candidates(point, role, opt))
                .collect();
        }
        let coordinates = points
            .iter()
            .map(|point| point.coordinate)
            .collect::<Vec<_>>();
        self.street
            .route_endpoint_batch(
                &coordinates,
                EndpointRoleInput {
                    longitude: 0.,
                    latitude: 0.,
                    maximum_walk_m: opt.walk_m,
                    walking_speed_kph: Some(opt.walk_speed.unwrap_or(self.speed)),
                    access_padding_factor: Some(self.padding),
                    access_overhead_seconds: Some(self.overhead),
                    role: role.into(),
                    disable_cache: Some(opt.disable_cache),
                },
            )?
            .into_iter()
            .map(|result| self.project_candidates(result))
            .collect()
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
        let mut result = self.route_options(q, false)?;
        // Every published journey prices its boardings: plain, window and ordered.
        let date = q["serviceDate"].as_str().unwrap_or_default().to_owned();
        self.annotate_fares(&mut result, &date);
        if let Some(choices) = result.get_mut("choices").and_then(Value::as_array_mut) {
            for choice in choices {
                self.annotate_fares(choice, &date);
            }
        }
        Ok(result)
    }
    fn route_options(&mut self, q: &Value, collect: bool) -> Result<Value> {
        let opt = Options::parse(q)?;
        let shared_legs = flag(q, "sharedLegs", false)?;
        let requested = crate::route_alternatives::parse(q)?;
        let origin = self.point(&q["origin"])?;
        let destination = self.point(&q["destination"])?;
        let mode = q["mode"].as_str().unwrap_or("transit");
        if shared_legs && mode != "transit" {
            return fail("sharedLegs requires transit mode");
        }
        if let Some(via) = q.get("via").or_else(|| q.get("waypoints"))
            && !via.as_array().ok_or("via must be an array")?.is_empty()
        {
            if shared_legs {
                return fail("sharedLegs is not supported with via points");
            }
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
        let mut choices = vec![];
        let mut alternative_search = None;
        // Alternatives share one timetable, options, and endpoint witnesses.
        // Reuse immutable leg evidence within this search; clocks are refreshed.
        let mut materialization = (collect || requested.is_some())
            .then(super::materialize::MatrixMaterializationCache::default);
        if (collect || requested.is_some())
            && let Some(j) = journey.as_ref()
        {
            let (candidates, unsupported) = super::point::alternatives(
                &mut self.timetable.as_mut().unwrap().kernel,
                &Self::matrix_input(
                    std::slice::from_ref(&a),
                    std::slice::from_ref(&b),
                    &opt,
                    true,
                ),
                j,
                requested.as_ref(),
            )?;
            alternative_search = requested.as_ref().map(|_| match &unsupported {
                None => json!({"status":"complete"}),
                Some(reason) => json!({"status":"unavailable","reason":reason}),
            });
            for candidate in candidates {
                let mut choice = self.materialize(
                    &candidate,
                    [&origin, &destination],
                    true,
                    &opt,
                    [&a, &b],
                    materialization.as_mut(),
                )?;
                choice["status"] = json!("ready");
                choice["mode"] = json!("transit");
                if shared_legs {
                    choice["sharedLegAlternatives"] = self.shared_leg_alternatives(
                        &choice,
                        &candidate,
                        [&origin, &destination],
                        &opt,
                        [&a, &b],
                    )?;
                }
                choices.push(choice);
            }
        }
        let mut output = if let Some(j) = journey.as_ref() {
            let mut j = self.materialize(
                j,
                [&origin, &destination],
                true,
                &opt,
                [&a, &b],
                materialization.as_mut(),
            )?;
            j["status"] = json!("ready");
            j["mode"] = json!("transit");
            j
        } else {
            json!({"status":"blocked","reason":if a.stops.is_empty() || b.stops.is_empty() {"no_access"}else{"no_path"},"mode":"transit"})
        };
        // A street walk is never shorter than the straight line between the
        // endpoints. When that bound already loses to the transit journey, the
        // walk cannot win and, unless choices are collected, is not searched.
        let walk_cannot_win =
            !collect && output["status"] == "ready" && output["mode"] == "transit" && {
                let bound = crate::route_materialization::haversine_km(
                    origin.coordinate,
                    destination.coordinate,
                ) / opt.walk_speed.unwrap_or(self.speed)
                    * 60.;
                let transit = if opt.arrive {
                    opt.time / 60.
                        - output["departureMinutes"]
                            .as_f64()
                            .unwrap_or(f64::NEG_INFINITY)
                } else {
                    output["arrivalMinutes"].as_f64().unwrap_or(f64::INFINITY) - opt.time / 60.
                };
                // Keep a margin for edge lengths measured another way.
                bound * 0.99 > transit
            };
        if !flag(q, "requireTransitRide", false)?
            && !walk_cannot_win
            && (output["status"] == "ready"
                || (origin.stop.is_none() && destination.stop.is_none()))
        {
            let walk = self.street_route(q, &origin, &destination, &opt, "walk")?;
            let wins = walk["status"] == "ready"
                && (output["status"] != "ready"
                    || if opt.arrive {
                        walk["departureMinutes"].as_f64() >= output["departureMinutes"].as_f64()
                    } else {
                        walk["arrivalMinutes"].as_f64() <= output["arrivalMinutes"].as_f64()
                    });
            if collect && walk["status"] == "ready" {
                choices.push(walk.clone());
            }
            if wins {
                output = walk;
            }
        }
        if shared_legs
            && output["mode"] == "transit"
            && output["status"] == "ready"
            && let Some(journey) = journey.as_ref()
        {
            output["sharedLegAlternatives"] = self.shared_leg_alternatives(
                &output,
                journey,
                [&origin, &destination],
                &opt,
                [&a, &b],
            )?;
        }
        if collect {
            if output["status"] == "ready" {
                choices.push(output.clone());
            }
            output["choices"] = json!(super::alternatives::select(choices, opt.arrive, 5));
        } else if let Some(search) = alternative_search {
            // Transit alternatives only; the shared public projection selects.
            output["choices"] = Value::Array(choices);
            output["alternativeSearch"] = search;
        }
        output["diagnostics"] = json!({"search":{"startSeconds":opt.start,"endSeconds":opt.end,"horizonScope":"timetable_scan","maxTransfers":q["maxTransfers"],"allowStreetTransfers":q.get("allowStreetTransfers").unwrap_or(&Value::Bool(true)),"minimumTransferBufferMinutes":q.get("minimumTransferBufferMinutes").unwrap_or(&json!(0))},"native":result});
        output["diagnostics"]["originAccess"] = a.diagnostics(&origin, self.full_access_evidence)?;
        output["diagnostics"]["destinationAccess"] =
            b.diagnostics(&destination, self.full_access_evidence)?;
        if output["status"] == "blocked" {
            output["access"] = json!({"origin":self.access_status(&origin,"origin",&a,&opt,true)?,
                "destination":self.access_status(&destination,"destination",&b,&opt,true)?});
        }
        output["serviceDate"] = q["serviceDate"].clone();
        output["diagnostics"]["realtime"] = self.timetable.as_ref().unwrap().realtime.clone();
        output["warnings"] = self.metadata["routingLimitations"].clone();
        output["dataMode"] = json!(if q.get("realtimeSnapshot").is_some()
            || self.query_live.is_some()
        {
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
        let mut states = vec![super::ordered::Candidate::start(opt.time / 60.)];
        let mut searches = 0;
        let indices: Vec<usize> = if opt.arrive {
            (0..points.len() - 1).rev().collect()
        } else {
            (0..points.len() - 1).collect()
        };
        for (step, i) in indices.iter().copied().enumerate() {
            let mut cache = std::collections::HashMap::<u64, Vec<std::sync::Arc<Value>>>::new();
            let mut candidates = vec![];
            let mut failure = None;
            for state in &states {
                let key = state.clock.to_bits();
                if let std::collections::hash_map::Entry::Vacant(entry) = cache.entry(key) {
                    let mut request = q.clone();
                    let m = request.as_object_mut().unwrap();
                    for k in ["via", "waypoints", "time", "windowMinutes"] {
                        m.remove(k);
                    }
                    m.insert("timeMinutes".into(), json!(state.clock));
                    m.insert("origin".into(), points[i].clone());
                    m.insert("destination".into(), points[i + 1].clone());
                    let mut result = self.route_options(&request, true)?;
                    searches += 1;
                    let choices = result
                        .as_object_mut()
                        .unwrap()
                        .remove("choices")
                        .and_then(|v| v.as_array().cloned())
                        .unwrap_or_else(|| vec![result.clone()]);
                    failure.get_or_insert(result);
                    entry.insert(
                        choices
                            .into_iter()
                            .filter(|v| v["status"] == "ready")
                            .map(std::sync::Arc::new)
                            .collect(),
                    );
                }
                for piece in &cache[&key] {
                    candidates.push(state.extend(piece.clone(), opt.arrive));
                }
            }
            if candidates.is_empty() {
                return Ok(
                    json!({"status":"blocked","reason":"via_leg_blocked","legIndex":i,"leg":failure}),
                );
            }
            states = super::ordered::select(candidates, opt.arrive, step + 1 == indices.len());
        }
        let choices: Vec<Value> = states
            .iter()
            .map(|state| state.finish(&json!(via)))
            .collect();
        let mut result = choices[0].clone();
        result["choices"] = json!(choices);
        result["diagnostics"]["orderedSearch"] = json!({"segmentQueries":searches,
            "candidateLimit":super::ordered::LIMIT,"alternatives":"bounded_waypoint_frontier"});
        Ok(result)
    }
    fn route_window(&mut self, q: &Value, window: f64) -> Result<Value> {
        let opt = Options::parse(q)?;
        let step = number(q, "windowStepMinutes", 1., 1., 60.)?;
        let mut choices = vec![];
        let mut first = None;
        let mut searches = 0;
        for sample in 0..=(window / step).floor() as u32 {
            let seconds =
                opt.time + if opt.arrive { -1. } else { 1. } * f64::from(sample) * step * 60.;
            if !(0. ..=345_540.).contains(&seconds) {
                continue;
            }
            let mut request = q.clone();
            request.as_object_mut().unwrap().remove("time");
            request["timeMinutes"] = json!(seconds / 60.);
            request["windowMinutes"] = json!(0);
            let mut result = self.route_options(&request, true)?;
            searches += 1;
            if let Some(items) = result
                .as_object_mut()
                .unwrap()
                .remove("choices")
                .and_then(|v| v.as_array().cloned())
            {
                choices.extend(items);
            }
            if first.is_none() {
                first = Some(result);
            }
        }
        let choices = super::alternatives::select(choices, opt.arrive, 5);
        // An unsuccessful window retains the original endpoint evidence and
        // failure class instead of fabricating a generic timetable failure.
        let mut result = choices.first().cloned().unwrap_or_else(|| first.unwrap());
        result["choices"] = json!(choices);
        result["window"] = json!({"minutes":window,"stepMinutes":step,"searches":searches,
            "coverage":"sampled","direction":if opt.arrive {"earlier_arrival_deadlines"} else {"later_departures"},
            "arrivalSlackMinutes":15,"maximumJourneys":5});
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
        let a = self.matrix_candidates(&search_origins, "origin", &opt)?;
        let b = self.matrix_candidates(&search_destinations, "destination", &opt)?;
        let include = flag(q, "includeJourneys", false)?;
        let mut result = self
            .timetable
            .as_mut()
            .unwrap()
            .kernel
            .route_matrix_csa(Self::matrix_input(&a, &b, &opt, include))?;
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
        if !flag(q, "requireTransitRide", false)? {
            let walk = self.street.route_street_matrix(StreetMatrixInput {
                origin_coordinates: search_origins.iter().flat_map(|p| p.coordinate).collect(),
                destination_coordinates: search_destinations
                    .iter()
                    .flat_map(|p| p.coordinate)
                    .collect(),
                maximum_distance_m: self.direct_walk_limit(q, &opt)?,
                disable_cache: Some(opt.disable_cache),
            })?;
            for (i, &distance) in walk.distances_m.iter().enumerate() {
                let minutes = distance / self.speed * 3.6 / 60.;
                let exact = search_origins[i / search_width].stop.is_some()
                    || search_destinations[i % search_width].stop.is_some();
                if !(exact && !durations[i].is_finite())
                    && minutes.is_finite()
                    && minutes <= durations[i]
                    && minutes <= (opt.end - opt.start) / 60.
                {
                    durations[i] = minutes;
                    if let Some(ref mut journeys) = journeys {
                        let departure = if opt.arrive {
                            opt.time / 60. - minutes
                        } else {
                            opt.time / 60.
                        };
                        let mut leg = json!({"kind":"walk","fromStopId":null,"toStopId":null,
                            "departureMinutes":departure,"arrivalMinutes":departure+minutes,"durationMinutes":minutes});
                        if !compact {
                            leg["distanceMeters"] = json!(distance);
                        }
                        if include_geometry {
                            let origin = &search_origins[i / search_width];
                            let destination = &search_destinations[i % search_width];
                            let path = self.street.route_path(StreetPathInput {
                                origin_lon: origin.coordinate[0],
                                origin_lat: origin.coordinate[1],
                                destination_lon: destination.coordinate[0],
                                destination_lat: destination.coordinate[1],
                                maximum_distance_m: self.direct_walk_limit(q, &opt)?,
                                maximum_points: 512,
                            })?;
                            if !path.found {
                                return fail("Matrix selected walk could not be materialized");
                            }
                            leg["coordinates"] = json!(walking_coordinates(
                                &path.coordinates,
                                origin.coordinate,
                                destination.coordinate
                            ));
                        }
                        journeys[i] = json!({"mode":"walk","departureMinutes":departure,"arrivalMinutes":departure+minutes,
                            "durationMinutes":minutes,"distanceMeters":distance,"transfers":0,
                            "walkMinutes":minutes,"rideMinutes":0,"waitMinutes":0,"legs":[leg]});
                    }
                }
            }
        }
        // Resolve both transit and direct walking once per distinct pair.
        // Expand only finished answers, retaining the caller's original order.
        if let Some(cells) = &cells {
            result.times = cells.iter().map(|&i| result.times[i]).collect();
            durations = cells.iter().map(|&i| durations[i]).collect();
        }
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
        let mut origin_access = serde_json::Map::new();
        for (i, point) in origins.iter().enumerate() {
            let candidates = &a[origin_indices[i]];
            if candidates.stops.is_empty() {
                origin_access.insert(
                    i.to_string(),
                    self.access_status(point, "origin", candidates, &opt, false)?,
                );
            }
        }
        let mut destination_access = serde_json::Map::new();
        for (i, point) in destinations.iter().enumerate() {
            let candidates = &b[destination_indices[i]];
            if candidates.stops.is_empty() {
                destination_access.insert(
                    i.to_string(),
                    self.access_status(point, "destination", candidates, &opt, false)?,
                );
            }
        }
        let mut output = json!({"kind":"matrix","mode":mode,"originCount":origins.len(),"destinationCount":destinations.len(),"durationsMinutes":durations.chunks(destinations.len()).collect::<Vec<_>>(),"diagnostics":result,"warnings":self.metadata["routingLimitations"]});
        output["diagnostics"]["matrixReuse"] = json!({
            "requestedPairs":origins.len() * destinations.len(),
            "searchPairs":search_origins.len() * search_destinations.len(),
            "uniqueOrigins":search_origins.len(),
            "uniqueDestinations":search_destinations.len()});
        if !origin_access.is_empty() || !destination_access.is_empty() {
            output["access"] = json!({"origins":origin_access,"destinations":destination_access});
        }
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
        // A street trip is one routed path, or for driving a road path between
        // two straight walks from each free endpoint to its road.
        let (legs, diagnostics) = match mode {
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
                    vec![StreetLeg {
                        kind: "walk",
                        seconds: r.distance_m / speed * 3.6,
                        meters: r.distance_m,
                        coordinates: walking_coordinates(
                            &r.coordinates,
                            origin.coordinate,
                            destination.coordinate,
                        ),
                        source: "osm",
                        verified: true,
                    }],
                    serde_json::to_value(&r)?,
                )
            }
            "drive" => {
                self.load_drive()?;
                let walking_speed_kph = opt.walk_speed.unwrap_or(self.speed);
                let d = self.drive.as_mut().unwrap();
                let (traffic, traffic_diagnostics) =
                    d.traffic(q.get("traffic"), realtime_drive(q))?;
                let r = d.kernel.route_coordinates(DriveCoordinateRouteInput {
                    origin_lon: origin.coordinate[0],
                    origin_lat: origin.coordinate[1],
                    destination_lon: destination.coordinate[0],
                    destination_lat: destination.coordinate[1],
                    maximum_walk_meters: opt.walk_m,
                    walking_speed_kph,
                    maximum_distance_meters: opt.street_m,
                    traffic,
                    nearest_road_only: None,
                })?;
                let mut diagnostics = serde_json::to_value(&r.search)?;
                diagnostics["originRoadMeters"] = json!(r.origin_road_meters);
                diagnostics["destinationRoadMeters"] = json!(r.destination_road_meters);
                diagnostics["maximumWalkMeters"] = json!(opt.walk_m);
                let diagnostics = drive_diagnostics(diagnostics, traffic_diagnostics);
                if r.status != "ready" {
                    return Ok(
                        json!({"status":"blocked","reason":r.reason,"mode":mode,"diagnostics":diagnostics}),
                    );
                }
                let road: Vec<[f64; 2]> = r
                    .drive_coordinates
                    .chunks_exact(2)
                    .map(|p| [p[0], p[1]])
                    .collect();
                let walk = |seconds: Option<f64>, meters: Option<f64>, from, to| StreetLeg {
                    kind: "walk",
                    seconds: seconds.unwrap_or(0.),
                    meters: meters.unwrap_or(0.),
                    coordinates: vec![from, to],
                    source: "coordinate-snap",
                    verified: false,
                };
                let first = walk(
                    r.origin_walk_seconds,
                    r.origin_walk_meters,
                    origin.coordinate,
                    road[0],
                );
                let last = walk(
                    r.destination_walk_seconds,
                    r.destination_walk_meters,
                    road[road.len() - 1],
                    destination.coordinate,
                );
                let drive = StreetLeg {
                    kind: "drive",
                    seconds: r.drive_seconds.ok_or("Missing drive duration")?,
                    meters: r.drive_meters.ok_or("Missing drive distance")?,
                    coordinates: road,
                    source: "osm",
                    verified: true,
                };
                // Sub-meter gaps are rounding, not walks; keep their seconds.
                let mut legs = vec![];
                let mut drive = drive;
                for gap in [&first, &last] {
                    if gap.meters < MINIMUM_CONNECTOR_METERS {
                        drive.seconds += gap.seconds;
                        drive.meters += gap.meters;
                    }
                }
                if first.meters >= MINIMUM_CONNECTOR_METERS {
                    legs.push(first);
                }
                legs.push(drive);
                if last.meters >= MINIMUM_CONNECTOR_METERS {
                    legs.push(last);
                }
                (legs, diagnostics)
            }
            _ => return fail("mode must be transit, walk, or drive"),
        };
        let seconds: f64 = legs.iter().map(|leg| leg.seconds).sum();
        let distance: f64 = legs.iter().map(|leg| leg.meters).sum();
        let (departure, arrival) = if opt.arrive {
            (opt.time - seconds, opt.time)
        } else {
            (opt.time, opt.time + seconds)
        };
        if departure < 0. {
            return Ok(json!({"status":"blocked","reason":"before_service_day","mode":mode}));
        }
        let mut clock = departure;
        let legs: Vec<Value> = legs
            .into_iter()
            .map(|leg| {
                let start = clock;
                clock += leg.seconds;
                json!({"kind":leg.kind,"departureMinutes":start/60.,"arrivalMinutes":clock/60.,
                    "durationMinutes":leg.seconds/60.,"distanceMeters":leg.meters,
                    "coordinates":leg.coordinates,"geometrySource":leg.source,
                    "streetPathVerified":leg.verified})
            })
            .collect();
        Ok(
            json!({"status":"ready","mode":mode,"departureMinutes":departure/60.,"arrivalMinutes":arrival/60.,"durationMinutes":seconds/60.,"distanceMeters":distance,"transfers":0,"legs":legs,"diagnostics":diagnostics}),
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
                let walking_speed_kph = opt.walk_speed.unwrap_or(self.speed);
                let d = self.drive.as_mut().unwrap();
                let (traffic, traffic_diagnostics) =
                    d.traffic(q.get("traffic"), realtime_drive(q))?;
                let r = d.kernel.route_coordinate_matrix(DriveCoordinateMatrixInput {
                    origin_coordinates: origins.iter().flat_map(|p| p.coordinate).collect(),
                    destination_coordinates: destinations
                        .iter()
                        .flat_map(|p| p.coordinate)
                        .collect(),
                    maximum_walk_meters: opt.walk_m,
                    walking_speed_kph,
                    maximum_distance_meters: opt.street_m,
                    traffic,
                })?;
                (
                    r.distances_m.clone(),
                    r.durations_s.iter().map(|v| v / 60.).collect(),
                    drive_diagnostics(serde_json::to_value(r)?, traffic_diagnostics),
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
        let result = match operation {
            "street.path" => call!(self.street, route_path),
            "street.matrix" => call!(self.street, route_street_matrix),
            "street.surface" => call!(self.street, street_surface),
            "street.connectors" => call!(self.street, timed_connectors),
            "access.endpoint" => call!(self.street, route_endpoint),
            "access.endpoints" => call!(self.street, route_endpoints),
            "drive.route" | "drive.matrix" => {
                self.load_drive()?;
                let drive = self.drive.as_mut().unwrap();
                if input.get("traffic").is_some_and(|v| !v.is_null()) {
                    let (traffic, _) = drive.traffic(input.get("traffic"), false)?;
                    input["traffic"] = serde_json::to_value(traffic)?;
                }
                let k = &mut drive.kernel;
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
                        json!({"stopIds":&*t.stop_ids,"tripIds":&*t.trip_ids,"routeIds":&*t.route_ids,"accessMemberStopIds":self.members})
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
    fn traffic(
        &mut self,
        value: Option<&Value>,
        automatic: bool,
    ) -> Result<(Option<DriveTrafficInput>, Value)> {
        let snapshot = if let Some(value) = value.filter(|v| !v.is_null()) {
            let fingerprint = self.image.header["identity"]["sourceFingerprint"]
                .as_str()
                .ok_or("Missing street fingerprint")?;
            self.kernel.compile_traffic(value, fingerprint)?
        } else if automatic && value.is_none() {
            let Some(snapshot) = &self.automatic_traffic else {
                return Ok((
                    None,
                    json!({"status":"unavailable_fallback","source":"ndw-datex2-v3-avg"}),
                ));
            };
            snapshot.clone()
        } else {
            return Ok((None, Value::Null));
        };
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_millis() as i64;
        let mut admission = snapshot.admission(now).map_err(std::io::Error::other)?;
        let input = (admission["status"] == "applied").then(|| DriveTrafficInput {
            snapshot_key: snapshot.weights.snapshot_key.clone(),
            edge_indices: snapshot.weights.edge_indices.clone(),
            edge_time_units: snapshot.weights.edge_time_units.clone(),
        });
        admission.as_object_mut().unwrap().remove("cacheKey");
        Ok((input, admission))
    }
}
pub(crate) fn haversine(a: [f64; 2], b: [f64; 2]) -> f64 {
    let v = ((b[1] - a[1]).to_radians() / 2.).sin().powi(2)
        + a[1].to_radians().cos()
            * b[1].to_radians().cos()
            * ((b[0] - a[0]).to_radians() / 2.).sin().powi(2);
    6371008.8 * 2. * v.sqrt().atan2((1. - v).max(0.).sqrt())
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

// Realtime transit queries without their own snapshot use the server's.
fn uses_live_snapshot(command: &str, q: &Value) -> bool {
    matches!(command, "route" | "matrix" | "reach" | "isochrone")
        && q.get("realtimeSnapshot").is_none()
        && q["mode"].as_str().unwrap_or("transit") == "transit"
        && q.get("routingDataMode")
            .or_else(|| q.get("dataMode"))
            .is_some_and(|v| v == "realtime")
}
fn validate_request(command: &str, q: &Value, polling: bool, live: bool) -> Result<()> {
    let common = [
        "kind",
        "wheelchair",
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
            "alternatives",
            "alternativeRanking",
            "alternativeSlackMinutes",
            "sharedLegs",
        ],
        "matrix" => &[
            "origins",
            "destinations",
            "includeJourneys",
            "includeGeometry",
            "journeyFormat",
        ],
        "reach" | "isochrone" => &[
            "reachFormat",
            "origin",
            "cutoffsMinutes",
            "rasterSize",
            "extentRadiusKm",
            "bounds",
            "walkSpeedKph",
            "includeStreetEdges",
            "surfaceSampling",
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
    if q.get("realtimeSnapshot").is_some()
        && (!matches!(command, "route" | "matrix" | "reach" | "isochrone") || mode != "transit")
    {
        return fail("Realtime transit snapshots are supported by transit Route, Matrix and Reach");
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
        if value == "realtime"
            && q.get("realtimeSnapshot").is_none()
            && q.get("traffic").is_none()
            && !(polling && mode == "drive" && matches!(command, "route" | "matrix"))
            && !(live && uses_live_snapshot(command, q))
        {
            return fail("Realtime mode requires a supplied snapshot");
        }
    }
    Ok(())
}

// Street kernels return graph geometry. Public walking journeys also retain
// the requested endpoints, including a valid two-point zero-length line.
/// Gaps shorter than this between a point and its road are not published as
/// separate walks.
const MINIMUM_CONNECTOR_METERS: f64 = 0.5;

struct StreetLeg {
    kind: &'static str,
    seconds: f64,
    meters: f64,
    coordinates: Vec<[f64; 2]>,
    source: &'static str,
    verified: bool,
}

fn walking_coordinates(raw: &[f64], origin: [f64; 2], destination: [f64; 2]) -> Vec<[f64; 2]> {
    let mut points = Vec::with_capacity(raw.len() / 2 + 2);
    points.push(origin);
    for point in raw
        .chunks_exact(2)
        .map(|p| [p[0], p[1]])
        .chain([destination])
    {
        if points
            .last()
            .is_none_or(|p| (p[0] - point[0]).abs() > 1e-10 || (p[1] - point[1]).abs() > 1e-10)
        {
            points.push(point);
        }
    }
    *points.last_mut().unwrap() = destination;
    if points.len() == 1 {
        points.push(destination);
    }
    points
}

fn realtime_drive(q: &Value) -> bool {
    q.get("routingDataMode")
        .or_else(|| q.get("dataMode"))
        .is_some_and(|v| v == "realtime")
}
fn drive_diagnostics(mut value: Value, traffic: Value) -> Value {
    if !traffic.is_null() {
        value["traffic"] = traffic;
    }
    value
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
