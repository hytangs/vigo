//! Compile portable frequency or explicit-trip service edits to the shared Rust overlay scan.
use super::query::{Options, Point};
use super::{City, Result, fail, flag, number};
use crate::{StreetMatrixInput, TimetableManyQueryInput, TimetableOverlayManyQueryInput};
use chrono::{Datelike, NaiveDate};
use serde_json::{Value, json};
use std::collections::HashMap;

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
        let mut points: Vec<Point> = vec![];
        let mut ids = vec![];
        let mut seen = HashMap::new();
        let mut direction_offsets = vec![0];
        let mut direction_stops = vec![];
        let mut departures = vec![];
        let mut arrivals = vec![];
        let mut board = vec![];
        let mut alight = vec![];
        let mut starts = vec![];
        let mut ends = vec![];
        let mut headways = vec![];
        let mut random = vec![];
        let mut labels = vec![];
        let mut run_services = vec![];
        let mut run_inbound = vec![];
        let mut run_entries = vec![];
        let mut excluded_trips = vec![];
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
                    let n = points.len() as u32;
                    seen.insert(key, n);
                    points.push(point);
                    ids.push(
                        stop["id"]
                            .as_str()
                            .map(str::to_owned)
                            .unwrap_or(format!("scenario:{service_index}:{i}")),
                    );
                    labels.push(
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
            if points.len() > 256 {
                return fail("At most 256 unique planned stops per query");
            }
            let preserve = s["scheduleMode"]
                .as_str()
                .unwrap_or(if operation == "replace" {
                    "preserve-trips"
                } else {
                    "frequency"
                });
            let t = self.timetable.as_ref().unwrap();
            if preserve != "preserve-trips" && s.get("timing").is_some() {
                return fail("timing requires scheduleMode preserve-trips");
            }
            if operation == "replace" {
                if let Some(trips) = s["scheduledTrips"].as_array() {
                    for trip in trips {
                        let id = trip["tripId"]
                            .as_str()
                            .ok_or("A replacement scheduledTrip requires its original tripId")?;
                        let index = t
                            .trip_ids
                            .iter()
                            .position(|v| v == id)
                            .ok_or("Replacement trip is not active on the service date")?;
                        excluded_trips.push(index as u32);
                    }
                } else if preserve == "frequency" {
                    let route = s["sourceRouteId"]
                        .as_str()
                        .ok_or("Frequency replacement requires sourceRouteId")?;
                    let selected = t
                        .route_ids
                        .iter()
                        .enumerate()
                        .filter(|(_, id)| id.as_str() == route)
                        .map(|(i, _)| i as u32)
                        .collect::<Vec<_>>();
                    if selected.is_empty() {
                        return fail("Replacement route has no active trips");
                    }
                    excluded_trips.extend(selected);
                }
            }
            if s.get("phaseFrom").is_some() && self.frequency_sample.is_none() {
                return fail("Frequency phasing requires a monteCarlo analysis");
            }
            let exact = flag(s, "exactTimes", false)?;
            if preserve != "frequency" && s.get("timetables").is_some() {
                return fail("timetables requires scheduleMode frequency");
            }
            let mut add_direction = |indexes: &[u32],
                                     dep: Vec<f64>,
                                     arr: Vec<f64>,
                                     b: Vec<u8>,
                                     a: Vec<u8>,
                                     start: f64,
                                     end: f64,
                                     headway: f64,
                                     inbound: bool,
                                     sampled: bool,
                                     entry: &str|
             -> Result<()> {
                if [dep.len(), arr.len(), b.len(), a.len()]
                    .iter()
                    .any(|&n| n != indexes.len())
                {
                    return fail(
                        "Each schedule offset/permission array must match the service stops",
                    );
                }
                direction_stops.extend_from_slice(indexes);
                departures.extend(dep);
                arrivals.extend(arr);
                board.extend(b);
                alight.extend(a);
                direction_offsets.push(direction_stops.len() as u32);
                starts.push(start);
                ends.push(end);
                headways.push(headway);
                random.push(sampled);
                run_entries.push(entry.to_owned());
                run_services.push(service_index);
                run_inbound.push(inbound);
                Ok(())
            };
            if preserve == "preserve-trips" {
                if flag(s, "bidirectional", false)? {
                    return fail("Preserved trips cannot invent reverse departures");
                }
                let trips=s["scheduledTrips"].as_array().ok_or("preserve-trips requires explicit scheduledTrips with original trip IDs and arrival/departure offsets")?;
                for trip in trips {
                    let start = number(trip, "departureSeconds", 0., 0., 1_048_575.)?;
                    let mut dep = vec_f64(&trip["departureOffsetsSeconds"])?;
                    let mut arr = vec_f64(&trip["arrivalOffsetsSeconds"])?;
                    if let Some(timing) = s.get("timing") {
                        adjust_timing(timing, &mut dep, &mut arr)?;
                    }
                    let b = permissions(trip.get("canBoard"), indexes.len())?;
                    let a = permissions(trip.get("canAlight"), indexes.len())?;
                    add_direction(&indexes, dep, arr, b, a, start, start, 1., false, false, "")?;
                }
            } else if preserve == "frequency" {
                let speed = number(s, "averageSpeedKph", 22., 1., 300.)?;
                let dwell = number(s, "dwellMinutes", 0.35, 0., 60.)? * 60.;
                let entries = frequency_entries(s, date, exact)?;
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
                let latitude = indexes
                    .iter()
                    .map(|&i| points[i as usize].coordinate[1])
                    .sum::<f64>()
                    / indexes.len() as f64;
                let lon_scale = (111.32 * latitude.to_radians().cos()).max(12.);
                let added_dwell = number(s, "addedStopDwellMinutes", 0., 0., 10.)? * 60.;
                let offsets = |reverse: bool| {
                    let mut dep = vec![0.];
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
                        let runtime = if model != "estimate-distance" {
                            runtimes
                                .as_ref()
                                .map(|r| {
                                    r[segment] * 60.
                                        + if ["inserted", "added"]
                                            .iter()
                                            .any(|e| stops[next]["editStatus"] == *e)
                                        {
                                            added_dwell
                                        } else {
                                            0.
                                        }
                                })
                                .unwrap_or(distance / speed * 3600. + dwell)
                        } else {
                            distance / speed * 3600. + dwell
                        };
                        dep.push(dep[i - 1] + runtime);
                    }
                    dep
                };
                let dep = offsets(false);
                let reverse = offsets(true);
                let reversed: Vec<u32> = indexes.iter().rev().copied().collect();
                for entry in entries {
                    // The overlay compiler's bound is inclusive. Every explicit
                    // timetable row uses the same end-exclusive clock as GTFS.
                    let end = if entry.exclusive {
                        entry.end - 1.
                    } else {
                        entry.end
                    };
                    add_direction(
                        &indexes,
                        dep.clone(),
                        dep.clone(),
                        vec![1; indexes.len()],
                        vec![1; indexes.len()],
                        entry.start,
                        if !entry.exact && self.frequency_sample.is_some() {
                            entry.end
                        } else {
                            end
                        },
                        entry.headway,
                        false,
                        !entry.exact,
                        &entry.id,
                    )?;
                    if flag(s, "bidirectional", true)? {
                        add_direction(
                            &reversed,
                            reverse.clone(),
                            reverse.clone(),
                            vec![1; indexes.len()],
                            vec![1; indexes.len()],
                            entry.start,
                            if !entry.exact && self.frequency_sample.is_some() {
                                entry.end
                            } else {
                                end
                            },
                            entry.headway,
                            true,
                            !entry.exact,
                            &entry.id,
                        )?;
                    }
                }
            } else {
                return fail("scheduleMode must be frequency or preserve-trips");
            }
            if direction_stops.len() > 1_000_000 {
                return fail("Planned timetable exceeds one million stop events");
            }
        }
        Ok(Planned {
            points,
            ids,
            labels,
            direction_offsets,
            direction_stops,
            departures,
            arrivals,
            board,
            alight,
            starts,
            ends,
            headways,
            random,
            run_services,
            run_inbound,
            run_entries,
            excluded_trips,
        })
    }
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

struct FrequencyEntry {
    id: String,
    start: f64,
    end: f64,
    headway: f64,
    exact: bool,
    exclusive: bool,
}

fn frequency_entries(s: &Value, date: NaiveDate, exact: bool) -> Result<Vec<FrequencyEntry>> {
    let read =
        |entry: &Value, id: String, exact: bool, exclusive: bool| -> Result<FrequencyEntry> {
            let start = number(entry, "startMinutes", 300., 0., 4319.)? * 60.;
            let end = number(entry, "endMinutes", 1500., 0., 4319.)? * 60.;
            let headway = number(entry, "headwayMinutes", 12., 0.1, 1440.)? * 60.;
            if end.round() <= start.round() {
                return fail(
                    "Frequency service endMinutes must exceed startMinutes by at least one second",
                );
            }
            Ok(FrequencyEntry {
                id,
                start,
                end,
                headway,
                exact,
                exclusive,
            })
        };
    let Some(rows) = s.get("timetables") else {
        return Ok(vec![read(s, String::new(), exact, exact)?]);
    };
    let rows = rows
        .as_array()
        .filter(|a| !a.is_empty() && a.len() <= 32)
        .ok_or("timetables must contain 1 to 32 rows")?;
    let mut ids = std::collections::HashSet::new();
    let mut entries = vec![];
    for row in rows {
        let typed: vigo_model::ScenarioTimetable = serde_json::from_value(row.clone())?;
        if typed.id.trim().is_empty() || typed.id.len() > 160 || !ids.insert(typed.id.clone()) {
            return fail("Timetable IDs must be unique, nonempty and at most 160 bytes");
        }
        let entry = read(row, typed.id, typed.exact_times.unwrap_or(exact), true)?;
        if let Some(days) = typed.days_of_week {
            if days.is_empty()
                || days.len() > 7
                || days.iter().any(|d| !(1..=7).contains(d))
                || days.iter().collect::<std::collections::HashSet<_>>().len() != days.len()
            {
                return fail(
                    "daysOfWeek must list distinct ISO weekdays from 1 (Monday) through 7 (Sunday)",
                );
            }
            if !days.contains(&(date.weekday().number_from_monday() as u8)) {
                continue;
            }
        }
        entries.push(entry);
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
