//! NDW Verkeersdata NL DATEX II 3.6 AVG publications. Streaming XML ingestion:
//! site versions and quantity indices are joined before any costs are emitted.
use crate::{Result, timestamp};
use quick_xml::{events::Event, name::ResolveResult, reader::NsReader};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    io::{BufRead, BufReader},
};
const ROA: &str = "http://datex2.eu/schema/3/roadTrafficData";
const LOC: &str = "http://datex2.eu/schema/3/locationReferencing";
const COM: &str = "http://datex2.eu/schema/3/common";
const MC: &str = "http://datex2.eu/schema/3/messageContainer";
#[derive(Default, Debug)]
struct Node {
    name: String,
    ns: String,
    attrs: HashMap<String, String>,
    text: String,
    children: Vec<Node>,
}
impl Node {
    fn attr(&self, k: &str) -> &str {
        self.attrs.get(k).map_or("", String::as_str)
    }
    fn all<'a>(&'a self, ns: &'a str, name: &'a str) -> impl Iterator<Item = &'a Node> {
        self.walk().filter(move |n| n.ns == ns && n.name == name)
    }
    fn walk(&self) -> Box<dyn Iterator<Item = &Node> + '_> {
        Box::new(std::iter::once(self).chain(self.children.iter().flat_map(Node::walk)))
    }
    fn first(&self, ns: &str, name: &str) -> Option<&Node> {
        self.walk().find(|n| n.ns == ns && n.name == name)
    }
    fn value(&self, ns: &str, name: &str) -> &str {
        self.first(ns, name).map_or("", |n| n.text.trim())
    }
}
/// Only retain one site record, not a DOM of the national publication.
fn records(reader: impl BufRead, mut accept: impl FnMut(Node) -> Result<()>) -> Result<()> {
    let mut reader = NsReader::from_reader(BufReader::new(reader.take(256 * 1024 * 1024 + 1)));
    reader.config_mut().trim_text(false);
    let mut buf = vec![];
    let mut stack: Vec<Node> = vec![];
    let mut depth = 0;
    let mut valid_root = false;
    let mut record_bytes = 0usize;
    let mut record_nodes = 0usize;
    let mut seen_root = false;
    loop {
        let (ns, event) = reader
            .read_resolved_event_into(&mut buf)
            .map_err(|e| format!("DATEX XML: {e}"))?;
        let ns = match ns {
            ResolveResult::Bound(n) => n.as_ref().to_owned(),
            ResolveResult::Unbound => String::new(),
            ResolveResult::Unknown(_) => return Err("Unknown XML namespace".into()),
        };
        if reader.buffer_position() > 256 * 1024 * 1024 {
            return Err("DATEX document exceeds 256 MiB".into());
        }
        match event {
            Event::Start(ref e) | Event::Empty(ref e) => {
                let empty = matches!(event, Event::Empty(_));
                let name = e.local_name().as_ref().to_owned();
                let mut attrs = HashMap::new();
                for a in e.attributes() {
                    let a = a.map_err(|e| e.to_string())?;
                    let key = a.key.as_ref().to_owned();
                    if !key.starts_with("xmlns") {
                        attrs.insert(
                            key,
                            a.normalized_value(quick_xml::XmlVersion::Explicit1_0)
                                .map_err(|e| e.to_string())?
                                .into_owned(),
                        );
                    }
                }
                let n = Node {
                    name: name.clone(),
                    ns: ns.clone(),
                    attrs,
                    ..Node::default()
                };
                if depth == 0 {
                    if seen_root {
                        return Err("Multiple DATEX XML roots".into());
                    }
                    seen_root = true;
                    valid_root =
                        ns == MC && name == "messageContainer" && n.attr("modelBaseVersion") == "3";
                    if !valid_root {
                        return Err("Expected DATEX II v3 messageContainer".into());
                    }
                }
                if !empty {
                    depth += 1;
                }
                if depth > 64 {
                    return Err("DATEX XML nesting limit exceeded".into());
                }
                let capture = (ns == ROA
                    && [
                        "measurementSite",
                        "siteMeasurements",
                        "measurementSiteTableReference",
                    ]
                    .contains(&name.as_str()))
                    || (ns == COM
                        && ["publicationTime", "informationStatus"].contains(&name.as_str()));
                if stack.is_empty() && ns == ROA && name == "measurementSiteTable" {
                    accept(n)?;
                } else if !stack.is_empty() || capture {
                    record_nodes += 1;
                    if record_nodes > 16384 {
                        return Err("DATEX record node limit exceeded".into());
                    }
                    record_bytes += e.len();
                    if record_bytes > 2 * 1024 * 1024 {
                        return Err("DATEX record exceeds 2 MiB".into());
                    }
                    if empty {
                        if let Some(parent) = stack.last_mut() {
                            parent.children.push(n);
                        } else {
                            accept(n)?;
                            record_bytes = 0;
                            record_nodes = 0;
                        }
                    } else {
                        stack.push(n);
                    }
                }
            }
            Event::End(_) => {
                depth -= 1;
                if let Some(n) = stack.pop() {
                    if let Some(parent) = stack.last_mut() {
                        parent.children.push(n);
                    } else {
                        accept(n)?;
                        record_bytes = 0;
                        record_nodes = 0;
                    }
                }
            }
            Event::Text(e) => {
                if let Some(n) = stack.last_mut() {
                    let t = e.xml_content(quick_xml::XmlVersion::Explicit1_0);
                    record_bytes += t.len();
                    if record_bytes > 2 * 1024 * 1024 {
                        return Err("DATEX record exceeds 2 MiB".into());
                    }
                    n.text
                        .push_str(&quick_xml::escape::unescape(&t).map_err(|e| e.to_string())?);
                }
            }
            Event::GeneralRef(e) => {
                let character = if let Some(c) = e.resolve_char_ref().map_err(|e| e.to_string())? {
                    c
                } else {
                    match e.as_ref() {
                        "amp" => '&',
                        "lt" => '<',
                        "gt" => '>',
                        "quot" => '\"',
                        "apos" => '\'',
                        _ => return Err("Unknown DATEX XML entity".into()),
                    }
                };
                if let Some(n) = stack.last_mut() {
                    record_bytes += character.len_utf8();
                    if record_bytes > 2 * 1024 * 1024 {
                        return Err("DATEX record exceeds 2 MiB".into());
                    }
                    n.text.push(character);
                }
            }
            Event::CData(_) | Event::DocType(_) => {
                return Err("DATEX DTD and CDATA are unsupported".into());
            }
            Event::Eof => break,
            _ => {}
        }
        if reader.buffer_position() > 256 * 1024 * 1024 {
            return Err("DATEX document exceeds 256 MiB".into());
        }
        buf.clear();
    }
    if !valid_root || depth != 0 {
        return Err("Incomplete DATEX XML".into());
    }
    Ok(())
}
#[derive(Debug)]
struct Site {
    version: String,
    coordinates: Vec<[f64; 2]>,
    quantities: HashMap<String, String>,
}
#[derive(Default, Debug)]
pub struct Configuration {
    table: String,
    version: String,
    sites: HashMap<String, Site>,
    excluded_sites: HashSet<String>,
    pub rejected: BTreeMap<String, usize>,
}
fn reject(report: &mut BTreeMap<String, usize>, reason: &str) {
    *report.entry(reason.into()).or_default() += 1;
}
impl Configuration {
    pub fn read(reader: impl BufRead) -> Result<Self> {
        let mut config = Self::default();
        let mut real = false;
        let mut ids = std::collections::HashSet::new();
        records(reader, |node| {
            match node.name.as_str() {
                "informationStatus" => {
                    if node.text.trim() != "real" {
                        return Err("NDW publication is not real data".into());
                    }
                    real = true;
                }
                "measurementSiteTable" => {
                    if !config.table.is_empty() {
                        return Err("Multiple NDW site tables are unsupported".into());
                    }
                    config.table = node.attr("id").into();
                    config.version = node.attr("version").into();
                }
                "measurementSite" => {
                    if !ids.insert(node.attr("id").to_owned()) {
                        return Err("Duplicate NDW measurementSite".into());
                    }
                    if ids.len() > 100_000 {
                        return Err("Too many NDW sites".into());
                    }
                    match site(&node) {
                        Ok(site) => {
                            config.sites.insert(node.attr("id").into(), site);
                        }
                        Err(reason) => reject(&mut config.rejected, &reason),
                    }
                }
                _ => {}
            }
            Ok(())
        })?;
        if config.table.is_empty() || config.version.is_empty() || !real {
            return Err("Incomplete NDW measurement site publication".into());
        }
        Ok(config)
    }
    /// Restrict a configuration to sites whose endpoints could match this
    /// immutable City. Off-City records are skipped before computing freshness,
    /// and only their IDs are retained for explicit rejection diagnostics.
    pub fn retain_near(&mut self, lons: &[f64], lats: &[f64], radius_m: f64) -> Result<()> {
        if lons.is_empty()
            || lons.len() != lats.len()
            || !radius_m.is_finite()
            || !(0. ..=1000.).contains(&radius_m)
            || lons.iter().any(|x| !x.is_finite() || x.abs() > 180.)
            || lats.iter().any(|y| !y.is_finite() || y.abs() > 90.)
        {
            return Err("Invalid City coordinates for NDW site selection".into());
        }
        let west = lons.iter().copied().fold(f64::INFINITY, f64::min);
        let east = lons.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        let south = lats.iter().copied().fold(f64::INFINITY, f64::min);
        let north = lats.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        let dy = radius_m / 111195.;
        let dx = dy / north.abs().max(south.abs()).to_radians().cos().max(0.01);
        let inside = |p: &[f64; 2]| {
            p[0] >= west - dx && p[0] <= east + dx && p[1] >= south - dy && p[1] <= north + dy
        };
        for (id, site) in std::mem::take(&mut self.sites) {
            if inside(&site.coordinates[0]) && inside(site.coordinates.last().unwrap()) {
                self.sites.insert(id, site);
            } else {
                self.excluded_sites.insert(id);
            }
        }
        Ok(())
    }
    pub fn excluded_site_count(&self) -> usize {
        self.excluded_sites.len()
    }
    pub fn site_count(&self) -> usize {
        self.sites.len()
    }
    pub fn ingest(&self, reader: impl BufRead, now_ms: i64, ttl_seconds: u32) -> Result<Batch> {
        if !(1..=1800).contains(&ttl_seconds) {
            return Err("ttlSeconds must be 1..1800".into());
        }
        let mut batch = Batch {
            observations: vec![],
            rejected: BTreeMap::new(),
            observed_at: now_ms,
            expires_at: now_ms + ttl_seconds as i64 * 1000,
            publication_time: None,
        };
        let mut real = false;
        let mut table = false;
        let mut seen = std::collections::HashSet::new();
        let mut records_count = 0;
        let mut earliest_seen: Option<i64> = None;
        records(reader, |node| {
            match node.name.as_str() {
                "informationStatus" => {
                    if node.text.trim() != "real" {
                        return Err("NDW publication is not real data".into());
                    }
                    real = true;
                }
                "measurementSiteTableReference" => {
                    if node.attr("id") != self.table || node.attr("version") != self.version {
                        return Err("NDW site table reference mismatch".into());
                    }
                    table = true;
                }
                "publicationTime" => {
                    let t = timestamp(&json!(node.text.trim()))?;
                    if t > now_ms + 60_000 {
                        return Err("NDW publicationTime is in the future".into());
                    }
                    batch.publication_time = Some(t);
                }
                "siteMeasurements" => {
                    records_count += 1;
                    if records_count > 100_000 {
                        return Err("Too many NDW measurement records".into());
                    }
                    let Some(reference) = node.first(ROA, "measurementSiteReference") else {
                        reject(&mut batch.rejected, "missing_site_reference");
                        return Ok(());
                    };
                    if !seen.insert(reference.attr("id").to_owned()) {
                        return Err("Duplicate NDW siteMeasurements".into());
                    }
                    let Some(site) = self.sites.get(reference.attr("id")) else {
                        reject(
                            &mut batch.rejected,
                            if self.excluded_sites.contains(reference.attr("id")) {
                                "out_of_city_site"
                            } else {
                                "unsupported_or_unknown_site"
                            },
                        );
                        return Ok(());
                    };
                    if site.version != reference.attr("version") {
                        reject(&mut batch.rejected, "site_version_mismatch");
                        return Ok(());
                    }
                    let time = node
                        .first(ROA, "measurementTimeDefault")
                        .and_then(|n| n.first(ROA, "timeValue"));
                    let Some(time) = time else {
                        reject(&mut batch.rejected, "missing_measurement_time");
                        return Ok(());
                    };
                    let t = timestamp(&json!(time.text.trim()))?;
                    earliest_seen = Some(earliest_seen.map_or(t, |old| old.min(t)));
                    if t > now_ms + 60_000 {
                        reject(&mut batch.rejected, "future_measurement");
                        return Ok(());
                    }
                    if t + ttl_seconds as i64 * 1000 <= now_ms {
                        reject(&mut batch.rejected, "stale_measurement");
                        return Ok(());
                    }
                    let mut quantity_indices = std::collections::HashSet::new();
                    for quantity in node
                        .children
                        .iter()
                        .filter(|n| n.ns == ROA && n.name == "physicalQuantity")
                    {
                        if !quantity_indices.insert(quantity.attr("index")) {
                            return Err("Duplicate NDW physicalQuantity index".into());
                        }
                        let Some(kind) = site.quantities.get(quantity.attr("index")) else {
                            reject(&mut batch.rejected, "unsupported_quantity_index");
                            continue;
                        };
                        // Forecasts, per-value timing overrides and invalid quality
                        // are not silently treated as current measured traffic.
                        if quantity.walk().any(|n| {
                            n.attr("dataError") == "true"
                                || n.attr("dataError") == "1"
                                || n.attr("forecast") == "true"
                                || n.attr("forecast") == "1"
                                || (n.name == "forecast" && ["true", "1"].contains(&n.text.trim()))
                        }) {
                            reject(&mut batch.rejected, "invalid_or_forecast");
                            continue;
                        }
                        if quantity.first(ROA, "timeValue").is_some()
                            || quantity
                                .first(ROA, "measurementOrCalculationTime")
                                .is_some()
                        {
                            reject(&mut batch.rejected, "unsupported_time_override");
                            continue;
                        }
                        let (container, field, key) = if kind == "travelTimeInformation" {
                            ("travelTime", "duration", "travelTimeSeconds")
                        } else {
                            ("averageVehicleSpeed", "speed", "speedKph")
                        };
                        let Some(data) = quantity.first(ROA, container) else {
                            reject(&mut batch.rejected, "quantity_type_mismatch");
                            continue;
                        };
                        if !data
                            .attr("accuracy")
                            .parse::<f64>()
                            .is_ok_and(|v| v.is_finite() && v > 0. && v <= 100.)
                        {
                            reject(&mut batch.rejected, "invalid_quality");
                            continue;
                        }
                        let value = data.value(ROA, field).parse::<f64>().unwrap_or(f64::NAN);
                        let valid = if key == "travelTimeSeconds" {
                            (0.01..=86400.).contains(&value)
                        } else {
                            (1. ..=200.).contains(&value)
                        };
                        if !value.is_finite() || !valid {
                            reject(&mut batch.rejected, "invalid_or_missing_value");
                            continue;
                        }
                        let mut observation = json!({"coordinates":site.coordinates,"sourceRecord":reference.attr("id"),"sourceVersion":site.version,"measurementIndex":quantity.attr("index")});
                        observation[key] = json!(value);
                        batch.observations.push(observation);
                        batch.observed_at = batch.observed_at.min(t);
                        batch.expires_at = batch.expires_at.min(t + ttl_seconds as i64 * 1000);
                    }
                }
                _ => {}
            }
            Ok(())
        })?;
        if !real || !table || batch.publication_time.is_none() {
            return Err("Incomplete NDW measured data publication".into());
        }
        if batch.observations.is_empty() {
            batch.observed_at = earliest_seen.or(batch.publication_time).unwrap();
            batch.expires_at = batch.observed_at + ttl_seconds as i64 * 1000;
        }
        Ok(batch)
    }
}
fn site(node: &Node) -> Result<Site> {
    if node.attr("id").is_empty() || node.attr("version").is_empty() {
        return Err("missing_site_identity".into());
    }
    let location = node
        .first(ROA, "measurementSiteLocation")
        .ok_or("missing_location")?;
    // The NDW AVG feed uses GML latitude/longitude pairs in travel direction.
    // Do not guess a path from a point detector, ALERT-C or encoded OpenLR.
    let mut sections = location
        .all(LOC, "locationContainedInItinerary")
        .collect::<Vec<_>>();
    sections.sort_by_key(|n| n.attr("index").parse::<usize>().unwrap_or(usize::MAX));
    if sections.is_empty() {
        return Err("unsupported_location_reference".into());
    }
    let mut coords = vec![];
    for (i, section) in sections.iter().enumerate() {
        if section.attr("index").parse::<usize>() != Ok(i) {
            return Err("invalid_itinerary_order".into());
        }
        let lines = section.all(LOC, "gmlLineString").collect::<Vec<_>>();
        if lines.len() != 1 {
            return Err("unsupported_location_reference".into());
        }
        let line = lines[0];
        let pos = line.first(LOC, "posList").ok_or("missing_pos_list")?;
        if [line, pos].iter().any(|n| {
            !n.attr("srsName").is_empty()
                || (!n.attr("srsDimension").is_empty() && n.attr("srsDimension") != "2")
        }) {
            return Err("unsupported_coordinate_reference".into());
        }
        let numbers = pos
            .text
            .split_whitespace()
            .map(str::parse::<f64>)
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|_| "invalid_geometry")?;
        if numbers.len() < 4 || numbers.len() % 2 != 0 {
            return Err("invalid_geometry".into());
        }
        let section = numbers
            .chunks_exact(2)
            .map(|p| [p[1], p[0]])
            .collect::<Vec<_>>();
        if i > 0 && coords.last() != section.first() {
            return Err("disconnected_itinerary".into());
        }
        coords.extend(section);
    }
    let coordinates =
        crate::coordinates(&json!({"coordinates":coords})).map_err(|_| "invalid_geometry")?;
    let mut quantities = HashMap::new();
    for q in node
        .children
        .iter()
        .filter(|n| n.ns == ROA && n.name == "measurementSpecificCharacteristics")
    {
        if q.attr("index").parse::<u32>().is_err() {
            return Err("invalid_quantity_index".into());
        }
        let kind = q.value(ROA, "specificMeasurementValueType");
        if !["travelTimeInformation", "trafficSpeed"].contains(&kind) {
            continue;
        }
        if q.value(COM, "vehicleType") != "anyVehicle"
            || q.first(COM, "lengthCharacteristic").is_some()
            || q.first(ROA, "specificLane").is_some()
        {
            continue;
        }
        if quantities
            .insert(q.attr("index").into(), kind.into())
            .is_some()
        {
            return Err("duplicate_quantity_index".into());
        }
    }
    if quantities.is_empty() {
        return Err("unsupported_measurement_characteristics".into());
    }
    Ok(Site {
        version: node.attr("version").into(),
        coordinates,
        quantities,
    })
}
pub struct Batch {
    pub observations: Vec<Value>,
    pub rejected: BTreeMap<String, usize>,
    pub observed_at: i64,
    pub expires_at: i64,
    pub publication_time: Option<i64>,
}
impl Batch {
    pub fn snapshot(&self, fingerprint: &str) -> Value {
        let mut value = json!({"source":"NDW DATEX II v3 AVG","observedAt":self.observed_at,"expiresAt":self.expires_at,"streetSourceFingerprint":fingerprint});
        if self.observations.is_empty() {
            value["edgeIndices"] = json!([]);
            value["edgeTimeUnits"] = json!([]);
        } else {
            value["observations"] = json!(self.observations);
        }
        value
    }
}
