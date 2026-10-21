//! `departNow`: leave at the City's current minute, resolved once per request.
use super::{City, Result, fail};
use chrono::{Datelike, Timelike};
use serde_json::{Value, json};

/// The request with its clock fixed to now, or None when it does not ask.
/// Public times use whole minutes; rounding forward means a departure
/// earlier within this minute can never be boarded, and a midnight boundary
/// advances the service date with it.
pub(super) fn depart_now(city: &City, request: &Value) -> Result<Option<Value>> {
    let Some(value) = request.get("departNow") else {
        return Ok(None);
    };
    let Some(now) = value.as_bool() else {
        return fail("departNow must be a boolean");
    };
    let mut resolved = request.clone();
    let object = resolved
        .as_object_mut()
        .ok_or("Request must be a JSON object")?;
    object.remove("departNow");
    if !now {
        return Ok(Some(resolved));
    }
    if request["mode"].as_str().unwrap_or("transit") != "transit" {
        return fail("departNow requires transit routing");
    }
    let mut zones: Vec<&str> = city.metadata["agencyTimezones"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|zone| !zone.is_empty())
        .collect();
    zones.sort_unstable();
    zones.dedup();
    let [zone] = zones.as_slice() else {
        return fail(
            "Depart now requires one agency timezone in the City's GTFS; rebuild it with a valid agency_timezone",
        );
    };
    let zone: chrono_tz::Tz = zone
        .parse()
        .map_err(|_| "The City's agency timezone is invalid; rebuild it before using Depart now")?;
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_secs_f64();
    let minute = (seconds / 60.).ceil() as i64 * 60;
    let local = chrono::DateTime::from_timestamp(minute, 0)
        .ok_or("The system clock is unavailable")?
        .with_timezone(&zone);
    let service_day = match local.weekday() {
        chrono::Weekday::Sat => "saturday",
        chrono::Weekday::Sun => "sunday",
        _ => "weekday",
    };
    for key in ["time", "timeMinutes", "arriveMinutes", "serviceDay"] {
        object.remove(key);
    }
    object.insert(
        "serviceDate".into(),
        json!(local.format("%Y-%m-%d").to_string()),
    );
    object.insert(
        "time".into(),
        json!(format!("{:02}:{:02}", local.hour(), local.minute())),
    );
    object.insert("timePreference".into(), json!("depart_at"));
    object.insert("serviceDay".into(), json!(service_day));
    Ok(Some(resolved))
}
