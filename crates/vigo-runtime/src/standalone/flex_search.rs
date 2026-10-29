//! Flex hops for one request, and the integrated Flex + timetable search.
//!
//! A hop is a conditional ride between two calls of one Flex trip. Hops whose
//! far end is a transit stop become time-dependent access and egress for the
//! native timetable scan: Flex reaches the network, rides fixed service, and
//! leaves it again in one search, in either direction and on both ends. Every
//! hop clock is FIFO, so the earliest arrival at a stop is the only arrival a
//! later hop from it needs. Static bounds are verified after the scan and,
//! when a window binds, replaced by exact clocks from one one-to-many scan.
use super::flex_index::{FlexIndex, Place, Projection};
use super::{
    City, Result, flag, number,
    query::{Candidates, Options, Point, haversine},
};
use crate::{
    TimetableArriveByManyQueryInput, TimetableArriveByQueryInput, TimetableManyQueryInput,
    TimetableMatrixJourney, TimetableMatrixQueryInput, TimetableQueryInput,
};
use chrono::NaiveDate;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;

/// Walkable board/alight pairs one direct Flex search evaluates before it stops.
pub(super) const FLEX_PAIR_LIMIT: usize = 4096;
/// Hops that end at transit stops; a broad zone is bounded the same way.
const FLEX_HUB_HOP_LIMIT: usize = 65_536;
/// Driving cells priced in one batch.
const FLEX_DRIVE_CELL_LIMIT: usize = 65_536;
/// Seconds a street walk may lengthen a straight-line bound before the
/// scheduled search's Flex winner is re-searched with exact clocks. Every
/// other journey's value was a lower bound, so the winner is then at most this
/// much later than the best conditional journey.
const FLEX_WALK_GAP: f64 = 60.;

#[derive(Clone, Copy, PartialEq)]
pub(super) enum Side {
    /// The request origin or destination, possibly after a walk.
    Free,
    /// A transit stop, where the rider changes to or from fixed service.
    Hub,
}

#[derive(Clone)]
pub(super) struct End {
    pub coordinate: [f64; 2],
    /// City stop index.
    pub stop: Option<u32>,
    pub planned_stop: Option<String>,
    /// Walking seconds between the free endpoint and this point.
    pub walk: f64,
    pub meters: f64,
    /// False while `walk` is the straight-line bound, before a street walk.
    pub priced: bool,
}

#[derive(Clone)]
pub(super) struct Stopping {
    /// Published call, or the call that starts a continuous interval.
    pub call: usize,
    pub projection: Option<Projection>,
    pub permission: u8,
    pub booking: Option<String>,
    pub position: Option<f64>,
}

#[derive(Clone)]
pub(super) struct Hop {
    pub trip: u32,
    pub day: usize,
    pub board: End,
    pub alight: End,
    pub a: Stopping,
    pub b: Stopping,
    /// The rider boards at `max(ready, lo)` when that is not after `hi`.
    pub lo: f64,
    pub hi: f64,
    pub duration: f64,
    pub factor: f64,
    pub offset: f64,
    /// Fixed calls a deviated route still serves on the way, first and last.
    pub anchors: Option<(usize, usize)>,
    pub sides: (Side, Side),
}

impl Hop {
    /// Boarding time for a rider ready at `ready`.
    pub fn depart(&self, ready: f64) -> Option<f64> {
        let departure = ready.max(self.lo);
        (departure <= self.hi).then_some(departure)
    }
    /// Latest boarding that still alights by `deadline`.
    pub fn latest(&self, deadline: f64) -> Option<f64> {
        let departure = self.hi.min(deadline - self.duration);
        (departure >= self.lo).then_some(departure)
    }
}

pub(super) struct Want {
    pub direct: bool,
    pub access: bool,
    pub egress: bool,
}

pub(super) struct Hops {
    pub index: Arc<FlexIndex>,
    pub list: Vec<Hop>,
    pub days: Vec<(NaiveDate, f64)>,
    pub truncated: bool,
    /// The scheduled search already found a Flex journey under optimistic
    /// values, so the pruning probe would pass.
    pub promising: bool,
}

type Key = (u64, u64);
fn key(p: [f64; 2]) -> Key {
    (p[0].to_bits(), p[1].to_bits())
}

/// A published call or a continuous stop, with the free end it serves.
struct Entry {
    call: usize,
    projection: Option<Projection>,
    time: Option<f64>,
    position: Option<f64>,
    carried: Option<(usize, End)>,
}

struct Shell {
    hop: Hop,
    a_window: (f64, f64),
    b_window: (f64, f64),
    /// Driving to price: board → alight, or board → first anchor and last
    /// anchor → alight on a deviated route.
    drive: Vec<([f64; 2], [f64; 2])>,
    anchor_clocks: (f64, f64),
}

/// Departure window for boarding and arrival window for alighting.
fn windows(index: &FlexIndex, trip: u32, e: &Entry, offset: f64, board: bool) -> (f64, f64) {
    if let Some(t) = e.time {
        return (t, t);
    }
    let call = &index.trips[trip as usize].calls[e.call];
    if call.window {
        (call.start + offset, call.end + offset)
    } else if board {
        (call.start + offset, call.start + offset)
    } else {
        (call.end + offset, call.end + offset)
    }
}

/// Earliest-ready boarding window of a ride `duration` long between windows.
fn bounds(a: (f64, f64), b: (f64, f64), duration: f64) -> (f64, f64) {
    (a.0.max(b.0 - duration), a.1.min(b.1 - duration))
}

impl City {
    fn flex_walks(
        &mut self,
        from: [f64; 2],
        points: &[[f64; 2]],
        reverse: bool,
        limit: f64,
        opt: &Options,
    ) -> Result<Vec<Option<(f64, f64)>>> {
        if points.is_empty() || opt.walk_m == 0. || limit <= 0. {
            return Ok(vec![None; points.len()]);
        }
        let speed = opt.walk_speed.unwrap_or(self.speed);
        let many: Vec<f64> = points.iter().flatten().copied().collect();
        let (origin_coordinates, destination_coordinates) = if reverse {
            (many, from.to_vec())
        } else {
            (from.to_vec(), many)
        };
        let r = self.street.route_street_matrix(crate::StreetMatrixInput {
            origin_coordinates,
            destination_coordinates,
            maximum_distance_m: limit,
            disable_cache: Some(opt.disable_cache),
        })?;
        Ok(r.distances_m
            .iter()
            .map(|&m| (m.is_finite() && m >= 0. && m <= limit).then(|| (m / speed * 3.6, m)))
            .collect())
    }

    /// Driving seconds for each segment, priced as Drive prices one trip.
    fn flex_drives(
        &mut self,
        opt: &Options,
        segments: &[([f64; 2], [f64; 2])],
        priced: &mut HashMap<(Key, Key), f64>,
    ) -> Result<bool> {
        let (mut sources, mut targets) = (vec![], vec![]);
        let (mut source_at, mut target_at) = (HashMap::new(), HashMap::new());
        for (a, b) in segments {
            if priced.contains_key(&(key(*a), key(*b))) {
                continue;
            }
            source_at.entry(key(*a)).or_insert_with(|| {
                sources.push(*a);
                sources.len() - 1
            });
            target_at.entry(key(*b)).or_insert_with(|| {
                targets.push(*b);
                targets.len() - 1
            });
        }
        if sources.is_empty() {
            return Ok(true);
        }
        if sources.len() * targets.len() > FLEX_DRIVE_CELL_LIMIT {
            return Ok(false);
        }
        self.load_drive()?;
        let walking_speed_kph = opt.walk_speed.unwrap_or(self.speed);
        // Flex rejects traffic snapshots: estimates use the free-flow metric.
        let r = self
            .drive
            .as_mut()
            .unwrap()
            .kernel
            .route_coordinate_matrix(crate::DriveCoordinateMatrixInput {
                origin_coordinates: sources.iter().flatten().copied().collect(),
                destination_coordinates: targets.iter().flatten().copied().collect(),
                maximum_walk_meters: opt.walk_m,
                walking_speed_kph,
                maximum_distance_meters: opt.street_m,
                traffic: None,
            })?;
        for (a, b) in segments {
            let (Some(&i), Some(&j)) = (source_at.get(&key(*a)), target_at.get(&key(*b))) else {
                continue;
            };
            let seconds = r.durations_s[i * targets.len() + j];
            priced.insert(
                (key(*a), key(*b)),
                if seconds.is_finite() {
                    seconds
                } else {
                    f64::NAN
                },
            );
        }
        Ok(true)
    }

    /// Every hop the request can use: free origin to free destination
    /// (`direct`), free origin to a transit stop (`access`), and a transit
    /// stop to the free destination (`egress`).
    pub(super) fn flex_hops(
        &mut self,
        q: &Value,
        opt: &Options,
        origin: &Point,
        destination: &Point,
        want: Want,
    ) -> Result<Hops> {
        if self.planned_flex.is_some() {
            return self.planned_hops(q, opt, origin, destination, want);
        }
        let index = self.flex_index()?;
        let mut hops = Hops {
            index: index.clone(),
            list: vec![],
            days: vec![],
            truncated: false,
            promising: false,
        };
        if index.trips.is_empty() {
            return Ok(hops);
        }
        let date = NaiveDate::parse_from_str(
            q["serviceDate"]
                .as_str()
                .ok_or("Flex requires serviceDate")?,
            "%Y-%m-%d",
        )?;
        let zone: chrono_tz::Tz = self.metadata["agencyTimezones"]
            .as_array()
            .and_then(|a| a.first())
            .and_then(Value::as_str)
            .unwrap_or("UTC")
            .parse()?;
        let epoch = super::calendar::service_epoch(zone, date)?;
        let scopes = self.selected_scopes(q)?;
        let first_day = ((opt.start - index.maximum_clock) / 86400.).floor() as i64 - 1;
        let last_day = (opt.end / 86400.).ceil() as i64 + 1;
        let mut active = vec![];
        for delta in first_day..=last_day {
            let day = date
                .checked_add_signed(chrono::Duration::days(delta))
                .ok_or("Flex service date overflow")?;
            let offset = (super::calendar::service_epoch(zone, day)? - epoch) as f64;
            hops.days.push((day, offset));
            active.push(self.services_on(day)?);
        }
        let mut walkq = q.clone();
        walkq["allowLongWalk"] = json!(false);
        let reach = if opt.walk_m > 0. {
            self.direct_walk_limit(&walkq, opt)?
        } else {
            0.
        };
        let strict = self.metadata["accessibility"]["profile"] == "wheelchair-strict-v1";
        let points = [origin, destination];
        // A roadside boarding exactly at a free endpoint is a zero-length
        // walk, which the strict profile still proves on its street graph.
        let mut roadside = [true, true];
        if strict {
            for (i, point) in points.into_iter().enumerate() {
                if point.stop.is_none() {
                    roadside[i] = self
                        .street
                        .route_path(crate::StreetPathInput {
                            origin_lon: point.coordinate[0],
                            origin_lat: point.coordinate[1],
                            destination_lon: point.coordinate[0],
                            destination_lat: point.coordinate[1],
                            maximum_distance_m: 1e-4,
                            maximum_points: 2,
                        })?
                        .found;
                }
            }
        }
        let free = [want.direct || want.access, want.direct || want.egress];
        // Flex stops and continuous stops near each free endpoint. Walks start
        // as straight-line bounds; street walks are priced only for hops a
        // request still needs after its bounds are checked.
        let speed = opt.walk_speed.unwrap_or(self.speed);
        let bound_walk = |from: [f64; 2], to: [f64; 2]| {
            let meters = haversine(from, to);
            End {
                coordinate: to,
                stop: None,
                planned_stop: None,
                walk: meters / speed * 3.6,
                meters,
                priced: false,
            }
        };
        let mut near: [HashMap<u32, End>; 2] = Default::default();
        let mut projected: HashMap<(u32, usize), Vec<(Projection, End)>> = HashMap::new();
        for (role, point) in points.into_iter().enumerate() {
            if !free[role] {
                continue;
            }
            let here = point.coordinate;
            for &s in &index.call_stops {
                let stop = &self.stops[s as usize];
                let coordinate = [stop.lon, stop.lat];
                if coordinate == here {
                    let end = End {
                        coordinate,
                        stop: Some(s),
                        planned_stop: None,
                        walk: 0.,
                        meters: 0.,
                        priced: true,
                    };
                    near[role].insert(s, end);
                } else if reach > 0. && haversine(here, coordinate) <= reach {
                    let mut end = bound_walk(here, coordinate);
                    end.stop = Some(s);
                    near[role].insert(s, end);
                }
            }
            for (p, pattern) in index.patterns.iter().enumerate() {
                let shape = &index.shapes[pattern.shape as usize];
                for c in pattern.project(shape, here, role == 0, reach) {
                    let end = if c.coordinate == here {
                        if !roadside[role] {
                            continue;
                        }
                        End {
                            coordinate: here,
                            stop: None,
                            planned_stop: None,
                            walk: 0.,
                            meters: 0.,
                            priced: true,
                        }
                    } else {
                        bound_walk(here, c.coordinate)
                    };
                    projected
                        .entry((p as u32, role))
                        .or_default()
                        .push((c, end));
                }
            }
        }
        let inside: [Vec<bool>; 2] = points.map(|point| {
            index
                .zones
                .iter()
                .map(|zone| zone.contains(point.coordinate))
                .collect()
        });
        // Only trips that can serve a free endpoint yield hops.
        let mut touched: Vec<u32> = vec![];
        for role in 0..2 {
            if !free[role] {
                continue;
            }
            for (z, inside) in inside[role].iter().enumerate() {
                if *inside {
                    touched.extend(&index.zone_trips[z]);
                }
            }
            for s in near[role].keys() {
                touched.extend(index.stop_trips.get(s).into_iter().flatten());
            }
            for &(p, r) in projected.keys() {
                if r == role {
                    touched.extend(&index.pattern_trips[p as usize]);
                }
            }
        }
        touched.sort_unstable();
        touched.dedup();
        let fallback_factor = number(&q["flex"], "durationFactor", 1.5, 1., 10.)?;
        let fallback_offset = number(&q["flex"], "durationOffsetSeconds", 300., 0., 7200.)?;
        let excluded_trips = q["excludedTripIds"].as_array();
        let excluded_routes = q["excludedRouteIds"].as_array();
        let mut shells: Vec<Shell> = vec![];
        let (mut direct_pairs, mut hub_hops) = (0usize, 0usize);
        // Transit-stop ends of each place, shared by every trip calling there.
        let mut hub_ends: HashMap<Place, Rc<Vec<End>>> = HashMap::new();
        for &t in &touched {
            for call in &index.trips[t as usize].calls {
                hub_ends.entry(call.place).or_insert_with(|| {
                    let members: Vec<u32> = match call.place {
                        Place::Stop(s) if s != u32::MAX => vec![s],
                        Place::Stop(_) => vec![],
                        place => index.place_stops(place).to_vec(),
                    };
                    Rc::new(
                        members
                            .into_iter()
                            .map(|s| {
                                let stop = &self.stops[s as usize];
                                End {
                                    coordinate: [stop.lon, stop.lat],
                                    stop: Some(s),
                                    planned_stop: None,
                                    walk: 0.,
                                    meters: 0.,
                                    priced: true,
                                }
                            })
                            .collect(),
                    )
                });
            }
        }
        let none: Rc<Vec<End>> = Rc::new(vec![]);
        for (day, services) in active.iter().enumerate() {
            let offset = hops.days[day].1;
            for &t in &touched {
                let trip = &index.trips[t as usize];
                let service = &trip.service_id;
                if !services.contains(service)
                    || scopes.as_ref().is_some_and(|scopes| {
                        service
                            .split_once('\u{1f}')
                            .is_none_or(|(scope, _)| !scopes.contains(scope))
                    })
                {
                    continue;
                }
                if (strict && !trip.wheelchair)
                    || excluded_trips.is_some_and(|ids| ids.contains(&trip.id_value))
                    || excluded_routes
                        .is_some_and(|ids| ids.iter().any(|id| id == trip.route_id.as_str()))
                {
                    continue;
                }
                let calls = &trip.calls;
                if calls
                    .iter()
                    .all(|c| c.end + offset < opt.start || c.start + offset > opt.end)
                {
                    continue;
                }
                let pattern = trip.pattern.map(|p| &index.patterns[p as usize]);
                if let Some(Err(e)) = pattern.map(|p| &p.positions) {
                    return Err(e.clone().into());
                }
                let positions = pattern.and_then(|p| p.positions.as_ref().ok());
                // Published calls and continuous stops, in travel order.
                let mut entries: Vec<Entry> = vec![];
                for (i, call) in calls.iter().enumerate() {
                    entries.push(Entry {
                        call: i,
                        projection: None,
                        time: None,
                        position: positions.map(|p| p[i]),
                        carried: None,
                    });
                    let (Some(p), Some(next)) = (trip.pattern, calls.get(i + 1)) else {
                        continue;
                    };
                    if next.end < call.start {
                        continue;
                    }
                    let mut extra = vec![];
                    for (role, &wanted) in free.iter().enumerate() {
                        if !wanted {
                            continue;
                        }
                        for (c, end) in projected.get(&(p, role)).into_iter().flatten() {
                            if c.interval == i {
                                extra.push((*c, role, end.clone()));
                            }
                        }
                    }
                    extra.sort_by(|a, b| a.0.position.total_cmp(&b.0.position));
                    for (c, role, end) in extra {
                        entries.push(Entry {
                            call: i,
                            projection: Some(c),
                            time: Some(call.start + (next.end - call.start) * c.fraction + offset),
                            position: Some(c.position),
                            carried: Some((role, end)),
                        });
                    }
                }
                let factor = trip.factor.unwrap_or(fallback_factor);
                let flex_offset = trip.offset.unwrap_or(fallback_offset);
                let ends = |e: &Entry, role: usize, side: Side| -> Rc<Vec<End>> {
                    if let Some((r, end)) = &e.carried {
                        return if side == Side::Free && *r == role {
                            Rc::new(vec![end.clone()])
                        } else {
                            none.clone()
                        };
                    }
                    let place = calls[e.call].place;
                    match (side, place) {
                        (Side::Hub, _) => hub_ends
                            .get(&place)
                            .cloned()
                            .unwrap_or_else(|| none.clone()),
                        (Side::Free, Place::Zone(z)) => {
                            if inside[role][z as usize] && roadside[role] {
                                Rc::new(vec![End {
                                    coordinate: points[role].coordinate,
                                    stop: None,
                                    planned_stop: None,
                                    walk: 0.,
                                    meters: 0.,
                                    priced: true,
                                }])
                            } else {
                                none.clone()
                            }
                        }
                        (Side::Free, Place::Stop(s)) => match near[role].get(&s) {
                            Some(end) => Rc::new(vec![end.clone()]),
                            None => none.clone(),
                        },
                        (Side::Free, _) => {
                            let found: Vec<End> = index
                                .place_stops(place)
                                .iter()
                                .filter_map(|s| near[role].get(s).cloned())
                                .collect();
                            if found.is_empty() {
                                none.clone()
                            } else {
                                Rc::new(found)
                            }
                        }
                    }
                };
                let resolve = |role: usize, side: Side| -> Vec<Rc<Vec<End>>> {
                    entries.iter().map(|e| ends(e, role, side)).collect()
                };
                let free_board = resolve(0, Side::Free);
                let free_alight = resolve(1, Side::Free);
                // Every hop has a free end; a trip that serves neither yields none.
                if free_board.iter().chain(&free_alight).all(|e| e.is_empty()) {
                    continue;
                }
                let hub_board = if want.egress {
                    resolve(0, Side::Hub)
                } else {
                    vec![none.clone(); entries.len()]
                };
                let hub_alight = if want.access {
                    resolve(1, Side::Hub)
                } else {
                    vec![none.clone(); entries.len()]
                };
                let anchor_point = |call: usize| match calls[call].place {
                    Place::Stop(s) if s != u32::MAX => {
                        Some([self.stops[s as usize].lon, self.stops[s as usize].lat])
                    }
                    _ => None,
                };
                for ai in 0..entries.len() {
                    if free_board[ai].is_empty() && hub_board[ai].is_empty() {
                        continue;
                    }
                    let a = &entries[ai];
                    let pickup = match a.projection {
                        Some(c) => c.kind,
                        None => calls[a.call].pickup,
                    };
                    if pickup == 1 {
                        continue;
                    }
                    let a_window = windows(&index, t, a, offset, true);
                    if a_window.1 < opt.start {
                        continue;
                    }
                    let a_booking = a
                        .projection
                        .is_none()
                        .then_some(calls[a.call].pickup_booking.as_ref())
                        .flatten();
                    let a_conditional =
                        a.projection.is_some() || pickup == 2 || a_booking.is_some();
                    // A deviated route still serves its fixed calls on time:
                    // the first and last fixed calls passed so far.
                    let mut anchors: Option<(usize, usize)> = None;
                    for bi in ai + 1..entries.len() {
                        if bi > ai + 1 {
                            let e = &entries[bi - 1];
                            if trip.on_demand && e.projection.is_none() && !calls[e.call].window {
                                anchors = Some((anchors.map_or(e.call, |a| a.0), e.call));
                            }
                        }
                        if free_alight[bi].is_empty() && hub_alight[bi].is_empty() {
                            continue;
                        }
                        let b = &entries[bi];
                        let dropoff = match b.projection {
                            Some(c) => c.kind,
                            None => calls[b.call].dropoff,
                        };
                        if dropoff == 1 {
                            continue;
                        }
                        let b_booking = b
                            .projection
                            .is_none()
                            .then_some(calls[b.call].dropoff_booking.as_ref())
                            .flatten();
                        // Ordinary fixed service is already in the timetable.
                        if !trip.on_demand
                            && !a_conditional
                            && b.projection.is_none()
                            && dropoff != 2
                            && b_booking.is_none()
                        {
                            continue;
                        }
                        let b_window = windows(&index, t, b, offset, false);
                        if b_window.0 > opt.end {
                            continue;
                        }
                        let drive_anchors = match anchors {
                            Some((first, last)) => {
                                match (anchor_point(first), anchor_point(last)) {
                                    (Some(f), Some(l)) => Some((f, l)),
                                    _ => continue,
                                }
                            }
                            None => None,
                        };
                        let published = if trip.on_demand {
                            None
                        } else {
                            let duration = b_window.1 - a_window.0;
                            if duration < 0. {
                                continue;
                            }
                            Some(duration)
                        };
                        let (lo, hi) =
                            published.map_or((0., 0.), |d| bounds(a_window, b_window, d));
                        if lo > hi {
                            continue;
                        }
                        for (sa, sb) in [
                            (Side::Free, Side::Free),
                            (Side::Free, Side::Hub),
                            (Side::Hub, Side::Free),
                        ] {
                            if sa == Side::Free && sb == Side::Free && !want.direct {
                                continue;
                            }
                            // A fixed-schedule vehicle already carries a rider who
                            // boarded upstream, so continuous egress starts at the
                            // call just before the drop-off point. Earlier calls
                            // would only add optimistic, loose values.
                            if sa == Side::Hub
                                && !trip.on_demand
                                && b.projection.is_some_and(|c| c.interval != a.call)
                            {
                                continue;
                            }
                            let boards = if sa == Side::Free {
                                &free_board[ai]
                            } else {
                                &hub_board[ai]
                            };
                            let alights = if sb == Side::Free {
                                &free_alight[bi]
                            } else {
                                &hub_alight[bi]
                            };
                            for board in boards.iter() {
                                for alight in alights.iter() {
                                    if board.coordinate == alight.coordinate {
                                        continue;
                                    }
                                    let counter = if sa == Side::Free && sb == Side::Free {
                                        direct_pairs += 1;
                                        direct_pairs > FLEX_PAIR_LIMIT
                                    } else {
                                        hub_hops += 1;
                                        hub_hops > FLEX_HUB_HOP_LIMIT
                                    };
                                    if counter {
                                        hops.truncated = true;
                                        continue;
                                    }
                                    if !board.walk.is_finite() || !alight.walk.is_finite() {
                                        continue;
                                    }
                                    let drive = match (published, drive_anchors) {
                                        (Some(_), _) => vec![],
                                        (None, None) => vec![(board.coordinate, alight.coordinate)],
                                        (None, Some((first, last))) => vec![
                                            (board.coordinate, first),
                                            (last, alight.coordinate),
                                        ],
                                    };
                                    shells.push(Shell {
                                        hop: Hop {
                                            trip: t,
                                            day,
                                            board: board.clone(),
                                            alight: alight.clone(),
                                            a: Stopping {
                                                call: a.call,
                                                projection: a.projection,
                                                permission: pickup,
                                                booking: a_booking.cloned(),
                                                position: a.position,
                                            },
                                            b: Stopping {
                                                call: b.call,
                                                projection: b.projection,
                                                permission: dropoff,
                                                booking: b_booking.cloned(),
                                                position: b.position,
                                            },
                                            lo,
                                            hi,
                                            duration: published.unwrap_or(0.),
                                            factor: if published.is_some() { 1. } else { factor },
                                            offset: if published.is_some() {
                                                0.
                                            } else {
                                                flex_offset
                                            },
                                            anchors,
                                            sides: (sa, sb),
                                        },
                                        a_window,
                                        b_window,
                                        drive,
                                        anchor_clocks: anchors.map_or((0., 0.), |(f, l)| {
                                            (calls[f].start + offset, calls[l].end + offset)
                                        }),
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }
        // Price every on-demand segment in three batches, each with one small
        // side: from the origin, to the destination, and between stops.
        let mut priced = HashMap::new();
        let mut batches: [Vec<([f64; 2], [f64; 2])>; 3] = Default::default();
        for shell in &shells {
            for (i, segment) in shell.drive.iter().enumerate() {
                let batch = if shell.hop.sides.0 == Side::Free && i == 0 {
                    0
                } else if shell.hop.sides.1 == Side::Free && i + 1 == shell.drive.len() {
                    1
                } else {
                    2
                };
                batches[batch].push(*segment);
            }
        }
        for batch in &batches {
            if !self.flex_drives(opt, batch, &mut priced)? {
                hops.truncated = true;
            }
        }
        for shell in shells {
            let mut hop = shell.hop;
            if !shell.drive.is_empty() {
                let mut seconds = vec![];
                for (a, b) in &shell.drive {
                    match priced.get(&(key(*a), key(*b))) {
                        Some(s) if s.is_finite() => seconds.push(*s),
                        _ => break,
                    }
                }
                if seconds.len() != shell.drive.len() {
                    continue;
                }
                if hop.anchors.is_none() {
                    hop.duration = (seconds[0] * hop.factor + hop.offset).ceil();
                    (hop.lo, hop.hi) = bounds(shell.a_window, shell.b_window, hop.duration);
                } else {
                    let (first, last) = shell.anchor_clocks;
                    let to_first = (seconds[0] * hop.factor).ceil();
                    let from_last = (seconds[1] * hop.factor + hop.offset).ceil();
                    let pickup = shell.a_window.1.min(first - to_first);
                    let arrival = (last + from_last).max(shell.b_window.0);
                    if pickup < shell.a_window.0 || arrival > shell.b_window.1 {
                        continue;
                    }
                    (hop.lo, hop.hi, hop.duration) = (pickup, pickup, arrival - pickup);
                }
                if hop.lo > hop.hi {
                    continue;
                }
            }
            hops.list.push(hop);
        }
        Ok(hops)
    }

    /// Street walks for the free ends of the selected hops, one matrix per
    /// endpoint. Ends no street walk reaches become unusable.
    pub(super) fn flex_price_walks(
        &mut self,
        q: &Value,
        opt: &Options,
        hops: &mut Hops,
        endpoints: [&Point; 2],
        selected: impl Fn(usize, &Hop) -> bool,
    ) -> Result<()> {
        let mut walkq = q.clone();
        walkq["allowLongWalk"] = json!(false);
        let reach = if opt.walk_m > 0. {
            self.direct_walk_limit(&walkq, opt)?
        } else {
            0.
        };
        for (role, endpoint) in endpoints.iter().enumerate() {
            let mut points: Vec<[f64; 2]> = vec![];
            let mut seen = std::collections::HashSet::new();
            for (_, hop) in hops
                .list
                .iter()
                .enumerate()
                .filter(|(i, h)| selected(*i, h))
            {
                let (side, end) = if role == 0 {
                    (hop.sides.0, &hop.board)
                } else {
                    (hop.sides.1, &hop.alight)
                };
                if side == Side::Free && !end.priced && seen.insert(key(end.coordinate)) {
                    points.push(end.coordinate);
                }
            }
            if points.is_empty() {
                continue;
            }
            let walks = self.flex_walks(endpoint.coordinate, &points, role == 1, reach, opt)?;
            let priced: HashMap<Key, (f64, f64)> = points
                .iter()
                .zip(walks)
                .map(|(p, w)| (key(*p), w.unwrap_or((f64::INFINITY, f64::INFINITY))))
                .collect();
            for hop in &mut hops.list {
                let (side, end) = if role == 0 {
                    (hop.sides.0, &mut hop.board)
                } else {
                    (hop.sides.1, &mut hop.alight)
                };
                if side == Side::Free
                    && !end.priced
                    && let Some(&(walk, meters)) = priced.get(&key(end.coordinate))
                {
                    (end.walk, end.meters, end.priced) = (walk, meters, true);
                }
            }
        }
        Ok(())
    }

    /// Public legs for one hop: the walk to it, the conditional ride and the
    /// walk from it, timed from `departure` (boarding) to `arrival`.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn flex_hop_legs(
        &mut self,
        q: &Value,
        opt: &Options,
        hops: &Hops,
        hop: &Hop,
        endpoints: [&Point; 2],
        departure: f64,
        arrival: f64,
    ) -> Result<Option<Vec<Value>>> {
        let index = hops.index.clone();
        let trip = &index.trips[hop.trip as usize];
        let point = |end: &End| Point {
            coordinate: end.coordinate,
            stop: end
                .planned_stop
                .clone()
                .or_else(|| end.stop.map(|s| self.stops[s as usize].id.clone())),
        };
        let (board, alight) = (point(&hop.board), point(&hop.alight));
        let mut walkq = q.clone();
        walkq["allowLongWalk"] = json!(false);
        let mut access = if hop.sides.0 == Side::Free {
            self.flex_walk(&walkq, endpoints[0], &board, opt)?
        } else {
            json!({"status":"ready","durationMinutes":0,"legs":[]})
        };
        let mut egress = if hop.sides.1 == Side::Free {
            self.flex_walk(&walkq, &alight, endpoints[1], opt)?
        } else {
            json!({"status":"ready","durationMinutes":0,"legs":[]})
        };
        if access["status"] != "ready" || egress["status"] != "ready" {
            return Ok(None);
        }
        let calls = &trip.calls;
        let (coordinates, distance, source) = if trip.planned.is_some() {
            (
                json!([board.coordinate, alight.coordinate]),
                json!(haversine(board.coordinate, alight.coordinate)),
                "scenario_estimate",
            )
        } else if trip.on_demand {
            let mut road = vec![];
            let mut meters = 0.;
            let mut stops: Vec<[f64; 2]> = vec![board.coordinate];
            if let Some((first, last)) = hop.anchors {
                for call in &calls[first..=last] {
                    if let Place::Stop(s) = call.place
                        && s != u32::MAX
                        && !call.window
                    {
                        stops.push([self.stops[s as usize].lon, self.stops[s as usize].lat]);
                    }
                }
            }
            stops.push(alight.coordinate);
            let mut roadq = q.clone();
            roadq["mode"] = json!("drive");
            for pair in stops.windows(2) {
                let from = Point {
                    coordinate: pair[0],
                    stop: None,
                };
                let to = Point {
                    coordinate: pair[1],
                    stop: None,
                };
                let r = self.street_route(&roadq, &from, &to, opt, "drive")?;
                if r["status"] != "ready" {
                    return Ok(None);
                }
                meters += r["distanceMeters"].as_f64().unwrap_or(0.);
                for leg in r["legs"].as_array().into_iter().flatten() {
                    road.extend(leg["coordinates"].as_array().cloned().unwrap_or_default());
                }
            }
            (Value::Array(road), json!(meters), "osm")
        } else {
            let pattern = trip.pattern.map(|p| &index.patterns[p as usize]);
            match (pattern, hop.a.position, hop.b.position) {
                (Some(p), Some(lo), Some(hi)) if hi > lo => {
                    let shape = &index.shapes[p.shape as usize];
                    (json!(shape.geometry(lo, hi)), Value::Null, "gtfs_shape")
                }
                _ => {
                    let line: Vec<[f64; 2]> = calls[hop.a.call..=hop.b.call]
                        .iter()
                        .filter_map(|c| match c.place {
                            Place::Stop(s) if s != u32::MAX => {
                                Some([self.stops[s as usize].lon, self.stops[s as usize].lat])
                            }
                            _ => None,
                        })
                        .collect();
                    (json!(line), Value::Null, "stop_sequence")
                }
            }
        };
        let confirmed = flag(&q["flex"], "bookingConfirmed", false)?;
        let mut requirements = vec![];
        for stopping in [&hop.a, &hop.b] {
            if stopping.permission == 2 || stopping.booking.is_some() {
                requirements.push(
                    stopping
                        .booking
                        .as_ref()
                        .and_then(|id| index.bookings.get(id))
                        .cloned()
                        .unwrap_or(json!({"message":"Contact the operator to arrange this trip"})),
                );
            }
        }
        let continuous = hop.a.projection.is_some() || hop.b.projection.is_some();
        let coordination = [&hop.a, &hop.b]
            .iter()
            .any(|s| s.projection.is_some_and(|c| c.kind == 3));
        let route: Value = if let Some(plan) = &trip.planned {
            json!({"shortName":plan["name"],"longName":plan["name"],"type":3})
        } else {
            match self.route_metadata.get(&trip.route_id) {
                Some(route) => route.clone(),
                None => {
                    let route = self.db.query_row("SELECT short_name,long_name,route_type,color FROM routes WHERE route_id=?", [&trip.route_id], |r| Ok(json!({"shortName":r.get::<_,Option<String>>(0)?,"longName":r.get::<_,Option<String>>(1)?,"type":r.get::<_,Option<i64>>(2)?,"color":r.get::<_,Option<String>>(3)?})))?;
                    self.route_metadata
                        .insert(trip.route_id.clone(), route.clone());
                    route
                }
            }
        };
        let access_s = access["durationMinutes"].as_f64().unwrap_or(0.) * 60.;
        let egress_s = egress["durationMinutes"].as_f64().unwrap_or(0.) * 60.;
        let retime = |result: &mut Value, start: f64| -> Vec<Value> {
            let mut clock = start;
            result["legs"]
                .as_array_mut()
                .map(|items| {
                    items
                        .iter_mut()
                        .map(|leg| {
                            let seconds = leg["durationMinutes"].as_f64().unwrap_or(0.) * 60.;
                            leg["departureMinutes"] = json!(clock / 60.);
                            clock += seconds;
                            leg["arrivalMinutes"] = json!(clock / 60.);
                            leg.clone()
                        })
                        .collect()
                })
                .unwrap_or_default()
        };
        let mut legs = vec![];
        if access_s > 0. {
            legs.extend(retime(&mut access, departure - access_s));
        }
        let assumption = if trip.planned.is_some() {
            "planned_zone_distance_and_wait"
        } else if continuous {
            "interpolated_shape"
        } else if !trip.on_demand {
            "published_timetable"
        } else if hop.anchors.is_some() {
            "deviated_route"
        } else if trip.factor.is_some() && trip.offset.is_some() {
            "gtfs_safe_duration"
        } else {
            "configured_driving_estimate"
        };
        let service_date = hops.days[hop.day].0.to_string();
        let name = |point: &Point| {
            point
                .stop
                .as_deref()
                .and_then(|id| self.stop(id).ok())
                .map(|s| s.name.as_str())
        };
        legs.push(json!({"kind":"ride","routeId":trip.route_id,"route":route,"tripId":trip.trip_id,"serviceId":trip.service_id,"serviceDate":service_date,
            "fromStopId":board.stop,"toStopId":alight.stop,"from":{"coordinate":board.coordinate,"name":name(&board)},"to":{"coordinate":alight.coordinate,"name":name(&alight)},
            "departureMinutes":departure/60.,"arrivalMinutes":arrival/60.,"durationMinutes":(arrival-departure)/60.,"distanceMeters":distance,"coordinates":coordinates,"geometrySource":source,
            "flexEstimate":{"durationFactor":hop.factor,"durationOffsetSeconds":hop.offset,"driverCoordination":coordination,"assumption":assumption,
            "bookingStatus":if confirmed {"caller_confirmed"} else if requirements.is_empty(){"not_required"} else {"required"},"bookingRequirements":requirements}}));
        if egress_s > 0. {
            legs.extend(retime(&mut egress, arrival));
        }
        Ok(Some(legs))
    }
}

/// Clock and secondary keys for ranking direct hops before building legs.
struct Ranked {
    hop: usize,
    departure: f64,
    arrival: f64,
    walking: f64,
}

impl City {
    /// Direct conditional journeys, best first, at most `limit`.
    pub(super) fn flex_direct(
        &mut self,
        q: &Value,
        opt: &Options,
        hops: &mut Hops,
        endpoints: [&Point; 2],
        limit: usize,
    ) -> Result<Vec<Value>> {
        let direct = |h: &Hop| h.sides == (Side::Free, Side::Free);
        if hops.list.iter().any(direct) {
            self.flex_price_walks(q, opt, hops, endpoints, |_, h| direct(h))?;
        }
        let hops = &*hops;
        let mut ranked = vec![];
        for (i, hop) in hops.list.iter().enumerate() {
            if hop.sides != (Side::Free, Side::Free) {
                continue;
            }
            let (walk_a, walk_b) = (hop.board.walk, hop.alight.walk);
            if !walk_a.is_finite() || !walk_b.is_finite() {
                continue;
            }
            let departure = if opt.arrive {
                hop.latest(opt.time - walk_b)
            } else {
                hop.depart(opt.time + walk_a)
            };
            let Some(departure) = departure else { continue };
            let arrival = departure + hop.duration;
            if departure - walk_a < opt.start || arrival + walk_b > opt.end {
                continue;
            }
            ranked.push(Ranked {
                hop: i,
                departure,
                arrival,
                walking: hop.board.meters + hop.alight.meters,
            });
        }
        ranked.sort_by(|a, b| {
            let time = if opt.arrive {
                (b.departure - hops.list[b.hop].board.walk)
                    .total_cmp(&(a.departure - hops.list[a.hop].board.walk))
            } else {
                (a.arrival + hops.list[a.hop].alight.walk)
                    .total_cmp(&(b.arrival + hops.list[b.hop].alight.walk))
            };
            time.then_with(|| a.walking.total_cmp(&b.walking))
        });
        let mut choices = vec![];
        let mut seen = std::collections::HashSet::new();
        for r in ranked {
            if choices.len() >= limit {
                break;
            }
            let hop = &hops.list[r.hop];
            if !seen.insert((
                hop.trip,
                hop.day,
                key(hop.board.coordinate),
                key(hop.alight.coordinate),
            )) {
                continue;
            }
            let Some(legs) =
                self.flex_hop_legs(q, opt, hops, hop, endpoints, r.departure, r.arrival)?
            else {
                continue;
            };
            let first = legs[0]["departureMinutes"]
                .as_f64()
                .unwrap_or(r.departure / 60.);
            let last = legs[legs.len() - 1]["arrivalMinutes"]
                .as_f64()
                .unwrap_or(r.arrival / 60.);
            if first * 60. < opt.start - 1e-6 || last * 60. > opt.end + 1e-6 {
                continue;
            }
            choices.push(json!({"status":"ready","mode":"transit","clockDate":q["serviceDate"],"departureMinutes":first,"arrivalMinutes":last,"durationMinutes":last-first,"transfers":0,"legs":legs,
                "warnings":[{"code":"flex_estimate","detail":"Conditional on operator availability and booking. Consult each leg for its timing assumption; no booking has been made."}]}));
        }
        Ok(choices)
    }
}

/// One side of the integrated search: per timetable stop, the best static
/// value and the hops that realize it.
#[derive(Default)]
pub(super) struct Seeds {
    pub seconds: HashMap<u32, f64>,
    hops: HashMap<u32, Vec<usize>>,
}

/// The scheduled search's winner when it used optimistic Flex values, with
/// the stops whose values came from Flex and the walking candidates.
pub(super) struct Witness {
    pub journey: TimetableMatrixJourney,
    pub flexible: [Vec<u32>; 2],
    pub walks: [Candidates; 2],
}

pub(super) enum Resolved {
    Journey(Value),
    /// No Flex journey is strictly better than the scheduled one.
    Worse,
    /// The optimistic values did not hold; search with exact clocks.
    Unresolved,
    /// Street walks replaced straight-line bounds on the winner's rides;
    /// search again with them.
    Repriced,
}

pub(super) enum Integrated {
    None,
    Journey(Value),
    /// A transfer rule at a Flex interchange contradicts the relaxed search.
    RuleBound,
}

impl City {
    /// Flex access, fixed service and Flex egress in one timetable search.
    /// `bound` is the best scheduled clock: arrival, or departure arrive-by.
    pub(super) fn flex_integrated(
        &mut self,
        q: &Value,
        opt: &Options,
        hops: &mut Hops,
        endpoints: [&Point; 2],
        bound: Option<f64>,
    ) -> Result<Integrated> {
        let any = |sides| hops.list.iter().any(|h| h.sides == sides);
        let (has_access, has_egress) = (any((Side::Free, Side::Hub)), any((Side::Hub, Side::Free)));
        if !has_access && !has_egress {
            return Ok(Integrated::None);
        }
        let combos: Vec<(bool, bool, Option<u32>)> = match opt.max_boardings {
            None if self.planned_flex.is_none() => vec![(has_access, has_egress, None)],
            cap => [(true, false, 1), (false, true, 1), (true, true, 2)]
                .into_iter()
                .filter(|&(a, e, used)| {
                    (!a || has_access) && (!e || has_egress) && cap.is_none_or(|cap| cap > used)
                })
                .map(|(a, e, used)| (a, e, cap.map(|cap| cap - used)))
                .collect(),
        };
        let mut best: Option<Value> = None;
        for (access, egress, cap) in combos {
            match self.flex_integrated_once(q, opt, hops, endpoints, bound, access, egress, cap)? {
                Integrated::RuleBound => return Ok(Integrated::RuleBound),
                Integrated::Journey(j) => {
                    if best
                        .as_ref()
                        .is_none_or(|b| super::flex::compare_journeys(opt.arrive, &j, b).is_lt())
                    {
                        best = Some(j);
                    }
                }
                Integrated::None => {}
            }
        }
        Ok(best.map_or(Integrated::None, Integrated::Journey))
    }

    #[allow(clippy::too_many_arguments)]
    fn flex_integrated_once(
        &mut self,
        q: &Value,
        opt: &Options,
        hops: &mut Hops,
        endpoints: [&Point; 2],
        bound: Option<f64>,
        use_access: bool,
        use_egress: bool,
        cap: Option<u32>,
    ) -> Result<Integrated> {
        self.activate(q)?;
        let (walk_a, walk_b) = self.point_candidates(endpoints[0], endpoints[1], opt)?;
        let buffer = number(q, "minimumTransferBufferMinutes", 0., 0., 60.)? * 60.;
        let index = hops.index.clone();
        // A rule may waive the buffer: such junctions are relaxed, then checked.
        let extra = move |end: &End| {
            if end.stop.is_some_and(|s| index.rule_stops.contains(&s)) {
                0.
            } else {
                buffer
            }
        };
        let (mut access, mut egress) = self.flex_seeds(opt, hops, use_access, use_egress, &extra);
        if access.seconds.is_empty() && egress.seconds.is_empty() {
            return Ok(Integrated::None);
        }
        // The Flex side whose clock depends on the scan (egress departing,
        // access arriving by) takes its clock from a one-to-many scan bounded
        // by the scheduled clock. Departing, that scan comes first; arriving
        // by, a pruning probe with optimistic access runs before it. A stop
        // the certified scan reaches later than assumed is repaired and the
        // scan repeated.
        // Optimistic values first: a probe with them rejects most requests
        // before any exact one-to-many scan.
        // A planned-zone interchange is a transit boarding, so it can be
        // reached by a valid transfer walk. Keep that side exclusively Flex:
        // enabling terminal transfers on ordinary coordinate egress would
        // incorrectly extend the requested walking budget.
        let hubs = Candidates {
            stops: vec![],
            seconds: vec![],
            terminal_transfers: true,
            evidence: None,
        };
        let planned = self.planned_flex.is_some();
        // Planned zones have fully priced, time-independent ride durations.
        // When their hours cover the whole query horizon, static hub costs
        // are exact; a second many-stop scan cannot tighten them.
        let static_clocks = planned
            && hops
                .list
                .iter()
                .filter(|h| {
                    (use_access && h.sides == (Side::Free, Side::Hub))
                        || (use_egress && h.sides == (Side::Hub, Side::Free))
                })
                .all(|h| h.lo <= opt.start && h.hi >= opt.end);
        let (mut exact, mut probe) = (static_clocks, !hops.promising);
        for _ in 0..8 {
            if access.seconds.is_empty() && egress.seconds.is_empty() {
                return Ok(Integrated::None);
            }
            let origins = merge(
                if planned && use_access {
                    &hubs
                } else {
                    &walk_a
                },
                &access.seconds,
            );
            let destinations = merge(
                if planned && use_egress {
                    &hubs
                } else {
                    &walk_b
                },
                &egress.seconds,
            );
            let mut input = super::City::matrix_input(
                std::slice::from_ref(&origins.0),
                std::slice::from_ref(&destinations.0),
                opt,
                true,
            );
            input.maximum_boardings = cap;
            // Only a strictly better journey can displace fixed service, and
            // it must then use Flex. The bound limits rides; the final walk
            // is compared by the probe.
            if let Some(bound) = bound {
                if opt.arrive {
                    input.departure = input.departure.max(bound);
                } else {
                    input.horizon = input.horizon.min(bound);
                }
                if input.horizon < input.departure {
                    return Ok(Integrated::None);
                }
            }
            if input.origin_stops.is_empty() || input.destination_stops.is_empty() {
                return Ok(Integrated::None);
            }
            if let (Some(bound), None, true) = (bound, cap, probe)
                && !self.flex_probe(opt, &input, &origins, &destinations, bound)?
            {
                return Ok(Integrated::None);
            }
            probe = true;
            // Bounds passed: replace straight-line walks with street walks.
            let interchange = |h: &Hop| h.sides != (Side::Free, Side::Free);
            if hops
                .list
                .iter()
                .any(|h| interchange(h) && (!h.board.priced || !h.alight.priced))
            {
                self.flex_price_walks(q, opt, hops, endpoints, |_, h| interchange(h))?;
                (access, egress) = self.flex_seeds(opt, hops, use_access, use_egress, &extra);
                // Walks only lengthen: the certified scan below decides.
                probe = false;
                continue;
            }
            if !exact {
                exact = true;
                let dynamic = if opt.arrive { &access } else { &egress };
                if !dynamic.seconds.is_empty() {
                    let values = if opt.arrive {
                        let earliest = bound.map_or(opt.start, |b| b.max(opt.start));
                        self.flex_exact_access(
                            opt,
                            hops,
                            &access,
                            &destinations.0,
                            cap,
                            &extra,
                            earliest,
                        )?
                    } else {
                        let horizon = bound.map_or(opt.end, |b| b.min(opt.end));
                        self.flex_exact_egress(
                            opt, hops, &egress, &origins.0, cap, &extra, horizon,
                        )?
                    };
                    if opt.arrive {
                        access.seconds = values;
                    } else {
                        egress.seconds = values;
                    }
                    // The certified scan follows directly; it verifies.
                    probe = false;
                    continue;
                }
            }
            let kernel = &mut self.timetable.as_mut().unwrap().kernel;
            let result = match super::point::route(kernel, &input)? {
                Some(result) => result,
                None => kernel.route_matrix_csa(clone_input(&input))?,
            };
            let Some(journey) = result.journeys.and_then(|mut rows| rows.pop().flatten()) else {
                return Ok(Integrated::None);
            };
            let first = journey.legs.first().filter(|l| l.from_stop.is_none());
            let last = journey.legs.last().filter(|l| l.to_stop.is_none());
            let flex_in = first
                .and_then(|l| l.to_stop)
                .filter(|s| origins.1.binary_search(s).is_ok());
            let flex_out = last
                .and_then(|l| l.from_stop)
                .filter(|s| destinations.1.binary_search(s).is_ok());
            if flex_in.is_none() && flex_out.is_none() {
                return Ok(Integrated::None);
            }
            if !journey.legs.iter().any(|l| l.trip.is_some()) {
                return Ok(Integrated::None);
            }
            // Resolve each Flex side from the scan's own clocks: the rider's
            // clock at an interchange is the adjacent leg's.
            let legs = &journey.legs;
            let access_choice = match flex_in {
                None => None,
                Some(stop) => {
                    let at = legs.get(1).map_or(first.unwrap().arrival, |l| l.departure);
                    let choice = self.flex_pick_access(opt, hops, &access, stop, at, &extra);
                    if choice.is_none_or(|c| {
                        opt.arrive && c.1 - hops.list[c.0].board.walk < journey.departure - 1e-6
                    }) {
                        return Ok(Integrated::None);
                    }
                    choice
                }
            };
            let egress_choice = match flex_out {
                None => None,
                Some(stop) => {
                    let at = legs
                        .len()
                        .checked_sub(2)
                        .map_or(last.unwrap().departure, |i| legs[i].arrival);
                    let choice = self.flex_pick_egress(opt, hops, &egress, stop, at, &extra);
                    let arrival = choice.map(|c| c.2 + hops.list[c.0].alight.walk);
                    if !opt.arrive && arrival.is_none_or(|a| a > journey.arrival + 1e-6) {
                        // The certified scan reached this stop later than the
                        // probe assumed: repair its value and scan again.
                        match arrival {
                            Some(a) => egress.seconds.insert(stop, a - at),
                            None => egress.seconds.remove(&stop),
                        };
                        continue;
                    }
                    if choice.is_none() {
                        return Ok(Integrated::None);
                    }
                    choice
                }
            };
            return self.flex_splice(
                q,
                opt,
                hops,
                endpoints,
                &journey,
                [&walk_a, &walk_b],
                access_choice,
                egress_choice,
            );
        }
        Ok(Integrated::None)
    }

    /// Confirm the scheduled search's Flex winner with street walks and exact
    /// clocks. Other Flex values were lower bounds, so a winner whose clocks
    /// hold within `FLEX_WALK_GAP` is within that gap of the best Flex
    /// journey; it is kept only when strictly better than `bound`, the
    /// scheduled arrival (departure arriving by).
    pub(super) fn flex_resolve(
        &mut self,
        q: &Value,
        opt: &Options,
        hops: &mut Hops,
        endpoints: [&Point; 2],
        witness: Witness,
        bound: Option<f64>,
    ) -> Result<Resolved> {
        let buffer = number(q, "minimumTransferBufferMinutes", 0., 0., 60.)? * 60.;
        let index = hops.index.clone();
        let extra = move |end: &End| {
            if end.stop.is_some_and(|s| index.rule_stops.contains(&s)) {
                0.
            } else {
                buffer
            }
        };
        let journey = &witness.journey;
        let legs = &journey.legs;
        if !legs.iter().any(|l| l.trip.is_some()) {
            return Ok(Resolved::Unresolved);
        }
        let member = |set: &[u32], stop: Option<u32>| stop.filter(|s| set.binary_search(s).is_ok());
        let first = legs.first().filter(|l| l.from_stop.is_none());
        let last = legs.last().filter(|l| l.to_stop.is_none());
        let flex_in = member(&witness.flexible[0], first.and_then(|l| l.to_stop));
        let flex_out = member(&witness.flexible[1], last.and_then(|l| l.from_stop));
        let (access, egress) = self.flex_seeds(opt, hops, true, true, &extra);
        let used: std::collections::HashSet<usize> = [
            flex_in.and_then(|s| access.hops.get(&s)),
            flex_out.and_then(|s| egress.hops.get(&s)),
        ]
        .into_iter()
        .flatten()
        .flatten()
        .copied()
        .collect();
        let unpriced = used
            .iter()
            .any(|&i| !hops.list[i].board.priced || !hops.list[i].alight.priced);
        self.flex_price_walks(q, opt, hops, endpoints, |i, _| used.contains(&i))?;
        let unresolved = if unpriced {
            Resolved::Repriced
        } else {
            Resolved::Unresolved
        };
        let access_choice = match flex_in {
            None => None,
            Some(stop) => {
                let at = legs.get(1).map_or(first.unwrap().arrival, |l| l.departure);
                let choice = self.flex_pick_access(opt, hops, &access, stop, at, &extra);
                if choice.is_none_or(|c| {
                    opt.arrive
                        && c.1 - hops.list[c.0].board.walk < journey.departure - FLEX_WALK_GAP
                }) {
                    return Ok(unresolved);
                }
                choice
            }
        };
        let egress_choice = match flex_out {
            None => None,
            Some(stop) => {
                let at = legs
                    .len()
                    .checked_sub(2)
                    .map_or(last.unwrap().departure, |i| legs[i].arrival);
                let choice = self.flex_pick_egress(opt, hops, &egress, stop, at, &extra);
                if choice.is_none_or(|c| {
                    !opt.arrive
                        && c.2 + hops.list[c.0].alight.walk > journey.arrival + FLEX_WALK_GAP
                }) {
                    return Ok(unresolved);
                }
                choice
            }
        };
        let walks = [&witness.walks[0], &witness.walks[1]];
        let value = match self.flex_splice(
            q,
            opt,
            hops,
            endpoints,
            journey,
            walks,
            access_choice,
            egress_choice,
        )? {
            Integrated::Journey(value) => value,
            Integrated::RuleBound | Integrated::None => return Ok(Resolved::Unresolved),
        };
        let better = bound.is_none_or(|b| {
            if opt.arrive {
                value["departureMinutes"]
                    .as_f64()
                    .is_some_and(|d| d * 60. > b + 1e-6)
            } else {
                value["arrivalMinutes"]
                    .as_f64()
                    .is_some_and(|a| a * 60. < b - 1e-6)
            }
        });
        Ok(if better {
            Resolved::Journey(value)
        } else {
            Resolved::Worse
        })
    }

    /// Static values per timetable stop: exact for the side whose clock the
    /// request fixes, optimistic for the side whose clock the scan fixes.
    pub(super) fn flex_seeds(
        &self,
        opt: &Options,
        hops: &Hops,
        use_access: bool,
        use_egress: bool,
        extra: &dyn Fn(&End) -> f64,
    ) -> (Seeds, Seeds) {
        let t = self.timetable.as_ref().unwrap();
        let stop_of = |end: &End| {
            end.planned_stop
                .as_ref()
                .and_then(|id| t.index.get(id).copied())
                .or_else(|| {
                    end.stop
                        .and_then(|s| t.index.get(&self.stops[s as usize].id).copied())
                })
        };
        let mut access = Seeds::default();
        let mut egress = Seeds::default();
        for (i, hop) in hops.list.iter().enumerate() {
            if !hop.board.walk.is_finite() || !hop.alight.walk.is_finite() {
                continue;
            }
            match hop.sides {
                (Side::Free, Side::Hub) if use_access => {
                    let Some(stop) = stop_of(&hop.alight) else {
                        continue;
                    };
                    let value = if opt.arrive {
                        // Optimistic: the rider never waits for the vehicle.
                        hop.board.walk + hop.duration + extra(&hop.alight)
                    } else {
                        let Some(departure) = hop.depart(opt.time + hop.board.walk) else {
                            continue;
                        };
                        departure + hop.duration + extra(&hop.alight) - opt.start
                    };
                    let slot = access.seconds.entry(stop).or_insert(f64::INFINITY);
                    *slot = slot.min(value);
                    access.hops.entry(stop).or_default().push(i);
                }
                (Side::Hub, Side::Free) if use_egress => {
                    let Some(stop) = stop_of(&hop.board) else {
                        continue;
                    };
                    let value = if opt.arrive {
                        let Some(departure) = hop.latest(opt.time - hop.alight.walk) else {
                            continue;
                        };
                        opt.end - (departure - extra(&hop.board))
                    } else {
                        // Optimistic: the vehicle is ready on arrival.
                        extra(&hop.board) + hop.duration + hop.alight.walk
                    };
                    let slot = egress.seconds.entry(stop).or_insert(f64::INFINITY);
                    *slot = slot.min(value);
                    egress.hops.entry(stop).or_default().push(i);
                }
                _ => {}
            }
        }
        access.seconds.retain(|_, s| s.is_finite() && *s >= 0.);
        egress.seconds.retain(|_, s| s.is_finite() && *s >= 0.);
        (access, egress)
    }

    /// Whether a journey strictly better than `bound` may exist. Uses the
    /// relaxed scan when the timetable allows it: a lower bound suffices.
    fn flex_probe(
        &mut self,
        opt: &Options,
        input: &TimetableMatrixQueryInput,
        origins: &(Candidates, Vec<u32>),
        destinations: &(Candidates, Vec<u32>),
        bound: f64,
    ) -> Result<bool> {
        let only = |c: &(Candidates, Vec<u32>)| -> (Vec<u32>, Vec<f64>) {
            c.0.stops
                .iter()
                .zip(&c.0.seconds)
                .filter(|(s, _)| c.1.binary_search(s).is_ok())
                .map(|(s, v)| (*s, *v))
                .unzip()
        };
        // With Flex on one side only, the probe starts or ends at Flex alone.
        let (mut origin_stops, mut origin_seconds) = (
            input.origin_stops.clone(),
            input.origin_walk_seconds.clone(),
        );
        let (mut destination_stops, mut destination_seconds) = (
            input.destination_stops.clone(),
            input.destination_walk_seconds.clone(),
        );
        if destinations.1.is_empty() {
            (origin_stops, origin_seconds) = only(origins);
        } else if origins.1.is_empty() {
            (destination_stops, destination_seconds) = only(destinations);
        }
        if origin_stops.is_empty() || destination_stops.is_empty() {
            return Ok(false);
        }
        // Departing, a better journey reaches its last stop before `bound`
        // less the least egress, and boards no earlier than the least access.
        let least = |v: &[f64]| v.iter().copied().fold(f64::INFINITY, f64::min);
        let (first, last) = (least(&origin_seconds), least(&destination_seconds));
        let candidates = |n: usize| (0..n as u32).collect::<Vec<_>>();
        let pre = input.allow_pre_ride_transfers[0];
        let post = input.allow_post_ride_transfers.as_ref().map(|f| f[0]);
        let kernel = &mut self.timetable.as_mut().unwrap().kernel;
        if opt.arrive {
            let probe = kernel.route_arrive_by_csa(TimetableArriveByQueryInput {
                origin_candidate_indices: candidates(origin_stops.len()),
                destination_candidate_indices: candidates(destination_stops.len()),
                origin_stops,
                origin_walk_seconds: origin_seconds,
                destination_stops,
                destination_walk_seconds: destination_seconds,
                earliest: input.departure.max(bound).min(input.horizon),
                deadline: input.horizon,
                allow_pre_ride_transfers: pre,
                allow_post_ride_transfers: post,
                maximum_boardings: None,
            })?;
            return Ok(!probe.supported || probe.latest_departure.is_some_and(|d| d > bound + 1e-6));
        }
        let horizon = input.horizon.min(bound - last).max(input.departure);
        let mut departure = input.departure;
        if destinations.1.is_empty() && first.is_finite() {
            departure = (departure + first).min(horizon);
            origin_seconds.iter_mut().for_each(|v| *v -= first);
        }
        let query = TimetableQueryInput {
            origin_candidate_indices: candidates(origin_stops.len()),
            destination_candidate_indices: candidates(destination_stops.len()),
            origin_stops,
            origin_walk_seconds: origin_seconds,
            destination_stops,
            destination_walk_seconds: destination_seconds,
            departure,
            horizon,
            allow_pre_ride_transfers: pre,
            allow_post_ride_transfers: post,
            maximum_boardings: None,
        };
        let probe = match kernel.route_scalar_relaxed_csa(&query)? {
            Some(probe) => probe,
            None => kernel.route_scalar_csa(query)?,
        };
        Ok(!probe.supported || probe.best_arrival.is_some_and(|a| a < bound - 1e-6))
    }

    /// Hop, boarding and alighting clocks for Flex access that reaches
    /// timetable stop `stop` by `at` (arrive-by) or from the request time.
    fn flex_pick_access(
        &self,
        opt: &Options,
        hops: &Hops,
        seeds: &Seeds,
        stop: u32,
        at: f64,
        extra: &dyn Fn(&End) -> f64,
    ) -> Option<(usize, f64, f64)> {
        let mut best: Option<(usize, f64, f64)> = None;
        for &i in seeds.hops.get(&stop)? {
            let hop = &hops.list[i];
            let departure = if opt.arrive {
                hop.latest(at - extra(&hop.alight))
            } else {
                hop.depart(opt.time + hop.board.walk)
            };
            let Some(departure) = departure else { continue };
            let choice = (i, departure, departure + hop.duration);
            if departure_first(opt, hops, &choice, best.as_ref()) {
                best = Some(choice);
            }
        }
        best.filter(|c| opt.arrive || c.2 + extra(&hops.list[c.0].alight) <= at + 1e-6)
    }

    fn flex_pick_egress(
        &self,
        opt: &Options,
        hops: &Hops,
        seeds: &Seeds,
        stop: u32,
        at: f64,
        extra: &dyn Fn(&End) -> f64,
    ) -> Option<(usize, f64, f64)> {
        let mut best: Option<(usize, f64, f64)> = None;
        for &i in seeds.hops.get(&stop)? {
            let hop = &hops.list[i];
            let departure = if opt.arrive {
                hop.latest(opt.time - hop.alight.walk)
            } else {
                hop.depart(at + extra(&hop.board))
            };
            let Some(departure) = departure else { continue };
            let choice = (i, departure, departure + hop.duration);
            if opt.arrive && departure - extra(&hop.board) < at - 1e-6 {
                continue;
            }
            let better = best.as_ref().is_none_or(|b| {
                let (x, y) = (choice.2 + hop.alight.walk, b.2 + hops.list[b.0].alight.walk);
                if opt.arrive { choice.1 > b.1 } else { x < y }
            });
            if better {
                best = Some(choice);
            }
        }
        best
    }

    /// Egress values from the earliest arrival at every Flex stop. The scan
    /// ignores transfer rules where that bounds it: values are then exact
    /// unless a rule delays the stop, and never claim an unreachable clock.
    #[allow(clippy::too_many_arguments)]
    fn flex_exact_egress(
        &mut self,
        opt: &Options,
        hops: &Hops,
        seeds: &Seeds,
        origins: &Candidates,
        cap: Option<u32>,
        extra: &dyn Fn(&End) -> f64,
        horizon: f64,
    ) -> Result<HashMap<u32, f64>> {
        let stops: Vec<u32> = seeds.seconds.keys().copied().collect();
        let input = TimetableManyQueryInput {
            origin_stops: origins.stops.clone(),
            origin_walk_seconds: origins.seconds.clone(),
            destination_offsets: (0..=stops.len() as u32).collect(),
            destination_stops: stops.clone(),
            destination_walk_seconds: vec![0.; stops.len()],
            excluded_trips: vec![],
            departure: opt.start,
            horizon,
            allow_pre_ride_transfers: origins.terminal_transfers,
            allow_post_ride_transfers: Some(vec![self.planned_flex.is_some(); stops.len()]),
            maximum_boardings: cap,
        };
        let kernel = &mut self.timetable.as_mut().unwrap().kernel;
        let r = match kernel.route_many_relaxed_csa(&input)? {
            Some(r) => r,
            None => kernel.route_many_csa(input)?,
        };
        let mut exact = HashMap::new();
        for (stop, &arrival) in stops.iter().zip(&r.best_arrivals) {
            if !arrival.is_finite() {
                continue;
            }
            if let Some((i, _, alight)) =
                self.flex_pick_egress(opt, hops, seeds, *stop, arrival, extra)
            {
                exact.insert(*stop, alight + hops.list[i].alight.walk - arrival);
            }
        }
        Ok(exact)
    }

    /// Exact access values from the latest departure at every Flex stop.
    #[allow(clippy::too_many_arguments)]
    fn flex_exact_access(
        &mut self,
        opt: &Options,
        hops: &Hops,
        seeds: &Seeds,
        destinations: &Candidates,
        cap: Option<u32>,
        extra: &dyn Fn(&End) -> f64,
        earliest: f64,
    ) -> Result<HashMap<u32, f64>> {
        let stops: Vec<u32> = seeds.seconds.keys().copied().collect();
        let planned = self.planned_flex.is_some();
        let kernel = &mut self.timetable.as_mut().unwrap().kernel;
        let r = kernel.route_arrive_by_many_csa(TimetableArriveByManyQueryInput {
            origin_offsets: (0..=stops.len() as u32).collect(),
            origin_stops: stops.clone(),
            origin_walk_seconds: vec![0.; stops.len()],
            allow_pre_ride_transfers: vec![planned; stops.len()],
            destination_stops: destinations.stops.clone(),
            destination_walk_seconds: destinations.seconds.clone(),
            earliest,
            deadline: opt.end,
            excluded_trips: vec![],
            allow_post_ride_transfers: Some(destinations.terminal_transfers),
            maximum_boardings: cap,
        })?;
        let mut exact = HashMap::new();
        for (stop, &latest) in stops.iter().zip(&r.latest_departures) {
            if !latest.is_finite() {
                continue;
            }
            if let Some((i, departure, _)) =
                self.flex_pick_access(opt, hops, seeds, *stop, latest, extra)
            {
                exact.insert(*stop, latest - (departure - hops.list[i].board.walk));
            }
        }
        Ok(exact)
    }

    #[allow(clippy::too_many_arguments)]
    fn flex_splice(
        &mut self,
        q: &Value,
        opt: &Options,
        hops: &Hops,
        endpoints: [&Point; 2],
        journey: &TimetableMatrixJourney,
        walks: [&Candidates; 2],
        access: Option<(usize, f64, f64)>,
        egress: Option<(usize, f64, f64)>,
    ) -> Result<Integrated> {
        let mut middle = journey.clone();
        if access.is_some() {
            middle.legs.remove(0);
        }
        if egress.is_some() {
            middle.legs.pop();
        }
        let (Some(first), Some(last)) = (middle.legs.first(), middle.legs.last()) else {
            return Ok(Integrated::None);
        };
        middle.departure = first.departure;
        middle.arrival = last.arrival;
        middle.walking_seconds = middle
            .legs
            .iter()
            .filter(|l| l.trip.is_none())
            .map(|l| l.arrival - l.departure)
            .sum();
        let value = self.materialize(&middle, endpoints, true, opt, walks, None)?;
        let mut legs: Vec<Value> = value["legs"].as_array().cloned().unwrap_or_default();
        let mut flex_legs = 0;
        if let Some((i, departure, arrival)) = access {
            let Some(before) =
                self.flex_hop_legs(q, opt, hops, &hops.list[i], endpoints, departure, arrival)?
            else {
                return Ok(Integrated::None);
            };
            legs.splice(0..0, before);
            flex_legs += 1;
        }
        if let Some((i, departure, arrival)) = egress {
            let Some(after) =
                self.flex_hop_legs(q, opt, hops, &hops.list[i], endpoints, departure, arrival)?
            else {
                return Ok(Integrated::None);
            };
            legs.extend(after);
            flex_legs += 1;
        }
        // A conditional ride that continues the same vehicle as the adjacent
        // fixed ride is one boarding: merge the two legs.
        let mut merged = 0;
        for i in (1..legs.len()).rev() {
            let (before, after) = (&legs[i - 1], &legs[i]);
            if before["kind"] == "ride"
                && after["kind"] == "ride"
                && before["tripId"] == after["tripId"]
                && (before["flexEstimate"].is_object() != after["flexEstimate"].is_object())
            {
                let (fixed, flexible) = if before["flexEstimate"].is_object() {
                    (i, i - 1)
                } else {
                    (i - 1, i)
                };
                let fixed_leg = legs[fixed].clone();
                let leg = &mut legs[flexible];
                let mut line: Vec<Value> =
                    leg["coordinates"].as_array().cloned().unwrap_or_default();
                let more = fixed_leg["coordinates"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default();
                if fixed < flexible {
                    for key in ["from", "fromStopId", "departureMinutes"] {
                        leg[key] = fixed_leg[key].clone();
                    }
                    line.splice(0..0, more);
                } else {
                    for key in ["to", "toStopId", "arrivalMinutes"] {
                        leg[key] = fixed_leg[key].clone();
                    }
                    line.extend(more);
                }
                leg["coordinates"] = Value::Array(line);
                leg["distanceMeters"] = Value::Null;
                let span = leg["arrivalMinutes"].as_f64().unwrap_or(0.)
                    - leg["departureMinutes"].as_f64().unwrap_or(0.);
                leg["durationMinutes"] = json!(span);
                legs.remove(fixed);
                merged += 1;
            }
        }
        // Each interchange obeys the same transfer rules as fixed service.
        let rides: Vec<usize> = (0..legs.len())
            .filter(|&i| legs[i]["kind"] == "ride")
            .collect();
        for pair in rides.windows(2) {
            let (a, b) = (&legs[pair[0]], &legs[pair[1]]);
            let flex = a["flexEstimate"].is_object() || b["flexEstimate"].is_object();
            if !flex {
                continue;
            }
            let junction = [&a["toStopId"], &b["fromStopId"]];
            let ruled = junction.iter().any(|id| {
                id.as_str()
                    .and_then(|id| self.stop_index.get(id))
                    .is_some_and(|&s| hops.index.rule_stops.contains(&(s as u32)))
            });
            if !ruled {
                continue;
            }
            let minimum = self.flex_transfer_minimum(a, b)?;
            let buffer = number(q, "minimumTransferBufferMinutes", 0., 0., 60.)?;
            let gap = b["departureMinutes"].as_f64().unwrap_or(0.)
                - a["arrivalMinutes"].as_f64().unwrap_or(0.);
            match minimum.map(|m| if m < 0. { 0. } else { m.max(buffer) }) {
                Some(m) if gap + 1e-9 >= m => {}
                _ => return Ok(Integrated::RuleBound),
            }
        }
        let departure = legs[0]["departureMinutes"].as_f64().unwrap_or(0.);
        let arrival = legs[legs.len() - 1]["arrivalMinutes"]
            .as_f64()
            .unwrap_or(0.);
        if departure * 60. < opt.start - 1e-6 || arrival * 60. > opt.end + 1e-6 {
            return Ok(Integrated::None);
        }
        // The fixed-service clocks above describe only the middle; the whole
        // journey is summarized afresh, as every composed Flex journey is.
        Ok(Integrated::Journey(
            json!({"status":"ready","mode":"transit","clockDate":q["serviceDate"],"departureMinutes":departure,"arrivalMinutes":arrival,"durationMinutes":arrival-departure,"transfers":journey.boardings+flex_legs-1-merged,"legs":legs,
                "warnings":[{"code":"flex_estimate","detail":"Conditional service: booking and vehicle availability are not confirmed."}]}),
        ))
    }
}

/// Earlier origin departure arrive-by, earlier alighting otherwise.
fn departure_first(
    opt: &Options,
    hops: &Hops,
    choice: &(usize, f64, f64),
    best: Option<&(usize, f64, f64)>,
) -> bool {
    let Some(best) = best else { return true };
    if opt.arrive {
        choice.1 - hops.list[choice.0].board.walk > best.1 - hops.list[best.0].board.walk
    } else {
        choice.2 < best.2
    }
}

/// Walking candidates plus Flex values; a stop keeps its better value.
/// Returns the merged set and the stops whose value came from Flex.
pub(super) fn merge(walk: &Candidates, flex: &HashMap<u32, f64>) -> (Candidates, Vec<u32>) {
    let mut seconds: HashMap<u32, f64> = HashMap::new();
    for (&s, &v) in walk.stops.iter().zip(&walk.seconds) {
        let slot = seconds.entry(s).or_insert(f64::INFINITY);
        *slot = slot.min(v);
    }
    let mut flexible = vec![];
    for (&s, &v) in flex {
        if seconds.get(&s).is_none_or(|&w| v < w) {
            seconds.insert(s, v);
            flexible.push(s);
        }
    }
    let mut stops: Vec<u32> = seconds.keys().copied().collect();
    stops.sort_unstable();
    flexible.sort_unstable();
    (
        Candidates {
            seconds: stops.iter().map(|s| seconds[s]).collect(),
            stops,
            terminal_transfers: walk.terminal_transfers,
            evidence: None,
        },
        flexible,
    )
}

fn clone_input(input: &TimetableMatrixQueryInput) -> TimetableMatrixQueryInput {
    TimetableMatrixQueryInput {
        origin_offsets: input.origin_offsets.clone(),
        origin_stops: input.origin_stops.clone(),
        origin_walk_seconds: input.origin_walk_seconds.clone(),
        allow_pre_ride_transfers: input.allow_pre_ride_transfers.clone(),
        destination_offsets: input.destination_offsets.clone(),
        destination_stops: input.destination_stops.clone(),
        destination_walk_seconds: input.destination_walk_seconds.clone(),
        departure: input.departure,
        horizon: input.horizon,
        arrive_by: input.arrive_by,
        allow_post_ride_transfers: input.allow_post_ride_transfers.clone(),
        maximum_boardings: input.maximum_boardings,
        include_journeys: input.include_journeys,
    }
}
