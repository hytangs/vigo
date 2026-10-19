//! Inspect a retained public NDW pair at an explicit historical clock.
use std::{fs::File, io::BufReader, time::Instant};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.len() != 3 {
        return Err("usage: inspect_ndw CONFIG.xml MEASUREMENTS.xml RFC3339_CLOCK".into());
    }
    let now = vigo_traffic::timestamp(&serde_json::json!(args[2]))?;
    let start = Instant::now();
    let config = vigo_traffic::ndw::Configuration::read(BufReader::new(File::open(&args[0])?))?;
    let config_ms = start.elapsed().as_secs_f64() * 1000.;
    let batch = config.ingest(BufReader::new(File::open(&args[1])?), now, 300)?;
    println!(
        "{}",
        serde_json::json!({"sites":config.site_count(),"configurationRejected":config.rejected,"observations":batch.observations.len(),"measurementsRejected":batch.rejected,"configurationMs":config_ms,"measurementsMs":start.elapsed().as_secs_f64()*1000.-config_ms})
    );
    Ok(())
}
