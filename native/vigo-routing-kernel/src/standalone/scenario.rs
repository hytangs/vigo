//! Compile portable frequency or explicit-trip service edits to the shared Rust overlay scan.
use super::query::{Options, Point};
use super::{City, Result, fail, flag, number};
use crate::{StreetMatrixInput, TimetableManyQueryInput, TimetableOverlayManyQueryInput};
use serde_json::{Value, json};
use std::collections::HashMap;

pub(crate) struct Overlay {
    pub input: TimetableOverlayManyQueryInput,
    pub stops: Vec<(String, [f64; 2])>,
}
impl City {
    pub(crate) fn scenario(
        &mut self,
        scenario: &Value,
        mut base: TimetableManyQueryInput,
        origin: &Point,
        opt: &Options,
    ) -> Result<Overlay> {
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
                        base.excluded_trips.push(index as u32);
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
                    base.excluded_trips.extend(selected);
                }
            }
            let mut add_direction = |indexes: &[u32],
                                     dep: Vec<f64>,
                                     arr: Vec<f64>,
                                     b: Vec<u8>,
                                     a: Vec<u8>,
                                     start: f64,
                                     end: f64,
                                     headway: f64|
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
                Ok(())
            };
            if preserve == "preserve-trips" {
                if flag(s, "bidirectional", false)? {
                    return fail("Preserved trips cannot invent reverse departures");
                }
                let trips=s["scheduledTrips"].as_array().ok_or("preserve-trips requires explicit scheduledTrips with original trip IDs and arrival/departure offsets")?;
                for trip in trips {
                    let start = number(trip, "departureSeconds", 0., 0., 1_048_575.)?;
                    let dep = vec_f64(&trip["departureOffsetsSeconds"])?;
                    let arr = vec_f64(&trip["arrivalOffsetsSeconds"])?;
                    let b = permissions(trip.get("canBoard"), indexes.len())?;
                    let a = permissions(trip.get("canAlight"), indexes.len())?;
                    add_direction(&indexes, dep, arr, b, a, start, start, 1.)?;
                }
            } else if preserve == "frequency" {
                let speed = number(s, "averageSpeedKph", 22., 1., 300.)?;
                let dwell = number(s, "dwellMinutes", 0.35, 0., 60.)? * 60.;
                let start = number(s, "startMinutes", 300., 0., 4319.)? * 60.;
                let end = number(s, "endMinutes", 1500., 0., 4319.)? * 60.;
                let headway = number(s, "headwayMinutes", 12., 0.1, 1440.)? * 60.;
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
                add_direction(
                    &indexes,
                    dep.clone(),
                    dep.clone(),
                    vec![1; indexes.len()],
                    vec![1; indexes.len()],
                    start,
                    end,
                    headway,
                )?;
                if flag(s, "bidirectional", true)? {
                    let reverse = offsets(true);
                    let reversed: Vec<u32> = indexes.iter().rev().copied().collect();
                    add_direction(
                        &reversed,
                        reverse.clone(),
                        reverse,
                        vec![1; indexes.len()],
                        vec![1; indexes.len()],
                        start,
                        end,
                        headway,
                    )?;
                }
            } else {
                return fail("scheduleMode must be frequency or preserve-trips");
            }
            if direction_stops.len() > 1_000_000 {
                return fail("Planned timetable exceeds one million stop events");
            }
        }
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
