//! Standalone City runtime. No Node, JavaScript evaluator, or external service.
mod access;
mod alternatives;
mod calendar;
mod city;
mod clock;
mod collection;
mod corridor;
mod encoding;
mod fare_store;
mod flex;
mod flex_index;
mod flex_search;
mod flex_transfers;
mod health;
mod http;
mod linked_trips;
mod materialize;
pub(crate) mod memory;
mod ordered;
mod planner;
mod point;
mod prepared;
mod project;
mod query;
mod reach;
mod realtime_poll;
mod scenario;
mod scenario_route;
mod service;
mod shared_legs;
mod timetable_cache;
mod traffic;
mod traffic_poll;
mod transport;
mod walking;
mod window;
pub use city::City;
pub use transport::main;

use serde_json::{Value, json};
pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

pub(crate) fn allocator_memory() -> Value {
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    {
        #[repr(C)]
        struct Mallinfo {
            arena: usize,
            ordblks: usize,
            smblks: usize,
            hblks: usize,
            hblkhd: usize,
            usmblks: usize,
            fsmblks: usize,
            uordblks: usize,
            fordblks: usize,
            keepcost: usize,
        }
        unsafe extern "C" {
            fn mallinfo2() -> Mallinfo;
        }
        // glibc reports allocator-owned blocks; mapped data files are excluded.
        let stats = unsafe { mallinfo2() };
        json!({"allocatedBytes":stats.uordblks + stats.hblkhd,
            "reusableArenaBytes":stats.fordblks,"scope":"native worker glibc allocations, excluding mapped data files"})
    }
    #[cfg(not(all(target_os = "linux", target_env = "gnu")))]
    Value::Null
}

// Large timetable preparation temporarily allocates sorting and import arrays.
// Return freed pages after a service change instead of retaining allocator
// arenas for every scenario. This never runs on an unchanged warm timetable.
pub(crate) fn release_preparation_memory() {
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    {
        unsafe extern "C" {
            fn malloc_trim(pad: usize) -> std::ffi::c_int;
        }
        // glibc's allocator owns these pages and performs its own locking.
        unsafe {
            malloc_trim(0);
        }
    }
}
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
        "runtime":"rust", "standalone":true, "commands":["traffic-import","info","route","matrix","reach","compare","native","stream","serve","health","capabilities"],
        "modes":["transit","walk","drive"], "timePreferences":["depart_at","arrive_by"],
        "scenarioCollections":{"format":"vigo.scenarios.v1","selector":"scenarioId","sharedStreets":true,"boundedResidency":true},"wheelchair":{"supported":true,"requiresCityProfile":"wheelchair-strict-v1","unknownData":"exclude","modes":["transit","walk"],"dataMode":"scheduled"},"cityFormat":"vigo.city.v1","routingStoreFormat":"vigo.routing.store.v4", "requestSchema":"vigo.standalone.query.v1",
        "flex":{"commands":["route","matrix"],"optIn":true,"directOnly":false,"transitTransfers":true,"continuousStopping":true,"wheelchair":true,"conditionalBooking":true,"confirmsAvailability":false,"maximumMatrixCells":4096},
        "route":{"journeyPolicies":["alternatives-v1"],"realtime":true,"transferControls":true,"waypoints":true,"departureWindows":true,"arrivalWindows":true,"alternatives":{"coverage":"sampled","maximum":5},"requestedAlternatives":{"maximum":9,"rankings":["pareto","ranked"],"timePreferences":["depart_at"]},"transitShapes":true,"fareAnnotations":true},
        "matrix":{"journeys":true,"journeyGeometry":true,"traffic":true,"realtimeTransit":true},
        "reach":{"modes":["transit","walk"],"timePreferences":["depart_at"],"raster":true,"geojson":true,"streets":true,"realtimeTransit":true,"scenarios":["frequency","explicit-scheduled-trips","compiled-overlay"]},
        "compare":{"kinds":["reach"]},
        "http":{"boundedConnections":true,"boundedQueue":true,"workerTerminationOnDeadline":true,"maxRequestBytes":8388608,"maxWorkerResponseBytes":67108864},
        "compatibility":{"studioResultEnvelope":false,"automaticEditorBranchRetiming":false},
        "nativeOperations":["places.describe","timetable.identifiers","timetable.prepare","timetable.route","timetable.arrive_by","timetable.matrix","timetable.many","timetable.arrive_by_many","timetable.pareto","timetable.overlay","access.endpoint","access.endpoints","street.path","street.matrix","street.surface","street.connectors","drive.route","drive.matrix","realtime.compile"],
        "output":{"streamFormats":["public","detailed"],"schemas":["vigo.route.v1","vigo.matrix.v1","vigo.reach.v1"],"diagnostics":["none","summary","profile","trace"],"durationUnit":"seconds","clock":"service-day HH:MM:SS; hours can exceed 23","geometry":"opt-in includeGeometry","trace":"unstable internal ABI"},
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
    if before["assumptionsFingerprint"]
        .as_str()
        .is_none_or(str::is_empty)
        || before["assumptionsFingerprint"] != after["assumptionsFingerprint"]
    {
        return fail("Reach comparison requires matching routing assumptions");
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
