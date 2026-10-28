//! Typed, query-ready view of the prepared GTFS Flex catalogs. It is compiled
//! once per City from the records `flex_catalogs` validates; nothing new is
//! persisted, so every prepared City keeps its format.
//!
//! A Flex ride between two calls of one trip is a *hop*: board at a point,
//! alight at a point, and a FIFO clock `arrive(t) = max(t, lo) + duration` for
//! a rider ready at `t <= hi`. Zones, location groups, published booking stops,
//! continuous stopping and deviated routes all reduce to that one shape, which
//! is what lets the timetable search treat Flex as time-dependent access and
//! egress instead of composing a search per interchange stop.
use super::{City, Result, query::haversine};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;

pub(super) struct Zone {
    bbox: [f64; 4],
    polygons: Vec<Vec<Vec<[f64; 2]>>>,
    /// City stop indices inside the zone, where riders can change to transit.
    pub stops: Vec<u32>,
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub(super) enum Place {
    Zone(u32),
    Group(u32),
    Stop(u32),
}

pub(super) struct Call {
    pub place: Place,
    pub start: f64,
    pub end: f64,
    pub window: bool,
    pub pickup: u8,
    pub dropoff: u8,
    pub pickup_booking: Option<String>,
    pub dropoff_booking: Option<String>,
}

pub(super) struct Shape {
    pub points: Vec<[f64; 2]>,
    lengths: Vec<f64>,
    bbox: [f64; 4],
}

/// Shape positions and continuous permissions shared by every trip that
/// stops at the same places along the same shape.
pub(super) struct Pattern {
    pub shape: u32,
    pub positions: std::result::Result<Vec<f64>, String>,
    /// Continuous pickup/drop-off permission of the interval after each call.
    continuous: Vec<[u8; 2]>,
}

pub(super) struct Trip {
    pub planned: Option<Value>,
    pub trip_id: String,
    pub route_id: String,
    pub service_id: String,
    pub wheelchair: bool,
    pub on_demand: bool,
    pub factor: Option<f64>,
    pub offset: Option<f64>,
    pub pattern: Option<u32>,
    pub calls: Vec<Call>,
    pub id_value: Value,
}

#[derive(Default)]
pub(super) struct FlexIndex {
    pub zones: Vec<Zone>,
    pub groups: Vec<Vec<u32>>,
    pub bookings: HashMap<String, Value>,
    pub shapes: Vec<Shape>,
    pub patterns: Vec<Pattern>,
    pub trips: Vec<Trip>,
    pub by_service: HashMap<String, Vec<u32>>,
    pub maximum_clock: f64,
    /// Stops named by a Flex call or group: candidates near a free endpoint.
    pub call_stops: Vec<u32>,
    /// Trips that can board or alight at each place, so a request visits
    /// only the trips its endpoints touch.
    pub stop_trips: HashMap<u32, Vec<u32>>,
    pub zone_trips: Vec<Vec<u32>>,
    pub pattern_trips: Vec<Vec<u32>>,
    /// Stops at which a transfer rule may apply; junctions there are checked.
    pub rule_stops: std::collections::HashSet<u32>,
}

fn ring_contains(ring: &[[f64; 2]], p: [f64; 2]) -> bool {
    let mut inside = false;
    for pair in ring.windows(2) {
        let (a, b) = (pair[0], pair[1]);
        let cross = (p[0] - a[0]) * (b[1] - a[1]) - (p[1] - a[1]) * (b[0] - a[0]);
        if cross.abs() < 1e-12
            && p[0] >= a[0].min(b[0])
            && p[0] <= a[0].max(b[0])
            && p[1] >= a[1].min(b[1])
            && p[1] <= a[1].max(b[1])
        {
            return true;
        }
        if (a[1] > p[1]) != (b[1] > p[1])
            && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]
        {
            inside = !inside;
        }
    }
    inside
}

fn bbox_of<'a>(points: impl Iterator<Item = &'a [f64; 2]>) -> [f64; 4] {
    points.fold(
        [
            f64::INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::NEG_INFINITY,
        ],
        |b, p| {
            [
                b[0].min(p[0]),
                b[1].min(p[1]),
                b[2].max(p[0]),
                b[3].max(p[1]),
            ]
        },
    )
}

/// Straight-line meters from `p` to the nearest point of `bbox`.
fn bbox_meters(bbox: &[f64; 4], p: [f64; 2]) -> f64 {
    haversine(
        p,
        [p[0].clamp(bbox[0], bbox[2]), p[1].clamp(bbox[1], bbox[3])],
    )
}

impl Zone {
    pub fn contains(&self, p: [f64; 2]) -> bool {
        p[0] >= self.bbox[0]
            && p[0] <= self.bbox[2]
            && p[1] >= self.bbox[1]
            && p[1] <= self.bbox[3]
            && self.polygons.iter().any(|rings| {
                ring_contains(&rings[0], p) && !rings[1..].iter().any(|r| ring_contains(r, p))
            })
    }
}

/// Nearest point of the directed shape interval `[lo, hi]` (fractional
/// vertex positions), using a locally scaled equirectangular metric.
pub(super) fn project(shape: &[[f64; 2]], p: [f64; 2], lo: f64, hi: f64) -> (f64, [f64; 2]) {
    let scale = p[1].to_radians().cos();
    let first = lo.floor() as usize;
    let mut best = (f64::INFINITY, lo, shape[first.min(shape.len() - 1)]);
    let last = (hi.ceil() as usize).min(shape.len() - 1);
    for i in first..last {
        let (a, b) = (shape[i], shape[i + 1]);
        let dx = (b[0] - a[0]) * scale;
        let dy = b[1] - a[1];
        let length = dx * dx + dy * dy;
        let t = if length == 0. {
            0.
        } else {
            (((p[0] - a[0]) * scale * dx + (p[1] - a[1]) * dy) / length)
                .clamp((lo - i as f64).max(0.), (hi - i as f64).min(1.))
        };
        let point = [a[0] + t * (b[0] - a[0]), a[1] + t * dy];
        let d = ((p[0] - point[0]) * scale).powi(2) + (p[1] - point[1]).powi(2);
        if d < best.0 {
            best = (d, i as f64 + t, point);
        }
    }
    (best.1, best.2)
}

impl Shape {
    pub fn distance(&self, position: f64) -> f64 {
        let i = (position.floor() as usize).min(self.points.len() - 2);
        self.lengths[i] + (self.lengths[i + 1] - self.lengths[i]) * (position - i as f64)
    }
    pub fn point(&self, position: f64) -> [f64; 2] {
        let i = (position.floor() as usize).min(self.points.len() - 2);
        let t = position - i as f64;
        let (a, b) = (self.points[i], self.points[i + 1]);
        [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
    }
    pub fn geometry(&self, lo: f64, hi: f64) -> Vec<[f64; 2]> {
        let mut line = vec![self.point(lo)];
        for i in (lo.floor() as usize + 1)..=(hi.floor() as usize) {
            if (i as f64) < hi {
                line.push(self.points[i]);
            }
        }
        line.push(self.point(hi));
        line
    }
}

/// A query-local continuous stop projected between two published calls.
#[derive(Clone, Copy)]
pub(super) struct Projection {
    /// Index of the published call that starts the interval.
    pub interval: usize,
    pub position: f64,
    pub coordinate: [f64; 2],
    pub fraction: f64,
    /// 0 permitted, 2 phone the agency, 3 coordinate with the driver.
    pub kind: u8,
}

impl Pattern {
    /// Continuous stops for a free endpoint, within `reach` meters of it.
    pub fn project(&self, shape: &Shape, p: [f64; 2], pickup: bool, reach: f64) -> Vec<Projection> {
        let Ok(positions) = &self.positions else {
            return vec![];
        };
        if bbox_meters(&shape.bbox, p) > reach {
            return vec![];
        }
        let mut found = vec![];
        for i in 0..positions.len().saturating_sub(1) {
            let kind = self.continuous[i][usize::from(!pickup)];
            let (lo, hi) = (positions[i], positions[i + 1]);
            if kind == 1 || hi <= lo {
                continue;
            }
            let (position, coordinate) = project(&shape.points, p, lo, hi);
            if position <= lo || position >= hi || haversine(p, coordinate) > reach {
                continue;
            }
            let span = shape.distance(hi) - shape.distance(lo);
            if span <= 0. {
                continue;
            }
            found.push(Projection {
                interval: i,
                position,
                coordinate,
                fraction: (shape.distance(position) - shape.distance(lo)) / span,
                kind,
            });
        }
        found
    }
}

fn permission(value: &Value) -> u8 {
    value.as_u64().map_or(1, |v| v.min(3) as u8)
}

impl FlexIndex {
    pub fn place_stops(&self, place: Place) -> &[u32] {
        match place {
            Place::Zone(z) => &self.zones[z as usize].stops,
            Place::Group(g) => &self.groups[g as usize],
            Place::Stop(_) => &[],
        }
    }
}

impl City {
    pub(super) fn flex_index(&mut self) -> Result<Arc<FlexIndex>> {
        if let Some(index) = self.flex_index.get() {
            return Ok(index.clone());
        }
        let catalogs = self.flex_catalogs()?;
        let index = Arc::new(self.compile_flex_index(&catalogs)?);
        let _ = self.flex_index.set(index.clone());
        Ok(index)
    }

    fn compile_flex_index(&self, catalogs: &Value) -> Result<FlexIndex> {
        let mut index = FlexIndex::default();
        let catalogs = catalogs.as_array().map(Vec::as_slice).unwrap_or_default();
        if catalogs.is_empty() {
            return Ok(index);
        }
        let mut places: HashMap<&str, Place> = HashMap::new();
        let mut shapes: HashMap<&str, u32> = HashMap::new();
        let mut patterns: HashMap<String, u32> = HashMap::new();
        let mut call_stops = std::collections::BTreeSet::new();
        let strict = self.metadata["accessibility"]["profile"] == "wheelchair-strict-v1";
        let accessible: std::collections::HashSet<String> = if strict {
            let mut statement = self
                .db
                .prepare("SELECT stop_id FROM wheelchair_stops WHERE boarding=1")?;
            statement
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<_>>()?
        } else {
            Default::default()
        };
        let stop_index = |id: &str| -> Option<u32> {
            let &i = self.stop_index.get(id)?;
            (!strict || accessible.contains(id)).then_some(i as u32)
        };
        for catalog in catalogs {
            for (id, zone) in catalog["locations"].as_object().into_iter().flatten() {
                let geometry = &zone["geometry"];
                let polygons: Vec<&Value> = match geometry["type"].as_str() {
                    Some("Polygon") => vec![&geometry["coordinates"]],
                    Some("MultiPolygon") => geometry["coordinates"]
                        .as_array()
                        .map(|v| v.iter().collect())
                        .unwrap_or_default(),
                    _ => vec![],
                };
                let polygons: Vec<Vec<Vec<[f64; 2]>>> = polygons
                    .into_iter()
                    .filter_map(Value::as_array)
                    .map(|rings| {
                        rings
                            .iter()
                            .map(|ring| {
                                ring.as_array()
                                    .into_iter()
                                    .flatten()
                                    .map(|p| {
                                        [
                                            p[0].as_f64().unwrap_or(f64::NAN),
                                            p[1].as_f64().unwrap_or(f64::NAN),
                                        ]
                                    })
                                    .collect()
                            })
                            .collect::<Vec<Vec<_>>>()
                    })
                    .filter(|rings| !rings.is_empty())
                    .collect();
                let bbox = bbox_of(polygons.iter().flat_map(|p| p[0].iter()));
                let mut zone = Zone {
                    bbox,
                    polygons,
                    stops: vec![],
                };
                zone.stops = self
                    .stops
                    .iter()
                    .enumerate()
                    .filter(|(_, s)| s.location == 0 && zone.contains([s.lon, s.lat]))
                    .filter_map(|(_, s)| stop_index(&s.id))
                    .collect();
                places
                    .entry(id)
                    .or_insert(Place::Zone(index.zones.len() as u32));
                index.zones.push(zone);
            }
            for (id, group) in catalog["groups"].as_object().into_iter().flatten() {
                let stops: Vec<u32> = group["stops"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .filter_map(stop_index)
                    .collect();
                call_stops.extend(stops.iter().copied());
                places
                    .entry(id)
                    .or_insert(Place::Group(index.groups.len() as u32));
                index.groups.push(stops);
            }
            for (id, rule) in catalog["bookings"].as_object().into_iter().flatten() {
                index.bookings.entry(id.clone()).or_insert(rule.clone());
            }
            for (id, rows) in catalog["shapes"].as_object().into_iter().flatten() {
                let rows = rows.as_array().map(Vec::as_slice).unwrap_or_default();
                let points: Vec<[f64; 2]> = rows
                    .iter()
                    .map(|p| {
                        Ok([
                            p[0].as_f64().ok_or("Invalid shape longitude")?,
                            p[1].as_f64().ok_or("Invalid shape latitude")?,
                        ])
                    })
                    .collect::<Result<_>>()?;
                if points.len() < 2 {
                    continue;
                }
                let lengths = if rows.iter().all(|row| row[3].as_f64().is_some()) {
                    rows.iter().map(|row| row[3].as_f64().unwrap()).collect()
                } else {
                    let mut lengths = vec![0.];
                    for pair in points.windows(2) {
                        let scale = ((pair[0][1] + pair[1][1]) / 2.).to_radians().cos();
                        lengths.push(
                            lengths.last().unwrap()
                                + ((pair[1][0] - pair[0][0]) * scale)
                                    .hypot(pair[1][1] - pair[0][1]),
                        );
                    }
                    lengths
                };
                shapes.insert(id, index.shapes.len() as u32);
                index.shapes.push(Shape {
                    bbox: bbox_of(points.iter()),
                    points,
                    lengths,
                });
            }
            for trip in catalog["trips"]
                .as_object()
                .into_iter()
                .flatten()
                .map(|t| t.1)
            {
                let mut calls = vec![];
                let mut stop_coordinates = vec![];
                let mut continuous = vec![];
                let mut key = String::new();
                for call in trip["calls"].as_array().into_iter().flatten() {
                    let location = call["location"].as_str().unwrap_or_default();
                    let place = match places.get(location) {
                        Some(&place) => place,
                        None => match stop_index(location) {
                            Some(stop) => {
                                call_stops.insert(stop);
                                Place::Stop(stop)
                            }
                            // An inaccessible fixed call stays on the trip but
                            // cannot be used to board or alight.
                            None if strict && self.stop_index.contains_key(location) => {
                                Place::Stop(u32::MAX)
                            }
                            None => return Err("Unknown Flex location".into()),
                        },
                    };
                    let coordinate = self
                        .stop_index
                        .get(location)
                        .map(|&i| [self.stops[i].lon, self.stops[i].lat]);
                    stop_coordinates.push((coordinate, call["shapeDistance"].as_f64()));
                    continuous.push([
                        permission(&call["continuousPickup"]),
                        permission(&call["continuousDropoff"]),
                    ]);
                    key.push_str(location);
                    key.push('\u{1f}');
                    key.push_str(&format!(
                        "{:?}{:?}\u{1f}",
                        continuous.last().unwrap(),
                        call["shapeDistance"].as_f64()
                    ));
                    // A fixed call departs at `start` and arrives at `end`.
                    let start = call["start"].as_f64().unwrap_or(0.);
                    calls.push(Call {
                        place,
                        start,
                        end: call["end"].as_f64().unwrap_or(start),
                        window: call["window"] == true,
                        pickup: permission(&call["pickup"]),
                        dropoff: permission(&call["dropoff"]),
                        pickup_booking: call["pickupBooking"].as_str().map(str::to_owned),
                        dropoff_booking: call["dropoffBooking"].as_str().map(str::to_owned),
                    });
                    index.maximum_clock =
                        index.maximum_clock.max(call["end"].as_f64().unwrap_or(0.));
                }
                let pattern =
                    trip["shapeId"]
                        .as_str()
                        .and_then(|id| shapes.get(id))
                        .map(|&shape| {
                            key.push_str(&shape.to_string());
                            *patterns.entry(key).or_insert_with(|| {
                                let s = &index.shapes[shape as usize];
                                let mut previous = 0.;
                                let positions = stop_coordinates
                                    .iter()
                                    .map(|&(coordinate, distance)| {
                                        let position = if let Some(distance) = distance {
                                            s.lengths
                                                .windows(2)
                                                .enumerate()
                                                .find_map(|(i, p)| {
                                                    (p[1] > p[0]
                                                        && distance >= p[0]
                                                        && distance <= p[1])
                                                        .then(|| {
                                                            i as f64
                                                                + (distance - p[0]) / (p[1] - p[0])
                                                        })
                                                })
                                                .ok_or("Stop shape distance is outside its shape")?
                                        } else {
                                            let coordinate = coordinate
                                                .ok_or("Continuous stop has no location")?;
                                            project(
                                                &s.points,
                                                coordinate,
                                                previous,
                                                (s.points.len() - 1) as f64,
                                            )
                                            .0
                                        };
                                        if position < previous {
                                            return Err("Stop shape distances are not ordered");
                                        }
                                        previous = position;
                                        Ok(position)
                                    })
                                    .collect::<std::result::Result<Vec<f64>, &str>>()
                                    .map_err(str::to_owned);
                                index.patterns.push(Pattern {
                                    shape,
                                    positions,
                                    continuous: continuous.clone(),
                                });
                                (index.patterns.len() - 1) as u32
                            })
                        });
                let service_id = trip["service_id"].as_str().unwrap_or_default().to_owned();
                index
                    .by_service
                    .entry(service_id.clone())
                    .or_default()
                    .push(index.trips.len() as u32);
                index.trips.push(Trip {
                    planned: None,
                    trip_id: trip["trip_id"].as_str().unwrap_or_default().to_owned(),
                    route_id: trip["route_id"].as_str().unwrap_or_default().to_owned(),
                    service_id,
                    wheelchair: trip["wheelchair"] == 1,
                    on_demand: trip["onDemand"] == true,
                    factor: trip["factor"].as_f64(),
                    offset: trip["offset"].as_f64(),
                    pattern,
                    calls,
                    id_value: trip["trip_id"].clone(),
                });
            }
        }
        index.call_stops = call_stops.into_iter().collect();
        index.zone_trips = vec![vec![]; index.zones.len()];
        index.pattern_trips = vec![vec![]; index.patterns.len()];
        for (t, trip) in index.trips.iter().enumerate() {
            let t = t as u32;
            if let Some(p) = trip.pattern {
                index.pattern_trips[p as usize].push(t);
            }
            for call in &trip.calls {
                let stops: &[u32] = match call.place {
                    Place::Zone(z) => {
                        index.zone_trips[z as usize].push(t);
                        &[]
                    }
                    Place::Group(g) => &index.groups[g as usize],
                    Place::Stop(s) if s != u32::MAX => std::slice::from_ref(match &call.place {
                        Place::Stop(s) => s,
                        _ => unreachable!(),
                    }),
                    Place::Stop(_) => &[],
                };
                for &s in stops {
                    index.stop_trips.entry(s).or_default().push(t);
                }
            }
        }
        for list in index
            .zone_trips
            .iter_mut()
            .chain(index.pattern_trips.iter_mut())
            .chain(index.stop_trips.values_mut())
        {
            list.dedup();
        }
        let exists: bool = self.db.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='transfer_rules')",
            [],
            |r| r.get(0),
        )?;
        if exists {
            let mut statement = self.db.prepare(
                "SELECT from_stop_id FROM transfer_rules WHERE transfer_type<4 UNION SELECT to_stop_id FROM transfer_rules WHERE transfer_type<4",
            )?;
            let selectors: std::collections::HashSet<String> = statement
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<_>>()?;
            // A selector names a stop or any of its ancestors.
            for (i, stop) in self.stops.iter().enumerate() {
                let mut id = stop.id.as_str();
                for _ in 0..8 {
                    if selectors.contains(id) {
                        index.rule_stops.insert(i as u32);
                        break;
                    }
                    match self.stop(id) {
                        Ok(s) if !s.parent.is_empty() => id = &s.parent,
                        _ => break,
                    }
                }
            }
        }
        Ok(index)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn projection_stays_on_directed_interval() {
        let s = [[0., 0.], [1., 0.], [1., 1.]];
        assert_eq!(project(&s, [0.5, 0.1], 0., 1.).0, 0.5);
        assert_eq!(project(&s, [0.5, 0.1], 1., 2.).0, 1.1);
        assert_eq!(project(&s, [2., 0.], 0., 0.5).0, 0.5);
    }
    #[test]
    fn zones_respect_holes_and_boundaries() {
        let ring = |r: &[[f64; 2]]| r.to_vec();
        let zone = Zone {
            bbox: [0., 0., 4., 4.],
            polygons: vec![vec![
                ring(&[[0., 0.], [4., 0.], [4., 4.], [0., 4.], [0., 0.]]),
                ring(&[[1., 1.], [2., 1.], [2., 2.], [1., 2.], [1., 1.]]),
            ]],
            stops: vec![],
        };
        assert!(zone.contains([0., 2.]));
        assert!(zone.contains([3., 3.]));
        assert!(!zone.contains([1.5, 1.5]));
        assert!(!zone.contains([1., 1.]));
        assert!(!zone.contains([5., 1.]));
    }
}
