use super::query::Options;
use super::{City, Result, fail, flag, number};
use crate::{StreetSurfaceInput, TimetableManyQueryInput, TimetableOverlayManyQueryInput};
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
        query["origins"] = json!([q["origin"]]);
        query["horizonMinutes"] = json!(maximum);
        query["allowLongWalk"] = json!(false);
        query["requireTransitRide"] = json!(false);
        query["includeJourneys"] = json!(false);
        query["includeGeometry"] = json!(false);
        query.as_object_mut().unwrap().remove("scenario");
        for first in (0..size * size).step_by(16_384) {
            query["destinations"] = Value::Array((first..(first + 16_384).min(size * size)).map(|i| {
                json!({"coordinate":[bounds[0]+(i%size) as f64/size as f64*(bounds[2]-bounds[0])
                    +0.5/size as f64*(bounds[2]-bounds[0]),
                    bounds[3]-((i/size) as f64+0.5)/size as f64*(bounds[3]-bounds[1])]})
            }).collect());
            let matrix = self.matrix(&query)?;
            let row = matrix["durationsMinutes"][0]
                .as_array()
                .ok_or("Missing Reach destination-grid row")?;
            values.extend(row.iter().map(|value| {
                value
                    .as_f64()
                    .map(|v| (v * 1000.).round() / 1000.)
                    .filter(|v| v.is_finite() && *v <= maximum)
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
        if opt.arrive {
            return fail("Reach requires depart_at");
        }
        let origin = self.point(&q["origin"])?;
        let mode = q["mode"].as_str().unwrap_or("transit");
        if !["transit", "walk"].contains(&mode) {
            return fail("Reach supports transit or walk");
        }
        let sampling = match q.get("surfaceSampling") {
            None => "street",
            Some(value) => value
                .as_str()
                .ok_or("surfaceSampling must be street or cell-center")?,
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
        let lon_delta = radius / (111.32 * origin.coordinate[1].to_radians().cos()).max(12.);
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
                (origin.coordinate[0] - lon_delta).max(-180.),
                (origin.coordinate[1] - lat_delta).max(-90.),
                (origin.coordinate[0] + lon_delta).min(180.),
                (origin.coordinate[1] + lat_delta).min(90.),
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
        if mode == "walk" && q.get("scenario").is_some() {
            return fail("Transit scenarios require transit Reach");
        }
        let mut seeds = origin.coordinate.to_vec();
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
        if mode == "transit" {
            self.activate(q)?;
            let a = self.candidates(&origin, "origin", &opt)?;
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
            let result = if scenario
                .and_then(|s| s.get("services"))
                .and_then(Value::as_array)
                .is_some_and(|a| !a.is_empty())
            {
                let overlay = self.scenario(scenario.unwrap(), input, &origin, &opt)?;
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
                result.timetable
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
                        origin_coordinates: origin.coordinate.to_vec(),
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
                result.timetable
            } else {
                let result = self
                    .timetable
                    .as_mut()
                    .unwrap()
                    .kernel
                    .route_many_csa(input)?;
                transit = serde_json::to_value(&result)?;
                result
            };
            if !result.supported {
                return fail(
                    result
                        .reason
                        .unwrap_or("Reach kernel rejected the query".into()),
                );
            }
            let t = self.timetable.as_ref().unwrap();
            for (i, &arrival) in result.best_arrivals.iter().enumerate() {
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
        let grid = if sampling == "cell-center" {
            Some(self.reach_grid_values(q, size, &bounds, maximum)?)
        } else {
            None
        };
        if let Some(values) = &grid
            && !include_edges
            && !flag(q, "includeNodes", false)?
        {
            let areas = areas(values, size, size, &bounds, &cutoffs);
            if q["reachFormat"] == "map" {
                return Ok(json!({"kind":"reach","mode":mode,"cutoffsMinutes":cutoffs,"areas":areas,"mapBounds":bounds,"diagnostics":{"transit":transit},"warnings":self.metadata["routingLimitations"]}));
            }
            let contours = contours(values, size, size, &bounds, &cutoffs);
            let reached = values.iter().filter(|v| v.is_finite()).count();
            return Ok(
                json!({"kind":"reach","mode":mode,"serviceDate":q["serviceDate"],"origin":q["origin"],
                "cutoffsMinutes":cutoffs,"stops":stops,"surface":{"sampling":sampling,"width":size,"height":size,
                    "bounds":bounds,"values":values,"fullBounds":bounds,"fullValues":values,"nodes":[],"edges":null},
                "areas":areas,"fullAreas":areas,"contours":contours,"fullContours":contours,
                "diagnostics":{"transit":transit,"surface":{"surfaceModel":"coordinate_to_coordinate_cell_centers",
                    "sampledTargets":values.len(),"reachableTargets":reached,"blockedTargets":values.len()-reached,
                    "queryErrors":0,"fixedRequestedGrid":true,"walkingSpeedKph":opt.walk_speed.unwrap_or(self.speed),
                    "directWalkingLimitKm":opt.walk_m/1000.}},"warnings":self.metadata["routingLimitations"]}),
            );
        }
        let mut result = self.street.street_surface(StreetSurfaceInput {
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
        let area_features = areas(&result.values, size, size, &bounds, &cutoffs);
        let full_areas = areas(full_values, size, size, full_bounds, &cutoffs);
        let contour_features = contours(&result.values, size, size, &bounds, &cutoffs);
        let full_contours = contours(full_values, size, size, full_bounds, &cutoffs);
        Ok(
            json!({"kind":"reach","mode":mode,"serviceDate":q["serviceDate"],"origin":q["origin"],"cutoffsMinutes":cutoffs,"stops":stops,
            "surface":{"sampling":sampling,"width":size,"height":size,"bounds":bounds,"values":result.values,"fullBounds":full_bounds,"fullValues":full_values,"nodes":result.node_evidence,
                "edges":if include_edges {json!({"schemaVersion":"vigo.standalone.street-edges.v2","encoding":"indexed-json","count":result.edge_evidence_ids.as_ref().map_or(0,Vec::len),"nodeCount":result.edge_evidence_nodes.as_ref().map_or(0,|v|v.len()/2),"nodes":result.edge_evidence_nodes,"endpoints":result.edge_evidence_endpoints,"edgeIds":result.edge_evidence_ids,"durationMinutes":result.edge_evidence_durations,"fromDurationMinutes":result.edge_evidence_start_durations,"startFractions":result.edge_evidence_start_fractions,"endFractions":result.edge_evidence_end_fractions,"walkDistanceM":result.edge_evidence_walk_distances,"transitArrivalMinutes":result.edge_evidence_transit_arrivals})}else{Value::Null}},
            "areas":area_features,"fullAreas":full_areas,"contours":contour_features,"fullContours":full_contours,
            "diagnostics":{"transit":transit,"surface":{"queryNs":result.query_ns,"seedNs":result.seed_ns,"propagationNs":result.propagation_ns,"envelopeNs":result.envelope_ns,"rasterNs":result.raster_ns,"settledLabels":result.settled_labels,"retainedLabels":result.retained_labels,"relaxedEdges":result.relaxed_edges,"reachedPixels":result.reached_pixels,"reachedEdgeCount":result.reached_edge_count,"reachedEdgeLengthM":result.reached_edge_length_m,"edgeEvidenceTruncated":result.edge_evidence_truncated,"nodeEvidenceTruncated":result.node_evidence_truncated}},"warnings":self.metadata["routingLimitations"]}),
        )
    }
}
type GridPoint = (i32, i32);
fn coordinate(p: GridPoint, w: usize, h: usize, b: &[f64]) -> [f64; 2] {
    [
        b[0] + p.0 as f64 / w as f64 * (b[2] - b[0]),
        b[3] - p.1 as f64 / h as f64 * (b[3] - b[1]),
    ]
}
fn signed_area(r: &[[f64; 2]]) -> f64 {
    r.windows(2)
        .map(|p| p[0][0] * p[1][1] - p[1][0] * p[0][1])
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
            for j in (0..i).rev() {
                if contains(&rings[j], rings[i][0]) {
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
        &[(3, 2), (0, 1)],
        &[(0, 2)],
        &[(3, 2)],
        &[(2, 3)],
        &[(0, 2)],
        &[(0, 3), (1, 2)],
        &[(1, 2)],
        &[(3, 1)],
        &[(0, 1)],
        &[(3, 0)],
        &[],
    ];
    let mut features = vec![];
    for &cutoff in cutoffs {
        let mut segments = vec![];
        for y in 0..h - 1 {
            for x in 0..w - 1 {
                let v = [
                    values[y * w + x],
                    values[y * w + x + 1],
                    values[(y + 1) * w + x + 1],
                    values[(y + 1) * w + x],
                ];
                if v.iter().any(|n| !n.is_finite()) {
                    continue;
                }
                let state = v
                    .iter()
                    .enumerate()
                    .fold(0, |state, (i, &n)| state | (usize::from(n <= cutoff) << i));
                let interpolate = |a: f64, b: f64| {
                    if (b - a).abs() < 1e-9 {
                        0.5
                    } else {
                        ((cutoff - a) / (b - a)).clamp(0., 1.)
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
                        ((b[0] + (p[0] + 0.5) / w as f64 * (b[2] - b[0])) * 1e6).round() as i64,
                        ((b[3] - (p[1] + 0.5) / h as f64 * (b[3] - b[1])) * 1e6).round() as i64,
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
            let mut line = vec![[point[0] as f64 / 1e6, point[1] as f64 / 1e6]];
            while let Some(i) = edge {
                if visited[i] {
                    break;
                }
                visited[i] = true;
                let (a, b) = segments[i];
                point = if a == point { b } else { a };
                line.push([point[0] as f64 / 1e6, point[1] as f64 / 1e6]);
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
