//! GTFS-Realtime overlays (RFC 0002), shared by the standalone runtime and the
//! Node addon. A snapshot never edits the schedule it describes: each overlay
//! compiles a new view from the retained schedule arrays, so every later
//! snapshot reuses the same resident source. Predictions replace the calls of
//! their trips and cancellations remove trips; [`alerts`] closes service.
//! Views keep the original trip indices and so share the schedule's names.
pub(crate) mod alerts;

use chrono::{NaiveDate, TimeZone};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, OnceLock};
use vigo_route::timetable::{
    RealtimeCallInput, RealtimeTimetableResult, RealtimeTimetableView, RealtimeTripInput,
    compile_realtime_timetable_view,
};

pub(crate) type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
fn fail<T>(message: impl Into<String>) -> Result<T> {
    Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, message.into()).into())
}

/// GTFS service time starts twelve elapsed hours before local noon, even on DST days.
pub(crate) fn service_epoch(zone: chrono_tz::Tz, day: NaiveDate) -> Result<i64> {
    Ok(zone
        .from_local_datetime(&day.and_hms_opt(12, 0, 0).unwrap())
        .single()
        .ok_or("Service date has no unambiguous local noon")?
        .timestamp()
        - 43_200)
}

/// The service date a query reads a snapshot against and, when one is known,
/// the City clock's zone. Absolute event times need the zone.
#[derive(Clone, Copy)]
pub(crate) struct Clock {
    pub date: NaiveDate,
    pub zone: Option<chrono_tz::Tz>,
}

/// Feed trip identifiers resolved against one schedule source. Both orders
/// index the shared trip table, so building it copies no identifiers.
pub(crate) struct TripIndex {
    exact: Vec<u32>,
    local: Vec<u32>,
    // Distinct dated service instances; most views hold only a few.
    instance_dates: Vec<NaiveDate>,
}
fn local_id(id: &str) -> &str {
    id.rsplit('\u{1f}').next().unwrap()
}
/// Feed records name local identifiers; a scoped identifier must match exactly.
fn same_id(supplied: &str, actual: &str) -> bool {
    if supplied.contains('\u{1f}') {
        supplied == actual
    } else {
        local_id(actual) == supplied
    }
}
impl TripIndex {
    fn new(trip_ids: &[String], trip_service_dates: &[String]) -> Self {
        let mut exact: Vec<u32> = (0..trip_ids.len() as u32).collect();
        exact.sort_unstable_by(|&a, &b| {
            trip_ids[a as usize]
                .cmp(&trip_ids[b as usize])
                .then(a.cmp(&b))
        });
        // Stable: equal local identifiers keep ascending trip order.
        let mut local = exact.clone();
        local
            .sort_by(|&a, &b| local_id(&trip_ids[a as usize]).cmp(local_id(&trip_ids[b as usize])));
        let instance_dates = trip_service_dates
            .iter()
            .collect::<HashSet<_>>()
            .into_iter()
            .filter_map(|text| NaiveDate::parse_from_str(text, "%Y-%m-%d").ok())
            .collect();
        Self {
            exact,
            local,
            instance_dates,
        }
    }
    pub(crate) fn matches<'a>(
        &'a self,
        trip_ids: &'a [String],
        id: &'a str,
    ) -> impl Iterator<Item = usize> + 'a {
        let (order, key): (&[u32], fn(&str) -> &str) = if id.contains('\u{1f}') {
            (&self.exact, |s| s)
        } else {
            (&self.local, local_id)
        };
        let start = order.partition_point(|&i| key(&trip_ids[i as usize]) < id);
        order[start..]
            .iter()
            .take_while(move |&&i| key(&trip_ids[i as usize]) == id)
            .map(|&i| i as usize)
    }
}

/// String tables of one service-day view. Realtime views keep the original
/// trip indices, so every view derived from one source shares these tables.
#[derive(Clone)]
pub(crate) struct TimetableNames {
    pub stop_ids: Arc<[String]>,
    pub trip_ids: Arc<[String]>,
    pub route_ids: Arc<[String]>,
    pub direction_ids: Arc<[String]>,
    pub trip_service_dates: Arc<[String]>,
    trip_index: Arc<OnceLock<TripIndex>>,
    route_trips: Arc<OnceLock<HashMap<String, Vec<u32>>>>,
}
impl TimetableNames {
    pub fn new(
        stop_ids: Arc<[String]>,
        trip_ids: Arc<[String]>,
        route_ids: Arc<[String]>,
        direction_ids: Arc<[String]>,
        trip_service_dates: Arc<[String]>,
    ) -> Self {
        Self {
            stop_ids,
            trip_ids,
            route_ids,
            direction_ids,
            trip_service_dates,
            trip_index: Arc::default(),
            route_trips: Arc::default(),
        }
    }
    pub fn trip_index(&self) -> &TripIndex {
        self.trip_index
            .get_or_init(|| TripIndex::new(&self.trip_ids, &self.trip_service_dates))
    }
    /// Trips by local route identifier, for alerts that select a route.
    pub fn route_trips(&self) -> &HashMap<String, Vec<u32>> {
        self.route_trips.get_or_init(|| {
            let mut routes: HashMap<String, Vec<u32>> = HashMap::new();
            for (trip, route) in self.route_ids.iter().enumerate() {
                routes
                    .entry(local_id(route).to_owned())
                    .or_default()
                    .push(trip as u32);
            }
            routes
        })
    }
}

/// Borrowed scheduled segments of one service-day view, trip by trip.
pub(crate) struct Schedule<'a> {
    pub stop_count: u32,
    pub departure_seconds: &'a [u32],
    pub arrival_seconds: &'a [u32],
    pub from_stop: &'a [u32],
    pub to_stop: &'a [u32],
    pub sequence: &'a [u32],
    pub segment_run: &'a [u32],
    pub continuity_break: &'a [u8],
    pub can_board: &'a [u8],
    pub can_alight: &'a [u8],
    pub trip_start: &'a [u32],
    pub names: &'a TimetableNames,
}

/// The realtime input of one query.
pub(crate) struct Input<'a> {
    pub snapshot: &'a Value,
    /// The service date of updates without a startDate. An early arrive-by
    /// search runs on the preceding date, yet its updates still describe the
    /// requested one.
    pub start_date: Option<&'a str>,
}

/// What became of one trip update.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Outcome {
    /// The feed or record clock is missing, invalid or stale.
    Stale,
    /// The update's start date is not a service day of the view.
    DateMismatch,
    /// No single trip of the view has the update's identity.
    Unmatched,
    /// Another fresh update names the same trip.
    Duplicate,
    Invalid,
    /// A valid record of a relationship routing does not model, such as ADDED.
    Unsupported,
    Canceled { trip: u32 },
    /// Predictions replace the trip's calls; `omitted` past calls had unknown
    /// actual times before an early first prediction.
    Applied { trip: u32, omitted: u32 },
}

/// One snapshot compiled against one schedule. Callers that prepare their own
/// stop indexes receive a view without a departure index.
pub(crate) struct Overlay {
    pub view: RealtimeTimetableResult,
    /// One outcome per trip update, in feed order.
    pub outcomes: Vec<Outcome>,
}

/// A summary of trip update outcomes.
#[derive(Clone, Copy, Default)]
pub(crate) struct Counts {
    pub feed_updates: u64,
    pub applied: u64,
    pub canceled: u64,
    pub stale: u64,
    pub date_mismatches: u64,
    pub unmatched: u64,
    pub duplicate: u64,
    pub invalid: u64,
    pub unsupported: u64,
    pub past_prefix_trips: u64,
    pub omitted_past_prefix_stops: u64,
}
impl Counts {
    pub(crate) fn of(outcomes: &[Outcome]) -> Self {
        let mut counts = Counts {
            feed_updates: outcomes.len() as u64,
            ..Counts::default()
        };
        for outcome in outcomes {
            match *outcome {
                Outcome::Stale => counts.stale += 1,
                Outcome::DateMismatch => counts.date_mismatches += 1,
                Outcome::Unmatched => counts.unmatched += 1,
                Outcome::Duplicate => counts.duplicate += 1,
                Outcome::Invalid => counts.invalid += 1,
                Outcome::Unsupported => counts.unsupported += 1,
                Outcome::Canceled { .. } => counts.canceled += 1,
                Outcome::Applied { omitted, .. } => {
                    counts.applied += 1;
                    if omitted > 0 {
                        counts.past_prefix_trips += 1;
                        counts.omitted_past_prefix_stops += u64::from(omitted);
                    }
                }
            }
        }
        counts
    }
}

/// Why one trip update was not applied.
#[derive(Debug, PartialEq)]
enum Rejection {
    Invalid,
    Unsupported,
}
use Rejection::{Invalid, Unsupported};

/// Packed native event times are 20-bit service seconds.
const MAXIMUM_TIME: f64 = 1_048_575.;

/// Compiles the realtime view of `schedule`. The schedule stays unchanged, so
/// every later snapshot reuses the same resident source.
pub(crate) fn apply(schedule: &Schedule, input: &Input, clock: Clock, now: f64) -> Result<Overlay> {
    let snapshot = input.snapshot;
    let start_date = input.start_date;
    let names = schedule.names;
    if !snapshot.is_object() {
        return fail("realtimeSnapshot must be an object");
    }
    if snapshot
        .get("incrementality")
        .is_some_and(|v| v != "FULL_DATASET" && v != 0)
    {
        return fail("Realtime requires a FULL_DATASET snapshot");
    }
    let updates = snapshot["tripUpdates"]
        .as_array()
        .ok_or("realtimeSnapshot.tripUpdates must be an array")?;
    if updates.len() > 100_000 {
        return fail("Realtime snapshot exceeds 100000 updates");
    }
    let date = clock.date;
    // Resolved once: every absolute event time is read on this origin.
    let origin = clock.zone.and_then(|zone| service_epoch(zone, date).ok());
    let service_seconds = |epoch: i64| origin.map(|origin| (epoch - origin) as f64);
    let trips = names.trip_index();
    let mut canceled = vec![0; names.trip_ids.len()];
    let mut replacements = vec![];
    let mut seen = HashSet::new();
    let resolve = |update: &Value| -> Option<usize> {
        let id = update["tripId"]
            .as_str()
            .or_else(|| update["trip"]["tripId"].as_str())?;
        let matches: Vec<_> = trips
            .matches(&names.trip_ids, id)
            .filter(|&i| {
                let instance_date = names
                    .trip_service_dates
                    .get(i)
                    .filter(|s| !s.is_empty())
                    .and_then(|s| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok())
                    .unwrap_or(date);
                (if supplied_start(update).is_some() || start_date.is_some() {
                    date_matches(update, &instance_date, start_date)
                } else {
                    instance_date == date
                }) && update["sourceScope"]
                    .as_str()
                    .is_none_or(|scope| names.trip_ids[i].split('\u{1f}').next() == Some(scope))
            })
            .collect();
        (matches.len() == 1).then(|| matches[0])
    };
    let mut identities = HashMap::new();
    for update in updates {
        if record_fresh(snapshot, update, now)
            && let Some(trip) = resolve(update)
        {
            *identities.entry(trip).or_insert(0) += 1;
        }
    }
    let mut total = 0;
    let mut outcome = |update: &Value| -> Outcome {
        if !record_fresh(snapshot, update, now) {
            return Outcome::Stale;
        }
        if !date_matches(update, &date, start_date)
            && !trips
                .instance_dates
                .iter()
                .any(|day| date_matches(update, day, start_date))
        {
            return Outcome::DateMismatch;
        }
        let Some(trip) = resolve(update) else {
            return Outcome::Unmatched;
        };
        if identities.get(&trip).copied().unwrap_or(0) > 1 || !seen.insert(trip) {
            return Outcome::Duplicate;
        }
        let matches_id = |supplied: &Value, actual: &str| {
            supplied.is_null() || supplied.as_str().is_some_and(|id| same_id(id, actual))
        };
        if !matches_id(&update["routeId"], &names.route_ids[trip])
            || update.get("directionId").is_some_and(|id| {
                id.as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| id.to_string())
                    != names.direction_ids[trip]
            })
        {
            return Outcome::Invalid;
        }
        let relationship = update.get("scheduleRelationship").or_else(|| {
            update
                .get("trip")
                .and_then(|v| v.get("scheduleRelationship"))
        });
        if relationship.is_some_and(|v| v == "CANCELED" || v == "DELETED" || v == 3 || v == 7) {
            canceled[trip] = 1;
            return Outcome::Canceled { trip: trip as u32 };
        }
        if relationship.is_some_and(|v| v != "SCHEDULED" && v != 0) {
            return Outcome::Unsupported;
        }
        let boundary = source_boundary(snapshot, update, now, &service_seconds);
        let predicted = scheduled_calls(schedule, trip).and_then(|calls| {
            predict(calls, &names.stop_ids, update, &service_seconds, boundary, &mut total)
        });
        match predicted {
            Ok((stops, omitted)) => {
                replacements.push(RealtimeTripInput {
                    trip: trip as u32,
                    stops,
                });
                Outcome::Applied {
                    trip: trip as u32,
                    omitted: omitted as u32,
                }
            }
            Err(Unsupported) => Outcome::Unsupported,
            Err(Invalid) => Outcome::Invalid,
        }
    };
    let outcomes: Vec<_> = updates.iter().map(&mut outcome).collect();
    let view = compile_realtime_timetable_view(RealtimeTimetableView {
        stop_count: schedule.stop_count,
        departure_seconds: schedule.departure_seconds,
        arrival_seconds: schedule.arrival_seconds,
        from_stop: schedule.from_stop,
        to_stop: schedule.to_stop,
        sequence: schedule.sequence,
        segment_run: schedule.segment_run,
        continuity_break: schedule.continuity_break,
        can_board: schedule.can_board,
        can_alight: schedule.can_alight,
        trip_start: schedule.trip_start,
        canceled: &canceled,
        replacements: &replacements,
        // Alerts may still close boardings; callers index the final view.
        index_departures: false,
    })?;
    Ok(Overlay { view, outcomes })
}

/// The calls of one trip in schedule order. Connections record each boarding
/// sequence but not the terminal's, which therefore follows the last one.
fn scheduled_calls(
    schedule: &Schedule,
    trip: usize,
) -> std::result::Result<Vec<RealtimeCallInput>, Rejection> {
    let first = schedule.trip_start[trip] as usize;
    let end = schedule.trip_start[trip + 1] as usize;
    // An empty trip or one beyond the native run limit cannot be replaced.
    if first == end || end - first > 32768 {
        return Err(Invalid);
    }
    // Nor can an update bridge disconnected scheduled runs.
    if (first + 1..end).any(|i| {
        schedule.from_stop[i] != schedule.to_stop[i - 1]
            || schedule.continuity_break[i] != 0
            || schedule.segment_run[i] != schedule.segment_run[i - 1]
    }) {
        return Err(Invalid);
    }
    let mut calls = Vec::with_capacity(end - first + 1);
    for i in first..end {
        calls.push(RealtimeCallInput {
            stop: schedule.from_stop[i],
            arrival: if i == first {
                schedule.departure_seconds[i] as f64
            } else {
                schedule.arrival_seconds[i - 1] as f64
            },
            departure: schedule.departure_seconds[i] as f64,
            sequence: schedule.sequence[i] as f64,
            can_board: schedule.can_board[i] != 0,
            can_alight: i == first || schedule.can_alight[i - 1] != 0,
        });
    }
    calls.push(RealtimeCallInput {
        stop: schedule.to_stop[end - 1],
        arrival: schedule.arrival_seconds[end - 1] as f64,
        departure: schedule.arrival_seconds[end - 1] as f64,
        sequence: schedule.sequence[end - 1] as f64 + 1.,
        can_board: true,
        can_alight: schedule.can_alight[end - 1] != 0,
    });
    Ok(calls)
}

/// Applies one trip update to its scheduled calls. Arrival and departure stay
/// distinct; a delay propagates forward until a new prediction or NO_DATA.
/// `boundary` is the update's source clock as POSIX and service seconds, once
/// both feed and record clocks have passed: an early first prediction may then
/// drop the omitted calls before it, which have unknown actual times. Returns
/// the predicted calls and how many past calls were omitted.
fn predict(
    mut calls: Vec<RealtimeCallInput>,
    stop_ids: &[String],
    update: &Value,
    service_seconds: &dyn Fn(i64) -> Option<f64>,
    boundary: Option<(i64, f64)>,
    total: &mut usize,
) -> std::result::Result<(Vec<RealtimeCallInput>, usize), Rejection> {
    let stop_updates = match update.get("stopTimeUpdates") {
        Some(value) => value.as_array().ok_or(Invalid)?.as_slice(),
        None => &[],
    };
    *total += stop_updates.len();
    if *total > 500_000 {
        return Err(Invalid);
    }
    // A prediction binds to exactly one call. A stop sequence identifies one
    // call on a loop; a stop alone must not be ambiguous.
    let mut matched = HashMap::new();
    let mut last_sequence = None;
    for u in stop_updates {
        if u.get("scheduleRelationship").is_some_and(|v| {
            v != "SCHEDULED" && v != "SKIPPED" && v != "NO_DATA" && v != 0 && v != 1 && v != 2
        }) {
            return Err(Unsupported);
        }
        let sequence = u
            .get("stopSequence")
            .map(|v| v.as_u64().ok_or(Invalid))
            .transpose()?;
        if let Some(n) = sequence {
            if last_sequence.is_some_and(|last| last >= n) {
                return Err(Invalid);
            }
            last_sequence = Some(n);
        }
        let stop_matches = |c: &RealtimeCallInput| {
            u["stopId"]
                .as_str()
                .is_none_or(|id| same_id(id, &stop_ids[c.stop as usize]))
        };
        let mut indexes: Vec<_> = calls
            .iter()
            .enumerate()
            .filter(|(_, c)| sequence.is_none_or(|n| c.sequence == n as f64) && stop_matches(c))
            .map(|(i, _)| i)
            .collect();
        // The terminal's inferred sequence yields to a later one that the
        // feed reports for the same stop.
        if indexes.is_empty()
            && sequence.is_some_and(|n| n as f64 > calls[calls.len() - 2].sequence)
            && u["stopId"].is_string()
            && stop_matches(calls.last().unwrap())
        {
            let i = calls.len() - 1;
            calls[i].sequence = sequence.unwrap() as f64;
            indexes.push(i);
        }
        if indexes.len() != 1 || matched.insert(indexes[0], u).is_some() {
            return Err(Invalid);
        }
    }
    let mut delay = update
        .get("delaySeconds")
        .map(|v| v.as_i64().map(|v| v as f64).ok_or(Invalid))
        .transpose()?;
    let trip_delay = update.get("delaySeconds").is_some();
    let mut output: Vec<RealtimeCallInput> = vec![];
    let mut used = 0;
    let mut omitted = 0;
    for (i, mut call) in calls.into_iter().enumerate() {
        let update = matched.get(&i).copied();
        used += usize::from(update.is_some());
        let state = update.and_then(|u| u.get("scheduleRelationship"));
        let no_data = state.is_some_and(|v| v == "NO_DATA" || v == 2);
        if no_data {
            delay = None;
        }
        // An absolute time takes precedence over a conflicting delay.
        let event = |name: &str, scheduled: f64| -> std::result::Result<Option<f64>, Rejection> {
            if no_data {
                return Ok(None);
            }
            let Some(e) = update.and_then(|v| v.get(name)) else {
                return Ok(None);
            };
            if !e.is_object() {
                return Err(Invalid);
            }
            if let Some(time) = e.get("time") {
                let time = service_seconds(time.as_i64().ok_or(Invalid)?).ok_or(Invalid)?;
                return Ok(Some(time - scheduled));
            }
            e.get("delay")
                .map(|v| v.as_i64().map(|n| n as f64).ok_or(Invalid))
                .transpose()
        };
        let arrival_delay = event("arrival", call.arrival)?;
        if arrival_delay.is_some() {
            delay = arrival_delay;
        }
        call.arrival += delay.unwrap_or(0.);
        let departure_delay = event("departure", call.departure)?;
        if departure_delay.is_some() {
            delay = departure_delay;
        }
        call.departure += delay.unwrap_or(0.);
        // A skipped call is not a routing vertex. Its event may still update
        // the propagated delay; connecting the remaining calls preserves
        // through travel without inventing a passing time.
        if state.is_some_and(|v| v == "SKIPPED" || v == 1) {
            if [call.arrival, call.departure]
                .iter()
                .any(|n| !n.is_finite() || n.fract() != 0. || !(0. ..=MAXIMUM_TIME).contains(n))
            {
                return Err(Invalid);
            }
            continue;
        }
        let predicted = update
            .and_then(|u| {
                u["arrival"]
                    .get("time")
                    .or_else(|| u["departure"].get("time"))
            })
            .and_then(Value::as_i64);
        let first_arrival = if arrival_delay.is_none() {
            call.arrival.min(call.departure)
        } else {
            call.arrival
        };
        // Never back-propagate a later prediction into an invented history:
        // omit the past calls only when the first prediction precedes them.
        if !output.is_empty()
            && !no_data
            && used == 1
            && !trip_delay
            && let (Some((epoch, boundary)), Some(predicted)) = (boundary, predicted)
            && predicted >= 0
            && predicted < epoch
            && first_arrival < boundary
            && (first_arrival < output.last().unwrap().departure
                || (arrival_delay.is_none() && call.departure < call.arrival))
            && output.iter().all(|c| c.departure < boundary)
        {
            omitted = output.len();
            output.clear();
        }
        // There is no incoming ride at the first call. A departure-only early
        // prediction must not conflict with an arrival kept from the schedule.
        if output.is_empty() && arrival_delay.is_none() {
            call.arrival = call.arrival.min(call.departure);
        }
        output.push(call);
    }
    // Contradictory observations must not introduce backwards ride segments.
    let mut previous = -1.;
    let mut previous_sequence = -1.;
    for call in &output {
        if call.sequence <= previous_sequence
            || !call.arrival.is_finite()
            || !call.departure.is_finite()
            || call.arrival < previous
            || call.arrival < 0.
            || call.departure < call.arrival
            || call.departure > MAXIMUM_TIME
            || call.arrival.fract() != 0.
            || call.departure.fract() != 0.
        {
            return Err(Invalid);
        }
        previous = call.departure;
        previous_sequence = call.sequence;
    }
    Ok((output, omitted))
}

/// Compiles the snapshot's Service Alerts and applies NO_SERVICE to `view`,
/// recording them under `diagnostics.alerts`. Alerts are only evaluated
/// against a known City clock.
#[allow(clippy::too_many_arguments)]
pub(crate) fn apply_alerts(
    view: &mut RealtimeTimetableResult,
    names: &TimetableNames,
    snapshot: &Value,
    clock: Clock,
    now: f64,
    parents: &[u32],
    route_types: Arc<HashMap<String, i64>>,
    diagnostics: &mut Value,
) -> Result<Option<alerts::Alerts>> {
    let Some(records) = snapshot.get("alerts") else {
        return Ok(None);
    };
    let Some(zone) = clock.zone else {
        diagnostics["alerts"] =
            json!({"received":records.as_array().map_or(0, Vec::len),"status":"timezone_required"});
        return Ok(None);
    };
    let day_start = service_epoch(zone, clock.date)?;
    let fresh = |record: &Value| {
        fresh(
            record
                .get("sourceFeedTimestamp")
                .unwrap_or(&snapshot["feedTimestamp"]),
            now,
        )
    };
    let alerts = alerts::Alerts::compile(
        records,
        names,
        route_types,
        parents,
        day_start,
        fresh,
        diagnostics,
    )?;
    alerts.apply(
        alerts::Service {
            departure_seconds: &view.departure_seconds,
            arrival_seconds: &view.arrival_seconds,
            from_stop: &view.from_stop,
            to_stop: &view.to_stop,
            trip_start: &view.trip_start,
            can_board: &mut view.can_board,
            can_alight: &mut view.can_alight,
        },
        diagnostics,
    );
    Ok((!alerts.is_empty()).then_some(alerts))
}
fn supplied_start(update: &Value) -> Option<&Value> {
    update
        .get("startDate")
        .or_else(|| update.get("trip").and_then(|t| t.get("startDate")))
}
fn same_day(text: &str, date: &NaiveDate) -> bool {
    text.replace('-', "") == date.format("%Y%m%d").to_string()
}
fn date_matches(update: &Value, date: &NaiveDate, start_date: Option<&str>) -> bool {
    match supplied_start(update) {
        Some(supplied) => supplied.as_str().is_some_and(|s| same_day(s, date)),
        None => start_date.is_none_or(|s| same_day(s, date)),
    }
}
fn fresh(v: &Value, now: f64) -> bool {
    v.as_f64()
        .is_some_and(|t| t > 0. && t.fract() == 0. && now - t <= 180. && t - now <= 60.)
}
fn record_fresh(snapshot: &Value, update: &Value, now: f64) -> bool {
    fresh(
        update
            .get("sourceFeedTimestamp")
            .unwrap_or(&snapshot["feedTimestamp"]),
        now,
    ) && update.get("timestamp").is_none_or(|v| fresh(v, now))
}
/// The update's source clock in POSIX and service seconds, once both its feed
/// and record clocks have passed `now`.
fn source_boundary(
    snapshot: &Value,
    update: &Value,
    now: f64,
    service_seconds: &dyn Fn(i64) -> Option<f64>,
) -> Option<(i64, f64)> {
    let epoch = past_boundary(snapshot, update, now)?;
    service_seconds(epoch)
        .filter(|n| (0. ..=MAXIMUM_TIME).contains(n))
        .map(|service| (epoch, service))
}
fn past_boundary(snapshot: &Value, update: &Value, now: f64) -> Option<i64> {
    let feed = update
        .get("sourceFeedTimestamp")
        .unwrap_or(&snapshot["feedTimestamp"])
        .as_i64()?;
    let record = update
        .get("timestamp")
        .map(Value::as_i64)
        .unwrap_or(Some(feed))?;
    (feed >= 0 && record >= 0 && feed as f64 <= now && record as f64 <= now)
        .then_some(feed.min(record))
}
/// Everything about `snapshot` that changes with the observation time. A view
/// is reusable for an unchanged snapshot while this stays the same.
pub(crate) fn validity(snapshot: &Value, now: f64) -> Value {
    let trips: Vec<_> = snapshot["tripUpdates"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|u| {
            (
                record_fresh(snapshot, u, now),
                past_boundary(snapshot, u, now).is_some(),
            )
        })
        .collect();
    // Alert feeds age independently of trip update feeds.
    let Some(alerts) = snapshot.get("alerts").and_then(Value::as_array) else {
        return json!(trips);
    };
    let alerts: Vec<_> = alerts
        .iter()
        .map(|a| {
            fresh(
                a.get("sourceFeedTimestamp")
                    .unwrap_or(&snapshot["feedTimestamp"]),
                now,
            )
        })
        .collect();
    json!([trips, alerts])
}
/// The fields of `snapshot` that [`validity`] reads, so that a retained
/// identity can be revalidated without the snapshot's predictions.
#[cfg(any(feature = "node", test))]
pub(crate) fn clocks(snapshot: &Value) -> Value {
    let pick = |record: &Value, keys: &[&str]| {
        let mut picked = json!({});
        for &key in keys {
            if let Some(value) = record.get(key) {
                picked[key] = value.clone();
            }
        }
        picked
    };
    let mut retained = pick(snapshot, &["feedTimestamp"]);
    let records = |key: &str, fields: &[&str]| {
        snapshot[key]
            .as_array()
            .map(|records| Value::Array(records.iter().map(|r| pick(r, fields)).collect()))
    };
    if let Some(trips) = records("tripUpdates", &["sourceFeedTimestamp", "timestamp"]) {
        retained["tripUpdates"] = trips;
    }
    if let Some(alerts) = records("alerts", &["sourceFeedTimestamp"]) {
        retained["alerts"] = alerts;
    }
    retained
}

#[cfg(test)]
mod tests;
