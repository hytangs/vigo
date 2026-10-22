//! GTFS-Realtime FeedMessage decoding. Only the standardized fields routing
//! and alert evidence use are read; unknown fields are skipped. A known field
//! with an unexpected wire type, a truncated value, a DIFFERENTIAL feed or a
//! deleted entity rejects the whole feed, so a partial read is never applied.
use serde_json::{Map, Value, json};
use std::fmt;

/// Bounds that match the Studio decoder, so both reject the same feeds.
pub const MAXIMUM_ENTITIES: usize = 100_000;
pub const MAXIMUM_STOP_TIME_UPDATES: usize = 500_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodeError(String);
impl fmt::Display for DecodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "GTFS-RT {}", self.0)
    }
}
impl std::error::Error for DecodeError {}
type Result<T> = std::result::Result<T, DecodeError>;
fn malformed(what: &str) -> DecodeError {
    DecodeError(format!("feed is malformed: {what}"))
}

#[derive(Debug, Default, Clone, PartialEq)]
pub struct Header {
    pub version: String,
    pub incrementality: Option<u64>,
    pub timestamp: Option<u64>,
    pub feed_version: Option<String>,
}

#[derive(Debug, Default, Clone, PartialEq)]
pub struct TripDescriptor {
    pub trip_id: Option<String>,
    pub route_id: Option<String>,
    pub direction_id: Option<u32>,
    pub start_time: Option<String>,
    pub start_date: Option<String>,
    pub schedule_relationship: Option<u64>,
}

#[derive(Debug, Default, Clone, PartialEq)]
pub struct StopTimeEvent {
    pub delay: Option<i32>,
    pub time: Option<i64>,
    pub uncertainty: Option<i32>,
    pub scheduled_time: Option<i64>,
}

#[derive(Debug, Default, Clone, PartialEq)]
pub struct StopTimeUpdate {
    pub stop_time_properties: Option<Value>,
    pub stop_sequence: Option<u32>,
    pub stop_id: Option<String>,
    pub arrival: Option<StopTimeEvent>,
    pub departure: Option<StopTimeEvent>,
    pub schedule_relationship: Option<u64>,
}

#[derive(Debug, Default, Clone, PartialEq)]
pub struct TripUpdate {
    pub entity_id: String,
    pub trip: Option<TripDescriptor>,
    pub vehicle_id: Option<String>,
    pub vehicle_label: Option<String>,
    pub stop_time_updates: Vec<StopTimeUpdate>,
    pub timestamp: Option<u64>,
    pub delay: Option<i32>,
}

#[derive(Debug, Default, Clone, PartialEq)]
pub struct EntitySelector {
    pub agency_id: Option<String>,
    pub route_id: Option<String>,
    pub route_type: Option<i32>,
    pub trip: Option<TripDescriptor>,
    pub stop_id: Option<String>,
    pub direction_id: Option<u32>,
}

#[derive(Debug, Default, Clone, PartialEq)]
pub struct Alert {
    pub entity_id: String,
    pub active_periods: Vec<(Option<u64>, Option<u64>)>,
    pub informed_entities: Vec<EntitySelector>,
    pub cause: Option<u64>,
    pub effect: Option<u64>,
    pub severity: Option<u64>,
    pub url: Option<String>,
    pub header: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Default, Clone, PartialEq)]
pub struct Feed {
    pub header: Header,
    pub trip_updates: Vec<TripUpdate>,
    pub alerts: Vec<Alert>,
    pub vehicle_positions: usize,
    /// Entities without a trip update, vehicle position or alert.
    pub other_entities: usize,
}

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

const VARINT: u8 = 0;
const FIXED64: u8 = 1;
const LENGTH: u8 = 2;
const FIXED32: u8 = 5;

impl<'a> Reader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, at: 0 }
    }
    fn varint(&mut self) -> Result<u64> {
        let mut value = 0_u64;
        for shift in (0..64).step_by(7) {
            let byte = *self
                .bytes
                .get(self.at)
                .ok_or_else(|| malformed("truncated varint"))?;
            self.at += 1;
            value |= u64::from(byte & 0x7f) << shift;
            if byte & 0x80 == 0 {
                return Ok(value);
            }
        }
        Err(malformed("varint exceeds 64 bits"))
    }
    fn key(&mut self) -> Result<Option<(u64, u8)>> {
        if self.at == self.bytes.len() {
            return Ok(None);
        }
        let key = self.varint()?;
        let field = key >> 3;
        if field == 0 {
            return Err(malformed("field number zero"));
        }
        Ok(Some((field, (key & 7) as u8)))
    }
    fn take(&mut self, length: usize) -> Result<&'a [u8]> {
        let end = self
            .at
            .checked_add(length)
            .filter(|&end| end <= self.bytes.len())
            .ok_or_else(|| malformed("truncated field"))?;
        let value = &self.bytes[self.at..end];
        self.at = end;
        Ok(value)
    }
    fn delimited(&mut self) -> Result<&'a [u8]> {
        let length = usize::try_from(self.varint()?).map_err(|_| malformed("oversized field"))?;
        self.take(length)
    }
    fn skip(&mut self, wire: u8) -> Result<()> {
        match wire {
            VARINT => self.varint().map(drop),
            FIXED64 => self.take(8).map(drop),
            LENGTH => self.delimited().map(drop),
            FIXED32 => self.take(4).map(drop),
            // Groups are not part of GTFS-Realtime.
            _ => Err(malformed("unsupported wire type")),
        }
    }
}

// Typed readers check the wire type of every known field they consume.
fn expect(wire: u8, expected: u8) -> Result<()> {
    if wire == expected {
        Ok(())
    } else {
        Err(malformed("unexpected wire type for a known field"))
    }
}
fn unsigned(r: &mut Reader, wire: u8) -> Result<u64> {
    expect(wire, VARINT)?;
    r.varint()
}
// Protobuf int32 and int64 are two's complement varints, not zigzag.
fn int64(r: &mut Reader, wire: u8) -> Result<i64> {
    Ok(unsigned(r, wire)? as i64)
}
fn int32(r: &mut Reader, wire: u8) -> Result<i32> {
    Ok(int64(r, wire)? as i32)
}
fn string(r: &mut Reader, wire: u8) -> Result<String> {
    expect(wire, LENGTH)?;
    Ok(String::from_utf8_lossy(r.delimited()?).into_owned())
}
fn message<'a>(r: &mut Reader<'a>, wire: u8) -> Result<Reader<'a>> {
    expect(wire, LENGTH)?;
    Ok(Reader::new(r.delimited()?))
}
fn boolean(r: &mut Reader, wire: u8) -> Result<bool> {
    Ok(unsigned(r, wire)? != 0)
}

fn header(mut r: Reader) -> Result<Header> {
    let mut h = Header::default();
    while let Some((field, wire)) = r.key()? {
        match field {
            1 => h.version = string(&mut r, wire)?,
            2 => h.incrementality = Some(unsigned(&mut r, wire)?),
            3 => h.timestamp = Some(unsigned(&mut r, wire)?),
            4 => h.feed_version = Some(string(&mut r, wire)?),
            _ => r.skip(wire)?,
        }
    }
    Ok(h)
}

fn trip_descriptor(mut r: Reader) -> Result<TripDescriptor> {
    let mut t = TripDescriptor::default();
    while let Some((field, wire)) = r.key()? {
        match field {
            1 => t.trip_id = Some(string(&mut r, wire)?),
            2 => t.start_time = Some(string(&mut r, wire)?),
            3 => t.start_date = Some(string(&mut r, wire)?),
            4 => t.schedule_relationship = Some(unsigned(&mut r, wire)?),
            5 => t.route_id = Some(string(&mut r, wire)?),
            6 => t.direction_id = Some(unsigned(&mut r, wire)? as u32),
            _ => r.skip(wire)?,
        }
    }
    Ok(t)
}

fn vehicle_descriptor(mut r: Reader) -> Result<(Option<String>, Option<String>)> {
    let (mut id, mut label) = (None, None);
    while let Some((field, wire)) = r.key()? {
        match field {
            1 => id = Some(string(&mut r, wire)?),
            2 => label = Some(string(&mut r, wire)?),
            _ => r.skip(wire)?,
        }
    }
    Ok((id, label))
}

fn stop_time_event(mut r: Reader) -> Result<StopTimeEvent> {
    let mut e = StopTimeEvent::default();
    while let Some((field, wire)) = r.key()? {
        match field {
            1 => e.delay = Some(int32(&mut r, wire)?),
            2 => e.time = Some(int64(&mut r, wire)?),
            3 => e.uncertainty = Some(int32(&mut r, wire)?),
            4 => e.scheduled_time = Some(int64(&mut r, wire)?),
            _ => r.skip(wire)?,
        }
    }
    Ok(e)
}

fn stop_time_update(mut r: Reader) -> Result<StopTimeUpdate> {
    let mut u = StopTimeUpdate::default();
    while let Some((field, wire)) = r.key()? {
        match field {
            1 => u.stop_sequence = Some(unsigned(&mut r, wire)? as u32),
            2 => u.arrival = Some(stop_time_event(message(&mut r, wire)?)?),
            3 => u.departure = Some(stop_time_event(message(&mut r, wire)?)?),
            4 => u.stop_id = Some(string(&mut r, wire)?),
            5 => u.schedule_relationship = Some(unsigned(&mut r, wire)?),
            6 => {
                let mut props = message(&mut r, wire)?;
                let mut record = Map::new();
                while let Some((field, wire)) = props.key()? {
                    match field {
                        1 => {
                            record
                                .insert("assignedStopId".into(), string(&mut props, wire)?.into());
                        }
                        2 => {
                            record.insert("stopHeadsign".into(), string(&mut props, wire)?.into());
                        }
                        3 => {
                            record.insert("pickupType".into(), unsigned(&mut props, wire)?.into());
                        }
                        4 => {
                            record.insert("dropOffType".into(), unsigned(&mut props, wire)?.into());
                        }
                        _ => props.skip(wire)?,
                    }
                }
                u.stop_time_properties = Some(Value::Object(record));
            }
            _ => r.skip(wire)?,
        }
    }
    Ok(u)
}

fn trip_update(mut r: Reader, entity_id: String, stop_updates: &mut usize) -> Result<TripUpdate> {
    let mut u = TripUpdate {
        entity_id,
        ..TripUpdate::default()
    };
    while let Some((field, wire)) = r.key()? {
        match field {
            1 => u.trip = Some(trip_descriptor(message(&mut r, wire)?)?),
            2 => {
                *stop_updates += 1;
                if *stop_updates > MAXIMUM_STOP_TIME_UPDATES {
                    return Err(DecodeError(format!(
                        "feed exceeds {MAXIMUM_STOP_TIME_UPDATES} stop predictions"
                    )));
                }
                u.stop_time_updates
                    .push(stop_time_update(message(&mut r, wire)?)?);
            }
            3 => (u.vehicle_id, u.vehicle_label) = vehicle_descriptor(message(&mut r, wire)?)?,
            4 => u.timestamp = Some(unsigned(&mut r, wire)?),
            5 => u.delay = Some(int32(&mut r, wire)?),
            _ => r.skip(wire)?,
        }
    }
    Ok(u)
}

fn entity_selector(mut r: Reader) -> Result<EntitySelector> {
    let mut s = EntitySelector::default();
    while let Some((field, wire)) = r.key()? {
        match field {
            1 => s.agency_id = Some(string(&mut r, wire)?),
            2 => s.route_id = Some(string(&mut r, wire)?),
            3 => s.route_type = Some(int32(&mut r, wire)?),
            4 => s.trip = Some(trip_descriptor(message(&mut r, wire)?)?),
            5 => s.stop_id = Some(string(&mut r, wire)?),
            6 => s.direction_id = Some(unsigned(&mut r, wire)? as u32),
            _ => r.skip(wire)?,
        }
    }
    Ok(s)
}

fn time_range(mut r: Reader) -> Result<(Option<u64>, Option<u64>)> {
    let (mut start, mut end) = (None, None);
    while let Some((field, wire)) = r.key()? {
        match field {
            1 => start = Some(unsigned(&mut r, wire)?),
            2 => end = Some(unsigned(&mut r, wire)?),
            _ => r.skip(wire)?,
        }
    }
    Ok((start, end))
}

// The English translation when present, otherwise the first, as in Studio.
fn translated(mut r: Reader) -> Result<Option<String>> {
    let mut first = None;
    while let Some((field, wire)) = r.key()? {
        if field != 1 {
            r.skip(wire)?;
            continue;
        }
        let mut t = message(&mut r, wire)?;
        let (mut text, mut language) = (None, None);
        while let Some((field, wire)) = t.key()? {
            match field {
                1 => text = Some(string(&mut t, wire)?),
                2 => language = Some(string(&mut t, wire)?),
                _ => t.skip(wire)?,
            }
        }
        if language.as_deref() == Some("en") && text.is_some() {
            return Ok(text);
        }
        if first.is_none() {
            first = text;
        }
    }
    Ok(first)
}

fn alert(mut r: Reader, entity_id: String) -> Result<Alert> {
    let mut a = Alert {
        entity_id,
        ..Alert::default()
    };
    while let Some((field, wire)) = r.key()? {
        match field {
            1 => a.active_periods.push(time_range(message(&mut r, wire)?)?),
            5 => a
                .informed_entities
                .push(entity_selector(message(&mut r, wire)?)?),
            6 => a.cause = Some(unsigned(&mut r, wire)?),
            7 => a.effect = Some(unsigned(&mut r, wire)?),
            8 => a.url = translated(message(&mut r, wire)?)?,
            10 => a.header = translated(message(&mut r, wire)?)?,
            11 => a.description = translated(message(&mut r, wire)?)?,
            14 => a.severity = Some(unsigned(&mut r, wire)?),
            _ => r.skip(wire)?,
        }
    }
    Ok(a)
}

/// Decodes one complete GTFS-Realtime FeedMessage.
pub fn decode(bytes: &[u8]) -> Result<Feed> {
    let mut r = Reader::new(bytes);
    let mut feed = Feed::default();
    let mut has_header = false;
    let mut entities = 0;
    let mut stop_updates = 0;
    while let Some((field, wire)) = r.key()? {
        match field {
            1 => {
                feed.header = header(message(&mut r, wire)?)?;
                has_header = true;
            }
            2 => {
                entities += 1;
                if entities > MAXIMUM_ENTITIES {
                    return Err(DecodeError(format!(
                        "feed exceeds {MAXIMUM_ENTITIES} entities"
                    )));
                }
                let mut e = message(&mut r, wire)?;
                let mut id = String::new();
                let mut parts = Vec::new();
                while let Some((field, wire)) = e.key()? {
                    match field {
                        1 => id = string(&mut e, wire)?,
                        2 if boolean(&mut e, wire)? => {
                            return Err(DecodeError(
                                "FeedEntity.is_deleted requires unsupported DIFFERENTIAL updates; use CANCELED or DELETED trips in a FULL_DATASET feed".into(),
                            ));
                        }
                        3..=5 => parts.push((field, message(&mut e, wire)?)),
                        _ => e.skip(wire)?,
                    }
                }
                // The entity id may follow its payload on the wire.
                let mut classified = false;
                for (field, payload) in parts {
                    classified = true;
                    match field {
                        3 => feed.trip_updates.push(trip_update(
                            payload,
                            id.clone(),
                            &mut stop_updates,
                        )?),
                        4 => feed.vehicle_positions += 1,
                        _ => feed.alerts.push(alert(payload, id.clone())?),
                    }
                }
                feed.other_entities += usize::from(!classified);
            }
            _ => r.skip(wire)?,
        }
    }
    if !has_header || feed.header.version.is_empty() {
        return Err(malformed(
            "missing required FeedHeader.gtfs_realtime_version",
        ));
    }
    if feed.header.incrementality.is_some_and(|value| value != 0) {
        return Err(DecodeError(
            "DIFFERENTIAL incrementality is unsupported; configure a FULL_DATASET feed".into(),
        ));
    }
    Ok(feed)
}

fn trip_relationship(value: u64) -> &'static str {
    match value {
        0 => "SCHEDULED",
        1 => "ADDED",
        2 => "UNSCHEDULED",
        3 => "CANCELED",
        5 => "REPLACEMENT",
        6 => "DUPLICATED",
        7 => "DELETED",
        8 => "NEW",
        _ => "UNKNOWN",
    }
}
fn stop_relationship(value: u64) -> &'static str {
    match value {
        0 => "SCHEDULED",
        1 => "SKIPPED",
        2 => "NO_DATA",
        3 => "UNSCHEDULED",
        _ => "UNKNOWN",
    }
}
fn cause(value: u64) -> &'static str {
    match value {
        1 => "UNKNOWN_CAUSE",
        2 => "OTHER_CAUSE",
        3 => "TECHNICAL_PROBLEM",
        4 => "STRIKE",
        5 => "DEMONSTRATION",
        6 => "ACCIDENT",
        7 => "HOLIDAY",
        8 => "WEATHER",
        9 => "MAINTENANCE",
        10 => "CONSTRUCTION",
        11 => "POLICE_ACTIVITY",
        12 => "MEDICAL_EMERGENCY",
        _ => "UNKNOWN",
    }
}
pub fn effect_label(value: u64) -> &'static str {
    match value {
        1 => "NO_SERVICE",
        2 => "REDUCED_SERVICE",
        3 => "SIGNIFICANT_DELAYS",
        4 => "DETOUR",
        5 => "ADDITIONAL_SERVICE",
        6 => "MODIFIED_SERVICE",
        7 => "OTHER_EFFECT",
        8 => "UNKNOWN_EFFECT",
        9 => "STOP_MOVED",
        10 => "NO_EFFECT",
        11 => "ACCESSIBILITY_ISSUE",
        _ => "UNKNOWN",
    }
}
fn severity(value: u64) -> &'static str {
    match value {
        1 => "UNKNOWN_SEVERITY",
        2 => "INFO",
        3 => "WARNING",
        4 => "SEVERE",
        _ => "UNKNOWN",
    }
}

// Studio's records omit absent and empty values; these match them.
fn put(object: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    if let Some(value) = value.filter(|v| !v.is_null() && v.as_str() != Some("")) {
        object.insert(key.into(), value);
    }
}
fn trip_fields(object: &mut Map<String, Value>, trip: Option<&TripDescriptor>) {
    let Some(t) = trip else { return };
    put(object, "routeId", t.route_id.clone().map(Value::from));
    put(object, "directionId", t.direction_id.map(Value::from));
    put(object, "tripId", t.trip_id.clone().map(Value::from));
    put(object, "startDate", t.start_date.clone().map(Value::from));
    put(object, "startTime", t.start_time.clone().map(Value::from));
    put(
        object,
        "scheduleRelationship",
        t.schedule_relationship.map(|v| trip_relationship(v).into()),
    );
}
fn event_record(event: &StopTimeEvent) -> Value {
    let mut object = Map::new();
    put(&mut object, "delay", event.delay.map(Value::from));
    put(&mut object, "time", event.time.map(Value::from));
    put(
        &mut object,
        "uncertainty",
        event.uncertainty.map(Value::from),
    );
    put(
        &mut object,
        "scheduledTime",
        event.scheduled_time.map(Value::from),
    );
    Value::Object(object)
}

impl TripUpdate {
    /// The routing record of this update, in the shape inline snapshots use.
    pub fn record(&self) -> Value {
        let mut object = Map::new();
        put(&mut object, "id", Some(self.entity_id.clone().into()));
        trip_fields(&mut object, self.trip.as_ref());
        put(
            &mut object,
            "vehicleId",
            self.vehicle_id.clone().map(Value::from),
        );
        put(
            &mut object,
            "vehicleLabel",
            self.vehicle_label.clone().map(Value::from),
        );
        put(&mut object, "timestamp", self.timestamp.map(Value::from));
        put(&mut object, "delaySeconds", self.delay.map(Value::from));
        let updates = self
            .stop_time_updates
            .iter()
            .map(|u| {
                let mut stop = Map::new();
                put(
                    &mut stop,
                    "stopTimeProperties",
                    u.stop_time_properties.clone(),
                );
                put(&mut stop, "stopSequence", u.stop_sequence.map(Value::from));
                put(&mut stop, "stopId", u.stop_id.clone().map(Value::from));
                put(
                    &mut stop,
                    "scheduleRelationship",
                    u.schedule_relationship.map(|v| stop_relationship(v).into()),
                );
                put(&mut stop, "arrival", u.arrival.as_ref().map(event_record));
                put(
                    &mut stop,
                    "departure",
                    u.departure.as_ref().map(event_record),
                );
                Value::Object(stop)
            })
            .collect();
        object.insert("stopTimeUpdates".into(), Value::Array(updates));
        Value::Object(object)
    }
}

impl Alert {
    pub fn record(&self) -> Value {
        let mut object = Map::new();
        put(&mut object, "id", Some(self.entity_id.clone().into()));
        put(&mut object, "cause", self.cause.map(|v| cause(v).into()));
        put(
            &mut object,
            "effect",
            self.effect.map(|v| effect_label(v).into()),
        );
        put(
            &mut object,
            "severity",
            self.severity.map(|v| severity(v).into()),
        );
        put(&mut object, "header", self.header.clone().map(Value::from));
        put(
            &mut object,
            "description",
            self.description.clone().map(Value::from),
        );
        put(&mut object, "url", self.url.clone().map(Value::from));
        let entities = self
            .informed_entities
            .iter()
            .map(|s| {
                let mut entity = Map::new();
                put(
                    &mut entity,
                    "agencyId",
                    s.agency_id.clone().map(Value::from),
                );
                put(&mut entity, "routeId", s.route_id.clone().map(Value::from));
                put(&mut entity, "routeType", s.route_type.map(Value::from));
                put(&mut entity, "stopId", s.stop_id.clone().map(Value::from));
                put(&mut entity, "directionId", s.direction_id.map(Value::from));
                if s.trip.is_some() {
                    let mut trip = Map::new();
                    trip_fields(&mut trip, s.trip.as_ref());
                    entity.insert("trip".into(), Value::Object(trip));
                }
                Value::Object(entity)
            })
            .collect();
        object.insert("informedEntities".into(), Value::Array(entities));
        let periods = self
            .active_periods
            .iter()
            .map(|(start, end)| {
                let mut period = Map::new();
                put(&mut period, "start", start.map(Value::from));
                put(&mut period, "end", end.map(Value::from));
                Value::Object(period)
            })
            .collect();
        object.insert("activePeriods".into(), Value::Array(periods));
        Value::Object(object)
    }
}

impl Feed {
    pub fn counts(&self) -> Value {
        json!({"tripUpdates":self.trip_updates.len(),"alerts":self.alerts.len(),
            "vehicles":self.vehicle_positions,"other":self.other_entities})
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // A minimal protobuf writer for test feeds.
    #[derive(Default)]
    struct W(Vec<u8>);
    impl W {
        fn varint(&mut self, mut v: u64) -> &mut Self {
            loop {
                let byte = (v & 0x7f) as u8;
                v >>= 7;
                if v == 0 {
                    self.0.push(byte);
                    return self;
                }
                self.0.push(byte | 0x80);
            }
        }
        fn key(&mut self, field: u64, wire: u8) -> &mut Self {
            self.varint(field << 3 | u64::from(wire))
        }
        fn uint(&mut self, field: u64, v: u64) -> &mut Self {
            self.key(field, VARINT).varint(v)
        }
        fn int(&mut self, field: u64, v: i64) -> &mut Self {
            self.uint(field, v as u64)
        }
        fn bytes(&mut self, field: u64, v: &[u8]) -> &mut Self {
            self.key(field, LENGTH).varint(v.len() as u64);
            self.0.extend_from_slice(v);
            self
        }
        fn str(&mut self, field: u64, v: &str) -> &mut Self {
            self.bytes(field, v.as_bytes())
        }
        fn msg(&mut self, field: u64, build: impl FnOnce(&mut W)) -> &mut Self {
            let mut inner = W::default();
            build(&mut inner);
            self.bytes(field, &inner.0)
        }
    }
    fn header(w: &mut W) {
        w.msg(1, |h| {
            h.str(1, "2.0").uint(2, 0).uint(3, 1_760_000_000);
        });
    }

    #[test]
    fn preserves_stop_permissions_from_protobuf_to_runtime_record() {
        let mut w = W::default();
        w.uint(1, 1).str(4, "S").msg(6, |p| {
            p.str(1, "S").str(2, "Destination").uint(3, 1).uint(4, 2);
        });
        let stop = stop_time_update(Reader::new(&w.0)).unwrap();
        let update = TripUpdate {
            stop_time_updates: vec![stop],
            ..TripUpdate::default()
        };
        assert_eq!(
            update.record()["stopTimeUpdates"][0]["stopTimeProperties"],
            json!({"assignedStopId":"S","stopHeadsign":"Destination","pickupType":1,"dropOffType":2})
        );
    }

    #[test]
    fn decodes_trip_updates_alerts_and_negative_delays() {
        let mut w = W::default();
        header(&mut w);
        w.msg(2, |e| {
            // Payload before the id; an unknown field in between is skipped.
            e.msg(3, |t| {
                t.msg(1, |d| {
                    d.str(1, "T1")
                        .str(3, "20261021")
                        .uint(4, 0)
                        .str(5, "Red")
                        .uint(6, 1);
                })
                .msg(2, |s| {
                    s.uint(1, 4).str(4, "S4").msg(2, |a| {
                        a.int(1, -90).int(2, 1_760_000_100);
                    });
                })
                .msg(2, |s| {
                    s.uint(1, 5).uint(5, 1);
                })
                .uint(4, 1_759_999_990)
                .int(5, -30);
            })
            .bytes(99, b"future field")
            .str(1, "entity-1");
        });
        w.msg(2, |e| {
            e.str(1, "alert-1").msg(5, |a| {
                a.msg(1, |p| {
                    p.uint(1, 100).uint(2, 200);
                })
                .msg(5, |s| {
                    s.str(5, "place-pktrm");
                })
                .uint(7, 1)
                .msg(10, |t| {
                    t.msg(1, |x| {
                        x.str(1, "Fermée").str(2, "fr");
                    })
                    .msg(1, |x| {
                        x.str(1, "Closed").str(2, "en");
                    });
                });
            });
        });
        w.msg(2, |e| {
            e.str(1, "vehicle").msg(4, |_| {});
        });
        let feed = decode(&w.0).unwrap();
        assert_eq!(feed.header.timestamp, Some(1_760_000_000));
        assert_eq!(feed.vehicle_positions, 1);
        let record = feed.trip_updates[0].record();
        assert_eq!(
            record,
            json!({"id":"entity-1","routeId":"Red","directionId":1,"tripId":"T1","startDate":"20261021",
                "scheduleRelationship":"SCHEDULED","timestamp":1_759_999_990_u64,"delaySeconds":-30,
                "stopTimeUpdates":[{"stopSequence":4,"stopId":"S4","arrival":{"delay":-90,"time":1_760_000_100_i64}},
                    {"stopSequence":5,"scheduleRelationship":"SKIPPED"}]})
        );
        let alert = feed.alerts[0].record();
        assert_eq!(alert["effect"], "NO_SERVICE");
        assert_eq!(alert["header"], "Closed");
        assert_eq!(alert["informedEntities"], json!([{"stopId":"place-pktrm"}]));
        assert_eq!(alert["activePeriods"], json!([{"start":100,"end":200}]));
    }

    #[test]
    fn rejects_partial_or_unsupported_feeds() {
        let reject = |bytes: &[u8]| decode(bytes).unwrap_err().to_string();
        assert!(reject(&[]).contains("gtfs_realtime_version"));
        let mut differential = W::default();
        differential.msg(1, |h| {
            h.str(1, "2.0").uint(2, 1);
        });
        assert!(reject(&differential.0).contains("DIFFERENTIAL"));
        let mut deleted = W::default();
        header(&mut deleted);
        deleted.msg(2, |e| {
            e.str(1, "x").uint(2, 1);
        });
        assert!(reject(&deleted.0).contains("is_deleted"));
        // A string where a varint belongs is not silently reinterpreted.
        let mut wrong = W::default();
        header(&mut wrong);
        wrong.msg(2, |e| {
            e.msg(3, |t| {
                t.str(4, "not a timestamp");
            });
        });
        assert!(reject(&wrong.0).contains("wire type"));
        let mut truncated = W::default();
        header(&mut truncated);
        truncated.msg(2, |e| {
            e.msg(3, |t| {
                t.msg(1, |d| {
                    d.str(1, "T1");
                });
            });
        });
        let cut = &truncated.0[..truncated.0.len() - 2];
        assert!(reject(cut).contains("truncated"));
        assert!(reject(&[0x80; 11]).contains("varint"));
    }

    #[test]
    fn bounds_entities_and_stop_predictions() {
        let mut w = W::default();
        header(&mut w);
        for _ in 0..=MAXIMUM_ENTITIES {
            w.msg(2, |e| {
                e.str(1, "x");
            });
        }
        assert!(decode(&w.0).unwrap_err().to_string().contains("entities"));
        let mut w = W::default();
        header(&mut w);
        w.msg(2, |e| {
            e.msg(3, |t| {
                for _ in 0..=MAXIMUM_STOP_TIME_UPDATES {
                    t.msg(2, |s| {
                        s.uint(1, 1);
                    });
                }
            });
        });
        assert!(
            decode(&w.0)
                .unwrap_err()
                .to_string()
                .contains("stop predictions")
        );
    }
}
