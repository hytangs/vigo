use super::{Result, access::AccessContext, fail, flag, number};
use crate::realtime::{self, TimetableNames};
use crate::*;
use chrono::{Datelike, NaiveDate};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeSet, HashMap, HashSet},
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
    sync::{Arc, OnceLock},
};

fn routing_source_identity(metadata: &Value) -> Value {
    let mut identity = json!({"identityVersion":"vigo.routing.static-topology-source.v3"});
    for key in [
        "storeId",
        "schemaVersion",
        "transferSemanticsVersion",
        "transferGeneration",
    ] {
        identity[key] = metadata[key].clone();
    }
    if !metadata["accessibility"].is_null() {
        identity["accessibility"] = metadata["accessibility"]["profile"].clone();
    }
    // Match the City compiler's staticTopologySourceIdentity defaults. Older
    // valid Cities can omit optional counts; their persisted identity uses -1,
    // whereas null would incorrectly reject the unchanged database.
    for key in [
        "connectionCount",
        "transferCount",
        "stopCount",
        "bridgedUntimedGapCount",
    ] {
        identity[key] = metadata
            .get(key)
            .filter(|v| !v.is_null())
            .cloned()
            .unwrap_or(json!(-1));
    }
    identity
}

pub(crate) use vigo_format::Snapshot as Image;

fn str_path(p: &Path) -> Result<String> {
    Ok(p.to_str().ok_or("City paths must be UTF-8")?.to_owned())
}
fn read_json(p: &Path) -> Result<Value> {
    Ok(serde_json::from_slice(&fs::read(p)?)?)
}
fn member_file(dir: &Path, entry: &Value) -> Result<String> {
    let name = entry["file"].as_str().ok_or("Missing CCH file")?;
    if !matches!(
        Path::new(name).components().collect::<Vec<_>>().as_slice(),
        [std::path::Component::Normal(_)]
    ) {
        return fail("CCH files must be adjacent to their snapshot");
    }
    let path = dir.join(name);
    if !fs::canonicalize(&path)?.starts_with(fs::canonicalize(dir)?) {
        return fail("CCH file must remain inside the City snapshot directory");
    }
    let size = entry["bytes"]
        .as_u64()
        .or_else(|| entry["bytes"].as_str()?.parse().ok())
        .ok_or("Missing CCH file size")?;
    if fs::metadata(&path)?.len() != size {
        return fail("CCH file size mismatch");
    }
    str_path(&path)
}
fn cch_files(path: &Path, kind: &str) -> Result<(String, String, Option<String>)> {
    let image = Image::open(path, false)?;
    let dir = path.parent().ok_or("Missing snapshot directory")?;
    let format = if kind == "street" {
        "street-cch-v2-u10000"
    } else {
        "drive-cch-v2-t100-d100"
    };
    let prefix = format!("{}.{format}.", path.file_name().unwrap().to_string_lossy());
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with(&prefix) || !name.ends_with(".manifest.json") {
            continue;
        }
        let m = read_json(&entry.path())?;
        if m["schemaVersion"] != "vigo.native-cch-manifest.v1"
            || m["kind"] != kind
            || m["format"] != format
        {
            continue;
        }
        if [
            "magic",
            "version",
            "identity",
            "nodeCount",
            "edgeCount",
            "byteLength",
        ]
        .iter()
        .any(|k| m["sourceSnapshot"][k] != image.header[k])
        {
            continue;
        }
        let structure = member_file(dir, &m["structure"])?;
        let metric = member_file(
            dir,
            &m["metrics"][if kind == "street" { "walk" } else { "time" }],
        )?;
        let distance = if kind == "drive" {
            Some(member_file(dir, &m["metrics"]["distance"])?)
        } else {
            None
        };
        return Ok((structure, metric, distance));
    }
    fail(format!(
        "No source-matched {kind} CCH manifest; rebuild the City"
    ))
}

/// A store's prepared access profile for `key`.
fn access_profile_path(layout: &super::project::Layout, key: &str) -> PathBuf {
    let suffix = crate::route_materialization::stable_key_suffix(key.encode_utf16().collect());
    layout.sidecar(&format!(".native-access-profile.{suffix}.bin"))
}

#[derive(Clone)]
pub(crate) struct Stop {
    pub id: String,
    pub name: String,
    pub lon: f64,
    pub lat: f64,
    pub parent: String,
    pub location: u32,
}
pub(crate) struct Timetable {
    pub kernel: TimetableKernel,
    pub links: super::linked_trips::Links,
    pub stop_ids: Arc<[String]>,
    pub index: Arc<HashMap<String, u32>>,
    pub trip_ids: Arc<[String]>,
    pub route_ids: Arc<[String]>,
    pub trip_service_dates: Arc<[String]>,
    pub key: String,
    pub realtime: Value,
    pub preparation: &'static str,
    pub complete_service_coverage: bool,
    pub coverage_end: Option<u32>,
    /// Trips whose calls carry realtime predictions, ascending.
    pub realtime_trips: Arc<[u32]>,
    pub alerts: Option<Arc<crate::realtime::alerts::Alerts>>,
}
/// Stop-domain inputs of timetable index preparation. They depend only on the
/// City's stops and access context, never on the active service, so every
/// scheduled and realtime view of the City shares them.
pub(crate) struct TransferInputs {
    pub index: Arc<HashMap<String, u32>>,
    // Stops kept for direct service even when no trip in the view serves them.
    pub direct: Vec<u8>,
    pub coords: Vec<f64>,
    pub forbidden_from: Vec<u32>,
    pub forbidden_to: Vec<u32>,
    pub forbidden_same_stop: Vec<u8>,
    pub same_stop_transfer_minimum: Vec<u32>,
    pub transfer_from: Vec<u32>,
    pub transfer_to: Vec<u32>,
    pub transfer_seconds: Vec<f64>,
    pub station_offset: Vec<u32>,
    pub station_members: Vec<u32>,
    /// Each stop's parent station index, or `u32::MAX`.
    pub parents: Vec<u32>,
}
/// One SQLite read of a service-day view. It is retained so that each new
/// realtime snapshot derives its view without reading the schedule again.
pub(crate) struct ScheduleSource {
    pub key: String,
    pub arrays: ServiceTimetableResult,
    pub names: TimetableNames,
}
impl ScheduleSource {
    pub fn new(key: String, mut arrays: ServiceTimetableResult) -> Self {
        fn shared(values: &mut Vec<String>) -> Arc<[String]> {
            std::mem::take(values).into()
        }
        let names = TimetableNames::new(
            shared(&mut arrays.stop_ids),
            shared(&mut arrays.trip_ids),
            shared(&mut arrays.route_ids),
            shared(&mut arrays.direction_ids),
            shared(&mut arrays.trip_service_dates),
        );
        // Service identifiers only select rows during the read.
        arrays.service_ids = Vec::new();
        Self { key, arrays, names }
    }
    pub fn schedule(&self) -> realtime::Schedule<'_> {
        let a = &self.arrays;
        realtime::Schedule {
            stop_count: a.stop_count,
            departure_seconds: &a.departure_seconds,
            arrival_seconds: &a.arrival_seconds,
            from_stop: &a.from_stop,
            to_stop: &a.to_stop,
            sequence: &a.sequence,
            segment_run: &a.segment_run,
            continuity_break: &a.continuity_break,
            can_board: &a.can_board,
            can_alight: &a.can_alight,
            trip_start: &a.trip_start,
            names: &self.names,
        }
    }
    pub fn heap_bytes(&self) -> usize {
        use super::memory::Heap;
        let a = &self.arrays;
        let n = &self.names;
        4 * (a.departure_seconds.len()
            + a.arrival_seconds.len()
            + a.from_stop.len()
            + a.to_stop.len()
            + a.sequence.len()
            + a.segment_trip.len()
            + a.segment_run.len()
            + a.trip_start.len())
            + a.continuity_break.len()
            + a.can_board.len()
            + a.can_alight.len()
            + n.stop_ids.heap_bytes()
            + n.trip_ids.heap_bytes()
            + n.route_ids.heap_bytes()
            + n.direction_ids.heap_bytes()
            + n.trip_service_dates.heap_bytes()
            // The two trip index orders, once built.
            + 8 * n.trip_ids.len()
    }
}
/// The query's service date and, when one is known, the City clock's zone.
fn realtime_clock(snapshot: &Value, request: &Value, metadata: &Value) -> Result<realtime::Clock> {
    let date = NaiveDate::parse_from_str(
        request["serviceDate"]
            .as_str()
            .ok_or("Missing serviceDate")?,
        "%Y-%m-%d",
    )?;
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
    Ok(realtime::Clock {
        date,
        zone: timezone.map(str::parse).transpose()?,
    })
}
/// The Result's `meta.realtime` for one overlay.
fn realtime_diagnostics(overlay: &realtime::Overlay, snapshot: &Value) -> Value {
    let c = realtime::Counts::of(&overlay.outcomes);
    let applied = c.applied + c.canceled;
    let rejected = c.feed_updates - applied;
    let status = if applied > 0 {
        if rejected > 0 { "partial" } else { "applied" }
    } else if c.stale > 0 {
        "stale_fallback"
    } else {
        "no_matches"
    };
    // Relationships that routing does not model are reported as invalid.
    json!({"mode":"full-snapshot","feedTripUpdates":c.feed_updates,"appliedTrips":c.applied,
        "canceledTrips":c.canceled,"staleTrips":c.stale,"unmatchedTrips":c.unmatched,
        "invalidTrips":c.invalid + c.unsupported,"duplicateTrips":c.duplicate,
        "dateMismatches":c.date_mismatches,"pastPrefixTrips":c.past_prefix_trips,
        "omittedPastPrefixStops":c.omitted_past_prefix_stops,"status":status,
        "coverage":{"appliedUpdates":applied,"rejectedUpdates":rejected,
            "complete":rejected == 0 && snapshot["failedFeeds"].as_u64().unwrap_or(0) == 0}})
}
pub(crate) struct Drive {
    pub automatic_traffic: Option<std::sync::Arc<vigo_traffic::Snapshot>>,
    pub kernel: DriveKernel,
    pub image: Image,
}
pub struct City {
    pub(crate) path: PathBuf,
    /// The routing store; a City's is `routing/project.sqlite`.
    pub(crate) routing_db: PathBuf,
    pub(crate) db: Connection,
    pub(crate) manifest: Value,
    pub(crate) metadata: Value,
    pub(crate) street_bounds: Value,
    pub(crate) street_directory: PathBuf,
    pub(crate) context: Image,
    pub(crate) access: AccessContext,
    pub(crate) stops: Vec<Stop>,
    pub(crate) stop_index: HashMap<String, usize>,
    pub(crate) members: Vec<String>,
    pub(crate) street: CoordinateKernel,
    pending_pedestrian_profile: Option<(PathBuf, String)>,
    pub(crate) drive: Option<Drive>,
    pub(crate) polling_enabled: bool,
    pub(crate) timetable: Option<Timetable>,
    /// What the active scenario view adds: new stops and planned services.
    pub(crate) scenario_view: Option<Arc<super::scenario_route::ScenarioPresentation>>,
    pub(crate) scenario_views: HashMap<String, Arc<super::scenario_route::ScenarioPresentation>>,
    /// A scenario Route keeps its view for the whole request.
    pub(crate) pinned_timetable: bool,
    pub(super) linked_candidates: Option<super::linked_trips::Candidates>,
    pub(crate) timetable_cache: super::timetable_cache::TimetableCache,
    pub(crate) query_workspace: Option<crate::timetable::TimetableQueryWorkspace>,
    pub(crate) timetable_preparations: u64,
    pub(crate) timetable_activation_ms: f64,
    pub(crate) timetable_preparation_profile: Value,
    pub(crate) calendar: std::sync::OnceLock<super::calendar::CalendarIndex>,
    pub(crate) transfer_inputs: OnceLock<Arc<TransferInputs>>,
    pub(crate) route_types: OnceLock<Arc<HashMap<String, i64>>>,
    // The server's installed live snapshot, the one this query uses, and the
    // last live query, whose view a new snapshot derives ahead of demand.
    pub(crate) live: Option<Arc<super::realtime_poll::LiveSnapshot>>,
    pub(crate) query_live: Option<Arc<super::realtime_poll::LiveSnapshot>>,
    pub(crate) live_request: Option<(Value, Option<String>)>,
    pub(crate) query_start_date: Option<String>,
    /// Trace and detailed results keep the complete endpoint access evidence;
    /// public results publish only its counts and timings.
    pub(crate) full_access_evidence: bool,
    pub(crate) indexed_matrix_journeys: bool,
    pub(crate) timetable_blocks: Option<TimetableBlockPool>,
    pub(crate) speed: f64,
    pub(crate) padding: f64,
    pub(crate) overhead: f64,
    pub(crate) shapes: ShapeGeometrySource,
    pub(crate) shape_cache: super::materialize::ShapeCache,
    // Immutable source metadata, shared by journeys in this City. These are
    // bounded by the City's routes/trips and never contain query answers.
    pub(crate) route_metadata: HashMap<String, Value>,
    pub(crate) trip_shape_ids: HashMap<String, Option<String>>,
    pub(crate) trip_details: HashMap<String, Value>,
    pub(crate) fare_engines: HashMap<String, Option<crate::fares::FareEngine>>,
    pub(crate) transfer_rows: HashMap<String, usize>,
    pub(crate) transfer_shortcut_rows: HashMap<String, usize>,
}
impl City {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        Self::open_shared(path.as_ref(), &[])
    }
    pub(crate) fn open_shared(
        path: &Path,
        residents: &[(&Path, &CoordinateKernel)],
    ) -> Result<Self> {
        let path = fs::canonicalize(path)?;
        Self::open_layout(super::project::Layout::city(&path)?, residents)
    }
    /// Opens one routing store of a Studio project; see `project`.
    pub fn open_project(path: impl AsRef<Path>, store: Option<&Path>) -> Result<Self> {
        let path = fs::canonicalize(path)?;
        Self::open_layout(super::project::Layout::project(&path, store)?, &[])
    }
    pub(crate) fn ensure_pedestrian_hierarchy(&mut self) -> Result<()> {
        if self.street.street_cch_load_diagnostics().is_none() {
            let snapshot = self
                .path
                .join("osm/street-index.sqlite.street-accelerator-v7.bin");
            let (structure_path, metric_path, _) = cch_files(&snapshot, "street")?;
            self.street.load_street_cch_index(StreetCchLoadInput {
                structure_path,
                metric_path,
            })?;
        }
        if let Some((path, key)) = &self.pending_pedestrian_profile {
            self.street
                .load_access_profile_snapshot(str_path(path)?, key.clone())?;
            if self
                .street
                .profile
                .as_ref()
                .is_none_or(|p| p.member_lons.len() != self.members.len())
            {
                return fail("Coordinate access member count mismatch");
            }
            self.pending_pedestrian_profile = None;
        }
        Ok(())
    }
    fn open_layout(
        layout: super::project::Layout,
        residents: &[(&Path, &CoordinateKernel)],
    ) -> Result<Self> {
        let path = layout.root.clone();
        let street_directory = fs::canonicalize(path.join("osm"))?;
        let mut manifest = layout.manifest.clone();
        if manifest["schemaVersion"] != "vigo.city.v1" {
            return fail("Expected a prepared vigo.city.v1 City");
        }
        // Load the shared graph alongside routing metadata. The pedestrian
        // hierarchy and access profile are opened only for pedestrian queries;
        // Drive uses its own hierarchy and must not depend on those files.
        let street_path = path.join("osm/street-index.sqlite.street-accelerator-v7.bin");
        let street_load = (!residents
            .iter()
            .any(|(directory, _)| *directory == street_directory))
        .then(|| {
            let street_path = street_path.clone();
            std::thread::spawn(move || {
                CoordinateKernel::new(street_path.to_string_lossy().into_owned())
                    .map_err(|error| error.to_string())
            })
        });
        let db_path = layout.routing.clone();
        if db_path.with_extension("sqlite-wal").exists() {
            return fail("City must be immutable and checkpointed (unexpected SQLite WAL)");
        }
        let db = Connection::open_with_flags(
            &db_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        db.execute_batch("PRAGMA query_only=ON; PRAGMA cache_size=-2048;")?;
        let mut metadata = json!({});
        for row in db
            .prepare("SELECT key,value FROM metadata")?
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        {
            let (k, v) = row?;
            metadata[k] = serde_json::from_str(&v).unwrap_or(Value::String(v));
        }
        if metadata["maximumServiceTimeSeconds"].as_f64().is_none()
            || metadata["minimumServiceTimeSeconds"].as_f64().is_none()
        {
            let (minimum, maximum) = db.query_row(
                "SELECT COALESCE(MIN(departure),0),COALESCE(MAX(arrival),0) FROM connections",
                [],
                |r| Ok((r.get::<_, f64>(0)?, r.get::<_, f64>(1)?)),
            )?;
            metadata["minimumServiceTimeSeconds"] = json!(minimum);
            metadata["maximumServiceTimeSeconds"] = json!(maximum);
        }
        if metadata["schemaVersion"] != "vigo.routing.store.v4"
            || metadata["transferSemanticsVersion"] != "vigo.routing.transfers.v4"
        {
            return fail("Rebuild City with the current routing/transfer format");
        }
        if !matches!(
            metadata["serviceModel"].as_str(),
            Some("exact-date" | "exact-date-multi-feed")
        ) {
            return fail("Rebuild City from GTFS; only exact-date service models are supported");
        }
        if metadata["blockingRoutingFeatures"]
            .as_array()
            .is_some_and(|x| !x.is_empty())
        {
            return fail("City contains blocking routing features");
        }
        let (context, mut access) =
            Image::open_with_metadata::<AccessContext>(&layout.sidecar(".access-context.bin"))?;
        if access.schema_version != "vigo.routing.access-context.v2"
            || !access.materialized.stop_access_index.ready
        {
            return fail("A prepared access context is required; rebuild the City");
        }
        let identity = routing_source_identity(&metadata);
        let mut header = [0u8; 100];
        File::open(&db_path)?.read_exact(&mut header)?;
        let mut generation = fs::metadata(&db_path)?.len().to_string();
        for offset in [24, 28, 40, 92] {
            generation.push_str(&format!(
                ":{}",
                u32::from_be_bytes(header[offset..offset + 4].try_into()?)
            ));
        }
        let expected = format!("{}\n{}|", serde_json::to_string(&identity)?, generation);
        if access.source_artifact_identity != expected {
            return fail("Prepared access context does not match the routing database");
        }
        if layout.derived {
            // A project store carries its own accessibility profile, and its
            // revision is the store generation every sidecar was prepared for.
            manifest["accessibility"] = metadata["accessibility"].clone();
            manifest["revisionId"] = json!(format!(
                "store-{}",
                &format!("{:x}", Sha256::digest(expected.as_bytes()))[..16]
            ));
        }
        let policy: Value = serde_json::from_str(&access.access_policy_identity)?;
        if policy["transferWalkingTimeFloor"] != "distance-at-configured-speed-v1"
            || policy["unpricedPathways"] != "typed-estimates-otherwise-excluded-v2"
            || policy["pathwayCostModel"]["id"]
                != "stairs-one-second-per-step-gates-five-seconds-v1"
            || policy["pathwayCostModel"]["secondsPerStair"] != 1
            || policy["pathwayCostModel"]["gateSeconds"] != 5
            || policy["stationStreetAnchors"] != "declared-entrances-v1"
            || policy["stationStreetTransfers"] != "entrance-pathway-chain-v1"
            || policy["streetAttachment"] != "nearest-vertex-or-reciprocal-edge-v3"
        {
            return fail(
                "Prepared station walking times are stale; prepare the City with the current VIGO runtime",
            );
        }
        let speed = number(&policy, "walkingSpeedKph", 4.8, 1., 8.)?;
        let padding = number(&policy, "accessPaddingFactor", 1., 0.75, 3.)?;
        let overhead = number(&policy, "accessOverheadSeconds", 0., 0., 900.)?;
        let records = std::mem::take(&mut access.materialized.stop_records);
        let mut stops = Vec::with_capacity(records.len());
        for (id, s) in records {
            let location = s.location_type.as_u64().unwrap_or(0) as u32;
            let coordinate = |value: &Value| -> Result<f64> {
                match value.as_f64() {
                    Some(value) => Ok(value),
                    None if value.is_null() && [3, 4].contains(&location) => Ok(f64::NAN),
                    _ => fail("Invalid stop coordinate"),
                }
            };
            stops.push(Stop {
                id,
                name: s.name.as_str().unwrap_or("").to_owned(),
                lon: coordinate(&s.lon)?,
                lat: coordinate(&s.lat)?,
                parent: s.parent_station.as_str().unwrap_or("").to_owned(),
                location,
            });
        }
        if Some(stops.len() as u64) != metadata["stopCount"].as_u64() {
            return fail("Prepared stop count mismatch");
        }
        let stop_index: HashMap<_, _> = stops
            .iter()
            .enumerate()
            .map(|(i, s)| (s.id.clone(), i))
            .collect();
        let eligible: HashSet<&str> = access
            .materialized
            .stop_access_index
            .departure_service_stop_ids
            .iter()
            .chain(
                &access
                    .materialized
                    .stop_access_index
                    .arrival_service_stop_ids,
            )
            .map(String::as_str)
            .collect();
        let members: Vec<String> = stops
            .iter()
            .filter(|s| s.location != 1 && (eligible.contains(s.id.as_str()) || s.location != 0))
            .map(|s| s.id.clone())
            .collect();
        let street_db = Connection::open_with_flags(
            path.join("osm/street-index.sqlite"),
            OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        let street_profile: Option<String> = street_db
            .query_row(
                "SELECT value FROM metadata WHERE key='accessibility'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        let street_accessibility: Value = street_profile
            .map(|v| serde_json::from_str(&v))
            .transpose()?
            .unwrap_or(Value::Null);
        let profile = &metadata["accessibility"]["profile"];
        if profile != &manifest["accessibility"]["profile"]
            || profile != &street_accessibility["profile"]
            || (!profile.is_null() && profile != "wheelchair-strict-v1")
        {
            return fail("City accessibility profiles do not match; rebuild the complete City");
        }
        // A street store built without a basemap has no coverage bounds; its
        // endpoints are then judged by street attachment alone.
        let basemap: Option<String> = street_db
            .query_row(
                "SELECT value FROM metadata WHERE key='localBasemap'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        let street_bounds = match basemap {
            Some(basemap) => serde_json::from_str::<Value>(&basemap)?["bounds"].clone(),
            None => Value::Null,
        };
        drop(street_db);
        let street_header = Image::open(&street_path, false)?;
        if street_header.header["identity"]["schemaVersion"] != "vigo.street.store.v6" {
            return fail(
                "Street pedestrian restrictions are stale; rebuild the City from the source OSM PBF",
            );
        }
        let mut street = match street_load {
            Some(load) => load.join().map_err(|_| "Street graph loader panicked")??,
            None => residents
                .iter()
                .find(|(directory, _)| *directory == street_directory)
                .ok_or("Missing resident street graph")?
                .1
                .share_streets()?,
        };
        let terminal = path.join("osm/street-index.sqlite.terminal-access-v1.json");
        if terminal.exists() && street.terminal_access.is_none() {
            street.configure_terminal_access(str_path(&terminal)?)?;
        } else if !terminal.exists()
            && ["endpoints", "authorized_endpoints"]
                .iter()
                .any(|m| manifest["streetStore"]["terminalAccess"]["model"] == *m)
        {
            return fail("Missing terminal-access artifact for private endpoints City");
        }
        // A City's street build always carries its source fingerprint. A
        // Studio store's streets may not, and its profile then records none.
        let fingerprint = match street_header.header["identity"]["sourceFingerprint"].as_str() {
            Some(fingerprint) => fingerprint,
            None if layout.derived => "",
            None => return fail("Missing street source fingerprint"),
        };
        if layout.derived {
            // The newest prepared profile for this store, street and policy.
            let key = super::project::profile_key(&layout, |key| {
                let parts: Vec<_> = key.split(':').collect();
                Ok(parts.len() == 6
                    && parts[0] == "coordinate-access-v11"
                    && percent_decode(parts[1])? == expected
                    && percent_decode(parts[5])? == access.access_policy_identity
                    && parts[3].parse::<usize>().ok() == Some(members.len())
                    && percent_decode(parts[2])?
                        .split('|')
                        .any(|v| v == fingerprint))
            })?;
            manifest["routingStore"]["nativeCoordinateAccess"]["profileKey"] = json!(key);
        }
        let key = manifest["routingStore"]["nativeCoordinateAccess"]["profileKey"]
            .as_str()
            .ok_or("Missing prepared coordinate access profile")?;
        let key_parts: Vec<_> = key.split(':').collect();
        if key_parts.len() != 6
            || key_parts[0] != "coordinate-access-v11"
            || percent_decode(key_parts[1])? != expected
            || percent_decode(key_parts[5])? != access.access_policy_identity
            || key_parts[3].parse::<usize>()? != members.len()
        {
            return fail("Prepared coordinate access profile identity is stale");
        }
        if street_header.header["identity"]["accessibility"] != metadata["accessibility"]["profile"]
        {
            return fail("Street snapshot accessibility profile does not match the City");
        }
        if !percent_decode(key_parts[2])?
            .split('|')
            .any(|v| v == fingerprint)
        {
            return fail("Coordinate profile belongs to another street source");
        }
        let pending_pedestrian_profile = Some((access_profile_path(&layout, key), key.to_owned()));
        let transfer_rows = access
            .materialized
            .transfers
            .iter()
            .enumerate()
            .map(|(i, (id, _))| (id.clone(), i))
            .collect();
        let transfer_shortcut_rows = access
            .materialized
            .transfer_shortcuts
            .iter()
            .enumerate()
            .map(|(i, (id, _))| (id.clone(), i))
            .collect();
        Ok(Self {
            shapes: ShapeGeometrySource::new(str_path(&db_path)?)?,
            shape_cache: super::materialize::ShapeCache::default(),
            route_metadata: HashMap::new(),
            trip_shape_ids: HashMap::new(),
            trip_details: HashMap::new(),
            fare_engines: HashMap::new(),
            path,
            routing_db: db_path,
            db,
            manifest,
            metadata,
            street_bounds,
            street_directory,
            context,
            access,
            stops,
            stop_index,
            members,
            street,
            pending_pedestrian_profile,
            drive: None,
            polling_enabled: false,
            timetable: None,
            scenario_view: None,
            scenario_views: HashMap::new(),
            pinned_timetable: false,
            linked_candidates: None,
            timetable_cache: super::timetable_cache::TimetableCache::from_env()?,
            query_workspace: None,
            timetable_preparations: 0,
            timetable_activation_ms: 0.,
            timetable_preparation_profile: Value::Null,
            calendar: Default::default(),
            transfer_inputs: OnceLock::new(),
            route_types: OnceLock::new(),
            live: None,
            query_live: None,
            live_request: None,
            query_start_date: None,
            full_access_evidence: false,
            indexed_matrix_journeys: false,
            timetable_blocks: Some(Default::default()),
            speed,
            padding,
            overhead,
            transfer_rows,
            transfer_shortcut_rows,
        })
    }
    pub fn info(&self) -> Value {
        let mut access =
            serde_json::to_value(self.street.profile_diagnostics()).unwrap_or(Value::Null);
        if let Some(object) = access.as_object_mut() {
            object.remove("profileKey");
        }
        json!({"schemaVersion":"vigo.standalone.city.v1","name":self.manifest["name"],"revisionId":self.manifest["revisionId"],"sources":self.manifest["sources"],"runtime":"rust","resourcePolicy":{"memoryCapacityBytes":crate::resources::memory_capacity(),"swapCountsAsRam":false},"accessibility":self.metadata["accessibility"],"routing":self.manifest["routingStore"],"streets":self.manifest["streetStore"],"warnings":self.metadata["routingLimitations"],"memory":{
            "ledger":self.memory_ledger(),"sharedStreetOwners":self.street.shared_street_owners(),"street":self.street.diagnostics(),"access":access,
            "timetable":self.timetable.as_ref().map(|t| t.kernel.diagnostics()),
            "timetablePreparations":self.timetable_preparations,
            "calendarIndexBytes":self.calendar.get().map_or(0, |c| c.heap_bytes()),
            "timetableSharedColumns":self.timetable_blocks.as_ref().map(|p| json!({
                "uniqueBytes":p.unique_bytes(), "indexBytes":p.index_bytes(),
                "uniqueBlocks":p.unique_blocks(),
                "references":self.timetable.iter().chain(self.timetable_cache.entries()).map(|t| t.kernel.source_block_references()).sum::<usize>()})),
            "timetableCache":{"entries":self.timetable_cache.entries().count(),
                "retainedBytes":self.timetable_cache.bytes,"budgetBytes":self.timetable_cache.budget,
                "hits":self.timetable_cache.hits,"evictions":self.timetable_cache.evictions},
            "timetableCoverageEndSeconds":self.timetable.as_ref().and_then(|t|t.coverage_end),
            "geometry":self.shape_cache.diagnostics(),"driveLoaded":self.drive.is_some(),
            "scope":"estimated retained native allocations and mapped file sizes; not RSS or container peak"}})
    }
    pub(crate) fn stop(&self, id: &str) -> Result<&Stop> {
        self.stop_index
            .get(id)
            .map(|&i| &self.stops[i])
            .or_else(|| self.scenario_view.as_ref()?.stops.get(id))
            .ok_or_else(|| format!("Unknown stopId: {id}").into())
    }
    fn calendar(&self) -> Result<&super::calendar::CalendarIndex> {
        if self.calendar.get().is_none() {
            let index = super::calendar::CalendarIndex::load(&self.db)?;
            let _ = self.calendar.set(index);
        }
        Ok(self.calendar.get().unwrap())
    }
    fn services_on(&self, date: NaiveDate) -> Result<BTreeSet<String>> {
        Ok(self.calendar()?.services_on(date))
    }
    fn service_instances(
        &self,
        request: &Value,
        date: NaiveDate,
        coverage_end: Option<u32>,
    ) -> Result<Option<Vec<ServiceInstance>>> {
        if request.get("time").is_none() && request.get("timeMinutes").is_none() {
            return Ok(None);
        }
        let opt = super::query::Options::parse(request)?;
        let zone: chrono_tz::Tz = self.metadata["agencyTimezones"]
            .as_array()
            .and_then(|a| a.first())
            .and_then(Value::as_str)
            .unwrap_or("UTC")
            .parse()?;
        let epoch = |day: NaiveDate| super::calendar::service_epoch(zone, day);
        let origin = epoch(date)?;
        let maximum = self.metadata["maximumServiceTimeSeconds"]
            .as_f64()
            .unwrap_or(0.);
        let minimum = if coverage_end.is_some() {
            self.metadata["minimumServiceTimeSeconds"]
                .as_f64()
                .unwrap_or(0.)
        } else {
            0.
        };
        let mut days = vec![];
        for delta in -3..=5 {
            let Some(day) = date.checked_add_signed(chrono::Duration::days(delta)) else {
                continue;
            };
            let offset = epoch(day)? - origin;
            // Keep the previous service days' overnight tails throughout the
            // clock date. Otherwise changing depart/arrive horizons repeatedly
            // discards and rebuilds an almost identical timetable.
            if delta != 0
                && ((offset as f64) + minimum > coverage_end.map_or(opt.end, f64::from)
                    || (offset as f64) + maximum < 0.)
            {
                continue;
            }
            days.push((day, offset as i32));
        }
        if days.len() == 1 && days[0].0 == date {
            return Ok(None);
        }
        let mut instances = vec![];
        for (day, offset_seconds) in days {
            for service_id in self.services_on(day)? {
                instances.push(ServiceInstance {
                    service_id,
                    offset_seconds,
                    service_date: day.to_string(),
                });
            }
        }
        Ok(Some(instances))
    }
    pub(crate) fn validated_service_date(request: &Value) -> Result<NaiveDate> {
        let date_text = request["serviceDate"]
            .as_str()
            .ok_or("serviceDate (YYYY-MM-DD) is required for transit")?;
        let date = NaiveDate::parse_from_str(date_text, "%Y-%m-%d")?;
        if date.format("%Y-%m-%d").to_string() != date_text || !(1..=9999).contains(&date.year()) {
            return fail("Invalid serviceDate");
        }
        let day = [
            "monday",
            "tuesday",
            "wednesday",
            "thursday",
            "friday",
            "saturday",
            "sunday",
        ][date.weekday().num_days_from_monday() as usize];
        let service_day = if day == "saturday" || day == "sunday" {
            day
        } else {
            "weekday"
        };
        if request.get("serviceDay").is_some_and(|v| v != service_day) {
            return fail("serviceDay disagrees with serviceDate");
        }
        Ok(date)
    }
    fn transfer_inputs_for(&self, stop_ids: &[String]) -> TransferInputs {
        let index: HashMap<String, u32> = stop_ids
            .iter()
            .enumerate()
            .map(|(i, s)| (s.clone(), i as u32))
            .collect();
        let n = stop_ids.len();
        let saved = &self.access.materialized;
        let direct: HashSet<&str> = saved
            .stop_access_index
            .direct_service_stop_ids
            .iter()
            .map(String::as_str)
            .collect();
        let direct = stop_ids
            .iter()
            .map(|s| u8::from(direct.contains(s.as_str())))
            .collect();
        let coords = stop_ids
            .iter()
            .flat_map(|id| {
                self.stop(id)
                    .map(|s| [s.lon, s.lat])
                    .unwrap_or([f64::NAN; 2])
            })
            .collect();
        let forbidden: HashSet<&str> = saved
            .forbidden_transfer_pairs
            .iter()
            .map(String::as_str)
            .collect();
        let mut forbidden_from = vec![];
        let mut forbidden_to = vec![];
        let mut forbidden_same_stop = vec![0; n];
        let mut same_stop_transfer_minimum = vec![0; n];
        for pair in &forbidden {
            if let Some((a, b)) = pair.split_once('\0')
                && let (Some(&a), Some(&b)) = (index.get(a), index.get(b))
            {
                forbidden_from.push(a);
                forbidden_to.push(b);
                if a == b {
                    forbidden_same_stop[a as usize] = 1;
                }
            }
        }
        let mut transfer_from = vec![];
        let mut transfer_to = vec![];
        let mut transfer_seconds = vec![];
        for (from, edges) in &saved.transfers {
            for edge in edges {
                let to = &edge.to_stop_id;
                if forbidden.contains(format!("{from}\0{to}").as_str()) {
                    continue;
                }
                if let (Some(&a), Some(&b)) = (index.get(from), index.get(to)) {
                    let duration = edge.min_transfer_time.unwrap_or(0.);
                    transfer_from.push(a);
                    transfer_to.push(b);
                    transfer_seconds.push(duration);
                    if a == b {
                        same_stop_transfer_minimum[a as usize] = duration.max(0.) as u32;
                    }
                }
            }
        }
        let mut station_offset = vec![0];
        let mut station_members = vec![];
        for (from, shortcuts) in &saved.transfer_shortcuts {
            for edge in shortcuts {
                if let (Some(&a), Some(&b)) = (index.get(from), index.get(&edge.to_stop_id)) {
                    transfer_from.push(a);
                    transfer_to.push(b);
                    transfer_seconds.push(edge.min_transfer_time);
                }
            }
        }
        let declared: HashSet<_> = saved.declared_pathway_stops.iter().collect();
        for (_, members) in &saved.station_members {
            if members.iter().any(|id| declared.contains(id)) {
                continue;
            }
            for id in members {
                if let Some(&i) = index.get(id) {
                    station_members.push(i);
                }
            }
            station_offset.push(station_members.len() as u32);
        }
        let parents = stop_ids
            .iter()
            .map(|id| {
                self.stop(id)
                    .ok()
                    .and_then(|s| index.get(&s.parent).copied())
                    .unwrap_or(u32::MAX)
            })
            .collect();
        TransferInputs {
            parents,
            index: Arc::new(index),
            direct,
            coords,
            forbidden_from,
            forbidden_to,
            forbidden_same_stop,
            same_stop_transfer_minimum,
            transfer_from,
            transfer_to,
            transfer_seconds,
            station_offset,
            station_members,
        }
    }
    fn read_schedule(
        &mut self,
        services: BTreeSet<String>,
        instances: Option<Vec<ServiceInstance>>,
        coverage_end: Option<u32>,
    ) -> Result<ServiceTimetableResult> {
        // City identity is owned by this cache. The key retains every service,
        // date/offset and horizon selector; realtime is applied only afterwards.
        let cache_key = (coverage_end.is_some() && self.timetable_cache.budget > 0)
            .then(|| serde_json::to_string(&(&services, &instances, coverage_end)))
            .transpose()?;
        if let Some(key) = &cache_key
            && let Some(source) = self.timetable_cache.compact_source(key)?
        {
            return Ok(source);
        }
        let has_permissions: bool = self.db.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='connection_permissions')",
            [],
            |r| r.get(0),
        )?;
        let mut source = read_service_timetable(ServiceTimetableInput {
            store_path: str_path(&self.routing_db)?,
            stop_ids: self.stops.iter().map(|s| s.id.clone()).collect(),
            service_ids: services.into_iter().collect(),
            has_connection_permissions: has_permissions,
            segment_count: None,
            service_instances: instances,
            maximum_departure_seconds: coverage_end,
        })?;
        if let Some(key) = cache_key {
            self.timetable_cache.insert_compact_source(key, &mut source);
        }
        Ok(source)
    }
    /// The transfer buffer is a search parameter, not part of the timetable:
    /// every buffer reuses the same resident, cached or scenario timetable.
    pub(super) fn apply_transfer_buffer(&mut self, request: &Value) -> Result<()> {
        let buffer = number(request, "minimumTransferBufferMinutes", 0., 0., 60.)?;
        if let Some(timetable) = self.timetable.as_mut() {
            timetable
                .kernel
                .set_minimum_transfer_buffer_seconds(buffer as u32 * 60);
        }
        Ok(())
    }
    /// The requested source feeds of a merged City, or None for all of them.
    fn selected_scopes(&self, request: &Value) -> Result<Option<BTreeSet<String>>> {
        let Some(value) = request.get("sourceScopes") else {
            return Ok(None);
        };
        let available: BTreeSet<String> = self.metadata["sourceStores"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|store| store["scope"].as_str())
            .filter(|scope| !scope.trim().is_empty())
            .map(str::to_owned)
            .collect();
        let selected: BTreeSet<String> = value
            .as_array()
            .filter(|a| !a.is_empty())
            .ok_or("sourceScopes must be a nonempty array of source feed scopes")?
            .iter()
            .map(|v| {
                v.as_str()
                    .filter(|scope| available.contains(*scope))
                    .map(str::to_owned)
                    .ok_or_else(|| format!("Unknown source scope: {v}"))
            })
            .collect::<std::result::Result<_, _>>()?;
        Ok((selected.len() < available.len()).then_some(selected))
    }
    pub(crate) fn activate(&mut self, request: &Value) -> Result<()> {
        if self.pinned_timetable {
            return Ok(());
        }
        let started = std::time::Instant::now();
        let result = self
            .activate_inner(request)
            .and_then(|()| self.apply_transfer_buffer(request));
        if result.is_ok() {
            self.scenario_view = None;
        }
        self.timetable_activation_ms += started.elapsed().as_secs_f64() * 1000.;
        result
    }
    fn activate_inner(&mut self, request: &Value) -> Result<()> {
        let started = std::time::Instant::now();
        let date = Self::validated_service_date(request)?;
        let date_text = request["serviceDate"].as_str().unwrap();
        let allow = flag(request, "allowStreetTransfers", true)?;
        let buffer = number(request, "minimumTransferBufferMinutes", 0., 0., 60.)?;
        if buffer.fract() != 0. {
            return fail("minimumTransferBufferMinutes must be an integer");
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_secs_f64();
        let complete_coverage = flag(request, "requireCompleteServiceCoverage", false)?;
        // Ordinary morning/evening requests share a stable prefix through
        // 06:00 the next day. Longer searches grow it in six-hour blocks;
        // narrower queries reuse the already loaded superset. Clipping avoids
        // loading an entire next day for a horizon that only reaches midnight.
        let clocked = request.get("time").is_some() || request.get("timeMinutes").is_some();
        // A supplied snapshot overrides the server's live one for this query.
        let live = self.query_live.clone();
        let start_date = self.query_start_date.clone();
        let snapshot = request
            .get("realtimeSnapshot")
            .or(live.as_deref().map(|l| &l.snapshot));
        let coverage_end = if clocked && snapshot.is_none() {
            Some(
                ((super::query::Options::parse(request)?.end.max(108_000.) / 21_600.).ceil()
                    * 21_600.) as u32,
            )
        } else {
            None
        };
        // A resident scheduled prefix already establishes the active services.
        // Resolve calendars only when it grows or the service date changes.
        // A realtime view derives from the retained source read of the same
        // service days. Its key excludes the snapshot, transfers and buffer.
        // A City case routes on some source feeds of a merged City.
        let scopes = self.selected_scopes(request)?;
        let scoped = |id: &str| {
            scopes.as_ref().is_none_or(|s| {
                id.split_once('\u{1f}')
                    .is_some_and(|(scope, _)| s.contains(scope))
            })
        };
        let scope_key = scopes.as_ref().map_or(String::new(), |s| {
            format!(
                ":scopes={}",
                s.iter().cloned().collect::<Vec<_>>().join("\u{1f}")
            )
        });
        let (key, instances, source_key) = if coverage_end.is_some() {
            (
                format!("{date_text}:{allow}:scheduled{scope_key}"),
                None,
                None,
            )
        } else {
            let instances = self.service_instances(request, date, None)?.map(|all| {
                all.into_iter()
                    .filter(|v| scoped(&v.service_id))
                    .collect::<Vec<_>>()
            });
            let days_key = instances.as_ref().map(|a| {
                a.iter()
                    .map(|v| (&v.service_date, v.offset_seconds))
                    .collect::<BTreeSet<_>>()
            });
            // A live snapshot is named by its content identifier, so a large
            // feed is not serialized again for every query.
            let inline = &request["realtimeSnapshot"];
            let live_id = live.as_ref().filter(|_| inline.is_null()).map(|l| &l.id);
            let validity = realtime::validity(snapshot.unwrap_or(&Value::Null), now);
            let realtime_key = format!(
                "{:x}",
                Sha256::digest(serde_json::to_vec(&(
                    inline,
                    live_id,
                    validity,
                    &start_date
                ))?)
            );
            let source_key = snapshot
                .is_some()
                .then(|| format!("{date_text}:{days_key:?}{scope_key}"));
            (
                format!("{date_text}:{allow}:{realtime_key}:{days_key:?}{scope_key}"),
                instances,
                source_key,
            )
        };
        if self.timetable.as_ref().is_some_and(|t| {
            t.key == key
                && coverage_end.is_none_or(|end| t.coverage_end.is_some_and(|saved| saved >= end))
        }) {
            if complete_coverage && !self.timetable.as_ref().unwrap().complete_service_coverage {
                return fail(
                    "Incomplete service coverage across source feeds on the requested date",
                );
            }
            self.install_query_workspace();
            return Ok(());
        }
        if let Some(index) = self.timetable_cache.find(&key, coverage_end) {
            if complete_coverage && !self.timetable_cache.get(index).complete_service_coverage {
                return fail(
                    "Incomplete service coverage across source feeds on the requested date",
                );
            }
            let timetable = self.timetable_cache.take(index);
            self.retire_timetable();
            self.timetable = Some(timetable);
            self.install_query_workspace();
            return Ok(());
        }
        let instances = if coverage_end.is_some() {
            self.service_instances(request, date, coverage_end)?
                .map(|all| all.into_iter().filter(|v| scoped(&v.service_id)).collect())
        } else {
            instances
        };
        let service_offsets: HashMap<String, i32> = instances
            .as_ref()
            .map(|items: &Vec<ServiceInstance>| {
                items
                    .iter()
                    .map(|i| (i.service_date.clone(), i.offset_seconds))
                    .collect()
            })
            .unwrap_or_default();
        self.retire_timetable();
        self.timetable_preparations += 1;
        let mut services = self.services_on(date)?;
        services.retain(|id| scoped(id));
        let complete_service_coverage = match &scopes {
            // Every selected source must run on the date.
            Some(selected) => {
                selected.len() <= 1
                    || selected.iter().all(|scope| {
                        services
                            .iter()
                            .any(|id| id.split_once('\u{1f}').is_some_and(|(s, _)| s == scope))
                    })
            }
            None => self.calendar()?.complete(&services),
        };
        if complete_coverage && !complete_service_coverage {
            return fail("Incomplete service coverage across source feeds on the requested date");
        }
        if allow
            && instances.is_none()
            && snapshot.is_none()
            && let Ok(mut timetable) = self.prepared_timetable(
                &services,
                key.clone(),
                buffer as u32 * 60,
                complete_service_coverage,
            )
        {
            timetable.coverage_end = coverage_end;
            self.timetable = Some(timetable);
            self.install_query_workspace();
            return Ok(());
        }
        let calendar_ms = started.elapsed().as_secs_f64() * 1000.;
        let source_started = std::time::Instant::now();
        let mut source_reused = false;
        let mut realtime_trips: Arc<[u32]> = Arc::new([]);
        let mut alerts = None;
        let (mut source, mut names, realtime) = if let Some(source_key) = source_key {
            let base = match self.timetable_cache.source(&source_key) {
                Some(base) => {
                    source_reused = true;
                    base
                }
                None => {
                    let read = self.read_schedule(services, instances, coverage_end)?;
                    let base = Arc::new(ScheduleSource::new(source_key, read));
                    if self.timetable_cache.insert_source(base.clone())
                        && let Some(pool) = &mut self.timetable_blocks
                    {
                        pool.prune();
                    }
                    base
                }
            };
            let input = realtime::Input {
                snapshot: snapshot.ok_or("Realtime view requires a snapshot")?,
                start_date: start_date.as_deref(),
            };
            let clock = realtime_clock(input.snapshot, request, &self.metadata)?;
            let headways: Vec<String> = self
                .db
                .prepare("SELECT DISTINCT trip_id FROM frequencies WHERE exact_times=0")?
                .query_map([], |r| r.get(0))?
                .collect::<std::result::Result<_, _>>()?;
            let overlay =
                realtime::apply_with_headways(&base.schedule(), &input, clock, now, &headways)?;
            let mut diagnostics = realtime_diagnostics(&overlay, input.snapshot);
            if let Some(live) = live
                .as_deref()
                .filter(|_| request.get("realtimeSnapshot").is_none())
            {
                diagnostics["snapshot"] = json!({"source":"server","id":live.id,"generation":live.generation,
                    "feeds":input.snapshot["feeds"]});
            }
            let mut compiled = overlay.view;
            // A replacement may introduce calls absent from the scheduled trip.
            // Reapply the prepared accessibility profile to those new calls.
            if self.metadata["accessibility"]["profile"] == "wheelchair-strict-v1" {
                let mut statement = self
                    .db
                    .prepare("SELECT stop_id FROM wheelchair_stops WHERE boarding=1")?;
                let accessible: HashSet<String> = statement
                    .query_map([], |r| r.get(0))?
                    .collect::<std::result::Result<_, _>>()?;
                for i in 0..compiled.from_stop.len() {
                    if !accessible.contains(&base.names.stop_ids[compiled.from_stop[i] as usize]) {
                        compiled.can_board[i] = 0;
                    }
                    if !accessible.contains(&base.names.stop_ids[compiled.to_stop[i] as usize]) {
                        compiled.can_alight[i] = 0;
                    }
                }
            }

            if input.snapshot.get("alerts").is_some() {
                let parents = &self.transfers_for(&base.names.stop_ids).parents;
                alerts = realtime::apply_alerts(
                    &mut compiled,
                    &base.names,
                    input.snapshot,
                    clock,
                    now,
                    parents,
                    self.route_types()?,
                    &mut diagnostics,
                )?
                .map(Arc::new);
            }
            realtime_trips = compiled.realtime_trip_indices.to_vec().into();
            let arrays = realtime_arrays(compiled, base.arrays.stop_count);
            (arrays, base.names.clone(), diagnostics)
        } else {
            let read = self.read_schedule(services, instances, coverage_end)?;
            let ScheduleSource { arrays, names, .. } = ScheduleSource::new(String::new(), read);
            (arrays, names, Value::Null)
        };
        let linked_started = std::time::Instant::now();
        let linked_candidates_reused = self.linked_candidates.is_some();
        if self.linked_candidates.is_none() {
            self.linked_candidates = Some(super::linked_trips::load_candidates(&self.db)?);
        }
        let linked_candidates_ms = linked_started.elapsed().as_secs_f64() * 1000.;
        let links = super::linked_trips::compile(
            self.linked_candidates
                .as_ref()
                .expect("initialized candidates"),
            &mut source,
            &mut names,
        )?;
        let linked_ms = linked_started.elapsed().as_secs_f64() * 1000.;
        let source_ms = source_started.elapsed().as_secs_f64() * 1000.;
        let index_started = std::time::Instant::now();
        // Sources normally use exactly the City's stops; a source that adds a
        // stop absent from them derives its own inputs.
        let transfers = self.transfers_for(&names.stop_ids);
        let n = source.stop_count as usize;
        let mut retained = transfers.direct.clone();
        for &s in source.from_stop.iter().chain(&source.to_stop) {
            retained[s as usize] = 1;
        }
        let mut p = crate::prepare_timetable_indexes_view(crate::TimetablePreparationView {
            departure_seconds: &source.departure_seconds,
            from_stop: &source.from_stop,
            can_board: &source.can_board,
            retained_stops: &retained,
            coordinates: &transfers.coords,
            transfer_from: &transfers.transfer_from,
            transfer_to: &transfers.transfer_to,
            transfer_seconds: &transfers.transfer_seconds,
            forbidden_from: &transfers.forbidden_from,
            forbidden_to: &transfers.forbidden_to,
            station_offset: &transfers.station_offset,
            station_members: &transfers.station_members,
            walking_speed_kph: self.speed,
        })?;
        if !allow {
            let group = |id: &String| {
                let mut id = id.clone();
                let mut seen = HashSet::new();
                while seen.insert(id.clone()) {
                    let parent = self.stop(&id).map(|s| s.parent.clone()).unwrap_or_default();
                    if parent.is_empty() {
                        break;
                    }
                    id = parent;
                }
                id
            };
            let groups: Vec<String> = names.stop_ids.iter().map(group).collect();
            let mut offsets = vec![0];
            let mut to = vec![];
            let mut duration = vec![];
            for a in 0..n {
                for e in p.transfer_offset[a]..p.transfer_offset[a + 1] {
                    let e = e as usize;
                    if groups[a] == groups[p.transfer_to[e] as usize] {
                        to.push(p.transfer_to[e]);
                        duration.push(p.transfer_duration[e]);
                    }
                }
                offsets.push(to.len() as u32);
            }
            p.transfer_offset = offsets.into();
            p.transfer_to = to.into();
            p.transfer_duration = duration.into();
        }
        let index_ms = index_started.elapsed().as_secs_f64() * 1000.;
        let kernel_started = std::time::Instant::now();
        let semantics = super::service::load(&self.db, &names, &links, &source, &service_offsets)?;
        let mut kernel = TimetableKernel::new(TimetableKernelInput {
            stop_count: source.stop_count,
            run_count: source.run_count,
            departure_seconds: source.departure_seconds,
            arrival_seconds: source.arrival_seconds,
            from_stop: source.from_stop,
            to_stop: source.to_stop,
            sequence: source.sequence,
            segment_trip: source.segment_trip,
            segment_run: source.segment_run,
            continuity_break: source.continuity_break,
            can_board: source.can_board,
            can_alight: source.can_alight,
            trip_start: source.trip_start,
            departure_offset: p.departure_offset,
            departure_order: p.departure_order,
            transfer_offset: p.transfer_offset,
            transfer_to: p.transfer_to,
            transfer_duration: p.transfer_duration,
            forbidden_same_stop: transfers.forbidden_same_stop.clone().into(),
            same_stop_transfer_minimum: Some(transfers.same_stop_transfer_minimum.clone().into()),
            minimum_transfer_buffer_seconds: Some(buffer as u32 * 60),
        })?;
        if let Some(semantics) = semantics {
            kernel.set_service_semantics(semantics)?;
        }
        self.timetable_preparation_profile = json!({"setupMs":calendar_ms,"sourceAndRealtimeMs":source_ms,"sourceReused":source_reused,
            "linkedCandidatesReused":linked_candidates_reused,"linkedCandidatesMs":linked_candidates_ms,"linkedTripsMs":linked_ms,
            "indexMs":index_ms,"kernelMs":kernel_started.elapsed().as_secs_f64()*1000.});
        self.timetable = Some(Timetable {
            kernel,
            links,
            stop_ids: names.stop_ids,
            index: transfers.index.clone(),
            trip_ids: names.trip_ids,
            route_ids: names.route_ids,
            trip_service_dates: names.trip_service_dates,
            key,
            realtime,
            preparation: "source",
            complete_service_coverage,
            coverage_end,
            realtime_trips,
            alerts,
        });
        self.install_query_workspace();
        Ok(())
    }
    fn transfers_for(&self, stop_ids: &[String]) -> Arc<TransferInputs> {
        if stop_ids.len() == self.stops.len() {
            self.transfer_inputs
                .get_or_init(|| Arc::new(self.transfer_inputs_for(stop_ids)))
                .clone()
        } else {
            Arc::new(self.transfer_inputs_for(stop_ids))
        }
    }
    fn route_types(&self) -> Result<Arc<HashMap<String, i64>>> {
        if let Some(types) = self.route_types.get() {
            return Ok(types.clone());
        }
        let mut types = HashMap::new();
        let mut statement = self.db.prepare("SELECT route_id,route_type FROM routes")?;
        for row in statement.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, Option<i64>>(1)?))
        })? {
            if let (id, Some(kind)) = row? {
                types.insert(id, kind);
            }
        }
        Ok(self.route_types.get_or_init(|| Arc::new(types)).clone())
    }
    pub(super) fn retire_timetable(&mut self) {
        if let Some(mut timetable) = self.timetable.take() {
            let workspace = timetable.kernel.take_query_workspace();
            if self.query_workspace.is_none() {
                self.query_workspace = Some(workspace);
            }
            if self.timetable_cache.budget > 0
                && timetable.coverage_end.is_some()
                && let Some(pool) = &mut self.timetable_blocks
            {
                timetable.kernel.share_source_columns(pool);
            }
            let released = self.timetable_cache.insert(timetable);
            if released && let Some(pool) = &mut self.timetable_blocks {
                pool.prune();
            }
        }
    }
    pub(super) fn install_query_workspace(&mut self) {
        if let Some(pool) = &mut self.timetable_blocks {
            // Keep the first-date hot path contiguous. Sharing starts only
            // when another date is retained and may reuse these columns.
            if self.timetable_cache.entries().next().is_some()
                && let Some(timetable) = &mut self.timetable
                && timetable.kernel.share_source_columns(pool)
            {
                pool.prune();
            }
        }
        if let (Some(timetable), Some(query)) = (&mut self.timetable, self.query_workspace.take()) {
            timetable.kernel.install_query_workspace(query);
        }
    }
    pub(crate) fn take_query_workspace(
        &mut self,
    ) -> Option<crate::timetable::TimetableQueryWorkspace> {
        self.query_workspace.take().or_else(|| {
            self.timetable
                .as_mut()
                .map(|t| t.kernel.take_query_workspace())
        })
    }
    pub(crate) fn load_drive(&mut self) -> Result<()> {
        if self.manifest["modes"]
            .as_array()
            .is_some_and(|m| !m.iter().any(|v| v == "drive"))
        {
            return fail(
                "Driving is not prepared in this City; rebuild with street-modes walk,drive",
            );
        }
        if self.drive.is_some() {
            return Ok(());
        }
        let path = self
            .path
            .join("osm/street-index.sqlite.drive-accelerator-v2.bin");
        let image = Image::open(&path, false)?;
        if image.header["magic"] != "vigo.drive.accelerator" || image.header["version"] != 2 {
            return fail("Unsupported drive snapshot");
        }
        let (structure, time, distance) = cch_files(&path, "drive")?;
        let lons = image.f64("nodeLons")?;
        let lats = image.f64("nodeLats")?;
        // The kernel owns the coordinates; it attaches free points to roads.
        let kernel = DriveKernel::new(DriveKernelInput {
            node_count: lons.len() as u32,
            node_lons: lons,
            node_lats: lats,
            edge_offsets: image.u32("edgeOffsets")?,
            edge_targets: image.u32("edgeTargets")?,
            edge_distances: None,
            edge_travel_times: None,
            edge_distance_units: Some(image.u32("edgeDistanceUnits")?),
            edge_time_units: Some(image.u32("edgeTimeUnits")?),
            cch_structure_path: Some(structure),
            cch_time_metric_path: Some(time),
            cch_distance_metric_path: distance,
        })?;
        self.drive = Some(Drive {
            automatic_traffic: None,
            kernel,
            image,
        });
        Ok(())
    }
}

// Realtime views keep every original trip, so the source's tables still apply.
fn realtime_arrays(view: RealtimeTimetableResult, stop_count: u32) -> ServiceTimetableResult {
    ServiceTimetableResult {
        stop_ids: Vec::new(),
        departure_seconds: view.departure_seconds,
        arrival_seconds: view.arrival_seconds,
        from_stop: view.from_stop,
        to_stop: view.to_stop,
        sequence: view.sequence,
        segment_trip: view.segment_trip,
        segment_run: view.segment_run,
        continuity_break: view.continuity_break,
        can_board: view.can_board,
        can_alight: view.can_alight,
        trip_start: view.trip_start,
        trip_ids: Vec::new(),
        route_ids: Vec::new(),
        service_ids: Vec::new(),
        direction_ids: Vec::new(),
        trip_service_dates: Vec::new(),
        run_count: view.run_count,
        stop_count,
    }
}

fn percent_decode(value: &str) -> Result<String> {
    let mut output = Vec::with_capacity(value.len());
    let bytes = value.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let pair = std::str::from_utf8(
                bytes
                    .get(i + 1..i + 3)
                    .ok_or("Invalid profile percent encoding")?,
            )?;
            output.push(u8::from_str_radix(pair, 16)?);
            i += 3;
        } else {
            output.push(bytes[i]);
            i += 1;
        }
    }
    Ok(String::from_utf8(output)?)
}

#[cfg(test)]
mod identity_tests {
    use super::*;

    #[test]
    fn older_city_optional_counts_match_compiler_identity() {
        let metadata = json!({"connectionCount": 10, "transferCount": 3, "stopCount": 4});
        let expected = routing_source_identity(&metadata);
        assert_eq!(expected["bridgedUntimedGapCount"], -1);
        let mut explicit_null = metadata.clone();
        explicit_null["bridgedUntimedGapCount"] = Value::Null;
        assert_eq!(routing_source_identity(&explicit_null), expected);
        let mut zero = metadata.clone();
        zero["bridgedUntimedGapCount"] = json!(0);
        assert_ne!(routing_source_identity(&zero), expected);
        let mut changed = metadata;
        changed["connectionCount"] = json!(11);
        assert_ne!(routing_source_identity(&changed), expected);
    }
}
