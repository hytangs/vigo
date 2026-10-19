//! One optional NDW producer per server. Downloads, XML and road matching never
//! run in the query worker. Only complete graph-bound snapshots are published.
use super::{Result, fail};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader, Cursor, Read},
    path::Path,
    sync::{Arc, Mutex, mpsc},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use vigo_traffic::{Freshness, Graph, TrafficEngine, ndw::Configuration};

const WIRE_LIMIT: u64 = 16 * 1024 * 1024;
const XML_LIMIT: u64 = 256 * 1024 * 1024;
fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
fn interval() -> u64 {
    60
}
fn refresh() -> u64 {
    3600
}
fn ttl() -> u32 {
    300
}
fn timeout() -> u64 {
    20
}
fn config_url() -> String {
    "https://opendata.ndw.nu/reistijden_configuratie_meetlocaties.xml.gz".into()
}
fn data_url() -> String {
    "https://opendata.ndw.nu/reistijden_meetgegevens.xml.gz".into()
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Settings {
    #[serde(default = "config_url")]
    configuration_url: String,
    #[serde(default = "data_url")]
    measurements_url: String,
    #[serde(default = "interval")]
    interval_seconds: u64,
    #[serde(default = "refresh")]
    configuration_refresh_seconds: u64,
    #[serde(default = "ttl")]
    ttl_seconds: u32,
    #[serde(default = "timeout")]
    timeout_seconds: u64,
}
impl Settings {
    fn read(path: &str) -> Result<Self> {
        let bytes = fs::read(path)?;
        if bytes.len() > 16 * 1024 {
            return fail("NDW settings exceed 16 KiB");
        }
        let s: Self = serde_json::from_slice(&bytes)?;
        if !(1..=3600).contains(&s.interval_seconds)
            || !(60..=86400).contains(&s.configuration_refresh_seconds)
            || !(1..=1800).contains(&s.ttl_seconds)
            || !(1..=60).contains(&s.timeout_seconds)
        {
            return fail(
                "Invalid NDW interval (1..3600), configuration refresh (60..86400), TTL (1..1800) or timeout (1..60 seconds)",
            );
        }
        for url in [&s.configuration_url, &s.measurements_url] {
            let uri: ureq::http::Uri = url.parse()?;
            let local = uri
                .host()
                .is_some_and(|h| matches!(h, "127.0.0.1" | "[::1]" | "localhost"));
            if uri.authority().is_none_or(|a| a.as_str().contains('@'))
                || !(uri.scheme_str() == Some("https") || local && uri.scheme_str() == Some("http"))
            {
                return fail(
                    "NDW URLs require HTTPS (HTTP is allowed only on loopback), without credentials",
                );
            }
        }
        Ok(s)
    }
}
#[derive(Clone)]
pub(crate) struct Publication {
    pub generation: u64,
    pub snapshot: Arc<Value>,
}
pub(crate) struct Status {
    publication: Publication,
    freshness: Option<Freshness>,
    source_publication: Option<i64>,
    attempts: u64,
    failures: u32,
    last_attempt: Option<i64>,
    last_success: Option<i64>,
    next_attempt: Option<i64>,
    error: Option<String>,
    diagnostics: Value,
}
impl Status {
    fn new() -> Self {
        Self {
            publication: Publication {
                generation: 0,
                snapshot: Arc::new(Value::Null),
            },
            freshness: None,
            source_publication: None,
            attempts: 0,
            failures: 0,
            last_attempt: None,
            last_success: None,
            next_attempt: None,
            error: None,
            diagnostics: Value::Null,
        }
    }
    fn accept(
        &mut self,
        snapshot: &vigo_traffic::Snapshot,
        diagnostics: Value,
        publication_time: i64,
    ) -> Result<()> {
        // Publication order and observation freshness are different clocks.
        // A newer batch can legitimately contain an older, still-valid detector.
        if publication_time > now() + 60_000
            || self
                .source_publication
                .is_some_and(|old| publication_time < old)
        {
            return fail("Out-of-order or future NDW publication retained previous data");
        }
        let prepared = snapshot.prepared();
        if self.publication.snapshot.as_ref() != &prepared {
            self.publication = Publication {
                generation: self.publication.generation + 1,
                snapshot: Arc::new(prepared),
            };
        }
        self.freshness = Some(snapshot.freshness);
        self.source_publication = Some(publication_time);
        self.diagnostics = diagnostics;
        Ok(())
    }
    fn view(&self) -> Value {
        let clock = now();
        json!({"enabled":true,"provider":"ndw-datex2-v3-avg","generation":self.publication.generation,
            "status":match self.freshness.as_ref() { None=>"unavailable_fallback", Some(f) if f.stale(clock).unwrap_or(true)=>"stale_fallback", _=>"fresh" },
            "attempts":self.attempts,"consecutiveFailures":self.failures,"lastAttemptAtMs":self.last_attempt,
            "lastSuccessAtMs":self.last_success,"nextAttemptAtMs":self.next_attempt,"lastError":self.error,
            "publicationTimeMs":self.source_publication,"observedAtMs":self.freshness.as_ref().map(|f| f.observed_at),"expiresAtMs":self.freshness.as_ref().map(|f| f.expires_at),
            "ingestion":self.diagnostics})
    }
}
pub(crate) struct Poller {
    state: Arc<Mutex<Status>>,
    stop: mpsc::Sender<()>,
    thread: Option<thread::JoinHandle<()>>,
}
impl Drop for Poller {
    fn drop(&mut self) {
        let _ = self.stop.send(());
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
impl Poller {
    pub fn start(city: &str, options: &HashMap<String, String>) -> Result<Option<Self>> {
        let Some(path) = options.get("ndw-poll") else {
            return Ok(None);
        };
        if Path::new(city).join("scenarios.json").exists() {
            return fail("NDW polling currently requires a single City");
        }
        let settings = Settings::read(path)?;
        let graph = RoadGraph::open(city)?;
        let state = Arc::new(Mutex::new(Status::new()));
        let shared = state.clone();
        let (stop, stopped) = mpsc::channel();
        let thread = thread::Builder::new()
            .name("vigo-ndw".into())
            .spawn(move || {
                let mut producer = Producer::new(settings, graph);
                loop {
                    if stopped.try_recv().is_ok() {
                        break;
                    }
                    {
                        let mut state = shared.lock().unwrap();
                        state.attempts += 1;
                        state.last_attempt = Some(now());
                    }
                    let result = producer.poll();
                    let delay = {
                        let mut state = shared.lock().unwrap();
                        match result {
                            Ok((snapshot, diagnostics, publication_time)) => {
                                match state.accept(&snapshot, diagnostics, publication_time) {
                                    Ok(()) => {
                                        state.failures = 0;
                                        state.error = None;
                                        state.last_success = Some(now());
                                    }
                                    Err(error) => {
                                        state.failures = state.failures.saturating_add(1);
                                        state.error = Some(error.to_string());
                                    }
                                }
                            }
                            Err(error) => {
                                state.failures = state.failures.saturating_add(1);
                                state.error = Some(error.to_string().chars().take(256).collect());
                            }
                        }
                        let delay = producer
                            .settings
                            .interval_seconds
                            .saturating_mul(1u64 << state.failures.min(5))
                            .min(3600);
                        state.next_attempt = Some(now() + delay as i64 * 1000);
                        Duration::from_secs(delay)
                    };
                    if stopped.recv_timeout(delay) != Err(mpsc::RecvTimeoutError::Timeout) {
                        break;
                    }
                }
            })?;
        Ok(Some(Self {
            state,
            stop,
            thread: Some(thread),
        }))
    }
    pub fn publication(&self) -> Publication {
        self.state.lock().unwrap().publication.clone()
    }
    pub fn status(&self) -> Value {
        self.state.lock().unwrap().view()
    }
}
// A producer needs the immutable street CSR, not a second CCH routing kernel.
struct RoadGraph {
    lons: Vec<f64>,
    lats: Vec<f64>,
    offsets: Vec<u32>,
    targets: Vec<u32>,
    distances: Vec<u32>,
    times: Vec<u32>,
    fingerprint: String,
}
impl RoadGraph {
    fn open(city: &str) -> Result<Self> {
        let image = vigo_format::Snapshot::open(
            &Path::new(city).join("osm/street-index.sqlite.drive-accelerator-v2.bin"),
            false,
        )?;
        if image.header["magic"] != "vigo.drive.accelerator" || image.header["version"] != 2 {
            return fail("Unsupported drive snapshot");
        }
        let g = Self {
            lons: image.f64("nodeLons")?,
            lats: image.f64("nodeLats")?,
            offsets: image.u32("edgeOffsets")?,
            targets: image.u32("edgeTargets")?,
            distances: image.u32("edgeDistanceUnits")?,
            times: image.u32("edgeTimeUnits")?,
            fingerprint: image.header["identity"]["sourceFingerprint"]
                .as_str()
                .ok_or("Missing street fingerprint")?
                .into(),
        };
        if g.lons.len() != g.lats.len()
            || g.offsets.len() != g.lons.len() + 1
            || g.offsets.first() != Some(&0)
            || g.offsets.last().copied() != Some(g.targets.len() as u32)
            || g.targets.len() != g.distances.len()
            || g.targets.len() != g.times.len()
            || g.offsets.windows(2).any(|p| p[0] > p[1])
            || g.targets.iter().any(|&n| n as usize >= g.lons.len())
            || g.lons.iter().chain(&g.lats).any(|v| !v.is_finite())
        {
            return fail("Invalid traffic street graph");
        }
        Ok(g)
    }
    fn graph(&self) -> Graph<'_> {
        Graph {
            lons: &self.lons,
            lats: &self.lats,
            offsets: &self.offsets,
            targets: &self.targets,
            distances: &self.distances,
            times: &self.times,
        }
    }
}
fn xml(bytes: Vec<u8>) -> Box<dyn BufRead> {
    let compressed = bytes.starts_with(&[0x1f, 0x8b]);
    let raw: Box<dyn Read> = if compressed {
        Box::new(flate2::read::MultiGzDecoder::new(Cursor::new(bytes)))
    } else {
        Box::new(Cursor::new(bytes))
    };
    Box::new(BufReader::new(raw.take(XML_LIMIT + 1)))
}
struct Producer {
    settings: Settings,
    agent: ureq::Agent,
    graph: RoadGraph,
    engine: TrafficEngine,
    config: Option<Configuration>,
    config_at: Option<Instant>,
}
impl Producer {
    fn new(settings: Settings, graph: RoadGraph) -> Self {
        let agent = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(settings.timeout_seconds)))
            .max_redirects(0)
            .build()
            .new_agent();
        Self {
            settings,
            agent,
            graph,
            engine: TrafficEngine::default(),
            config: None,
            config_at: None,
        }
    }
    fn fetch(&self, url: &str) -> Result<Vec<u8>> {
        // Do not echo URLs, query strings, response bodies or proxy credentials into status.
        let mut response = self
            .agent
            .get(url)
            .header("Accept-Encoding", "identity")
            .call()
            .map_err(|_| "NDW HTTP request failed (transport, timeout or status)")?;
        if response.status().as_u16() != 200 {
            return fail("NDW endpoint did not return HTTP 200");
        }
        let mut bytes = Vec::new();
        response
            .body_mut()
            .as_reader()
            .take(WIRE_LIMIT + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "NDW download failed or timed out")?;
        if bytes.len() as u64 > WIRE_LIMIT {
            return fail("NDW download exceeds 16 MiB");
        }
        Ok(bytes)
    }
    fn refresh(&mut self) -> Result<()> {
        let mut config = Configuration::read(xml(self.fetch(&self.settings.configuration_url)?))
            .map_err(std::io::Error::other)?;
        config
            .retain_near(&self.graph.lons, &self.graph.lats, 120.)
            .map_err(std::io::Error::other)?;
        self.config = Some(config);
        self.config_at = Some(Instant::now());
        Ok(())
    }
    fn poll(&mut self) -> Result<(Arc<vigo_traffic::Snapshot>, Value, i64)> {
        let start = Instant::now();
        let refreshed = self
            .config_at
            .is_none_or(|t| t.elapsed().as_secs() >= self.settings.configuration_refresh_seconds);
        if refreshed {
            self.refresh()?;
        }
        let bytes = self.fetch(&self.settings.measurements_url)?;
        let mut batch = self.config.as_ref().unwrap().ingest(
            xml(bytes.clone()),
            now(),
            self.settings.ttl_seconds,
        );
        // Tables are downloaded independently; retry the join once with fresh metadata.
        if !refreshed
            && (batch.is_err()
                || batch
                    .as_ref()
                    .is_ok_and(|b| b.rejected.contains_key("site_version_mismatch")))
        {
            self.refresh()?;
            batch =
                self.config
                    .as_ref()
                    .unwrap()
                    .ingest(xml(bytes), now(), self.settings.ttl_seconds);
        }
        let batch = batch.map_err(std::io::Error::other)?;
        let parse_ms = start.elapsed().as_secs_f64() * 1000.;
        let snapshot = self
            .engine
            .compile(
                self.graph.graph(),
                &self.graph.fingerprint,
                &batch.snapshot(&self.graph.fingerprint),
            )
            .map_err(std::io::Error::other)?;
        let mut admission = snapshot.admission(now()).map_err(std::io::Error::other)?;
        admission.as_object_mut().unwrap().remove("nativeInput");
        admission.as_object_mut().unwrap().remove("cacheKey");
        let config = self.config.as_ref().unwrap();
        let diagnostics = json!({"configuredSites":config.site_count(),"outOfCitySites":config.excluded_site_count(),"configurationRejected":config.rejected,
            "acceptedMeasurements":batch.observations.len(),"measurementsRejected":batch.rejected,"traffic":admission,
            "timingsMs":{"downloadAndParse":parse_ms,"matching":start.elapsed().as_secs_f64()*1000.-parse_ms,"total":start.elapsed().as_secs_f64()*1000.}});
        Ok((
            snapshot,
            diagnostics,
            batch
                .publication_time
                .ok_or("Missing NDW publication time")?,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn snapshot(clock: i64) -> vigo_traffic::Snapshot {
        vigo_traffic::Snapshot {
            freshness: Freshness {
                observed_at: clock,
                expires_at: clock + 300_000,
            },
            fingerprint: "graph".into(),
            source: "NDW".into(),
            snapshot_id: None,
            weights: vigo_traffic::Weights {
                snapshot_key: "key".into(),
                edge_indices: vec![],
                edge_time_units: vec![],
            },
            observations: 0,
            matched_observations: 0,
            matched_edges: 0,
            rejected: Default::default(),
        }
    }
    #[test]
    fn publication_order_does_not_freshen_measurements_or_reinstall_identical_data() {
        let clock = now();
        let mut state = Status::new();
        state
            .accept(&snapshot(clock - 60_000), Value::Null, clock - 10_000)
            .unwrap();
        let generation = state.publication.generation;
        state
            .accept(&snapshot(clock - 60_000), Value::Null, clock - 10_000)
            .unwrap();
        assert_eq!(state.publication.generation, generation);
        // An older but still-valid observation in a newer publication is valid.
        state
            .accept(&snapshot(clock - 120_000), Value::Null, clock)
            .unwrap();
        assert_eq!(state.freshness.unwrap().observed_at, clock - 120_000);
        assert!(
            state
                .accept(&snapshot(clock), Value::Null, clock - 20_000)
                .is_err()
        );
        assert!(
            state
                .accept(&snapshot(clock), Value::Null, clock + 120_000)
                .is_err()
        );
        assert_eq!(state.freshness.unwrap().observed_at, clock - 120_000);
    }
}
