//! Drive the GTFS store compiler from a JSON request, for parity checks.
//!
//! `gtfs-store '{"mode":"city","feeds":[{"path":"a.zip","scope":"a"}],"output":"x.sqlite"}'`
//! Prints the result JSON on stdout and one JSON progress event per line on
//! stderr; failures print `{"error": message}` and exit 1.
use std::path::PathBuf;
use vigo_format::js::{Js, quote};
use vigo_gtfs::{BuildOptions, Feed, Progress, StoreSource};

fn main() {
    let request: serde_json::Value =
        serde_json::from_str(&std::env::args().nth(1).expect("request JSON")).expect("JSON");
    let text = |key: &str| {
        request
            .get(key)
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_owned()
    };
    let options = BuildOptions {
        wheelchair: request
            .get("wheelchair")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        wheelchair_streets: request
            .get("wheelchairStreets")
            .and_then(|v| v.as_str())
            .unwrap_or("inferred")
            .to_owned(),
    };
    let started = std::time::Instant::now();
    let mut progress = |event: &Progress| {
        eprintln!(
            "{{\"phase\":{},\"progress\":{},\"detail\":{},\"ms\":{}}}",
            quote(&event.phase),
            vigo_format::js::number(event.progress),
            quote(&event.detail),
            started.elapsed().as_millis()
        );
    };
    let output = PathBuf::from(text("output"));
    let feeds: Vec<Feed> = request
        .get("feeds")
        .and_then(|v| v.as_array())
        .map(|feeds| {
            feeds
                .iter()
                .map(|feed| Feed {
                    path: PathBuf::from(feed["path"].as_str().unwrap_or_default()),
                    scope: feed["scope"].as_str().unwrap_or_default().to_owned(),
                })
                .collect()
        })
        .unwrap_or_default();
    let result: vigo_gtfs::Result<Js> = match text("mode").as_str() {
        "city" => vigo_gtfs::build_city_store(&feeds, &output, &options, &mut progress),
        "store" => vigo_gtfs::build_store(
            &feeds[0].path,
            &output,
            &options,
            request
                .get("forCity")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            &mut progress,
        ),
        "merge" => vigo_gtfs::merge_stores(
            &feeds
                .iter()
                .map(|f| StoreSource {
                    scope: f.scope.clone(),
                    store_path: f.path.clone(),
                })
                .collect::<Vec<_>>(),
            &output,
            false,
            request
                .get("forCity")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            &mut progress,
        ),
        "compact" => vigo_gtfs::compact_runtime_store(&output),
        "roles" => vigo_gtfs::ensure_stop_access_roles(&output),
        "topology" => vigo_gtfs::build_static_topology_sidecar(
            &PathBuf::from(text("store")),
            &output,
            &mut progress,
            None,
            request
                .get("force")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
        ),
        "inspect" => {
            vigo_gtfs::inspect_static_topology_sidecar(&PathBuf::from(text("store")), Some(&output))
        }
        other => Err(vigo_gtfs::Error::new(format!("unknown mode {other}"))),
    };
    match result {
        Ok(value) => println!("{}", value.stringify()),
        Err(error) => {
            println!("{{\"error\":{}}}", quote(&error.to_string()));
            std::process::exit(1);
        }
    }
}
