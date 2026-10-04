//! Standalone City runtime. No Node, JavaScript evaluator, or external service.
mod access;
mod city;
mod http;
mod materialize;
mod prepared;
mod query;
mod reach;
mod realtime;
mod scenario;
mod transport;
mod walking;
pub use city::City;
pub use transport::main;

use serde_json::{Value, json};
pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
pub(crate) fn fail<T>(message: impl Into<String>) -> Result<T> {
    Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, message.into()).into())
}
pub(crate) fn number(v: &Value, key: &str, default: f64, min: f64, max: f64) -> Result<f64> {
    let n = match v.get(key) {
        None => default,
        Some(x) => x
            .as_f64()
            .ok_or_else(|| format!("{key} must be a number"))?,
    };
    if !n.is_finite() || n < min || n > max {
        return fail(format!("{key} must be between {min} and {max}"));
    }
    Ok(n)
}
pub(crate) fn flag(v: &Value, key: &str, default: bool) -> Result<bool> {
    v.get(key).map_or(Ok(default), |v| {
        v.as_bool()
            .ok_or_else(|| format!("{key} must be boolean").into())
    })
}
pub fn capabilities() -> Value {
    json!({"schemaVersion":"vigo.standalone.capabilities.v1", "version":env!("CARGO_PKG_VERSION"),
        "runtime":"rust", "standalone":true, "commands":["info","route","matrix","reach","compare","native","stream","serve","capabilities"],
        "modes":["transit","walk","drive"], "timePreferences":["depart_at","arrive_by"],
        "cityFormat":"vigo.city.v1", "requestSchema":"vigo.standalone.query.v1",
        "route":{"realtime":true,"transferControls":true,"waypoints":true,"departureWindows":true,"transitShapes":true,"fareAnnotations":false},
        "matrix":{"journeys":true,"journeyGeometry":true,"traffic":true,"realtimeTransit":false},
        "reach":{"modes":["transit","walk"],"raster":true,"geojson":true,"streets":true,"realtimeTransit":false,"scenarios":["frequency","explicit-scheduled-trips","compiled-overlay"]},
        "compare":{"kinds":["reach"]},
        "http":{"boundedConnections":true,"boundedQueue":true,"workerTerminationOnDeadline":true,"maxRequestBytes":8388608,"maxWorkerResponseBytes":67108864},
        "compatibility":{"studioResultEnvelope":false,"automaticEditorBranchRetiming":false},
        "nativeOperations":["timetable.identifiers","timetable.route","timetable.arrive_by","timetable.matrix","timetable.many","timetable.arrive_by_many","timetable.pareto","timetable.overlay","access.endpoint","access.endpoints","street.path","street.matrix","street.surface","street.connectors","drive.route","drive.matrix","realtime.compile"],
        "dataPreparation":"Load a prepared City. Raw GTFS/OSM import remains a separate build step."})
}
pub fn compare(before: &Value, after: &Value) -> Result<Value> {
    if before["cityRevision"].as_str().is_none_or(str::is_empty)
        || after["cityRevision"].as_str().is_none_or(str::is_empty)
    {
        return fail("Reach comparison requires a City revision on each result");
    }
    if before["cityRevision"] != after["cityRevision"] {
        return fail("Reach comparison requires the same City revision");
    }
    let a = &before["surface"];
    let b = &after["surface"];
    for key in ["width", "height", "bounds"] {
        if a[key] != b[key] {
            return fail(format!("Incompatible Reach grid: {key}"));
        }
    }
    let av = a["values"]
        .as_array()
        .ok_or("Before result has no raster")?;
    let bv = b["values"].as_array().ok_or("After result has no raster")?;
    let width = a["width"]
        .as_u64()
        .filter(|n| *n > 0 && *n <= 1024)
        .ok_or("Invalid raster width")?;
    let height = a["height"]
        .as_u64()
        .filter(|n| *n > 0 && *n <= 1024)
        .ok_or("Invalid raster height")?;
    let bounds = a["bounds"]
        .as_array()
        .filter(|v| v.len() == 4 && v.iter().all(Value::is_number))
        .ok_or("Invalid raster bounds")?;
    if bounds[0].as_f64() >= bounds[2].as_f64()
        || bounds[1].as_f64() >= bounds[3].as_f64()
        || av.len() as u64 != width * height
    {
        return fail("Invalid raster dimensions or bounds");
    }
    if av
        .iter()
        .chain(bv)
        .any(|v| !v.is_null() && v.as_f64().is_none_or(|n| n < 0.))
    {
        return fail("Raster values must be nonnegative numbers or null");
    }
    if av.len() != bv.len() || av.is_empty() {
        return fail("Reach raster lengths differ or are empty");
    }
    let mut deltas = Vec::with_capacity(av.len());
    let mut common = 0;
    let mut newly = 0;
    let mut lost = 0;
    let mut sum = 0.;
    for (a, b) in av.iter().zip(bv) {
        match (a.as_f64(), b.as_f64()) {
            (Some(a), Some(b)) => {
                common += 1;
                sum += b - a;
                deltas.push(json!(b - a));
            }
            (None, Some(_)) => {
                newly += 1;
                deltas.push(Value::Null);
            }
            (Some(_), None) => {
                lost += 1;
                deltas.push(Value::Null);
            }
            _ => deltas.push(Value::Null),
        }
    }
    Ok(
        json!({"schemaVersion":"vigo.standalone.comparison.v1","kind":"compare","commonCells":common,"newlyReachableCells":newly,"noLongerReachableCells":lost,"meanChangeMinutes":if common>0 {Some(sum/common as f64)}else{None},"deltaMinutes":deltas,"sign":"after-minus-before","bounds":a["bounds"],"width":a["width"],"height":a["height"]}),
    )
}
