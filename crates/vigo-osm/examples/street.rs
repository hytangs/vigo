//! Compile a street store as the City build does, without native CCH.
//!   street <pbf> <output.sqlite> [walk|walk,drive|walk,bike|walk,drive,bike] [wheelchair=inferred|verified] [studio]
use std::path::Path;
use vigo_osm::{StreetOptions, WheelchairStreets};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (pbf, output) = (Path::new(&args[1]), Path::new(&args[2]));
    let modes = args.get(3).map_or("walk,drive", String::as_str);
    let wheelchair = args.iter().find_map(|a| a.strip_prefix("wheelchair="));
    let studio = args.iter().any(|a| a == "studio");
    let options = if modes.ends_with(".json") {
        let json: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(modes).unwrap()).unwrap();
        let flag = |key: &str, default: bool| {
            json.get(key)
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(default)
        };
        StreetOptions {
            include_driving: flag("includeDriving", true),
            include_biking: flag("includeBiking", false),
            flex_driving: flag("flexDriving", false),
            wheelchair: flag("wheelchair", false),
            wheelchair_streets: WheelchairStreets::parse(
                json.get("wheelchairStreets")
                    .and_then(|v| v.as_str())
                    .unwrap_or("inferred"),
            )
            .unwrap(),
            build_driving_profile: flag("buildDrivingProfile", false),
        }
    } else {
        StreetOptions {
            include_driving: modes.split(',').any(|m| m == "drive"),
            include_biking: modes.split(',').any(|m| m == "bike"),
            flex_driving: false,
            wheelchair: wheelchair.is_some(),
            wheelchair_streets: WheelchairStreets::parse(wheelchair.unwrap_or("inferred")).unwrap(),
            build_driving_profile: studio,
        }
    };
    let studio = options.build_driving_profile;
    let started = std::time::Instant::now();
    let mut previous = (
        String::new(),
        std::time::Instant::now() - std::time::Duration::from_secs(60),
    );
    let mut report = |event: &vigo_osm::Progress| {
        if event.phase == previous.0
            && event.progress < 1.0
            && previous.1.elapsed().as_secs_f64() < 10.0
        {
            return;
        }
        previous = (event.phase.to_owned(), std::time::Instant::now());
        let detail = event.detail.trim();
        eprintln!(
            "[osm] {}{}",
            event.phase,
            if detail.is_empty() {
                String::new()
            } else {
                format!(": {detail}")
            }
        );
    };
    let built = match vigo_osm::build_street_store(pbf, output, &options, &mut report) {
        Ok(result) => result,
        Err(error) => {
            println!("build error: {error}");
            std::process::exit(0);
        }
    };
    let build_s = started.elapsed().as_secs_f64();
    std::fs::copy(output, format!("{}.source.sqlite", output.display())).unwrap();
    let drive_started = std::time::Instant::now();
    let drive = if built
        .get("driveEdgeCount")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0)
        > 0.0
        && !studio
    {
        Some(vigo_osm::build_drive_store(output, true, None).unwrap())
    } else {
        None
    };
    let drive_s = drive_started.elapsed().as_secs_f64();
    let compact_started = std::time::Instant::now();
    let compacted = vigo_osm::compact_runtime_store(output, true, None);
    let compact_s = compact_started.elapsed().as_secs_f64();
    println!("{}", built.stringify());
    if let Some(drive) = drive {
        println!("{}", drive.stringify());
    }
    match compacted {
        Ok(compacted) => println!("{}", compacted.stringify()),
        Err(error) => println!("compaction error: {error}"),
    }
    eprintln!("timing build {build_s:.3}s drive {drive_s:.3}s compact {compact_s:.3}s");
}
