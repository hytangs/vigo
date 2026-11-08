//! Compile portable frequency or explicit-trip service edits to the shared Rust overlay scan.
//!
//! Generated trips follow GTFS stop-time semantics: a vehicle arrives after
//! running, dwells, then departs, so alighting uses the arrival and boarding
//! the departure. A frequency service runs on every service day, so the
//! previous days' overnight tails and the next days' early runs are generated
//! where the active timetable's clock reaches them, as scheduled service is.
use super::query::{Options, Point};
use super::{City, Result, fail, flag, number};
use crate::{StreetMatrixInput, TimetableManyQueryInput, TimetableOverlayManyQueryInput};
use chrono::{Datelike, NaiveDate};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

/// Service days around the query date whose frequency windows can reach its
/// clock: windows end at most 4319 minutes after their own day starts.
const PLANNED_DAY_DELTAS: std::ops::RangeInclusive<i64> = -3..=3;
/// The clock a planned timetable covers when its timetable states none.
const DEFAULT_PLANNED_CLOCK_SECONDS: f64 = 108_000.;

pub(crate) struct Overlay {
    pub input: TimetableOverlayManyQueryInput,
    pub stops: Vec<(String, [f64; 2])>,
}
/// Planned services compiled to stop patterns, one per run: a frequency
/// window or one kept trip. Offsets are seconds after the run's departure.
#[derive(Default)]
pub(crate) struct Planned {
    pub points: Vec<Point>,
    pub ids: Vec<String>,
    pub labels: Vec<String>,
    pub direction_offsets: Vec<u32>,
    pub direction_stops: Vec<u32>,
    pub departures: Vec<f64>,
    pub arrivals: Vec<f64>,
    pub board: Vec<u8>,
    pub alight: Vec<u8>,
    pub starts: Vec<f64>,
    pub ends: Vec<f64>,
    pub headways: Vec<f64>,
    pub random: Vec<bool>,
    /// Each run's service and whether it runs the service in reverse.
    pub run_services: Vec<usize>,
    pub run_inbound: Vec<bool>,
    pub run_entries: Vec<String>,
    /// The service day each run belongs to, in days after the query date.
    pub run_days: Vec<i64>,
    /// Resident trips a replacement removes.
    pub excluded_trips: Vec<u32>,
}
impl City {
    pub(crate) fn scenario(
        &mut self,
        scenario: &Value,
        mut base: TimetableManyQueryInput,
        origin: &Point,
        opt: &Options,
        date: NaiveDate,
    ) -> Result<Overlay> {
        let Planned {
            points,
            ids,
            direction_offsets,
            direction_stops,
            departures,
            arrivals,
            board,
            alight,
            starts,
            ends,
            headways,
            excluded_trips,
            ..
        } = self.planned(scenario, date)?;
        base.excluded_trips.extend(excluded_trips);
        let n = self.timetable.as_ref().unwrap().stop_ids.len();
        let m = points.len();
        let mut transfers: Vec<HashMap<u32, u32>> = vec![HashMap::new(); n + m];
        let mut origin_coordinates = origin.coordinate.to_vec();
        let mut all_coordinates: Vec<f64> = points.iter().flat_map(|p| p.coordinate).collect();
        origin_coordinates.append(&mut all_coordinates);
        let walk = self.street.route_street_matrix(StreetMatrixInput {
            origin_coordinates,
            destination_coordinates: points.iter().flat_map(|p| p.coordinate).collect(),
            maximum_distance_m: opt.walk_m,
            disable_cache: Some(opt.disable_cache),
        })?;
        let mut base_stops = vec![];
        for (i, point) in points.iter().enumerate() {
            base_stops.push(
                point
                    .stop
                    .as_ref()
                    .and_then(|id| self.timetable.as_ref().unwrap().index.get(id))
                    .map(|&v| v as i32)
                    .unwrap_or(-1),
            );
            let outbound = self.street_candidates(point, "origin", opt, 1., 0.)?;
            let inbound = self.street_candidates(point, "destination", opt, 1., 0.)?;
            for (stop, duration) in outbound.stops.iter().zip(&outbound.seconds) {
                transfers[n + i].insert(*stop, duration.ceil() as u32);
            }
            for (stop, duration) in inbound.stops.iter().zip(&inbound.seconds) {
                transfers[*stop as usize].insert((n + i) as u32, duration.ceil() as u32);
            }
            if base_stops[i] >= 0 {
                let stop = base_stops[i] as u32;
                transfers[n + i].insert(stop, 0);
                transfers[stop as usize].insert((n + i) as u32, 0);
            }
            if walk.distances_m[i].is_finite() {
                base.origin_stops.push((n + i) as u32);
                base.origin_walk_seconds.push(
                    (walk.distances_m[i] / opt.walk_speed.unwrap_or(self.speed)
                        * 3.6
                        * self.padding
                        + self.overhead)
                        .ceil(),
                );
            }
            for j in 0..m {
                let distance = walk.distances_m[(i + 1) * m + j];
                if i != j && distance.is_finite() {
                    transfers[n + i].insert(
                        (n + j) as u32,
                        (distance / opt.walk_speed.unwrap_or(self.speed) * 3.6).ceil() as u32,
                    );
                }
            }
            base.destination_stops.push((n + i) as u32);
            base.destination_walk_seconds.push(0.);
            base.destination_offsets
                .push(base.destination_stops.len() as u32);
        }
        base.allow_post_ride_transfers = Some(vec![false; n + m]);
        let mut offsets = vec![0];
        let mut to = vec![];
        let mut seconds = vec![];
        for edges in transfers {
            let mut edges: Vec<_> = edges.into_iter().collect();
            edges.sort();
            for (target, duration) in edges {
                to.push(target);
                seconds.push(duration);
            }
            offsets.push(to.len() as u32);
        }
        let mut v = serde_json::to_value(base)?;
        let extra = json!({"overlayStopCount":m,"overlayBaseStops":base_stops,"directionOffsets":direction_offsets,"directionStops":direction_stops,"directionStopOffsetsSeconds":departures,"directionArrivalOffsetsSeconds":arrivals,"directionCanBoard":board,"directionCanAlight":alight,"serviceStartSeconds":starts,"serviceEndSeconds":ends,"serviceHeadwaySeconds":headways,"supplementalTransferOffsets":offsets,"supplementalTransferTo":to,"supplementalTransferDuration":seconds});
        for (k, value) in extra.as_object().unwrap() {
            v[k] = value.clone();
        }
        Ok(Overlay {
            input: serde_json::from_value(v)?,
            stops: ids
                .into_iter()
                .zip(points.into_iter().map(|p| p.coordinate))
                .collect(),
        })
    }

    /// Compile `scenario.services` against the active timetable.
    pub(crate) fn planned(&mut self, scenario: &Value, date: NaiveDate) -> Result<Planned> {
        let services = scenario["services"]
            .as_array()
            .ok_or("scenario.services must be an array")?;
        if services.len() > 128 {
            return fail("At most 128 planned services per query");
        }
        let days = self.planned_service_days(date);
        let clock = self
            .timetable
            .as_ref()
            .and_then(|t| t.coverage_end)
            .map_or(DEFAULT_PLANNED_CLOCK_SECONDS, f64::from);
        let mut planned = Planned {
            direction_offsets: vec![0],
            ..Default::default()
        };
        let mut seen = HashMap::new();
        // Original trips and routes that replacements remove, each owned by
        // one service; resolved against the timetable in a single scan.
        let mut replaced_trips: HashMap<(String, i64), usize> = HashMap::new();
        let mut replaced_routes: HashMap<String, usize> = HashMap::new();
        // Runs on the days around the query date follow every service-date
        // run, so service-date runs keep their order and identities.
        let mut adjacent_runs = vec![];
        for (service_index, s) in services.iter().enumerate() {
            for key in s
                .as_object()
                .ok_or("Each service must be an object")?
                .keys()
            {
                if ![
                    "id",
                    "name",
                    "operation",
                    "stops",
                    "scheduleMode",
                    "sourceRouteId",
                    "scheduledTrips",
                    "bidirectional",
                    "averageSpeedKph",
                    "dwellMinutes",
                    "timeModel",
                    "addedStopDwellMinutes",
                    "startMinutes",
                    "endMinutes",
                    "headwayMinutes",
                    "exactTimes",
                    "timetables",
                    "timing",
                    "phaseFrom",
                    "segmentDistancesKm",
                    "segmentRuntimeMinutes",
                ]
                .contains(&key.as_str())
                {
                    return fail(format!("Unknown planned service field: {key}"));
                }
            }
            for key in ["operation", "scheduleMode"] {
                if s.get(key).is_some_and(|v| !v.is_string()) {
                    return fail(format!("{key} must be a string"));
                }
            }
            let operation = s["operation"].as_str().unwrap_or("add");
            if !["add", "augment", "replace"].contains(&operation) {
                return fail("Scenario operation must be add, augment, or replace");
            }
            let stops = s["stops"]
                .as_array()
                .filter(|a| a.len() >= 2)
                .ok_or("Each planned service requires at least two stops")?;
            let mut indexes = vec![];
            for (i, stop) in stops.iter().enumerate() {
                let point = self.point(stop)?;
                let key = format!("{:?}:{:?}", point.stop, point.coordinate);
                let index = if let Some(&n) = seen.get(&key) {
                    n
                } else {
                    let n = planned.points.len() as u32;
                    seen.insert(key, n);
                    planned.points.push(point);
                    planned.ids.push(
                        stop["id"]
                            .as_str()
                            .map(str::to_owned)
                            .unwrap_or(format!("scenario:{service_index}:{i}")),
                    );
                    planned.labels.push(
                        stop["label"]
                            .as_str()
                            .or(stop["name"].as_str())
                            .filter(|label| !label.is_empty())
                            .map(str::to_owned)
                            .unwrap_or(format!("Planned stop {}", n + 1)),
                    );
                    n
                };
                indexes.push(index);
            }
            if planned.points.len() > 256 {
                return fail("At most 256 unique planned stops per query");
            }
            let preserve = s["scheduleMode"]
                .as_str()
                .unwrap_or(if operation == "replace" {
                    "preserve-trips"
                } else {
                    "frequency"
                });
            if preserve != "preserve-trips" && s.get("timing").is_some() {
                return fail("timing requires scheduleMode preserve-trips");
            }
            if operation == "replace" {
                if let Some(trips) = s["scheduledTrips"].as_array() {
                    for trip in trips {
                        let id = trip["tripId"]
                            .as_str()
                            .ok_or("A replacement scheduledTrip requires its original tripId")?;
                        if replaced_trips
                            .insert((id.to_owned(), trip_service_day(trip)?), service_index)
                            .is_some_and(|owner| owner != service_index)
                        {
                            return fail(format!(
                                "Trip {id} is replaced by more than one planned service"
                            ));
                        }
                    }
                } else if preserve == "frequency" {
                    let route = s["sourceRouteId"]
                        .as_str()
                        .ok_or("Frequency replacement requires sourceRouteId")?;
                    if replaced_routes
                        .insert(route.to_owned(), service_index)
                        .is_some()
                    {
                        return fail(format!(
                            "Route {route} is replaced by more than one planned service"
                        ));
                    }
                }
            }
            if s.get("phaseFrom").is_some() && self.frequency_sample.is_none() {
                return fail("Frequency phasing requires a monteCarlo analysis");
            }
            let exact = flag(s, "exactTimes", false)?;
            if preserve != "frequency" && s.get("timetables").is_some() {
                return fail("timetables requires scheduleMode frequency");
            }
            let all = vec![1; indexes.len()];
            if preserve == "preserve-trips" {
                if flag(s, "bidirectional", false)? {
                    return fail("Preserved trips cannot invent reverse departures");
                }
                let trips=s["scheduledTrips"].as_array().ok_or("preserve-trips requires explicit scheduledTrips with original trip IDs and arrival/departure offsets")?;
                for trip in trips {
                    for key in trip
                        .as_object()
                        .ok_or("Each scheduledTrip must be an object")?
                        .keys()
                    {
                        if ![
                            "tripId",
                            "departureSeconds",
                            "arrivalOffsetsSeconds",
                            "departureOffsetsSeconds",
                            "canBoard",
                            "canAlight",
                            "serviceDayOffset",
                        ]
                        .contains(&key.as_str())
                        {
                            return fail(format!("Unknown scheduledTrip field: {key}"));
                        }
                    }
                    let start = number(trip, "departureSeconds", 0., 0., 1_048_575.)?;
                    let day = trip_service_day(trip)?;
                    let mut departures = vec_f64(&trip["departureOffsetsSeconds"])?;
                    let mut arrivals = vec_f64(&trip["arrivalOffsetsSeconds"])?;
                    if let Some(timing) = s.get("timing") {
                        adjust_timing(timing, &mut departures, &mut arrivals)?;
                    }
                    let run = PlannedRun {
                        indexes: indexes.clone(),
                        departures,
                        arrivals,
                        board: permissions(trip.get("canBoard"), indexes.len())?,
                        alight: permissions(trip.get("canAlight"), indexes.len())?,
                        start,
                        end: start,
                        headway: 1.,
                        inbound: false,
                        random: false,
                        entry: String::new(),
                        service: service_index,
                        day,
                    };
                    if day == 0 {
                        planned.push(run)?;
                        continue;
                    }
                    // A trip of another service day runs on its own clock.
                    let offset = days
                        .iter()
                        .find(|d| d.delta == day)
                        .map(|d| d.offset)
                        .ok_or_else(|| {
                            format!(
                                "The service date {day:+} days away has no unambiguous local start"
                            )
                        })?;
                    adjacent_runs.extend(run.shifted(offset).on_clock(clock));
                }
            } else if preserve == "frequency" {
                let speed = number(s, "averageSpeedKph", 22., 1., 300.)?;
                let dwell = number(s, "dwellMinutes", 0.35, 0., 60.)? * 60.;
                let rows = frequency_rows(s, exact)?;
                let segment = |field: &str| -> Result<Option<Vec<f64>>> {
                    s.get(field)
                        .map(|v| {
                            let a = vec_f64(v)?;
                            if a.len() != indexes.len() - 1 {
                                return fail(format!("{field} must have one value per stop pair"));
                            }
                            Ok(a)
                        })
                        .transpose()
                };
                let distances = segment("segmentDistancesKm")?;
                let runtimes = segment("segmentRuntimeMinutes")?;
                let model = s
                    .get("timeModel")
                    .map(|v| v.as_str().ok_or("timeModel must be a string"))
                    .transpose()?
                    .unwrap_or("estimate-distance");
                if !["estimate-distance", "preserve-scheduled", "infer-road"].contains(&model) {
                    return fail("Invalid scenario timeModel");
                }
                if model == "infer-road" && distances.is_none() && runtimes.is_none() {
                    return fail("infer-road requires supplied segment distances or runtimes");
                }
                let points = &planned.points;
                let latitude = indexes
                    .iter()
                    .map(|&i| points[i as usize].coordinate[1])
                    .sum::<f64>()
                    / indexes.len() as f64;
                let lon_scale = (111.32 * latitude.to_radians().cos()).max(12.);
                let added_dwell = number(s, "addedStopDwellMinutes", 0., 0., 10.)? * 60.;
                // The running time of each stop pair in travel order and the
                // dwell at the stop it arrives at.
                let stop_times = |reverse: bool| {
                    let (mut running, mut dwells) = (vec![], vec![]);
                    for i in 1..indexes.len() {
                        let previous = if reverse { indexes.len() - i } else { i - 1 };
                        let next = if reverse { previous - 1 } else { i };
                        let segment = previous.min(next);
                        let a = points[indexes[previous] as usize].coordinate;
                        let b = points[indexes[next] as usize].coordinate;
                        let inferred = ((b[0] - a[0]) * lon_scale).hypot((b[1] - a[1]) * 111.32);
                        let distance = if model == "infer-road" {
                            distances.as_ref().map(|d| d[segment]).unwrap_or(inferred)
                        } else {
                            inferred
                        };
                        match runtimes.as_ref().filter(|_| model != "estimate-distance") {
                            Some(r) => {
                                running.push(r[segment] * 60.);
                                let added = ["inserted", "added"]
                                    .iter()
                                    .any(|e| stops[next]["editStatus"] == *e);
                                dwells.push(if added { added_dwell } else { 0. });
                            }
                            None => {
                                running.push(distance / speed * 3600.);
                                dwells.push(dwell);
                            }
                        }
                    }
                    run_stop_times(&running, &dwells)
                };
                let outbound = stop_times(false);
                let inbound = stop_times(true);
                let reversed: Vec<u32> = indexes.iter().rev().copied().collect();
                let bidirectional = flag(s, "bidirectional", true)?;
                let sampled = self.frequency_sample.is_some();
                for row in &rows {
                    for window in row.windows(&days, clock, sampled) {
                        for (pattern, (departures, arrivals), reverse) in
                            [(&indexes, &outbound, false), (&reversed, &inbound, true)]
                        {
                            if reverse && !bidirectional {
                                continue;
                            }
                            let run =
                                |start: f64, end: f64, headway: f64, random: bool| PlannedRun {
                                    indexes: pattern.clone(),
                                    departures: departures.clone(),
                                    arrivals: arrivals.clone(),
                                    board: all.clone(),
                                    alight: all.clone(),
                                    start,
                                    end,
                                    headway,
                                    inbound: reverse,
                                    random,
                                    entry: window.entry.clone(),
                                    service: service_index,
                                    day: window.day,
                                };
                            if window.start <= window.end {
                                let grid = run(window.start, window.end, row.headway, !row.exact);
                                if window.day == 0 {
                                    planned.push(grid)?;
                                } else {
                                    adjacent_runs.push(grid);
                                }
                            }
                            // Runs that left before midnight and are still
                            // on the road after it, latest first.
                            if let Some((first, last)) = window.earlier {
                                let duration = departures.last().copied().unwrap_or(0.);
                                let mut departure = last;
                                while departure >= first && departure + duration > 0. {
                                    adjacent_runs.extend(
                                        run(departure, departure, 1., false).on_clock(clock),
                                    );
                                    departure -= row.headway;
                                }
                            }
                        }
                    }
                }
            } else {
                return fail("scheduleMode must be frequency or preserve-trips");
            }
        }
        for run in adjacent_runs {
            planned.push(run)?;
        }
        if !replaced_trips.is_empty() || !replaced_routes.is_empty() {
            self.resolve_replacements(&mut planned, &replaced_trips, &replaced_routes, date)?;
        }
        Ok(planned)
    }

    /// The service days whose frequency windows can reach the query date's
    /// clock: days after `date`, seconds from its service-day origin to theirs
    /// (DST-aware, as the scheduled timetable places them) and ISO weekday.
    /// Days without an unambiguous local origin are skipped.
    fn planned_service_days(&self, date: NaiveDate) -> Vec<ServiceDay> {
        let zone: Option<chrono_tz::Tz> = self.metadata["agencyTimezones"]
            .as_array()
            .and_then(|a| a.first())
            .and_then(Value::as_str)
            .unwrap_or("UTC")
            .parse()
            .ok();
        let epoch = |day: NaiveDate| zone.and_then(|z| super::calendar::service_epoch(z, day).ok());
        let origin = epoch(date);
        PLANNED_DAY_DELTAS
            .filter_map(|delta| {
                let day = date.checked_add_signed(chrono::Duration::days(delta))?;
                let offset = if delta == 0 { 0 } else { epoch(day)? - origin? };
                Some(ServiceDay {
                    delta,
                    offset: offset as f64,
                    weekday: day.weekday().number_from_monday() as u8,
                })
            })
            .collect()
    }

    /// Cancel every instance of each replaced trip and route. A replaced trip
    /// must run on the query date; the active timetable may also hold its
    /// instances from adjacent service days, which are removed alike.
    fn resolve_replacements(
        &self,
        planned: &mut Planned,
        trips: &HashMap<(String, i64), usize>,
        routes: &HashMap<String, usize>,
        date: NaiveDate,
    ) -> Result<()> {
        let t = self.timetable.as_ref().ok_or("Timetable is not active")?;
        let replaced: HashSet<&str> = trips.keys().map(|(id, _)| id.as_str()).collect();
        // The service date each replaced trip names, by its days from `date`.
        let dates: HashMap<String, i64> = trips
            .keys()
            .filter_map(|&(_, day)| {
                let named = date.checked_add_signed(chrono::Duration::days(day))?;
                Some((named.to_string(), day))
            })
            .collect();
        let mut found = HashSet::new();
        let mut active_routes = HashSet::new();
        for (index, (trip, route)) in t.trip_ids.iter().zip(t.route_ids.iter()).enumerate() {
            let replaced_trip = replaced.contains(trip.as_str());
            let replaced_route = routes.contains_key(route.as_str());
            if !replaced_trip && !replaced_route {
                continue;
            }
            planned.excluded_trips.push(index as u32);
            if replaced_trip {
                // A timetable of one service day records no dates.
                match t.trip_service_dates.get(index).filter(|d| !d.is_empty()) {
                    Some(day) => {
                        if let Some(&offset) = dates.get(day) {
                            found.insert((trip.as_str(), offset));
                        }
                    }
                    None => {
                        found.insert((trip.as_str(), 0));
                    }
                }
            }
            if replaced_route {
                active_routes.insert(route.as_str());
            }
        }
        // Report the first problem in request order, not hash order.
        if let Some(((id, day), _)) = trips
            .iter()
            .filter(|((id, day), _)| !found.contains(&(id.as_str(), *day)))
            .min_by_key(|((id, day), service)| (**service, *day, id.as_str()))
        {
            let named = date
                .checked_add_signed(chrono::Duration::days(*day))
                .map_or_else(|| format!("{day:+} days"), |d| d.to_string());
            return fail(if *day == 0 {
                format!("Replacement trip {id} is not active on the service date")
            } else {
                format!("Replacement trip {id} is not active on {named}")
            });
        }
        if let Some((route, _)) = routes
            .iter()
            .filter(|(route, _)| !active_routes.contains(route.as_str()))
            .min_by_key(|(route, service)| (**service, route.as_str()))
        {
            return fail(format!("Replacement route {route} has no active trips"));
        }
        Ok(())
    }
}

/// One planned run: a frequency window or one kept trip over a stop pattern.
struct PlannedRun {
    indexes: Vec<u32>,
    departures: Vec<f64>,
    arrivals: Vec<f64>,
    board: Vec<u8>,
    alight: Vec<u8>,
    start: f64,
    end: f64,
    headway: f64,
    inbound: bool,
    random: bool,
    entry: String,
    service: usize,
    day: i64,
}

impl PlannedRun {
    /// This run `seconds` later on the query date's clock.
    fn shifted(mut self, seconds: f64) -> Self {
        self.start += seconds;
        self.end += seconds;
        self
    }

    /// This single run as the query date's clock holds it: its calls before
    /// midnight, where no query on that date can board, are left out. None
    /// when it starts after `clock` or no stop pair remains after midnight.
    fn on_clock(mut self, clock: f64) -> Option<Self> {
        if self.start > clock {
            return None;
        }
        let first = self
            .departures
            .iter()
            .position(|&offset| self.start + offset >= 0.)?;
        if first + 1 >= self.indexes.len() {
            return None;
        }
        if first > 0 {
            let base = self.departures[first];
            self.indexes.drain(..first);
            self.departures.drain(..first);
            self.arrivals.drain(..first);
            self.board.drain(..first);
            self.alight.drain(..first);
            for offset in &mut self.departures {
                *offset -= base;
            }
            for offset in &mut self.arrivals {
                *offset = (*offset - base).max(0.);
            }
            self.start += base;
            self.end = self.start;
        }
        Some(self)
    }
}

/// The days from the query's service date to the service date a kept trip
/// runs on; its `departureSeconds` is on that day's clock.
fn trip_service_day(trip: &Value) -> Result<i64> {
    match trip.get("serviceDayOffset") {
        None => Ok(0),
        Some(value) => value
            .as_i64()
            .filter(|day| PLANNED_DAY_DELTAS.contains(day))
            .ok_or_else(|| "serviceDayOffset must be an integer from -3 through 3".into()),
    }
}

impl Planned {
    fn push(&mut self, run: PlannedRun) -> Result<()> {
        if [
            run.departures.len(),
            run.arrivals.len(),
            run.board.len(),
            run.alight.len(),
        ]
        .iter()
        .any(|&n| n != run.indexes.len())
        {
            return fail("Each schedule offset/permission array must match the service stops");
        }
        self.direction_stops.extend_from_slice(&run.indexes);
        if self.direction_stops.len() > 1_000_000 {
            return fail("Planned timetable exceeds one million stop events");
        }
        self.departures.extend(run.departures);
        self.arrivals.extend(run.arrivals);
        self.board.extend(run.board);
        self.alight.extend(run.alight);
        self.direction_offsets
            .push(self.direction_stops.len() as u32);
        self.starts.push(run.start);
        self.ends.push(run.end);
        self.headways.push(run.headway);
        self.random.push(run.random);
        self.run_entries.push(run.entry);
        self.run_services.push(run.service);
        self.run_inbound.push(run.inbound);
        self.run_days.push(run.day);
        Ok(())
    }
}

/// Departure and arrival offsets of a run from its stop pairs' running
/// seconds and the dwell at each pair's arrival stop. A vehicle arrives,
/// dwells, then departs; it does not dwell at its first or last stop.
fn run_stop_times(running: &[f64], dwells: &[f64]) -> (Vec<f64>, Vec<f64>) {
    let mut departures = vec![0.];
    let mut arrivals = vec![0.];
    for (pair, (&run, &dwell)) in running.iter().zip(dwells).enumerate() {
        let arrival = departures[pair] + run;
        arrivals.push(arrival);
        departures.push(if pair + 1 == running.len() {
            arrival
        } else {
            arrival + dwell
        });
    }
    (departures, arrivals)
}
fn adjust_timing(value: &Value, departures: &mut [f64], arrivals: &mut [f64]) -> Result<()> {
    let timing: vigo_model::ServiceTiming = serde_json::from_value(value.clone())?;
    if departures.len() < 2
        || arrivals.len() != departures.len()
        || departures[0] != 0.
        || arrivals[0] != 0.
    {
        return fail("Timing edits require matching schedule offsets starting at zero");
    }
    let speed = number(value, "speedFactor", 1., 0.1, 10.)?;
    let scale = number(value, "dwellScale", 1., 0., 10.)?;
    let dwell = timing
        .dwell_minutes
        .map(|_| number(value, "dwellMinutes", 0., 0., 60.))
        .transpose()?;
    if dwell.is_some() && timing.dwell_scale.is_some() {
        return fail("Choose dwellMinutes or dwellScale, not both");
    }
    let selected = |indexes: &Option<Vec<u32>>, min: usize, max: usize| -> Result<Vec<bool>> {
        let mut selected = vec![indexes.is_none(); departures.len()];
        if let Some(indexes) = indexes {
            if indexes.is_empty() {
                return fail("Timing selections must not be empty");
            }
            for &index in indexes {
                let index = index as usize;
                if index < min || index >= max || selected[index] {
                    return fail("Timing indexes must be distinct and inside the service pattern");
                }
                selected[index] = true;
            }
        }
        Ok(selected)
    };
    let segments = selected(&timing.segment_indexes, 0, departures.len() - 1)?;
    let stops = selected(&timing.stop_indexes, 1, departures.len())?;
    let mut original_previous = departures[0];
    for i in 1..departures.len() {
        let running = arrivals[i] - original_previous;
        let standing = departures[i] - arrivals[i];
        original_previous = departures[i];
        if running < 0. || standing < 0. {
            return fail("Cannot adjust non-monotone schedule offsets");
        }
        arrivals[i] = departures[i - 1] + running / if segments[i - 1] { speed } else { 1. };
        departures[i] = arrivals[i]
            + if stops[i] {
                dwell.map_or(standing * scale, |m| m * 60.)
            } else {
                standing
            };
        if !departures[i].is_finite() || departures[i] > 1_048_575. {
            return fail("Adjusted schedule exceeds the supported time range");
        }
    }
    Ok(())
}

/// A service day around the query date: days after it, seconds from its
/// service-day origin, and ISO weekday.
struct ServiceDay {
    delta: i64,
    offset: f64,
    weekday: u8,
}

/// One frequency timetable row: departures every `headway` seconds from
/// `start` through `end` on its weekdays, on its own service day's clock.
/// Times are whole seconds, so every consumer expands the same departures.
struct FrequencyRow {
    id: String,
    start: f64,
    end: f64,
    headway: f64,
    exact: bool,
    exclusive: bool,
    weekdays: Option<Vec<u8>>,
}

/// A row's departure window on one service day, on the query date's clock.
/// `start..=end` is its departure grid from the query date's midnight, empty
/// when `start > end`; `earlier` holds the first and last grid departures
/// before that midnight, whose runs may still be on the road after it.
#[derive(Debug, PartialEq)]
struct RunWindow {
    entry: String,
    day: i64,
    start: f64,
    end: f64,
    earlier: Option<(f64, f64)>,
}

impl FrequencyRow {
    /// The row's window on each service day it runs whose departures reach
    /// the query date's clock `[0, clock]`. The service date's window is
    /// kept whole. Another day's window keeps its departure grid, starts at
    /// or after the query date's midnight, ends by `clock`, and leaves out
    /// departures its neighbor toward the service date already runs.
    fn windows(&self, days: &[ServiceDay], clock: f64, sampled: bool) -> Vec<RunWindow> {
        // A sampled schedule draws its phase over the whole service window.
        let sampled = sampled && !self.exact;
        let last = if sampled || !self.exclusive {
            self.end
        } else {
            self.end - 1.
        };
        let headway = self.headway;
        let mut windows: Vec<Option<RunWindow>> = days
            .iter()
            .map(|day| {
                if self
                    .weekdays
                    .as_ref()
                    .is_some_and(|weekdays| !weekdays.contains(&day.weekday))
                {
                    return None;
                }
                let (mut start, mut end) = (self.start + day.offset, last + day.offset);
                let mut earlier = None;
                if day.delta != 0 {
                    if start > clock {
                        return None;
                    }
                    if start < 0. {
                        // The grid's last departure before midnight, if any.
                        let before = (start + ((-start / headway).ceil() - 1.) * headway)
                            .min(start + ((end - start) / headway).floor() * headway);
                        earlier = (!sampled && before >= start).then_some((start, before));
                        start += (-start / headway).ceil() * headway;
                    }
                    end = end.min(clock);
                    if start > end && earlier.is_none() {
                        return None;
                    }
                }
                Some(RunWindow {
                    entry: if day.delta == 0 {
                        self.id.clone()
                    } else {
                        format!("{}@{:+}", self.id, day.delta)
                    },
                    day: day.delta,
                    start,
                    end,
                    earlier,
                })
            })
            .collect();
        let Some(zero) = days.iter().position(|day| day.delta == 0) else {
            return windows.into_iter().flatten().collect();
        };
        if !sampled {
            // Departures on the same grid as the neighbor's are one vehicle.
            let last_departure =
                |w: &RunWindow| w.start + ((w.end - w.start) / headway).floor() * headway;
            let aligned = |a: f64, b: f64| ((a - b) % headway).abs() < 0.5;
            for i in zero + 1..windows.len() {
                let previous = windows[i - 1].as_ref().map(last_departure);
                let empty = match (previous, windows[i].as_mut()) {
                    (Some(previous), Some(w)) => {
                        if w.start <= previous && aligned(previous, w.start) {
                            w.start = previous + headway;
                        }
                        w.start > w.end && w.earlier.is_none()
                    }
                    _ => false,
                };
                if empty {
                    windows[i] = None;
                }
            }
            for i in (0..zero).rev() {
                let next = windows[i + 1].as_ref().map(|w| w.start);
                let empty = match (next, windows[i].as_mut()) {
                    (Some(next), Some(w)) => {
                        if last_departure(w) >= next && aligned(next, w.start) {
                            w.end = next - headway;
                        }
                        w.start > w.end && w.earlier.is_none()
                    }
                    _ => false,
                };
                if empty {
                    windows[i] = None;
                }
            }
        }
        windows.into_iter().flatten().collect()
    }
}

fn frequency_rows(s: &Value, exact: bool) -> Result<Vec<FrequencyRow>> {
    let read = |entry: &Value,
                id: String,
                exact: bool,
                exclusive: bool,
                weekdays: Option<Vec<u8>>|
     -> Result<FrequencyRow> {
        let start = (number(entry, "startMinutes", 300., 0., 4319.)? * 60.).round();
        let end = (number(entry, "endMinutes", 1500., 0., 4319.)? * 60.).round();
        let headway = (number(entry, "headwayMinutes", 12., 0.1, 1440.)? * 60.)
            .round()
            .max(1.);
        if end <= start {
            return fail(
                "Frequency service endMinutes must exceed startMinutes by at least one second",
            );
        }
        Ok(FrequencyRow {
            id,
            start,
            end,
            headway,
            exact,
            exclusive,
            weekdays,
        })
    };
    let Some(rows) = s.get("timetables") else {
        return Ok(vec![read(s, String::new(), exact, exact, None)?]);
    };
    let rows = rows
        .as_array()
        .filter(|a| !a.is_empty() && a.len() <= 32)
        .ok_or("timetables must contain 1 to 32 rows")?;
    let mut ids = HashSet::new();
    let mut entries = vec![];
    for row in rows {
        let typed: vigo_model::ScenarioTimetable = serde_json::from_value(row.clone())?;
        if typed.id.trim().is_empty() || typed.id.len() > 160 || !ids.insert(typed.id.clone()) {
            return fail("Timetable IDs must be unique, nonempty and at most 160 bytes");
        }
        if let Some(days) = &typed.days_of_week
            && (days.is_empty()
                || days.len() > 7
                || days.iter().any(|d| !(1..=7).contains(d))
                || days.iter().collect::<HashSet<_>>().len() != days.len())
        {
            return fail(
                "daysOfWeek must list distinct ISO weekdays from 1 (Monday) through 7 (Sunday)",
            );
        }
        let exact = typed.exact_times.unwrap_or(exact);
        entries.push(read(row, typed.id, exact, true, typed.days_of_week)?);
    }
    Ok(entries)
}

fn vec_f64(v: &Value) -> Result<Vec<f64>> {
    v.as_array()
        .ok_or_else(|| "Expected a numeric array".into())
        .and_then(|v| {
            v.iter()
                .map(|v| {
                    v.as_f64()
                        .filter(|n| n.is_finite() && *n >= 0.)
                        .ok_or_else(|| "Schedule values must be finite and nonnegative".into())
                })
                .collect()
        })
}
fn permissions(v: Option<&Value>, n: usize) -> Result<Vec<u8>> {
    v.map_or(Ok(vec![1; n]), |v| {
        v.as_array()
            .ok_or_else(|| "Permission array required".into())
            .and_then(|a| {
                a.iter()
                    .map(|v| {
                        v.as_u64()
                            .filter(|n| *n <= 1)
                            .map(|n| n as u8)
                            .ok_or_else(|| "Permission must be 0 or 1".into())
                    })
                    .collect()
            })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(start: f64, end: f64, headway: f64, exclusive: bool) -> FrequencyRow {
        FrequencyRow {
            id: "row".into(),
            start,
            end,
            headway,
            exact: exclusive,
            exclusive,
            weekdays: None,
        }
    }
    /// Tuesday, Wednesday (the query date) and Thursday, without DST.
    fn days() -> Vec<ServiceDay> {
        [(-1, 2), (0, 3), (1, 4)]
            .into_iter()
            .map(|(delta, weekday)| ServiceDay {
                delta,
                offset: delta as f64 * 86_400.,
                weekday,
            })
            .collect()
    }
    /// Each window's departure grid from the query date's midnight.
    fn spans(windows: &[RunWindow]) -> Vec<(i64, f64, f64)> {
        windows
            .iter()
            .filter(|w| w.start <= w.end)
            .map(|w| (w.day, w.start, w.end))
            .collect()
    }
    fn run(departures: &[f64], arrivals: &[f64], start: f64) -> PlannedRun {
        let n = departures.len();
        PlannedRun {
            indexes: (0..n as u32).collect(),
            departures: departures.to_vec(),
            arrivals: arrivals.to_vec(),
            board: vec![1; n],
            alight: vec![1; n],
            start,
            end: start,
            headway: 1.,
            inbound: false,
            random: false,
            entry: String::new(),
            service: 0,
            day: -1,
        }
    }

    #[test]
    fn vehicles_dwell_after_arriving_and_not_at_terminals() {
        let (departures, arrivals) = run_stop_times(&[60., 120., 90.], &[30., 30., 30.]);
        assert_eq!(departures, vec![0., 90., 240., 330.]);
        assert_eq!(arrivals, vec![0., 60., 210., 330.]);
        assert_eq!(run_stop_times(&[], &[]), (vec![0.], vec![0.]));
    }

    #[test]
    fn frequency_service_runs_into_and_from_adjacent_service_days() {
        // 05:00–25:00 every 10 minutes: the previous day's tail runs
        // 00:00–01:00, and the next day starts at 29:00 within the clock.
        let windows = row(18_000., 90_000., 600., false).windows(&days(), 108_000., false);
        assert_eq!(
            spans(&windows),
            vec![
                (-1, 0., 3_600.),
                (0, 18_000., 90_000.),
                (1, 104_400., 108_000.)
            ]
        );
        assert_eq!(windows[0].entry, "row@-1");
        assert_eq!(windows[1].entry, "row");
        // The previous day's runs from 05:00 to 23:50 left before midnight.
        assert_eq!(windows[0].earlier, Some((-68_400., -600.)));
        assert_eq!(windows[1].earlier, None);
        // A clock that ends at midnight leaves the next day out.
        let short = row(18_000., 90_000., 600., false).windows(&days(), 86_400., false);
        assert_eq!(spans(&short).len(), 2);
    }

    #[test]
    fn abutting_service_days_never_run_one_departure_twice() {
        // An inclusive 24-hour window: 00:00 and 24:00 each run once.
        let windows = row(0., 86_400., 600., false).windows(&days(), 108_000., false);
        assert_eq!(
            spans(&windows),
            vec![(0, 0., 86_400.), (1, 87_000., 108_000.)]
        );
        // The previous day's 24:00 is the query date's 00:00, but its runs
        // before midnight remain.
        assert_eq!(windows[0].earlier, Some((-86_400., -600.)));
        // An end-exclusive window abuts the next day's first departure.
        let exact = row(0., 86_400., 600., true).windows(&days(), 108_000., false);
        assert_eq!(
            spans(&exact),
            vec![(0, 0., 86_399.), (1, 86_400., 108_000.)]
        );
        // Overlapping days on one grid share their common departures.
        let long = row(0., 93_600., 600., true).windows(&days(), 108_000., false);
        assert_eq!(spans(&long), vec![(0, 0., 93_599.), (1, 93_600., 108_000.)]);
        // A 25-hour DST day keeps a 10-minute grid, so the overlap is shared;
        // it shifts a 7-minute grid, whose departures are all distinct.
        let mut dst = days();
        dst[2].offset = 90_000.;
        let aligned = row(0., 93_600., 600., true).windows(&dst, 108_000., false);
        assert_eq!(spans(&aligned)[1], (1, 93_600., 108_000.));
        let shifted = row(0., 93_600., 420., true).windows(&dst, 108_000., false);
        assert_eq!(
            spans(&shifted),
            vec![(-1, 120., 7_199.), (0, 0., 93_599.), (1, 90_000., 108_000.)]
        );
    }

    #[test]
    fn weekdays_and_sampled_windows_follow_their_own_day() {
        let mut weekday = row(18_000., 90_000., 600., true);
        weekday.weekdays = Some(vec![2]);
        // Tuesday's service ends at 00:59:59 on Wednesday, the query date.
        assert_eq!(
            spans(&weekday.windows(&days(), 108_000., false)),
            vec![(-1, 0., 3_599.)]
        );
        // A sampled schedule keeps its whole window for the phase draw.
        let mut sampled = row(0., 86_400., 600., false);
        sampled.exact = false;
        let windows = sampled.windows(&days(), 108_000., true);
        assert_eq!(
            spans(&windows),
            vec![(-1, 0., 0.), (0, 0., 86_400.), (1, 86_400., 108_000.)]
        );
        assert!(windows.iter().all(|w| w.earlier.is_none()));
        // A window wholly before midnight still offers its last runs.
        let evening = row(64_800., 86_400., 600., true).windows(&days(), 108_000., false);
        assert_eq!(spans(&evening), vec![(0, 64_800., 86_399.)]);
        assert_eq!(evening[0].earlier, Some((-21_600., -600.)));
    }

    #[test]
    fn runs_keep_only_their_calls_after_midnight() {
        // Departs 23:50, calls at 23:55 (arrives 23:54) and 00:05, ends 00:15.
        let trimmed = run(&[0., 300., 900., 1_500.], &[0., 240., 840., 1_500.], -600.)
            .on_clock(108_000.)
            .unwrap();
        assert_eq!(trimmed.indexes, vec![2, 3]);
        assert_eq!(trimmed.start, 300.);
        assert_eq!(trimmed.departures, vec![0., 600.]);
        assert_eq!(trimmed.arrivals, vec![0., 600.]);
        // A run that only arrives after midnight offers no boarding.
        assert!(
            run(&[0., 900.], &[0., 900.], -600.)
                .on_clock(108_000.)
                .is_none()
        );
        // A previous day's 24:30 trip is the query date's 00:30.
        let placed = run(&[0., 600.], &[0., 600.], 88_200.)
            .shifted(-86_400.)
            .on_clock(108_000.)
            .unwrap();
        assert_eq!((placed.start, placed.indexes.len()), (1_800., 2));
        assert!(
            run(&[0., 600.], &[0., 600.], 120_000.)
                .on_clock(108_000.)
                .is_none()
        );
    }
}
