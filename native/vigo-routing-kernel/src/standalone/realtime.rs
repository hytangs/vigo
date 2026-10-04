use super::{Result, fail};
use crate::*;
use chrono::{NaiveDate, TimeZone, Timelike};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

pub(crate) fn apply(
    source: &mut ServiceTimetableResult,
    request: &Value,
    metadata: &Value,
    now: f64,
) -> Result<Value> {
    let Some(snapshot) = request.get("realtimeSnapshot") else {
        return Ok(Value::Null);
    };
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
    let date = NaiveDate::parse_from_str(
        request["serviceDate"]
            .as_str()
            .ok_or("Missing serviceDate")?,
        "%Y-%m-%d",
    )?;
    let mut diagnostics = json!({"mode":"full-snapshot","feedTripUpdates":updates.len(),"appliedTrips":0,"canceledTrips":0,"staleTrips":0,"unmatchedTrips":0,"invalidTrips":0,"duplicateTrips":0,"dateMismatches":0,"pastPrefixTrips":0,"omittedPastPrefixStops":0,"status":"no_matches"});
    let timezone = snapshot["timezone"]
        .as_str()
        .or_else(|| metadata["agencyTimezone"].as_str())
        .or_else(|| metadata["timezone"].as_str())
        .or_else(|| {
            metadata["agencyTimezones"]
                .as_array()
                .filter(|z| z.len() == 1)
                .and_then(|z| z[0].as_str())
        });
    let zone: Option<chrono_tz::Tz> = timezone.map(str::parse).transpose()?;
    let clock = |epoch: i64| -> Result<f64> {
        let tz = zone
            .ok_or("Absolute realtime timestamps require realtimeSnapshot.timezone (IANA name)")?;
        let t = tz
            .timestamp_opt(epoch, 0)
            .single()
            .ok_or("Invalid realtime epoch")?;
        Ok((t.date_naive() - date).num_days() as f64 * 86400.
            + t.num_seconds_from_midnight() as f64)
    };
    let mut exact = HashMap::new();
    let mut local: HashMap<&str, Vec<usize>> = HashMap::new();
    for (i, id) in source.trip_ids.iter().enumerate() {
        exact.insert(id.as_str(), i);
        local
            .entry(id.rsplit('\u{1f}').next().unwrap())
            .or_default()
            .push(i);
    }
    let mut canceled = vec![0; source.trip_ids.len()];
    let mut replacements = vec![];
    let mut seen = HashSet::new();
    let resolve = |update: &Value| -> Option<usize> {
        let id = update["tripId"]
            .as_str()
            .or_else(|| update["trip"]["tripId"].as_str())?;
        if id.contains('\u{1f}') {
            let index = exact.get(id).copied()?;
            if update["sourceScope"]
                .as_str()
                .is_some_and(|scope| id.split('\u{1f}').next() != Some(scope))
            {
                return None;
            }
            return Some(index);
        }
        let matches: Vec<_> = local
            .get(id)
            .into_iter()
            .flatten()
            .copied()
            .filter(|&i| {
                update["sourceScope"]
                    .as_str()
                    .is_none_or(|scope| source.trip_ids[i].split('\u{1f}').next() == Some(scope))
            })
            .collect();
        (matches.len() == 1).then(|| matches[0])
    };
    let mut counts = HashMap::new();
    for update in updates {
        if record_fresh(snapshot, update, now)
            && date_matches(update, &date)
            && let Some(trip) = resolve(update)
        {
            *counts.entry(trip).or_insert(0) += 1;
        }
    }
    let mut total = 0;
    for update in updates {
        if !record_fresh(snapshot, update, now) {
            increment(&mut diagnostics, "staleTrips");
            continue;
        }
        if !date_matches(update, &date) {
            increment(&mut diagnostics, "dateMismatches");
            continue;
        }
        let Some(trip) = resolve(update) else {
            increment(&mut diagnostics, "unmatchedTrips");
            continue;
        };
        if counts.get(&trip).copied().unwrap_or(0) > 1 || !seen.insert(trip) {
            increment(&mut diagnostics, "duplicateTrips");
            continue;
        }
        let matches_id = |supplied: &Value, actual: &str| {
            supplied.is_null()
                || supplied.as_str().is_some_and(|id| {
                    if id.contains('\u{1f}') {
                        id == actual
                    } else {
                        actual.rsplit('\u{1f}').next() == Some(id)
                    }
                })
        };
        if !matches_id(&update["routeId"], &source.route_ids[trip])
            || update.get("directionId").is_some_and(|id| {
                id.as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| id.to_string())
                    != source.direction_ids[trip]
            })
        {
            increment(&mut diagnostics, "invalidTrips");
            continue;
        }
        let relationship = update.get("scheduleRelationship").or_else(|| {
            update
                .get("trip")
                .and_then(|v| v.get("scheduleRelationship"))
        });
        if relationship.is_some_and(|v| v == "CANCELED" || v == "DELETED" || v == 3 || v == 7) {
            canceled[trip] = 1;
            increment(&mut diagnostics, "canceledTrips");
            continue;
        }
        if relationship.is_some_and(|v| v != "SCHEDULED" && v != 0) {
            increment(&mut diagnostics, "invalidTrips");
            continue;
        }
        let prepared = (|| -> Result<(RealtimeTripInput, usize)> {
            let first = source.trip_start[trip] as usize;
            let end = source.trip_start[trip + 1] as usize;
            if first == end || end - first > 32768 {
                return fail("Realtime trip has no connections or exceeds the native run limit");
            }
            if (first + 1..end).any(|i| {
                source.from_stop[i] != source.to_stop[i - 1]
                    || source.continuity_break[i] != 0
                    || source.segment_run[i] != source.segment_run[i - 1]
            }) {
                return fail("Realtime update cannot bridge disconnected scheduled runs");
            }
            let mut calls = vec![];
            for i in first..end {
                calls.push(RealtimeCallInput {
                    stop: source.from_stop[i],
                    arrival: if i == first {
                        source.departure_seconds[i] as f64
                    } else {
                        source.arrival_seconds[i - 1] as f64
                    },
                    departure: source.departure_seconds[i] as f64,
                    sequence: source.sequence[i] as f64,
                    can_board: source.can_board[i] != 0,
                    can_alight: i == first || source.can_alight[i - 1] != 0,
                });
            }
            calls.push(RealtimeCallInput {
                stop: source.to_stop[end - 1],
                arrival: source.arrival_seconds[end - 1] as f64,
                departure: source.arrival_seconds[end - 1] as f64,
                sequence: source.sequence[end - 1] as f64 + 1.,
                can_board: true,
                can_alight: source.can_alight[end - 1] != 0,
            });
            let stop_updates = update
                .get("stopTimeUpdates")
                .map(|v| v.as_array().ok_or("stopTimeUpdates must be an array"))
                .transpose()?
                .cloned()
                .unwrap_or_default();
            total += stop_updates.len();
            if total > 500_000 {
                return fail("Realtime snapshot exceeds 500000 stop updates");
            }
            let mut matched = HashMap::new();
            let mut last_sequence = None;
            for u in &stop_updates {
                let sequence = u
                    .get("stopSequence")
                    .map(|v| v.as_u64().ok_or("stopSequence must be an integer"))
                    .transpose()?;
                if let Some(n) = sequence {
                    if last_sequence.is_some_and(|last| last >= n) {
                        return fail("Realtime sequences must be strictly increasing");
                    }
                    last_sequence = Some(n);
                }
                let stop_matches = |c: &RealtimeCallInput| {
                    u["stopId"].as_str().is_none_or(|id| {
                        let actual = &source.stop_ids[c.stop as usize];
                        if id.contains('\u{1f}') {
                            actual == id
                        } else {
                            actual.rsplit('\u{1f}').next() == Some(id)
                        }
                    })
                };
                let mut indexes: Vec<_> = calls
                    .iter()
                    .enumerate()
                    .filter(|(_, c)| {
                        sequence.is_none_or(|n| c.sequence == n as f64) && stop_matches(c)
                    })
                    .map(|(i, _)| i)
                    .collect();
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
                    return fail("Each realtime prediction must identify exactly one call");
                }
            }
            let mut delay = update
                .get("delaySeconds")
                .map(|v| {
                    v.as_i64()
                        .map(|v| v as f64)
                        .ok_or("delaySeconds must be an integer")
                })
                .transpose()?;
            let boundary_epoch = past_boundary(snapshot, update, now);
            let boundary = boundary_epoch
                .and_then(|epoch| clock(epoch).ok())
                .filter(|n| (0. ..=1_048_575.).contains(n));
            let trip_delay = update.get("delaySeconds").is_some();
            let mut output: Vec<RealtimeCallInput> = vec![];
            let mut used = 0;
            let mut omitted = 0;
            for (i, mut call) in calls.into_iter().enumerate() {
                let update = matched.get(&i).copied();
                used += usize::from(update.is_some());
                let state = update.and_then(|u| u.get("scheduleRelationship"));
                if state.is_some_and(|v| {
                    v != "SCHEDULED"
                        && v != "SKIPPED"
                        && v != "NO_DATA"
                        && v != 0
                        && v != 1
                        && v != 2
                }) {
                    return fail("Unsupported realtime stop relationship");
                }
                let no_data = state.is_some_and(|v| v == "NO_DATA" || v == 2);
                if no_data {
                    delay = None;
                }
                let event = |name: &str, scheduled: f64| -> Result<Option<f64>> {
                    if no_data {
                        return Ok(None);
                    }
                    let Some(e) = update.and_then(|v| v.get(name)) else {
                        return Ok(None);
                    };
                    if !e.is_object() {
                        return fail("Realtime arrival/departure must be an object");
                    }
                    if let Some(time) = e.get("time") {
                        return Ok(Some(
                            clock(
                                time.as_i64()
                                    .ok_or("Realtime time must be integer epoch seconds")?,
                            )? - scheduled,
                        ));
                    }
                    e.get("delay")
                        .map(|v| {
                            v.as_i64()
                                .map(|n| n as f64)
                                .ok_or_else(|| "Realtime delay must be integer seconds".into())
                        })
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
                if state.is_some_and(|v| v == "SKIPPED" || v == 1) {
                    if [call.arrival, call.departure].iter().any(|n| {
                        !n.is_finite() || n.fract() != 0. || !(0. ..=1_048_575.).contains(n)
                    }) {
                        return fail("Invalid skipped-call prediction");
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
                if !output.is_empty()
                    && !no_data
                    && used == 1
                    && !trip_delay
                    && let (Some(boundary), Some(epoch), Some(predicted)) =
                        (boundary, boundary_epoch, predicted)
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
                if output.is_empty() && arrival_delay.is_none() {
                    call.arrival = call.arrival.min(call.departure);
                }
                output.push(call);
            }
            let mut previous = -1.;
            for call in &output {
                if !call.arrival.is_finite()
                    || !call.departure.is_finite()
                    || call.arrival < previous
                    || call.arrival < 0.
                    || call.departure < call.arrival
                    || call.departure > 1_048_575.
                    || call.arrival.fract() != 0.
                    || call.departure.fract() != 0.
                {
                    return fail("Contradictory realtime event times");
                }
                previous = call.departure;
            }
            Ok((
                RealtimeTripInput {
                    trip: trip as u32,
                    stops: output,
                },
                omitted,
            ))
        })();
        match prepared {
            Ok((trip, omitted)) => {
                replacements.push(trip);
                increment(&mut diagnostics, "appliedTrips");
                if omitted > 0 {
                    increment(&mut diagnostics, "pastPrefixTrips");
                    diagnostics["omittedPastPrefixStops"] = json!(
                        diagnostics["omittedPastPrefixStops"].as_u64().unwrap_or(0)
                            + omitted as u64
                    );
                }
            }
            Err(_) => increment(&mut diagnostics, "invalidTrips"),
        }
    }
    let r = compile_realtime_timetable(RealtimeTimetableInput {
        stop_count: source.stop_count,
        departure_seconds: std::mem::take(&mut source.departure_seconds),
        arrival_seconds: std::mem::take(&mut source.arrival_seconds),
        from_stop: std::mem::take(&mut source.from_stop),
        to_stop: std::mem::take(&mut source.to_stop),
        sequence: std::mem::take(&mut source.sequence),
        segment_run: std::mem::take(&mut source.segment_run),
        continuity_break: std::mem::take(&mut source.continuity_break),
        can_board: std::mem::take(&mut source.can_board),
        can_alight: std::mem::take(&mut source.can_alight),
        trip_start: std::mem::take(&mut source.trip_start),
        canceled,
        replacements,
    })?;
    source.departure_seconds = r.departure_seconds;
    source.arrival_seconds = r.arrival_seconds;
    source.from_stop = r.from_stop;
    source.to_stop = r.to_stop;
    source.sequence = r.sequence;
    source.segment_run = r.segment_run;
    source.segment_trip = r.segment_trip;
    source.continuity_break = r.continuity_break;
    source.can_board = r.can_board;
    source.can_alight = r.can_alight;
    source.trip_start = r.trip_start;
    source.run_count = r.run_count;
    let applied = diagnostics["appliedTrips"].as_u64().unwrap()
        + diagnostics["canceledTrips"].as_u64().unwrap();
    let rejected = updates.len() as u64 - applied;
    diagnostics["status"] = json!(if applied > 0 {
        if rejected > 0 { "partial" } else { "applied" }
    } else if diagnostics["staleTrips"].as_u64().unwrap() > 0 {
        "stale_fallback"
    } else {
        "no_matches"
    });
    diagnostics["coverage"] = json!({"appliedUpdates":applied,"rejectedUpdates":rejected,"complete":rejected == 0 && snapshot["failedFeeds"].as_u64().unwrap_or(0) == 0});
    Ok(diagnostics)
}
fn increment(value: &mut Value, key: &str) {
    value[key] = json!(value[key].as_u64().unwrap_or(0) + 1);
}
fn date_matches(update: &Value, date: &NaiveDate) -> bool {
    update
        .get("startDate")
        .or_else(|| update.get("trip").and_then(|t| t.get("startDate")))
        .is_none_or(|d| {
            d.as_str()
                .is_some_and(|s| s.replace('-', "") == date.format("%Y%m%d").to_string())
        })
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
pub(crate) fn validity(request: &Value, now: f64) -> Value {
    let snapshot = &request["realtimeSnapshot"];
    json!(
        snapshot["tripUpdates"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|u| (
                record_fresh(snapshot, u, now),
                past_boundary(snapshot, u, now).is_some()
            ))
            .collect::<Vec<_>>()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn omitted_past_calls_follow_source_clock_and_remove_prefix_boarding() {
        let source = || ServiceTimetableResult {
            stop_ids: ["A", "B", "C", "D", "E"].map(str::to_owned).to_vec(),
            departure_seconds: vec![34800, 35400, 36000, 36600],
            arrival_seconds: vec![35400, 36000, 36600, 37200],
            from_stop: vec![0, 1, 2, 3],
            to_stop: vec![1, 2, 3, 4],
            sequence: vec![1, 2, 3, 4],
            segment_trip: vec![0; 4],
            segment_run: vec![0; 4],
            continuity_break: vec![0; 4],
            can_board: vec![1; 4],
            can_alight: vec![1; 4],
            trip_start: vec![0, 4],
            trip_ids: vec!["main".into()],
            route_ids: vec!["R".into()],
            service_ids: vec!["day".into()],
            direction_ids: vec!["0".into()],
            run_count: 1,
            stop_count: 5,
        };
        let midnight = NaiveDate::from_ymd_opt(2026, 9, 15)
            .unwrap()
            .and_hms_opt(0, 0, 0)
            .unwrap()
            .and_utc()
            .timestamp();
        let feed = midnight + 36000;
        let updates: Vec<_> = [(3, 589), (4, 602), (5, 610)].iter().map(|(seq, minute)| json!({"stopSequence":seq,"arrival":{"time":midnight+minute*60},"departure":{"time":midnight+minute*60}})).collect();
        let request = json!({"serviceDate":"2026-09-15","realtimeSnapshot":{"timezone":"UTC","feedTimestamp":feed,"tripUpdates":[{"tripId":"main","stopTimeUpdates":updates}]}});
        let mut before = source();
        let diagnostics = apply(&mut before, &request, &json!({}), (feed - 1) as f64).unwrap();
        assert_eq!(diagnostics["invalidTrips"], 1);
        assert_eq!(before.from_stop, [0, 1, 2, 3]);
        let mut after = source();
        let diagnostics = apply(&mut after, &request, &json!({}), (feed + 1) as f64).unwrap();
        assert_eq!(diagnostics["appliedTrips"], 1);
        assert_eq!(diagnostics["omittedPastPrefixStops"], 2);
        assert_eq!(after.from_stop, [2, 3]);
        assert_eq!(after.departure_seconds, [35340, 36120]);
        assert_eq!(after.arrival_seconds, [36120, 36600]);
        assert_ne!(
            validity(&request, (feed - 1) as f64),
            validity(&request, (feed + 1) as f64)
        );
        assert_eq!(
            validity(&request, (feed + 1) as f64),
            validity(&request, (feed + 30) as f64)
        );
    }
}
