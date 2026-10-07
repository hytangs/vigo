use super::{Result, access::AccessContext, fail, flag, number};
use crate::*;
use chrono::{Datelike, NaiveDate};
use memmap2::Mmap;
use rusqlite::{Connection, OpenFlags};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeSet, HashMap, HashSet},
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
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

pub(crate) struct Image {
    pub header: Value,
    bytes: Mmap,
    base: usize,
}
impl Image {
    // Parse large metadata directly into its native projection; unknown fields
    // are validated as JSON and skipped instead of retained as Value trees.
    pub(crate) fn open_with_metadata<T: serde::de::DeserializeOwned>(
        path: &Path,
    ) -> Result<(Self, T)> {
        #[derive(serde::Deserialize)]
        struct Envelope<T> {
            metadata: T,
            #[serde(flatten)]
            header: serde_json::Map<String, Value>,
        }
        let file = File::open(path)?;
        // Prepared City artifacts are immutable for the process lifetime.
        let bytes = unsafe { Mmap::map(&file)? };
        let (range, base) = portable_header(&bytes)?;
        let parsed: Envelope<T> = serde_json::from_slice(&bytes[range])?;
        let image = Self {
            header: Value::Object(parsed.header),
            bytes,
            base,
        };
        image.validate_portable_arrays()?;
        Ok((image, parsed.metadata))
    }
    fn validate_portable_arrays(&self) -> Result<()> {
        if !self.base.is_multiple_of(8) {
            return fail("Unaligned routing snapshot payload");
        }
        let mut ranges = Vec::new();
        for (name, array) in self.header["arrays"]
            .as_object()
            .ok_or("Missing snapshot arrays")?
        {
            let kind = array["type"].as_str().ok_or("Missing array type")?;
            let size = match kind {
                "Uint8Array" => 1,
                "Uint32Array" | "Int32Array" => 4,
                "Float64Array" => 8,
                _ => return fail("Unsupported snapshot array type"),
            };
            let bytes = self.array(name, kind, size)?;
            let start = usize::try_from(array["offset"].as_u64().ok_or("Invalid array offset")?)?;
            ranges.push((start, bytes.len()));
        }
        // JSON object key order is immaterial. Zero-length arrays sharing an
        // offset precede a nonempty array at that offset.
        ranges.sort_unstable();
        let mut end = 0usize;
        for (start, length) in ranges {
            let aligned = end.checked_add(7).ok_or("Array alignment overflow")? / 8 * 8;
            if start != aligned {
                return fail("Overlapping or noncanonical snapshot arrays");
            }
            end = start.checked_add(length).ok_or("Array end overflow")?;
        }
        Ok(())
    }
    pub fn open(path: &Path, portable: bool) -> Result<Self> {
        let file = File::open(path)?;
        // City artifacts are immutable for the lifetime of the process.
        let bytes = unsafe { Mmap::map(&file)? };
        let (header, base) = if portable {
            let (range, base) = portable_header(&bytes)?;
            (serde_json::from_slice(&bytes[range])?, base)
        } else {
            if bytes.len() < 4096 {
                return fail("Truncated street snapshot");
            }
            let s = std::str::from_utf8(&bytes[..4096])?.trim_matches(['\0', ' ', '\n', '\r']);
            let header: Value = serde_json::from_str(s)?;
            if header["byteLength"].as_u64() != Some(bytes.len() as u64) {
                return fail("Street snapshot size mismatch");
            }
            (header, 0)
        };
        Ok(Self {
            header,
            bytes,
            base,
        })
    }
    pub(crate) fn array(&self, name: &str, kind: &str, size: usize) -> Result<&[u8]> {
        let a = &self.header["arrays"][name];
        if a["type"] != kind {
            return fail(format!("Invalid snapshot array {name}"));
        }
        let start = usize::try_from(a["offset"].as_u64().ok_or("Invalid array offset")?)?
            .checked_add(self.base)
            .ok_or("Array offset overflow")?;
        let length = usize::try_from(a["length"].as_u64().ok_or("Invalid array length")?)?
            .checked_mul(size)
            .ok_or("Array length overflow")?;
        self.bytes
            .get(start..start.checked_add(length).ok_or("Array end overflow")?)
            .ok_or_else(|| "Array exceeds snapshot".into())
    }
    pub fn u32(&self, name: &str) -> Result<Vec<u32>> {
        Ok(self
            .array(name, "Uint32Array", 4)?
            .chunks_exact(4)
            .map(|x| u32::from_le_bytes(x.try_into().unwrap()))
            .collect())
    }
    pub fn f64(&self, name: &str) -> Result<Vec<f64>> {
        Ok(self
            .array(name, "Float64Array", 8)?
            .chunks_exact(8)
            .map(|x| f64::from_le_bytes(x.try_into().unwrap()))
            .collect())
    }
}

fn portable_header(bytes: &[u8]) -> Result<(std::ops::Range<usize>, usize)> {
    if bytes.len() < 16 || &bytes[..8] != b"VIGORS01" {
        return fail("Invalid routing snapshot magic");
    }
    let len = u32::from_le_bytes(bytes[8..12].try_into()?) as usize;
    let base = u32::from_le_bytes(bytes[12..16].try_into()?) as usize;
    if len > bytes.len() - 16 || base < 16 + len || base > bytes.len() {
        return fail("Invalid routing snapshot header");
    }
    Ok((16..16 + len, base))
}

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
    let prefix = format!("{}.", path.file_name().unwrap().to_string_lossy());
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with(&prefix) || !name.ends_with(".manifest.json") {
            continue;
        }
        let m = read_json(&entry.path())?;
        if m["schemaVersion"] != "vigo.native-cch-manifest.v1" || m["kind"] != kind {
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
    pub stop_ids: Vec<String>,
    pub index: HashMap<String, u32>,
    pub trip_ids: Vec<String>,
    pub route_ids: Vec<String>,
    pub key: String,
    pub realtime: Value,
    pub preparation: &'static str,
}
pub(crate) struct Drive {
    pub kernel: DriveKernel,
    pub image: Image,
    pub lons: Vec<f64>,
    pub lats: Vec<f64>,
    pub spatial_offsets: Vec<u32>,
    pub spatial_nodes: Vec<u32>,
}
pub struct City {
    pub(crate) path: PathBuf,
    pub(crate) db: Connection,
    pub(crate) manifest: Value,
    pub(crate) metadata: Value,
    pub(crate) context: Image,
    pub(crate) access: AccessContext,
    pub(crate) stops: Vec<Stop>,
    pub(crate) stop_index: HashMap<String, usize>,
    pub(crate) members: Vec<String>,
    pub(crate) street: CoordinateKernel,
    pub(crate) drive: Option<Drive>,
    pub(crate) timetable: Option<Timetable>,
    pub(crate) speed: f64,
    pub(crate) padding: f64,
    pub(crate) overhead: f64,
    pub(crate) shapes: ShapeGeometrySource,
    pub(crate) shape_cache: super::materialize::ShapeCache,
    // Immutable source metadata, shared by journeys in this City. These are
    // bounded by the City's routes/trips and never contain query answers.
    pub(crate) route_metadata: HashMap<String, Value>,
    pub(crate) trip_shape_ids: HashMap<String, Option<String>>,
    pub(crate) transfer_rows: HashMap<String, usize>,
    pub(crate) transfer_shortcut_rows: HashMap<String, usize>,
}
impl City {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = fs::canonicalize(path)?;
        let manifest = read_json(&path.join("network.json"))?;
        if manifest["schemaVersion"] != "vigo.city.v1" {
            return fail("Expected a prepared vigo.city.v1 City");
        }
        let db_path = path.join("routing/project.sqlite");
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
        if metadata["schemaVersion"] != "vigo.routing.store.v3"
            || metadata["transferSemanticsVersion"] != "vigo.routing.transfers.v4"
        {
            return fail("Rebuild City with the current routing/transfer format");
        }
        if metadata["blockingRoutingFeatures"]
            .as_array()
            .is_some_and(|x| !x.is_empty())
        {
            return fail("City contains blocking routing features");
        }
        let (context, mut access) = Image::open_with_metadata::<AccessContext>(
            &path.join("routing/project.sqlite.access-context.bin"),
        )?;
        if access.schema_version != "vigo.routing.access-context.v1"
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
        let policy: Value = serde_json::from_str(&access.access_policy_identity)?;
        if policy["transferWalkingTimeFloor"] != "distance-at-configured-speed-v1"
            || policy["unpricedPathways"] != "typed-estimates-otherwise-excluded-v2"
            || policy["pathwayCostModel"]["id"]
                != "stairs-one-second-per-step-gates-five-seconds-v1"
            || policy["pathwayCostModel"]["secondsPerStair"] != 1
            || policy["pathwayCostModel"]["gateSeconds"] != 5
            || policy["stationStreetAnchors"] != "declared-entrances-v1"
            || policy["stationStreetTransfers"] != "entrance-pathway-chain-v1"
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
            let location = s["location_type"].as_u64().unwrap_or(0) as u32;
            let coordinate = |key: &str| -> Result<f64> {
                match s[key].as_f64() {
                    Some(value) => Ok(value),
                    None if s[key].is_null() && [3, 4].contains(&location) => Ok(f64::NAN),
                    _ => fail("Invalid stop coordinate"),
                }
            };
            stops.push(Stop {
                id,
                name: s["name"].as_str().unwrap_or("").to_owned(),
                lon: coordinate("lon")?,
                lat: coordinate("lat")?,
                parent: s["parent_station"].as_str().unwrap_or("").to_owned(),
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
        let street_path = path.join("osm/street-index.sqlite.street-accelerator-v7.bin");
        let street_header = Image::open(&street_path, false)?;
        if street_header.header["identity"]["schemaVersion"] != "vigo.street.store.v5" {
            return fail(
                "Street pedestrian restrictions are stale; rebuild the City from the source OSM PBF",
            );
        }
        let (structure_path, metric_path, _) = cch_files(&street_path, "street")?;
        let mut street = CoordinateKernel::open_prepared(
            str_path(&street_path)?,
            StreetCchLoadInput {
                structure_path,
                metric_path,
            },
        )?;
        let terminal = path.join("osm/street-index.sqlite.terminal-access-v1.json");
        if terminal.exists() {
            street.configure_terminal_access(str_path(&terminal)?)?;
        } else if ["endpoints", "authorized_endpoints"]
            .iter()
            .any(|m| manifest["streetStore"]["terminalAccess"]["model"] == *m)
        {
            return fail("Missing terminal-access artifact for private endpoints City");
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
        let fingerprint = street_header.header["identity"]["sourceFingerprint"]
            .as_str()
            .ok_or("Missing street source fingerprint")?;
        if !percent_decode(key_parts[2])?
            .split('|')
            .any(|v| v == fingerprint)
        {
            return fail("Coordinate profile belongs to another street source");
        }
        let suffix = crate::route_materialization::stable_key_suffix(key.encode_utf16().collect());
        let snapshot = path.join(format!(
            "routing/project.sqlite.native-access-profile.{suffix}.bin"
        ));
        street.load_access_profile_snapshot(str_path(&snapshot)?, key.to_owned())?;
        if street
            .profile
            .as_ref()
            .is_none_or(|p| p.member_lons.len() != members.len())
        {
            return fail("Coordinate access member count mismatch");
        }
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
            path,
            db,
            manifest,
            metadata,
            context,
            access,
            stops,
            stop_index,
            members,
            street,
            drive: None,
            timetable: None,
            speed,
            padding,
            overhead,
            transfer_rows,
            transfer_shortcut_rows,
        })
    }
    pub fn info(&self) -> Value {
        json!({"schemaVersion":"vigo.standalone.city.v1","name":self.manifest["name"],"revisionId":self.manifest["revisionId"],"sources":self.manifest["sources"],"runtime":"rust","routing":self.manifest["routingStore"],"streets":self.manifest["streetStore"],"warnings":self.metadata["routingLimitations"]})
    }
    pub(crate) fn stop(&self, id: &str) -> Result<&Stop> {
        self.stop_index
            .get(id)
            .map(|&i| &self.stops[i])
            .ok_or_else(|| format!("Unknown stopId: {id}").into())
    }
    pub(crate) fn activate(&mut self, request: &Value) -> Result<()> {
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
        let allow = flag(request, "allowStreetTransfers", true)?;
        let buffer = number(request, "minimumTransferBufferMinutes", 0., 0., 60.)?;
        if buffer.fract() != 0. {
            return fail("minimumTransferBufferMinutes must be an integer");
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_secs_f64();
        let realtime_key = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&json!([
                request["realtimeSnapshot"],
                super::realtime::validity(request, now)
            ]))?)
        );
        let complete_coverage = flag(request, "requireCompleteServiceCoverage", false)?;
        let key = format!("{date_text}:{allow}:{buffer}:{realtime_key}:{complete_coverage}");
        if self.timetable.as_ref().is_some_and(|t| t.key == key) {
            return Ok(());
        }
        let date_number = date.year() * 10000 + date.month() as i32 * 100 + date.day() as i32;
        let sql = format!(
            "SELECT service_id FROM calendar WHERE {day}=1 AND start_date<=?1 AND end_date>=?1"
        );
        let mut services: BTreeSet<String> = self
            .db
            .prepare(&sql)?
            .query_map([date_number], |r| r.get(0))?
            .collect::<std::result::Result<_, _>>()?;
        for row in self
            .db
            .prepare("SELECT service_id,exception_type FROM calendar_dates WHERE date=?1")?
            .query_map([date_number], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, i32>(1)?))
            })?
        {
            let (id, kind) = row?;
            if kind == 1 {
                services.insert(id);
            } else if kind == 2 {
                services.remove(&id);
            }
        }
        if services.is_empty() && self.metadata["serviceModel"] == "weekday-template" {
            services.insert(service_day.to_owned());
        }
        if flag(request, "requireCompleteServiceCoverage", false)? {
            let all: Vec<String> = self
                .db
                .prepare(
                    "SELECT service_id FROM calendar UNION SELECT service_id FROM calendar_dates",
                )?
                .query_map([], |r| r.get(0))?
                .collect::<std::result::Result<_, _>>()?;
            let scopes: HashSet<&str> = all
                .iter()
                .filter_map(|id| id.split_once('\u{1f}').map(|p| p.0))
                .collect();
            let active: HashSet<&str> = services
                .iter()
                .filter_map(|id| id.split_once('\u{1f}').map(|p| p.0))
                .collect();
            if scopes.len() > 1 && !scopes.is_subset(&active) {
                return fail(
                    "Incomplete service coverage across source feeds on the requested date",
                );
            }
        }
        if allow
            && request.get("realtimeSnapshot").is_none()
            && let Ok(timetable) =
                self.prepared_timetable(&services, key.clone(), buffer as u32 * 60)
        {
            self.timetable = Some(timetable);
            return Ok(());
        }
        let has_permissions: bool = self.db.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='connection_permissions')",
            [],
            |r| r.get(0),
        )?;
        let mut source = read_service_timetable(ServiceTimetableInput {
            store_path: str_path(&self.path.join("routing/project.sqlite"))?,
            stop_ids: self.stops.iter().map(|s| s.id.clone()).collect(),
            service_ids: services.into_iter().collect(),
            has_connection_permissions: has_permissions,
            segment_count: None,
        })?;
        let realtime = super::realtime::apply(&mut source, request, &self.metadata, now)?;
        let index: HashMap<String, u32> = source
            .stop_ids
            .iter()
            .enumerate()
            .map(|(i, s)| (s.clone(), i as u32))
            .collect();
        let n = source.stop_count as usize;
        let saved = &self.access.materialized;
        let direct: HashSet<&str> = saved
            .stop_access_index
            .direct_service_stop_ids
            .iter()
            .map(String::as_str)
            .collect();
        let mut retained: Vec<u8> = source
            .stop_ids
            .iter()
            .map(|s| u8::from(direct.contains(s.as_str())))
            .collect();
        for &s in source.from_stop.iter().chain(&source.to_stop) {
            retained[s as usize] = 1;
        }
        let coords: Vec<f64> = source
            .stop_ids
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
        let mut p = prepare_timetable_indexes(TimetablePreparationInput {
            departure_seconds: source.departure_seconds.clone(),
            from_stop: source.from_stop.clone(),
            can_board: source.can_board.clone(),
            retained_stops: retained,
            coordinates: coords,
            transfer_from,
            transfer_to,
            transfer_seconds,
            forbidden_from,
            forbidden_to,
            station_offset,
            station_members,
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
            let groups: Vec<String> = source.stop_ids.iter().map(group).collect();
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
            p.transfer_offset = offsets;
            p.transfer_to = to;
            p.transfer_duration = duration;
        }
        let kernel = TimetableKernel::new(TimetableKernelInput {
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
            forbidden_same_stop,
            same_stop_transfer_minimum: Some(same_stop_transfer_minimum),
            minimum_transfer_buffer_seconds: Some(buffer as u32 * 60),
        })?;
        self.timetable = Some(Timetable {
            kernel,
            stop_ids: source.stop_ids,
            index,
            trip_ids: source.trip_ids,
            route_ids: source.route_ids,
            key,
            realtime,
            preparation: "source",
        });
        Ok(())
    }
    pub(crate) fn load_drive(&mut self) -> Result<()> {
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
        let kernel = DriveKernel::new(DriveKernelInput {
            node_count: lons.len() as u32,
            node_lons: lons.clone(),
            node_lats: lats.clone(),
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
        let spatial_offsets = image.u32("spatialOffsets")?;
        let spatial_nodes = image.u32("spatialNodeIndices")?;
        self.drive = Some(Drive {
            kernel,
            image,
            lons,
            lats,
            spatial_offsets,
            spatial_nodes,
        });
        Ok(())
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
