//! Versioned public results. Routing structs and research witnesses are private
//! implementation details; only an explicit trace request exports them.
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicU64, Ordering};

fn pick<'a>(v: &'a Value, keys: &[&str]) -> &'a Value {
    keys.iter()
        .find_map(|k| v.get(k).filter(|v| !v.is_null()))
        .unwrap_or(&Value::Null)
}
fn integer(v: &Value) -> Value {
    v.as_f64()
        .filter(|n| n.is_finite())
        .map_or(Value::Null, |n| json!(n.round() as i64))
}
fn seconds(v: &Value, sec: &[&str], min: &[&str]) -> Value {
    let n = pick(v, sec)
        .as_f64()
        .or_else(|| pick(v, min).as_f64().map(|n| n * 60.));
    n.map_or(Value::Null, |n| json!(n.round() as i64))
}
fn clock(seconds: &Value) -> Value {
    seconds.as_i64().map_or(Value::Null, |s| {
        json!(format!(
            "{:02}:{:02}:{:02}",
            s / 3600,
            s % 3600 / 60,
            s % 60
        ))
    })
}
fn clean(v: &mut Value) {
    match v {
        Value::Number(n) if n.as_u64() == Some(u32::MAX as u64) => *v = Value::Null,
        Value::Array(a) => a.iter_mut().for_each(clean),
        Value::Object(o) => o.values_mut().for_each(clean),
        _ => (),
    }
}
pub fn identifier(v: &Value) -> Value {
    let Some(s) = v.as_str().filter(|s| !s.is_empty()) else {
        return Value::Null;
    };
    match s.split_once('\u{1f}') {
        Some((feed, id)) => json!({"feed":feed,"id":id}),
        None => json!({"feed":null,"id":s}),
    }
}
fn point(v: &Value) -> Value {
    let mut p = json!({});
    if v["stop"].is_object() {
        p["stop"] = v["stop"].clone();
    }
    if v.is_string() {
        p["stop"] = identifier(v);
    }
    if let Some(s) = v.get("stopId") {
        p["stop"] = identifier(s);
    }
    for key in ["coordinate", "name"] {
        if let Some(x) = v.get(key).filter(|x| !x.is_null()) {
            p[key] = x.clone();
        }
    }
    if v.is_array() {
        p["coordinate"] = v.clone();
    }
    p
}
fn endpoint(leg: &Value, side: &str) -> Value {
    let mut p = point(&leg[side]);
    let id = &leg[format!("{side}StopId")];
    if !id.is_null() {
        p["stop"] = identifier(id);
    }
    if let Some(name) = leg.get(format!("{side}Name")) {
        p["name"] = name.clone();
    }
    p
}
fn leg(v: &Value, geometry: bool) -> Value {
    let raw_kind = pick(v, &["kind", "type"]).as_str().unwrap_or("walk");
    let kind = if raw_kind == "ride" {
        "transit"
    } else {
        raw_kind
    };
    let departure = seconds(v, &["departure"], &["departureMinutes", "startMinutes"]);
    let arrival = seconds(v, &["arrival"], &["arrivalMinutes", "endMinutes"]);
    let mut out = json!({"type":kind,"from":endpoint(v,"from"),"to":endpoint(v,"to"),
        "departureTime":clock(&departure),"arrivalTime":clock(&arrival),
        "durationSeconds":seconds(v,&[],&["durationMinutes"])});
    if let (Some(a), Some(b)) = (departure.as_i64(), arrival.as_i64()) {
        out["durationSeconds"] = json!(b - a);
    }
    if let Some(d) = v["distanceMeters"]
        .as_f64()
        .or_else(|| v["distanceKm"].as_f64().map(|d| d * 1000.))
    {
        out["distanceMeters"] = json!(d.round() as i64);
    }
    let source = v["geometrySource"].as_str().unwrap_or("unknown");
    let street = if v["streetSegmentVerified"] == true || v["streetPathVerified"] == true {
        "verified"
    } else {
        "unverified"
    };
    if kind == "transit" {
        out["route"] = json!({"id":identifier(&v["routeId"]),
            "name":pick(&v["route"], &["shortName","longName"]),
            "color":pick(&v["route"], &["color"]),"type":pick(&v["route"], &["type"])});
        for (dst, src) in [
            ("name", "routeShortName"),
            ("color", "routeColor"),
            ("type", "routeType"),
        ] {
            if out["route"][dst].is_null() {
                out["route"][dst] = v[src].clone();
            }
        }
        if out["route"]["name"] == "" {
            out["route"]["name"] = v["route"]["longName"].clone();
        }
        out["trip"] = identifier(&v["tripId"]);
        out["quality"] = json!({"geometry":source,"schedule":if v["sourceEqualTime"] == true || v["bridgedUntimedGapCount"].as_f64().unwrap_or(0.) > 0. {"source_time_limitations"} else {"timetable"}});
        if let Some(fare) = v.get("fare") {
            out["fare"] = fare.clone();
        }
    } else {
        out["quality"] = json!({"streetGeometry":street,"geometrySource":source});
        if !v["stationAccessStatus"].is_null() {
            out["quality"]["stationPath"] = json!(if v["stationAccessStatus"] == "source_path" {
                "source_path"
            } else {
                "inferred"
            });
        }
        let estimated_station_time = v["transferSource"] == "gtfs_pathway_estimated"
            || [
                &v["stationPathSources"],
                &v["accessCost"]["station"]["sources"],
            ]
            .iter()
            .any(|sources| {
                sources.as_array().is_some_and(|items| {
                    items
                        .iter()
                        .any(|source| source == "gtfs_pathway_estimated")
                })
            });
        if estimated_station_time {
            out["quality"]["stationTime"] = json!("estimated");
        }
        if v["accessCost"].is_object() {
            let mut components = vec![];
            for part in ["street", "station"] {
                let c = &v["accessCost"][part];
                if c.is_object() {
                    let mut component = json!({"type":part,"durationSeconds":integer(&c["seconds"]),
                        "distanceMeters":c["distanceKm"].as_f64().map(|d|(d*1000.).round() as i64)});
                    if let Some(a) = c["sources"].as_array() {
                        let mut sources = a.clone();
                        sources.sort_by_key(Value::to_string);
                        sources.dedup();
                        component["sources"] = json!(sources);
                    }
                    components.push(component);
                }
            }
            out["components"] = json!(components);
        }
    }
    if geometry && v["coordinates"].is_array() {
        out["geometry"] = json!({"type":"LineString","coordinates":v["coordinates"]});
    }
    out
}
fn journey(v: &Value, geometry: bool) -> Value {
    if v.is_null() || v["status"] == "blocked" {
        return Value::Null;
    }
    let departure = seconds(v, &["departure"], &["departureMinutes", "departMinutes"]);
    let arrival = seconds(v, &["arrival"], &["arrivalMinutes", "arriveMinutes"]);
    if departure.is_null() || arrival.is_null() {
        return Value::Null;
    }
    let mut legs: Vec<_> = v["legs"]
        .as_array()
        .map(|a| a.iter().map(|v| leg(v, geometry)).collect())
        .unwrap_or_default();
    if let Some(segments) = v["segments"].as_array() {
        for segment in segments {
            if let Some(part) = journey(segment, geometry)["legs"].as_array() {
                legs.extend(part.clone());
            }
        }
    }
    let boardings = v["boardings"]
        .as_f64()
        .map(|n| n as u64)
        .unwrap_or_else(|| legs.iter().filter(|l| l["type"] == "transit").count() as u64);
    let mut out = json!({"departureTime":clock(&departure),"arrivalTime":clock(&arrival),
        "durationSeconds":arrival.as_i64().unwrap()-departure.as_i64().unwrap(),
        "walkingSeconds":seconds(v,&["walkingSeconds"],&["walkMinutes"]),
        "waitingSeconds":seconds(v,&["waitingSeconds"],&["waitMinutes"]),
        "ridingSeconds":seconds(v,&["rideSeconds"],&["rideMinutes"]),
        "boardings":boardings,"transfers":boardings.saturating_sub(1),"legs":legs});
    // Rounded public clocks determine elapsed durations. Component rounding
    // is independent; retain unknown values instead of inventing evidence.
    let mut walking = 0i64;
    let mut riding = 0i64;
    let mut driving = 0i64;
    for l in out["legs"].as_array().unwrap() {
        let duration = l["durationSeconds"].as_i64().unwrap_or(0);
        match l["type"].as_str() {
            Some("walk") => walking += duration,
            Some("transit") => riding += duration,
            Some("drive") => driving += duration,
            _ => (),
        }
    }
    if !out["legs"].as_array().unwrap().is_empty() {
        out["walkingSeconds"] = json!(walking);
        out["ridingSeconds"] = json!(riding);
        out["waitingSeconds"] =
            json!((out["durationSeconds"].as_i64().unwrap() - walking - riding - driving).max(0));
        if driving > 0 {
            out["drivingSeconds"] = json!(driving);
        }
    }
    if let Some(t) = v.get("transfers") {
        out["transfers"] = integer(t);
    }
    out
}
fn digest(v: &Value) -> String {
    format!("{:x}", Sha256::digest(serde_json::to_vec(v).unwrap()))
}
fn request_id() -> String {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let time = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!(
        "vigo-{:x}-{time:x}-{:x}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    )
}
pub fn validate(request: &Value) -> Result<(), String> {
    if request.get("diagnostics").is_some_and(|v| {
        !["none", "summary", "profile", "trace"]
            .iter()
            .any(|s| v == s)
    }) {
        return Err("diagnostics must be none, summary, profile, or trace".into());
    }
    for key in ["includeGeometry", "includeLimitations"] {
        if request.get(key).is_some_and(|v| !v.is_boolean()) {
            return Err(format!("{key} must be boolean"));
        }
    }
    Ok(())
}
/// Accept public stop references without changing the kernel's scoped IDs.
pub fn normalize_points(v: &mut Value) -> Result<(), String> {
    match v {
        Value::Array(a) => {
            for x in a {
                normalize_points(x)?;
            }
        }
        Value::Object(o) => {
            if let Some(stop) = o.remove("stop") {
                let id = stop["id"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .ok_or("stop.id must be a nonempty string")?;
                if o.contains_key("stopId") {
                    return Err("Supply stop or stopId, not both".into());
                }
                let feed = stop
                    .get("feed")
                    .filter(|f| !f.is_null())
                    .map(|f| f.as_str().ok_or("stop.feed must be a string or null"))
                    .transpose()?;
                if id.contains('\u{1f}')
                    || feed.is_some_and(|f| f.is_empty() || f.contains('\u{1f}'))
                {
                    return Err("Invalid public stop reference".into());
                }
                o.insert(
                    "stopId".into(),
                    json!(feed.map_or_else(|| id.to_owned(), |f| format!("{f}\u{1f}{id}"))),
                );
            }
            for x in o.values_mut() {
                normalize_points(x)?;
            }
        }
        _ => (),
    }
    Ok(())
}
fn summary(raw: &Value) -> Value {
    let d = if raw["result"]["diagnostics"].is_object() {
        &raw["result"]["diagnostics"]
    } else {
        &raw["diagnostics"]
    };
    let nested = pick(d, &["native", "transit", "searchStats"]);
    let n = if nested.is_null() { d } else { nested };
    let mut out = json!({});
    for key in [
        "scannedDepartures",
        "expandedTripRuns",
        "relaxedStops",
        "dominatedTripBoardings",
        "explicitTransferChecks",
        "forwardSearches",
        "reverseSearches",
    ] {
        if let Some(v) = n
            .get(key)
            .or_else(|| d.get(key))
            .or_else(|| d["searchStats"]["tripExpansion"].get(key))
        {
            out[key] = integer(v);
        }
    }
    for (dst, src) in [
        ("originCandidates", "originAccess"),
        ("destinationCandidates", "destinationAccess"),
    ] {
        if let Some(a) = d[src]["memberIndices"].as_array() {
            out[dst] = json!(a.len());
        }
    }
    for (dst, src) in [
        ("originCandidates", "originStopCandidates"),
        ("destinationCandidates", "destinationStopCandidates"),
    ] {
        if out.get(dst).is_none() {
            if let Some(a) = d[src].as_array() {
                out[dst] = json!(a.len());
            } else if d[src].is_number() {
                out[dst] = integer(&d[src]);
            }
        }
    }
    if let Some(algorithm) = d["algorithm"].as_str().or_else(|| n["algorithm"].as_str()) {
        out["algorithm"] = json!(algorithm);
    }
    if d["originAccess"]["cchAccelerated"].is_boolean() {
        out["cchAccelerated"] = d["originAccess"]["cchAccelerated"].clone();
    }
    out
}
fn profile(v: &Value, prefix: &str, out: &mut Value) {
    if let Some(obj) = v.as_object() {
        for (k, v) in obj {
            let path = if prefix.is_empty() {
                k.clone()
            } else {
                format!("{prefix}.{k}")
            };
            if (k.ends_with("Ms") || k.ends_with("Ns")) && v.is_number() {
                let us = v.as_f64().unwrap() * if k.ends_with("Ms") { 1000. } else { 0.001 };
                out[format!("{}Us", &path[..path.len() - 2])] = json!(us.round() as i64);
            } else if v.is_object() {
                profile(v, &path, out);
            }
        }
    }
}
fn convert_minutes(v: &Value) -> Value {
    if let Some(a) = v.as_array() {
        json!(a.iter().map(convert_minutes).collect::<Vec<_>>())
    } else {
        v.as_f64()
            .filter(|n| *n >= 0.)
            .map_or(Value::Null, |n| json!((n * 60.).round() as i64))
    }
}
/// Both transports and the Node addon call this exact projection.
pub fn format(kind: &str, request: &Value, raw: &Value) -> Value {
    if kind == "native" {
        return raw.clone();
    }
    if kind == "compare" {
        if raw.get("before").is_some() {
            return compare(&raw["before"], &raw["after"]).unwrap_or_else(|e| error(&e));
        }
        let mut result = json!({"schema":"vigo.compare.v1","status":"ok","counts":{"comparable":raw["commonCells"],"newlyReachable":raw["newlyReachableCells"],"noLongerReachable":raw["noLongerReachableCells"]},"meanChangeSeconds":raw["meanChangeMinutes"].as_f64().map(|n|n*60.)});
        if request["diagnostics"] == "trace" {
            result["trace"] = raw.clone();
        }
        return result;
    }
    let kind = if kind == "isochrone" { "reach" } else { kind };
    let q = if raw["query"].is_object() {
        &raw["query"]
    } else {
        request
    };
    let plan = if raw["result"].is_object() {
        &raw["result"]
    } else {
        raw
    };
    let geometry = request["includeGeometry"]
        .as_bool()
        .unwrap_or(kind == "route");
    let compute = pick(&raw["timing"], &["computeMs", "totalMs"]).as_f64();
    let revision = pick(raw, &["cityRevision", "revisionId"])
        .as_str()
        .or_else(|| raw["city"]["revisionId"].as_str());
    let mut fingerprint_query = q.clone();
    if let Some(o) = fingerprint_query.as_object_mut() {
        for k in [
            "id",
            "kind",
            "diagnostics",
            "includeGeometry",
            "includeLimitations",
        ] {
            o.remove(k);
        }
    }
    // Hash supplied observation/scenario content, never expose entire snapshots.
    for key in ["realtimeSnapshot", "scenario"] {
        if let Some(v) = request.get(key) {
            fingerprint_query[key] = v.clone();
        }
    }
    let mut meta = json!({"engineVersion":env!("CARGO_PKG_VERSION"),"cityRevision":revision,
        "requestId":request.get("id").cloned().unwrap_or_else(||json!(request_id())),
        "queryFingerprint":digest(&json!({"kind":kind,"query":fingerprint_query,"cityRevision":revision})),
        "computeUs":compute.map(|n|(n*1000.).round() as i64),
        "computeScope":if raw["runtime"] == "rust" {"query_dispatch_including_materialization"} else {"routing_call"}});
    for key in ["realtimeSnapshot", "scenario"] {
        if let Some(v) = request.get(key).filter(|v| !v.is_null()) {
            meta[format!("{key}Fingerprint")] = json!(digest(v));
        }
    }
    let requested = if let Some(t) = q["time"].as_str() {
        json!(if t.len() == 5 {
            format!("{t}:00")
        } else {
            t.to_owned()
        })
    } else {
        let t = seconds(q, &[], &["timeMinutes", "time"]);
        clock(&if t.is_null() { json!(28800) } else { t })
    };
    let mut query = json!({"serviceDate":pick(q,&["serviceDate"]),"timePreference":if ["arrive","arrive_by"].iter().any(|s|q["timePreference"]==*s) {"arrive_by"} else {"depart_at"},"requestedTime":requested});
    if query["serviceDate"].is_null() {
        query["serviceDate"] = raw["serviceDate"].clone();
    }
    query["dataMode"] = pick(q, &["routingDataMode", "dataMode"])
        .as_str()
        .map_or(json!("scheduled"), |s| json!(s));
    for key in ["origin", "destination"] {
        if !q[key].is_null() {
            query[key] = point(&q[key]);
        }
    }
    let mut out = json!({"schema":format!("vigo.{kind}.v1"),"status":"ok","mode":pick(q,&["mode"]),"query":query,"meta":meta});
    if !pick(plan, &["mode", "travelMode"]).is_null() {
        out["mode"] = pick(plan, &["mode", "travelMode"]).clone();
    }
    if out["mode"].is_null() {
        out["mode"] = json!("transit");
    }
    match kind {
        "route" => {
            out["journey"] = journey(plan, geometry);
            if let Some(legs) = out
                .get_mut("journey")
                .and_then(|j| j.get_mut("legs"))
                .and_then(Value::as_array_mut)
                && legs.len() == 1
                && ["walk", "drive"]
                    .iter()
                    .any(|kind| legs[0]["type"] == *kind)
            {
                if legs[0]["from"] == json!({}) {
                    legs[0]["from"] = point(&q["origin"]);
                }
                if legs[0]["to"] == json!({}) {
                    legs[0]["to"] = point(&q["destination"]);
                }
            }
            if out["journey"].is_null() {
                out["status"] = json!("not_found");
                out["reason"] = json!({"code":pick(plan,&["reason"]).as_str().unwrap_or("no_path"),"message":"No journey found within the requested constraints."});
            } else {
                let inferred = out["journey"]["legs"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|l| l["quality"]["stationPath"] == "inferred");
                if inferred {
                    out["warnings"] = json!([{"code":"station_path_inferred","message":"Part of this journey uses inferred station access; physical passage is not fully verified."}]);
                }
            }
            if let Some(choices) = pick(raw, &["choices", "journeys"]).as_array() {
                out["alternatives"] = json!(
                    choices
                        .iter()
                        .map(|v| journey(v, geometry))
                        .collect::<Vec<_>>()
                );
            }
        }
        "matrix" => {
            if let Some(distances) = raw.get("distancesMeters") {
                out["distancesMeters"] = distances.clone();
            }

            for key in ["origins", "destinations"] {
                if let Some(a) = q[key].as_array() {
                    out["query"][key] = json!(
                        a.iter()
                            .map(|v| {
                                let p = if v["point"].is_null() { v } else { &v["point"] };
                                let mut result = point(p);
                                if let Some(id) = v.get("id") {
                                    result["id"] = id.clone();
                                }
                                result
                            })
                            .collect::<Vec<_>>()
                    );
                }
            }
            if raw["durationsMinutes"].is_array() {
                out["durationsSeconds"] = convert_minutes(&raw["durationsMinutes"]);
                if let Some(rows) = raw["journeys"].as_array() {
                    out["journeys"] = json!(
                        rows.iter()
                            .map(|r| r.as_array().map(|a| a
                                .iter()
                                .map(|v| journey(v, geometry))
                                .collect::<Vec<_>>()))
                            .collect::<Vec<_>>()
                    );
                }
            } else if let Some(rows) = raw["rows"].as_array() {
                let origin_count = q["origins"].as_array().map_or(0, Vec::len);
                let destination_count = q["destinations"].as_array().map_or(0, Vec::len);
                let mut durations = vec![vec![Value::Null; destination_count]; origin_count];
                let mut journeys = durations.clone();
                let mut has_journeys = false;
                for row in rows {
                    if let (Some(i), Some(j)) = (
                        row["originIndex"].as_u64(),
                        row["destinationIndex"].as_u64(),
                    ) && i < origin_count as u64
                        && j < destination_count as u64
                    {
                        durations[i as usize][j as usize] =
                            convert_minutes(&row["durationMinutes"]);
                        if let Some(v) = row.get("journey") {
                            has_journeys = true;
                            journeys[i as usize][j as usize] = journey(v, geometry);
                        }
                    }
                }
                out["durationsSeconds"] = json!(durations);
                if has_journeys {
                    out["journeys"] = json!(journeys);
                }
            }
        }
        "reach" => {
            for key in ["stops", "scenarioStops"] {
                if let Some(a) = raw[key].as_array() {
                    out[key] = json!(
                        a.iter()
                            .map(|v| {
                                let mut p = point(v);
                                p["durationSeconds"] = seconds(v, &[], &["durationMinutes"]);
                                p
                            })
                            .collect::<Vec<_>>()
                    );
                }
            }

            out["cutoffsSeconds"] = convert_minutes(pick(raw, &["cutoffsMinutes"]));
            if out["cutoffsSeconds"].is_null() {
                out["cutoffsSeconds"] = convert_minutes(&q["cutoffsMinutes"]);
            }
            for key in ["contours", "areas", "fullContours", "fullAreas"] {
                if let Some(v) = raw.get(key) {
                    out[key] = v.clone();
                }
            }
            let s = &raw["surface"];
            out["surface"] = json!({"width":s["width"],"height":s["height"],"bounds":s["bounds"],"valuesSeconds":convert_minutes(&s["values"])});
            if s["fullValues"].is_array() {
                out["fullSurface"] = json!({"width":s["width"],"height":s["height"],"bounds":s["fullBounds"],"valuesSeconds":convert_minutes(&s["fullValues"])});
            }
            for key in ["edges", "nodes"] {
                if !s[key].is_null() {
                    out["surface"][key] = s[key].clone();
                }
            }
        }
        "info" | "inspect" => {
            out = json!({"schema":"vigo.info.v1","status":"ok","name":raw["name"],"revision":revision,
                "counts":raw["counts"],"sources":public_sources(&raw["sources"]),"datasetLimitations":pick(raw,&["datasetLimitations","warnings"]),"engineVersion":env!("CARGO_PKG_VERSION")});
            if out["counts"].is_null() {
                out["counts"] = json!({"routes":raw["routing"]["routeCount"],"stops":raw["routing"]["stopCount"],"trips":raw["routing"]["tripCount"],"connections":raw["routing"]["connectionCount"],"streetNodes":raw["streets"]["nodeCount"],"streetEdges":raw["streets"]["edgeCount"]});
            }
        }
        _ => return raw.clone(),
    }
    if matches!(kind, "route" | "matrix" | "reach") {
        let realtime = pick(&plan["diagnostics"], &["realtime", "realtimeRouting"]);
        if !realtime.is_null() {
            out["meta"]["realtime"] = realtime.clone();
        }
        if !raw["dataMode"].is_null() {
            out["query"]["dataMode"] = raw["dataMode"].clone();
        }
        let reserves = &plan["diagnostics"]["timeReserves"];
        if reserves.is_object() {
            out["query"]["arrivalReserveSeconds"] =
                seconds(reserves, &[], &["arrivalBufferMinutes"]);
            out["query"]["planningArrivalTime"] =
                clock(&seconds(reserves, &[], &["planningArrivalMinutes"]));
        }
    }
    let level = request["diagnostics"].as_str().unwrap_or("none");
    if level != "none" {
        out["diagnostics"] = summary(raw);
    }
    if ["profile", "trace"].contains(&level) {
        let mut timings = json!({});
        profile(&raw["timing"], "timing", &mut timings);
        profile(&plan["diagnostics"], "diagnostics", &mut timings);
        out["profile"] = json!({"timingsUs":timings,"note":"Measured scopes may overlap. Compute excludes public formatting, JSON serialization, queueing and network time."});
    }
    if request["includeLimitations"] == true {
        out["datasetLimitations"] = raw.get("warnings").cloned().unwrap_or(json!([]));
    }
    clean(&mut out);
    // Trace is intentionally an unstable, lossless copy of the internal ABI.
    if level == "trace" {
        out["trace"] = raw.clone();
    }
    if let Some(id) = request.get("id") {
        out["id"] = id.clone();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn clean_journey_and_opt_in_trace() {
        let q =
            json!({"time":"25:00","serviceDate":"2026-10-05","origin":{"stopId":"mbta\u{001f}A"}});
        let raw = json!({"status":"ready","departure":90000,"arrival":90660,"walkingSeconds":60,"waitingSeconds":0,"rideSeconds":600,"boardings":1,"legs":[{"kind":"ride","fromStopId":"mbta\u{001f}A","toStopId":"mbta\u{001f}B","tripId":"mbta\u{001f}T","routeId":"mbta\u{001f}R","departure":90060,"arrival":90660,"trip":4294967295u64}],"diagnostics":{"native":{"scannedDepartures":12.0}},"warnings":["global limitation"]});
        let out = format("route", &q, &raw);
        assert_eq!(out["journey"]["arrivalTime"], "25:11:00");
        assert_eq!(out["journey"]["durationSeconds"], 660);
        assert_eq!(
            out["journey"]["legs"][0]["from"]["stop"],
            json!({"feed":"mbta","id":"A"})
        );
        assert!(out.get("diagnostics").is_none());
        assert!(out.get("warnings").is_none());
        assert!(!out.to_string().contains("4294967295"));
        assert!(!out.to_string().contains("\\u001f"));
        let mut debug = q.clone();
        debug["diagnostics"] = json!("trace");
        let trace = format("route", &debug, &raw);
        assert_eq!(trace["trace"], raw);
        assert_eq!(trace["diagnostics"]["scannedDepartures"].as_u64(), Some(12));
        assert_eq!(
            trace["meta"]["queryFingerprint"],
            out["meta"]["queryFingerprint"]
        );
        assert_ne!(trace["meta"]["requestId"], out["meta"]["requestId"]);
    }
    #[test]
    fn public_ids_round_trip_and_options_validate() {
        let mut q = json!({"origin":{"stop":{"feed":"mbta","id":"A:B"}}});
        normalize_points(&mut q).unwrap();
        assert_eq!(q["origin"]["stopId"], "mbta\u{001f}A:B");
        assert!(validate(&json!({"diagnostics":true})).is_err());
        assert!(validate(&json!({"includeGeometry":"false"})).is_err());
    }
}

pub fn error(message: &str) -> Value {
    let (code, public_message) = if message.starts_with("Unknown stop") {
        (
            "stop_not_found",
            "A requested stop is not present in this City.",
        )
    } else if message.contains("No such file") || message.contains("file not found") {
        (
            "file_not_found",
            "The requested input or City file was not found.",
        )
    } else if message.contains("Permission denied") {
        (
            "permission_denied",
            "VIGO cannot read or write a required file.",
        )
    } else if message.contains("os error")
        || message.contains("SQLite")
        || message.contains("SQLITE")
    {
        (
            "city_unavailable",
            "The City could not be opened. Check its files and rebuild if necessary.",
        )
    } else {
        ("invalid_request", message)
    };
    json!({"schema":"vigo.error.v1","status":"error","error":{"code":code,"message":public_message}})
}

pub fn compare(before: &Value, after: &Value) -> Result<Value, String> {
    if before["schema"] != after["schema"] {
        return Err("compare requires results from the same query family".into());
    }
    let schema = before["schema"].as_str().unwrap_or("");
    let mut out = json!({"schema":"vigo.compare.v1","status":"ok","beforeStatus":before["status"],"afterStatus":after["status"],
        "cityRevisions":{"before":before["meta"]["cityRevision"],"after":after["meta"]["cityRevision"]}});
    if schema == "vigo.route.v1" {
        out["durationChangeSeconds"] = match (
            before["journey"]["durationSeconds"].as_i64(),
            after["journey"]["durationSeconds"].as_i64(),
        ) {
            (Some(a), Some(b)) => json!(b - a),
            _ => Value::Null,
        };
        out["transferChange"] = match (
            before["journey"]["transfers"].as_i64(),
            after["journey"]["transfers"].as_i64(),
        ) {
            (Some(a), Some(b)) => json!(b - a),
            _ => Value::Null,
        };
        return Ok(out);
    }
    let (a, b) = match schema {
        "vigo.reach.v1" => {
            for key in ["width", "height", "bounds"] {
                if before["surface"][key] != after["surface"][key] {
                    return Err("Reach results require the same grid".into());
                }
            }
            (
                &before["surface"]["valuesSeconds"],
                &after["surface"]["valuesSeconds"],
            )
        }
        "vigo.matrix.v1" => {
            for key in ["origins", "destinations"] {
                if before["query"][key] != after["query"][key] {
                    return Err("Matrix results require the same ordered endpoints".into());
                }
            }
            (&before["durationsSeconds"], &after["durationsSeconds"])
        }
        _ => return Err("Unsupported public result schema for compare".into()),
    };
    fn flatten(v: &Value, out: &mut Vec<Option<i64>>) -> Result<(), String> {
        if let Some(a) = v.as_array() {
            for x in a {
                flatten(x, out)?;
            }
        } else if v.is_null() {
            out.push(None);
        } else if let Some(n) = v.as_i64().filter(|n| *n >= 0) {
            out.push(Some(n));
        } else {
            return Err("Comparison values must be nonnegative integer seconds or null".into());
        }
        Ok(())
    }
    if !a.is_array() || !b.is_array() {
        return Err("Comparison requires result arrays".into());
    }
    let (mut av, mut bv) = (vec![], vec![]);
    flatten(a, &mut av)?;
    flatten(b, &mut bv)?;
    if av.len() != bv.len() || av.is_empty() {
        return Err("Comparison dimensions differ or are empty".into());
    }
    if schema == "vigo.reach.v1"
        && before["surface"]["width"]
            .as_u64()
            .zip(before["surface"]["height"].as_u64())
            .is_none_or(|(w, h)| w == 0 || h == 0 || w.checked_mul(h) != Some(av.len() as u64))
    {
        return Err("Invalid Reach dimensions".into());
    }
    let (mut common, mut newly, mut lost, mut faster, mut slower, mut sum) = (0, 0, 0, 0, 0, 0i64);
    for (a, b) in av.into_iter().zip(bv) {
        match (a, b) {
            (Some(a), Some(b)) => {
                common += 1;
                sum += b - a;
                if b < a {
                    faster += 1;
                } else if b > a {
                    slower += 1;
                }
            }
            (None, Some(_)) => newly += 1,
            (Some(_), None) => lost += 1,
            _ => (),
        }
    }
    out["counts"] = json!({"comparable":common,"faster":faster,"slower":slower,"unchanged":common-faster-slower,"newlyReachable":newly,"noLongerReachable":lost});
    out["meanChangeSeconds"] = if common > 0 {
        json!(sum as f64 / common as f64)
    } else {
        Value::Null
    };
    Ok(out)
}

fn public_sources(v: &Value) -> Value {
    let gtfs = v["gtfs"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|s| json!({"name":s["name"],"feed":pick(s,&["scope","feed"])}))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    json!({"gtfs":gtfs,"osm":if v["osm"].is_object() {json!({"name":v["osm"]["name"]})}else{Value::Null}})
}

#[cfg(test)]
mod regressions {
    use super::*;
    #[test]
    fn no_journey_stays_null() {
        let result = format(
            "route",
            &json!({}),
            &json!({"status":"blocked","reason":"no_path"}),
        );
        assert_eq!(result["status"], "not_found");
        assert!(result["journey"].is_null());
    }
    #[test]
    fn compare_rejects_incompatible_grids() {
        let a = json!({"schema":"vigo.reach.v1","surface":{"width":1,"height":1,"bounds":[0,0,1,1],"valuesSeconds":[100]}});
        let mut b = a.clone();
        b["surface"]["valuesSeconds"] = json!([80]);
        assert_eq!(compare(&a, &b).unwrap()["meanChangeSeconds"], -20.);
        b["surface"]["width"] = json!(2);
        assert!(compare(&a, &b).is_err());
    }
}

/// A terminal view over the public result, never over engine structs.
pub fn text(result: &Value) -> Option<String> {
    if result["schema"] != "vigo.route.v1" || result.get("diagnostics").is_some() {
        return None;
    }
    if result["status"] == "not_found" {
        return Some("No journey found within the requested constraints.\n".into());
    }
    let j = &result["journey"];
    let mut text = format!(
        "{} → {} · {:.1} min · {} transfer(s)\n",
        j["departureTime"].as_str()?,
        j["arrivalTime"].as_str()?,
        j["durationSeconds"].as_f64()? / 60.,
        j["transfers"]
    );
    for leg in j["legs"].as_array()? {
        if leg["durationSeconds"] == 0 {
            continue;
        }
        let label = if leg["type"] == "transit" {
            leg["route"]["name"].as_str().unwrap_or("Transit")
        } else {
            leg["type"].as_str().unwrap_or("Travel")
        };
        let from = leg["from"]["name"].as_str().unwrap_or("Origin");
        let to = leg["to"]["name"].as_str().unwrap_or("Destination");
        text.push_str(&format!(
            "  {}  {}  {} → {} ({:.1} min)\n",
            leg["departureTime"].as_str().unwrap_or(""),
            label,
            from,
            to,
            leg["durationSeconds"].as_f64().unwrap_or(0.) / 60.
        ));
    }
    if let Some(warnings) = result["warnings"].as_array() {
        for warning in warnings {
            if let Some(message) = warning["message"].as_str() {
                text.push_str(&format!("Note: {message}\n"));
            }
        }
    }
    Some(text)
}
