//! Node-API adapter over the shared GTFS-Realtime overlays. Studio's resident
//! timetable lives in JavaScript typed arrays: a schedule retains them without
//! copying, and each snapshot compiles one immutable view of it.
use crate::realtime::{self, Clock, Input, Outcome, TimetableNames, alerts::Alerts};
use chrono::NaiveDate;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::Arc;
use vigo_route::types::{Buffer, U8Buffer, U32Buffer};

fn invalid(error: impl std::fmt::Display) -> napi::Error {
    napi::Error::new(napi::Status::InvalidArg, error.to_string())
}

#[napi(object)]
pub struct RealtimeScheduleInput {
    pub stop_ids: Vec<String>,
    pub trip_ids: Vec<String>,
    pub route_ids: Vec<String>,
    pub direction_ids: Vec<String>,
    /// Service dates of dated trip instances, one per trip, or none.
    pub trip_service_dates: Option<Vec<String>>,
    pub departure_seconds: Uint32Array,
    pub arrival_seconds: Uint32Array,
    pub from_stop: Uint32Array,
    pub to_stop: Uint32Array,
    pub sequence: Uint32Array,
    pub segment_run: Uint32Array,
    pub continuity_break: Uint8Array,
    pub can_board: Uint8Array,
    pub can_alight: Uint8Array,
    pub trip_start: Uint32Array,
    /// Each stop's parent station index, or 4294967295 for none.
    pub stop_parents: Uint32Array,
    /// Route types by route identifier, for alerts that select one.
    pub route_types: HashMap<String, i64>,
}

#[napi(object)]
pub struct RealtimeOverlayOptions {
    pub service_date: String,
    /// The service date of updates without one, when it differs.
    pub start_date: Option<String>,
    /// The City clock's IANA zone, unless the snapshot names one.
    pub timezone: Option<String>,
    /// The observation time in POSIX seconds.
    pub now_seconds: f64,
}

#[napi(object)]
pub struct RealtimeOverlayCounts {
    pub feed_updates: u32,
    pub applied: u32,
    pub canceled: u32,
    pub stale: u32,
    pub date_mismatches: u32,
    pub unmatched: u32,
    pub duplicate: u32,
    pub invalid: u32,
    pub unsupported: u32,
    pub past_prefix_trips: u32,
    pub omitted_past_prefix_stops: u32,
}

const RETAINED_CLOCKS: usize = 8;

/// One resident timetable that snapshots are applied to.
#[napi]
pub struct RealtimeSchedule {
    stop_count: u32,
    departure_seconds: U32Buffer,
    arrival_seconds: U32Buffer,
    from_stop: U32Buffer,
    to_stop: U32Buffer,
    sequence: U32Buffer,
    segment_run: U32Buffer,
    continuity_break: U8Buffer,
    can_board: U8Buffer,
    can_alight: U8Buffer,
    trip_start: U32Buffer,
    names: TimetableNames,
    parents: U32Buffer,
    route_types: Arc<HashMap<String, i64>>,
    /// Record clocks of recent snapshots by content digest, newest last, so
    /// that a resubmitted snapshot is identified without parsing it.
    clocks: Vec<(String, Value)>,
    /// The snapshot that identification parsed last, for the `apply` after it.
    parsed: Option<(String, Value)>,
}

#[napi]
impl RealtimeSchedule {
    #[napi(constructor)]
    pub fn new(input: RealtimeScheduleInput) -> Result<Self> {
        let trips = input.trip_ids.len();
        let segments = input.departure_seconds.len();
        let stops = input.stop_ids.len();
        let dates = input.trip_service_dates.unwrap_or_else(|| vec![String::new(); trips]);
        let trip_start: &[u32] = &input.trip_start;
        // The overlay reads trips and stops by index; reject inconsistent tables.
        if [input.route_ids.len(), input.direction_ids.len(), dates.len()]
            .iter()
            .any(|&n| n != trips)
            || trip_start.len() != trips + 1
            || trip_start.first() != Some(&0)
            || trip_start.last().map(|&n| n as usize) != Some(segments)
            || trip_start.windows(2).any(|p| p[0] > p[1])
            || [&input.arrival_seconds, &input.from_stop, &input.to_stop, &input.sequence, &input.segment_run]
                .iter()
                .any(|a| a.len() != segments)
            || [&input.continuity_break, &input.can_board, &input.can_alight]
                .iter()
                .any(|a| a.len() != segments)
            || input.from_stop.iter().chain(input.to_stop.iter()).any(|&s| s as usize >= stops)
            || input.stop_parents.len() != stops
            || stops > u32::MAX as usize
        {
            return Err(invalid("Inconsistent realtime schedule arrays"));
        }
        Ok(Self {
            stop_count: stops as u32,
            departure_seconds: Buffer::from_owner(input.departure_seconds),
            arrival_seconds: Buffer::from_owner(input.arrival_seconds),
            from_stop: Buffer::from_owner(input.from_stop),
            to_stop: Buffer::from_owner(input.to_stop),
            sequence: Buffer::from_owner(input.sequence),
            segment_run: Buffer::from_owner(input.segment_run),
            continuity_break: Buffer::from_owner(input.continuity_break),
            can_board: Buffer::from_owner(input.can_board),
            can_alight: Buffer::from_owner(input.can_alight),
            trip_start: Buffer::from_owner(input.trip_start),
            names: TimetableNames::new(
                input.stop_ids.into(),
                input.trip_ids.into(),
                input.route_ids.into(),
                input.direction_ids.into(),
                dates.into(),
            ),
            parents: Buffer::from_owner(input.stop_parents),
            route_types: Arc::new(input.route_types),
            clocks: vec![],
            parsed: None,
        })
    }

    /// The identity of the view that `snapshot` (JSON) yields under `options`:
    /// its content, each record's validity at the observation time, and the
    /// clock it is read on. Equal keys yield identical views of this schedule.
    #[napi]
    pub fn view_key(&mut self, snapshot: String, options: RealtimeOverlayOptions) -> Result<String> {
        Ok(self.identify(&snapshot, &options)?.0)
    }

    /// Compiles the realtime view of this schedule for `snapshot` (JSON).
    #[napi]
    pub fn apply(
        &mut self,
        snapshot: String,
        options: RealtimeOverlayOptions,
    ) -> Result<RealtimeOverlay> {
        let (key, digest) = self.identify(&snapshot, &options)?;
        let value = match self.parsed.take() {
            Some((parsed, value)) if parsed == digest => value,
            _ => serde_json::from_str(&snapshot).map_err(invalid)?,
        };
        drop(snapshot);
        let clock = Clock {
            date: NaiveDate::parse_from_str(&options.service_date, "%Y-%m-%d").map_err(invalid)?,
            zone: options
                .timezone
                .as_deref()
                .map(str::parse)
                .transpose()
                .map_err(invalid)?,
        };
        let input = Input {
            snapshot: &value,
            start_date: options.start_date.as_deref(),
        };
        let now = options.now_seconds;
        let overlay = realtime::apply(&self.schedule(), &input, clock, now).map_err(invalid)?;
        let mut view = overlay.view;
        let mut diagnostics = json!({});
        let alerts = realtime::apply_alerts(
            &mut view,
            &self.names,
            &value,
            clock,
            now,
            &self.parents,
            self.route_types.clone(),
            &mut diagnostics,
        )
        .map_err(invalid)?;
        let alert_diagnostics = diagnostics.get("alerts");
        let closed = alert_diagnostics.map_or(0, |a| {
            a["closedBoardings"].as_u64().unwrap_or(0) + a["closedAlightings"].as_u64().unwrap_or(0)
        });
        // An overlay that changes no service reuses the scheduled timetable.
        let changed = closed > 0
            || overlay
                .outcomes
                .iter()
                .any(|o| matches!(o, Outcome::Applied { .. } | Outcome::Canceled { .. }));
        let view = if changed {
            // Index the final view: alerts may have closed boardings.
            let (offset, order) = vigo_route::timetable::departure_index(
                self.stop_count as usize,
                &view.from_stop,
                &view.departure_seconds,
                &view.can_board,
            )
            .map_err(invalid)?;
            view.departure_offset = offset.into();
            view.departure_order = order.into();
            Some(view)
        } else {
            None
        };
        Ok(RealtimeOverlay {
            key,
            alert_diagnostics: alert_diagnostics.map(Value::to_string),
            view,
            outcomes: overlay.outcomes,
            alerts,
        })
    }
}

impl RealtimeSchedule {
    fn schedule(&self) -> realtime::Schedule<'_> {
        realtime::Schedule {
            stop_count: self.stop_count,
            departure_seconds: &self.departure_seconds,
            arrival_seconds: &self.arrival_seconds,
            from_stop: &self.from_stop,
            to_stop: &self.to_stop,
            sequence: &self.sequence,
            segment_run: &self.segment_run,
            continuity_break: &self.continuity_break,
            can_board: &self.can_board,
            can_alight: &self.can_alight,
            trip_start: &self.trip_start,
            names: &self.names,
        }
    }
    /// The view key and content digest of `snapshot`.
    fn identify(&mut self, snapshot: &str, options: &RealtimeOverlayOptions) -> Result<(String, String)> {
        let digest = format!("{:x}", Sha256::digest(snapshot.as_bytes()));
        self.parsed = self.parsed.take().filter(|(parsed, _)| *parsed == digest);
        match self.clocks.iter().position(|(retained, _)| *retained == digest) {
            Some(index) => {
                let entry = self.clocks.remove(index);
                self.clocks.push(entry);
            }
            None => {
                let value: Value = serde_json::from_str(snapshot).map_err(invalid)?;
                if self.clocks.len() == RETAINED_CLOCKS {
                    self.clocks.remove(0);
                }
                self.clocks.push((digest.clone(), realtime::clocks(&value)));
                self.parsed = Some((digest.clone(), value));
            }
        }
        let clocks = &self.clocks.last().unwrap().1;
        let validity = realtime::validity(clocks, options.now_seconds);
        let context = serde_json::to_vec(&(
            validity,
            &options.service_date,
            &options.start_date,
            &options.timezone,
        ))
        .map_err(invalid)?;
        Ok((format!("{digest}:{:x}", Sha256::digest(context)), digest))
    }
}

/// One snapshot applied to one schedule.
#[napi]
pub struct RealtimeOverlay {
    key: String,
    view: Option<vigo_route::timetable::RealtimeTimetableResult>,
    outcomes: Vec<Outcome>,
    alerts: Option<Alerts>,
    alert_diagnostics: Option<String>,
}

#[napi]
impl RealtimeOverlay {
    #[napi(getter)]
    pub fn key(&self) -> String {
        self.key.clone()
    }
    #[napi(getter)]
    pub fn counts(&self) -> RealtimeOverlayCounts {
        let c = realtime::Counts::of(&self.outcomes);
        let n = |value: u64| value as u32;
        RealtimeOverlayCounts {
            feed_updates: n(c.feed_updates),
            applied: n(c.applied),
            canceled: n(c.canceled),
            stale: n(c.stale),
            date_mismatches: n(c.date_mismatches),
            unmatched: n(c.unmatched),
            duplicate: n(c.duplicate),
            invalid: n(c.invalid),
            unsupported: n(c.unsupported),
            past_prefix_trips: n(c.past_prefix_trips),
            omitted_past_prefix_stops: n(c.omitted_past_prefix_stops),
        }
    }
    /// Applied and canceled updates in feed order, as alternating update and
    /// trip indexes.
    #[napi(getter)]
    pub fn applied(&self) -> Vec<u32> {
        let mut pairs = vec![];
        for (update, outcome) in self.outcomes.iter().enumerate() {
            if let Outcome::Applied { trip, .. } | Outcome::Canceled { trip } = *outcome {
                pairs.extend([update as u32, trip]);
            }
        }
        pairs
    }
    /// The Service Alerts diagnostics as JSON, when the snapshot has alerts.
    #[napi(getter)]
    pub fn alert_diagnostics(&self) -> Option<String> {
        self.alert_diagnostics.clone()
    }
    /// Whether any fresh alert may describe a ride.
    #[napi(getter)]
    pub fn has_alerts(&self) -> bool {
        self.alerts.is_some()
    }
    /// Moves the compiled view to JavaScript. There is none when the snapshot
    /// changes no service; the scheduled timetable then stands.
    #[napi]
    pub fn take_view(&mut self) -> Option<crate::RealtimeTimetableResult> {
        self.view.take().map(Into::into)
    }
    /// The fresh alerts, as JSON, active during a ride on `trip` that describe
    /// its trip, its route or a stop it calls at.
    #[napi]
    pub fn alerts_for_ride(
        &self,
        trip: u32,
        stops: Vec<u32>,
        departure: f64,
        arrival: f64,
    ) -> Option<String> {
        let ride = self.alerts.as_ref()?.for_ride(trip, &stops, departure, arrival);
        (!ride.is_empty()).then(|| Value::Array(ride).to_string())
    }
}
