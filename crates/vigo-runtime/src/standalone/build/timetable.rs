//! `--prepare-date`: compile a service date's timetable ahead of time.
//!
//! Dates with the same active services share one snapshot,
//! `project.sqlite.active-service-kernel.<key>.bin`, which runtimes load
//! instead of reading the schedule from SQLite on the first query.
use super::Result;
use super::access::{AccessStore, to_uint32, u8_array, u32_array};
use super::policy::{POLICY, stable_key_suffix, transfer_duration_seconds};
use chrono::{Datelike, NaiveDate};
use rusqlite::{Connection, OpenFlags};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use vigo_format::js::Js;
use vigo_format::{ServiceTimetableInput, encode_routing_snapshot, read_service_timetable};
use vigo_route::timetable::{TimetablePreparationInput, prepare_timetable_indexes};

const SCHEMA: &str = "vigo.routing.active-service-kernel.v15-portable";
const TRANSFER_PROJECTION: &str = "single_edge_service_ingress.v7-station-chain";

/// `activeServiceIds`: calendar weekdays in range, then dated exceptions.
fn active_services(db: &Connection, date: NaiveDate) -> Result<Vec<String>> {
    let number = f64::from(date.year() * 10_000 + date.month() as i32 * 100 + date.day() as i32);
    let weekday = [
        "sunday",
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
    ][date.weekday().num_days_from_sunday() as usize];
    let mut services: Vec<String> = vec![];
    let mut seen = HashSet::new();
    let mut statement = db.prepare(&format!(
        "SELECT service_id FROM calendar WHERE start_date <= ? AND end_date >= ? AND {weekday}=1"
    ))?;
    for id in statement.query_map([number, number], |r| r.get::<_, String>(0))? {
        let id = id?;
        if seen.insert(id.clone()) {
            services.push(id);
        }
    }
    let mut statement =
        db.prepare("SELECT service_id, exception_type FROM calendar_dates WHERE date=?")?;
    let mut rows = statement.query([number])?;
    while let Some(row) = rows.next()? {
        let id: String = row.get(0)?;
        match row.get::<_, f64>(1)? {
            1.0 if seen.insert(id.clone()) => services.push(id),
            2.0 if seen.remove(&id) => services.retain(|s| *s != id),
            _ => {}
        }
    }
    Ok(services)
}

/// The installed memory planning budget (`defaultTimetableBudgetBytes`).
fn timetable_budget_bytes() -> f64 {
    let total = super::host::memory_bytes() as f64;
    let default = (total / 8.0)
        .floor()
        .clamp(64.0 * 1024.0 * 1024.0, 2.0 * 1024.0 * 1024.0 * 1024.0);
    std::env::var("VIGO_ACTIVE_KERNEL_MAX_BYTES")
        .ok()
        .map(|v| super::policy::js_number(&v))
        .filter(|v| v.is_finite() && *v > 0.0)
        .map_or(default, |v| {
            v.floor()
                .clamp(1024.0 * 1024.0, 16.0 * 1024.0 * 1024.0 * 1024.0)
        })
}

/// Prepare one service date. Fails when the date has no active service.
/// Returns `false` when the City's frequency templates make every runtime
/// compile the timetable from its source instead.
pub(crate) fn prepare_date(store: &AccessStore, date: &str) -> Result<bool> {
    let failed = || format!("Timetable preparation failed for {date}");
    let parsed = NaiveDate::parse_from_str(date, "%Y-%m-%d").map_err(|_| failed())?;
    let db = Connection::open_with_flags(&store.path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    if super::super::prepared::frequency_templates(&db)? {
        return Ok(false);
    }
    let services = active_services(&db, parsed)?;
    if services.is_empty() {
        return Err(failed().into());
    }
    let mut sorted: Vec<&str> = services.iter().map(String::as_str).collect();
    sorted.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    let service_key = format!("services:{}", sorted.join("\u{1f}"));
    let identity = Js::object()
        .with("schemaVersion", SCHEMA)
        .with(
            "sourceArtifactIdentity",
            store.source_artifact_identity.as_str(),
        )
        .with("serviceKey", service_key.as_str())
        .with("accessPolicyIdentity", POLICY.identity.as_str())
        .stringify();
    let mut path = store.path.as_os_str().to_owned();
    path.push(format!(
        ".active-service-kernel.{}.bin",
        stable_key_suffix(&identity)
    ));
    let path = PathBuf::from(path);
    // Count the slice first, as the runtime's memory guard does.
    db.execute_batch("PRAGMA temp_store=MEMORY; CREATE TEMP TABLE active_kernel_services(service_id TEXT PRIMARY KEY) WITHOUT ROWID;")?;
    {
        let mut insert = db.prepare("INSERT INTO active_kernel_services VALUES(?)")?;
        for id in &services {
            insert.execute([id])?;
        }
    }
    let segment_count: f64 = db.query_row(
        "SELECT COUNT(*) FROM connections c JOIN active_kernel_services a ON a.service_id=c.service_id",
        [],
        |r| r.get(0),
    )?;
    drop(db);
    let budget = timetable_budget_bytes();
    if segment_count == 0.0 {
        return Err(failed().into());
    }
    if segment_count * 96.0 + store.stops.len() as f64 * 256.0 > budget {
        return Err(format!(
            "{}: the preliminary timetable estimate exceeds the {} MiB guard",
            failed(),
            (budget / 1024.0 / 1024.0).floor()
        )
        .into());
    }
    let stop_ids: Vec<String> = store.stops.iter().map(|s| s.id.clone()).collect();
    let source = read_service_timetable(ServiceTimetableInput {
        store_path: store
            .path
            .to_str()
            .ok_or("City paths must be UTF-8")?
            .to_owned(),
        stop_ids: stop_ids.clone(),
        service_ids: services.clone(),
        has_connection_permissions: store.has_connection_permissions,
        segment_count: Some(segment_count as u32),
        service_instances: None,
        maximum_departure_seconds: None,
    })?;
    if source.departure_seconds.is_empty() {
        return Err(failed().into());
    }
    let stop_count = source.stop_ids.len();
    let index: std::collections::HashMap<&str, u32> = source
        .stop_ids
        .iter()
        .enumerate()
        .map(|(i, id)| (id.as_str(), i as u32))
        .collect();
    let mut retained = vec![0u8; stop_count];
    for (i, id) in source.stop_ids.iter().enumerate() {
        if store.index.direct_service.contains(id) {
            retained[i] = 1;
        }
    }
    for (&from, &to) in source.from_stop.iter().zip(source.to_stop.iter()) {
        retained[from as usize] = 1;
        retained[to as usize] = 1;
    }
    // `serviceTransferRows`: each origin's transfers, then its shortcuts.
    let mut transfer_from = vec![];
    let mut transfer_to = vec![];
    let mut transfer_seconds = vec![];
    let mut push = |from: &str, to: &str, seconds: f64| {
        if store.forbidden.contains(&format!("{from}\0{to}")) {
            return;
        }
        transfer_from.push(index.get(from).copied().unwrap_or(u32::MAX));
        transfer_to.push(index.get(to).copied().unwrap_or(u32::MAX));
        transfer_seconds.push(if seconds.is_finite() { seconds } else { 0.0 });
    };
    let shortcut_origins: HashSet<&str> = store.shortcuts.iter().map(|(f, _)| f.as_str()).collect();
    let shortcuts_of = |from: &str| {
        store
            .shortcuts
            .iter()
            .find(|(f, _)| f == from)
            .map(|(_, rows)| rows)
    };
    for (from, edges) in &store.transfers {
        for edge in edges {
            push(from, &edge.to, edge.seconds());
        }
        if shortcut_origins.contains(from.as_str())
            && let Some(rows) = shortcuts_of(from)
        {
            for row in rows {
                push(from, &row.to, row.seconds);
            }
        }
    }
    let transfer_origins: HashSet<&str> = store.transfers.iter().map(|(f, _)| f.as_str()).collect();
    for (from, rows) in &store.shortcuts {
        if transfer_origins.contains(from.as_str()) {
            continue;
        }
        for row in rows {
            push(from, &row.to, row.seconds);
        }
    }
    let (forbidden_from, forbidden_to): (Vec<u32>, Vec<u32>) = store
        .forbidden
        .items
        .iter()
        .filter_map(|pair| {
            let (a, b) = pair.split_once('\0')?;
            Some((*index.get(a)?, *index.get(b)?))
        })
        .unzip();
    let mut station_offset = vec![0u32];
    let mut station_members = vec![];
    for (_, ids) in &store.station_members {
        if ids
            .iter()
            .any(|id| store.declared_pathway_stops.contains(id))
        {
            continue;
        }
        station_members.extend(ids.iter().filter_map(|id| index.get(id.as_str()).copied()));
        station_offset.push(station_members.len() as u32);
    }
    let coordinates: Vec<f64> = source
        .stop_ids
        .iter()
        .flat_map(|id| {
            let stop = store.stop(id);
            stop.map_or([f64::NAN; 2], |s| {
                let (lon, lat) = s.packed();
                [lon, lat]
            })
        })
        .collect();
    let prepared = prepare_timetable_indexes(TimetablePreparationInput {
        departure_seconds: source.departure_seconds.clone(),
        from_stop: source.from_stop.clone(),
        can_board: source.can_board.clone(),
        retained_stops: retained.into(),
        coordinates: coordinates.into(),
        transfer_from: transfer_from.into(),
        transfer_to: transfer_to.into(),
        transfer_seconds: transfer_seconds.into(),
        forbidden_from: forbidden_from.into(),
        forbidden_to: forbidden_to.into(),
        station_offset: station_offset.into(),
        station_members: station_members.into(),
        walking_speed_kph: POLICY.walking_speed_kph,
    })?;
    let mut forbidden_same_stop = vec![0u8; stop_count];
    let mut same_stop_minimum = vec![0u32; stop_count];
    for (i, id) in source.stop_ids.iter().enumerate() {
        if store.forbidden.contains(&format!("{id}\0{id}")) {
            forbidden_same_stop[i] = 1;
        }
        if let Some(rule) = store.transfers_from(id).iter().find(|t| t.to == *id) {
            same_stop_minimum[i] = transfer_duration_seconds(&rule.timing()).map_or(0, to_uint32);
        }
    }
    // Construct the kernel once: the runtime rejects inputs it would reject.
    let kernel = crate::TimetableKernel::new(crate::TimetableKernelInput {
        stop_count: stop_count as u32,
        run_count: source.run_count,
        departure_seconds: source.departure_seconds.clone(),
        arrival_seconds: source.arrival_seconds.clone(),
        from_stop: source.from_stop.clone(),
        to_stop: source.to_stop.clone(),
        sequence: source.sequence.clone(),
        segment_trip: source.segment_trip.clone(),
        segment_run: source.segment_run.clone(),
        continuity_break: source.continuity_break.clone(),
        can_board: source.can_board.clone(),
        can_alight: source.can_alight.clone(),
        trip_start: source.trip_start.clone(),
        departure_offset: prepared.departure_offset.clone(),
        departure_order: prepared.departure_order.clone(),
        transfer_offset: prepared.transfer_offset.clone(),
        transfer_to: prepared.transfer_to.clone(),
        transfer_duration: prepared.transfer_duration.clone(),
        forbidden_same_stop: forbidden_same_stop.clone().into(),
        same_stop_transfer_minimum: Some(same_stop_minimum.clone().into()),
        minimum_transfer_buffer_seconds: Some(0),
    })?;
    let diagnostics = kernel.diagnostics();
    drop(kernel);
    let source_bytes = [
        source.departure_seconds.len() * 4,
        source.arrival_seconds.len() * 4,
        source.from_stop.len() * 4,
        source.to_stop.len() * 4,
        source.sequence.len() * 4,
        source.segment_trip.len() * 4,
        source.segment_run.len() * 4,
        source.continuity_break.len(),
        source.can_board.len(),
        source.can_alight.len(),
        source.trip_start.len() * 4,
        prepared.departure_offset.len() * 4,
        prepared.departure_order.len() * 4,
        prepared.transfer_offset.len() * 4,
        prepared.transfer_to.len() * 4,
        prepared.transfer_duration.len() * 4,
        stop_count,
        stop_count * 4,
    ]
    .iter()
    .sum::<usize>() as f64;
    let dictionary_bytes: f64 = [
        &source.stop_ids,
        &source.trip_ids,
        &source.route_ids,
        &source.service_ids,
        &source.direction_ids,
    ]
    .iter()
    .flat_map(|list| list.iter())
    .map(|value| value.encode_utf16().count() as f64 * 2.0 + 16.0)
    .sum();
    let estimated = source_bytes
        + diagnostics.native_index_bytes.max(0.0)
        + diagnostics.workspace_bytes.max(0.0)
        + dictionary_bytes;
    if estimated > budget {
        return Err(format!(
            "The Rust timetable kernel retains {} MiB, exceeding the {} MiB guard.",
            (estimated / 1024.0 / 1024.0).ceil(),
            (budget / 1024.0 / 1024.0).floor()
        )
        .into());
    }
    let strings = |list: &[String]| Js::Array(list.iter().map(Js::from).collect());
    let kernel = Js::object()
        .with("schemaVersion", SCHEMA)
        .with("serviceKey", service_key.as_str())
        .with(
            "sourceArtifactIdentity",
            store.source_artifact_identity.as_str(),
        )
        .with("accessPolicyIdentity", POLICY.identity.as_str())
        .with("runCount", source.run_count)
        .with("activeSegmentCount", source.departure_seconds.len())
        .with("transferCount", prepared.transfer_to.len())
        .with("transferProjectionVersion", TRANSFER_PROJECTION)
        .with("transferProjectionVerified", true)
        .with(
            "sourceExpandedTransferEdges",
            prepared.source_expanded_transfer_edges,
        )
        .with(
            "excludedNonServiceTransferEdges",
            prepared.excluded_non_service_transfer_edges,
        )
        .with(
            "excludedNonServiceStationMembers",
            prepared.excluded_non_service_station_members,
        )
        .with("stopIds", strings(&source.stop_ids))
        .with("tripIds", strings(&source.trip_ids))
        .with("routeIds", strings(&source.route_ids))
        .with("serviceIds", strings(&source.service_ids))
        .with("directionIds", strings(&source.direction_ids));
    let metadata = Js::object()
        .with("schemaVersion", SCHEMA)
        .with("kernel", kernel);
    let arrays = vec![
        u32_array("departureSeconds", &source.departure_seconds),
        u32_array("arrivalSeconds", &source.arrival_seconds),
        u32_array("fromStop", &source.from_stop),
        u32_array("toStop", &source.to_stop),
        u32_array("sequence", &source.sequence),
        u32_array("segmentTrip", &source.segment_trip),
        u32_array("segmentRun", &source.segment_run),
        u8_array("continuityBreak", &source.continuity_break),
        u8_array("canBoard", &source.can_board),
        u8_array("canAlight", &source.can_alight),
        u32_array("tripStart", &source.trip_start),
        u32_array("departureOffset", &prepared.departure_offset),
        u32_array("departureOrder", &prepared.departure_order),
        u32_array("transferOffset", &prepared.transfer_offset),
        u32_array("transferTo", &prepared.transfer_to),
        u32_array("transferDuration", &prepared.transfer_duration),
        u8_array("forbiddenSameStop", &forbidden_same_stop),
        u32_array("sameStopTransferMinimum", &same_stop_minimum),
    ];
    let bytes = encode_routing_snapshot(Some(&metadata.stringify()), &arrays)?;
    super::write_private(&path, &bytes)?;
    prune_snapshots(&store.path, &path)?;
    Ok(true)
}

/// `pruneRoutingSnapshotCache` for timetable snapshots: keep the current one
/// and the newest others within two entries and the planning budget.
fn prune_snapshots(store: &Path, current: &Path) -> Result<()> {
    let budget = timetable_budget_bytes();
    let maximum_bytes = std::env::var("VIGO_ACTIVE_KERNEL_SNAPSHOT_CACHE_BUDGET_BYTES")
        .ok()
        .map(|v| super::policy::js_number(&v))
        .filter(|v| v.is_finite() && *v > 0.0)
        .map_or(
            (512.0 * 1024.0 * 1024.0_f64).min((budget / 4.0).floor()),
            |v| {
                v.floor()
                    .clamp(8.0 * 1024.0 * 1024.0, 2.0 * 1024.0 * 1024.0 * 1024.0)
            },
        );
    let maximum_entries = 2;
    let directory = store.parent().ok_or("Routing store has no directory")?;
    let prefix = format!(
        "{}.active-service-kernel.",
        store
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or("Routing store name must be UTF-8")?
    );
    let mut snapshots = vec![];
    for entry in std::fs::read_dir(directory)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !entry.file_type()?.is_file() || !name.starts_with(&prefix) || !name.ends_with(".bin") {
            continue;
        }
        let metadata = entry.metadata()?;
        snapshots.push((
            entry.path() == current,
            metadata.modified()?,
            entry.path(),
            metadata.len(),
        ));
    }
    snapshots.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)).then(a.2.cmp(&b.2)));
    let (mut count, mut bytes) = (0usize, 0u64);
    for (current, _, path, size) in snapshots {
        if current || (count < maximum_entries && (bytes + size) as f64 <= maximum_bytes) {
            count += 1;
            bytes += size;
        } else {
            std::fs::remove_file(path)?;
        }
    }
    Ok(())
}
