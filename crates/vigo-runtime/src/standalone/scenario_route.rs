//! Routes on a planned scenario. The active timetable is derived into a view
//! with the scenario's removed trips cancelled and its planned services added
//! as trips over existing and new stops; the request then routes on that view
//! with every Route option. A view is kept like any other timetable.
use super::city::{Stop, Timetable};
use super::query::{Candidates, Options, Point};
use super::{City, Result, fail};
use crate::{ScenarioPlan, StreetMatrixInput};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

/// What a scenario view adds to the City: its new stops (timetable index and
/// coordinate) and, for each planned route, the service it runs.
pub(crate) struct ScenarioPresentation {
    pub stops: HashMap<String, Stop>,
    pub appended: Vec<(u32, [f64; 2])>,
    pub services: HashMap<String, Value>,
}

const RETAINED_VIEWS: usize = 8;

impl City {
    /// Route `q` on the view its `scenario` describes.
    pub(super) fn scenario_route(&mut self, q: &Value) -> Result<Value> {
        let scenario = &q["scenario"];
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
                "cityRevision",
            ]
            .contains(&key.as_str())
            {
                return fail(format!(
                    "Unsupported scenario field: {key}; use explicit trip exclusions and schedules"
                ));
            }
        }
        if scenario
            .get("cityRevision")
            .is_some_and(|v| v != &self.manifest["revisionId"])
        {
            return fail("Scenario belongs to another City revision");
        }
        if q["mode"].as_str().unwrap_or("transit") != "transit" {
            return fail("A scenario changes transit service; route it in transit mode");
        }
        if q.get("routingDataMode")
            .or_else(|| q.get("dataMode"))
            .is_some_and(|mode| mode == "realtime")
        {
            return fail("Scenario routes use the scheduled timetable");
        }
        let mut base = q.clone();
        base.as_object_mut().unwrap().remove("scenario");
        self.activate(&base)?;
        self.install_scenario(scenario)?;
        // A retained view keeps the buffer it was last searched with.
        self.apply_transfer_buffer(&base)?;
        self.pinned_timetable = true;
        let result = self.route(&base);
        self.pinned_timetable = false;
        let mut result = result?;
        result["scenario"] = json!({"id":scenario["id"],"name":scenario["name"]});
        Ok(result)
    }

    /// Make the view of the active timetable under `scenario` active.
    pub(super) fn install_scenario(&mut self, scenario: &Value) -> Result<()> {
        let t = self.timetable.as_ref().ok_or("Timetable is not active")?;
        let digest = format!("{:x}", Sha256::digest(serde_json::to_vec(scenario)?));
        // The view's planned stops, routes and trips belong to its own feed.
        let tag = format!("scenario-{}", &digest[..12]);
        let key = format!("{}:{tag}", t.key);
        let coverage_end = t.coverage_end;
        if let (Some(index), Some(presentation)) = (
            self.timetable_cache.find(&key, coverage_end),
            self.scenario_views.get(&key).cloned(),
        ) {
            let view = self.timetable_cache.take(index);
            self.retire_timetable();
            self.timetable = Some(view);
            self.install_query_workspace();
            self.scenario_view = Some(presentation);
            return Ok(());
        }
        let (view, presentation) = self.derive_scenario(scenario, &tag, key.clone())?;
        self.retire_timetable();
        self.timetable = Some(view);
        self.install_query_workspace();
        if self.scenario_views.len() >= RETAINED_VIEWS {
            self.scenario_views.clear();
        }
        let presentation = Arc::new(presentation);
        self.scenario_views.insert(key, presentation.clone());
        self.scenario_view = Some(presentation);
        Ok(())
    }

    fn derive_scenario(
        &mut self,
        scenario: &Value,
        tag: &str,
        key: String,
    ) -> Result<(Timetable, ScenarioPresentation)> {
        let planned = if scenario["services"].is_null() {
            None
        } else {
            Some(self.planned(scenario)?)
        };
        let t = self.timetable.as_ref().unwrap();
        let n = t.stop_ids.len() as u32;
        let mut canceled = vec![0_u8; t.trip_ids.len()];
        let excluded = |field: &str| -> Result<HashSet<&str>> {
            let Some(values) = scenario.get(field) else {
                return Ok(HashSet::new());
            };
            values
                .as_array()
                .ok_or("Scenario exclusions must be arrays")?
                .iter()
                .map(|id| {
                    id.as_str()
                        .ok_or_else(|| "Scenario IDs must be strings".into())
                })
                .collect()
        };
        let (trips, routes) = (excluded("excludedTripIds")?, excluded("excludedRouteIds")?);
        for (trip, flag) in canceled.iter_mut().enumerate() {
            if trips.contains(t.trip_ids[trip].as_str())
                || routes.contains(t.route_ids[trip].as_str())
            {
                *flag = 1;
            }
        }
        let links = t.links.clone();
        let mut stop_index = vec![];
        let mut appended = vec![];
        if let Some(planned) = &planned {
            for &trip in &planned.excluded_trips {
                canceled[trip as usize] = 1;
            }
            // A planned stop on a resident stop is that stop; others are new.
            for (point, stop) in planned.points.iter().enumerate() {
                match stop.stop.as_ref().and_then(|id| t.index.get(id)) {
                    Some(&index) => stop_index.push(index),
                    None => {
                        stop_index.push(n + appended.len() as u32);
                        appended.push(point);
                    }
                }
            }
        }
        let mut canceled_spans = Vec::new();
        for (&logical, parts) in &t.links {
            canceled[logical as usize] = 0;
            for part in parts {
                if canceled[part.trip as usize] != 0 {
                    canceled_spans.extend([
                        logical,
                        part.first,
                        part.first + part.sequences.len() as u32 - 1,
                    ]);
                }
            }
        }
        let (stop_ids, trip_ids, route_ids, trip_dates) = (
            t.stop_ids.clone(),
            t.trip_ids.clone(),
            t.route_ids.clone(),
            t.trip_service_dates.clone(),
        );
        let (index, complete, coverage_end) =
            (t.index.clone(), t.complete_service_coverage, t.coverage_end);
        let empty = super::scenario::Planned {
            direction_offsets: vec![0],
            ..Default::default()
        };
        let planned = planned.unwrap_or(empty);
        let (from, to, duration) = self.new_stop_links(&planned, &appended, n)?;
        let seconds = |values: &[f64]| -> Vec<u32> {
            values.iter().map(|v| v.round().max(0.) as u32).collect()
        };
        let plan = ScenarioPlan {
            added_stop_count: appended.len() as u32,
            canceled: canceled.into(),
            canceled_spans: Some(canceled_spans.into()),
            pattern_offsets: planned.direction_offsets.clone().into(),
            pattern_stops: planned
                .direction_stops
                .iter()
                .map(|&point| stop_index[point as usize])
                .collect::<Vec<_>>()
                .into(),
            pattern_departure_offsets: seconds(&planned.departures).into(),
            pattern_arrival_offsets: seconds(&planned.arrivals).into(),
            pattern_can_board: planned.board.clone().into(),
            pattern_can_alight: planned.alight.clone().into(),
            run_start_seconds: seconds(&planned.starts).into(),
            run_end_seconds: seconds(&planned.ends).into(),
            run_headway_seconds: planned
                .headways
                .iter()
                .map(|v| v.round().max(1.) as u32)
                .collect::<Vec<_>>()
                .into(),
            added_transfer_from: from.into(),
            added_transfer_to: to.into(),
            added_transfer_duration: duration.into(),
        };
        let view = self
            .timetable
            .as_ref()
            .unwrap()
            .kernel
            .scenario_view(plan)?;

        // Names: new stops, and one route per planned service.
        let services = scenario["services"].as_array().cloned().unwrap_or_default();
        let service = |run: usize| &services[planned.run_services[run]];
        let service_id = |run: usize| {
            service(run)["id"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or(format!("service-{}", planned.run_services[run] + 1))
        };
        let service_name = |run: usize| {
            service(run)["name"]
                .as_str()
                .filter(|name| !name.is_empty())
                .map(str::to_owned)
                .unwrap_or(format!("Planned service {}", planned.run_services[run] + 1))
        };
        let mut presentation = ScenarioPresentation {
            stops: HashMap::new(),
            appended: vec![],
            services: HashMap::new(),
        };
        let mut stop_ids = stop_ids.to_vec();
        let mut index = (*index).clone();
        for (k, &point) in appended.iter().enumerate() {
            let id = format!("{tag}\u{1f}stop:{k}");
            let [lon, lat] = planned.points[point].coordinate;
            index.insert(id.clone(), n + k as u32);
            stop_ids.push(id.clone());
            presentation.appended.push((n + k as u32, [lon, lat]));
            presentation.stops.insert(
                id.clone(),
                Stop {
                    id,
                    name: planned.labels[point].clone(),
                    lon,
                    lat,
                    parent: String::new(),
                    location: 0,
                },
            );
        }
        let (mut trip_ids, mut route_ids, mut trip_dates) =
            (trip_ids.to_vec(), route_ids.to_vec(), trip_dates.to_vec());
        for (&run, &departure) in view
            .added_trip_patterns
            .iter()
            .zip(view.added_trip_departures.iter())
        {
            let run = run as usize;
            let route = format!("{tag}\u{1f}{}", service_id(run));
            let trip = format!("{route}:{run}:{departure}");
            let inbound = planned.run_inbound[run];
            let name = service_name(run);
            self.route_metadata.entry(route.clone()).or_insert_with(
                || json!({"shortName":name,"longName":null,"type":3,"color":"7c5cff"}),
            );
            self.trip_details.insert(
                trip.clone(),
                json!({"service":null,"direction":if inbound {"1"} else {"0"},
                    "headsign":if inbound { format!("{name} · return") } else { name.clone() },"shortName":null}),
            );
            presentation
                .services
                .entry(route.clone())
                .or_insert_with(|| {
                    json!({"scenarioId":scenario["id"],"scenarioName":scenario["name"],
                    "serviceId":service_id(run),"name":name})
                });
            trip_ids.push(trip);
            route_ids.push(route);
            trip_dates.push(String::new());
        }
        Ok((
            Timetable {
                heap: Default::default(),
                links,
                kernel: view.kernel,
                stop_ids: stop_ids.into(),
                index: Arc::new(index),
                trip_ids: trip_ids.into(),
                route_ids: route_ids.into(),
                trip_service_dates: trip_dates.into(),
                key,
                realtime: Value::Null,
                preparation: "scenario",
                complete_service_coverage: complete,
                coverage_end,
                realtime_trips: Arc::new([]),
                alerts: None,
            },
            presentation,
        ))
    }

    /// Walking links of new stops to resident stops and to each other, at
    /// the radius the City's own stop transfers use.
    fn new_stop_links(
        &mut self,
        planned: &super::scenario::Planned,
        appended: &[usize],
        n: u32,
    ) -> Result<(Vec<u32>, Vec<u32>, Vec<u32>)> {
        let (mut from, mut to, mut duration) = (vec![], vec![], vec![]);
        if appended.is_empty() {
            return Ok((from, to, duration));
        }
        let radius = self.metadata["transferGeneration"]["osmMaximumWalkM"]
            .as_f64()
            .unwrap_or(500.);
        let links = Options::parse(&json!({"time":"00:00","maxWalkKm":radius / 1000.}))?;
        for (k, &point) in appended.iter().enumerate() {
            let stop = n + k as u32;
            let point = Point {
                coordinate: planned.points[point].coordinate,
                stop: None,
            };
            let out = self.street_candidates(&point, "origin", &links, 1., 0.)?;
            for (&target, &seconds) in out.stops.iter().zip(&out.seconds) {
                from.push(stop);
                to.push(target);
                duration.push(seconds.ceil() as u32);
            }
            let inbound = self.street_candidates(&point, "destination", &links, 1., 0.)?;
            for (&source, &seconds) in inbound.stops.iter().zip(&inbound.seconds) {
                from.push(source);
                to.push(stop);
                duration.push(seconds.ceil() as u32);
            }
        }
        if appended.len() > 1 {
            let coordinates: Vec<f64> = appended
                .iter()
                .flat_map(|&point| planned.points[point].coordinate)
                .collect();
            let walk = self.street.route_street_matrix(StreetMatrixInput {
                origin_coordinates: coordinates.clone(),
                destination_coordinates: coordinates,
                maximum_distance_m: radius,
                disable_cache: Some(false),
            })?;
            let m = appended.len();
            for a in 0..m {
                for b in 0..m {
                    let meters = walk.distances_m[a * m + b];
                    if a != b && meters.is_finite() {
                        from.push(n + a as u32);
                        to.push(n + b as u32);
                        duration.push((meters / self.speed * 3.6).ceil() as u32);
                    }
                }
            }
        }
        Ok((from, to, duration))
    }

    /// Add the active view's new stops a walk from `point` reaches.
    pub(super) fn with_scenario_access(
        &mut self,
        point: &Point,
        opt: &Options,
        mut candidates: Candidates,
    ) -> Result<Candidates> {
        let Some(view) = self
            .scenario_view
            .clone()
            .filter(|v| !v.appended.is_empty())
        else {
            return Ok(candidates);
        };
        let walk = self.street.route_street_matrix(StreetMatrixInput {
            origin_coordinates: point.coordinate.to_vec(),
            destination_coordinates: view.appended.iter().flat_map(|(_, c)| *c).collect(),
            maximum_distance_m: opt.walk_m,
            disable_cache: Some(opt.disable_cache),
        })?;
        for ((stop, _), &meters) in view.appended.iter().zip(&walk.distances_m) {
            if meters.is_finite() {
                candidates.stops.push(*stop);
                candidates.seconds.push(
                    (meters / opt.walk_speed.unwrap_or(self.speed) * 3.6 * self.padding
                        + self.overhead)
                        .ceil(),
                );
            }
        }
        Ok(candidates)
    }
}
