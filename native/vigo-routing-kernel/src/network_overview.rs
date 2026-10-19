//! Read-only City overview construction. SQLite traversal and geometry remain
//! on the libuv pool for Studio; no new prepared-data tables are required.
#[path = "network_overview_sql.rs"]
mod sql;
use crate::decimal_rounding::rounded;
use rusqlite::{Connection, OpenFlags, Params, types::ValueRef};
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::time::Duration;
const MAX_ROWS: usize = 1_000_000;
const MAX_COORDINATES: usize = 4_000_000;
fn rows(db: &Connection, sql: &str, params: impl Params) -> Result<Vec<Value>, String> {
    let mut statement = db.prepare_cached(sql).map_err(|e| e.to_string())?;
    let mut rows = statement.query(params).map_err(|e| e.to_string())?;
    let mut output = vec![];
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        if output.len() >= MAX_ROWS {
            return Err("City overview exceeds the row budget".into());
        }
        let mut fields = Map::new();
        for i in 0..row.as_ref().column_count() {
            let value = match row.get_ref(i).map_err(|e| e.to_string())? {
                ValueRef::Null => Value::Null,
                ValueRef::Integer(v) => json!(v),
                ValueRef::Real(v) => json!(v),
                ValueRef::Text(v) => {
                    Value::String(std::str::from_utf8(v).map_err(|e| e.to_string())?.into())
                }
                ValueRef::Blob(_) => return Err("Unexpected binary value in City overview".into()),
            };
            fields.insert(
                row.as_ref()
                    .column_name(i)
                    .map_err(|e| e.to_string())?
                    .into(),
                value,
            );
        }
        output.push(Value::Object(fields));
    }
    Ok(output)
}
fn text<'a>(v: &'a Value, name: &str) -> &'a str {
    v[name].as_str().unwrap_or("")
}
fn number(v: &Value, name: &str, fallback: f64) -> f64 {
    match v.get(name) {
        None => fallback,
        Some(Value::Null) => 0.,
        Some(Value::String(s)) => {
            if s.trim().is_empty() {
                0.
            } else {
                s.parse().unwrap_or(fallback)
            }
        }
        Some(v) => v.as_f64().filter(|v| v.is_finite()).unwrap_or(fallback),
    }
}
fn stop(row: &Value, prefix: &str) -> Option<Value> {
    let lon = number(row, &format!("{prefix}_lon"), f64::NAN);
    let lat = number(row, &format!("{prefix}_lat"), f64::NAN);
    if !lon.is_finite() || !lat.is_finite() {
        return None;
    }
    let id = text(row, &format!("{prefix}_stop_id"));
    let name = text(row, &format!("{prefix}_name"));
    let mut s = json!({"id":id,"name":if name.is_empty(){id}else{name},"lon":lon,"lat":lat,"x":0,"y":0,"locationType":row.get(format!("{prefix}_location_type")).filter(|v|!v.is_null()).unwrap_or(&json!(0)),"routes":[],"tripCount":0,"transferScore":0});
    for (source, target) in [
        ("parent_station", "parentStationId"),
        ("platform_code", "platformCode"),
    ] {
        let value = text(row, &format!("{prefix}_{source}"));
        if !value.is_empty() {
            s[target] = json!(value);
        }
    }
    Some(s)
}
fn path(rows: &[Value]) -> Vec<Value> {
    let mut result = vec![];
    for (i, row) in rows.iter().enumerate() {
        if (i == 0 || row["from_stop_id"] != rows[i - 1]["to_stop_id"])
            && let Some(s) = stop(row, "from")
        {
            result.push(s);
        }
        if let Some(s) = stop(row, "to") {
            result.push(s);
        }
    }
    result
}
fn valid(p: &[f64; 2]) -> bool {
    p[0].is_finite()
        && p[1].is_finite()
        && (-180. ..=180.).contains(&p[0])
        && (-90. ..=90.).contains(&p[1])
}
fn distance(line: &[[f64; 2]]) -> f64 {
    line.windows(2)
        .map(|pair| {
            let (a, b) = (pair[0], pair[1]);
            let radians = |v: f64| v * std::f64::consts::PI / 180.;
            let value = (radians(b[1] - a[1]) / 2.).sin().powi(2)
                + radians(a[1]).cos()
                    * radians(b[1]).cos()
                    * (radians(b[0] - a[0]) / 2.).sin().powi(2);
            6371.0088 * 2. * value.sqrt().atan2((1. - value).sqrt())
        })
        .fold(0., |total, value| total + value)
}
fn read(store: &str, scope: &str) -> Result<String, String> {
    if scope.len() > 4096 {
        return Err("City overview source scope is too long".into());
    }
    let db = Connection::open_with_flags(
        store,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| e.to_string())?;
    db.busy_timeout(Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    db.execute_batch("BEGIN").map_err(|e| e.to_string())?;
    let current = rows(
        &db,
        "SELECT value FROM metadata WHERE key='routeServiceCatalogVersion'",
        [],
    )
    .ok()
    .and_then(|v| v.first().cloned())
    .and_then(|v| serde_json::from_str::<String>(text(&v, "value")).ok())
    .is_some_and(|v| v == "vigo.routing.route-services.v2");
    let services = if current {
        rows(&db, sql::SERVICES, [scope])?
    } else {
        rows(
            &db,
            sql::SERVICES_LEGACY,
            [
                scope,
                &format!("{scope}\u{1f}"),
                &format!("{scope}\u{1f}\u{ffff}"),
            ],
        )?
    };
    let total: f64 = services
        .iter()
        .map(|s| number(s, "trip_count", 0.))
        .fold(0., |total, value| total + value);
    let mut shapes = HashMap::<String, Vec<[f64; 2]>>::new();
    let mut shape_points = 0;
    let mut stop_ids = HashMap::<String, usize>::new();
    let mut stops: Vec<Value> = vec![];
    let mut routes = vec![];
    let (mut scanned, mut geometry_count, mut shape_count, mut coordinates_count) = (0, 0, 0, 0);
    for service in &services {
        let id = text(service, "representative_route_id");
        let Some(mut trip) = rows(&db, sql::REPRESENTATIVE_TRIP, [id])?
            .into_iter()
            .next()
        else {
            continue;
        };
        let mut connections = rows(&db, sql::CONNECTIONS, [text(&trip, "trip_id")])?;
        let mut path_stops = path(&connections);
        if path_stops.len() < 2 {
            for candidate in rows(&db, sql::CANDIDATE_TRIPS, [id])? {
                if candidate["trip_id"] == trip["trip_id"] {
                    continue;
                }
                let candidate_rows = rows(&db, sql::CONNECTIONS, [text(&candidate, "trip_id")])?;
                let candidate_stops = path(&candidate_rows);
                if candidate_stops.len() < 2 {
                    continue;
                }
                trip = candidate;
                connections = candidate_rows;
                path_stops = candidate_stops;
                break;
            }
        }
        scanned += connections.len();
        let shape_id = text(&trip, "shape_id");
        if !shape_id.is_empty() && !shapes.contains_key(shape_id) {
            let points: Vec<_> = rows(&db, sql::SHAPE_POINTS, [shape_id])?
                .iter()
                .map(|p| [number(p, "lon", f64::NAN), number(p, "lat", f64::NAN)])
                .filter(valid)
                .collect();
            shape_points += points.len();
            if shape_points > MAX_COORDINATES {
                return Err("City overview exceeds the shape budget".into());
            }
            shapes.insert(shape_id.into(), points);
        }
        let shape = shapes.get(shape_id).filter(|p| p.len() >= 2);
        let coordinates: Vec<_> = shape.cloned().unwrap_or_else(|| {
            path_stops
                .iter()
                .map(|p| [number(p, "lon", f64::NAN), number(p, "lat", f64::NAN)])
                .filter(valid)
                .collect()
        });
        coordinates_count += coordinates.len();
        if coordinates_count > MAX_COORDINATES {
            return Err("City overview exceeds the coordinate budget".into());
        }
        geometry_count += usize::from(coordinates.len() >= 2);
        shape_count += usize::from(shape.is_some());
        let stats = rows(&db, sql::SERVICE_STATS, [id])?
            .into_iter()
            .next()
            .unwrap_or(Value::Null);
        let first = connections
            .first()
            .map_or(f64::NAN, |r| number(r, "departure", f64::NAN));
        let last = connections
            .last()
            .map_or(f64::NAN, |r| number(r, "arrival", f64::NAN));
        let start = number(&stats, "first_departure", first);
        let end = number(&stats, "last_arrival", last);
        let trip_count = number(service, "trip_count", 0.);
        let scheduled = number(&stats, "trip_count", trip_count).max(1.);
        let runtime = number(&stats, "runtime_seconds", 0.).max(0.);
        let average = if runtime > 0. {
            runtime / scheduled
        } else {
            (last - first).max(0.)
        };
        let gaps = number(&stats, "headway_gap_count", 0.).max(0.);
        let headway = if gaps > 0. {
            (number(&stats, "headway_span_seconds", 0.) / gaps / 60.)
                .round()
                .max(1.)
        } else {
            0.
        };
        let span = if start.is_finite() && end.is_finite() {
            (end - start).max(0.) / 3600.
        } else {
            0.
        };
        let km = distance(&coordinates);
        let short = text(service, "short_name");
        let long = text(service, "long_name");
        let mut route = json!({"id":id,"routeId":id,"patternId":id,"routeType":number(service,"route_type",3.),"shortName":if !short.is_empty(){short}else if !long.is_empty(){long}else{id},
            "color":service["color"],"tripCount":trip_count,"stopCount":path_stops.len(),"headwayMinutes":headway,"spanHours":rounded(span,2),"serviceHours":rounded(runtime/3600.,2),"serviceShare":if total>0.{trip_count/total}else{0.},
            "frequencyClass":if headway>0. && headway<=15.{"high"}else if headway>0. && headway<=30.{"medium"}else{"low"},"patternRank":routes.len()+1,"serviceVariantCount":number(service,"variant_count",1.).max(1.),
            "geometrySource":if shape.is_some(){"shape"}else{"stop_sequence"},"distanceKm":rounded(km,2),"scheduledSpeedKph":if average>0.{rounded(km/(average/3600.),1)}else{0.},
            "stopPairCount":path_stops.len().saturating_sub(1),"segmentCount":path_stops.len().saturating_sub(1),"status":"baseline","coordinates":coordinates,"points":[],"stopIds":path_stops.iter().map(|s|&s["id"]).collect::<Vec<_>>(),
            "_display":[short,long,path_stops.first().map(|s|text(s,"name")).unwrap_or(""),path_stops.last().map(|s|text(s,"name")).unwrap_or("")]});
        if !trip["direction_id"].is_null() {
            route["directionId"] = trip["direction_id"].clone();
        }
        if shape.is_some() {
            route["shapeId"] = json!(shape_id);
        }
        if start.is_finite() {
            route["firstDepartureMinutes"] = json!(rounded(start / 60., 3));
        }
        if end.is_finite() {
            route["lastArrivalMinutes"] = json!(rounded(end / 60., 3));
        }
        routes.push(route);
        for source in path_stops {
            let sid = text(&source, "id");
            let index = *stop_ids.entry(sid.into()).or_insert_with(|| {
                stops.push(source.clone());
                stops.len() - 1
            });
            let stop = &mut stops[index];
            if !stop["routes"]
                .as_array()
                .unwrap()
                .iter()
                .any(|v| v.as_str() == Some(id))
            {
                stop["routes"].as_array_mut().unwrap().push(json!(id));
                stop["tripCount"] = json!(number(stop, "tripCount", 0.) + trip_count);
            }
        }
        if stops.len() > MAX_ROWS {
            return Err("City overview exceeds the stop budget".into());
        }
    }
    for stop in &mut stops {
        stop["transferScore"] = json!(
            (stop["routes"].as_array().unwrap().len() as f64 * 24.
                + number(stop, "tripCount", 0.).max(1.).log10() * 18.)
                .min(100.)
        );
    }
    let trips: f64 = routes
        .iter()
        .map(|r| number(r, "tripCount", 0.))
        .fold(0., |total, value| total + value);
    let mut coverage = json!({"rawRouteRows":services.len(),"publicRouteIdentities":routes.len(),"tripsIndexed":trips,"stopTimesScanned":scanned,"stopsIndexed":stops.len(),"stopPairsIndexed":0,"capped":false,"timetableDeferred":false,"previewStrategy":"sqlite-complete-service-atlas-v1","tripCountStrategy":"route-identity-catalog","routeGeometryIndexed":geometry_count,"routeGeometryComplete":geometry_count==routes.len(),"shapeGeometryIndexed":shape_count});
    if !scope.is_empty() {
        coverage["sourceScope"] = json!(scope);
    }
    serde_json::to_string(
        &json!({"routes":routes,"stops":stops,"stopPairs":[],"coverage":coverage}),
    )
    .map_err(|e| e.to_string())
}
#[cfg(feature = "node")]
pub mod node {
    use napi::{Env, Task, bindgen_prelude::*};
    use napi_derive::napi;
    pub struct NetworkOverviewTask {
        path: String,
        scope: String,
    }
    #[napi]
    impl Task for NetworkOverviewTask {
        type Output = String;
        type JsValue = String;
        fn compute(&mut self) -> Result<String> {
            super::read(&self.path, &self.scope).map_err(|e| Error::new(Status::GenericFailure, e))
        }
        fn resolve(&mut self, _env: Env, output: String) -> Result<String> {
            Ok(output)
        }
    }
    #[napi]
    pub fn network_overview(path: String, scope: String) -> AsyncTask<NetworkOverviewTask> {
        AsyncTask::new(NetworkOverviewTask { path, scope })
    }
    #[napi]
    pub fn network_overview_sync(path: String, scope: String) -> Result<String> {
        super::read(&path, &scope).map_err(|e| Error::new(Status::GenericFailure, e))
    }
}
#[cfg(test)]
mod tests {
    #[test]
    fn missing_store_is_not_created() {
        let file = std::env::temp_dir().join(format!(
            "vigo-missing-overview-{}.sqlite",
            std::process::id()
        ));
        assert!(super::read(file.to_str().unwrap(), "").is_err());
        assert!(!file.exists());
    }
}
