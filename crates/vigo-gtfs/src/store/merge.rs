//! Multi-feed metadata and store merging (`mergedGtfsMetadata`,
//! `mergeNationalGtfsStores`), plus helpers both builders share.

use super::fares::copy_fare_catalogs;
use super::flex::copy_flex_catalogs;
use super::metadata::{admit_store, admit_transfer_semantics};
use super::policy::{cos, haversine_km};
use super::schema::{create_indexes, create_schema};
use super::topology::{build_default_sidecar, publish_with_sidecar, static_topology_sidecar_path};
use super::*;
use crate::jsval;
use std::collections::HashMap;
use std::time::Instant;
use vigo_format::js::{Js, locale_compare};

const NEARBY_TRANSFER_CELL_DEGREES: f64 = 0.01;

/// `serviceTimeBounds(db)`: first departure and last arrival, including
/// frequency tails after their windows.
pub(crate) fn service_time_bounds(db: &Connection) -> Result<(f64, f64)> {
    Ok(db.query_row(
        "SELECT COALESCE(MIN(first), 0) AS first, COALESCE(MAX(last), 0) AS last
    FROM (
      SELECT MIN(departure) AS first, MAX(arrival) AS last FROM connections
      UNION ALL
      SELECT f.start_time AS first, f.end_time + h.duration AS last
      FROM frequencies f
      JOIN (
        SELECT trip_id, MAX(arrival) - MIN(departure) AS duration
        FROM headway_connections GROUP BY trip_id
      ) h ON h.trip_id = f.trip_id
      WHERE f.exact_times = 0
    )",
        [],
        |row| Ok((row.get::<_, f64>(0)?, row.get::<_, f64>(1)?)),
    )?)
}

/// `linkNearbyTransferStops(db)`: the radial candidate count. No transfer
/// is inferred; the count records how many pairs lie within 250 m.
pub(crate) fn link_nearby_transfer_stops(db: &Connection) -> Result<f64> {
    let max_distance_km = NEARBY_TRANSFER_MAX_DISTANCE_KM;
    let mut stops: Vec<(String, f64, f64)> = Vec::new();
    {
        let mut statement = db.prepare(
            "SELECT stop_id, lat, lon FROM stops
    WHERE lat IS NOT NULL AND lon IS NOT NULL AND COALESCE(location_type, 0)=0",
        )?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            stops.push((row.get(0)?, row.get(1)?, row.get(2)?));
        }
    }
    let cell = |value: f64| (value / NEARBY_TRANSFER_CELL_DEGREES).floor() as i64;
    let mut cells: HashMap<(i64, i64), Vec<usize>> = HashMap::new();
    for (index, (_, lat, lon)) in stops.iter().enumerate() {
        cells
            .entry((cell(*lat), cell(*lon)))
            .or_default()
            .push(index);
    }
    let mut candidates = 0.0;
    let latitude_radius =
        ((max_distance_km / 111.2) / NEARBY_TRANSFER_CELL_DEGREES).ceil() as i64 + 1;
    for (id, lat, lon) in &stops {
        let (lat_cell, lon_cell) = (cell(*lat), cell(*lon));
        let longitude_km_per_degree = 111.2 * 0.05f64.max(cos(lat * std::f64::consts::PI / 180.0));
        let longitude_radius = 20f64.min(
            ((max_distance_km / longitude_km_per_degree) / NEARBY_TRANSFER_CELL_DEGREES).ceil()
                + 1.0,
        ) as i64;
        for lat_offset in -latitude_radius..=latitude_radius {
            for lon_offset in -longitude_radius..=longitude_radius {
                let Some(members) = cells.get(&(lat_cell + lat_offset, lon_cell + lon_offset))
                else {
                    continue;
                };
                for &candidate in members {
                    let (candidate_id, candidate_lat, candidate_lon) = &stops[candidate];
                    if locale_compare(candidate_id, id) != std::cmp::Ordering::Greater {
                        continue;
                    }
                    if haversine_km(*lon, *lat, *candidate_lon, *candidate_lat) > max_distance_km {
                        continue;
                    }
                    candidates += 2.0;
                }
            }
        }
    }
    Ok(candidates)
}

fn js_number_of(value: &Js) -> f64 {
    match value {
        Js::Null => 0.0,
        Js::Bool(b) => f64::from(u8::from(*b)),
        Js::Number(n) => *n,
        Js::String(s) => jsval::to_number(s),
        Js::Array(items) => match items.as_slice() {
            [] => 0.0,
            [one] => match one {
                Js::Null => 0.0,
                other => js_number_of(&Js::String(js_to_string(other))),
            },
            _ => f64::NAN,
        },
        Js::Object(_) => f64::NAN,
    }
}

fn js_to_string(value: &Js) -> String {
    match value {
        Js::Null => "null".into(),
        Js::Bool(b) => b.to_string(),
        Js::Number(n) if n.is_nan() => "NaN".into(),
        Js::Number(n) if n.is_infinite() => {
            if *n > 0.0 {
                "Infinity".into()
            } else {
                "-Infinity".into()
            }
        }
        Js::Number(n) => vigo_format::js::number(*n),
        Js::String(s) => s.clone(),
        Js::Array(items) => items
            .iter()
            .map(|v| {
                if matches!(v, Js::Null) {
                    String::new()
                } else {
                    js_to_string(v)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Js::Object(_) => "[object Object]".into(),
    }
}

fn number_field(metadata: &Js, key: &str) -> f64 {
    // Number(metadata[key] ?? 0)
    metadata.get(key).map_or(0.0, js_number_of)
}

/// `mergedGtfsMetadata(db, descriptors, metadataByStore, nearbyTransfers, forCity)`.
pub(crate) fn merged_metadata(
    db: &Connection,
    scopes: &[String],
    sources: &[Js],
    candidates: f64,
    for_city: bool,
) -> Result<Js> {
    let mut inventory = Js::object();
    for source in sources {
        if let Some(Js::Object(members)) = source.get("featureInventory") {
            for (key, value) in members {
                let count = js_number_of(value);
                if !count.is_finite() || count < 0.0 {
                    return Err(Error::new(format!(
                        "Routing store contains invalid feature inventory count {key}: {}",
                        js_to_string(value)
                    )));
                }
                let current = inventory.get(key).map_or(0.0, js_number_of);
                inventory.set(key.clone(), current + count);
            }
        }
    }
    let count = |table: &str| -> Result<f64> {
        Ok(db.query_row(
            &format!("SELECT COUNT(*) AS count FROM {table}"),
            [],
            |row| row.get::<_, f64>(0),
        )?)
    };
    let text = |source: &Js, key: &str| js_to_string(source.get(key).unwrap_or(&Js::Null));
    let mut fingerprints: Vec<(String, String)> = scopes
        .iter()
        .zip(sources)
        .map(|(scope, source)| (scope.clone(), text(source, "sourceFingerprint")))
        .collect();
    fingerprints.sort_by(|a, b| locale_compare(&a.0, &b.0));
    let source_fingerprint = fingerprints
        .iter()
        .map(|(scope, fp)| format!("{scope}:{fp}"))
        .collect::<Vec<_>>()
        .join("|");
    let mut zones: Vec<String> = Vec::new();
    for source in sources {
        if let Some(Js::Array(items)) = source.get("agencyTimezones") {
            for item in items {
                let zone = js_to_string(item);
                if !zones.contains(&zone) {
                    zones.push(zone);
                }
            }
        }
    }
    zones.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    let mut blocking: Vec<(String, Js)> = Vec::new();
    let mut limitations: Vec<(String, Js)> = Vec::new();
    let merge = |target: &mut Vec<(String, Js)>, features: Option<&Js>, skip: Option<&str>| {
        let Some(Js::Array(features)) = features else {
            return;
        };
        for feature in features {
            let code = feature
                .get("code")
                .map(js_to_string)
                .unwrap_or_else(|| "undefined".into());
            if skip == Some(code.as_str()) {
                continue;
            }
            match target.iter_mut().find(|(c, _)| *c == code) {
                Some((_, current)) => {
                    let total = number_field(current, "count") + number_field(feature, "count");
                    current.set("count", total);
                }
                None => target.push((code, feature.clone())),
            }
        }
    };
    for source in sources {
        merge(&mut blocking, source.get("blockingRoutingFeatures"), None);
        merge(
            &mut limitations,
            source.get("routingLimitations"),
            Some("generated_radial_transfers"),
        );
    }
    if zones.len() > 1 {
        let value = Js::object()
            .with("code", "multiple_agency_timezones")
            .with("count", zones.len())
            .with("detail", "The merged store contains agencies in multiple timezones; cross-timezone service-day routing is unsupported.");
        match blocking
            .iter_mut()
            .find(|(c, _)| c == "multiple_agency_timezones")
        {
            Some(entry) => entry.1 = value,
            None => blocking.push(("multiple_agency_timezones".into(), value)),
        }
    }
    let sorted = |mut list: Vec<(String, Js)>| {
        list.sort_by(|a, b| locale_compare(&a.0, &b.0));
        Js::Array(list.into_iter().map(|(_, v)| v).collect())
    };
    let mut store_scopes: Vec<String> = scopes.to_vec();
    store_scopes.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    let (first, last) = service_time_bounds(db)?;
    let mut metadata = Js::object().with("schemaVersion", STORE_SCHEMA_VERSION);
    if let Some(accessibility) = sources[0].get("accessibility").filter(|v| jsval::truthy(v)) {
        metadata.set("accessibility", accessibility.clone());
    }
    metadata
        .set("storeId", format!("merged-{}", store_scopes.join("+")))
        .set("sourceFingerprint", source_fingerprint)
        .set(
            "sourceFile",
            scopes
                .iter()
                .zip(sources)
                .map(|(scope, s)| format!("{scope}:{}", text(s, "sourceFile")))
                .collect::<Vec<_>>()
                .join(", "),
        )
        .set(
            "sourceBytes",
            sources
                .iter()
                .map(|s| number_field(s, "sourceBytes"))
                .sum::<f64>(),
        )
        .set("builtAt", iso_now())
        .set("routeCount", count("routes")?)
        .set("stopCount", count("stops")?)
        .set("tripCount", count("trips")?)
        .set(
            "stopTimeCount",
            sources
                .iter()
                .map(|s| number_field(s, "stopTimeCount"))
                .sum::<f64>(),
        )
        .set("connectionCount", count("connections")?)
        .set("minimumServiceTimeSeconds", first)
        .set("maximumServiceTimeSeconds", last)
        .set(
            "connectionPermissionCount",
            count("connection_permissions")?,
        )
        .set("boardingAlightingModel", "sparse-connection-permissions-v1")
        .set(
            "departureIndexState",
            if for_city { "deferred" } else { "ready" },
        )
        .set("stopAccessRoleIndexVersion", STOP_ACCESS_ROLE_INDEX_VERSION)
        .set("stopAccessRoleCount", count("stop_access_roles")?)
        .set("calendarDateCount", count("calendar_dates")?)
        .set("transferCount", count("transfers")?)
        .set("frequencyCount", count("frequencies")?)
        .set("shapePointCount", count("shape_points")?)
        .set("routeServiceCatalogVersion", ROUTE_SERVICE_CATALOG_VERSION)
        .set("routeServiceCatalogBuiltAt", iso_now())
        .set("serviceModel", "exact-date-multi-feed")
        .set("agencyTimezones", zones)
        .set("featureInventory", inventory)
        .set("blockingRoutingFeatures", sorted(blocking))
        .set("routingLimitations", sorted(limitations))
        .set("transferSemanticsVersion", TRANSFER_SEMANTICS_VERSION)
        .set(
            "transferGeneration",
            Js::object()
                .with("strategy", "source_literal_only")
                .with("exact", true)
                .with("maxDistanceKm", NEARBY_TRANSFER_MAX_DISTANCE_KM)
                .with("radialCandidateCount", candidates)
                .with("inferredTransferCount", 0),
        )
        .set(
            "sourceStores",
            Js::Array(
                scopes
                    .iter()
                    .zip(sources)
                    .map(|(scope, s)| {
                        // Absent (undefined) members are omitted by JSON.stringify.
                        let mut store = Js::object().with("scope", scope.clone());
                        for key in ["storeId", "sourceFingerprint", "sourceFile"] {
                            if let Some(value) = s.get(key) {
                                store.set(key, value.clone());
                            }
                        }
                        store
                    })
                    .collect(),
            ),
        );
    Ok(metadata)
}

fn sql_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// A routing store to merge and the scope that namespaces it.
#[derive(Clone, Debug)]
pub struct StoreSource {
    pub scope: String,
    pub store_path: PathBuf,
}

/// `mergeNationalGtfsStores({ stores, outputPath, removeSourcesAfterMerge, forCity })`.
pub fn merge_stores(
    stores: &[StoreSource],
    output: &Path,
    remove_sources: bool,
    for_city: bool,
    progress: &mut dyn FnMut(&Progress),
) -> Result<Js> {
    let started = Instant::now();
    if stores.len() < 2 {
        return Err(Error::new(
            "At least two exact-date routing stores are required.",
        ));
    }
    let mut descriptors: Vec<StoreSource> = stores
        .iter()
        .enumerate()
        .map(|(index, store)| StoreSource {
            scope: if store.scope.is_empty() {
                format!("feed-{}", index + 1)
            } else {
                store.scope.clone()
            },
            store_path: resolve(&store.store_path),
        })
        .collect();
    descriptors.sort_by(|a, b| {
        locale_compare(&a.scope, &b.scope)
            .then_with(|| locale_compare(&path_text(&a.store_path), &path_text(&b.store_path)))
    });
    let unique: std::collections::HashSet<&str> =
        descriptors.iter().map(|d| d.scope.as_str()).collect();
    if unique.len() != descriptors.len() {
        return Err(Error::new("Routing-store scopes must be unique."));
    }
    let resolved_output = resolve(output);
    if descriptors.iter().any(|d| d.store_path == resolved_output) {
        return Err(Error::new(
            "Merged routing-store output must differ from every source store.",
        ));
    }
    let mut sources = Vec::new();
    for descriptor in &descriptors {
        if !std::fs::metadata(&descriptor.store_path).is_ok_and(|m| m.is_file()) {
            return Err(Error::new(format!(
                "Routing store is missing: {}",
                path_text(&descriptor.store_path)
            )));
        }
        let metadata = {
            let source = Connection::open_with_flags(
                &descriptor.store_path,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )?;
            let metadata = admit_store(&source, &descriptor.store_path)?;
            admit_transfer_semantics(&source, &descriptor.store_path, &metadata)?;
            metadata
        };
        let shown = path_text(&descriptor.store_path);
        if metadata.get("accessibility").is_some_and(jsval::truthy) {
            return Err(Error::new(
                "Build wheelchair Cities from the original GTFS feeds; merging prepared wheelchair stores is unsupported.",
            ));
        }
        if metadata.get("serviceModel").and_then(Js::as_str) != Some("exact-date") {
            return Err(Error::new(format!(
                "Routing store is not an exact-date raw GTFS store: {shown}"
            )));
        }
        if jsval::trim(
            &metadata
                .get("sourceFingerprint")
                .map(js_to_string)
                .unwrap_or_default(),
        )
        .is_empty()
            || matches!(metadata.get("sourceFingerprint"), None | Some(Js::Null))
        {
            return Err(Error::new(format!(
                "Routing store lacks a source identity and must be rebuilt from raw GTFS: {shown}"
            )));
        }
        if !matches!(metadata.get("featureInventory"), Some(Js::Object(_))) {
            return Err(Error::new(format!(
                "Routing store lacks a 0.1.4 feature inventory and must be rebuilt from raw GTFS: {shown}"
            )));
        }
        sources.push(metadata);
    }
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temp = PathBuf::from(format!("{}.building", path_text(output)));
    remove_file(&temp);
    let db = Connection::open(&temp)?;
    let outcome = (|| -> Result<Js> {
        configure_build_database(&db)?;
        create_schema(&db)?;
        for (index, descriptor) in descriptors.iter().enumerate() {
            let alias = format!("source_{index}");
            let prefix = format!("{}\u{1f}", descriptor.scope);
            let p = sql_literal(&prefix);
            report(
                progress,
                "Merging exact GTFS stores",
                index as f64 / descriptors.len() as f64 * 0.72,
                &basename(&descriptor.store_path),
            );
            db.execute_batch(&format!(
                "ATTACH DATABASE {} AS {alias}",
                sql_literal(&path_text(&descriptor.store_path))
            ))?;
            db.execute_batch("BEGIN IMMEDIATE")?;
            let copied = (|| -> Result<()> {
                copy_fare_catalogs(&db, &alias, &descriptor.scope)?;
                copy_flex_catalogs(&db, &alias, &prefix)?;
                db.execute_batch(&format!(
                    "INSERT INTO stops SELECT {p} || stop_id, name, lat, lon, CASE WHEN parent_station IS NULL OR parent_station='' THEN NULL ELSE {p} || parent_station END, location_type, platform_code FROM {alias}.stops;
          INSERT INTO routes SELECT {p} || route_id, short_name, long_name, route_type, color FROM {alias}.routes;
          INSERT INTO trips SELECT {p} || trip_id, {p} || route_id, {p} || service_id, direction_id FROM {alias}.trips;
          INSERT INTO trip_details SELECT {p} || trip_id, headsign, short_name FROM {alias}.trip_details;
          INSERT INTO trip_shapes SELECT {p} || trip_id, {p} || shape_id FROM {alias}.trip_shapes;
          INSERT INTO shape_points SELECT {p} || shape_id, sequence, lat, lon FROM {alias}.shape_points;
          INSERT INTO calendar SELECT {p} || service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday, start_date, end_date FROM {alias}.calendar;
          INSERT INTO calendar_dates SELECT {p} || service_id, date, exception_type FROM {alias}.calendar_dates;
          INSERT INTO transfers SELECT {p} || from_stop_id, {p} || to_stop_id, transfer_type, min_transfer_time FROM {alias}.transfers;
          INSERT INTO transfer_provenance SELECT {p} || from_stop_id, {p} || to_stop_id, provenance, evidence_fingerprint, path_distance_m FROM {alias}.transfer_provenance;
          INSERT INTO frequencies SELECT {p} || trip_id, start_time, end_time, headway_secs, exact_times FROM {alias}.frequencies;
          INSERT INTO connections SELECT departure, arrival, {p} || trip_id, {p} || route_id, {p} || service_id, direction_id, {p} || from_stop_id, {p} || to_stop_id, stop_sequence FROM {alias}.connections;"
                ))?;
                let has = |sql: String| -> Result<bool> {
                    Ok(db.query_row(&sql, [], |_| Ok(())).optional()?.is_some())
                };
                let permissions = has(format!(
                    "SELECT 1 AS ready FROM {alias}.sqlite_master WHERE type='table' AND name='connection_permissions'"
                ))?;
                if has(format!(
                    "SELECT 1 FROM {alias}.sqlite_master WHERE name='trip_origins'"
                ))? {
                    db.execute_batch(&format!("INSERT INTO trip_origins SELECT {p} || trip_id,{p} || source_trip_id FROM {alias}.trip_origins"))?;
                }
                if has(format!(
                    "SELECT 1 FROM {alias}.sqlite_master WHERE name='headway_connections'"
                ))? {
                    db.execute_batch(&format!("INSERT INTO headway_connections SELECT departure,arrival,{p} || trip_id,{p} || route_id,{p} || service_id,direction_id,{p} || from_stop_id,{p} || to_stop_id,stop_sequence FROM {alias}.headway_connections"))?;
                }
                if has(format!(
                    "SELECT 1 FROM {alias}.sqlite_master WHERE type='table' AND name='transfer_rules'"
                ))? {
                    let columns = [
                        "from_stop_id",
                        "to_stop_id",
                        "from_route_id",
                        "to_route_id",
                        "from_trip_id",
                        "to_trip_id",
                    ]
                    .iter()
                    .map(|key| format!("CASE WHEN {key} IS NULL THEN NULL ELSE {p} || {key} END"))
                    .collect::<Vec<_>>()
                    .join(",");
                    db.execute_batch(&format!("INSERT INTO transfer_rules SELECT {columns}, transfer_type,min_transfer_time FROM {alias}.transfer_rules"))?;
                }
                if has(format!(
                    "SELECT 1 FROM {alias}.sqlite_master WHERE type='table' AND name='trip_links'"
                ))? {
                    db.execute_batch(&format!("INSERT INTO trip_links SELECT {p} || from_trip_id, {p} || to_trip_id, transfer_type FROM {alias}.trip_links"))?;
                }
                if has(format!(
                    "SELECT 1 FROM {alias}.sqlite_master WHERE type='table' AND name='trip_operations'"
                ))? {
                    db.execute_batch(&format!("INSERT INTO trip_operations SELECT {p} || trip_id, CASE WHEN block_id IS NULL THEN NULL ELSE {p} || block_id END, bikes_allowed FROM {alias}.trip_operations"))?;
                }
                if permissions {
                    db.execute_batch(&format!("INSERT INTO connection_permissions SELECT {p} || trip_id, stop_sequence, can_board, can_alight FROM {alias}.connection_permissions;"))?;
                }
                Ok(())
            })();
            match copied {
                Ok(()) => db.execute_batch("COMMIT")?,
                Err(error) => {
                    let _ = db.execute_batch("ROLLBACK");
                    return Err(error);
                }
            }
            db.execute_batch(&format!("DETACH DATABASE {alias}"))?;
        }
        report(progress, "Linking nearby interchanges", 0.76, "");
        let candidates = link_nearby_transfer_stops(&db)?;
        report(progress, "Building routing indexes", 0.88, "");
        create_indexes(&db, for_city)?;
        let scopes: Vec<String> = descriptors.iter().map(|d| d.scope.clone()).collect();
        let metadata = merged_metadata(&db, &scopes, &sources, candidates, for_city)?;
        db.execute_batch("BEGIN IMMEDIATE")?;
        write_metadata(
            &db,
            "INSERT OR REPLACE INTO metadata VALUES(?,?)",
            &metadata,
        )?;
        db.execute_batch("COMMIT")?;
        Ok(metadata)
    })();
    let metadata = match outcome {
        Ok(metadata) => metadata,
        Err(error) => {
            drop(db);
            cleanup_failed(&temp, output);
            return Err(error);
        }
    };
    db.execute_batch("PRAGMA optimize;")?;
    drop(db);
    let (topology, bytes) = if for_city {
        std::fs::rename(&temp, output)?;
        (
            Js::object()
                .with("ready", false)
                .with("reason", "city_transfers_pending"),
            std::fs::metadata(output)?.len(),
        )
    } else {
        let published = build_default_sidecar(&temp, output, progress)
            .and_then(|staged| publish_with_sidecar(&temp, output, staged));
        match published {
            Ok(topology) => (topology, std::fs::metadata(output)?.len()),
            Err(error) => {
                cleanup_failed(&temp, output);
                return Err(error);
            }
        }
    };
    let mut warnings = Vec::new();
    if remove_sources {
        for descriptor in &descriptors {
            if let Err(error) = std::fs::remove_file(&descriptor.store_path)
                && error.kind() != std::io::ErrorKind::NotFound
            {
                warnings.push(
                    Js::object()
                        .with("storePath", path_text(&descriptor.store_path))
                        .with("reason", error.to_string()),
                );
            }
        }
    }
    let megabytes = grouped((bytes as f64 / 1024.0 / 1024.0).round() as u64);
    if warnings.is_empty() {
        report(
            progress,
            "Routing store ready",
            1.0,
            &format!("{megabytes} MB"),
        );
    } else {
        report(
            progress,
            "Routing store ready with cleanup warnings",
            1.0,
            &format!(
                "{megabytes} MB / {} source cleanup warning(s)",
                warnings.len()
            ),
        );
    }
    Ok(metadata
        .with("staticTopology", topology)
        .with("path", path_text(output))
        .with("bytes", bytes)
        .with("cleanupWarnings", Js::Array(warnings))
        .with(
            "buildSeconds",
            (started.elapsed().as_secs_f64() * 1000.0).round() / 1000.0,
        ))
}

fn cleanup_failed(temp: &Path, output: &Path) {
    let sidecar = path_text(&static_topology_sidecar_path(output));
    for path in [
        temp.to_path_buf(),
        PathBuf::from(format!("{}-journal", path_text(temp))),
        PathBuf::from(format!("{sidecar}.next")),
        PathBuf::from(format!("{sidecar}.next.building")),
    ] {
        remove_file(&path);
    }
}

use rusqlite::OptionalExtension;
