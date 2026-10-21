use super::query::{Candidates, Options, Point};
use super::{City, Result, memory::Heap};
use crate::{ShapeGeometry, TimetableMatrixJourney, TimetableMatrixLeg};
use rusqlite::OptionalExtension;
use serde_json::{Value, json};
use std::borrow::Cow;
use std::collections::{HashMap, VecDeque};

#[derive(Debug, Eq, Hash, PartialEq)]
enum LegKey {
    Ride(u32, Option<u32>, Option<u32>, u64, u64, Option<u64>),
    Walk(Option<u32>, Option<u32>, u64, [usize; 2]),
}

/// Immutable evidence shared only inside one Route search or Matrix request. Timetable, options,
/// and endpoint candidates cannot change during that request. No route answers
/// or mutable street frontiers survive it; output clocks are always refreshed.
#[derive(Default)]
pub(crate) struct MatrixMaterializationCache {
    entries: HashMap<LegKey, Value>,
    trip_details: HashMap<String, Value>,
    bytes: usize,
}
impl MatrixMaterializationCache {
    fn key(leg: &TimetableMatrixLeg, access: [&Candidates; 2]) -> LegKey {
        if let Some(trip) = leg.trip {
            LegKey::Ride(
                trip,
                leg.from_stop,
                leg.to_stop,
                leg.board_sequence.unwrap_or(f64::NAN).to_bits(),
                leg.alight_sequence.unwrap_or(f64::NAN).to_bits(),
                leg.in_seat_seconds.map(f64::to_bits),
            )
        } else {
            // Candidate identity retains the exact selected entrance/pathway
            // witness. Endpoint vectors live unchanged for the whole request.
            let endpoints = [leg.from_stop, leg.to_stop].map(|stop| stop.is_none());
            LegKey::Walk(
                leg.from_stop,
                leg.to_stop,
                (leg.arrival - leg.departure).to_bits(),
                std::array::from_fn(|i| {
                    if endpoints[i] {
                        access[i] as *const Candidates as usize
                    } else {
                        0
                    }
                }),
            )
        }
    }
    const MAX_BYTES: usize = 16 * 1024 * 1024;

    fn reserve(&mut self, bytes: usize) -> bool {
        if bytes > Self::MAX_BYTES.saturating_sub(self.bytes) {
            return false;
        }
        self.bytes += bytes;
        true
    }

    fn insert(&mut self, key: LegKey, value: &Value) {
        if self.entries.len() >= 4096 || self.entries.contains_key(&key) {
            return;
        }
        let bytes = value.heap_bytes() + std::mem::size_of::<(LegKey, Value)>() + 128;
        if self.reserve(bytes) {
            self.entries.insert(key, value.clone());
        }
    }

    fn insert_trip_details(&mut self, trip_id: &str, value: &Value) {
        if self.trip_details.len() >= 1024 || self.trip_details.contains_key(trip_id) {
            return;
        }
        let bytes =
            value.heap_bytes() + trip_id.len() + std::mem::size_of::<(String, Value)>() + 128;
        if self.reserve(bytes) {
            self.trip_details.insert(trip_id.to_owned(), value.clone());
        }
    }
}

fn leg_clocks(value: &mut Value, leg: &TimetableMatrixLeg) {
    value["departure"] = json!(leg.departure);
    value["arrival"] = json!(leg.arrival);
    value["departureMinutes"] = json!(leg.departure / 60.);
    value["arrivalMinutes"] = json!(leg.arrival / 60.);
    value["durationMinutes"] = json!((leg.arrival - leg.departure) / 60.);
}

/// Compiled immutable GTFS shapes, owned by one City. No route or timetable
/// answers are retained. Account again after alignment grows candidate data.
pub(crate) struct ShapeCache {
    entries: VecDeque<(String, CompiledShape, usize)>,
    bytes: usize,
    maximum_bytes: usize,
    maximum_entries: usize,
}

struct CompiledShape {
    geometry: ShapeGeometry,
    // A shape can serve several active stop sequences (including skipped
    // realtime calls). Key the complete coordinates, never only the trip ID.
    alignments: VecDeque<(Vec<[u64; 2]>, Vec<u32>)>,
}
impl CompiledShape {
    fn new(geometry: ShapeGeometry) -> Self {
        Self {
            geometry,
            alignments: VecDeque::new(),
        }
    }
    fn align(&mut self, stops: &[[f64; 2]]) -> Result<Vec<u32>> {
        let key: Vec<_> = stops.iter().map(|s| s.map(f64::to_bits)).collect();
        if let Some(index) = self.alignments.iter().position(|(k, _)| *k == key) {
            let entry = self.alignments.remove(index).unwrap();
            let indices = entry.1.clone();
            self.alignments.push_back(entry);
            return Ok(indices);
        }
        let indices = self
            .geometry
            .align_stops(stops.iter().flatten().copied().collect())?;
        if self.alignments.len() == 8 {
            self.alignments.pop_front();
        }
        self.alignments.push_back((key, indices.clone()));
        Ok(indices)
    }
    fn estimated_bytes(&self) -> usize {
        self.geometry.estimated_bytes() as usize
            + self.alignments.capacity() * std::mem::size_of::<(Vec<[u64; 2]>, Vec<u32>)>()
            + self
                .alignments
                .iter()
                .map(|(key, indices)| key.capacity() * 16 + indices.capacity() * 4)
                .sum::<usize>()
    }
}

impl Default for ShapeCache {
    fn default() -> Self {
        Self {
            entries: VecDeque::new(),
            bytes: 0,
            maximum_bytes: std::env::var("VIGO_SHAPE_GEOMETRY_CACHE_MAX_BYTES")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or_else(|| crate::resources::cache_budget(64 * 1024 * 1024, 64))
                .min(256 * 1024 * 1024),
            maximum_entries: std::env::var("VIGO_SHAPE_GEOMETRY_CACHE_MAX_ENTRIES")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(1024usize)
                .min(4096),
        }
    }
}

impl ShapeCache {
    pub(crate) fn partition_budget(&mut self, residents: usize) {
        self.maximum_bytes /= residents.max(1);
    }
    pub(crate) fn retained_bytes(&self) -> usize {
        self.bytes + self.entries.capacity() * std::mem::size_of::<(String, CompiledShape, usize)>()
    }
    pub(crate) fn diagnostics(&self) -> Value {
        json!({"entries":self.entries.len(),"estimatedBytes":self.retained_bytes(),
            "maximumBytes":self.maximum_bytes,"maximumEntries":self.maximum_entries})
    }
    fn take(&mut self, id: &str) -> Option<CompiledShape> {
        let index = self.entries.iter().rposition(|entry| entry.0 == id)?;
        let (_, shape, bytes) = self.entries.remove(index)?;
        self.bytes -= bytes;
        Some(shape)
    }

    fn put(&mut self, id: String, shape: CompiledShape) {
        let bytes = id.capacity() + shape.estimated_bytes();
        if bytes > self.maximum_bytes || self.maximum_entries == 0 {
            return;
        }
        self.bytes += bytes;
        self.entries.push_back((id, shape, bytes));
        while self.retained_bytes() > self.maximum_bytes
            || self.entries.len() > self.maximum_entries
        {
            let Some((_, _, removed)) = self.entries.pop_front() else {
                break;
            };
            self.bytes -= removed;
            if self.entries.is_empty() {
                self.entries.shrink_to_fit();
            }
        }
    }
}

impl City {
    fn expand_transfer_journey<'a>(
        &self,
        journey: &'a TimetableMatrixJourney,
    ) -> Result<Cow<'a, TimetableMatrixJourney>> {
        let t = self.timetable.as_ref().ok_or("Timetable not active")?;
        let mut expanded: Option<Vec<TimetableMatrixLeg>> = None;
        for (i, leg) in journey.legs.iter().enumerate() {
            let shortcut = if leg.kind == "walk" {
                leg.from_stop.zip(leg.to_stop).and_then(|(a, b)| {
                    self.transfer_shortcut_rows
                        .get(&t.stop_ids[a as usize])
                        .and_then(|&row| {
                            self.access.materialized.transfer_shortcuts[row]
                                .1
                                .iter()
                                .find(|e| {
                                    e.to_stop_id == t.stop_ids[b as usize]
                                        && (e.min_transfer_time - (leg.arrival - leg.departure))
                                            .abs()
                                            < 0.001
                                })
                        })
                })
            } else {
                None
            };
            if let Some(parts) = leg.trip.and_then(|trip| t.links.get(&trip)) {
                let legs = expanded.get_or_insert_with(|| journey.legs[..i].to_vec());
                let board = leg.board_sequence.ok_or("Missing linked-trip boarding")?;
                let alight = leg.alight_sequence.ok_or("Missing linked-trip alighting")?;
                let mut previous_arrival = None;
                for part in parts {
                    let selected: Vec<_> = (0..part.sequences.len())
                        .filter(|&j| {
                            let seq = f64::from(part.first) + j as f64;
                            seq >= board && seq <= alight
                        })
                        .collect();
                    let (Some(&first), Some(&last)) = (selected.first(), selected.last()) else {
                        continue;
                    };
                    let departure = f64::from(part.departures[first]);
                    let arrival = f64::from(part.arrivals[last]);
                    legs.push(TimetableMatrixLeg {
                        kind: "ride".into(),
                        trip: Some(part.trip),
                        board_sequence: Some(f64::from(part.sequences[first])),
                        alight_sequence: Some(f64::from(part.sequences[last])),
                        from_stop: Some(part.from[first]),
                        to_stop: Some(part.to[last]),
                        departure,
                        arrival,
                        in_seat_seconds: previous_arrival.map(|previous| departure - previous),
                    });
                    previous_arrival = Some(arrival);
                }
            } else if let Some(shortcut) = shortcut {
                let legs = expanded.get_or_insert_with(|| journey.legs[..i].to_vec());
                let mut clock = leg.departure;
                for step in &shortcut.steps {
                    let from = *t
                        .index
                        .get(&step.from_stop_id)
                        .ok_or("Unknown transfer witness origin")?;
                    let to = *t
                        .index
                        .get(&step.to_stop_id)
                        .ok_or("Unknown transfer witness destination")?;
                    legs.push(TimetableMatrixLeg {
                        from_stop: Some(from),
                        to_stop: Some(to),
                        departure: clock,
                        arrival: clock + step.min_transfer_time,
                        ..leg.clone()
                    });
                    clock += step.min_transfer_time;
                }
            } else if let Some(legs) = &mut expanded {
                legs.push(leg.clone());
            }
        }
        Ok(if let Some(legs) = expanded {
            Cow::Owned(TimetableMatrixJourney {
                legs,
                ..journey.clone()
            })
        } else {
            Cow::Borrowed(journey)
        })
    }
    /// The exact native witness for analytical matrices. Full display and
    /// walking-evidence materialization remains the default response format.
    pub(crate) fn compact_journey(&self, journey: &TimetableMatrixJourney) -> Result<Value> {
        let journey = self.expand_transfer_journey(journey)?;
        let t = self.timetable.as_ref().ok_or("Timetable not active")?;
        let mut value = json!({
            "departureMinutes": journey.departure / 60.,
            "arrivalMinutes": journey.arrival / 60.,
            "durationMinutes": (journey.arrival - journey.departure) / 60.,
            "walkMinutes": journey.walking_seconds / 60.,
            "rideMinutes": journey.ride_seconds / 60.,
            "waitMinutes": journey.waiting_seconds / 60.,
            "transfers": journey.boardings.saturating_sub(1),
            "boardings": journey.boardings,
        });
        value["legs"] = Value::Array(
            journey
                .legs
                .iter()
                .map(|leg| {
                    let mut v = json!({
                        "kind": leg.kind,
                        "fromStopId": leg.from_stop.map(|i| &t.stop_ids[i as usize]),
                        "toStopId": leg.to_stop.map(|i| &t.stop_ids[i as usize]),
                        "departureMinutes": leg.departure / 60.,
                        "arrivalMinutes": leg.arrival / 60.,
                        "durationMinutes": (leg.arrival - leg.departure) / 60.,
                    });
                    if let Some(trip) = leg.trip {
                        if let Some(seconds) = leg.in_seat_seconds {
                            v["inSeatSeconds"] = json!(seconds);
                        }
                        v["tripId"] = json!(t.trip_ids[trip as usize]);
                        v["boardSequence"] = json!(leg.board_sequence);
                        v["alightSequence"] = json!(leg.alight_sequence);
                    }
                    v
                })
                .collect(),
        );
        Ok(value)
    }
    pub(crate) fn materialize(
        &mut self,
        journey: &TimetableMatrixJourney,
        endpoints: [&Point; 2],
        geometry: bool,
        opt: &Options,
        access: [&Candidates; 2],
        mut cache: Option<&mut MatrixMaterializationCache>,
    ) -> Result<Value> {
        let [origin, destination] = endpoints;
        let journey = self.expand_transfer_journey(journey)?;
        let mut value = serde_json::to_value(journey.as_ref())?;
        for (i, leg) in journey.legs.iter().enumerate() {
            let t = self.timetable.as_ref().ok_or("Timetable not active")?;
            let v = &mut value["legs"][i];
            let key = cache
                .as_ref()
                .map(|_| MatrixMaterializationCache::key(leg, access));
            if let Some(saved) = key
                .as_ref()
                .and_then(|k| cache.as_ref().unwrap().entries.get(k))
            {
                *v = saved.clone();
                leg_clocks(v, leg);
                continue;
            }
            let mut coordinates = [origin.coordinate, destination.coordinate];
            let last = journey.legs.len() - 1;
            for (j, (key, index)) in [("from", leg.from_stop), ("to", leg.to_stop)]
                .into_iter()
                .enumerate()
            {
                if let Some(id) = index.and_then(|n| t.stop_ids.get(n as usize)) {
                    let s = self.stop(id)?;
                    coordinates[j] = [s.lon, s.lat];
                    v[key] = json!({"stopId":id,"name":s.name,"coordinate":coordinates[j]});
                    v[format!("{key}StopId")] = json!(id);
                } else {
                    v[key] = json!({"coordinate":coordinates[j]});
                    // A journey that starts or ends at a selected stop names it.
                    let endpoint = if j == 0 && i == 0 {
                        origin.stop.as_ref()
                    } else if j == 1 && i == last {
                        destination.stop.as_ref()
                    } else {
                        None
                    };
                    if let Some(id) = endpoint {
                        v[key]["name"] = json!(self.stop(id)?.name);
                    }
                }
            }
            if let Some(trip) = leg.trip {
                let trip_id = &t.trip_ids[trip as usize];
                let route_id = &t.route_ids[trip as usize];
                v["tripId"] = json!(trip_id);
                v["routeId"] = json!(route_id);
                let route = match self.route_metadata.entry(route_id.clone()) {
                    std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
                    std::collections::hash_map::Entry::Vacant(entry) => {
                        let value = self.db.prepare_cached("SELECT short_name,long_name,route_type,color FROM routes WHERE route_id=?")?
                            .query_row([route_id], |r| {
                                Ok(json!({"shortName":r.get::<_,Option<String>>(0)?,"longName":r.get::<_,Option<String>>(1)?,"type":r.get::<_,Option<i32>>(2)?,"color":r.get::<_,Option<String>>(3)?}))
                            }).optional()?.unwrap_or(Value::Null);
                        entry.insert(value)
                    }
                };
                v["route"] = route.clone();
                if let Some(service) = self
                    .scenario_view
                    .as_ref()
                    .and_then(|view| view.services.get(route_id))
                {
                    v["scenarioService"] = service.clone();
                }
                let details = if let Some(value) = cache
                    .as_ref()
                    .and_then(|c| c.trip_details.get(trip_id))
                    .or_else(|| self.trip_details.get(trip_id))
                {
                    value.clone()
                } else {
                    let value = self.db.prepare_cached("SELECT t.service_id,t.direction_id,d.headsign,d.short_name FROM trips t LEFT JOIN trip_details d ON d.trip_id=t.trip_id WHERE t.trip_id=?")?
                    .query_row([trip_id], |r| Ok(json!({"service":r.get::<_,String>(0)?,"direction":r.get::<_,Option<String>>(1)?,
                        "headsign":r.get::<_,Option<String>>(2)?,"shortName":r.get::<_,Option<String>>(3)?}))).optional()?.unwrap_or(Value::Null);
                    if let Some(cache) = cache.as_mut() {
                        cache.insert_trip_details(trip_id, &value);
                    }
                    // Trip descriptions are immutable City data, like route
                    // metadata; keep a bounded City-wide copy.
                    if self.trip_details.len() >= 65_536 {
                        self.trip_details.clear();
                    }
                    self.trip_details.insert(trip_id.clone(), value.clone());
                    value
                };
                v["serviceId"] = details["service"].clone();
                v["serviceDate"] = json!(
                    t.trip_service_dates
                        .get(trip as usize)
                        .filter(|s| !s.is_empty())
                        .map(String::as_str)
                        .unwrap_or(&t.key[..10])
                );
                v["directionId"] = details["direction"].clone();
                v["headsign"] = details["headsign"].clone();
                v["tripShortName"] = details["shortName"].clone();
                let (indexes, first, last) = t.kernel.ride_stop_sequence(
                    trip,
                    leg.board_sequence.ok_or("Missing board sequence")?,
                    leg.alight_sequence.ok_or("Missing alight sequence")?,
                )?;
                // Source timing limitations, flagged exactly as Node flags them.
                let board = leg.board_sequence.ok_or("Missing board sequence")?;
                let alight = leg.alight_sequence.ok_or("Missing alight sequence")?;
                let gaps = t.kernel.ride_bridged_gaps(trip, board, alight);
                if gaps > 0 {
                    v["bridgedUntimedGapCount"] = json!(gaps);
                }
                if leg.arrival == leg.departure && leg.from_stop != leg.to_stop {
                    v["sourceEqualTime"] = json!(true);
                }
                let ids: Vec<_> = indexes.iter().map(|&i| &t.stop_ids[i as usize]).collect();
                v["stopIds"] = json!(&ids[first..=last]);
                v["stopCount"] = json!(last - first);
                if t.realtime_trips.binary_search(&trip).is_ok() {
                    v["realtimeTrip"] = json!(true);
                }
                if let Some(alerts) = &t.alerts {
                    let ride =
                        alerts.for_ride(trip, &indexes[first..=last], leg.departure, leg.arrival);
                    if !ride.is_empty() {
                        v["alerts"] = Value::Array(ride);
                    }
                }
                let calls = t.kernel.ride_calls(trip);
                v["intermediateStops"] = Value::Array(calls[first + 1..last].iter().map(|c| {
                    let id = &t.stop_ids[c.stop as usize];
                    let stop = self.stop(id)?;
                    Ok(json!({"stopId":id,"name":stop.name,"coordinate":[stop.lon,stop.lat],
                        "arrival":c.arrival,"departure":c.departure}))
                }).collect::<Result<Vec<Value>>>()?);
                if geometry {
                    let trip_coordinates: Vec<_> = ids
                        .iter()
                        .map(|id| self.stop(id).map(|s| [s.lon, s.lat]))
                        .collect::<Result<_>>()?;
                    let located = |point: [f64; 2]| point.iter().all(|v| v.is_finite());
                    let mut shaped = None;
                    let shape_id = match self.trip_shape_ids.entry(trip_id.clone()) {
                        std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
                        std::collections::hash_map::Entry::Vacant(entry) => {
                            let id = self
                                .db
                                .prepare_cached("SELECT shape_id FROM trip_shapes WHERE trip_id=?")?
                                .query_row([trip_id], |r| r.get::<_, String>(0))
                                .optional()?;
                            entry.insert(id)
                        }
                    }
                    .clone();
                    if let Some(id) = shape_id {
                        let shape = match self.shape_cache.take(&id) {
                            Some(shape) => Some(shape),
                            None => self.shapes.read_shape(id.clone())?.map(CompiledShape::new),
                        };
                        if let Some(mut shape) = shape {
                            let alignment = shape.align(&trip_coordinates)?;
                            if alignment.len() == trip_coordinates.len()
                                && alignment[first] < alignment[last]
                            {
                                // One line definition for every runtime: the
                                // stops plus every distinct aligned shape vertex.
                                let (line, meters) = shape.geometry.leg_polyline(
                                    alignment[first] as usize,
                                    alignment[last] as usize,
                                    Some(trip_coordinates[first]).filter(|p| located(*p)),
                                    Some(trip_coordinates[last]).filter(|p| located(*p)),
                                )?;
                                shaped = Some((line, Some(meters), "gtfs_shape"));
                            }
                            self.shape_cache.put(id, shape);
                        }
                    }
                    let (selected, distance, source) = shaped.unwrap_or_else(|| {
                        let (line, distance) = crate::route_materialization::stop_sequence_polyline(
                            &trip_coordinates[first..=last],
                        );
                        (line, distance, "stop_sequence")
                    });
                    if let Some(distance) = distance {
                        v["distanceMeters"] = json!(distance);
                    }
                    v["coordinates"] = json!(selected);
                    v["geometrySource"] = json!(source);
                }
            } else {
                let evidence =
                    self.walk_evidence(leg, [origin, destination], access, opt, geometry)?;
                if let Value::Object(evidence) = evidence {
                    v.as_object_mut().unwrap().extend(evidence);
                }
            }
            leg_clocks(v, leg);
            if let (Some(cache), Some(key)) = (cache.as_deref_mut(), key) {
                cache.insert(key, v);
            }
        }
        value["departureMinutes"] = json!(journey.departure / 60.);
        value["arrivalMinutes"] = json!(journey.arrival / 60.);
        value["durationMinutes"] = json!((journey.arrival - journey.departure) / 60.);
        value["walkMinutes"] = json!(journey.walking_seconds / 60.);
        value["rideMinutes"] = json!(journey.ride_seconds / 60.);
        value["waitMinutes"] = json!(journey.waiting_seconds / 60.);
        value["transfers"] = json!(journey.boardings.saturating_sub(1));
        self.annotate_station_walks(&mut value, [origin, destination])?;
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matrix_evidence_keeps_endpoints_and_run_clocks_separate() {
        let candidate = || Candidates {
            stops: vec![],
            seconds: vec![],
            terminal_transfers: false,
            evidence: None,
        };
        let (origin, a, b) = (candidate(), candidate(), candidate());
        let mut leg = TimetableMatrixLeg {
            in_seat_seconds: None,
            kind: "walk".into(),
            from_stop: None,
            to_stop: None,
            trip: None,
            board_sequence: None,
            alight_sequence: None,
            departure: 0.,
            arrival: 60.,
        };
        assert_ne!(
            MatrixMaterializationCache::key(&leg, [&origin, &a]),
            MatrixMaterializationCache::key(&leg, [&origin, &b])
        );
        leg.from_stop = Some(1);
        leg.to_stop = Some(2);
        leg.trip = Some(3);
        leg.board_sequence = Some(1.);
        leg.alight_sequence = Some(2.);
        let key = MatrixMaterializationCache::key(&leg, [&origin, &a]);
        leg.departure = 120.;
        leg.arrival = 210.;
        assert_eq!(key, MatrixMaterializationCache::key(&leg, [&origin, &a]));
        let mut evidence = json!({"coordinates":[[1.,2.],[3.,4.]],"departure":0.,"arrival":60.});
        leg_clocks(&mut evidence, &leg);
        assert_eq!(evidence["departure"], 120.);
        assert_eq!(evidence["arrival"], 210.);
        assert_eq!(evidence["durationMinutes"], 1.5);
        assert_eq!(evidence["coordinates"], json!([[1., 2.], [3., 4.]]));
    }

    #[test]
    fn matrix_evidence_is_bounded_and_does_not_survive_requests() {
        let mut cache = MatrixMaterializationCache::default();
        for i in 0..5000 {
            cache.insert(
                LegKey::Ride(i, None, None, 0, 0, None),
                &json!({"source":"GTFS"}),
            );
        }
        assert_eq!(cache.entries.len(), 4096);
        assert!(cache.bytes <= 16 * 1024 * 1024);
        let empty = MatrixMaterializationCache::default();
        assert!(empty.entries.is_empty());
        let mut cache = MatrixMaterializationCache::default();
        cache.insert(
            LegKey::Ride(0, None, None, 0, 0, None),
            &json!("x".repeat(16 * 1024 * 1024)),
        );
        assert!(cache.entries.is_empty());
        assert_eq!(cache.bytes, 0);
    }

    #[test]
    fn matrix_metadata_and_legs_share_one_budget_without_duplicate_charges() {
        let mut cache = MatrixMaterializationCache::default();
        let details = json!({"headsign":"Downtown"});
        cache.insert_trip_details("trip", &details);
        let metadata_bytes = cache.bytes;
        cache.insert_trip_details("trip", &details);
        assert_eq!(cache.bytes, metadata_bytes);
        cache.insert(LegKey::Ride(0, None, None, 0, 0, None), &Value::Null);
        let both_bytes = cache.bytes;
        cache.insert(LegKey::Ride(0, None, None, 0, 0, None), &Value::Null);
        assert_eq!(cache.bytes, both_bytes);
        assert!(both_bytes > metadata_bytes);
        // Neither store can bypass the budget consumed by the other.
        let oversized = json!("x".repeat(MatrixMaterializationCache::MAX_BYTES - both_bytes));
        cache.insert_trip_details("large", &oversized);
        cache.insert(LegKey::Ride(1, None, None, 0, 0, None), &oversized);
        assert_eq!(cache.trip_details.len(), 1);
        assert_eq!(cache.entries.len(), 1);
        assert_eq!(cache.bytes, both_bytes);
    }

    fn shape() -> CompiledShape {
        CompiledShape::new(ShapeGeometry::new(vec![-77.0, 38.0, -77.001, 38.001]).unwrap())
    }

    #[test]
    fn shape_retention_is_bounded_and_recent_use_survives_eviction() {
        let mut cache = ShapeCache {
            maximum_entries: 2,
            ..ShapeCache::default()
        };
        cache.put("a".into(), shape());
        cache.put("b".into(), shape());
        let mut a = cache.take("a").unwrap();
        let points = a.geometry.leg_polyline(0, 1, None, None).unwrap().0;
        let stops = points.clone();
        assert_eq!(a.align(&stops).unwrap(), vec![0, 1]);
        cache.put("a".into(), a);
        cache.put("c".into(), shape());
        assert!(cache.take("b").is_none());
        assert_eq!(
            cache
                .take("a")
                .unwrap()
                .geometry
                .leg_polyline(0, 1, None, None)
                .unwrap()
                .0,
            points
        );
        assert!(cache.take("c").is_some());
        assert_eq!(cache.bytes, 0);

        cache.maximum_bytes = 1;
        cache.put("too-large".into(), shape());
        assert!(cache.entries.is_empty());
        assert_eq!(cache.bytes, 0);
        cache.maximum_bytes = 32 * 1024 * 1024;
        cache.put("first".into(), shape());
        cache.maximum_bytes = cache.bytes;
        cache.put("other".into(), shape());
        assert!(cache.entries.len() <= 1);
        assert!(cache.bytes <= cache.maximum_bytes);
    }

    #[test]
    fn alignment_reuse_is_exact_bounded_and_accounted() {
        let mut cached = shape();
        let original = [[-77.0, 38.0], [-77.001, 38.001]];
        let before = cached.estimated_bytes();
        assert_eq!(cached.align(&original).unwrap(), vec![0, 1]);
        let after = cached.estimated_bytes();
        assert!(after > before);
        assert_eq!(cached.align(&original).unwrap(), vec![0, 1]);
        assert_eq!(cached.alignments.len(), 1);
        assert_eq!(cached.estimated_bytes(), after);
        for i in 0..12 {
            let stops = [[-77.0 + f64::from(i) * 1e-6, 38.0], [-77.001, 38.001]];
            let expected = shape()
                .geometry
                .align_stops(stops.into_iter().flatten().collect())
                .unwrap();
            assert_eq!(cached.align(&stops).unwrap(), expected);
        }
        assert_eq!(cached.alignments.len(), 8);
        // A realtime skipped call changes the full sequence and cannot reuse
        // an alignment belonging to the scheduled trip.
        let skipped = [original[1]];
        assert!(cached.align(&skipped).unwrap().is_empty());
        assert_eq!(cached.align(&original).unwrap(), vec![0, 1]);
    }
}
