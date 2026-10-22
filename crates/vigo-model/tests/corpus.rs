//! Every recorded Result and request reads into the model and writes back as
//! the same JSON, including integer-versus-fraction number forms.

mod common;

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::fmt::Write as _;
use vigo_model::{
    Capabilities, CompareRequest, MatrixRequest, ReachRequest, Response, RouteRequest,
};

/// Paths where two JSON values differ, compared strictly (`1` is not `1.0`).
fn differences(expected: &Value, actual: &Value, at: &str, found: &mut Vec<String>) {
    if found.len() >= 8 || expected == actual {
        return;
    }
    match (expected, actual) {
        (Value::Object(a), Value::Object(b)) => {
            for key in a.keys().chain(b.keys().filter(|k| !a.contains_key(*k))) {
                match (a.get(key), b.get(key)) {
                    (Some(x), Some(y)) => differences(x, y, &format!("{at}.{key}"), found),
                    (Some(x), None) => found.push(format!("{at}.{key}: dropped {}", brief(x))),
                    (None, Some(y)) => found.push(format!("{at}.{key}: added {}", brief(y))),
                    (None, None) => unreachable!(),
                }
            }
        }
        (Value::Array(a), Value::Array(b)) if a.len() == b.len() => {
            for (index, (x, y)) in a.iter().zip(b).enumerate() {
                differences(x, y, &format!("{at}[{index}]"), found);
            }
        }
        _ => found.push(format!("{at}: {} → {}", brief(expected), brief(actual))),
    }
}

fn brief(value: &Value) -> String {
    let text = value.to_string();
    if text.len() > 80 {
        format!("{}…", &text[..80])
    } else {
        text
    }
}

/// Reads `value` as `T` and writes it back; returns what changed.
fn round_trip<T: DeserializeOwned + Serialize>(value: &Value) -> Result<Vec<String>, String> {
    let text = serde_json::to_string(value).unwrap();
    let typed: T = serde_json::from_str(&text).map_err(|error| error.to_string())?;
    let written = serde_json::to_value(&typed).map_err(|error| error.to_string())?;
    let mut found = vec![];
    differences(value, &written, "$", &mut found);
    Ok(found)
}

#[test]
fn corpus_round_trips_through_the_model() {
    let mut checked = 0;
    let mut rejected_requests = 0;
    let mut report = String::new();
    for record in common::records() {
        let name = record["case"].as_str().unwrap_or("?").to_owned();
        let kind = record["kind"].as_str().unwrap_or("");
        let result = &record["result"];
        let outcome = match kind {
            "capabilities" => round_trip::<Capabilities>(result),
            _ => round_trip::<Response>(result),
        };
        match outcome {
            Ok(found) if found.is_empty() => {}
            Ok(found) => {
                writeln!(report, "{name}: result changed\n  {}", found.join("\n  ")).unwrap()
            }
            Err(error) => writeln!(report, "{name}: result rejected: {error}").unwrap(),
        }
        let request = &record["request"];
        let outcome = match common::request_schema(kind).filter(|_| !request.is_null()) {
            Some("RouteRequest") => round_trip::<RouteRequest>(request),
            Some("MatrixRequest") => round_trip::<MatrixRequest>(request),
            Some("ReachRequest") => round_trip::<ReachRequest>(request),
            Some("CompareRequest") => round_trip::<CompareRequest>(request),
            _ => Ok(vec![]),
        };
        match outcome {
            Ok(found) if found.is_empty() => {}
            Ok(found) => {
                writeln!(report, "{name}: request changed\n  {}", found.join("\n  ")).unwrap()
            }
            // The engine rejected this request too; the model may as well.
            Err(_) if record["exitCode"] != 0 => rejected_requests += 1,
            Err(error) => writeln!(report, "{name}: request rejected: {error}").unwrap(),
        }
        checked += 1;
    }
    assert!(report.is_empty(), "{checked} records checked:\n{report}");
    eprintln!(
        "{checked} records round-trip; {rejected_requests} invalid requests rejected by both"
    );
}

#[test]
fn routing_profile_preserves_absent_ordinary_and_scoped_dispatch() {
    for dispatch in [
        None,
        Some(serde_json::json!({"semantics": "ordinary"})),
        Some(serde_json::json!({
            "semantics": "scoped", "ordinarySearches": 7, "statefulSearches": 2,
            "counts": "resident_timetable_cumulative"
        })),
    ] {
        let mut profile = serde_json::json!({"timingsUs": {}, "note": "Scopes may overlap."});
        if let Some(dispatch) = dispatch {
            profile["routingDispatch"] = dispatch;
        }
        let changes = round_trip::<vigo_model::Profile>(&profile).unwrap();
        assert!(changes.is_empty(), "{}", changes.join("\n"));
    }
}
