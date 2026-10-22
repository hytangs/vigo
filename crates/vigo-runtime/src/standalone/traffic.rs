use super::{City, Result};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs::File,
    io::{BufRead, BufReader, Read},
    time::{Instant, SystemTime, UNIX_EPOCH},
};
fn xml(path: &str) -> Result<Box<dyn BufRead>> {
    let mut file = BufReader::new(File::open(path)?);
    let gzip = file.fill_buf()?.starts_with(&[0x1f, 0x8b]);
    let input: Box<dyn Read> = if gzip {
        Box::new(flate2::read::MultiGzDecoder::new(file))
    } else {
        Box::new(file)
    };
    Ok(Box::new(BufReader::new(input.take(256 * 1024 * 1024 + 1))))
}
pub fn import(city_path: &str, options: &HashMap<String, String>) -> Result<Value> {
    let configuration = options
        .get("configuration")
        .ok_or("--configuration is required")?;
    let measurements = options
        .get("measurements")
        .ok_or("--measurements is required")?;
    let ttl: u32 = options.get("ttl-seconds").map_or(Ok(300), |s| s.parse())?;
    let started = Instant::now();
    let mut config = vigo_traffic::ndw::Configuration::read(xml(configuration)?)
        .map_err(std::io::Error::other)?;
    let config_ms = started.elapsed().as_secs_f64() * 1000.;
    let mut city = City::open(city_path)?;
    city.load_drive()?;
    let drive = city.drive.as_mut().unwrap();
    let (lons, lats) = drive.kernel.coordinates();
    config
        .retain_near(lons, lats, 120.)
        .map_err(std::io::Error::other)?;
    let city_ms = started.elapsed().as_secs_f64() * 1000. - config_ms;
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis() as i64;
    let batch = config
        .ingest(xml(measurements)?, now, ttl)
        .map_err(std::io::Error::other)?;
    let parse_ms = started.elapsed().as_secs_f64() * 1000. - config_ms - city_ms;
    let fingerprint = drive.image.header["identity"]["sourceFingerprint"]
        .as_str()
        .ok_or("Missing street fingerprint")?;
    let matching = Instant::now();
    let snapshot = drive
        .kernel
        .compile_traffic(&batch.snapshot(fingerprint), fingerprint)?;
    let mut prepared = snapshot.prepared();
    prepared["ingestion"] = json!({"provider":"ndw-datex2-v3-avg","configuredSites":config.site_count(),"outOfCitySites":config.excluded_site_count(),
        "configurationRejected":config.rejected,"measurementsRejected":batch.rejected,
        "publicationTime":batch.publication_time,"acceptedMeasurements":batch.observations.len(),
        "traffic":snapshot.admit(now).map_err(std::io::Error::other)?,
        "timingsMs":{"configuration":config_ms,"cityAndSelection":city_ms,"measurements":parse_ms,"matching":matching.elapsed().as_secs_f64()*1000.,"total":started.elapsed().as_secs_f64()*1000.}});
    // Diagnostics never duplicate the potentially large prepared edge arrays.
    prepared["ingestion"]["traffic"]
        .as_object_mut()
        .unwrap()
        .remove("nativeInput");
    Ok(prepared)
}
