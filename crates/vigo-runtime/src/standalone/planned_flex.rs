//! Query-local planned zones use the same FIFO hops and integrated timetable
//! search as imported Flex. They never alter a prepared City. Their explicit
//! planning model is typical wait plus direct distance / configured speed.
use super::flex_index::{Call, FlexIndex, Place, Trip};
use super::flex_search::{End, Hop, Hops, Side, Stopping, Want};
use super::query::{Candidates, Options, Point, haversine};
use super::{City, Result, fail, number};
use serde_json::{Value, json};
use std::sync::Arc;

#[derive(Clone)]
pub(super) struct Zone {
    pub id: String,
    pub name: String,
    pub geometry: Value,
    pub start: f64,
    pub end: f64,
    pub speed: f64,
    pub wait: f64,
}
impl Zone {
    pub fn contains(&self, p: [f64; 2]) -> bool {
        super::flex::contains(&self.geometry, p)
    }
    pub fn duration(&self, a: [f64; 2], b: [f64; 2]) -> f64 {
        (self.wait + haversine(a, b) / self.speed * 3.6).ceil()
    }
    pub fn clock(&self, a: [f64; 2], b: [f64; 2], time: f64, reverse: bool) -> Option<f64> {
        let d = self.duration(a, b);
        if reverse {
            let t = time.min(self.end) - d;
            (t >= self.start).then_some(t)
        } else {
            let t = time.max(self.start) + d;
            (t <= self.end).then_some(t)
        }
    }
}

pub(super) struct Surface {
    zones: Vec<Zone>,
    sources: Vec<Vec<([f64; 2], f64)>>,
    place: [f64; 2],
    time: f64,
    reverse: bool,
    buffer: f64,
}
impl Surface {
    pub fn minutes(&self, p: [f64; 2]) -> f64 {
        let mut best = f64::INFINITY;
        for (index, zone) in self.zones.iter().enumerate() {
            if !zone.contains(p) {
                continue;
            }
            let elapsed = |t: f64| {
                if self.reverse {
                    (self.time - t) / 60.
                } else {
                    (t - self.time) / 60.
                }
            };
            if zone.contains(self.place) {
                if let Some(t) = zone.clock(self.place, p, self.time, self.reverse) {
                    best = best.min(elapsed(t));
                }
            }
            for &(hub, t) in &self.sources[index] {
                let ready = t + if self.reverse {
                    -self.buffer
                } else {
                    self.buffer
                };
                if let Some(t) = zone.clock(hub, p, ready, self.reverse) {
                    best = best.min(elapsed(t));
                }
            }
        }
        best
    }
}

impl City {
    /// Reach uses the same zone hop clocks as Route. Reserve one boarding
    /// for each conditional end, then run the ordinary many-target scan.
    /// The output surface adds zone egress at its declared raster resolution.
    pub(super) fn planned_zone_reach(
        &mut self,
        q: &Value,
        place: &Point,
        opt: &Options,
        maximum: f64,
    ) -> Result<(Vec<(Point, f64)>, Surface)> {
        let zones = self.parse_planned_zones(&q["scenario"], q)?;
        self.activate(q)?;
        self.install_scenario(&q["scenario"])?;
        self.apply_transfer_buffer(q)?;
        let mut options = Options::parse(q)?;
        if opt.arrive {
            options.start = opt.time - maximum * 60.;
        } else {
            options.end = opt.time + maximum * 60.;
        }
        let ids = self.timetable.as_ref().unwrap().stop_ids.clone();
        let points = ids
            .iter()
            .map(|id| {
                let s = self.stop(id)?;
                Ok(Point {
                    coordinate: [s.lon, s.lat],
                    stop: Some(id.clone()),
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let walk = self.candidates(
            place,
            if opt.arrive { "destination" } else { "origin" },
            &options,
        )?;
        let buffer = number(q, "minimumTransferBufferMinutes", 0., 0., 60.)? * 60.;
        let mut flex = Candidates {
            stops: vec![],
            seconds: vec![],
            terminal_transfers: false,
            evidence: None,
        };
        let mut direct = vec![f64::INFINITY; points.len()];
        for (i, p) in points.iter().enumerate() {
            let mut best = f64::INFINITY;
            for z in &zones {
                if z.contains(place.coordinate) && z.contains(p.coordinate) {
                    if let Some(t) = z.clock(place.coordinate, p.coordinate, opt.time, opt.arrive) {
                        best = best.min(if opt.arrive {
                            opt.time - t + buffer
                        } else {
                            t - opt.time + buffer
                        });
                    }
                }
            }
            if best.is_finite() {
                direct[i] = (best - buffer) / 60.;
                flex.stops.push(i as u32);
                flex.seconds.push(best);
            }
        }
        let all: Vec<_> = (0..points.len())
            .map(|i| Candidates {
                stops: vec![i as u32],
                seconds: vec![0.],
                terminal_transfers: false,
                evidence: None,
            })
            .collect();
        let mut scan = |ends: &Candidates, reserved: u32| -> Result<Vec<f64>> {
            if ends.stops.is_empty() || opt.max_boardings.is_some_and(|n| n <= reserved) {
                return Ok(vec![f64::INFINITY; points.len()]);
            }
            let (a, b) = if opt.arrive {
                (&all[..], std::slice::from_ref(ends))
            } else {
                (std::slice::from_ref(ends), &all[..])
            };
            let mut input = Self::matrix_input(a, b, &options, false);
            input.maximum_boardings = opt.max_boardings.map(|n| n - reserved);
            let r = self
                .timetable
                .as_mut()
                .unwrap()
                .kernel
                .route_matrix_csa(input)?;
            Ok(r.times
                .iter()
                .map(|&t| {
                    if opt.arrive {
                        (opt.time - t) / 60.
                    } else {
                        (t - opt.time) / 60.
                    }
                })
                .collect())
        };
        let ordinary = scan(&walk, 0)?;
        let access = scan(&flex, 1)?;
        // Without a boarding cap, reserving a Flex boarding does not change
        // either timetable query. Reuse those results for zone egress.
        let exit = if opt.max_boardings.is_some() {
            Some(scan(&walk, 1)?)
        } else {
            None
        };
        let both = if opt.max_boardings.is_some() {
            Some(scan(&flex, 2)?)
        } else {
            None
        };
        let exit = exit.as_deref().unwrap_or(&ordinary);
        let both = both.as_deref().unwrap_or(&access);
        let mut seeds = vec![];
        let mut sources = vec![];
        for (i, p) in points.into_iter().enumerate() {
            let duration = ordinary[i].min(access[i]).min(direct[i]);
            if duration.is_finite() && duration <= maximum {
                seeds.push((p.clone(), duration));
            }
            let duration = exit[i].min(both[i]);
            if duration.is_finite() && duration <= maximum {
                sources.push((
                    p.coordinate,
                    opt.time
                        + if opt.arrive {
                            -duration * 60.
                        } else {
                            duration * 60.
                        },
                ));
            }
        }
        let sources = zones
            .iter()
            .map(|zone| {
                sources
                    .iter()
                    .copied()
                    .filter(|(point, _)| zone.contains(*point))
                    .collect()
            })
            .collect();
        Ok((
            seeds,
            Surface {
                zones,
                sources,
                place: place.coordinate,
                time: opt.time,
                reverse: opt.arrive,
                buffer,
            },
        ))
    }
    pub(super) fn parse_planned_zones(&self, scenario: &Value, q: &Value) -> Result<Vec<Zone>> {
        let Some(raw) = scenario.get("flexZones") else {
            return Ok(vec![]);
        };
        let zones = raw
            .as_array()
            .ok_or("scenario.flexZones must be an array")?;
        if zones.len() > 48 {
            return fail("At most 48 planned Flex zones per query");
        }
        let date = chrono::NaiveDate::parse_from_str(
            q["serviceDate"].as_str().ok_or("serviceDate required")?,
            "%Y-%m-%d",
        )?;
        let offset = if let Some(original) = &self.query_start_date {
            let original = chrono::NaiveDate::parse_from_str(original, "%Y-%m-%d")?;
            let tz: chrono_tz::Tz = self.metadata["agencyTimezones"][0]
                .as_str()
                .unwrap_or("UTC")
                .parse()?;
            (super::calendar::service_epoch(tz, original)?
                - super::calendar::service_epoch(tz, date)?) as f64
        } else {
            0.
        };
        zones
            .iter()
            .map(|v| {
                let g = &v["geometry"];
                if g["type"] != "Polygon" {
                    return fail("A planned Flex outline must be a Polygon");
                }
                let rings = g["coordinates"]
                    .as_array()
                    .filter(|r| !r.is_empty())
                    .ok_or("Flex outline requires rings")?;
                for ring in rings {
                    let points = ring
                        .as_array()
                        .filter(|p| (4..=257).contains(&p.len()))
                        .ok_or("Flex rings require 3..256 corners and a closing point")?;
                    if points.first() != points.last() {
                        return fail("Flex outline must be closed");
                    }
                    for p in points {
                        let p = p
                            .as_array()
                            .filter(|p| p.len() == 2)
                            .ok_or("Flex coordinates must be longitude, latitude")?;
                        if !p[0]
                            .as_f64()
                            .is_some_and(|n| n.is_finite() && n.abs() <= 180.)
                            || !p[1]
                                .as_f64()
                                .is_some_and(|n| n.is_finite() && n.abs() <= 90.)
                        {
                            return fail("Invalid Flex coordinate");
                        }
                    }
                }
                let start = number(v, "startMinutes", 360., 0., 2880.)? * 60. + offset;
                let end = number(v, "endMinutes", 1320., 0., 2880.)? * 60. + offset;
                if end <= start {
                    return fail("Flex endMinutes must be after startMinutes");
                }
                Ok(Zone {
                    id: v["id"].as_str().ok_or("Flex zone requires id")?.into(),
                    name: v["name"].as_str().unwrap_or("Planned Flex").into(),
                    geometry: g.clone(),
                    start,
                    end,
                    speed: number(v, "averageSpeedKph", 30., 4., 120.)?,
                    wait: number(v, "waitMinutes", 15., 0., 120.)? * 60.,
                })
            })
            .collect()
    }

    pub(super) fn planned_hops(
        &self,
        q: &Value,
        _opt: &Options,
        origin: &Point,
        destination: &Point,
        want: Want,
    ) -> Result<Hops> {
        let mut index = FlexIndex::default();
        let mut list = vec![];
        let mut truncated = false;
        let date = chrono::NaiveDate::parse_from_str(
            q["serviceDate"].as_str().ok_or("serviceDate required")?,
            "%Y-%m-%d",
        )?;
        let end = |p: &Point| End {
            coordinate: p.coordinate,
            stop: None,
            planned_stop: p.stop.clone(),
            walk: 0.,
            meters: 0.,
            priced: true,
        };
        for (i, z) in self.planned_flex.as_ref().into_iter().flatten().enumerate() {
            let call = || Call {
                place: Place::Zone(i as u32),
                start: z.start,
                end: z.end,
                window: true,
                pickup: 0,
                dropoff: 0,
                pickup_booking: None,
                dropoff_booking: None,
            };
            index.trips.push(Trip {
                planned: Some(json!({"name":z.name})),
                trip_id: format!("planned-flex:{}", z.id),
                route_id: format!("planned-flex:{}", z.id),
                service_id: "planned-flex".into(),
                wheelchair: false,
                on_demand: true,
                factor: Some(1.),
                offset: Some(z.wait),
                pattern: None,
                calls: vec![call(), call()],
                id_value: json!(z.id),
            });
            let mut add = |a: End, b: End, sides| {
                if list.len() >= 65_536 {
                    truncated = true;
                    return;
                }
                let duration = z.duration(a.coordinate, b.coordinate);
                if z.start + duration > z.end {
                    return;
                }
                let stopping = |call| Stopping {
                    call,
                    projection: None,
                    permission: 0,
                    booking: None,
                    position: None,
                };
                list.push(Hop {
                    trip: i as u32,
                    day: 0,
                    board: a,
                    alight: b,
                    a: stopping(0),
                    b: stopping(1),
                    lo: z.start,
                    hi: z.end - duration,
                    duration,
                    factor: 1.,
                    offset: z.wait,
                    anchors: None,
                    sides,
                });
            };
            let inside_o = z.contains(origin.coordinate);
            let inside_d = z.contains(destination.coordinate);
            if want.direct && inside_o && inside_d {
                add(end(origin), end(destination), (Side::Free, Side::Free));
            }
            if (want.access && inside_o) || (want.egress && inside_d) {
                if let Some(t) = &self.timetable {
                    for id in t.stop_ids.iter() {
                        let s = self.stop(id)?;
                        let p = Point {
                            coordinate: [s.lon, s.lat],
                            stop: Some(id.clone()),
                        };
                        if !z.contains(p.coordinate) {
                            continue;
                        }
                        if want.access && inside_o {
                            add(end(origin), end(&p), (Side::Free, Side::Hub));
                        }
                        if want.egress && inside_d {
                            add(end(&p), end(destination), (Side::Hub, Side::Free));
                        }
                    }
                }
            }
        }
        Ok(Hops {
            index: Arc::new(index),
            list,
            days: vec![(date, 0.)],
            truncated,
            promising: false,
        })
    }

    pub(super) fn planned_zone_route(&mut self, q: &Value) -> Result<Value> {
        // Keep ordinary alternatives and compare conditional choices at each
        // requested clock. Fixed service and zone rides share the active view.
        let ordinary = self.route(q)?;
        let mut choices = ordinary["choices"].as_array().cloned().unwrap_or_default();
        if ordinary["status"] == "ready" {
            choices.push(ordinary.clone());
        }
        let opt = Options::parse(q)?;
        let window = number(q, "windowMinutes", 0., 0., 240.)?;
        let mut query = q.clone();
        for k in [
            "windowMinutes",
            "windowChoices",
            "journeyPolicy",
            "sharedLegs",
            "includeEarliestTransit",
            "alternatives",
            "alternativeRanking",
            "alternativeSlackMinutes",
            "expandedWalkKm",
        ] {
            query.as_object_mut().unwrap().remove(k);
        }
        query["flex"] = json!({});
        query.as_object_mut().unwrap().remove("time");
        for sample in 0..=window.floor() as usize {
            query["timeMinutes"] = json!(
                opt.time / 60.
                    + if opt.arrive {
                        -(sample as f64)
                    } else {
                        sample as f64
                    }
            );
            let result = self.route_with_flex(&query)?;
            if result["status"] == "ready" {
                choices.push(result.clone());
            }
            choices.extend(result["choices"].as_array().into_iter().flatten().cloned());
        }
        let choices = super::alternatives::select(choices, opt.arrive, 5);
        let mut result = choices.first().cloned().unwrap_or(ordinary);
        result["choices"] = json!(choices);
        result["plannedFlex"] =
            json!({"model":"direct_distance_plus_wait","confirmsAvailability":false});
        Ok(result)
    }
}
