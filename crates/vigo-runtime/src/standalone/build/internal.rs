//! Internal compiler commands run by other VIGO processes: Studio's GTFS and
//! OSM imports, its place-name upgrade, and the compiler checks. Each prints one JSON result on
//! standard output; `--progress json` reports `{phase, progress, detail}`
//! lines on standard error.
use super::{Arguments, Progress, Result, absolute, raw};
use crate::standalone::fail;
use std::path::PathBuf;
use vigo_format::js::Js;

pub(crate) fn run(command: &str, arguments: &Arguments) -> Result<Option<Js>> {
    Ok(Some(match command {
        "_build-gtfs-store" => gtfs_store(arguments)?,
        "_build-street-store" => street_store(arguments)?,
        "_build-static-topology" => static_topology(arguments)?,
        "_compact-gtfs-store" => raw::compact_gtfs(&required(arguments, "store", command)?)?,
        "_stop-access-roles" => {
            raw::ensure_stop_access_roles(&required(arguments, "store", command)?)?
        }
        "_prepare-transfers" => prepare_transfers(arguments)?,
        "_remove-stop-transfers" => {
            remove_stop_transfers(&required(arguments, "routing-store", command)?)?
        }
        "_refresh-topology" => raw::refresh_topology(
            &required(arguments, "store", command)?,
            &Progress::new("topology"),
        )?,
        "_build-drive-store" => {
            let street = required(arguments, "street-store", command)?;
            if arguments.enabled("native") {
                let mut native = |snapshot: &std::path::Path| -> vigo_osm::Result<(f64, Js)> {
                    super::build_drive_cch(snapshot)
                        .map_err(|e| vigo_osm::Error::new(e.to_string()))
                };
                vigo_osm::build_drive_store(&street, true, Some(&mut native))?
            } else {
                raw::build_drive(&street)?
            }
        }
        "_build-walk-store" => {
            vigo_osm::build_walk_profile(&required(arguments, "street-store", command)?)?
        }
        "_backfill-place-names" => {
            let street = required(arguments, "street-store", command)?;
            let pbf = required(arguments, "osm", command)?;
            let progress = Progress::new("osm");
            vigo_osm::backfill_place_names(&street, &pbf, &mut |event| {
                progress.osm(event);
                Ok(())
            })?
        }
        "_compact-street-store" => {
            let street = required(arguments, "street-store", command)?;
            let require_drive = arguments
                .value("require-drive")
                .is_none_or(|_| arguments.enabled("require-drive"));
            let mut native = |snapshot: &std::path::Path| -> vigo_osm::Result<(f64, Js)> {
                super::build_drive_cch(snapshot).map_err(|e| vigo_osm::Error::new(e.to_string()))
            };
            vigo_osm::compact_runtime_store(&street, require_drive, Some(&mut native))?
        }
        "_build-terminal-access" => {
            let pbf = required(arguments, "osm", command)?;
            let street = required(arguments, "street-store", command)?;
            let routing = required(arguments, "routing-store", command)?;
            let mut kernel = open_street_kernel(&street)?;
            let identity = super::street_identity_of(&street)?;
            super::reserve_workspaces(&mut kernel)?;
            let mut components = || -> Result<Vec<u32>> {
                super::prepare_coordinate_access(&routing, &mut kernel, &identity)?;
                Ok(kernel.public_access_components()?)
            };
            raw::build_terminal_access(&pbf, &street, &mut components)?
        }
        _ => return Ok(None),
    }))
}

fn required(arguments: &Arguments, name: &str, command: &str) -> Result<PathBuf> {
    match arguments.value(name) {
        Some(value) => absolute(value),
        None => fail(format!("{command} requires --{name}")),
    }
}

/// A Studio feed store (`buildNationalGtfsStore`), a City store from several
/// scoped feeds (`--city`), or a merge of feed stores (`--merge-store`).
fn gtfs_store(arguments: &Arguments) -> Result<Js> {
    let output = required(arguments, "output-store", "_build-gtfs-store")?;
    let progress = Progress::new("gtfs");
    let mut report = |event: &vigo_gtfs::Progress| progress.gtfs(event);
    let merged = arguments.values("merge-store");
    if !merged.is_empty() {
        let mut sources = vec![];
        for source in merged {
            let Some((scope, path)) = source.split_once('=') else {
                return fail("--merge-store expects SCOPE=PATH");
            };
            sources.push(vigo_gtfs::StoreSource {
                scope: scope.to_owned(),
                store_path: absolute(path)?,
            });
        }
        return Ok(vigo_gtfs::merge_stores(
            &sources,
            &output,
            false,
            arguments.enabled("city"),
            &mut report,
        )?);
    }
    let options = vigo_gtfs::BuildOptions {
        wheelchair: arguments.enabled("wheelchair"),
        wheelchair_streets: arguments
            .value("wheelchair-streets")
            .unwrap_or("inferred")
            .to_owned(),
    };
    let gtfs = arguments.values("gtfs");
    let scopes = arguments.values("gtfs-scope");
    if gtfs.is_empty() || (arguments.enabled("city") && gtfs.len() != scopes.len()) {
        return fail("_build-gtfs-store requires feeds, matching scopes and output-store");
    }
    if arguments.enabled("city") {
        let feeds = gtfs
            .iter()
            .zip(scopes)
            .map(|(path, scope)| {
                Ok(vigo_gtfs::Feed {
                    path: absolute(path)?,
                    scope: scope.clone(),
                })
            })
            .collect::<Result<Vec<_>>>()?;
        return Ok(vigo_gtfs::build_city_store(
            &feeds,
            &output,
            &options,
            &mut report,
        )?);
    }
    if gtfs.len() != 1 {
        return fail("_build-gtfs-store builds one feed store; pass --city for several feeds");
    }
    Ok(vigo_gtfs::build_store(
        &absolute(&gtfs[0])?,
        &output,
        &options,
        false,
        &mut report,
    )?)
}

/// The street store a City or a Studio project uses. `--studio` also seals
/// it, prepares the pedestrian hierarchy and, with `--private-access
/// endpoints`, authorized endpoint access for `--routing-store`, as Studio's
/// street import does.
fn street_store(arguments: &Arguments) -> Result<Js> {
    let pbf = required(arguments, "osm", "_build-street-store")?;
    let output = required(arguments, "output-store", "_build-street-store")?;
    let progress = Progress::new("osm");
    let wheelchair = arguments.enabled("wheelchair");
    let studio = arguments.enabled("studio");
    let modes = arguments.value("street-modes").unwrap_or("walk,drive");
    let flex_driving = arguments.enabled("flex-driving");
    let options = vigo_osm::StreetOptions {
        include_driving: if studio {
            true
        } else {
            modes.split(',').any(|m| m == "drive") || flex_driving
        },
        include_biking: if studio {
            !wheelchair
        } else {
            modes.split(',').any(|m| m == "bike")
        },
        flex_driving,
        wheelchair,
        wheelchair_streets: vigo_osm::WheelchairStreets::parse(
            arguments.value("wheelchair-streets").unwrap_or("inferred"),
        )?,
        build_driving_profile: studio
            || arguments.enabled("drive-profile")
            || vigo_osm::StreetOptions::default().build_driving_profile,
    };
    let mut report = |event: &vigo_osm::Progress| progress.osm(event);
    let mut result = vigo_osm::build_street_store(&pbf, &output, &options, &mut report)?;
    if !studio {
        return Ok(result);
    }
    progress.emit(
        "Sealing runtime street snapshots",
        0.975,
        "Removing compiler-only street tables before publication",
    );
    let compaction = raw::compact_streets(&output)?;
    if compaction.get("ready") != Some(&Js::Bool(true)) {
        let reason = compaction
            .get("reason")
            .and_then(Js::as_str)
            .unwrap_or("unknown reason");
        return fail(format!(
            "The OSM street store could not be sealed: {reason}"
        ));
    }
    progress.emit(
        "Building Rust pedestrian CCH",
        0.99,
        "Preparing exact directed walking access for routing",
    );
    let walk_snapshot = vigo_osm::walk_snapshot_path(&output);
    let mut cch = super::build_street_cch(&walk_snapshot)?;
    let milliseconds = |ns: f64| (ns / 1e6 * 1e3).round() / 1e3;
    let summary = Js::object()
        .with("ready", cch.loaded.cch_arc_count > 0)
        .with("format", super::cch::STREET_FORMAT)
        .with("orderStrategy", cch.order_strategy)
        .with("nodeCount", cch.built.node_count)
        .with("edgeCount", cch.built.edge_count)
        .with("cchArcCount", cch.built.cch_arc_count)
        .with("distanceUnitsPerMeter", cch.built.distance_units_per_meter)
        .with("structureFile", super::file_name(&cch.structure))
        .with("metricFile", super::file_name(&cch.metric))
        .with("orderMs", milliseconds(cch.built.order_ns))
        .with("buildMs", milliseconds(cch.built.structure_ns))
        .with("customizeMs", milliseconds(cch.built.customization_ns))
        .with("persistMs", milliseconds(cch.built.persistence_ns));
    let terminal_access = match (
        arguments.value("private-access"),
        arguments.value("routing-store"),
    ) {
        (Some("endpoints"), Some(routing)) => {
            progress.emit(
                "Preparing authorized endpoint access",
                0.99,
                "Linking mapped private paths and gates to the public network",
            );
            let routing = absolute(routing)?;
            let identity = super::street_identity_of(&output)?;
            super::reserve_workspaces(&mut cch.kernel)?;
            let mut components = || -> Result<Vec<u32>> {
                super::prepare_coordinate_access(&routing, &mut cch.kernel, &identity)?;
                Ok(cch.kernel.public_access_components()?)
            };
            raw::build_terminal_access(&pbf, &output, &mut components)?
        }
        (Some("endpoints"), None) => {
            return fail("--private-access endpoints requires --routing-store");
        }
        _ => Js::object().with("model", "public"),
    };
    result
        .set(
            "bytes",
            compaction.get("afterBytes").cloned().unwrap_or(Js::Null),
        )
        .set(
            "storageLayout",
            compaction.get("storageLayout").cloned().unwrap_or(Js::Null),
        )
        .set("runtimeCompaction", compaction.clone())
        .set(
            "driveSnapshot",
            compaction.get("drive").cloned().unwrap_or(Js::Null),
        )
        .set("cch", summary)
        .set("terminalAccess", terminal_access);
    Ok(result)
}

/// The static topology sidecar of a routing store.
fn static_topology(arguments: &Arguments) -> Result<Js> {
    let store = required(arguments, "store", "_build-static-topology")?;
    let output = match arguments.value("output") {
        Some(path) => absolute(path)?,
        None => vigo_gtfs::store::static_topology_sidecar_path(&store),
    };
    let minimum = arguments
        .value("minimum-free-bytes")
        .map(|v| {
            v.parse::<f64>()
                .map_err(|_| "--minimum-free-bytes must be a number")
        })
        .transpose()?;
    let progress = Progress::new("topology");
    let mut report = |event: &vigo_gtfs::Progress| progress.gtfs(event);
    Ok(vigo_gtfs::build_static_topology_sidecar(
        &store,
        &output,
        &mut report,
        minimum,
        arguments.enabled("force"),
    )?)
}

/// The pedestrian kernel of a street store, with its hierarchy when present.
fn open_street_kernel(street: &std::path::Path) -> Result<crate::CoordinateKernel> {
    let snapshot = vigo_osm::walk_snapshot_path(street);
    let text = snapshot.to_string_lossy().into_owned();
    Ok(
        match crate::standalone::city::cch_files(&snapshot, "street") {
            Ok((structure, metric, _)) => crate::CoordinateKernel::open_prepared(
                text,
                crate::StreetCchLoadInput {
                    structure_path: structure,
                    metric_path: metric,
                },
            )?,
            Err(_) => crate::CoordinateKernel::new(text)?,
        },
    )
}

/// Studio's certified stop transfers for a project store and its streets.
fn prepare_transfers(arguments: &Arguments) -> Result<Js> {
    let routing = required(arguments, "routing-store", "_prepare-transfers")?;
    let street = required(arguments, "street-store", "_prepare-transfers")?;
    vigo_gtfs::store::admit_compiler_input(&routing)?;
    let mut kernel = open_street_kernel(&street)?;
    super::reserve_workspaces(&mut kernel)?;
    let identity = super::street_identity_of(&street)?;
    super::stop_transfers(&routing, &mut kernel, &identity)
}

/// Remove the street-certified stop transfers of a Studio routing store, keep
/// the feed's own transfers, and rebuild what depended on them
/// (`removeNationalGtfsOsmStopTransfers`).
fn remove_stop_transfers(routing: &std::path::Path) -> Result<Js> {
    let metadata = vigo_gtfs::store::read_store_metadata(routing)?;
    let mut db = rusqlite::Connection::open(routing)?;
    db.busy_timeout(std::time::Duration::from_millis(5_000))?;
    let transaction = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let removed = transaction.execute(
        "DELETE FROM transfers WHERE EXISTS (
          SELECT 1 FROM transfer_provenance AS p
          WHERE p.from_stop_id=transfers.from_stop_id AND p.to_stop_id=transfers.to_stop_id
            AND p.provenance='osm_certified_radial'
        )",
        [],
    )?;
    transaction.execute_batch(
        "DELETE FROM transfer_provenance WHERE provenance='osm_certified_radial'; DELETE FROM metadata WHERE key='osmStopTransferGraph';",
    )?;
    let mut generation = match metadata.get("transferGeneration") {
        Some(Js::Object(members)) => Js::Object(
            members
                .iter()
                .filter(|(key, _)| !key.starts_with("osm"))
                .cloned()
                .collect(),
        ),
        _ => Js::object(),
    };
    generation.set("strategy", "source_literal_only");
    let count: i64 =
        transaction.query_row("SELECT COUNT(*) FROM transfers", [], |row| row.get(0))?;
    let mut set = transaction.prepare("INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)")?;
    set.execute(rusqlite::params![
        "transferGeneration",
        generation.stringify()
    ])?;
    set.execute(rusqlite::params![
        "transferCount",
        Js::from(count as f64).stringify()
    ])?;
    drop(set);
    transaction.commit()?;
    db.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?;
    drop(db);
    // Topology and timetable snapshots are rebuilt before any query can reuse
    // transfers whose street evidence was removed.
    let refresh = raw::refresh_topology(routing, &Progress::new("topology"))?;
    Ok(Js::object()
        .with("removed", removed as f64)
        .with("derivedArtifacts", refresh))
}
