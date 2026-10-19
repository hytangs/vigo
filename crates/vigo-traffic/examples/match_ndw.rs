//! Reproducible offline road-match inspection. Inputs remain outside the repo.
//! Use the engine's actual prepared drive CSR, never a substitute OSM adapter.
use serde_json::json;
use std::{fs::File, io::BufReader, path::Path, time::Instant};
use vigo_traffic::{Graph, Matcher, ndw::Configuration};
fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.len() != 4 {
        return Err("usage: match_ndw DRIVE.bin CONFIG.xml MEASUREMENTS.xml RFC3339_CLOCK".into());
    }
    let image = vigo_format::Snapshot::open(Path::new(&args[0]), false)?;
    let lons = image.f64("nodeLons")?;
    let lats = image.f64("nodeLats")?;
    let offsets = image.u32("edgeOffsets")?;
    let targets = image.u32("edgeTargets")?;
    let distances = image.u32("edgeDistanceUnits")?;
    let times = image.u32("edgeTimeUnits")?;
    let graph = Graph {
        lons: &lons,
        lats: &lats,
        offsets: &offsets,
        targets: &targets,
        distances: &distances,
        times: &times,
    };
    let config = Configuration::read(BufReader::new(File::open(&args[1])?))?;
    let batch = config.ingest(
        BufReader::new(File::open(&args[2])?),
        vigo_traffic::timestamp(&json!(args[3]))?,
        300,
    )?;
    let west = lons.iter().copied().fold(f64::INFINITY, f64::min);
    let east = lons.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let south = lats.iter().copied().fold(f64::INFINITY, f64::min);
    let north = lats.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let observations = batch
        .observations
        .iter()
        .filter(|o| {
            o["coordinates"].as_array().unwrap().iter().all(|p| {
                let x = p[0].as_f64().unwrap();
                let y = p[1].as_f64().unwrap();
                x >= west && x <= east && y >= south && y <= north
            })
        })
        .collect::<Vec<_>>();
    let mut matcher = Matcher::default();
    let mut results = vec![];
    let start = Instant::now();
    for observation in &observations {
        let points = serde_json::from_value::<Vec<[f64; 2]>>(observation["coordinates"].clone())?;
        let started = Instant::now();
        let result = matcher.match_path(graph, &points, 120.);
        let mut row = json!({"site":observation["sourceRecord"],"coordinates":points,"matchingMs":started.elapsed().as_secs_f64()*1000.});
        match result {
            Ok(edges) => {
                let sources = edges
                    .iter()
                    .map(|&e| offsets.partition_point(|&o| o <= e) - 1)
                    .collect::<Vec<_>>();
                // Each output pair is a real directed CSR edge for independent OSM audit.
                row["edges"]=json!(edges.iter().zip(&sources).map(|(&e,&s)|{
                    let t=targets[e as usize] as usize;json!({"edge":e,"from":[lons[s],lats[s]],"to":[lons[t],lats[t]],"distanceM":distances[e as usize] as f64/100.})
                }).collect::<Vec<_>>());
            }
            Err(reason) => row["rejected"] = json!(reason),
        }
        results.push(row);
    }
    let cold_ms = start.elapsed().as_secs_f64() * 1000.;
    let start = Instant::now();
    for observation in &observations {
        let p = serde_json::from_value::<Vec<[f64; 2]>>(observation["coordinates"].clone())?;
        let _ = matcher.match_path(graph, &p, 120.);
    }
    println!(
        "{}",
        json!({"nodes":lons.len(),"edges":targets.len(),"bounds":[west,south,east,north],"clock":args[3],
        "providerObservations":batch.observations.len(),"localObservations":observations.len(),
        "matched":results.iter().filter(|v|v.get("edges").is_some()).count(),"coldMs":cold_ms,"warmMs":start.elapsed().as_secs_f64()*1000.,"results":results})
    );
    Ok(())
}
