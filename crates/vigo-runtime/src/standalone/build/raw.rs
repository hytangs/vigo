//! The GTFS and OpenStreetMap compilers, and how many run at once.
use super::{Feed, Progress, Result};
use std::path::Path;
use vigo_format::js::Js;

pub(crate) struct StreetOptions {
    pub include_driving: bool,
    pub include_biking: bool,
    pub flex_driving: bool,
    pub wheelchair: bool,
    pub wheelchair_streets: String,
}

pub(crate) struct Concurrency {
    pub enabled: bool,
    estimate: f64,
    host_guard: f64,
    free_at_start: f64,
    free_guard: f64,
    load: [f64; 3],
    load_guard: f64,
    load_passed: bool,
}

impl Concurrency {
    pub fn summary(&self, parallel: bool) -> Js {
        Js::object()
            .with("gtfsAndOsmParallel", parallel)
            .with(
                "parallelFallback",
                if parallel {
                    Js::Null
                } else {
                    Js::from("memory_or_load_guard")
                },
            )
            .with("estimatedPeakWorkingBytes", self.estimate)
            .with("hostMemoryGuardBytes", self.host_guard)
            .with("freeMemoryAtBuildStartBytes", self.free_at_start)
            .with("freeMemoryGuardBytes", self.free_guard)
            .with("loadAverageAtBuildStart", self.load.to_vec())
            .with("loadAverageGuard", self.load_guard)
            .with("loadAverageGuardPassed", self.load_passed)
    }
}

/// Run GTFS and OSM together only when their estimated peak fits in memory
/// and the host is not already saturated.
pub(crate) fn concurrency(gtfs_bytes: u64, osm_bytes: u64) -> Concurrency {
    // Each Rust compiler peaks at about 7-11x its PBF and 9-14x its GTFS ZIP
    // bytes (Boston and Washington, DC; walk, drive, bike and wheelchair).
    // Washington, DC compiled in parallel peaked at 2.6 GB for the whole
    // build; this estimate is 3.6 GB.
    const FIXED: f64 = 512.0 * 1024.0 * 1024.0;
    const OSM_FACTOR: f64 = 16.0;
    const GTFS_FACTOR: f64 = 20.0;
    let memory_limit = super::host::memory_bytes() as f64;
    let estimate = FIXED + osm_bytes as f64 * OSM_FACTOR + gtfs_bytes as f64 * GTFS_FACTOR;
    let host_guard = memory_limit * 0.55;
    let free_guard = (estimate * 0.75).min(memory_limit * 0.02);
    let free_at_start = super::host::available_bytes() as f64;
    let cpus = std::thread::available_parallelism().map_or(1, |n| n.get()) as f64;
    let load = super::host::load_average();
    let load_guard = (cpus * 2.0).max(1.0);
    let load_passed = load[1] <= load_guard;
    Concurrency {
        enabled: cpus >= 4.0
            && memory_limit >= 8.0 * 1024.0 * 1024.0 * 1024.0
            && estimate <= host_guard
            && free_at_start >= free_guard
            && load_passed,
        estimate,
        host_guard,
        free_at_start,
        free_guard,
        load,
        load_guard,
        load_passed,
    }
}

fn osm_progress(progress: &Progress) -> impl FnMut(&vigo_osm::Progress) + '_ {
    move |event| progress.osm(event)
}

fn gtfs_progress(progress: &Progress) -> impl FnMut(&vigo_gtfs::Progress) + '_ {
    move |event| progress.gtfs(event)
}

/// The City's routing store (`buildNationalGtfsCityStore`).
pub(crate) fn build_gtfs(
    feeds: &[Feed],
    output: &Path,
    wheelchair: bool,
    streets: &str,
    progress: &Progress,
) -> Result<()> {
    let feeds: Vec<vigo_gtfs::Feed> = feeds
        .iter()
        .map(|f| vigo_gtfs::Feed {
            path: f.path.clone(),
            scope: f.scope.clone(),
        })
        .collect();
    let options = vigo_gtfs::BuildOptions {
        wheelchair,
        wheelchair_streets: streets.to_owned(),
    };
    vigo_gtfs::build_city_store(&feeds, output, &options, &mut gtfs_progress(progress))?;
    Ok(())
}

/// The source street store (`buildNationalOsmStore`).
pub(crate) fn build_streets(
    pbf: &Path,
    output: &Path,
    options: &StreetOptions,
    progress: &Progress,
) -> Result<Js> {
    let options = vigo_osm::StreetOptions {
        include_driving: options.include_driving,
        include_biking: options.include_biking,
        flex_driving: options.flex_driving,
        wheelchair: options.wheelchair,
        wheelchair_streets: vigo_osm::WheelchairStreets::parse(&options.wheelchair_streets)?,
        ..Default::default()
    };
    Ok(vigo_osm::build_street_store(
        pbf,
        output,
        &options,
        &mut osm_progress(progress),
    )?)
}

/// Persist the drive snapshot from the source graph.
pub(crate) fn build_drive(street: &Path) -> Result<Js> {
    Ok(vigo_osm::build_drive_store(street, true, None)?)
}

/// Seal the street store; the drive hierarchy is built from its snapshot first.
pub(crate) fn compact_streets(street: &Path) -> Result<Js> {
    let mut native = |snapshot: &Path| -> vigo_osm::Result<(f64, Js)> {
        super::build_drive_cch(snapshot).map_err(|e| vigo_osm::Error::new(e.to_string()))
    };
    Ok(vigo_osm::compact_runtime_store(
        street,
        true,
        Some(&mut native),
    )?)
}

pub(crate) fn compact_gtfs(routing: &Path) -> Result<Js> {
    Ok(vigo_gtfs::compact_runtime_store(routing)?)
}

pub(crate) fn ensure_stop_access_roles(routing: &Path) -> Result<Js> {
    Ok(vigo_gtfs::ensure_stop_access_roles(routing)?)
}

/// `refreshNationalGtfsDerivedArtifacts`: rebuild the static topology and
/// retire timetable snapshots of the previous generation.
pub(crate) fn refresh_topology(routing: &Path, progress: &Progress) -> Result<Js> {
    let sidecar = vigo_gtfs::store::static_topology_sidecar_path(routing);
    let before = vigo_gtfs::inspect_static_topology_sidecar(routing, Some(&sidecar))?;
    let mut report = |event: &vigo_gtfs::Progress| {
        progress.gtfs_scaled(event, 0.75 + event.progress.clamp(0.0, 1.0) * 0.25)
    };
    let topology =
        vigo_gtfs::build_static_topology_sidecar(routing, &sidecar, &mut report, None, true)?;
    let name = routing.file_name().and_then(|n| n.to_str()).unwrap_or("");
    let prefix = format!("{name}.active-service-kernel.");
    let mut removed = vec![];
    let mut removed_bytes = 0u64;
    if let Some(directory) = routing.parent() {
        for entry in std::fs::read_dir(directory)? {
            let entry = entry?;
            let file = entry.file_name().to_string_lossy().into_owned();
            if entry.file_type()?.is_file()
                && file.starts_with(&prefix)
                && (file.ends_with(".bin") || (file.contains(".bin.") && file.ends_with(".tmp")))
            {
                let bytes = entry.metadata()?.len();
                std::fs::remove_file(entry.path())?;
                removed_bytes += bytes;
                removed.push(
                    Js::object()
                        .with("path", entry.path().to_string_lossy().into_owned())
                        .with("bytes", bytes),
                );
            }
        }
    }
    let attestation = inspect_topology(routing)?;
    if attestation.get("ready") != Some(&Js::Bool(true)) {
        let reason = attestation
            .get("reason")
            .and_then(Js::as_str)
            .unwrap_or("unknown");
        return Err(format!(
            "Static-topology refresh did not produce a current sidecar: {reason}."
        )
        .into());
    }
    Ok(Js::object()
        .with("schemaVersion", "vigo.routing.derived-artifact-refresh.v1")
        .with("storePath", routing.to_string_lossy().into_owned())
        .with("sidecarPath", sidecar.to_string_lossy().into_owned())
        .with("before", before)
        .with("staticTopology", topology)
        .with(
            "activeServiceKernels",
            Js::object()
                .with("removed", Js::Array(removed.clone()))
                .with("removedCount", removed.len())
                .with("removedBytes", removed_bytes),
        )
        .with("attestation", attestation))
}

pub(crate) fn inspect_topology(routing: &Path) -> Result<Js> {
    Ok(vigo_gtfs::inspect_static_topology_sidecar(routing, None)?)
}

/// Authorized endpoint access (`buildTerminalAccessStore`). `components`
/// returns the public access components of the configured coordinate profile.
pub(crate) fn build_terminal_access(
    pbf: &Path,
    street: &Path,
    components: &mut dyn FnMut() -> Result<Vec<u32>>,
) -> Result<Js> {
    let mut boundary = || components().map_err(|e| vigo_osm::Error::new(e.to_string()));
    Ok(vigo_osm::build_terminal_access_store(
        pbf,
        street,
        &mut boundary,
    )?)
}
