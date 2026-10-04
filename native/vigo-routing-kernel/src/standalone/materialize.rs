use super::query::{Candidates, Options, Point, haversine};
use super::{City, Result};
use crate::{ShapeGeometry, TimetableMatrixJourney};
use rusqlite::OptionalExtension;
use serde_json::{Value, json};
use std::collections::VecDeque;

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
            maximum_bytes: 32 * 1024 * 1024,
            maximum_entries: 128,
        }
    }
}

impl ShapeCache {
    fn take(&mut self, id: &str) -> Option<CompiledShape> {
        let index = self.entries.iter().position(|entry| entry.0 == id)?;
        let (_, shape, bytes) = self.entries.remove(index)?;
        self.bytes -= bytes;
        Some(shape)
    }

    fn put(&mut self, id: String, shape: CompiledShape) {
        let bytes = id.capacity()
            + shape.estimated_bytes()
            + std::mem::size_of::<(String, CompiledShape, usize)>();
        if bytes > self.maximum_bytes || self.maximum_entries == 0 {
            return;
        }
        while self.bytes + bytes > self.maximum_bytes || self.entries.len() >= self.maximum_entries
        {
            let (_, _, removed) = self.entries.pop_front().unwrap();
            self.bytes -= removed;
        }
        self.bytes += bytes;
        self.entries.push_back((id, shape, bytes));
    }
}

impl City {
    /// The exact native witness for analytical matrices. Full display and
    /// walking-evidence materialization remains the default response format.
    pub(crate) fn compact_journey(&self, journey: &TimetableMatrixJourney) -> Result<Value> {
        let t = self.timetable.as_ref().ok_or("Timetable not active")?;
        let mut value = json!({
            "departureMinutes": journey.departure / 60.,
            "arrivalMinutes": journey.arrival / 60.,
            "durationMinutes": (journey.arrival - journey.departure) / 60.,
            "walkMinutes": journey.walking_seconds / 60.,
            "rideMinutes": journey.ride_seconds / 60.,
            "waitMinutes": journey.waiting_seconds / 60.,
            "transfers": journey.boardings.saturating_sub(1),
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
        origin: &Point,
        destination: &Point,
        geometry: bool,
        opt: &Options,
        access: [&Candidates; 2],
    ) -> Result<Value> {
        let mut value = serde_json::to_value(journey)?;
        for (i, leg) in journey.legs.iter().enumerate() {
            let t = self.timetable.as_ref().ok_or("Timetable not active")?;
            let v = &mut value["legs"][i];
            let mut coordinates = [origin.coordinate, destination.coordinate];
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
                let (indexes, first, last) = t.kernel.ride_stop_sequence(
                    trip,
                    leg.board_sequence.ok_or("Missing board sequence")?,
                    leg.alight_sequence.ok_or("Missing alight sequence")?,
                )?;
                let ids: Vec<_> = indexes.iter().map(|&i| &t.stop_ids[i as usize]).collect();
                v["stopIds"] = json!(&ids[first..=last]);
                v["stopCount"] = json!(last - first);
                if geometry {
                    let trip_coordinates: Vec<_> = ids
                        .iter()
                        .map(|id| self.stop(id).map(|s| [s.lon, s.lat]))
                        .collect::<Result<_>>()?;
                    let mut selected = trip_coordinates[first..=last].to_vec();
                    let mut source = "stop_sequence";
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
                                selected = shape
                                    .geometry
                                    .coordinate_slice(
                                        alignment[first] as usize..=alignment[last] as usize,
                                    )?
                                    .to_vec();
                                source = "gtfs_shape";
                            }
                            self.shape_cache.put(id, shape);
                        }
                    }
                    v["distanceMeters"] = json!(
                        selected
                            .windows(2)
                            .map(|p| haversine(p[0], p[1]))
                            .sum::<f64>()
                    );
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
            v["departureMinutes"] = json!(leg.departure / 60.);
            v["arrivalMinutes"] = json!(leg.arrival / 60.);
            v["durationMinutes"] = json!((leg.arrival - leg.departure) / 60.);
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
        let points = a.geometry.packed_coordinates();
        let stops: Vec<_> = points.chunks_exact(2).map(|p| [p[0], p[1]]).collect();
        assert_eq!(a.align(&stops).unwrap(), vec![0, 1]);
        cache.put("a".into(), a);
        cache.put("c".into(), shape());
        assert!(cache.take("b").is_none());
        assert_eq!(
            cache.take("a").unwrap().geometry.packed_coordinates(),
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
