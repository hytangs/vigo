//! Query-local planned zones use the same FIFO hops and integrated timetable
//! search as imported Flex. They never alter a prepared City. Their explicit
//! planning model is typical wait plus direct distance / configured speed.
use super::flex_index::{Call, FlexIndex, Place, Trip};
use super::flex_search::{End, Hop, Hops, Integrated, Side, Stopping, Want};
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
    direct: Vec<bool>,
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
            if self.direct[index]
                && let Some(t) = zone.clock(self.place, p, self.time, self.reverse)
            {
                best = best.min(elapsed(t));
            }
            for &(hub, t) in &self.sources[index] {
                let ready = t + if self.reverse {
                    -self.buffer
                } else {
                    self.buffer
                };
                // Sources are ordered by their best possible elapsed time.
                // Travel distance is nonnegative, so later sources cannot
                // improve an already better arrival (or reverse departure).
                if elapsed(ready) + zone.wait / 60. >= best {
                    break;
                }
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
            terminal_transfers: true,
            evidence: None,
        };
        let mut direct = vec![f64::INFINITY; points.len()];
        for (i, p) in points.iter().enumerate() {
            let mut best = f64::INFINITY;
            for z in &zones {
                if z.contains(place.coordinate)
                    && z.contains(p.coordinate)
                    && let Some(t) = z.clock(place.coordinate, p.coordinate, opt.time, opt.arrive)
                {
                    best = best.min(if opt.arrive {
                        opt.time - t + buffer
                    } else {
                        t - opt.time + buffer
                    });
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
        let mut scan =
            |ends: &Candidates, reserved: u32, hub_transfers: bool| -> Result<Vec<f64>> {
                if ends.stops.is_empty() || opt.max_boardings.is_some_and(|n| n <= reserved) {
                    return Ok(vec![f64::INFINITY; points.len()]);
                }
                let (a, b) = if opt.arrive {
                    (&all[..], std::slice::from_ref(ends))
                } else {
                    (std::slice::from_ref(ends), &all[..])
                };
                let mut input = Self::matrix_input(a, b, &options, false);
                if opt.arrive {
                    input.allow_pre_ride_transfers.fill(hub_transfers);
                } else if let Some(flags) = input.allow_post_ride_transfers.as_mut() {
                    flags.fill(hub_transfers);
                }
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
        let ordinary = scan(&walk, 0, false)?;
        let access = scan(&flex, 1, false)?;
        // A walk into a Flex pickup is an interchange, while an ordinary
        // egress keeps its own walking budget. Keep the two frontiers separate.
        let exit = scan(&walk, 1, true)?;
        let both = scan(&flex, 2, true)?;
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
                let mut points: Vec<_> = sources
                    .iter()
                    .copied()
                    .filter(|(point, _)| zone.contains(*point))
                    .collect();
                points.sort_by(|a, b| {
                    if opt.arrive {
                        b.1.total_cmp(&a.1)
                    } else {
                        a.1.total_cmp(&b.1)
                    }
                });
                points
            })
            .collect();
        Ok((
            seeds,
            Surface {
                direct: zones
                    .iter()
                    .map(|zone| zone.contains(place.coordinate))
                    .collect(),
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
            if ((want.access && inside_o) || (want.egress && inside_d))
                && let Some(t) = &self.timetable
            {
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
        let origin = self.point(&q["origin"])?;
        let destination = self.point(&q["destination"])?;
        let interchange = opt.max_boardings != Some(1);
        // Zone geometry, stop membership and hop durations do not change
        // across the window. Ordinary choices were already searched above.
        let mut hops = self.planned_hops(
            q,
            &opt,
            &origin,
            &destination,
            Want {
                direct: true,
                access: interchange,
                egress: interchange,
            },
        )?;
        let mut sample = 0;
        let mut searches = 0;
        let mut reused = 0;
        while sample <= window.floor() as usize {
            query["timeMinutes"] = json!(
                opt.time / 60.
                    + if opt.arrive {
                        -(sample as f64)
                    } else {
                        sample as f64
                    }
            );
            let at = Options::parse(&query)?;
            let mut conditional =
                self.flex_direct(&query, &at, &mut hops, [&origin, &destination], 9)?;
            if interchange {
                match self.flex_integrated(&query, &at, &mut hops, [&origin, &destination], None)? {
                    Integrated::Journey(plan) => conditional.push(plan),
                    Integrated::RuleBound => conditional.extend(self.flex_transfers(&query)?),
                    Integrated::None => {}
                }
            }
            searches += 1;
            // FIFO: a certified winner that still catches the same first
            // scheduled vehicle remains optimal at a later origin clock.
            // Direct/initial Flex rides keep exact forward samples.
            let catch = (!opt.arrive && !conditional.is_empty())
                .then(|| {
                    conditional
                        .iter()
                        .map(|p| fixed_first_catch(p, at.end / 60.))
                        .collect::<Option<Vec<_>>>()
                        .map(|v| v.into_iter().fold(f64::INFINITY, f64::min))
                })
                .flatten();
            choices.extend(conditional.iter().cloned());
            sample += 1;
            while sample <= window.floor() as usize
                && catch.is_some_and(|c| opt.time / 60. + sample as f64 <= c)
            {
                for plan in &conditional {
                    choices.push(super::window::retime(
                        plan,
                        opt.time / 60. + sample as f64,
                        catch,
                    ));
                }
                reused += 1;
                sample += 1;
            }
            // In reverse, an unchanged latest-departure witness remains
            // optimal while its actual arrival meets the earlier deadline.
            let arrived = conditional
                .iter()
                .filter_map(|p| p["arrivalMinutes"].as_f64())
                .fold(f64::NEG_INFINITY, f64::max);
            while opt.arrive
                && !conditional.is_empty()
                && sample <= window.floor() as usize
                && opt.time / 60. - sample as f64 >= arrived
            {
                choices.extend(conditional.iter().cloned());
                reused += 1;
                sample += 1;
            }
        }
        let choices = super::alternatives::select(choices, opt.arrive, 5);
        let mut result = choices.first().cloned().unwrap_or(ordinary);
        result["choices"] = json!(choices);
        result["plannedFlex"] = json!({"model":"direct_distance_plus_wait","confirmsAvailability":false,"searches":searches,"reusedSamples":reused});
        Ok(result)
    }
}

fn fixed_first_catch(plan: &Value, horizon: f64) -> Option<f64> {
    let legs = plan["legs"].as_array()?;
    let first = legs.iter().position(|leg| leg["kind"] == "ride")?;
    let ride = &legs[first];
    if ride["flexEstimate"].is_object()
        || legs.iter().any(|leg| leg["headwayEstimate"].is_object())
        || plan["arrivalMinutes"].as_f64()? > horizon
    {
        return None;
    }
    let walk: Option<f64> = legs[..first]
        .iter()
        .map(|leg| leg["durationMinutes"].as_f64())
        .sum();
    Some(ride["departureMinutes"].as_f64()? - walk?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordered_zone_sources_match_exhaustive_clocks() {
        let zone = Zone {
            id: "zone".into(),
            name: "Zone".into(),
            geometry: json!({"type":"Polygon","coordinates":[[[0.,0.],[1.,0.],[1.,1.],[0.,1.],[0.,0.]]]}),
            start: 1800.,
            end: 7200.,
            speed: 30.,
            wait: 180.,
        };
        for reverse in [false, true] {
            let time = if reverse { 7000. } else { 1200. };
            let mut sources: Vec<_> = (0..40)
                .map(|i| {
                    (
                        [0.1 + (i % 7) as f64 * 0.1, 0.1 + (i % 5) as f64 * 0.1],
                        time + if reverse {
                            -(i as f64) * 60.
                        } else {
                            i as f64 * 60.
                        },
                    )
                })
                .collect();
            sources.sort_by(|a, b| {
                if reverse {
                    b.1.total_cmp(&a.1)
                } else {
                    a.1.total_cmp(&b.1)
                }
            });
            let surface = Surface {
                zones: vec![zone.clone()],
                sources: vec![sources.clone()],
                place: [-1., -1.],
                time,
                reverse,
                buffer: 60.,
                direct: vec![false],
            };
            for x in 0..20 {
                let p = [0.025 + x as f64 * 0.05, 0.4];
                let expected = sources
                    .iter()
                    .filter_map(|(hub, t)| {
                        zone.clock(*hub, p, t + if reverse { -60. } else { 60. }, reverse)
                    })
                    .map(|t| {
                        if reverse {
                            (time - t) / 60.
                        } else {
                            (t - time) / 60.
                        }
                    })
                    .fold(f64::INFINITY, f64::min);
                assert_eq!(surface.minutes(p), expected);
            }
        }
    }
}
