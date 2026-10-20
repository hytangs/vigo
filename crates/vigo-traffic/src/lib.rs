//! Immutable, graph-bound road traffic snapshots. No network or system clock:
//! adapters supply bytes, an immutable graph and one admission time per query.
mod matching;
pub mod ndw;
pub use matching::{Graph, Matcher};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, sync::Arc};

pub type Result<T> = std::result::Result<T, String>;
pub const CLOSED: u32 = 0x7fff_ffff;
pub const MAX_UPDATES: usize = 200_000;

pub fn timestamp(value: &Value) -> Result<i64> {
    if let Some(n) = value.as_f64().or_else(|| value.as_str()?.parse().ok()) {
        let millis = if n < 1e12 { n * 1000. } else { n };
        if millis.is_finite()
            && millis > 0.
            && millis < i64::MAX as f64
            && chrono::DateTime::from_timestamp_millis(millis as i64).is_some()
        {
            return Ok(millis as i64);
        }
    } else if let Some(s) = value.as_str() {
        return chrono::DateTime::parse_from_rfc3339(s)
            .map(|t| t.timestamp_millis())
            .map_err(|_| "Invalid traffic timestamp".into());
    }
    Err("Invalid traffic timestamp".into())
}
fn iso(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .unwrap()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
pub fn number(value: &Value, key: &str, default: f64, min: f64, max: f64) -> Result<f64> {
    let n = value
        .get(key)
        .map_or(Some(default), Value::as_f64)
        .ok_or_else(|| format!("{key} must be a number"))?;
    if !n.is_finite() || n < min || n > max {
        return Err(format!("{key} must be between {min} and {max}"));
    }
    Ok(n)
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Freshness {
    pub observed_at: i64,
    pub expires_at: i64,
}
impl Freshness {
    pub fn parse(v: &Value) -> Result<Self> {
        let observed = timestamp(
            v.get("observedAt")
                .or_else(|| v.get("fetchedAt"))
                .or_else(|| v.get("timestamp"))
                .ok_or("traffic requires observedAt, including prepared snapshots")?,
        )?;
        let ttl = number(v, "ttlSeconds", 300., 1., 1800.)?;
        let expires = v
            .get("expiresAt")
            .map(timestamp)
            .transpose()?
            .unwrap_or(observed + (ttl * 1000.) as i64);
        if expires <= observed
            || expires - observed > 1_800_000
            || chrono::DateTime::from_timestamp_millis(expires).is_none()
        {
            return Err(
                "expiresAt must be later than observedAt and at most 1800 seconds later".into(),
            );
        }
        Ok(Self {
            observed_at: observed,
            expires_at: expires,
        })
    }
    pub fn stale(self, now: i64) -> Result<bool> {
        if self.observed_at > now.saturating_add(60_000) {
            return Err("observedAt is in the future".into());
        }
        Ok(now >= self.expires_at)
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Weights {
    pub snapshot_key: String,
    pub edge_indices: Vec<u32>,
    pub edge_time_units: Vec<u32>,
}
#[derive(Clone, Debug)]
pub struct Snapshot {
    pub freshness: Freshness,
    pub fingerprint: String,
    pub source: String,
    pub snapshot_id: Option<String>,
    pub weights: Weights,
    pub observations: usize,
    pub matched_observations: usize,
    pub matched_edges: usize,
    pub rejected: BTreeMap<String, usize>,
}
impl Snapshot {
    /// Freshness is evaluated even on cache hits. The returned admission is
    /// pinned for the entire route or matrix; no mid-query wall-clock reads.
    pub fn admit(&self, now: i64) -> Result<Value> {
        let mut v = self.admission(now)?;
        if v["status"] == "applied" {
            v["nativeInput"] = serde_json::to_value(&self.weights).map_err(|e| e.to_string())?;
        }
        Ok(v)
    }
    /// Native callers can use the admitted weights directly, without a JSON array round trip.
    pub fn admission(&self, now: i64) -> Result<Value> {
        let stale = self.freshness.stale(now)?;
        let status = if stale {
            "stale_fallback"
        } else if !self.weights.edge_indices.is_empty() {
            "applied"
        } else if self.matched_observations > 0 {
            "free_flow_equivalent"
        } else {
            "no_matches"
        };
        let mut v = json!({"status":status,"source":self.source,"snapshotId":self.snapshot_id,
            "observedAt":iso(self.freshness.observed_at),"expiresAt":iso(self.freshness.expires_at),
            "ageSeconds":((now-self.freshness.observed_at).max(0) as f64/100.).round()/10.,
            "observations":self.observations,"matchedObservations":self.matched_observations,
            "unmatchedObservations":self.observations-self.matched_observations,
            "matchedEdges":self.matched_edges,"rejected":self.rejected,
            "closedEdges":if stale {0} else {self.weights.edge_time_units.iter().filter(|&&w| w==CLOSED).count()},
            "snapshotKey":self.weights.snapshot_key,
            "cacheKey":format!("{status}:{}:{}:{}",self.weights.snapshot_key,self.freshness.observed_at,self.freshness.expires_at)});
        if status == "applied" {
            v["mode"] = json!("cch-time-metric");
        }
        Ok(v)
    }
    pub fn prepared(&self) -> Value {
        let mut v = serde_json::to_value(&self.weights).unwrap();
        v["streetSourceFingerprint"] = json!(self.fingerprint);
        v["observedAt"] = json!(iso(self.freshness.observed_at));
        v["expiresAt"] = json!(iso(self.freshness.expires_at));
        v["source"] = json!(self.source);
        v
    }
}
/// A bounded cache of one compiled snapshot and one spatial index. Provider
/// ingestion can retain Arc<Snapshot> independently while publishing a new one.
#[derive(Default)]
pub struct TrafficEngine {
    matcher: Matcher,
    cached: Option<(String, Arc<Snapshot>)>,
}
impl TrafficEngine {
    /// Retained payload estimate, excluding allocator and hash-table control bytes.
    pub fn estimated_heap_bytes(&self) -> usize {
        self.matcher.estimated_heap_bytes()
            + self.cached.as_ref().map_or(0, |(key, s)| {
                key.capacity()
                    + s.fingerprint.capacity()
                    + s.source.capacity()
                    + s.snapshot_id.as_ref().map_or(0, String::capacity)
                    + s.weights.snapshot_key.capacity()
                    + (s.weights.edge_indices.capacity() + s.weights.edge_time_units.capacity()) * 4
                    + s.rejected
                        .keys()
                        .map(|k| k.capacity() + std::mem::size_of::<(String, usize)>())
                        .sum::<usize>()
            })
    }
    pub fn compile(
        &mut self,
        graph: Graph<'_>,
        fingerprint: &str,
        value: &Value,
    ) -> Result<Arc<Snapshot>> {
        if !value.is_object() {
            return Err("traffic must be an object".into());
        }
        let mut hash = Sha256::new();
        hash.update(fingerprint);
        hash.update(serde_json::to_vec(value).map_err(|e| e.to_string())?);
        let input_key = format!("{:x}", hash.finalize());
        if let Some((key, snapshot)) = &self.cached
            && *key == input_key
        {
            return Ok(snapshot.clone());
        }
        // A matcher is bound to this immutable graph; changing identities drops
        // its index and geometry cache rather than reusing provider edge IDs.
        self.matcher.bind(fingerprint);
        let freshness = Freshness::parse(value)?;
        let source = value["source"]
            .as_str()
            .unwrap_or("traffic-snapshot")
            .chars()
            .take(160)
            .collect();
        let mut snapshot = Snapshot {
            freshness,
            fingerprint: fingerprint.into(),
            source,
            snapshot_id: value
                .get("snapshotId")
                .or_else(|| value.get("id"))
                .and_then(Value::as_str)
                .map(|s| s.chars().take(160).collect()),
            weights: Weights {
                snapshot_key: String::new(),
                edge_indices: vec![],
                edge_time_units: vec![],
            },
            observations: 0,
            matched_observations: 0,
            matched_edges: 0,
            rejected: BTreeMap::new(),
        };
        let mut updates = BTreeMap::<u32, u32>::new();
        let exact = value["streetSourceFingerprint"]
            .as_str()
            .is_some_and(|s| !s.is_empty() && s == fingerprint);
        if value.get("edgeTimeUnits").is_some() {
            if !exact {
                return Err(
                    "traffic edge indices require the current streetSourceFingerprint".into(),
                );
            }
            let edges = indices(&value["edgeIndices"], graph.times.len(), MAX_UPDATES)?;
            let weights = value["edgeTimeUnits"]
                .as_array()
                .ok_or("edgeTimeUnits must be an array")?;
            if edges.len() != weights.len() {
                return Err("Traffic edge arrays differ in length".into());
            }
            for (edge, w) in edges.into_iter().zip(weights) {
                let w = w
                    .as_u64()
                    .filter(|w| *w > 0 && *w <= CLOSED as u64)
                    .ok_or("Invalid traffic edge time")? as u32;
                merge(&mut updates, edge, w.max(graph.times[edge as usize]));
            }
            snapshot.observations = updates.len();
            snapshot.matched_observations = updates.len();
        } else {
            let observations = value
                .get("observations")
                .or_else(|| value.get("segments"))
                .or_else(|| value.get("edgeUpdates"))
                .and_then(Value::as_array)
                .ok_or("traffic requires observations or edgeTimeUnits")?;
            if observations.is_empty() || observations.len() > 100_000 {
                return Err("traffic requires 1..100000 observations".into());
            }
            snapshot.observations = observations.len();
            let radius = number(value, "snapRadiusMeters", 120., 1., 1000.)?;
            let mut references = 0;
            for observation in observations {
                let effect = Effect::parse(observation)?;
                let edges = if observation.get("edgeIndices").is_some()
                    || observation.get("edgeIndex").is_some()
                {
                    if !exact {
                        return Err(
                            "traffic edge indices require the current streetSourceFingerprint"
                                .into(),
                        );
                    }
                    if observation.get("coordinates").is_some()
                        || observation.get("fromCoordinate").is_some()
                    {
                        return Err("Use geometry or edge indices, not both".into());
                    }
                    indices(
                        &observation
                            .get("edgeIndices")
                            .cloned()
                            .unwrap_or_else(|| json!([observation["edgeIndex"]])),
                        graph.times.len(),
                        4096,
                    )?
                } else {
                    let coords = coordinates(observation)?;
                    match self.matcher.match_path(graph, &coords, radius) {
                        Ok(edges) => edges,
                        Err(reason) => {
                            *snapshot.rejected.entry(reason).or_default() += 1;
                            continue;
                        }
                    }
                };
                if edges.is_empty() {
                    return Err("An observation must identify at least one directed edge".into());
                }
                references += edges.len();
                if references > MAX_UPDATES {
                    return Err("Traffic edge reference limit exceeded".into());
                }
                snapshot.matched_observations += 1;
                let mut unique = edges;
                unique.sort_unstable();
                unique.dedup();
                let total_base: f64 = unique.iter().map(|&i| graph.times[i as usize] as f64).sum();
                for edge in unique {
                    let base = graph.times[edge as usize];
                    let weight = match effect {
                        Effect::Closed => CLOSED,
                        Effect::Time(t) => {
                            ((t * 100. * base as f64 / total_base.max(1.)).round() as u32).max(base)
                        }
                        Effect::Speed(s) => ((graph.distances[edge as usize] as f64 / (s / 3.6))
                            .round() as u32)
                            .max(base),
                        Effect::Factor(f) => ((base as f64 * f).round() as u32).max(base),
                    };
                    if weight == 0 || (weight >= CLOSED && !matches!(effect, Effect::Closed)) {
                        return Err("Traffic cost exceeds native domain".into());
                    }
                    merge(&mut updates, edge, weight);
                }
            }
        }
        snapshot.matched_edges = updates.len();
        updates.retain(|&e, w| *w > graph.times[e as usize]);
        let mut hash = Sha256::new();
        hash.update(fingerprint);
        for (&e, &w) in &updates {
            hash.update(e.to_le_bytes());
            hash.update(w.to_le_bytes());
        }
        snapshot.weights.snapshot_key = format!("{:x}", hash.finalize());
        (
            snapshot.weights.edge_indices,
            snapshot.weights.edge_time_units,
        ) = updates.into_iter().unzip();
        let snapshot = Arc::new(snapshot);
        self.cached = Some((input_key, snapshot.clone()));
        Ok(snapshot)
    }
}
fn merge(updates: &mut BTreeMap<u32, u32>, edge: u32, w: u32) {
    updates
        .entry(edge)
        .and_modify(|v| *v = (*v).max(w))
        .or_insert(w);
}
fn indices(v: &Value, count: usize, max: usize) -> Result<Vec<u32>> {
    let a = v
        .as_array()
        .filter(|a| a.len() <= max)
        .ok_or("Invalid traffic edge indices or too many entries")?;
    a.iter()
        .map(|v| {
            v.as_u64()
                .filter(|&e| e < (count as u64))
                .map(|e| e as u32)
                .ok_or("Invalid traffic edge index".into())
        })
        .collect()
}
pub fn coordinates(v: &Value) -> Result<Vec<[f64; 2]>> {
    let v = v
        .get("coordinates")
        .cloned()
        .unwrap_or_else(|| json!([v["fromCoordinate"], v["toCoordinate"]]));
    let a = v
        .as_array()
        .filter(|a| (2..=512).contains(&a.len()))
        .ok_or("Traffic coordinates must contain 2..512 points")?;
    let mut points = Vec::new();
    for p in a {
        let p = p
            .as_array()
            .filter(|p| p.len() == 2)
            .ok_or("Coordinate must be [longitude, latitude]")?;
        let x = p[0]
            .as_f64()
            .filter(|x| x.is_finite() && x.abs() <= 180.)
            .ok_or("Invalid longitude")?;
        let y = p[1]
            .as_f64()
            .filter(|y| y.is_finite() && y.abs() <= 90.)
            .ok_or("Invalid latitude")?;
        if points.last() != Some(&[x, y]) {
            points.push([x, y]);
        }
    }
    if points.len() < 2 {
        return Err("Traffic geometry has no length".into());
    }
    Ok(points)
}
#[derive(Clone, Copy)]
enum Effect {
    Closed,
    Time(f64),
    Speed(f64),
    Factor(f64),
}
impl Effect {
    fn parse(v: &Value) -> Result<Self> {
        if v.get("closed").is_some_and(|v| !v.is_boolean()) {
            return Err("closed must be boolean".into());
        }
        let closed = v["closed"] == true;
        let factor = v
            .get("delayFactor")
            .or_else(|| v.get("factor"))
            .or_else(|| v.get("multiplier"));
        if [
            closed,
            v.get("travelTimeSeconds").is_some(),
            v.get("speedKph").is_some(),
            factor.is_some(),
        ]
        .iter()
        .filter(|&&x| x)
        .count()
            != 1
        {
            return Err("Traffic observations must declare exactly one of closed, travelTimeSeconds, speedKph, or delayFactor".into());
        }
        if closed {
            return Ok(Self::Closed);
        }
        if v.get("travelTimeSeconds").is_some() {
            return Ok(Self::Time(number(
                v,
                "travelTimeSeconds",
                0.,
                0.001,
                86400.,
            )?));
        }
        if v.get("speedKph").is_some() {
            return Ok(Self::Speed(number(v, "speedKph", 0., 1., 200.)?));
        }
        let f = factor
            .and_then(Value::as_f64)
            .filter(|f| f.is_finite() && (1. ..=100.).contains(f))
            .ok_or("Invalid delayFactor")?;
        Ok(Self::Factor(f))
    }
}
