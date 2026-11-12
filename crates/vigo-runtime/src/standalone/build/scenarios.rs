//! `vigo build-scenarios`: a portable collection of Cities that share one
//! prepared street network.
use super::{
    Arguments, Options, Result, SCENARIO_CITY, absolute, compile, file_digest, link_street_base,
    options, publish, relative_path, signals,
};
use crate::standalone::fail;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use vigo_format::js::{self, Js};

const TERMINAL_ACCESS_ARTIFACT: &str = "street-index.sqlite.terminal-access-v1.json";

pub(crate) const HELP: &str = "VIGO build-scenarios · prepare a portable scenario collection with one shared street network

Usage:
  vigo build-scenarios --spec scenarios.source.json --output ./scenario-set

Options:
  --spec PATH                 Scenario source manifest JSON
  --output PATH               Collection output directory
  --wheelchair                Prepare a strict wheelchair collection
  --wheelchair-streets MODE   Wheelchair street evidence: inferred (step-free unless mapped otherwise) or verified (wheelchair=yes only)
  --help                      Show help for this command

Queries use the standalone Rust runtime with scenarioId. Street data is prepared once.
Source paths are relative to the spec. Input SHA-256 values, if supplied, must match.
Use --wheelchair or wheelchair: true in the spec for a strict wheelchair collection.
";

/// `String(value)` for a parsed JSON value; `None` is `undefined`.
fn js_text(value: Option<&Js>) -> String {
    match value {
        None => "undefined".into(),
        Some(Js::Null) => "null".into(),
        Some(Js::Bool(b)) => b.to_string(),
        Some(Js::Number(n)) => super::policy::js_string(*n),
        Some(Js::String(s)) => s.clone(),
        Some(Js::Array(items)) => items
            .iter()
            .map(|item| match item {
                Js::Null => String::new(),
                other => js_text(Some(other)),
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Js::Object(_)) => "[object Object]".into(),
    }
}

/// `value ?? fallback`: null and absent members use the fallback.
fn present(value: Option<&Js>) -> Option<&Js> {
    value.filter(|v| !matches!(v, Js::Null))
}

fn truthy(value: Option<&Js>) -> bool {
    match value {
        None | Some(Js::Null) => false,
        Some(Js::Bool(b)) => *b,
        Some(Js::Number(n)) => *n != 0.0 && !n.is_nan(),
        Some(Js::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// `readJsonObject(path, label)`.
fn read_json_object(path: &Path, label: &str) -> Result<Js> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return fail(format!("{label} file not found: {}", path.display()));
        }
        Err(error) => return Err(error.into()),
    };
    if !metadata.is_file() {
        return fail(format!("{label} must be a file: {}", path.display()));
    }
    let text = String::from_utf8_lossy(&fs::read(path)?).into_owned();
    let Ok(parsed) = Js::parse(text.strip_prefix('\u{feff}').unwrap_or(&text)) else {
        return fail(format!(
            "{label} is not valid JSON ({}). Provide one JSON object.",
            path.display()
        ));
    };
    if !matches!(parsed, Js::Object(_)) {
        return fail(format!(
            "{label} must be one JSON object ({})",
            path.display()
        ));
    }
    Ok(parsed)
}

struct Input {
    path: PathBuf,
    sha256: String,
}

/// A source named by the spec, relative to the spec's directory.
fn resolve_input(base: &Path, input: Option<&Js>, label: &str) -> Result<Input> {
    let Some(relative) = input.and_then(|i| i.get("path")).and_then(Js::as_str) else {
        return fail(format!("{label} requires a path."));
    };
    let path = absolute(&base.join(relative).to_string_lossy())?;
    let sha256 = file_digest(&path)?;
    let expected = input.and_then(|i| i.get("sha256"));
    if truthy(expected) && expected != Some(&Js::String(sha256.clone())) {
        return fail(format!("{label} SHA-256 mismatch."));
    }
    Ok(Input { path, sha256 })
}

/// `normalizeServiceDate(date) === date` for a prepared date.
fn prepared_date(date: &Js) -> Result<bool> {
    let Js::String(text) = date else {
        return Ok(false);
    };
    let trimmed = text.trim();
    let digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    let bytes = trimmed.as_bytes();
    if trimmed.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && digits(&trimmed[..4])
        && digits(&trimmed[5..7])
        && digits(&trimmed[8..])
    {
        return Ok(trimmed == text);
    }
    if trimmed.is_empty() || (trimmed.len() == 8 && digits(trimmed)) {
        return Ok(false);
    }
    fail(format!("Invalid --service-date value: {text}"))
}

struct Scenario {
    id: Js,
    key: String,
    name: Js,
    feeds: Vec<(Input, String)>,
}

pub(crate) fn run(arguments: &Arguments) -> Result<()> {
    let Some(spec) = arguments.value("spec") else {
        return fail("build-scenarios requires --spec");
    };
    let spec_path = absolute(spec)?;
    let spec = read_json_object(&spec_path, "Scenario specification")?;
    let Some(output) = arguments.value("output").filter(|v| !v.trim().is_empty()) else {
        return fail("build-scenarios requires --output");
    };
    let output = absolute(output)?;
    if output.parent().is_none() {
        return fail("Scenario collection output cannot be a filesystem root");
    }
    publish::recover(&output)?;
    if output.exists() {
        return fail("Scenario collection already exists; build to a new directory.");
    }
    let listed = match spec.get("scenarios") {
        Some(Js::Array(items)) if (1..=128).contains(&items.len()) => items.clone(),
        _ => vec![],
    };
    if spec.get("schemaVersion").and_then(Js::as_str) != Some("vigo.scenarios.source.v1")
        || listed.is_empty()
    {
        return fail("Expected vigo.scenarios.source.v1 with 1 to 128 scenarios.");
    }
    let declared = spec.get("wheelchair");
    if declared.is_some() && !matches!(declared, Some(Js::Bool(_))) {
        return fail("wheelchair must be boolean");
    }
    let wheelchair = if arguments.has("wheelchair") {
        arguments.enabled("wheelchair")
    } else {
        declared == Some(&Js::Bool(true))
    };
    if arguments.has("wheelchair") && declared.is_some() && declared != Some(&Js::Bool(wheelchair))
    {
        return fail("--wheelchair conflicts with wheelchair in the scenario specification");
    }
    let base = spec_path.parent().unwrap_or(Path::new("/")).to_path_buf();
    let osm = resolve_input(&base, spec.get("osm"), "OSM")?;
    let street_modes = js_text(Some(
        present(spec.get("streetModes")).unwrap_or(&Js::from("walk")),
    ));
    if !super::STREET_MODES.contains(&street_modes.as_str()) {
        return fail("streetModes must be walk, walk,drive, walk,bike, or walk,drive,bike");
    }
    if wheelchair && street_modes != "walk" {
        return fail("Wheelchair collections require streetModes walk");
    }
    let private_access = present(spec.get("privateAccess"))
        .cloned()
        .unwrap_or(Js::from("public"));
    let private_access = match private_access {
        Js::String(value) if value == "public" || value == "endpoints" => value,
        _ => return fail("privateAccess must be public or endpoints"),
    };
    if wheelchair && private_access != "public" {
        return fail("Wheelchair collections require public privateAccess");
    }
    let maximum_resident = present(spec.get("maximumResidentScenarios"))
        .cloned()
        .unwrap_or(Js::Number(2.0));
    if !matches!(maximum_resident, Js::Number(n) if n.fract() == 0.0 && (1.0..=16.0).contains(&n)) {
        return fail("maximumResidentScenarios must be between 1 and 16");
    }
    let prepare_dates = match present(spec.get("prepareDates")) {
        None => vec![],
        Some(Js::Array(dates)) if dates.len() <= 32 => {
            for date in dates {
                if !prepared_date(date)? {
                    return fail("prepareDates must contain up to 32 ISO service dates");
                }
            }
            dates.iter().map(|d| js_text(Some(d))).collect()
        }
        Some(_) => return fail("prepareDates must contain up to 32 ISO service dates"),
    };
    let wheelchair_streets = arguments
        .value("wheelchair-streets")
        .unwrap_or("inferred")
        .to_owned();
    if !["inferred", "verified"].contains(&wheelchair_streets.as_str()) {
        return fail("--wheelchair-streets must be inferred or verified");
    }
    // Validate every source before doing expensive preparation.
    let mut seen: Vec<Js> = vec![];
    let mut scenarios = vec![];
    for item in &listed {
        let id = item.get("id").cloned();
        let key = js_text(id.as_ref());
        let valid = !key.is_empty()
            && key.len() <= 64
            && key
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
        let id = id.unwrap_or(Js::Null);
        if !valid || seen.contains(&id) {
            return fail("Scenario IDs must be unique letters, digits, hyphens or underscores.");
        }
        seen.push(id.clone());
        let feeds = match item.get("feeds") {
            Some(Js::Array(feeds)) if !feeds.is_empty() => feeds,
            _ => return fail(format!("Scenario {key} needs feeds.")),
        };
        let mut inputs = vec![];
        for feed in feeds {
            let input = resolve_input(&base, Some(feed), &format!("{key} GTFS"))?;
            inputs.push((input, js_text(feed.get("scope"))));
        }
        scenarios.push(Scenario {
            name: present(item.get("name"))
                .cloned()
                .unwrap_or_else(|| id.clone()),
            id,
            key,
            feeds: inputs,
        });
    }
    let default_scenario = match present(spec.get("defaultScenario")) {
        Some(value) => js_text(Some(value)),
        None => js_text(Some(&scenarios[0].id)),
    };
    if !seen.contains(&Js::String(default_scenario.clone())) {
        return fail("Unknown defaultScenario.");
    }

    let staged = publish::staging_path(&output);
    // Register before the directory exists: a signal may arrive at any time.
    let _guard = signals::remove_on_termination(&staged);
    publish::create_staging_directory(&output, &staged)?;
    let result = (|| -> Result<Js> {
        fs::create_dir(staged.join("cities"))?;
        let mut first_city: Option<PathBuf> = None;
        for scenario in &scenarios {
            let city_path = staged.join("cities").join(&scenario.key);
            let options = scenario_options(
                scenario,
                &osm,
                &street_modes,
                wheelchair,
                &wheelchair_streets,
                &private_access,
                &prepare_dates,
                first_city.as_deref(),
                &city_path,
            )?;
            let compiler_stage = publish::staging_path(&city_path);
            publish::create_staging_directory(&city_path, &compiler_stage)?;
            compile(&options, &compiler_stage)?;
            // The whole collection is flushed once, before it is published.
            publish::publish(&compiler_stage, &city_path, false, false)?;
            if first_city.is_none() {
                share_streets(&staged, &city_path, &osm.sha256, &private_access)?;
                first_city = Some(city_path);
            }
        }
        let name = present(spec.get("name")).cloned().unwrap_or_else(|| {
            Js::from(
                output
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default(),
            )
        });
        let members: Vec<Js> = scenarios
            .iter()
            .map(|s| {
                Js::object()
                    .with("id", s.id.clone())
                    .with("name", s.name.clone())
                    .with("city", format!("cities/{}", s.key))
            })
            .collect();
        let manifest = Js::object()
            .with("schemaVersion", "vigo.scenarios.v1")
            .with("name", name)
            .with("defaultScenario", default_scenario.as_str())
            .with("maximumResidentScenarios", maximum_resident.clone())
            .with("scenarios", members);
        fs::write(
            staged.join("scenarios.json"),
            manifest.stringify_pretty(2) + "\n",
        )?;
        let mut files = vec![];
        let mut physical: HashMap<(u64, u64), (u64, String)> = HashMap::new();
        let mut order: Vec<(u64, u64)> = vec![];
        inventory(&staged, &staged, &mut files, &mut physical, &mut order)?;
        let checksums = Js::object()
            .with("schemaVersion", "vigo.checksums.v1")
            .with("algorithm", "sha256")
            .with("files", files);
        fs::write(
            staged.join("checksums.json"),
            checksums.stringify_pretty(2) + "\n",
        )?;
        publish::sync_directory_tree(&staged)?;
        fs::rename(&staged, &output)?;
        publish::sync_directory(output.parent().unwrap_or(Path::new(".")))?;
        let storage_bytes: u64 = order.iter().map(|key| physical[key].0).sum();
        let mut summary = manifest;
        summary
            .set("storageBytes", storage_bytes as f64)
            .set("sharedStreetCopies", 1);
        Ok(summary)
    })();
    if staged.exists() {
        let _ = fs::remove_dir_all(&staged);
    }
    let summary = result?;
    println!("{}", summary.stringify_pretty(2));
    Ok(())
}

/// The options one member City is compiled with, validated as `vigo build`
/// validates its own.
#[allow(clippy::too_many_arguments)]
fn scenario_options(
    scenario: &Scenario,
    osm: &Input,
    street_modes: &str,
    wheelchair: bool,
    wheelchair_streets: &str,
    private_access: &str,
    prepare_dates: &[String],
    streets_from: Option<&Path>,
    city_path: &Path,
) -> Result<Options> {
    let mut argv = vec![];
    argv.extend(
        scenario
            .feeds
            .iter()
            .map(|(input, _)| format!("--gtfs={}", input.path.display())),
    );
    argv.extend(
        scenario
            .feeds
            .iter()
            .map(|(_, scope)| format!("--gtfs-scope={scope}")),
    );
    argv.extend(
        prepare_dates
            .iter()
            .map(|date| format!("--prepare-date={date}")),
    );
    argv.extend([
        format!("--osm={}", osm.path.display()),
        format!("--street-modes={street_modes}"),
        format!("--wheelchair={wheelchair}"),
        format!("--wheelchair-streets={wheelchair_streets}"),
        format!("--flex-driving={wheelchair}"),
        format!("--private-access={private_access}"),
    ]);
    if let Some(first) = streets_from {
        argv.push(format!("--streets-from={}", first.display()));
    }
    argv.push(format!("--output={}", city_path.display()));
    argv.push(format!("--city-name={}", js_text(Some(&scenario.name))));
    let arguments = Arguments::parse(SCENARIO_CITY, argv)?;
    options(SCENARIO_CITY, &arguments)
}

/// Move the first City's streets to `streets/<osm sha256>` and point it there.
/// Public Cities link the whole directory; with endpoint access each City
/// keeps its own boundary overlay beside links to the shared base.
fn share_streets(
    staged: &Path,
    city_path: &Path,
    osm_sha256: &str,
    private_access: &str,
) -> Result<()> {
    let shared = staged.join("streets").join(osm_sha256);
    let local = city_path.join("osm");
    fs::create_dir(staged.join("streets"))?;
    if private_access == "public" {
        fs::rename(&local, &shared)?;
        let target = relative_path(city_path, &shared);
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, &local)?;
        #[cfg(windows)]
        std::os::windows::fs::symlink_dir(target, &local)?;
    } else {
        fs::create_dir(&shared)?;
        for entry in fs::read_dir(&local)? {
            let name = entry?.file_name();
            if name.to_string_lossy() != TERMINAL_ACCESS_ARTIFACT {
                fs::rename(local.join(&name), shared.join(&name))?;
            }
        }
        link_street_base(&shared, &local)?;
    }
    Ok(())
}

/// Every regular file below `root`, in `localeCompare` order per directory.
/// Links to shared streets are skipped; hard links are hashed once.
fn inventory(
    root: &Path,
    directory: &Path,
    files: &mut Vec<Js>,
    physical: &mut HashMap<(u64, u64), (u64, String)>,
    order: &mut Vec<(u64, u64)>,
) -> Result<()> {
    let mut entries = fs::read_dir(directory)?.collect::<std::io::Result<Vec<_>>>()?;
    entries.sort_by(|a, b| {
        js::locale_compare(
            &a.file_name().to_string_lossy(),
            &b.file_name().to_string_lossy(),
        )
    });
    for entry in entries {
        let kind = entry.file_type()?;
        let path = entry.path();
        if kind.is_symlink() {
            continue;
        }
        if kind.is_dir() {
            inventory(root, &path, files, physical, order)?;
            continue;
        }
        let key = file_identity(&path)?;
        if let std::collections::hash_map::Entry::Vacant(slot) = physical.entry(key) {
            let bytes = fs::metadata(&path)?.len();
            slot.insert((bytes, file_digest(&path)?));
            order.push(key);
        }
        let (bytes, sha256) = &physical[&key];
        let relative = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join("/");
        files.push(
            Js::object()
                .with("path", relative)
                .with("bytes", *bytes as f64)
                .with("sha256", sha256.as_str()),
        );
    }
    Ok(())
}

#[cfg(unix)]
fn file_identity(path: &Path) -> Result<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    let metadata = fs::metadata(path)?;
    Ok((metadata.dev(), metadata.ino()))
}

#[cfg(not(unix))]
fn file_identity(path: &Path) -> Result<(u64, u64)> {
    // Without inode numbers every path is its own file.
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut hasher);
    Ok((0, hasher.finish()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn javascript_string_conversion() {
        assert_eq!(js_text(None), "undefined");
        assert_eq!(js_text(Some(&Js::Number(5.0))), "5");
        assert_eq!(
            js_text(Some(&Js::Array(vec![
                Js::from("a"),
                Js::Null,
                Js::from(1.5)
            ]))),
            "a,,1.5"
        );
    }

    #[test]
    fn prepared_dates_follow_service_date_rules() {
        assert!(prepared_date(&Js::from("2026-01-05")).unwrap());
        assert!(!prepared_date(&Js::from("20260105")).unwrap());
        assert!(!prepared_date(&Js::from(" 2026-01-05")).unwrap());
        assert!(!prepared_date(&Js::Number(1.0)).unwrap());
        assert!(
            prepared_date(&Js::from("2026/01/05"))
                .unwrap_err()
                .to_string()
                .contains("Invalid --service-date value")
        );
    }
}
