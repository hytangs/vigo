//! `vigo build`: compile GTFS feeds and an OpenStreetMap extract into a City.
//!
//! The steps and the files they write are the prepared-data contract of
//! `docs/reference/city-format.md`. A City is compiled into a private sibling
//! directory and renamed into place when complete. `vigo build-scenarios`
//! compiles several Cities that share one street network.
mod access;
mod cch;
mod host;
mod internal;
mod policy;
mod publish;
mod raw;
mod scenarios;
mod signals;
mod timetable;

use super::fail;
use access::AccessStore;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Instant;
use vigo_format::js::{self, Js};

pub(crate) type Result<T> = super::Result<T>;

const API_VERSION: &str = "1.0";
const CITY_FORMAT_VERSION: u32 = 1;
const STREET_MODES: [&str; 4] = ["walk", "walk,drive", "walk,bike", "walk,drive,bike"];

pub(crate) const HELP: &str = "VIGO build · compile GTFS and OSM into a reusable City

Usage:
  vigo build --gtfs feed.zip --osm region.osm.pbf --output ./city [--replace]

Options:
  --gtfs PATH                 GTFS ZIP; repeat for multiple sources
  --gtfs-scope VALUE          Unique source scope; one per --gtfs
  --osm PATH                  OSM .pbf covering the City
  --output PATH               City output directory
  --wheelchair                Prepare a strict wheelchair City
  --wheelchair-streets MODE   Wheelchair street evidence: inferred (step-free unless mapped otherwise) or verified (wheelchair=yes only)
  --private-access VALUE      public (default) or endpoints for authorized access
  --street-modes VALUE        walk, walk,drive (default), walk,bike, or walk,drive,bike
  --streets-from PATH         Reuse identical immutable streets from a prepared City
  --prepare-date YYYY-MM-DD   Precompile this service date; repeat for other dates
  --replace                   Replace an existing City
  --help                      Show help for this command

Options accept --name value or --name=value. Progress goes to standard error;
the City manifest is printed to standard output.
";

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Value,
    Repeat,
    Boolean,
}

const CITY_OPTIONS: [&str; 11] = [
    "gtfs",
    "gtfs-scope",
    "osm",
    "output",
    "wheelchair",
    "wheelchair-streets",
    "private-access",
    "street-modes",
    "streets-from",
    "prepare-date",
    "help",
];

/// The options a member City of `vigo build-scenarios` is compiled with.
/// Not a command: the name cannot be typed on a command line.
pub(crate) const SCENARIO_CITY: &str = "scenario city";

fn option_kind(command: &str, name: &str) -> Option<Kind> {
    let allowed: &[&str] = match command {
        "build" => &["replace"],
        SCENARIO_CITY => &["flex-driving", "city-name"],
        "build-scenarios" => &["spec", "output", "wheelchair", "wheelchair-streets", "help"],
        "_build-gtfs-store" => &[
            "gtfs",
            "gtfs-scope",
            "wheelchair",
            "wheelchair-streets",
            "output-store",
            "merge-store",
            "city",
            "progress",
            "help",
        ],
        "_build-street-store" => &[
            "osm",
            "street-modes",
            "wheelchair",
            "wheelchair-streets",
            "flex-driving",
            "output-store",
            "routing-store",
            "private-access",
            "studio",
            "drive-profile",
            "progress",
            "help",
        ],
        "_build-static-topology" => &[
            "store",
            "output",
            "force",
            "minimum-free-bytes",
            "progress",
            "help",
        ],
        "_compact-gtfs-store" | "_stop-access-roles" => &["store", "help"],
        "_prepare-transfers" => &["routing-store", "street-store", "progress", "help"],
        "_remove-stop-transfers" => &["routing-store", "progress", "help"],
        "_refresh-topology" => &["store", "progress", "help"],
        "_build-drive-store" => &["street-store", "native", "help"],
        "_build-walk-store" => &["street-store", "help"],
        "_backfill-place-names" => &["street-store", "osm", "progress", "help"],
        "_compact-street-store" => &["street-store", "require-drive", "help"],
        "_build-terminal-access" => &["osm", "street-store", "routing-store", "help"],
        _ => &[],
    };
    let city = (command == "build" || command == SCENARIO_CITY) && CITY_OPTIONS.contains(&name);
    if !city && !allowed.contains(&name) {
        return None;
    }
    Some(match name {
        "gtfs" | "gtfs-scope" | "prepare-date" | "merge-store" => Kind::Repeat,
        "wheelchair" | "replace" | "help" | "flex-driving" | "city" | "studio" | "force"
        | "native" | "require-drive" | "drive-profile" => Kind::Boolean,
        _ => Kind::Value,
    })
}

struct Arguments(HashMap<String, Vec<String>>);
impl Arguments {
    fn parse(command: &str, argv: Vec<String>) -> Result<Self> {
        let mut values: HashMap<String, Vec<String>> = HashMap::new();
        let mut index = 0;
        while index < argv.len() {
            let mut token = argv[index].clone();
            index += 1;
            if token == "-h" {
                token = "--help".into();
            }
            let Some(raw) = token.strip_prefix("--") else {
                return fail(format!(
                    "Unexpected argument: {token}. Use named options after the command."
                ));
            };
            let (name, inline) = match raw.split_once('=') {
                Some((name, value)) => (name.to_owned(), Some(value.to_owned())),
                None => (raw.to_owned(), None),
            };
            let Some(kind) = option_kind(command, &name) else {
                return fail(format!(
                    "Unknown option: --{name}. Use --help to see supported options."
                ));
            };
            let boolean = |v: &str| {
                ["true", "false", "yes", "no", "1", "0"].contains(&v.to_ascii_lowercase().as_str())
            };
            let value = match kind {
                Kind::Boolean => {
                    let value = match inline {
                        Some(value) => value,
                        None if argv.get(index).is_some_and(|next| boolean(next)) => {
                            index += 1;
                            argv[index - 1].clone()
                        }
                        None => "true".into(),
                    };
                    if !boolean(&value) {
                        return fail(format!("--{name} expects true or false"));
                    }
                    value
                }
                Kind::Value | Kind::Repeat => {
                    let value = match inline {
                        Some(value) => value,
                        None => {
                            let next = argv.get(index);
                            let negative_number = next
                                .is_some_and(|n| n.len() > 1 && n.as_bytes()[1].is_ascii_digit());
                            match next {
                                Some(next)
                                    if !next.starts_with('-') || next == "-" || negative_number =>
                                {
                                    index += 1;
                                    next.clone()
                                }
                                _ => {
                                    return fail(format!(
                                        "--{name} requires a value. For a value starting with -, use --{name}=VALUE."
                                    ));
                                }
                            }
                        }
                    };
                    if value.trim().is_empty() {
                        return fail(format!("--{name} requires a non-empty value"));
                    }
                    value
                }
            };
            if values.contains_key(&name) && kind != Kind::Repeat {
                return fail(format!("--{name} may only be supplied once"));
            }
            values.entry(name).or_default().push(value);
        }
        Ok(Arguments(values))
    }
    fn value(&self, name: &str) -> Option<&str> {
        self.0.get(name).and_then(|v| v.last()).map(String::as_str)
    }
    fn values(&self, name: &str) -> &[String] {
        self.0.get(name).map_or(&[], Vec::as_slice)
    }
    fn enabled(&self, name: &str) -> bool {
        self.value(name)
            .is_some_and(|v| ["1", "true", "yes"].contains(&v.to_ascii_lowercase().as_str()))
    }
    fn has(&self, name: &str) -> bool {
        self.0.contains_key(name)
    }
}

/// Progress on standard error: `[scope] Phase: detail`. A repeated phase is
/// shown at most every ten seconds unless it completes.
/// Internal commands report progress as JSON lines for their parent process.
static JSON_PROGRESS: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[derive(Clone)]
pub(crate) struct Progress {
    scope: &'static str,
    previous: std::sync::Arc<std::sync::Mutex<(String, Option<Instant>)>>,
}
impl Progress {
    pub fn new(scope: &'static str) -> Self {
        Progress {
            scope,
            previous: Default::default(),
        }
    }
    pub fn emit(&self, phase: &str, progress: f64, detail: &str) {
        self.emit_work(phase, progress, detail, None);
    }
    /// An event that measured `work`: `{completed, total, unit: "bytes"}`,
    /// with `rows` for a GTFS table. Only JSON progress carries it.
    pub fn emit_work(&self, phase: &str, progress: f64, detail: &str, work: Option<Js>) {
        if JSON_PROGRESS.load(std::sync::atomic::Ordering::Relaxed) {
            let mut event = Js::object()
                .with("phase", phase)
                .with("progress", progress)
                .with("detail", detail);
            if let Some(work) = work {
                event.set("work", work);
            }
            eprintln!("{}", event.stringify());
            return;
        }
        let mut previous = self.previous.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        if previous.0 == phase
            && progress < 1.0
            && previous
                .1
                .is_some_and(|at| now.duration_since(at).as_secs_f64() < 10.0)
        {
            return;
        }
        *previous = (phase.to_owned(), Some(now));
        let detail = detail.trim();
        if detail.is_empty() {
            eprintln!("[{}] {phase}", self.scope);
        } else {
            eprintln!("[{}] {phase}: {detail}", self.scope);
        }
    }
    pub fn phase(&self, phase: &str) {
        self.emit(phase, 0.0, "");
    }
    pub fn gtfs(&self, event: &vigo_gtfs::Progress) {
        self.gtfs_scaled(event, event.progress);
    }
    pub fn gtfs_scaled(&self, event: &vigo_gtfs::Progress, progress: f64) {
        let work = event.work.map(|work| {
            Js::object()
                .with("completed", work.completed as f64)
                .with("total", work.total as f64)
                .with("unit", "bytes")
                .with("rows", work.rows as f64)
        });
        self.emit_work(&event.phase, progress, &event.detail, work);
    }
    pub fn osm(&self, event: &vigo_osm::Progress) {
        let work = event.work.map(|work| {
            Js::object()
                .with("completed", work.completed as f64)
                .with("total", work.total as f64)
                .with("unit", "bytes")
        });
        self.emit_work(event.phase, event.progress, event.detail, work);
    }
}

/// The admission code and reason of a refused routing or street store.
fn admission_reason(
    error: &(dyn std::error::Error + 'static),
) -> Option<(&'static str, &'static str)> {
    if let Some(error) = error.downcast_ref::<vigo_gtfs::Error>() {
        return error
            .reason
            .map(|reason| ("VIGO_ROUTING_STORE_ADMISSION_FAILED", reason));
    }
    error
        .downcast_ref::<vigo_osm::Error>()
        .and_then(|error| error.reason)
        .map(|reason| ("VIGO_STREET_STORE_ADMISSION_FAILED", reason))
}

/// Write a private derived file through a temporary name.
pub(crate) fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut temporary = path.as_os_str().to_owned();
    temporary.push(format!(".{}.tmp", std::process::id()));
    let temporary = PathBuf::from(temporary);
    let result = (|| -> std::io::Result<()> {
        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        std::io::Write::write_all(&mut options.open(&temporary)?, bytes)?;
        fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    Ok(result?)
}

fn file_digest(path: &Path) -> Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = vec![0u8; 1 << 20];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn absolute(path: &str) -> Result<PathBuf> {
    let path = Path::new(path);
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    // path.resolve: lexical normalization, without following links.
    let mut normalized = PathBuf::new();
    for component in joined.components() {
        match component {
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            std::path::Component::CurDir => {}
            other => normalized.push(other),
        }
    }
    Ok(normalized)
}

fn required_input(input: &str, label: &str, extensions: &[&str]) -> Result<PathBuf> {
    if input.trim().is_empty() {
        return fail(format!("build requires {label}"));
    }
    let path = absolute(input)?;
    if !path.is_file() {
        return fail(format!("{label} file not found: {}", path.display()));
    }
    let lower = path.to_string_lossy().to_lowercase();
    if !extensions
        .iter()
        .any(|extension| lower.ends_with(extension))
    {
        return fail(format!(
            "{label} has an unsupported file name: {}",
            path.display()
        ));
    }
    Ok(path)
}

/// `defaultGtfsScope`: the file name without `.gtfs.zip` or `.zip`.
fn default_scope(path: &str, index: usize) -> String {
    let name = Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let lower = name.to_lowercase();
    let stem = if lower.ends_with(".gtfs.zip") {
        &name[..name.len() - 9]
    } else if lower.ends_with(".zip") {
        &name[..name.len() - 4]
    } else {
        &name
    };
    let mut scope = String::new();
    let mut separator = false;
    for c in stem.chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
            scope.push(c);
            separator = false;
        } else if !separator {
            scope.push('-');
            separator = true;
        }
    }
    let scope = scope.trim_matches('-').to_owned();
    if scope.is_empty() {
        format!("feed-{}", index + 1)
    } else {
        scope
    }
}

pub(crate) struct Feed {
    pub path: PathBuf,
    pub scope: String,
}

pub(crate) struct Options {
    pub feeds: Vec<Feed>,
    pub osm: PathBuf,
    pub output: PathBuf,
    pub name: String,
    pub wheelchair: bool,
    pub wheelchair_streets: String,
    pub street_modes: String,
    pub private_access: String,
    pub streets_from: Option<PathBuf>,
    pub prepare_dates: Vec<String>,
    pub flex_driving: bool,
}

fn wheelchair_description(streets: &str) -> Js {
    let evidence = if streets == "verified" {
        "wheelchair-yes-only"
    } else {
        "inferred-step-free-v1"
    };
    let street_limitation = if streets == "verified" {
        "Unknown street accessibility is excluded; only ways tagged wheelchair=yes are used."
    } else {
        "Inferred streets can lack wheelchair or surface tags. An explicit wheelchair=yes overrides surface and trail filters; mapped dimensions and some barriers are still checked."
    };
    Js::object()
        .with("profile", policy::WHEELCHAIR_PROFILE)
        .with("unknownData", "exclude")
        .with("streetEvidence", evidence)
        .with("stationPaths", "published-wheelchair-time-or-dimensioned-step-free")
        .with("fareGates", "accessible-endpoints-with-published-time-or-five-second-estimate")
        .with(
            "sameLevelWalkways",
            "zero-wheelchair-length-with-published-walk-length-and-accessible-endpoints",
        )
        .with("minimumWidthMeters", 0.9)
        .with("maximumSlope", 0.083)
        .with(
            "limitations",
            vec![
                "Unknown vehicle and boarding accessibility is excluded; coverage may be sparse.",
                "Fare gates between accessible nodes use published crossing time or a five-second estimate.",
                "Same-level walkways with accessible endpoints and a zero wheelchair length use their positive published walk length.",
                street_limitation,
                "Coordinate attachments are geometric; door-to-street access is not verified.",
                "Elevator outages, temporary obstructions and individual chair dimensions are not modeled.",
            ],
        )
}

/// Validate a build's options before any work starts.
fn options(command: &str, arguments: &Arguments) -> Result<Options> {
    for name in ["gtfs", "osm", "output"] {
        if !arguments.has(name) {
            return fail(format!("{command} requires --{name}"));
        }
    }
    if arguments.value("output") == Some("-") {
        return fail("build requires a City output directory, not -");
    }
    let wheelchair = arguments.enabled("wheelchair");
    let wheelchair_streets = arguments
        .value("wheelchair-streets")
        .unwrap_or("inferred")
        .to_owned();
    if !["inferred", "verified"].contains(&wheelchair_streets.as_str()) {
        return fail("--wheelchair-streets must be inferred or verified");
    }
    let street_modes = arguments
        .value("street-modes")
        .unwrap_or(if wheelchair { "walk" } else { "walk,drive" })
        .to_owned();
    if wheelchair && street_modes != "walk" {
        return fail("Wheelchair Cities require --street-modes walk");
    }
    if !STREET_MODES.contains(&street_modes.as_str()) {
        return fail("street-modes must be walk, walk,drive, walk,bike, or walk,drive,bike");
    }
    let private_access = arguments
        .value("private-access")
        .unwrap_or("public")
        .to_owned();
    if wheelchair && private_access != "public" {
        return fail("Wheelchair Cities require public access");
    }
    if !["public", "endpoints"].contains(&private_access.as_str()) {
        return fail("private-access must be public or endpoints");
    }
    let gtfs = arguments.values("gtfs");
    let scopes = arguments.values("gtfs-scope");
    if gtfs.is_empty() {
        return fail("build requires at least one --gtfs GTFS ZIP");
    }
    if !scopes.is_empty() && scopes.len() != gtfs.len() {
        return fail("repeat --gtfs-scope once for every --gtfs input, or omit it");
    }
    let mut feeds = vec![];
    for (index, input) in gtfs.iter().enumerate() {
        feeds.push(Feed {
            path: required_input(input, &format!("GTFS ZIP {}", index + 1), &[".zip"])?,
            scope: scopes
                .get(index)
                .cloned()
                .unwrap_or_else(|| default_scope(input, index))
                .trim()
                .to_owned(),
        });
    }
    if feeds.iter().any(|f| f.scope.is_empty()) {
        return fail("GTFS scopes must be non-empty");
    }
    let unique: std::collections::HashSet<_> = feeds.iter().map(|f| &f.scope).collect();
    if unique.len() != feeds.len() {
        return fail("GTFS scopes must be unique; pass one --gtfs-scope for each feed");
    }
    let osm = required_input(arguments.value("osm").unwrap_or(""), "OSM PBF", &[".pbf"])?;
    let output = absolute(arguments.value("output").unwrap_or(""))?;
    if output.parent().is_none() {
        return fail("City output cannot be a filesystem root");
    }
    for date in arguments.values("prepare-date") {
        if chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").is_err() || date.len() != 10 {
            return fail("prepare-date requires an ISO service date");
        }
    }
    Ok(Options {
        name: arguments
            .value("city-name")
            .map(str::to_owned)
            .unwrap_or_else(|| {
                output
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default()
            }),
        feeds,
        osm,
        output,
        wheelchair,
        wheelchair_streets,
        street_modes,
        private_access,
        streets_from: arguments.value("streets-from").map(absolute).transpose()?,
        prepare_dates: arguments.values("prepare-date").to_vec(),
        flex_driving: arguments.enabled("flex-driving"),
    })
}

/// `vigo build`, `vigo build-scenarios` and the internal compiler commands.
/// Returns the process exit status.
pub fn main(command: &str, mut argv: Vec<String>) -> i32 {
    // A build started by another VIGO process ends with it: the parent keeps
    // our standard input open and never writes to it. Whatever a stopped
    // build leaves beside its output is removed by the next build.
    if let Some(index) = argv.iter().position(|a| a == "--parent-pipe") {
        argv.remove(index);
        std::thread::spawn(|| {
            let mut sink = [0u8; 64];
            let mut input = std::io::stdin().lock();
            loop {
                match input.read(&mut sink) {
                    Ok(n) if n > 0 => {}
                    // A termination signal interrupts this read; the signal
                    // watcher ends the process with that signal instead.
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                    _ => break,
                }
            }
            std::process::exit(1);
        });
    }
    let result = (|| -> Result<()> {
        let arguments = Arguments::parse(command, argv)?;
        if arguments.enabled("help") {
            print!(
                "{}",
                if command == "build-scenarios" {
                    scenarios::HELP
                } else {
                    HELP
                }
            );
            return Ok(());
        }
        if let Some(mode) = arguments.value("progress") {
            if mode != "json" && mode != "text" {
                return fail("--progress must be json or text");
            }
            JSON_PROGRESS.store(mode == "json", std::sync::atomic::Ordering::Relaxed);
        }
        if let Some(result) = internal::run(command, &arguments)? {
            println!("{}", result.stringify());
            return Ok(());
        }
        if command == "build-scenarios" {
            return scenarios::run(&arguments);
        }
        let options = options(command, &arguments)?;
        let manifest = build(&options, arguments.enabled("replace"))?;
        println!("{}", manifest.stringify_pretty(2));
        Ok(())
    })();
    match result {
        Ok(()) => 0,
        Err(error) => {
            signals::await_termination();
            // A refused store keeps the machine-readable code and reason the
            // calling process reports (`{"error":{"code","reason"}}`).
            if command.starts_with('_')
                && let Some((code, reason)) = admission_reason(error.as_ref())
            {
                let detail = Js::object().with("code", code).with("reason", reason);
                eprintln!("{}", Js::object().with("error", detail).stringify());
            }
            eprintln!("VIGO {}: {error}", command.trim_start_matches('_'));
            if command == "build" || command == "build-scenarios" {
                eprintln!("Run \"vigo {command} --help\" for usage.");
            }
            2
        }
    }
}

/// Compile into a private sibling and publish atomically.
fn build(options: &Options, replace: bool) -> Result<Js> {
    publish::recover(&options.output)?;
    if options.output.exists() && !replace {
        return fail(format!(
            "City already exists; pass --replace to replace it: {}",
            options.output.display()
        ));
    }
    let staging = publish::staging_path(&options.output);
    // Register before the directory exists: a signal may arrive at any time.
    let _guard = signals::remove_on_termination(&staging);
    publish::create_staging_directory(&options.output, &staging)?;
    let result = (|| {
        let manifest = compile(options, &staging)?;
        Progress::new("city").phase("Saving City");
        publish::publish(&staging, &options.output, replace, true)?;
        Ok(manifest)
    })();
    if staging.exists() {
        let _ = fs::remove_dir_all(&staging);
    }
    result
}

fn metadata_record(path: &Path) -> Result<Vec<(String, Js)>> {
    let db =
        rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let mut statement = db.prepare("SELECT key, value FROM metadata")?;
    let rows = statement
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows
        .into_iter()
        .map(|(key, text)| {
            let value = Js::parse(&text).unwrap_or(Js::String(text));
            (key, value)
        })
        .collect())
}

fn field(record: &[(String, Js)], key: &str) -> Option<Js> {
    record
        .iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.clone())
}

/// `linkStreetBase`: share a donor City's street files without its endpoint overlay.
fn link_street_base(source: &Path, destination: &Path) -> Result<()> {
    fs::create_dir_all(destination)?;
    let destination_real = fs::canonicalize(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let name = entry.file_name();
        let name_text = name.to_string_lossy();
        if name_text == "street-index.sqlite.terminal-access-v1.json" {
            continue;
        }
        let target = fs::canonicalize(entry.path())?;
        if !target.is_file() {
            return fail(format!("Unexpected street base member: {name_text}"));
        }
        if name_text.ends_with(".structure") || name_text.ends_with(".metric") {
            fs::hard_link(&target, destination.join(&name))?;
        } else {
            let relative = relative_path(&destination_real, &target);
            #[cfg(unix)]
            std::os::unix::fs::symlink(relative, destination.join(&name))?;
            #[cfg(windows)]
            std::os::windows::fs::symlink_file(relative, destination.join(&name))?;
        }
    }
    Ok(())
}

/// `path.relative(from, to)` for absolute paths.
fn relative_path(from: &Path, to: &Path) -> PathBuf {
    let from: Vec<_> = from.components().collect();
    let to: Vec<_> = to.components().collect();
    let common = from.iter().zip(&to).take_while(|(a, b)| a == b).count();
    let mut relative = PathBuf::new();
    for _ in common..from.len() {
        relative.push("..");
    }
    for component in &to[common..] {
        relative.push(component);
    }
    relative
}

use vigo_format::js::iso_now;

fn milliseconds(started: Instant) -> f64 {
    (started.elapsed().as_secs_f64() * 1e6).round() / 1e3
}

/// Every step of a City, into an empty directory. Returns its manifest.
fn compile(options: &Options, staging: &Path) -> Result<Js> {
    let wheelchair = options.wheelchair;
    let accessibility = wheelchair.then(|| wheelchair_description(&options.wheelchair_streets));
    let modes: Vec<&str> = options.street_modes.split(',').collect();
    let osm_sha256 = file_digest(&options.osm)?;
    let shared = match &options.streets_from {
        Some(path) => {
            let manifest = publish::validate_city(path)?;
            let modes_of = |mode: &str| {
                manifest["modes"]
                    .as_array()
                    .is_some_and(|m| m.iter().any(|v| v == mode))
            };
            if manifest["accessibility"].is_object() != wheelchair
                || (wheelchair
                    && manifest["accessibility"]["streetEvidence"]
                        != accessibility
                            .as_ref()
                            .and_then(|a| a.get("streetEvidence"))
                            .and_then(Js::as_str)
                            .unwrap_or(""))
                || manifest["sources"]["osm"]["sha256"] != osm_sha256.as_str()
                || manifest["preparationPolicy"] != "vigo.city.prepare.v2"
                || modes_of("drive") != modes.contains(&"drive")
                || modes_of("bike") != modes.contains(&"bike")
            {
                return fail(
                    "Shared streets require matching OSM bytes, prepared modes, accessibility and preparation policy.",
                );
            }
            Some((path.clone(), manifest))
        }
        None => None,
    };
    let gtfs_bytes: u64 = options
        .feeds
        .iter()
        .map(|f| fs::metadata(&f.path).map(|m| m.len()))
        .sum::<std::io::Result<u64>>()?;
    let osm_bytes = fs::metadata(&options.osm)?.len();
    let concurrency = raw::concurrency(gtfs_bytes, osm_bytes);
    let parallel = !wheelchair && shared.is_none() && concurrency.enabled;

    let routing_dir = staging.join("routing");
    let osm_dir = staging.join("osm");
    fs::create_dir_all(&routing_dir)?;
    if let Some((path, manifest)) = &shared {
        let street = fs::canonicalize(path.join("osm"))?;
        if options.private_access == "public"
            && manifest["streetStore"]["terminalAccess"]["model"] == "public"
        {
            let relative = relative_path(&fs::canonicalize(staging)?, &street);
            #[cfg(unix)]
            std::os::unix::fs::symlink(relative, &osm_dir)?;
            #[cfg(windows)]
            std::os::windows::fs::symlink_dir(relative, &osm_dir)?;
        } else {
            link_street_base(&street, &osm_dir)?;
        }
    } else {
        fs::create_dir_all(&osm_dir)?;
    }
    let routing = routing_dir.join("project.sqlite");
    let street = osm_dir.join("street-index.sqlite");
    let started = Instant::now();
    let city = Progress::new("city");
    let street_options = |flex_driving: bool| raw::StreetOptions {
        include_driving: modes.contains(&"drive") || flex_driving,
        include_biking: modes.contains(&"bike"),
        flex_driving,
        wheelchair,
        wheelchair_streets: options.wheelchair_streets.clone(),
    };

    // GTFS and OSM compile independently; run them together when memory allows.
    let (gtfs, parallel_streets) = std::thread::scope(|scope| {
        let streets = parallel.then(|| {
            let street_options = street_options(false);
            let (pbf, street) = (&options.osm, &street);
            scope.spawn(move || {
                let started = Instant::now();
                raw::build_streets(pbf, street, &street_options, &Progress::new("osm"))
                    .map(|r| (r, milliseconds(started)))
            })
        });
        let gtfs_started = Instant::now();
        let gtfs = raw::build_gtfs(
            &options.feeds,
            &routing,
            wheelchair,
            &options.wheelchair_streets,
            &Progress::new("gtfs"),
        )
        .map(|()| milliseconds(gtfs_started));
        let streets = streets.map(|handle| {
            handle
                .join()
                .unwrap_or_else(|_| fail("The OSM compiler stopped unexpectedly."))
        });
        (gtfs, streets)
    });
    let gtfs_build_ms = gtfs?;

    // On-demand vehicle durations need roads even when walking is restricted to
    // the strict wheelchair graph. This does not enable Drive queries.
    let mut flex_driving = options.flex_driving;
    if wheelchair && !flex_driving {
        let db = rusqlite::Connection::open_with_flags(
            &routing,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        let catalog: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='flex_catalog')",
            [],
            |r| r.get(0),
        )?;
        if catalog {
            flex_driving = db.query_row(
                "SELECT EXISTS(SELECT 1 FROM flex_catalog,json_each(data,'$.trips') WHERE json_extract(value,'$.onDemand')=1)",
                [],
                |r| r.get(0),
            )?;
        }
    }

    let mut osm_build_ms = 0.0;
    let street_result: Js = match (&shared, parallel_streets) {
        (Some(_), _) => Js::Object(metadata_record(&street)?),
        (None, Some(result)) => {
            let (result, ms) = result?;
            osm_build_ms = ms;
            result
        }
        (None, None) => {
            let started = Instant::now();
            let result = raw::build_streets(
                &options.osm,
                &street,
                &street_options(flex_driving),
                &Progress::new("osm"),
            )?;
            osm_build_ms = milliseconds(started);
            result
        }
    };
    let drive_edges = street_result
        .get("driveEdgeCount")
        .and_then(Js::as_f64)
        .unwrap_or(0.0);
    let drive = if shared.is_none() && drive_edges > 0.0 {
        city.phase("Preparing driving routes");
        Some(raw::build_drive(&street)?)
    } else {
        None
    };

    // Publish one sealed runtime layout before any native preparation.
    let compaction_started = Instant::now();
    city.phase("Saving street data");
    let compaction = match &shared {
        Some((_, manifest)) => Js::object()
            .with("afterBytes", Js::from(&manifest["streetStore"]["bytes"]))
            .with(
                "storageLayout",
                Js::from(&manifest["streetStore"]["storageLayout"]),
            )
            .with("bytesSaved", 0)
            .with("drive", Js::Null),
        None => raw::compact_streets(&street)?,
    };
    let walk_snapshot = cch::with_suffix(&street, ".street-accelerator-v7.bin");
    let compaction_ms = milliseconds(compaction_started);

    let cch_started = Instant::now();
    city.phase("Preparing street routing");
    let street_cch = cch::prefix(&walk_snapshot, cch::STREET_FORMAT)?;
    let load = crate::StreetCchLoadInput {
        structure_path: cch::with_suffix(&street_cch, ".structure")
            .to_string_lossy()
            .into_owned(),
        metric_path: cch::with_suffix(&street_cch, ".metric")
            .to_string_lossy()
            .into_owned(),
    };
    let snapshot_text = walk_snapshot.to_string_lossy().into_owned();
    let (mut kernel, street_cch_summary) = match &shared {
        Some((_, manifest)) => {
            let kernel = crate::CoordinateKernel::open_prepared(snapshot_text, load)?;
            let summary = &manifest["streetStore"]["streetCch"];
            (kernel, Js::from(summary))
        }
        None => {
            let built = build_street_cch(&walk_snapshot)?;
            let summary = Js::object()
                .with("ready", built.loaded.cch_arc_count > 0)
                .with("format", cch::STREET_FORMAT)
                .with("orderStrategy", "balanced")
                .with("nodeCount", built.built.node_count)
                .with("edgeCount", built.built.edge_count)
                .with("cchArcCount", built.built.cch_arc_count)
                .with("structureFile", file_name(&built.structure))
                .with("metricFile", file_name(&built.metric));
            (built.kernel, summary)
        }
    };
    let street_cch_ms = milliseconds(cch_started);

    // Seal SQLite before binding transfers and access snapshots to its generation.
    let gtfs_compaction_started = Instant::now();
    city.phase("Preparing transit topology");
    let gtfs_compaction = raw::compact_gtfs(&routing)?;
    let gtfs_compaction_ms = milliseconds(gtfs_compaction_started);

    let street_identity = street_identity_of(&street)?;
    reserve_workspaces(&mut kernel)?;
    let transfers_started = Instant::now();
    let transfers = stop_transfers(&routing, &mut kernel, &street_identity)?;
    let transfers_ms = milliseconds(transfers_started);

    let access_started = Instant::now();
    city.phase("Preparing station access");
    let (store, profile_key, profile_bytes) =
        prepare_coordinate_access(&routing, &mut kernel, &street_identity)?;
    let access_ms = milliseconds(access_started);

    let terminal_access = if options.private_access == "endpoints" {
        let mut components = || -> Result<Vec<u32>> { Ok(kernel.public_access_components()?) };
        raw::build_terminal_access(&options.osm, &street, &mut components)?
    } else {
        Js::object().with("model", "public")
    };
    drop(kernel);
    let topology = raw::inspect_topology(&routing)?;
    if topology.get("ready") != Some(&Js::Bool(true)) {
        let reason = topology
            .get("reason")
            .and_then(Js::as_str)
            .unwrap_or("unknown");
        return fail(format!("City topology is not current: {reason}."));
    }
    for date in &options.prepare_dates {
        let phase = format!("Preparing timetable for {date}");
        city.phase(&phase);
        if !timetable::prepare_date(&store, date)? {
            city.emit(
                &phase,
                1.0,
                "frequency-based trips are compiled when queried",
            );
        }
    }

    let routing_metadata = metadata_record(&routing)?;
    let built_at = iso_now();
    let revision = built_at.replace(['-', ':'], "").replacen('.', "-", 1);
    let mut gtfs_sources = vec![];
    for feed in &options.feeds {
        gtfs_sources.push(
            Js::object()
                .with(
                    "name",
                    feed.path
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_default(),
                )
                .with("scope", feed.scope.as_str())
                .with("sha256", file_digest(&feed.path)?)
                .with("bytes", fs::metadata(&feed.path)?.len()),
        );
    }
    let osm_name = options
        .osm
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let sources = Js::object().with("gtfs", gtfs_sources.clone()).with(
        "osm",
        Js::object()
            .with("name", osm_name.as_str())
            .with("sha256", osm_sha256.as_str())
            .with("bytes", osm_bytes),
    );
    let get = |key: &str| field(&routing_metadata, key);
    let feature = |key: &str| get("featureInventory").and_then(|f| f.get(key).cloned());
    let mut summary = Js::object().with("schemaVersion", "vigo.city.v1");
    if let Some(accessibility) = &accessibility {
        summary.set("accessibility", accessibility.clone());
    }
    let compaction_drive = compaction.get("drive");
    let drive_snapshot_name = compaction_drive
        .and_then(|d| d.get("snapshotPath"))
        .and_then(Js::as_str)
        .filter(|p| !p.is_empty())
        .and_then(|p| Path::new(p).file_name())
        .map(|n| Js::from(n.to_string_lossy().into_owned()))
        .unwrap_or(Js::Null);
    let drive_accelerator = match &drive {
        Some(drive) => {
            let pick = |key: &str| drive.get(key).cloned().unwrap_or(Js::Null);
            Js::object()
                .with("ready", pick("ready"))
                .with("source", pick("source"))
                .with(
                    "buildMs",
                    drive.get("buildMs").cloned().unwrap_or(Js::Number(0.0)),
                )
                .with(
                    "snapshotWriteMs",
                    drive
                        .get("snapshotWriteMs")
                        .cloned()
                        .unwrap_or(Js::Number(0.0)),
                )
                .with("snapshotStatus", pick("snapshotStatus"))
                .with("reason", pick("reason"))
                .with("error", pick("error"))
        }
        None => street_result
            .get("driveAccelerator")
            .cloned()
            .unwrap_or(Js::Null),
    };
    let street_value = |key: &str| street_result.get(key).cloned().unwrap_or(Js::Null);
    summary = summary
        .with("productVersion", env!("CARGO_PKG_VERSION"))
        .with("apiVersion", API_VERSION)
        .with("cityFormatVersion", CITY_FORMAT_VERSION)
        .with("preparationPolicy", "vigo.city.prepare.v2")
        .with(
            "modes",
            std::iter::once("transit")
                .chain(modes.iter().copied())
                .map(Js::from)
                .collect::<Vec<_>>(),
        );
    if flex_driving {
        summary.set("flexVehicleEstimates", true);
    }
    summary = summary
        .with(
            "validation",
            Js::object()
                .with("schemaVersion", "vigo.preparation.validation.v1")
                .with(
                    "routingLimitations",
                    get("routingLimitations").unwrap_or(Js::Array(vec![])),
                )
                .with(
                    "blockingRoutingFeatures",
                    get("blockingRoutingFeatures").unwrap_or(Js::Array(vec![])),
                )
                .with(
                    "excludedTripCount",
                    feature("excludedTripCount").unwrap_or(Js::Number(0.0)),
                ),
        )
        .with("kind", "city")
        .with("name", options.name.as_str())
        .with("revisionId", revision)
        .with("builtAt", built_at.as_str())
        .with("sources", sources)
        .with(
            "inputs",
            Js::object()
                .with("gtfs", gtfs_sources)
                .with("osmPbf", Js::object().with("name", osm_name.as_str())),
        )
        .with(
            "routingStore",
            Js::object()
                .with("routeCount", get("routeCount").unwrap_or(Js::Null))
                .with("stopCount", get("stopCount").unwrap_or(Js::Null))
                .with("tripCount", get("tripCount").unwrap_or(Js::Null))
                .with(
                    "connectionCount",
                    get("connectionCount").unwrap_or(Js::Null),
                )
                .with(
                    "departureIndexState",
                    get("departureIndexState")
                        .filter(|v| !matches!(v, Js::Null))
                        .or_else(|| gtfs_compaction.get("state").cloned())
                        .unwrap_or(Js::Null),
                )
                .with(
                    "runtimeCompaction",
                    Js::object()
                        .with(
                            "state",
                            gtfs_compaction.get("state").cloned().unwrap_or(Js::Null),
                        )
                        .with(
                            "bytesSaved",
                            gtfs_compaction
                                .get("bytesSaved")
                                .cloned()
                                .unwrap_or(Js::Null),
                        ),
                )
                .with(
                    "stopTransfers",
                    Js::object()
                        .with(
                            "edgeCount",
                            transfers.get("edgeCount").cloned().unwrap_or(Js::Null),
                        )
                        .with(
                            "candidateEdgeCount",
                            transfers
                                .get("candidateEdgeCount")
                                .cloned()
                                .unwrap_or(Js::Null),
                        ),
                )
                .with(
                    "nativeCoordinateAccess",
                    Js::object()
                        .with("profileKey", profile_key.as_str())
                        .with("mode", "exact-local-graph-frontier")
                        .with("persistenceState", "written")
                        .with("snapshotBytes", profile_bytes)
                        .with("prepareMs", access_ms),
                ),
        )
        .with(
            "streetStore",
            Js::object()
                .with("terminalAccess", terminal_access)
                .with("nodeCount", street_value("nodeCount"))
                .with("walkNodeCount", street_value("walkNodeCount"))
                .with("edgeCount", street_value("edgeCount"))
                .with("driveNodeCount", street_value("driveNodeCount"))
                .with("driveEdgeCount", street_value("driveEdgeCount"))
                .with(
                    "bytes",
                    compaction.get("afterBytes").cloned().unwrap_or(Js::Null),
                )
                .with(
                    "storageLayout",
                    compaction.get("storageLayout").cloned().unwrap_or(Js::Null),
                )
                .with(
                    "runtimeCompaction",
                    Js::object()
                        .with(
                            "storageLayout",
                            compaction.get("storageLayout").cloned().unwrap_or(Js::Null),
                        )
                        .with(
                            "bytesSaved",
                            compaction.get("bytesSaved").cloned().unwrap_or(Js::Null),
                        )
                        .with("driveSnapshot", drive_snapshot_name),
                )
                .with("walkAccelerator", street_value("walkAccelerator"))
                .with("driveAccelerator", drive_accelerator)
                .with("streetCch", street_cch_summary),
        )
        .with(
            "timing",
            Js::object()
                .with("totalMs", milliseconds(started))
                .with("gtfsBuildMs", gtfs_build_ms)
                .with("gtfsMergeMs", 0)
                .with("osmBuildMs", osm_build_ms)
                .with("streetCchBuildMs", street_cch_ms)
                .with("stopTransferBuildMs", transfers_ms)
                .with("coordinateAccessBuildMs", access_ms)
                .with("osmRuntimeCompactionMs", compaction_ms)
                .with("gtfsRuntimeCompactionMs", gtfs_compaction_ms)
                .with(
                    "osmDrivePreparationMs",
                    drive
                        .as_ref()
                        .and_then(|d| d.get("prepareMs"))
                        .cloned()
                        .unwrap_or(Js::Number(0.0)),
                )
                .with("rawCompilerConcurrency", concurrency.summary(parallel)),
        );
    fs::write(
        staging.join("network.json"),
        format!("{}\n", summary.stringify_pretty(2)),
    )?;
    Ok(summary)
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

pub(crate) struct StreetCch {
    pub kernel: crate::CoordinateKernel,
    pub built: crate::StreetCchBuildResult,
    pub loaded: crate::StreetCchLoadResult,
    pub structure: PathBuf,
    pub metric: PathBuf,
    pub order_strategy: &'static str,
}

/// Build, admit and load the pedestrian hierarchy of a walk snapshot
/// (`buildNativeStreetCchIndex`).
pub(crate) fn build_street_cch(walk_snapshot: &Path) -> Result<StreetCch> {
    let prefix = cch::prefix(walk_snapshot, cch::STREET_FORMAT)?;
    let structure = cch::with_suffix(&prefix, ".structure");
    let metric = cch::with_suffix(&prefix, ".metric");
    let mut kernel = crate::CoordinateKernel::new(walk_snapshot.to_string_lossy().into_owned())?;
    let order_strategy = "balanced";
    let built = kernel.build_street_cch_index(crate::StreetCchBuildInput {
        structure_path: structure.to_string_lossy().into_owned(),
        metric_path: metric.to_string_lossy().into_owned(),
        order_strategy: Some(order_strategy.into()),
    })?;
    cch::publish_manifest(
        "street",
        cch::STREET_FORMAT,
        walk_snapshot,
        &cch::with_suffix(&prefix, ".manifest.json"),
        &structure,
        &[("walk", &metric)],
        f64::from(built.edge_count),
    )?;
    let loaded = kernel.load_street_cch_index(crate::StreetCchLoadInput {
        structure_path: structure.to_string_lossy().into_owned(),
        metric_path: metric.to_string_lossy().into_owned(),
    })?;
    Ok(StreetCch {
        kernel,
        built,
        loaded,
        structure,
        metric,
        order_strategy,
    })
}

/// Endpoint workspaces reserved before the first access profile.
pub(crate) fn reserve_workspaces(kernel: &mut crate::CoordinateKernel) -> Result<()> {
    let workspace_m = std::env::var("VIGO_NATIVE_ENDPOINT_WORKSPACE_M")
        .ok()
        .map(|v| policy::js_number(&v))
        .filter(|v| v.is_finite() && *v != 0.0)
        .unwrap_or(1_600.0)
        .clamp(100.0, 5_000.0);
    kernel.reserve_endpoint_workspaces(workspace_m)?;
    Ok(())
}

/// Coordinate access for a routing store and its streets
/// (`prepareNationalGtfsNativeCoordinateAccess`): station paths, the
/// persisted access context and the native access profile snapshot.
/// Returns the store, the profile key and the snapshot size.
pub(crate) fn prepare_coordinate_access(
    routing: &Path,
    kernel: &mut crate::CoordinateKernel,
    street_identity: &str,
) -> Result<(AccessStore, String, f64)> {
    let mut store = AccessStore::open(routing)?;
    let profile = store.access_profile("coordinate-access-v11", street_identity)?;
    kernel.set_access_profile(profile.input)?;
    let mut path = routing.as_os_str().to_owned();
    path.push(format!(
        ".native-access-profile.{}.bin",
        policy::stable_key_suffix(&profile.key)
    ));
    let path = PathBuf::from(path);
    let written = kernel.persist_access_profile_snapshot(path.to_string_lossy().into_owned())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    store.station_paths = None;
    Ok((store, profile.key, written.snapshot_bytes))
}

/// `osmStopTransferStreetIdentity` of a street store.
pub(crate) fn street_identity_of(street: &Path) -> Result<String> {
    let db =
        rusqlite::Connection::open_with_flags(street, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    Ok(access::street_identity(&access::read_metadata(&db)?))
}

/// Build the driving hierarchy from the persisted drive snapshot. Returns
/// the kernel's configuration time and diagnostics.
fn build_drive_cch(snapshot: &Path) -> Result<(f64, Js)> {
    let started = Instant::now();
    use crate::exact_routing::{F64Column, U32Column};
    let prefix = cch::prefix(snapshot, cch::DRIVE_FORMAT)?;
    let structure = cch::with_suffix(&prefix, ".structure");
    let time = cch::with_suffix(&prefix, ".time.metric");
    let distance = cch::with_suffix(&prefix, ".distance.metric");
    let image = std::sync::Arc::new(super::city::Image::open(snapshot, false)?);
    let lons = F64Column::mapped(&image, "nodeLons")?;
    let targets = U32Column::mapped(&image, "edgeTargets")?;
    let edge_count = targets.len() as f64;
    let kernel = crate::DriveKernel::new(crate::DriveKernelInput {
        node_count: lons.len() as u32,
        node_lons: lons,
        node_lats: F64Column::mapped(&image, "nodeLats")?,
        edge_offsets: U32Column::mapped(&image, "edgeOffsets")?,
        edge_targets: targets,
        edge_distances: None,
        edge_travel_times: None,
        edge_distance_units: Some(U32Column::mapped(&image, "edgeDistanceUnits")?),
        edge_time_units: Some(U32Column::mapped(&image, "edgeTimeUnits")?),
        cch_structure_path: Some(structure.to_string_lossy().into_owned()),
        cch_time_metric_path: Some(time.to_string_lossy().into_owned()),
        cch_distance_metric_path: Some(distance.to_string_lossy().into_owned()),
    })?;
    let configure_ms = milliseconds(started);
    let diagnostics = Js::from(&serde_json::to_value(kernel.diagnostics())?);
    drop(kernel);
    cch::publish_manifest(
        "drive",
        cch::DRIVE_FORMAT,
        snapshot,
        &cch::with_suffix(&prefix, ".manifest.json"),
        &structure,
        &[("time", &time), ("distance", &distance)],
        edge_count,
    )?;
    Ok((configure_ms, diagnostics))
}

/// Certified walking transfers between nearby stops
/// (`ensureNationalGtfsOsmStopTransfers`). Returns the published result.
pub(crate) fn stop_transfers(
    routing: &Path,
    kernel: &mut crate::CoordinateKernel,
    street_identity: &str,
) -> Result<Js> {
    let progress = Progress::new("transfers");
    let roles = raw::ensure_stop_access_roles(routing)?;
    let roles_built = roles.get("built") == Some(&Js::Bool(true));
    let maximum_walk_m = policy::POLICY.transfer_maximum_walk_m;
    let maximum_neighbors = policy::POLICY.transfer_maximum_neighbors;
    let store = AccessStore::open(routing)?;
    let stop_count = store.metadata["stopCount"].as_f64().unwrap_or(0.0);
    let fingerprint = [
        policy::OSM_TRANSFER_SCHEMA.to_owned(),
        store.metadata["storeId"]
            .as_str()
            .or(store.metadata["sourceFingerprint"].as_str())
            .unwrap_or("")
            .to_owned(),
        js::number(stop_count),
        street_identity.to_owned(),
        js::number(maximum_walk_m),
        maximum_neighbors.to_string(),
    ]
    .join("|");
    let base = Js::object()
        .with("ready", true)
        .with("built", false)
        .with("schemaVersion", policy::OSM_TRANSFER_SCHEMA)
        .with("fingerprint", fingerprint.as_str());
    {
        let db = rusqlite::Connection::open_with_flags(
            routing,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        let retained_edges: f64 = db.query_row(
            "SELECT COUNT(*) FROM transfer_provenance WHERE provenance='osm_certified_radial'",
            [],
            |r| r.get(0),
        )?;
        let graph = &store.metadata["osmStopTransferGraph"];
        if graph["fingerprint"] == fingerprint.as_str()
            && graph["edgeCount"].as_f64() == Some(retained_edges)
        {
            let mut result = base
                .with("edgeCount", retained_edges)
                .with("maximumWalkM", maximum_walk_m)
                .with("maximumNeighbors", maximum_neighbors)
                .with("walkingPolicy", policy::POLICY.object.clone())
                .with("stopAccessRoles", roles);
            if roles_built {
                result.set(
                    "derivedArtifacts",
                    raw::refresh_topology(routing, &progress)?,
                );
            }
            return Ok(result);
        }
    }
    progress.emit(
        "Building pedestrian stop transfers",
        0.05,
        &format!("{} stops", js::grouped(stop_count as i64)),
    );
    let mut store = store;
    let profile = store.access_profile("stop-transfer-v3", street_identity)?;
    let members = profile.members.clone();
    let profile_key = profile.key.clone();
    kernel.set_access_profile(profile.input)?;
    let built = kernel.build_stop_transfer_graph(crate::StopTransferGraphInput {
        maximum_walk_m,
        maximum_neighbors,
    })?;
    let native = Js::object()
        .with("kernel", "rust_node_api_stop_transfer_graph_v1")
        .with("profileKey", profile_key.as_str())
        .with("edgeCount", built.from_member_indices.len())
        .with("sourceSearches", built.source_searches)
        .with("candidatePairs", built.candidate_pairs)
        .with("settledNodes", built.settled_nodes)
        .with("relaxedEdges", built.relaxed_edges)
        .with("buildMs", (built.build_ns / 1e6 * 1e3).round() / 1e3);
    let mut pairs: Vec<(String, String, f64)> = vec![];
    let mut pair_index: HashMap<(String, String), usize> = HashMap::new();
    for i in 0..built.from_member_indices.len() {
        let (Some(&from), Some(&to)) = (
            members.get(built.from_member_indices[i] as usize),
            members.get(built.to_member_indices[i] as usize),
        ) else {
            continue;
        };
        let (from, to) = (&store.stops[from], &store.stops[to]);
        let distance = built.distances_m[i];
        let shared_parent = from.parent().is_some_and(|p| Some(p) == to.parent());
        if from.id == to.id
            || !distance.is_finite()
            || distance < 0.0
            || distance > maximum_walk_m + 0.1
            || shared_parent
        {
            continue;
        }
        let key = (from.id.clone(), to.id.clone());
        match pair_index.get(&key) {
            Some(&existing) => {
                if distance < pairs[existing].2 {
                    pairs[existing].2 = distance;
                }
            }
            None => {
                pair_index.insert(key, pairs.len());
                pairs.push((from.id.clone(), to.id.clone(), distance));
            }
        }
    }
    let previous_generation = match field(&metadata_record(routing)?, "transferGeneration") {
        Some(value @ Js::Object(_)) => value,
        _ => Js::object(),
    };
    drop(store);
    let mut db = rusqlite::Connection::open(routing)?;
    db.busy_timeout(std::time::Duration::from_millis(5_000))?;
    let transaction = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    transaction.execute_batch(
        "DELETE FROM transfers
        WHERE EXISTS(
          SELECT 1 FROM transfer_provenance AS provenance
          WHERE provenance.from_stop_id=transfers.from_stop_id
            AND provenance.to_stop_id=transfers.to_stop_id
            AND provenance.provenance='osm_certified_radial'
        );
        DELETE FROM transfer_provenance WHERE provenance='osm_certified_radial';",
    )?;
    let mut inserted = 0usize;
    {
        let mut insert_transfer = transaction.prepare(
            "INSERT OR IGNORE INTO transfers(from_stop_id, to_stop_id, transfer_type, min_transfer_time) VALUES(?, ?, 2, ?)",
        )?;
        let mut insert_provenance = transaction.prepare(
            "INSERT INTO transfer_provenance(from_stop_id, to_stop_id, provenance, evidence_fingerprint, path_distance_m) VALUES(?, ?, 'osm_certified_radial', ?, ?)",
        )?;
        for (from, to, distance) in &pairs {
            let seconds = (distance / 1000.0 / policy::OSM_TRANSFER_LOWER_BOUND_KPH * 3600.0)
                .ceil()
                .max(1.0);
            if insert_transfer.execute(rusqlite::params![from, to, seconds])? != 1 {
                continue;
            }
            insert_provenance.execute(rusqlite::params![from, to, fingerprint, distance])?;
            inserted += 1;
        }
    }
    let transfer_count: f64 =
        transaction.query_row("SELECT COUNT(*) FROM transfers", [], |r| r.get(0))?;
    let graph = Js::object()
        .with("schemaVersion", policy::OSM_TRANSFER_SCHEMA)
        .with("fingerprint", fingerprint.as_str())
        .with("streetIdentity", street_identity)
        .with("maximumWalkM", maximum_walk_m)
        .with("maximumNeighbors", maximum_neighbors)
        .with("candidateEdgeCount", pairs.len())
        .with("edgeCount", inserted)
        .with("builtAt", iso_now());
    let generation = previous_generation
        .with(
            "strategy",
            "source-plus-osm-certified-directed-stop-frontier",
        )
        .with("exact", true)
        .with("osmCertifiedTransferCount", inserted)
        .with("osmMaximumWalkM", maximum_walk_m)
        .with("osmMaximumNeighbors", maximum_neighbors);
    {
        let mut set = transaction.prepare(
            "INSERT INTO metadata(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )?;
        set.execute(["transferCount", &js::number(transfer_count)])?;
        set.execute(["osmStopTransferGraph", &graph.stringify()])?;
        set.execute(["transferGeneration", &generation.stringify()])?;
    }
    transaction.commit()?;
    db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA optimize;")?;
    drop(db);
    progress.emit(
        "Refreshing transfer-aware topology",
        0.75,
        &format!("{} directed stop transfers", js::grouped(inserted as i64)),
    );
    let derived = raw::refresh_topology(routing, &progress)?;
    Ok(base
        .with("built", true)
        .with("edgeCount", inserted)
        .with("candidateEdgeCount", pairs.len())
        .with("maximumWalkM", maximum_walk_m)
        .with("maximumNeighbors", maximum_neighbors)
        .with("walkingPolicy", policy::POLICY.object.clone())
        .with("stopAccessRoles", roles)
        .with("native", native)
        .with("derivedArtifacts", derived))
}
