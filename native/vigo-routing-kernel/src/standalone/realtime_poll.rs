//! One optional GTFS-Realtime producer per server. Downloads and protobuf
//! decoding never run in the query worker; each poll publishes one immutable
//! snapshot that every query admitted after it sees in full.
use super::{Result, fail};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    io::Read,
    path::Path,
    sync::{Arc, Mutex, mpsc},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const WIRE_LIMIT: u64 = 32 * 1024 * 1024;
const DECODED_LIMIT: u64 = 128 * 1024 * 1024;
const MAXIMUM_SOURCES: usize = 16;
fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
fn kind() -> String {
    "feed".into()
}
fn interval() -> u64 {
    30
}
fn timeout() -> u64 {
    10
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Source {
    url: String,
    /// `feed` (trip updates and alerts), `tripUpdates` or `alerts`.
    #[serde(default = "kind")]
    kind: String,
    /// The static feed this source describes, in a City built from several.
    source_scope: Option<String>,
    /// Request headers such as an API key. They are never echoed.
    #[serde(default)]
    headers: BTreeMap<String, String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Settings {
    sources: Vec<Source>,
    #[serde(default = "interval")]
    interval_seconds: u64,
    #[serde(default = "timeout")]
    timeout_seconds: u64,
}
fn header_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
        && !["host", "content-length", "transfer-encoding", "connection"]
            .contains(&name.to_ascii_lowercase().as_str())
}
impl Settings {
    fn read(path: &str) -> Result<Self> {
        let bytes = fs::read(path)?;
        if bytes.len() > 64 * 1024 {
            return fail("GTFS-RT settings exceed 64 KiB");
        }
        let s: Self = serde_json::from_slice(&bytes)?;
        if s.sources.is_empty() || s.sources.len() > MAXIMUM_SOURCES {
            return fail(format!(
                "GTFS-RT settings need 1 to {MAXIMUM_SOURCES} sources"
            ));
        }
        if !(5..=3600).contains(&s.interval_seconds) || !(1..=60).contains(&s.timeout_seconds) {
            return fail("Invalid GTFS-RT interval (5..3600) or timeout (1..60 seconds)");
        }
        let mut urls = HashSet::new();
        for source in &s.sources {
            let uri: ureq::http::Uri = source.url.parse()?;
            let local = uri
                .host()
                .is_some_and(|h| matches!(h, "127.0.0.1" | "[::1]" | "localhost"));
            if source.url.len() > 8192
                || uri.authority().is_none_or(|a| a.as_str().contains('@'))
                || !(uri.scheme_str() == Some("https") || local && uri.scheme_str() == Some("http"))
            {
                return fail(
                    "GTFS-RT URLs require HTTPS (HTTP is allowed only on loopback), without credentials",
                );
            }
            if !urls.insert(&source.url) {
                return fail("Each GTFS-RT URL may appear once");
            }
            if !["feed", "tripUpdates", "alerts"].contains(&source.kind.as_str()) {
                return fail("GTFS-RT source kind must be feed, tripUpdates or alerts");
            }
            if source
                .source_scope
                .as_ref()
                .is_some_and(|s| s.is_empty() || s.len() > 160 || s.chars().any(char::is_control))
            {
                return fail("Invalid GTFS-RT sourceScope");
            }
            if source.headers.len() > 8
                || source.headers.iter().any(|(name, value)| {
                    !header_name(name)
                        || value.len() > 4096
                        || value.bytes().any(|b| matches!(b, b'\r' | b'\n' | 0))
                })
            {
                return fail("GTFS-RT headers must be at most 8 valid name/value pairs");
            }
        }
        Ok(s)
    }
}

/// One publication as installed in a query worker.
pub(crate) struct LiveSnapshot {
    pub generation: u64,
    pub id: String,
    pub snapshot: Value,
}

/// One published live state. Queries name it by `id`; `generation` orders
/// publications for installation in the query worker.
#[derive(Clone)]
pub(crate) struct Publication {
    pub generation: u64,
    pub id: String,
    pub snapshot: Arc<Value>,
}

#[derive(Default)]
struct SourceState {
    trip_updates: Vec<Value>,
    alerts: Vec<Value>,
    feed_timestamp: Option<u64>,
    counts: Value,
    last_success: Option<i64>,
    error: Option<String>,
}

struct Status {
    publication: Option<Publication>,
    generation: u64,
    sources: Vec<SourceState>,
    attempts: u64,
    failures: u32,
    last_attempt: Option<i64>,
    next_attempt: Option<i64>,
    poll_ms: Option<f64>,
}

impl Status {
    /// Rebuilds the published snapshot from every source's latest good read.
    /// A failed source keeps its previous records; their own timestamps make
    /// routing treat them as stale once they age out.
    fn publish(&mut self, settings: &Settings) -> Result<()> {
        let mut trip_updates = vec![];
        let mut alerts = vec![];
        let mut feeds = vec![];
        let mut timestamps = vec![];
        for (index, (source, state)) in settings.sources.iter().zip(&self.sources).enumerate() {
            if let Some(timestamp) = state.feed_timestamp {
                timestamps.push(timestamp);
            }
            let stamp = |record: &Value| {
                let mut record = record.clone();
                if let Some(scope) = &source.source_scope {
                    record["sourceScope"] = json!(scope);
                }
                if let Some(timestamp) = state.feed_timestamp {
                    record["sourceFeedTimestamp"] = json!(timestamp);
                }
                record
            };
            trip_updates.extend(state.trip_updates.iter().map(stamp));
            alerts.extend(state.alerts.iter().map(stamp));
            feeds.push(
                json!({"index":index,"kind":source.kind,"sourceScope":source.source_scope,
                "feedTimestamp":state.feed_timestamp,"failed":state.error.is_some()}),
            );
        }
        if trip_updates.len() > vigo_gtfs::realtime::MAXIMUM_ENTITIES {
            return fail("GTFS-RT sources together exceed 100000 trip updates");
        }
        let failed = self.sources.iter().filter(|s| s.error.is_some()).count();
        let received = self.sources.iter().any(|s| s.last_success.is_some());
        let mut snapshot = json!({"incrementality":"FULL_DATASET","tripUpdates":trip_updates,
            "alerts":alerts,"failedFeeds":failed,"feeds":feeds,
            "inputCoverage":{"received":received,"complete":received && failed == 0}});
        if let Some(&oldest) = timestamps.iter().min() {
            snapshot["feedTimestamp"] = json!(oldest);
        }
        let digest = Sha256::digest(serde_json::to_vec(&snapshot)?);
        let id = format!("live-{:x}", digest)[..21].to_owned();
        if self.publication.as_ref().is_none_or(|p| p.id != id) {
            self.generation += 1;
            self.publication = Some(Publication {
                generation: self.generation,
                id,
                snapshot: Arc::new(snapshot),
            });
        }
        Ok(())
    }

    fn view(&self, settings: &Settings) -> Value {
        let clock = now() / 1000;
        let sources: Vec<_> = settings
            .sources
            .iter()
            .zip(&self.sources)
            .enumerate()
            .map(|(index, (source, state))| {
                json!({"index":index,"kind":source.kind,"sourceScope":source.source_scope,
                    "status":if state.error.is_some() { "failed" } else if state.last_success.is_some() { "ok" } else { "pending" },
                    "feedTimestamp":state.feed_timestamp,
                    "ageSeconds":state.feed_timestamp.map(|t| clock - t as i64),
                    "lastSuccessAtMs":state.last_success,"entities":state.counts,"lastError":state.error})
            })
            .collect();
        let snapshot = self.publication.as_ref().map(|p| &p.snapshot);
        let oldest = snapshot.and_then(|s| s["feedTimestamp"].as_i64());
        // Matches the routing freshness bound for feed timestamps.
        let status = match oldest {
            None => "unavailable_fallback",
            Some(t) if clock - t > 180 => "stale_fallback",
            _ => "fresh",
        };
        json!({"enabled":true,"status":status,"generation":self.publication.as_ref().map(|p| p.generation),
            "snapshotId":self.publication.as_ref().map(|p| &p.id),
            "tripUpdates":snapshot.map(|s| s["tripUpdates"].as_array().map_or(0, Vec::len)),
            "alerts":snapshot.map(|s| s["alerts"].as_array().map_or(0, Vec::len)),
            "intervalSeconds":settings.interval_seconds,"attempts":self.attempts,
            "consecutiveFailures":self.failures,"lastAttemptAtMs":self.last_attempt,
            "nextAttemptAtMs":self.next_attempt,"pollMs":self.poll_ms,"sources":sources})
    }
}

pub(crate) struct Poller {
    settings: Arc<Settings>,
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
        let Some(path) = options.get("realtime-poll") else {
            return Ok(None);
        };
        if Path::new(city).join("scenarios.json").exists() {
            return fail("GTFS-RT polling currently requires a single City");
        }
        let settings = Arc::new(Settings::read(path)?);
        let state = Arc::new(Mutex::new(Status {
            publication: None,
            generation: 0,
            sources: settings
                .sources
                .iter()
                .map(|_| SourceState::default())
                .collect(),
            attempts: 0,
            failures: 0,
            last_attempt: None,
            next_attempt: None,
            poll_ms: None,
        }));
        let (shared, polled) = (state.clone(), settings.clone());
        let (stop, stopped) = mpsc::channel();
        let thread = thread::Builder::new()
            .name("vigo-gtfs-rt".into())
            .spawn(move || {
                let agent = ureq::Agent::config_builder()
                    .timeout_global(Some(Duration::from_secs(polled.timeout_seconds)))
                    .max_redirects(0)
                    .build()
                    .new_agent();
                loop {
                    let started = Instant::now();
                    shared.lock().unwrap().last_attempt = Some(now());
                    let reads: Vec<_> = polled.sources.iter().map(|s| read(&agent, s)).collect();
                    let delay = {
                        let mut state = shared.lock().unwrap();
                        state.attempts += 1;
                        let mut any = false;
                        for (source, read) in state.sources.iter_mut().zip(reads) {
                            match read {
                                Ok(read) => {
                                    *source = SourceState {
                                        last_success: Some(now()),
                                        error: None,
                                        ..read
                                    };
                                    any = true;
                                }
                                Err(error) => {
                                    source.error =
                                        Some(error.to_string().chars().take(256).collect());
                                }
                            }
                        }
                        if let Err(error) = state.publish(&polled) {
                            for source in &mut state.sources {
                                source.error.get_or_insert_with(|| error.to_string());
                            }
                            any = false;
                        }
                        state.failures = if any {
                            0
                        } else {
                            state.failures.saturating_add(1)
                        };
                        state.poll_ms = Some(started.elapsed().as_secs_f64() * 1000.);
                        let delay = polled
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
            settings,
            state,
            stop,
            thread: Some(thread),
        }))
    }
    pub fn publication(&self) -> Option<Publication> {
        self.state.lock().unwrap().publication.clone()
    }
    pub fn status(&self) -> Value {
        self.state.lock().unwrap().view(&self.settings)
    }
}

fn read(agent: &ureq::Agent, source: &Source) -> Result<SourceState> {
    // Do not echo URLs, query strings, headers or response bodies into status.
    let mut request = agent
        .get(&source.url)
        .header("Accept", "application/x-protobuf, application/octet-stream")
        .header("Accept-Encoding", "identity");
    for (name, value) in &source.headers {
        request = request.header(name, value);
    }
    let mut response = request
        .call()
        .map_err(|_| "GTFS-RT HTTP request failed (transport, timeout or status)")?;
    if response.status().as_u16() != 200 {
        return fail("GTFS-RT endpoint did not return HTTP 200");
    }
    let mut bytes = Vec::new();
    response
        .body_mut()
        .as_reader()
        .take(WIRE_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "GTFS-RT download failed or timed out")?;
    if bytes.len() as u64 > WIRE_LIMIT {
        return fail("GTFS-RT download exceeds 32 MiB");
    }
    // Some publishers serve gzip files without a Content-Encoding header.
    if bytes.starts_with(&[0x1f, 0x8b]) {
        let mut decoded = Vec::new();
        flate2::read::MultiGzDecoder::new(bytes.as_slice())
            .take(DECODED_LIMIT + 1)
            .read_to_end(&mut decoded)
            .map_err(|_| "GTFS-RT gzip body is invalid")?;
        if decoded.len() as u64 > DECODED_LIMIT {
            return fail("GTFS-RT feed exceeds 128 MiB when decompressed");
        }
        bytes = decoded;
    }
    let feed = vigo_gtfs::realtime::decode(&bytes)?;
    let trips = source.kind != "alerts";
    let alerts = source.kind != "tripUpdates";
    Ok(SourceState {
        trip_updates: if trips {
            feed.trip_updates.iter().map(|u| u.record()).collect()
        } else {
            vec![]
        },
        alerts: if alerts {
            feed.alerts.iter().map(|a| a.record()).collect()
        } else {
            vec![]
        },
        feed_timestamp: feed.header.timestamp.filter(|&t| t > 0),
        counts: feed.counts(),
        ..SourceState::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn settings(text: &str) -> Result<Settings> {
        let path = std::env::temp_dir().join(format!(
            "vigo-gtfs-rt-settings-{}-{}.json",
            std::process::id(),
            Sha256::digest(text.as_bytes())[0]
        ));
        fs::write(&path, text).unwrap();
        let result = Settings::read(path.to_str().unwrap());
        fs::remove_file(path).unwrap();
        result
    }
    #[test]
    fn settings_require_safe_sources() {
        assert!(settings(r#"{"sources":[{"url":"https://example.test/trips.pb","sourceScope":"mbta","headers":{"x-api-key":"k"}}]}"#).is_ok());
        assert!(settings(r#"{"sources":[{"url":"http://127.0.0.1:9/trips.pb","kind":"alerts"}],"intervalSeconds":5}"#).is_ok());
        for bad in [
            r#"{"sources":[]}"#,
            r#"{"sources":[{"url":"http://example.test/trips.pb"}]}"#,
            r#"{"sources":[{"url":"https://user:secret@example.test/trips.pb"}]}"#,
            r#"{"sources":[{"url":"https://example.test/a.pb","kind":"vehicles"}]}"#,
            r#"{"sources":[{"url":"https://example.test/a.pb"},{"url":"https://example.test/a.pb"}]}"#,
            r#"{"sources":[{"url":"https://example.test/a.pb","headers":{"Host":"evil"}}]}"#,
            r#"{"sources":[{"url":"https://example.test/a.pb","headers":{"x-key":"a\r\nInjected: 1"}}]}"#,
            r#"{"sources":[{"url":"https://example.test/a.pb"}],"intervalSeconds":1}"#,
            r#"{"sources":[{"url":"https://example.test/a.pb","extra":true}]}"#,
        ] {
            assert!(settings(bad).is_err(), "{bad}");
        }
    }
    #[test]
    fn publication_changes_only_with_content_and_keeps_failed_sources() {
        let settings = settings(
            r#"{"sources":[{"url":"https://example.test/a.pb","sourceScope":"a"},{"url":"https://example.test/b.pb","kind":"alerts"}]}"#,
        )
        .unwrap();
        let mut status = Status {
            publication: None,
            generation: 0,
            sources: vec![SourceState::default(), SourceState::default()],
            attempts: 0,
            failures: 0,
            last_attempt: None,
            next_attempt: None,
            poll_ms: None,
        };
        status.sources[0] = SourceState {
            trip_updates: vec![json!({"tripId":"T1","delaySeconds":60})],
            feed_timestamp: Some(1_000),
            last_success: Some(1),
            ..SourceState::default()
        };
        status.publish(&settings).unwrap();
        let first = status.publication.clone().unwrap();
        assert_eq!(first.generation, 1);
        assert_eq!(first.snapshot["tripUpdates"][0]["sourceScope"], "a");
        assert_eq!(
            first.snapshot["tripUpdates"][0]["sourceFeedTimestamp"],
            1_000
        );
        status.publish(&settings).unwrap();
        assert_eq!(status.publication.as_ref().unwrap().generation, 1);
        // A failed read keeps the last good records and marks the gap.
        status.sources[0].error = Some("timeout".into());
        status.publish(&settings).unwrap();
        let failed = status.publication.clone().unwrap();
        assert_eq!(failed.generation, 2);
        assert_eq!(failed.snapshot["tripUpdates"].as_array().unwrap().len(), 1);
        assert_eq!(failed.snapshot["failedFeeds"], 1);
        assert_eq!(failed.snapshot["inputCoverage"]["complete"], false);
        assert!(
            status
                .view(&settings)
                .to_string()
                .find("example.test")
                .is_none()
        );
    }
}
