//! Materialize the selected access witness, not a new walk to a platform.
use super::query::{Candidates, Options, Point, haversine};
use super::{City, Result};
use crate::{CoordinateKernel, MaterializePathInput, StreetPathInput, TimetableMatrixLeg};
use serde_json::{Value, json};
use std::collections::HashSet;

fn pathway(source: &str) -> bool {
    matches!(source, "gtfs_pathway" | "schedule_pathway")
}

// Endpoint frontiers belong to one coordinate query. Point queries retain both
// roles; matrix requests may have replaced them while preparing other endpoints.
// Only reconstruct the selected witness while its token is still current.
fn selected_street_path(
    kernel: &mut CoordinateKernel,
    input: MaterializePathInput,
) -> Result<Option<(Vec<f64>, f64)>> {
    if input.query_token != kernel.query_token {
        return Ok(None);
    }
    let frontier = match input.role.as_str() {
        "origin" => &kernel.last_origin_frontier,
        "destination" => &kernel.last_destination_frontier,
        _ => return Err("Invalid selected street path role".into()),
    }
    .as_ref()
    .ok_or("Selected street path frontier is missing")?;
    let index = frontier
        .member_indices
        .iter()
        .position(|member| *member == input.member_index)
        .ok_or("Selected street path member is missing")?;
    let distance = frontier.distances_m[index];
    Ok(Some((
        kernel.materialize_path(input)?.coordinates,
        distance,
    )))
}

impl City {
    fn station_path(&self, from: usize, to: usize, seconds: f64) -> Result<Option<Value>> {
        let integer = |name: &str, i: usize| -> Result<usize> {
            let bytes = self.context.array(name, "Uint32Array", 4)?;
            let value = bytes
                .get(i * 4..i * 4 + 4)
                .ok_or("Invalid station witness index")?;
            Ok(u32::from_le_bytes(value.try_into()?) as usize)
        };
        let number = |name: &str, i: usize| -> Result<f64> {
            let bytes = self.context.array(name, "Float64Array", 8)?;
            let value = bytes
                .get(i * 8..i * 8 + 8)
                .ok_or("Invalid station witness cost")?;
            Ok(f64::from_le_bytes(value.try_into()?))
        };
        let metadata = &self.access.station_paths;
        for i in integer("offsets", from)?..integer("offsets", from + 1)? {
            if integer("to", i)? != to || (number("seconds", i)? - seconds).abs() > 0.001 {
                continue;
            }
            let start = integer("pathOffsets", i)?;
            let end = integer("pathOffsets", i + 1)?;
            let mut ids = vec![];
            for j in start..end {
                ids.push(
                    metadata["stopIds"][integer("pathStops", j)?]
                        .as_str()
                        .ok_or("Missing station witness stop")?,
                );
            }
            let mut sources = vec![];
            for j in start
                .checked_sub(i)
                .ok_or("Invalid station source offset")?
                ..end.checked_sub(i + 1).ok_or("Invalid station source end")?
            {
                sources.push(
                    metadata["sources"][integer("pathSources", j)?]
                        .as_str()
                        .ok_or("Missing station witness source")?,
                );
            }
            return Ok(Some(
                json!({"stopIds":ids,"sources":sources,"seconds":seconds,"distanceKm":number("distanceM", i)?/1000.}),
            ));
        }
        Ok(None)
    }

    pub(crate) fn walk_evidence(
        &mut self,
        leg: &TimetableMatrixLeg,
        endpoints: [&Point; 2],
        access: [&Candidates; 2],
        opt: &Options,
        geometry: bool,
    ) -> Result<Value> {
        let t = self.timetable.as_ref().ok_or("Timetable not active")?;
        let ids = [leg.from_stop, leg.to_stop].map(|i| i.map(|i| t.stop_ids[i as usize].clone()));
        let mut coordinates = [endpoints[0].coordinate, endpoints[1].coordinate];
        for i in 0..2 {
            if let Some(id) = &ids[i] {
                let stop = self.stop(id)?;
                coordinates[i] = [stop.lon, stop.lat];
            }
        }
        let duration = leg.arrival - leg.departure;
        let role = if leg.from_stop.is_none() {
            Some(0)
        } else if leg.to_stop.is_none() {
            Some(1)
        } else {
            None
        };
        let mut value = json!({"streetPathVerified":false});
        let mut street_coordinates = coordinates;
        let mut station_coordinates = vec![];
        let mut street_budget = duration;
        let mut distance = None;
        let mut source_only = false;
        let mut selected_path = None;
        if let Some(role) = role {
            if endpoints[role].stop.is_some() {
                value["geometrySource"] = json!("station_selection");
                value["distanceMeters"] = json!(0);
                if geometry {
                    value["coordinates"] = json!(coordinates);
                }
                return Ok(value);
            }
            let evidence = access[role]
                .evidence
                .as_ref()
                .ok_or("Missing coordinate access evidence")?;
            let target = ids[1 - role].as_ref().ok_or("Missing access stop")?;
            let index = evidence
                .member_indices
                .iter()
                .enumerate()
                .find(|(index, member)| {
                    self.members.get(**member as usize) == Some(target)
                        && (f64::from(evidence.access_seconds[*index]) - duration).abs() < 0.001
                })
                .map(|(index, _)| index)
                .ok_or("Selected access witness is missing")?;
            let priced = f64::from(evidence.access_seconds[index]);
            if (priced - duration).abs() > 0.001 {
                return Err("Selected access cost does not match its journey".into());
            }
            distance = Some(evidence.distances_m[index]);
            let member = evidence.path_member_indices[index] as usize;
            selected_path = geometry.then(|| MaterializePathInput {
                query_token: evidence.query_token,
                role: if role == 0 { "origin" } else { "destination" }.into(),
                member_index: member as u32,
                maximum_points: 512,
            });
            let stop = self.stop(self.members.get(member).ok_or("Unknown access member")?)?;
            street_coordinates[1 - role] = [stop.lon, stop.lat];
            if evidence.candidate_kinds[index] == 1 {
                let mut from = evidence.link_from_stop_keys[index] as usize;
                let mut to = evidence.link_to_stop_keys[index] as usize;
                if role == 1 {
                    std::mem::swap(&mut from, &mut to);
                }
                let seconds = f64::from(evidence.link_durations[index]);
                street_budget = (duration - seconds).max(0.);
                {
                    let station = self
                        .station_path(from, to, seconds)?
                        .ok_or("Selected station path witness is missing")?;
                    for id in station["stopIds"]
                        .as_array()
                        .ok_or("Missing station path")?
                    {
                        let stop = self.stop(id.as_str().ok_or("Invalid station stop")?)?;
                        if stop.lon.is_finite() && stop.lat.is_finite() {
                            station_coordinates.push([stop.lon, stop.lat]);
                        } else {
                            value["stationGeometryStatus"] = json!("incomplete");
                        }
                    }
                    let ids = station["stopIds"].as_array().unwrap();
                    for pair in ids.windows(2) {
                        let from = pair[0].as_str().unwrap();
                        let to = pair[1].as_str().unwrap();
                        let a = self.stop(from)?;
                        let b = self.stop(to)?;
                        if [a.lon, a.lat, b.lon, b.lat].iter().any(|v| !v.is_finite())
                            && self
                                .transfer_rows
                                .get(from)
                                .and_then(|&i| {
                                    self.access.materialized.transfers[i]
                                        .1
                                        .iter()
                                        .find(|edge| edge.to_stop_id == to)
                                })
                                .is_none_or(|edge| edge.path_distance_m.is_none())
                        {
                            value["stationDistanceStatus"] = json!("lower_bound");
                        }
                    }
                    value["stationPathSources"] = station["sources"].clone();
                    value["accessCost"] = json!({"street":{"seconds":street_budget,"distanceKm":
                        (distance.unwrap_or(0.) / 1000. - station["distanceKm"].as_f64().unwrap_or(0.)).max(0.)},"station":station});
                }
                value["stationAccessStatus"] = json!("unverified");
            }
        } else if let (Some(from), Some(to)) = (&ids[0], &ids[1]) {
            let row = self
                .transfer_rows
                .get(from)
                .map(|&i| &self.access.materialized.transfers[i].1);
            let transfer = row.and_then(|rows| {
                rows.iter().find(|r| {
                    r.to_stop_id == *to
                        && r.min_transfer_time
                            .is_some_and(|s| s.trunc() <= duration + 0.001)
                })
            });
            if let Some(transfer) = transfer {
                let source = transfer.provenance.as_deref().unwrap_or("unknown");
                value["transferSource"] = json!(source);
                if source != "osm_certified_radial" {
                    source_only = true;
                    let located = coordinates.iter().flatten().all(|v| v.is_finite());
                    if !located {
                        value["stationGeometryStatus"] = json!("incomplete");
                        if transfer.path_distance_m.is_none() {
                            value["stationDistanceStatus"] = json!("lower_bound");
                        }
                    }
                    distance = Some(transfer.path_distance_m.unwrap_or_else(|| {
                        if located {
                            haversine(coordinates[0], coordinates[1])
                        } else {
                            0.
                        }
                    }));
                    value["geometrySource"] = json!(if pathway(source) {
                        "gtfs_pathway"
                    } else {
                        "stop_coordinate_fallback"
                    });
                    if pathway(source) {
                        value["stationPathSources"] = json!([source]);
                        value["accessCost"] = json!({"street":{"seconds":0.,"distanceKm":0.},"station":{
                            "stopIds":[from,to],"sources":[source],"seconds":duration,"distanceKm":distance.unwrap()/1000.}});
                    }
                }
            }
        }
        if let Some(distance) = distance {
            value["distanceMeters"] = json!(distance);
        }
        if geometry && !source_only && duration > 0. {
            let selected = match selected_path {
                Some(input) => selected_street_path(&mut self.street, input)?,
                None => None,
            };
            let (path_coordinates, path_distance, found) =
                if let Some((coordinates, distance)) = selected {
                    (coordinates, distance, true)
                } else {
                    let path = self.street.route_path(StreetPathInput {
                        origin_lon: street_coordinates[0][0],
                        origin_lat: street_coordinates[0][1],
                        destination_lon: street_coordinates[1][0],
                        destination_lat: street_coordinates[1][1],
                        maximum_distance_m: opt
                            .walk_m
                            .max(duration * opt.walk_speed.unwrap_or(self.speed) / 3.6),
                        maximum_points: 512,
                    })?;
                    (path.coordinates, path.distance_m, path.found)
                };
            // Never attach a longer, newly searched path to an already priced
            // walk and then claim that path fits the timetable's walking cost.
            if found
                && path_distance * 3.6 / opt.walk_speed.unwrap_or(self.speed)
                    <= street_budget + 0.061
            {
                let street: Vec<[f64; 2]> = path_coordinates
                    .chunks_exact(2)
                    .map(|p| [p[0], p[1]])
                    .collect();
                let mut combined = if role == Some(1) {
                    station_coordinates.clone()
                } else {
                    vec![]
                };
                combined.extend(street);
                if role == Some(0) {
                    combined.extend(station_coordinates);
                }
                value["coordinates"] = json!(combined);
                value["geometrySource"] = json!(if value.get("accessCost").is_some() {
                    "osm_and_station_path"
                } else {
                    "osm"
                });
                value["streetSegmentVerified"] = json!(true);
                value["streetPathVerified"] = json!(value.get("stationAccessStatus").is_none());
                if distance.is_none() {
                    value["distanceMeters"] = json!(path_distance);
                }
            }
        }
        if geometry && value.get("coordinates").is_none() {
            value["coordinates"] = json!(
                coordinates
                    .iter()
                    .filter(|c| c.iter().all(|v| v.is_finite()))
                    .collect::<Vec<_>>()
            );
            if value.get("geometrySource").is_none() {
                value["geometrySource"] = json!("unverified_transfer");
            }
        }
        Ok(value)
    }

    pub(crate) fn annotate_station_walks(
        &self,
        value: &mut Value,
        endpoints: [&Point; 2],
    ) -> Result<()> {
        let legs = value["legs"].as_array_mut().ok_or("Missing journey legs")?;
        let mut stations = HashSet::new();
        for leg in legs.iter().filter(|leg| leg["kind"] == "ride") {
            let subway = matches!(leg["route"]["type"].as_i64(), Some(1 | 401 | 402));
            for key in ["fromStopId", "toStopId"] {
                if let Some(id) = leg[key].as_str()
                    && (subway || !self.stop(id)?.parent.is_empty())
                {
                    stations.insert(id.to_owned());
                }
            }
        }
        let last = legs.len().saturating_sub(1);
        for (i, leg) in legs.iter_mut().enumerate() {
            if leg["kind"] != "walk"
                || (i == 0 && endpoints[0].stop.is_some())
                || (i == last && endpoints[1].stop.is_some())
                || (leg["fromStopId"].is_string() && leg["fromStopId"] == leg["toStopId"])
            {
                continue;
            }
            let ids: Vec<_> = ["fromStopId", "toStopId"]
                .iter()
                .filter_map(|key| leg[key].as_str())
                .filter(|id| stations.contains(*id))
                .map(str::to_owned)
                .collect();
            if ids.is_empty() && leg.get("stationAccessStatus").is_none() {
                continue;
            }
            let source_path = leg["stationPathSources"].as_array().is_some_and(|sources| {
                !sources.is_empty() && sources.iter().all(|s| s.as_str().is_some_and(pathway))
            });
            leg["stationAccessStatus"] = json!(if source_path {
                "source_path"
            } else {
                "unverified"
            });
            leg["stationAccessStopIds"] = json!(ids);
            if !source_path {
                leg["streetSegmentVerified"] = json!(
                    leg["streetSegmentVerified"] == true || leg["streetPathVerified"] == true
                );
                leg["streetPathVerified"] = json!(false);
            }
        }
        let unverified = legs
            .iter()
            .filter(|leg| leg["stationAccessStatus"] == "unverified")
            .count();
        value["unverifiedStationAccessLegs"] = json!(unverified);
        Ok(())
    }
}
