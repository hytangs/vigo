use super::query::Options;
use super::{City, Result, fail, flag, number};
use crate::{
    StreetSurfaceInput, TimetableArriveByManyQueryInput, TimetableManyQueryInput,
    TimetableOverlayManyQueryInput,
};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

impl City {
    fn reach_grid_values(
        &mut self,
        q: &Value,
        size: usize,
        bounds: &[f64],
        maximum: f64,
    ) -> Result<Vec<f64>> {
        let mut values = Vec::with_capacity(size * size);
        let mut query = q.clone();
        query["kind"] = json!("matrix");
        if q["mode"] == "drive" && q.get("maxStreetKm").is_none() {
            query["maxStreetKm"] = json!(750.);
        }
        // Arrive-by Reach measures from every cell to its destination.
        let arrive = super::query::Options::parse(q)?.arrive;
        let (place, cells) = if arrive {
            ("destinations", "origins")
        } else {
            ("origins", "destinations")
        };
        query[place] = json!([q[if arrive { "destination" } else { "origin" }]]);
        query["horizonMinutes"] = json!(maximum);
        query["allowLongWalk"] = json!(false);
        query["requireTransitRide"] = json!(false);
        query["includeJourneys"] = json!(false);
        query["includeGeometry"] = json!(false);
        // Every cell centre is a new point: an endpoint cache would only hold
        // them, while uncached access projects them on the endpoint pool.
        // Driving grids keep the cached road attachment.
        if q["mode"] != "drive" {
            query["disableCache"] = json!(true);
        }
        query.as_object_mut().unwrap().remove("scenario");
        query
            .as_object_mut()
            .unwrap()
            .remove(if arrive { "destination" } else { "origin" });
        for first in (0..size * size).step_by(16_384) {
            query[cells] = Value::Array((first..(first + 16_384).min(size * size)).map(|i| {
                json!({"coordinate":[bounds[0]+(i%size) as f64/size as f64*(bounds[2]-bounds[0])
                    +0.5/size as f64*(bounds[2]-bounds[0]),
                    bounds[3]-((i/size) as f64+0.5)/size as f64*(bounds[3]-bounds[1])]})
            }).collect());
            let matrix = self.matrix_with(&query, false)?;
            let durations = matrix["durationsMinutes"]
                .as_array()
                .ok_or("Missing Reach grid durations")?;
            // One row from the origin, or one column to the destination.
            let row: Vec<&Value> = if arrive {
                durations.iter().map(|row| &row[0]).collect()
            } else {
                durations[0]
                    .as_array()
                    .ok_or("Missing Reach destination-grid row")?
                    .iter()
                    .collect()
            };
            values.extend(row.into_iter().map(|value| {
                value
                    .as_f64()
                    .filter(|v| v.is_finite() && *v <= maximum)
                    .map(|v| (v * 1000.).round() / 1000.)
                    .unwrap_or(f64::INFINITY)
            }));
        }
        Ok(values)
    }

    pub fn reach(&mut self, q: &Value) -> Result<Value> {
        if let Some(scenario) = q.get("scenario") {
            for key in scenario
                .as_object()
                .ok_or("scenario must be an object")?
                .keys()
            {
                if ![
                    "id",
                    "name",
                    "services",
                    "excludedTripIds",
                    "excludedRouteIds",
                    "overlay",
                    "cityRevision",
                ]
                .contains(&key.as_str())
                {
                    return fail(format!(
                        "Unsupported scenario field: {key}; use explicit trip exclusions and schedules"
                    ));
                }
            }
            if scenario.get("services").is_some_and(|s| !s.is_array()) {
                return fail("scenario.services must be an array");
            }
            if scenario
                .get("cityRevision")
                .is_some_and(|v| v != &self.manifest["revisionId"])
            {
                return fail("Scenario belongs to another City revision");
            }
            if scenario.get("overlay").is_some()
                && scenario["services"]
                    .as_array()
                    .is_some_and(|s| !s.is_empty())
            {
                return fail("Choose services or a compiled overlay, not both");
            }
        }
        let opt = Options::parse(q)?;
        // Depart-at Reach spreads from an origin; arrive-by Reach gathers
        // toward a destination, timed to arrive by the requested time.
        let (field, other) = if opt.arrive {
            ("destination", "origin")
        } else {
            ("origin", "destination")
        };
        if q.get(other).is_some() {
            return fail(if opt.arrive {
                "Arrive-by Reach takes a destination, not an origin"
            } else {
                "Reach with a destination requires timePreference arrive_by"
            });
        }
        let place = self.point(&q[field])?;
        let mode = q["mode"].as_str().unwrap_or("transit");
        if !["transit", "walk", "drive"].contains(&mode) {
            return fail("Reach supports transit, walk, or drive");
        }
        let sampling = if mode == "drive" {
            "cell-center"
        } else {
            match q.get("surfaceSampling") {
                None => "street",
                Some(value) => value
                    .as_str()
                    .ok_or("surfaceSampling must be street or cell-center")?,
            }
        };
        if !["street", "cell-center"].contains(&sampling) {
            return fail("surfaceSampling must be street or cell-center");
        }
        if sampling == "cell-center" {
            if q.get("scenario").is_some_and(|s| {
                ["services", "excludedTripIds", "excludedRouteIds"]
                    .iter()
                    .any(|k| {
                        s.get(k)
                            .is_some_and(|v| v.as_array().is_none_or(|a| !a.is_empty()))
                    })
                    || q["scenario"].get("overlay").is_some()
            }) {
                return fail("Planned transit changes require transit Reach with street sampling");
            }
            if mode == "transit" && opt.walk_speed.is_some_and(|speed| speed != self.speed) {
                return fail(format!(
                    "Cell-center transit Reach uses the City walking speed of {} km/h",
                    self.speed
                ));
            }
        }
        let mut cutoffs: Vec<f64> =
            q.get("cutoffsMinutes")
                .map_or(Ok(vec![15., 30., 45., 60.]), |v| {
                    v.as_array()
                        .ok_or_else(|| "cutoffsMinutes must be an array".into())
                        .and_then(|a| {
                            a.iter()
                                .map(|v| {
                                    v.as_f64()
                                        .filter(|v| v.is_finite() && *v >= 1. && *v <= 240.)
                                        .ok_or_else(|| "Each cutoff must be 1..240 minutes".into())
                                })
                                .collect::<Result<Vec<_>>>()
                        })
                })?;
        if cutoffs.is_empty() || cutoffs.len() > 16 {
            return fail("Provide 1..16 cutoffs");
        }
        cutoffs.sort_by(f64::total_cmp);
        cutoffs.dedup();
        let maximum = cutoffs.iter().copied().fold(0., f64::max);
        let size = number(q, "rasterSize", 96., 16., 1024.)?;
        if size.fract() != 0. {
            return fail("rasterSize must be an integer");
        }
        let size = size as usize;
        let radius = number(q, "extentRadiusKm", 8., 1., 40.)?;
        let lat_delta = radius / 111.32;
        let lon_delta = radius / (111.32 * place.coordinate[1].to_radians().cos()).max(12.);
        let bounds = if let Some(bounds) = q.get("bounds") {
            let a = bounds
                .as_array()
                .filter(|a| a.len() == 4)
                .ok_or("bounds must be [west,south,east,north]")?;
            a.iter()
                .map(|v| v.as_f64().ok_or_else(|| "Invalid bounds".into()))
                .collect::<Result<Vec<_>>>()?
        } else {
            vec![
                (place.coordinate[0] - lon_delta).max(-180.),
                (place.coordinate[1] - lat_delta).max(-90.),
                (place.coordinate[0] + lon_delta).min(180.),
                (place.coordinate[1] + lat_delta).min(90.),
            ]
        };
        if bounds.iter().any(|v| !v.is_finite())
            || bounds[0] < -180.
            || bounds[2] > 180.
            || bounds[1] < -90.
            || bounds[3] > 90.
            || bounds[0] >= bounds[2]
            || bounds[1] >= bounds[3]
        {
            return fail("bounds must be finite, ordered longitude/latitude limits");
        }
        if mode != "transit" && q.get("scenario").is_some() {
            return fail("Transit scenarios require transit Reach");
        }
        let mut seeds = place.coordinate.to_vec();
        let mut durations = vec![0.];
        let members: HashMap<String, i32> = self
            .members
            .iter()
            .enumerate()
            .map(|(index, id)| (id.clone(), index as i32))
            .collect();
        let mut seed_members = vec![-1];
        let mut stops = vec![];
        let mut transit = Value::Null;
        if mode == "transit" && opt.arrive {
            transit = self.arrive_by_stops(
                q,
                &place,
                &opt,
                maximum,
                &members,
                [&mut seeds, &mut durations],
                &mut seed_members,
                &mut stops,
            )?;
        } else if mode == "transit" {
            self.activate(q)?;
            let a = self.candidates(&place, "origin", &opt)?;
            let t = self.timetable.as_ref().unwrap();
            let n = t.stop_ids.len();
            let scenario = q.get("scenario");
            let mut excluded = HashSet::new();
            if let Some(s) = scenario {
                for (field, ids) in [
                    ("excludedTripIds", &t.trip_ids),
                    ("excludedRouteIds", &t.route_ids),
                ] {
                    if let Some(values) = s.get(field) {
                        for id in values
                            .as_array()
                            .ok_or("Scenario exclusions must be arrays")?
                        {
                            let id = id.as_str().ok_or("Scenario IDs must be strings")?;
                            for (i, tid) in ids.iter().enumerate() {
                                if tid == id {
                                    excluded.insert(i as u32);
                                }
                            }
                        }
                    }
                }
            }
            let excluded_count = excluded.len();
            let input = TimetableManyQueryInput {
                origin_stops: a.stops,
                origin_walk_seconds: a.seconds,
                destination_offsets: (0..=n as u32).collect(),
                destination_stops: (0..n as u32).collect(),
                destination_walk_seconds: vec![0.; n],
                excluded_trips: excluded.into_iter().collect(),
                departure: opt.time,
                horizon: opt.time + maximum * 60.,
                allow_pre_ride_transfers: a.terminal_transfers,
                allow_post_ride_transfers: Some(vec![false; n]),
                maximum_boardings: opt.max_boardings,
            };
            let mut overlay_stops = vec![];
            let mut overlay_members = vec![];
            let planned = scenario.is_some_and(|s| {
                s.get("overlay").is_some()
                    || s["services"].as_array().is_some_and(|a| !a.is_empty())
            });
            // No stop within walking reach: the surface is the walk alone.
            let walk_only = input.origin_stops.is_empty() && !planned;
            if walk_only {
                transit = json!({"supported":true,"reason":"no_origin_access","bestArrivals":[]});
            }
            let result = if walk_only {
                None
            } else if scenario
                .and_then(|s| s.get("services"))
                .and_then(Value::as_array)
                .is_some_and(|a| !a.is_empty())
            {
                let overlay = self.scenario(scenario.unwrap(), input, &place, &opt)?;
                overlay_members = overlay
                    .input
                    .overlay_base_stops
                    .iter()
                    .map(|&stop| {
                        usize::try_from(stop)
                            .ok()
                            .and_then(|index| self.timetable.as_ref().unwrap().stop_ids.get(index))
                            .and_then(|id| members.get(id))
                            .copied()
                            .unwrap_or(-1)
                    })
                    .collect();
                overlay_stops = overlay.stops;
                let result = self
                    .timetable
                    .as_mut()
                    .unwrap()
                    .kernel
                    .route_overlay_many_csa(overlay.input)?;
                transit = serde_json::to_value(&result)?;
                Some(result.timetable)
            } else if let Some(overlay) = scenario.and_then(|s| s.get("overlay")) {
                let mut input = input;
                let points = overlay["stops"]
                    .as_array()
                    .ok_or("A compiled Reach overlay requires stops with coordinates")?;
                if overlay["overlayStopCount"].as_u64() != Some(points.len() as u64)
                    || points.len() > 256
                {
                    return fail("overlayStopCount must match stops (at most 256)");
                }
                let mut coordinates = vec![];
                for (i, point) in points.iter().enumerate() {
                    let p = self.point(point)?;
                    overlay_members.push(
                        p.stop
                            .as_deref()
                            .and_then(|id| members.get(id))
                            .copied()
                            .unwrap_or(-1),
                    );
                    coordinates.extend(p.coordinate);
                    overlay_stops.push((
                        point["id"]
                            .as_str()
                            .map(str::to_owned)
                            .unwrap_or(format!("scenario:{i}")),
                        p.coordinate,
                    ));
                    input.destination_stops.push((n + i) as u32);
                    input.destination_walk_seconds.push(0.);
                    input
                        .destination_offsets
                        .push(input.destination_stops.len() as u32);
                }
                if !points.is_empty() {
                    let walks = self.street.route_street_matrix(crate::StreetMatrixInput {
                        origin_coordinates: place.coordinate.to_vec(),
                        destination_coordinates: coordinates,
                        maximum_distance_m: opt.walk_m,
                        disable_cache: Some(opt.disable_cache),
                    })?;
                    for (i, &distance) in walks.distances_m.iter().enumerate() {
                        if distance.is_finite() {
                            input.origin_stops.push((n + i) as u32);
                            input.origin_walk_seconds.push(
                                (distance / self.speed * 3.6 * self.padding + self.overhead).ceil(),
                            );
                        }
                    }
                }
                input.allow_post_ride_transfers = Some(vec![false; n + points.len()]);
                let mut value = serde_json::to_value(input)?;
                for (k, v) in overlay
                    .as_object()
                    .ok_or("scenario.overlay must be an object")?
                {
                    if k == "stops" {
                        continue;
                    }
                    if value.get(k).is_some() {
                        return fail(format!("scenario.overlay cannot override {k}"));
                    }
                    value[k] = v.clone();
                }
                let result = self
                    .timetable
                    .as_mut()
                    .unwrap()
                    .kernel
                    .route_overlay_many_csa(serde_json::from_value::<
                        TimetableOverlayManyQueryInput,
                    >(value)?)?;
                transit = serde_json::to_value(&result)?;
                Some(result.timetable)
            } else {
                let result = self
                    .timetable
                    .as_mut()
                    .unwrap()
                    .kernel
                    .route_many_csa(input)?;
                transit = serde_json::to_value(&result)?;
                Some(result)
            };
            if let Some(result) = &result
                && !result.supported
            {
                return fail(
                    result
                        .reason
                        .clone()
                        .unwrap_or("Reach kernel rejected the query".into()),
                );
            }
            let t = self.timetable.as_ref().unwrap();
            // The active view's size shows which sources a City case selected.
            transit["residentTrips"] = json!(t.trip_ids.len());
            transit["excludedTrips"] = json!(excluded_count);
            let arrivals = result.as_ref().map_or(&[][..], |r| &r.best_arrivals[..]);
            for (i, &arrival) in arrivals.iter().enumerate() {
                let duration = (arrival - opt.time) / 60.;
                if !duration.is_finite() || duration > maximum {
                    continue;
                }
                let (id, name, coordinate) = if i < n {
                    let s = self.stop(&t.stop_ids[i])?;
                    (s.id.clone(), s.name.clone(), [s.lon, s.lat])
                } else {
                    let s = overlay_stops
                        .get(i - n)
                        .ok_or("Missing scenario stop coordinates")?;
                    (s.0.clone(), s.0.clone(), s.1)
                };
                seeds.extend(coordinate);
                durations.push(duration);
                seed_members.push(if i < n {
                    members
                        .get(&id)
                        .copied()
                        .ok_or("Missing Reach egress access member")?
                } else {
                    *overlay_members
                        .get(i - n)
                        .ok_or("Missing scenario egress identity")?
                });
                stops.push(json!({"stopId":id,"name":name,"coordinate":coordinate,"durationMinutes":duration}));
            }
        }
        let include_edges = flag(q, "includeStreetEdges", false)?;
        // A caller that draws its own areas asks for the surface alone.
        let polygons = q["reachFormat"] != "surface";
        // A typed-array caller reads rasters and street evidence as
        // little-endian base64: f64 values, u32 indices.
        let base64 = match q.get("arrayEncoding").map(Value::as_str) {
            None | Some(Some("json")) => false,
            Some(Some("base64")) => true,
            Some(_) => return fail("arrayEncoding must be json or base64"),
        };
        let f64s = |values: &[f64]| {
            if base64 {
                json!(super::encoding::f64s(values))
            } else {
                json!(values)
            }
        };
        let u32s = |values: &[u32]| {
            if base64 {
                json!(super::encoding::u32s(values))
            } else {
                json!(values)
            }
        };
        let raster_encoding = if base64 {
            json!("f64le-base64")
        } else {
            Value::Null
        };
        let grid = if sampling == "cell-center" {
            Some(self.reach_grid_values(q, size, &bounds, maximum)?)
        } else {
            None
        };
        if let Some(values) = &grid
            && (mode == "drive" || (!include_edges && !flag(q, "includeNodes", false)?))
        {
            let areas = if polygons {
                areas(values, size, size, &bounds, &cutoffs)
            } else {
                Value::Null
            };
            if q["reachFormat"] == "map" {
                return Ok(
                    json!({"kind":"reach","mode":mode,"cutoffsMinutes":cutoffs,"areas":areas,"mapBounds":bounds,"diagnostics":{"transit":transit},"warnings":self.metadata["routingLimitations"]}),
                );
            }
            let contours = if polygons {
                contours(values, size, size, &bounds, &cutoffs)
            } else {
                Value::Null
            };
            let reached = values.iter().filter(|v| v.is_finite()).count();
            return Ok(without_polygons(
                anchored(
                    q,
                    json!({"kind":"reach","mode":mode,"serviceDate":q["serviceDate"],"origin":q["origin"],
                "cutoffsMinutes":cutoffs,"stops":stops,"surface":{"sampling":sampling,"width":size,"height":size,
                    "bounds":bounds,"values":f64s(values),"fullBounds":bounds,"fullValues":f64s(values),"arrayEncoding":raster_encoding,"nodes":[],"edges":null},
                "areas":areas,"fullAreas":areas,"contours":contours,"fullContours":contours,
                "diagnostics":{"transit":transit,"surface":{"surfaceModel":"coordinate_to_coordinate_cell_centers",
                    "sampledTargets":values.len(),"reachableTargets":reached,"blockedTargets":values.len()-reached,
                    "queryErrors":0,"fixedRequestedGrid":true,"walkingSpeedKph":opt.walk_speed.unwrap_or(self.speed),
                    "directWalkingLimitKm":if mode == "drive" { Value::Null } else { json!(opt.walk_m/1000.) },"travelMode":mode,"fixedExtent":true}},"warnings":self.metadata["routingLimitations"]}),
                ),
                polygons,
            ));
        }
        // A comparison keeps its reference surface ("baseline") for the
        // scenario that follows it in this process ("scenario"); the street
        // kernel reuses it only when every seed is unchanged or earlier.
        let surface_reuse = match q.get("surfaceReuse").map(Value::as_str) {
            None => None,
            Some(Some(mode @ ("baseline" | "scenario"))) => Some(mode.to_owned()),
            Some(_) => return fail("surfaceReuse must be baseline or scenario"),
        };
        let mut result = self.street.street_surface(StreetSurfaceInput {
            surface_reuse,
            bounds: bounds.clone(),
            width: size as u32,
            height: size as u32,
            seed_coordinates: seeds,
            seed_durations_minutes: durations,
            seed_member_indices: Some(seed_members),
            seed_walk_distances_m: None,
            maximum_walk_m: opt.walk_m,
            walk_speed_kph: number(q, "walkSpeedKph", self.speed, 1., 8.)?,
            maximum_duration_minutes: maximum,
            independent_terminal_walk: false,
            include_nodes: flag(q, "includeNodes", false)?,
            node_evidence_limit: 30_000,
            include_edges,
            edge_evidence_limit: 0,
            expand_bounds_to_reached_edges: true,
            reverse_direction: Some(opt.arrive),
        })?;
        if let Some(values) = grid {
            result.reached_pixels = values.iter().filter(|v| v.is_finite()).count() as u32;
            result.full_surface_values = Some(values.clone());
            result.values = values;
            result.full_surface_bounds = Some(bounds.clone());
        }
        let full_bounds = result.full_surface_bounds.as_ref().unwrap_or(&bounds);
        let full_values = result
            .full_surface_values
            .as_ref()
            .unwrap_or(&result.values);
        if q["reachFormat"] == "map" {
            return Ok(json!({"kind":"reach","mode":mode,"cutoffsMinutes":cutoffs,
                "areas":areas(full_values,size,size,full_bounds,&cutoffs),"mapBounds":full_bounds,
                "diagnostics":{"transit":transit,"surface":{"queryNs":result.query_ns,"seedNs":result.seed_ns,"propagationNs":result.propagation_ns,"envelopeNs":result.envelope_ns,"rasterNs":result.raster_ns}},
                "warnings":self.metadata["routingLimitations"]}));
        }
        let polygon =
            |draw: fn(&[f64], usize, usize, &[f64], &[f64]) -> Value, values: &[f64], b: &[f64]| {
                if polygons {
                    draw(values, size, size, b, &cutoffs)
                } else {
                    Value::Null
                }
            };
        let area_features = polygon(areas, &result.values, &bounds);
        let full_areas = polygon(areas, full_values, full_bounds);
        let contour_features = polygon(contours, &result.values, &bounds);
        let full_contours = polygon(contours, full_values, full_bounds);
        Ok(without_polygons(
            anchored(
                q,
                json!({"kind":"reach","mode":mode,"serviceDate":q["serviceDate"],"origin":q["origin"],"cutoffsMinutes":cutoffs,"stops":stops,
            "surface":{"sampling":sampling,"width":size,"height":size,"bounds":bounds,"values":f64s(&result.values),"fullBounds":full_bounds,"fullValues":f64s(full_values),"arrayEncoding":raster_encoding,"nodes":result.node_evidence,
                "edges":if include_edges {
                    let f = |v: &Option<Vec<f64>>| v.as_deref().map_or(Value::Null, f64s);
                    let u = |v: &Option<Vec<u32>>| v.as_deref().map_or(Value::Null, u32s);
                    json!({"schemaVersion":"vigo.standalone.street-edges.v2","encoding":if base64 {"indexed-base64-le"} else {"indexed-json"},"count":result.edge_evidence_ids.as_ref().map_or(0,Vec::len),"nodeCount":result.edge_evidence_nodes.as_ref().map_or(0,|v|v.len()/2),"nodes":f(&result.edge_evidence_nodes),"endpoints":u(&result.edge_evidence_endpoints),"edgeIds":u(&result.edge_evidence_ids),"durationMinutes":f(&result.edge_evidence_durations),"fromDurationMinutes":f(&result.edge_evidence_start_durations),"startFractions":f(&result.edge_evidence_start_fractions),"endFractions":f(&result.edge_evidence_end_fractions),"walkDistanceM":f(&result.edge_evidence_walk_distances),"transitArrivalMinutes":f(&result.edge_evidence_transit_arrivals)})
                } else {Value::Null}},
            "areas":area_features,"fullAreas":full_areas,"contours":contour_features,"fullContours":full_contours,
            "diagnostics":{"transit":transit,"surface":{"queryNs":result.query_ns,"seedNs":result.seed_ns,"propagationNs":result.propagation_ns,"envelopeNs":result.envelope_ns,"rasterNs":result.raster_ns,"settledLabels":result.settled_labels,"reusedLabels":result.reused_labels,"retainedLabels":result.retained_labels,"relaxedEdges":result.relaxed_edges,"reachedPixels":result.reached_pixels,"reachedEdgeCount":result.reached_edge_count,"reachedEdgeLengthM":result.reached_edge_length_m,"edgeEvidenceTruncated":result.edge_evidence_truncated,"nodeEvidenceTruncated":result.node_evidence_truncated}},"warnings":self.metadata["routingLimitations"]}),
            ),
            polygons,
        ))
    }
}
impl City {
    /// Each stop's latest boarding that still reaches `destination` by the
    /// requested time, as seeds: the minutes before that time a traveler
    /// must be at the stop. A scenario's planned services run on its view.
    #[allow(clippy::too_many_arguments)]
    fn arrive_by_stops(
        &mut self,
        q: &Value,
        destination: &super::query::Point,
        opt: &Options,
        maximum: f64,
        members: &HashMap<String, i32>,
        [seeds, durations]: [&mut Vec<f64>; 2],
        seed_members: &mut Vec<i32>,
        stops: &mut Vec<Value>,
    ) -> Result<Value> {
        let scenario = q.get("scenario").filter(|s| !s.is_null());
        if scenario.is_some_and(|s| s.get("overlay").is_some()) {
            return fail("A compiled overlay applies to depart-at Reach; send planned services");
        }
        let planned =
            scenario.is_some_and(|s| s["services"].as_array().is_some_and(|a| !a.is_empty()));
        if planned
            && q.get("routingDataMode")
                .or_else(|| q.get("dataMode"))
                .is_some_and(|mode| mode == "realtime")
        {
            return fail("Arrive-by scenario Reach uses the scheduled timetable");
        }
        self.activate(q)?;
        if planned {
            self.install_scenario(scenario.unwrap())?;
            self.apply_transfer_buffer(q)?;
            self.pinned_timetable = true;
        }
        let searched = self.latest_boardings(scenario, destination, opt, maximum);
        self.pinned_timetable = false;
        let (latest, mut transit) = searched?;
        let t = self.timetable.as_ref().unwrap();
        let planned_stops = self.scenario_view.as_ref().filter(|_| planned);
        for (i, &departure) in latest.iter().enumerate() {
            let duration = (opt.time - departure) / 60.;
            if !duration.is_finite() || duration > maximum {
                continue;
            }
            let id = &t.stop_ids[i];
            let stop = self.stop(id)?;
            seeds.extend([stop.lon, stop.lat]);
            durations.push(duration);
            // A planned stop has no station paths: it is entered from the street.
            seed_members.push(if planned_stops.is_some_and(|v| v.stops.contains_key(id)) {
                -1
            } else {
                members
                    .get(id)
                    .copied()
                    .ok_or("Missing Reach access member")?
            });
            stops.push(json!({"stopId":stop.id,"name":stop.name,"coordinate":[stop.lon,stop.lat],"durationMinutes":duration}));
        }
        transit["residentTrips"] = json!(t.trip_ids.len());
        if planned {
            transit["scenario"] =
                json!({"id":scenario.unwrap()["id"],"name":scenario.unwrap()["name"]});
        }
        Ok(transit)
    }

    /// One reverse scan from the destination's stops gives every stop's
    /// latest boarding, in seconds; unreached stops are -infinity.
    fn latest_boardings(
        &mut self,
        scenario: Option<&Value>,
        destination: &super::query::Point,
        opt: &Options,
        maximum: f64,
    ) -> Result<(Vec<f64>, Value)> {
        let b = self.candidates(destination, "destination", opt)?;
        let t = self.timetable.as_ref().unwrap();
        let n = t.stop_ids.len();
        let mut excluded = HashSet::new();
        if let Some(s) = scenario {
            for (field, ids) in [
                ("excludedTripIds", &t.trip_ids),
                ("excludedRouteIds", &t.route_ids),
            ] {
                for id in s.get(field).and_then(Value::as_array).into_iter().flatten() {
                    let id = id.as_str().ok_or("Scenario IDs must be strings")?;
                    excluded.extend(
                        ids.iter()
                            .enumerate()
                            .filter(|(_, other)| *other == id)
                            .map(|(i, _)| i as u32),
                    );
                }
            }
        }
        let excluded_count = excluded.len();
        let excluded: Vec<u32> = excluded.into_iter().collect();
        if b.stops.is_empty() {
            return Ok((
                vec![f64::NEG_INFINITY; n],
                json!({"supported":true,"reason":"no_destination_access","latestDepartures":[],"excludedTrips":excluded_count}),
            ));
        }
        let mut latest = Vec::with_capacity(n);
        let mut transit = Value::Null;
        // Every stop is an origin of its own; the kernel bounds one request.
        for first in (0..n).step_by(crate::MAXIMUM_MATRIX_PAIRS) {
            let count = (n - first).min(crate::MAXIMUM_MATRIX_PAIRS);
            let result = self
                .timetable
                .as_mut()
                .unwrap()
                .kernel
                .route_arrive_by_many_csa(TimetableArriveByManyQueryInput {
                    origin_offsets: (0..=count as u32).collect(),
                    origin_stops: (first as u32..(first + count) as u32).collect(),
                    origin_walk_seconds: vec![0.; count],
                    // The street surface walks between stops.
                    allow_pre_ride_transfers: vec![false; count],
                    destination_stops: b.stops.clone(),
                    destination_walk_seconds: b.seconds.clone(),
                    earliest: opt.time - maximum * 60.,
                    deadline: opt.time,
                    excluded_trips: excluded.clone(),
                    allow_post_ride_transfers: Some(b.terminal_transfers),
                    maximum_boardings: opt.max_boardings,
                })?;
            latest.extend_from_slice(&result.latest_departures);
            if transit.is_null() {
                transit = serde_json::to_value(&result)?;
                transit["latestDepartures"] = Value::Null;
            }
        }
        transit["supported"] = json!(true);
        transit["excludedTrips"] = json!(excluded_count);
        transit["latestDepartures"] = json!(latest);
        Ok((latest, transit))
    }
}

/// An arrive-by Reach names its destination: its values are the minutes
/// before the requested time a traveler must leave each place.
fn anchored(q: &Value, mut output: Value) -> Value {
    if Options::parse(q).is_ok_and(|opt| opt.arrive) {
        let object = output.as_object_mut().unwrap();
        object.remove("origin");
        object.insert("destination".into(), q["destination"].clone());
        object.insert("timePreference".into(), json!("arrive_by"));
    }
    output
}

/// The Reach Result, or with `reachFormat: "surface"` its stops and rasters
/// alone: area and contour fields are omitted rather than drawn.
fn without_polygons(mut output: Value, polygons: bool) -> Value {
    if !polygons && let Some(object) = output.as_object_mut() {
        object.retain(|key, _| {
            !matches!(
                key.as_str(),
                "areas" | "fullAreas" | "contours" | "fullContours"
            )
        });
    }
    output
}
type GridPoint = (i32, i32);
// Split corner-touching boundary walks into simple cycles before simplification.
fn split_touching_rings(ring: Vec<GridPoint>) -> Vec<Vec<GridPoint>> {
    let mut positions = HashMap::new();
    let mut path = Vec::new();
    let mut rings = Vec::new();
    for point in ring {
        if let Some(&start) = positions.get(&point) {
            let mut cycle = path[start..].to_vec();
            cycle.push(point);
            rings.push(cycle);
            for vertex in &path[start + 1..] {
                positions.remove(vertex);
            }
            path.truncate(start + 1);
        } else {
            positions.insert(point, path.len());
            path.push(point);
        }
    }
    rings
}
fn coordinate(p: GridPoint, w: usize, h: usize, b: &[f64]) -> [f64; 2] {
    [
        b[0] + p.0 as f64 / w as f64 * (b[2] - b[0]),
        b[3] - p.1 as f64 / h as f64 * (b[3] - b[1]),
    ]
}
fn signed_area(r: &[[f64; 2]]) -> f64 {
    let origin = r[0];
    r.windows(2)
        .map(|p| {
            (p[0][0] - origin[0]) * (p[1][1] - origin[1])
                - (p[1][0] - origin[0]) * (p[0][1] - origin[1])
        })
        .sum::<f64>()
        / 2.
}
fn contains(r: &[[f64; 2]], p: [f64; 2]) -> bool {
    let mut inside = false;
    for line in r.windows(2) {
        let (a, b) = (line[0], line[1]);
        if (a[1] > p[1]) != (b[1] > p[1])
            && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]
        {
            inside = !inside;
        }
    }
    inside
}
fn area_rings(values: &[f64], w: usize, h: usize, b: &[f64], cutoff: f64) -> Vec<Vec<[f64; 2]>> {
    let yes = |x: i32, y: i32| {
        x >= 0
            && y >= 0
            && (x as usize) < w
            && (y as usize) < h
            && values[y as usize * w + x as usize].is_finite()
            && values[y as usize * w + x as usize] <= cutoff
    };
    let mut edges: HashMap<GridPoint, Vec<GridPoint>> = HashMap::new();
    let mut add = |a, b| edges.entry(a).or_default().push(b);
    for y in 0..h as i32 {
        for x in 0..w as i32 {
            if !yes(x, y) {
                continue;
            }
            if !yes(x, y - 1) {
                add((x, y), (x + 1, y));
            }
            if !yes(x + 1, y) {
                add((x + 1, y), (x + 1, y + 1));
            }
            if !yes(x, y + 1) {
                add((x + 1, y + 1), (x, y + 1));
            }
            if !yes(x - 1, y) {
                add((x, y + 1), (x, y));
            }
        }
    }
    let mut starts: Vec<_> = edges.keys().copied().collect();
    starts.sort();
    let mut rings = vec![];
    for start in starts {
        while edges.get(&start).is_some_and(|v| !v.is_empty()) {
            let mut ring = vec![start];
            let mut current = start;
            let mut previous = (start.0 - 1, start.1);
            while let Some(nexts) = edges.get_mut(&current) {
                if nexts.is_empty() {
                    break;
                }
                let direction = (current.0 - previous.0, current.1 - previous.1);
                // At a diagonal contact, turn right to keep disconnected cell areas separate.
                let next_index = nexts
                    .iter()
                    .position(|p| (p.0 - current.0, p.1 - current.1) == (-direction.1, direction.0))
                    .unwrap_or(0);
                let next = nexts.remove(next_index);
                previous = current;
                current = next;
                ring.push(current);
                if current == start {
                    break;
                }
            }
            if ring.len() >= 4 && ring.last() == Some(&start) {
                for ring in split_touching_rings(ring) {
                    let points = &ring[..ring.len() - 1];
                    let mut simple = vec![];
                    for i in 0..points.len() {
                        let a = points[(i + points.len() - 1) % points.len()];
                        let p = points[i];
                        let c = points[(i + 1) % points.len()];
                        if (p.0 - a.0) * (c.1 - p.1) != (p.1 - a.1) * (c.0 - p.0) {
                            simple.push(coordinate(p, w, h, b));
                        }
                    }
                    if simple.len() >= 3 {
                        simple.push(simple[0]);
                        rings.push(simple);
                    }
                }
            }
        }
    }
    rings
}
fn areas(values: &[f64], w: usize, h: usize, b: &[f64], cutoffs: &[f64]) -> Value {
    let mut features = vec![];
    for &cutoff in cutoffs {
        let mut rings = area_rings(values, w, h, b, cutoff);
        rings.sort_by(|a, b| signed_area(b).abs().total_cmp(&signed_area(a).abs()));
        let mut parents: Vec<Option<usize>> = vec![None; rings.len()];
        let mut depth = vec![0; rings.len()];
        for i in 0..rings.len() {
            let probe = [
                (rings[i][0][0] + rings[i][1][0]) / 2.,
                (rings[i][0][1] + rings[i][1][1]) / 2.,
            ];
            for j in (0..i).rev() {
                if contains(&rings[j], probe) {
                    parents[i] = Some(j);
                    depth[i] = depth[j] + 1;
                    break;
                }
            }
        }
        let mut polygons = vec![];
        for i in 0..rings.len() {
            if depth[i] % 2 != 0 {
                continue;
            }
            let mut outer = rings[i].clone();
            if signed_area(&outer) < 0. {
                outer.reverse();
            }
            let mut polygon = vec![outer];
            for j in 0..rings.len() {
                if parents[j] == Some(i) && depth[j] % 2 == 1 {
                    let mut hole = rings[j].clone();
                    if signed_area(&hole) > 0. {
                        hole.reverse();
                    }
                    polygon.push(hole);
                }
            }
            polygons.push(polygon);
        }
        if !polygons.is_empty() {
            features.push(json!({"type":"Feature","properties":{"cutoffMinutes":cutoff},"geometry":{"type":"MultiPolygon","coordinates":polygons}}));
        }
    }
    json!({"type":"FeatureCollection","features":features})
}
fn contours(values: &[f64], w: usize, h: usize, b: &[f64], cutoffs: &[f64]) -> Value {
    let cases: [&[(usize, usize)]; 16] = [
        &[],
        &[(3, 0)],
        &[(0, 1)],
        &[(3, 1)],
        &[(1, 2)],
        &[(3, 0), (1, 2)],
        &[(0, 2)],
        &[(3, 2)],
        &[(2, 3)],
        &[(0, 2)],
        &[(0, 1), (2, 3)],
        &[(1, 2)],
        &[(3, 1)],
        &[(0, 1)],
        &[(3, 0)],
        &[],
    ];
    let mut features = vec![];
    for &cutoff in cutoffs {
        let mut segments = vec![];
        let value_at = |x: i32, y: i32| {
            if x >= 0 && y >= 0 && (x as usize) < w && (y as usize) < h {
                let v = values[y as usize * w + x as usize];
                if v.is_finite() { v } else { f64::INFINITY }
            } else {
                f64::INFINITY
            }
        };
        // A masked collar closes contours at the extent without inventing time.
        for y in -1..h as i32 {
            for x in -1..w as i32 {
                let v = [
                    value_at(x, y),
                    value_at(x + 1, y),
                    value_at(x + 1, y + 1),
                    value_at(x, y + 1),
                ];
                let state = v
                    .iter()
                    .enumerate()
                    .fold(0, |state, (i, &n)| state | (usize::from(n <= cutoff) << i));
                let interpolate = |a: f64, b: f64| {
                    if !a.is_finite() || !b.is_finite() || (b - a).abs() < 1e-9 {
                        0.5
                    } else {
                        ((cutoff - a) / (b - a)).clamp(1e-6, 1. - 1e-6)
                    }
                };
                let edges = [
                    [x as f64 + interpolate(v[0], v[1]), y as f64],
                    [x as f64 + 1., y as f64 + interpolate(v[1], v[2])],
                    [x as f64 + interpolate(v[3], v[2]), y as f64 + 1.],
                    [x as f64, y as f64 + interpolate(v[0], v[3])],
                ];
                let coord = |p: [f64; 2]| {
                    [
                        ((b[0] + (p[0] + 0.5).clamp(0., w as f64) / w as f64 * (b[2] - b[0]))
                            * 1e12)
                            .round() as i64,
                        ((b[3] - (p[1] + 0.5).clamp(0., h as f64) / h as f64 * (b[3] - b[1]))
                            * 1e12)
                            .round() as i64,
                    ]
                };
                for &(a, z) in cases[state] {
                    segments.push((coord(edges[a]), coord(edges[z])));
                }
            }
        }
        let mut nodes: HashMap<[i64; 2], Vec<usize>> = HashMap::new();
        for (i, &(a, b)) in segments.iter().enumerate() {
            nodes.entry(a).or_default().push(i);
            nodes.entry(b).or_default().push(i);
        }
        let mut visited = vec![false; segments.len()];
        let mut lines = vec![];
        let mut walk = |start: [i64; 2], first: usize| {
            let mut point = start;
            let mut edge = Some(first);
            let mut line = vec![[point[0] as f64 / 1e12, point[1] as f64 / 1e12]];
            while let Some(i) = edge {
                if visited[i] {
                    break;
                }
                visited[i] = true;
                let (a, b) = segments[i];
                point = if a == point { b } else { a };
                line.push([point[0] as f64 / 1e12, point[1] as f64 / 1e12]);
                edge = nodes[&point].iter().copied().find(|&i| !visited[i]);
            }
            if line.len() >= 2 {
                lines.push(line);
            }
        };
        let mut starts: Vec<_> = nodes.iter().filter(|(_, e)| e.len() != 2).collect();
        starts.sort_by_key(|(p, _)| **p);
        for (&point, edges) in starts {
            for &edge in edges {
                walk(point, edge);
            }
        }
        for (i, &(point, _)) in segments.iter().enumerate() {
            walk(point, i);
        }
        if !lines.is_empty() {
            features.push(json!({"type":"Feature","properties":{"cutoffMinutes":cutoff},"geometry":{"type":"MultiLineString","coordinates":lines}}));
        }
    }
    json!({"type":"FeatureCollection","features":features})
}

#[cfg(test)]
mod tests {
    use super::*;
    fn check_cell_mask(v: &[f64], w: usize, h: usize) {
        let bounds = [-74., 40., -73.9, 40.1];
        let result = areas(v, w, h, &bounds, &[1.]);
        let mut polygons: Vec<Vec<Vec<[f64; 2]>>> = Vec::new();
        for feature in result["features"].as_array().unwrap() {
            polygons.extend(
                serde_json::from_value::<Vec<Vec<Vec<[f64; 2]>>>>(
                    feature["geometry"]["coordinates"].clone(),
                )
                .unwrap(),
            );
        }
        let contour_result = contours(v, w, h, &bounds, &[1.]);
        let lines: Vec<Vec<[f64; 2]>> = contour_result["features"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|f| {
                serde_json::from_value::<Vec<Vec<[f64; 2]>>>(f["geometry"]["coordinates"].clone())
                    .unwrap()
            })
            .collect();
        for line in &lines {
            assert_eq!(line.first(), line.last(), "closed cutoff contour");
        }
        for y in 0..h {
            for x in 0..w {
                let point = [
                    bounds[0] + (x as f64 + 0.5) / w as f64 * (bounds[2] - bounds[0]),
                    bounds[3] - (y as f64 + 0.5) / h as f64 * (bounds[3] - bounds[1]),
                ];
                let covered = polygons.iter().any(|p| {
                    contains(&p[0], point) && !p[1..].iter().any(|hole| contains(hole, point))
                });
                assert_eq!(
                    lines.iter().filter(|line| contains(line, point)).count() % 2 == 1,
                    v[y * w + x].is_finite() && v[y * w + x] <= 1.,
                    "contour sample {x},{y}"
                );
                assert_eq!(
                    covered,
                    v[y * w + x].is_finite() && v[y * w + x] <= 1.,
                    "cell {x},{y}: {v:?}"
                );
            }
        }
        for polygon in &polygons {
            for ring in polygon {
                assert_eq!(ring.first(), ring.last());
                let vertices: std::collections::HashSet<_> = ring[..ring.len() - 1]
                    .iter()
                    .map(|p| (p[0].to_bits(), p[1].to_bits()))
                    .collect();
                assert_eq!(vertices.len(), ring.len() - 1, "simple boundary rings");
            }
        }
    }
    #[test]
    fn cell_polygon_masks_and_nested_islands() {
        for mask in 0..512 {
            let v: Vec<_> = (0..9)
                .map(|i| {
                    if mask & (1 << i) != 0 {
                        0.
                    } else {
                        f64::INFINITY
                    }
                })
                .collect();
            check_cell_mask(&v, 3, 3);
        }
        let nested: Vec<_> = (0usize..121)
            .map(|i| {
                let x = i % 11;
                let y = i / 11;
                if x.min(y).min(10 - x).min(10 - y) % 2 == 0 {
                    0.
                } else {
                    f64::INFINITY
                }
            })
            .collect();
        check_cell_mask(&nested, 11, 11);
        check_cell_mask(&[1.], 1, 1);
        check_cell_mask(&[0., 1., 2., 3., 0.5, 1., 2., 3., 0., 0.5, 1., 2.], 4, 3);
        let mut seed = 20261012u32;
        for _ in 0..300 {
            let v: Vec<_> = (0..120)
                .map(|_| {
                    seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                    if seed >> 31 != 0 { 0. } else { f64::INFINITY }
                })
                .collect();
            check_cell_mask(&v, 12, 10);
        }
    }
    #[test]
    fn preserves_holes_and_disconnected_cells() {
        let mut v = vec![0.; 25];
        v[12] = f64::INFINITY;
        let a = areas(&v, 5, 5, &[0., 0., 5., 5.], &[1.]);
        assert_eq!(
            a["features"][0]["geometry"]["coordinates"][0]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        let a = areas(
            &[0., f64::INFINITY, f64::INFINITY, 0.],
            2,
            2,
            &[0., 0., 2., 2.],
            &[1.],
        );
        assert_eq!(
            a["features"][0]["geometry"]["coordinates"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }
}
