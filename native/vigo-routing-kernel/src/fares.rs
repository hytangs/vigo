//! Boarding fare quotes from an imported GTFS fare catalog. One engine serves
//! every runtime; fares never influence path selection. A quote prices a single
//! boarding: transfers, joined legs and passes are not combined into a total.
use chrono::{Datelike, LocalResult, NaiveDate, TimeZone, Timelike};
use serde_json::{Map, Value, json};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

/// Currency minor-unit scales as ICU publishes them through `Intl` (CLDR
/// digits, which differ from ISO 4217 for several currencies). The fare check
/// keeps this sorted table equal to the JavaScript runtime's.
#[rustfmt::skip]
pub(crate) const CURRENCY_DIGITS: &[(&str, u8)] = &[
    ("AED", 2), ("AFN", 0), ("ALL", 0), ("AMD", 2), ("ANG", 2), ("AOA", 2),
    ("ARS", 2), ("AUD", 2), ("AWG", 2), ("AZN", 2), ("BAM", 2), ("BBD", 2),
    ("BDT", 2), ("BGN", 2), ("BHD", 3), ("BIF", 0), ("BMD", 2), ("BND", 2),
    ("BOB", 2), ("BRL", 2), ("BSD", 2), ("BTN", 2), ("BWP", 2), ("BYN", 2),
    ("BZD", 2), ("CAD", 2), ("CDF", 2), ("CHF", 2), ("CLP", 0), ("CNY", 2),
    ("COP", 0), ("CRC", 2), ("CUC", 2), ("CUP", 2), ("CVE", 2), ("CZK", 2),
    ("DJF", 0), ("DKK", 2), ("DOP", 2), ("DZD", 2), ("EGP", 2), ("ERN", 2),
    ("ETB", 2), ("EUR", 2), ("FJD", 2), ("FKP", 2), ("GBP", 2), ("GEL", 2),
    ("GHS", 2), ("GIP", 2), ("GMD", 2), ("GNF", 0), ("GTQ", 2), ("GYD", 2),
    ("HKD", 2), ("HNL", 2), ("HRK", 2), ("HTG", 2), ("HUF", 0), ("IDR", 0),
    ("ILS", 2), ("INR", 2), ("IQD", 0), ("IRR", 0), ("ISK", 0), ("JMD", 2),
    ("JOD", 3), ("JPY", 0), ("KES", 2), ("KGS", 2), ("KHR", 2), ("KMF", 0),
    ("KPW", 0), ("KRW", 0), ("KWD", 3), ("KYD", 2), ("KZT", 2), ("LAK", 0),
    ("LBP", 0), ("LKR", 2), ("LRD", 2), ("LSL", 2), ("LYD", 3), ("MAD", 2),
    ("MDL", 2), ("MGA", 0), ("MKD", 2), ("MMK", 0), ("MNT", 2), ("MOP", 2),
    ("MRU", 2), ("MUR", 2), ("MVR", 2), ("MWK", 2), ("MXN", 2), ("MYR", 2),
    ("MZN", 2), ("NAD", 2), ("NGN", 2), ("NIO", 2), ("NOK", 2), ("NPR", 2),
    ("NZD", 2), ("OMR", 3), ("PAB", 2), ("PEN", 2), ("PGK", 2), ("PHP", 2),
    ("PKR", 0), ("PLN", 2), ("PYG", 0), ("QAR", 2), ("RON", 2), ("RSD", 2),
    ("RUB", 2), ("RWF", 0), ("SAR", 2), ("SBD", 2), ("SCR", 2), ("SDG", 2),
    ("SEK", 2), ("SGD", 2), ("SHP", 2), ("SLE", 2), ("SLL", 0), ("SOS", 0),
    ("SRD", 2), ("SSP", 2), ("STN", 2), ("SVC", 2), ("SYP", 0), ("SZL", 2),
    ("THB", 2), ("TJS", 2), ("TMT", 2), ("TND", 3), ("TOP", 2), ("TRY", 2),
    ("TTD", 2), ("TWD", 2), ("TZS", 2), ("UAH", 2), ("UGX", 0), ("USD", 2),
    ("UYU", 2), ("UZS", 2), ("VES", 2), ("VND", 0), ("VUV", 0), ("WST", 2),
    ("XAF", 0), ("XCD", 2), ("XCG", 2), ("XDR", 2), ("XOF", 0), ("XPF", 0),
    ("XSU", 2), ("YER", 0), ("ZAR", 2), ("ZMW", 2), ("ZWG", 2), ("ZWL", 2),
];

const MESSAGES: [(&str, &str); 4] = [
    (
        "invalid_data",
        "The saved fare data is incomplete or inconsistent.",
    ),
    (
        "no_rule",
        "No published boarding fare matches this route and these stops.",
    ),
    (
        "schedule_unresolved",
        "A scheduled boarding time is needed for this fare.",
    ),
    (
        "unsupported_rule",
        "These fare conditions cannot yet be priced.",
    ),
];
const WEEKDAYS: [&str; 7] = [
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
];
const MAXIMUM_SAFE_INTEGER: f64 = 9_007_199_254_740_991.;
const CACHE_ENTRIES: usize = 1024;

fn currency_digits(currency: &str) -> Option<usize> {
    CURRENCY_DIGITS
        .binary_search_by(|(code, _)| code.cmp(&currency))
        .ok()
        .map(|i| usize::from(CURRENCY_DIGITS[i].1))
}

fn decimal_digits(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit())
}

/// JavaScript's String(value) for the catalog's CSV scalars.
fn js_text(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

/// JavaScript truthiness of a catalog field.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

fn field<'a>(row: &'a Value, key: &str) -> &'a Value {
    row.get(key).unwrap_or(&Value::Null)
}

/// `row[key] || ''`, the key used to group or index a catalog table.
fn key_of(row: &Value, key: &str) -> String {
    let value = field(row, key);
    if truthy(value) {
        js_text(value)
    } else {
        String::new()
    }
}

/// A raw field used directly as a Map key: absent values match nothing.
fn raw_key(row: &Value, key: &str) -> Option<String> {
    row.get(key).filter(|v| !v.is_null()).map(js_text)
}

fn text_is(row: &Value, key: &str, expected: &str) -> bool {
    field(row, key).as_str() == Some(expected)
}

/// Validate decimal text in minor units before converting it to a number.
/// Rounding a malformed price would turn invalid evidence into another fare.
pub(crate) fn parse_fare_amount(amount: &Value, currency: &Value) -> Option<f64> {
    let digits = currency_digits(currency.as_str()?)?;
    let text = js_text(amount);
    let (whole, fraction) = text.split_once('.').unwrap_or((text.as_str(), ""));
    if text.len() > 32
        || !decimal_digits(whole)
        || (text.contains('.') && !decimal_digits(fraction))
    {
        return None;
    }
    let whole_amount: f64 = whole.parse().ok()?;
    // Exact whole-unit prices need no minor-unit arithmetic.
    if whole_amount <= (MAXIMUM_SAFE_INTEGER / 10_000.).floor()
        && !fraction.bytes().any(|b| (b'1'..=b'9').contains(&b))
    {
        return Some(whole_amount);
    }
    if fraction.len() > digits && fraction[digits..].bytes().any(|b| b != b'0') {
        return None;
    }
    let mut minor = whole.to_owned();
    minor.push_str(&fraction[..fraction.len().min(digits)]);
    minor.extend(std::iter::repeat_n(
        '0',
        digits.saturating_sub(fraction.len()),
    ));
    let units: f64 = minor.parse().ok()?;
    if units.fract() != 0. || units.abs() > MAXIMUM_SAFE_INTEGER {
        return None;
    }
    let number = units / 10_f64.powi(digits as i32);
    // The stored decimal must reproduce the published minor units exactly.
    let stored = number.to_string();
    let (stored_whole, stored_fraction) = stored.split_once('.').unwrap_or((stored.as_str(), ""));
    let mut stored_minor = stored_whole.to_owned();
    stored_minor.push_str(stored_fraction);
    stored_minor.extend(std::iter::repeat_n(
        '0',
        digits.saturating_sub(stored_fraction.len()),
    ));
    (stored_minor.parse::<f64>().ok()? == units).then_some(number)
}

/// A whole-unit amount is an integer in JSON in every runtime.
fn amount_value(amount: f64) -> Value {
    if amount.fract() == 0. && amount.abs() <= MAXIMUM_SAFE_INTEGER {
        json!(amount as i64)
    } else {
        json!(amount)
    }
}

fn canonical_ipv4(host: &str) -> bool {
    let parts: Vec<_> = host.split('.').collect();
    parts.len() == 4
        && parts.iter().all(|p| {
            decimal_digits(p)
                && p.len() <= 3
                && (p.len() == 1 || !p.starts_with('0'))
                && p.parse::<u16>().is_ok_and(|v| v <= 255)
        })
}

/// A public agency fare link: a plain http(s) URL without credentials. Scheme
/// and host are lowercased, a default port removed, an empty path becomes "/"
/// and a query apostrophe is escaped. Anything needing further URL
/// normalization is withheld rather than guessed.
pub(crate) fn public_fare_url(text: &str) -> Option<String> {
    let text = text.trim_matches(|c: char| c <= ' ');
    if text.is_empty()
        || !text.is_ascii()
        || text.bytes().any(|b| {
            b <= b' '
                || b == 0x7f
                || matches!(
                    b,
                    b'\\' | b'"' | b'<' | b'>' | b'`' | b'{' | b'}' | b'|' | b'^'
                )
        })
    {
        return None;
    }
    let (scheme, rest) = text.split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    let default_port = match scheme.as_str() {
        "http" => 80,
        "https" => 443,
        _ => return None,
    };
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(end);
    if authority.contains(['@', '[', ']']) {
        return None;
    }
    let (host, port) = match authority.rsplit_once(':') {
        Some((host, port)) => (host, Some(port)),
        None => (authority, None),
    };
    let last_label = host.trim_end_matches('.').rsplit('.').next().unwrap_or("");
    if host.is_empty()
        || !host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
        || (decimal_digits(last_label) && !canonical_ipv4(host))
    {
        return None;
    }
    let port = match port {
        None | Some("") => None,
        Some(port) if decimal_digits(port) && port.len() <= 5 => {
            let number: u32 = port.parse().ok()?;
            if number > 65_535 {
                return None;
            }
            (number != default_port).then_some(number)
        }
        Some(_) => return None,
    };
    let path_end = tail.find(['?', '#']).unwrap_or(tail.len());
    let (path, after) = tail.split_at(path_end);
    let dot = |segment: &str| {
        let lower = segment.to_ascii_lowercase();
        matches!(
            lower.as_str(),
            "." | ".." | "%2e" | ".%2e" | "%2e." | "%2e%2e"
        )
    };
    if path.split('/').any(dot) {
        return None;
    }
    let mut href = format!("{scheme}://{}", host.to_ascii_lowercase());
    if let Some(port) = port {
        href.push_str(&format!(":{port}"));
    }
    href.push_str(if path.is_empty() { "/" } else { path });
    let (query, fragment) = match after.find('#') {
        Some(index) => after.split_at(index),
        None => (after, ""),
    };
    href.push_str(&query.replace('\'', "%27"));
    href.push_str(fragment);
    Some(href)
}

/// The civil date, weekday and local clock of an event on a GTFS service day.
/// Service clocks count from local noon minus twelve hours, which is not civil
/// midnight on daylight-saving transition days.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct FareEventDay {
    pub date: String,
    pub weekday: &'static str,
    pub seconds: u32,
}

pub(crate) fn fare_event_day(
    service_date: &str,
    service_seconds: f64,
    agency_timezone: &str,
    event_timezone: &str,
) -> Option<FareEventDay> {
    let b = service_date.as_bytes();
    if b.len() != 10
        || b[4] != b'-'
        || b[7] != b'-'
        || !b
            .iter()
            .enumerate()
            .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
        || !service_seconds.is_finite()
        || service_seconds < 0.
    {
        return None;
    }
    let agency: chrono_tz::Tz = agency_timezone.parse().ok()?;
    let event: chrono_tz::Tz = event_timezone.parse().ok()?;
    // The shape is validated above: read the digits rather than reparsing a
    // format. Impossible calendar dates still yield None.
    let number = |range: std::ops::Range<usize>| {
        b[range]
            .iter()
            .fold(0_u32, |value, digit| value * 10 + u32::from(digit - b'0'))
    };
    let date = NaiveDate::from_ymd_opt(number(0..4) as i32, number(5..7), number(8..10))?;
    let LocalResult::Single(noon) = agency.from_local_datetime(&date.and_hms_opt(12, 0, 0)?) else {
        return None;
    };
    let anchor = noon.timestamp_millis() - 12 * 3_600_000;
    let instant = (anchor as f64 + service_seconds * 1000.).trunc() as i64;
    let civil = chrono::DateTime::from_timestamp_millis(instant)?.with_timezone(&event);
    Some(FareEventDay {
        date: format!("{:04}{:02}{:02}", civil.year(), civil.month(), civil.day()),
        weekday: WEEKDAYS[civil.weekday().num_days_from_monday() as usize],
        seconds: civil.hour() * 3600 + civil.minute() * 60 + civil.second(),
    })
}

/// A GTFS timeframe clock; empty text uses the fallback, invalid text fails.
fn fare_clock_seconds(value: &Value, fallback: u32) -> Option<u32> {
    if !truthy(value) {
        return Some(fallback);
    }
    let text = js_text(value);
    let b = text.as_bytes();
    if b.len() != 8
        || b[2] != b':'
        || b[5] != b':'
        || !b
            .iter()
            .enumerate()
            .all(|(i, c)| i == 2 || i == 5 || c.is_ascii_digit())
    {
        return None;
    }
    let part = |i: usize| u32::from(b[i] - b'0') * 10 + u32::from(b[i + 1] - b'0');
    let (h, m, s) = (part(0), part(3), part(6));
    (h <= 24 && m < 60 && s < 60 && (h < 24 || m + s == 0)).then_some(h * 3600 + m * 60 + s)
}

fn unavailable(code: &str, reason: Option<&Value>) -> Value {
    let message = MESSAGES
        .iter()
        .find(|(c, _)| *c == code)
        .map_or("", |(_, m)| m);
    json!({"status":"unavailable","code":code,"reason":reason.cloned().unwrap_or_else(|| json!(message))})
}

fn rows(tables: &Map<String, Value>, name: &str) -> Vec<Value> {
    tables
        .get(name)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn group(rows: &[Value], key: &str) -> HashMap<String, Vec<usize>> {
    let mut groups: HashMap<String, Vec<usize>> = HashMap::new();
    for (index, row) in rows.iter().enumerate() {
        groups.entry(key_of(row, key)).or_default().push(index);
    }
    groups
}

fn unique(rows: &[Value], key: &str) -> Option<HashMap<String, usize>> {
    let mut unique = HashMap::new();
    for (index, row) in rows.iter().enumerate() {
        if unique.insert(key_of(row, key), index).is_some() {
            return None;
        }
    }
    Some(unique)
}

struct StopReference {
    areas: HashSet<String>,
    timezone: String,
    zone: Value,
}

struct Candidate {
    agency: usize,
    from: StopReference,
    to: StopReference,
    rules: Vec<usize>,
    timed: bool,
}

/// Immutable indexes over one catalog snapshot.
struct Index {
    v2: bool,
    priority: bool,
    agency: Vec<Value>,
    routes: Vec<Value>,
    stops: Vec<Value>,
    stop_areas: Vec<Value>,
    route_networks: Vec<Value>,
    leg_rules: Vec<Value>,
    v1_rules_table: Vec<Value>,
    attributes: Vec<Value>,
    timeframes: Vec<Value>,
    calendar_rows: Vec<Value>,
    calendar_date_rows: Vec<Value>,
    route_index: HashMap<String, usize>,
    stop_index: HashMap<String, usize>,
    agency_index: HashMap<String, usize>,
    areas: HashMap<String, Vec<usize>>,
    networks: HashMap<String, Vec<usize>>,
    rules: HashMap<String, Vec<usize>>,
    v1_rules: HashMap<String, Vec<usize>>,
    products: HashMap<String, Option<Vec<Value>>>,
    frames: HashMap<String, Vec<usize>>,
    calendar: HashMap<String, usize>,
    exceptions: HashMap<String, HashMap<String, usize>>,
    mentioned: [HashSet<String>; 3],
}

impl Index {
    fn build(catalog: &Value) -> Option<Self> {
        if catalog["version"] != 1 {
            return None;
        }
        let tables = catalog["tables"].as_object()?;
        let leg_rules = rows(tables, "fare_leg_rules");
        let categories_rows = rows(tables, "rider_categories");
        let media_rows = rows(tables, "fare_media");
        let categories = unique(&categories_rows, "rider_category_id")?;
        let media = unique(&media_rows, "fare_media_id")?;
        let calendar_date_rows = rows(tables, "calendar_dates");
        let mut exceptions = HashMap::new();
        for (service, members) in group(&calendar_date_rows, "service_id") {
            let mut dates = HashMap::new();
            for index in members {
                if dates
                    .insert(key_of(&calendar_date_rows[index], "date"), index)
                    .is_some()
                {
                    return None;
                }
            }
            exceptions.insert(service, dates);
        }
        let mentioned = ["network_id", "from_area_id", "to_area_id"].map(|f| {
            leg_rules
                .iter()
                .map(|row| field(row, f))
                .filter(|v| truthy(v))
                .map(js_text)
                .collect()
        });
        let product_rows = rows(tables, "fare_products");
        let mut order: Vec<String> = vec![];
        let mut members: HashMap<String, Vec<usize>> = HashMap::new();
        for (index, row) in product_rows.iter().enumerate() {
            let id = key_of(row, "fare_product_id");
            members
                .entry(id.clone())
                .or_insert_with(|| {
                    order.push(id);
                    vec![]
                })
                .push(index);
        }
        let category_of = |row: &Value| {
            truthy(field(row, "rider_category_id"))
                .then(|| js_text(field(row, "rider_category_id")))
        };
        let mut products = HashMap::new();
        for id in order {
            let group: Vec<&Value> = members[&id].iter().map(|&i| &product_rows[i]).collect();
            let defaults: HashSet<String> = group
                .iter()
                .filter_map(|row| category_of(row))
                .filter(|c| {
                    categories.get(c).is_some_and(|&i| {
                        text_is(&categories_rows[i], "is_default_fare_category", "1")
                    })
                })
                .collect();
            let selected: Vec<&Value> = group
                .iter()
                .copied()
                .filter(|row| category_of(row).is_none_or(|c| defaults.contains(&c)))
                .collect();
            let mut invalid = group
                .iter()
                .any(|row| category_of(row).is_some_and(|c| !categories.contains_key(&c)))
                || defaults.len() > 1
                || selected.is_empty();
            let mut variants: Vec<(String, Value)> = vec![];
            for row in selected {
                let amount = parse_fare_amount(field(row, "amount"), field(row, "currency"));
                let medium = truthy(field(row, "fare_media_id"))
                    .then(|| js_text(field(row, "fare_media_id")));
                let rider = category_of(row);
                let mut option = Map::new();
                option.insert("productId".into(), json!(id));
                let name = field(row, "fare_product_name");
                option.insert(
                    "name".into(),
                    if truthy(name) {
                        name.clone()
                    } else {
                        json!("Published fare")
                    },
                );
                option.insert("amount".into(), amount.map_or(Value::Null, amount_value));
                if let Some(currency) = row.get("currency") {
                    option.insert("currency".into(), currency.clone());
                }
                let medium_name = medium
                    .as_ref()
                    .and_then(|m| media.get(m))
                    .map(|&i| field(&media_rows[i], "fare_media_name"))
                    .filter(|v| truthy(v))
                    .cloned();
                option.insert("media".into(), medium_name.unwrap_or_else(|| json!("")));
                let rider_name = rider.as_ref().map(|c| {
                    categories
                        .get(c)
                        .map(|&i| field(&categories_rows[i], "rider_category_name"))
                        .filter(|v| truthy(v))
                        .cloned()
                        .unwrap_or_else(|| json!(c))
                });
                option.insert(
                    "riderCategory".into(),
                    rider_name.unwrap_or_else(|| json!("")),
                );
                let key = format!(
                    "{}\u{0}{}",
                    medium.clone().unwrap_or_default(),
                    rider.unwrap_or_default()
                );
                let duplicate = variants.iter().position(|(k, _)| *k == key);
                if duplicate.is_some()
                    || amount.is_none()
                    || medium.as_ref().is_some_and(|m| !media.contains_key(m))
                {
                    invalid = true;
                }
                match duplicate {
                    Some(position) => variants[position].1 = Value::Object(option),
                    None => variants.push((key, Value::Object(option))),
                }
            }
            products.insert(
                id,
                (!invalid).then(|| variants.into_iter().map(|(_, v)| v).collect()),
            );
        }
        let agency = rows(tables, "agency");
        let routes = rows(tables, "routes");
        let stops = rows(tables, "stops");
        let stop_areas = rows(tables, "stop_areas");
        let route_networks = rows(tables, "route_networks");
        let v1_rules_table = rows(tables, "fare_rules");
        let timeframes = rows(tables, "timeframes");
        let calendar_rows = rows(tables, "calendar");
        Some(Self {
            v2: tables.contains_key("fare_products"),
            priority: leg_rules
                .iter()
                .any(|row| row.get("rule_priority").is_some()),
            route_index: unique(&routes, "route_id")?,
            stop_index: unique(&stops, "stop_id")?,
            agency_index: unique(&agency, "agency_id")?,
            areas: group(&stop_areas, "stop_id"),
            networks: group(&route_networks, "route_id"),
            rules: group(&leg_rules, "network_id"),
            v1_rules: group(&v1_rules_table, "fare_id"),
            products,
            frames: group(&timeframes, "timeframe_group_id"),
            calendar: unique(&calendar_rows, "service_id")?,
            exceptions,
            mentioned,
            agency,
            routes,
            stops,
            stop_areas,
            route_networks,
            leg_rules,
            v1_rules_table,
            attributes: rows(tables, "fare_attributes"),
            timeframes,
            calendar_rows,
            calendar_date_rows,
        })
    }

    fn reference(&self, id: &str) -> Option<StopReference> {
        let stop = &self.stops[*self.stop_index.get(id)?];
        let parent_station = field(stop, "parent_station");
        // Explicit platform membership replaces inherited station membership.
        let areas = self
            .areas
            .get(id)
            .or_else(|| raw_key(stop, "parent_station").and_then(|p| self.areas.get(&p)));
        // A child's timezone is ignored when it belongs to a parent station.
        let timezone = if truthy(parent_station) {
            self.stop_index
                .get(&js_text(parent_station))
                .map(|&p| field(&self.stops[p], "stop_timezone"))
                .filter(|v| truthy(v))
                .map(js_text)
                .unwrap_or_default()
        } else {
            Some(field(stop, "stop_timezone"))
                .filter(|v| truthy(v))
                .map(js_text)
                .unwrap_or_default()
        };
        Some(StopReference {
            areas: areas
                .map(|members| {
                    members
                        .iter()
                        .map(|&i| js_text(field(&self.stop_areas[i], "area_id")))
                        .collect()
                })
                .unwrap_or_default(),
            timezone,
            zone: field(stop, "zone_id").clone(),
        })
    }

    fn candidate(&self, leg: &FareLeg) -> Result<Candidate, &'static str> {
        let (Some(&route), Some(from), Some(to)) = (
            self.route_index.get(leg.route_id),
            self.reference(leg.from_stop_id),
            self.reference(leg.to_stop_id),
        ) else {
            return Err("no_rule");
        };
        let route = &self.routes[route];
        let agency = if truthy(field(route, "agency_id")) {
            self.agency_index
                .get(&js_text(field(route, "agency_id")))
                .copied()
        } else if self.agency_index.len() == 1 {
            self.agency_index.values().next().copied()
        } else {
            None
        };
        let agency = agency.ok_or("invalid_data")?;
        if !self.v2 {
            return Ok(Candidate {
                agency,
                from,
                to,
                rules: vec![],
                timed: false,
            });
        }
        let assignments = self
            .networks
            .get(leg.route_id)
            .map_or(&[][..], Vec::as_slice);
        if assignments.len() > 1 || (!assignments.is_empty() && route.get("network_id").is_some()) {
            return Err("invalid_data");
        }
        let network = assignments
            .first()
            .map(|&i| field(&self.route_networks[i], "network_id"))
            .filter(|v| truthy(v))
            .or_else(|| Some(field(route, "network_id")).filter(|v| truthy(v)))
            .map(js_text)
            .unwrap_or_default();
        let mut selected: Vec<usize> = vec![];
        if !network.is_empty() {
            selected.extend(self.rules.get(&network).into_iter().flatten());
        }
        if self.priority || !self.mentioned[0].contains(&network) {
            selected.extend(self.rules.get("").into_iter().flatten());
        }
        let rules: Vec<usize> = selected
            .into_iter()
            .filter(|&r| {
                let rule = &self.leg_rules[r];
                [
                    (1, "from_area_id", &from.areas),
                    (2, "to_area_id", &to.areas),
                ]
                .iter()
                .all(|(m, key, values)| {
                    let value = field(rule, key);
                    if truthy(value) {
                        values.contains(&js_text(value))
                    } else {
                        self.priority || !values.iter().any(|v| self.mentioned[*m].contains(v))
                    }
                })
            })
            .collect();
        let timed = rules.iter().any(|&r| {
            let rule = &self.leg_rules[r];
            truthy(field(rule, "from_timeframe_group_id"))
                || truthy(field(rule, "to_timeframe_group_id"))
        });
        Ok(Candidate {
            agency,
            from,
            to,
            rules,
            timed,
        })
    }

    fn timeframe_matches(&self, group: &Value, day: Option<&FareEventDay>) -> Option<bool> {
        if !truthy(group) {
            return Some(true);
        }
        let frames = self.frames.get(&js_text(group)).filter(|f| !f.is_empty())?;
        let day = day?;
        let mut matched = false;
        for &f in frames {
            let frame = &self.timeframes[f];
            let start = fare_clock_seconds(field(frame, "start_time"), 0)?;
            let end = fare_clock_seconds(field(frame, "end_time"), 86_400)?;
            if start >= end
                || truthy(field(frame, "start_time")) != truthy(field(frame, "end_time"))
            {
                return None;
            }
            let service = raw_key(frame, "service_id");
            let dates = service.as_ref().and_then(|s| self.exceptions.get(s));
            let exception = dates
                .and_then(|d| d.get(&day.date))
                .map(|&i| &self.calendar_date_rows[i]);
            let calendar = service
                .as_ref()
                .and_then(|s| self.calendar.get(s))
                .map(|&i| &self.calendar_rows[i]);
            if calendar.is_none() && dates.is_none() {
                return None;
            }
            if exception.is_some_and(|e| {
                !text_is(e, "exception_type", "1") && !text_is(e, "exception_type", "2")
            }) {
                return None;
            }
            let active = match exception {
                Some(exception) => text_is(exception, "exception_type", "1"),
                None => calendar.is_some_and(|c| {
                    js_text(field(c, "start_date")).as_str() <= day.date.as_str()
                        && js_text(field(c, "end_date")).as_str() >= day.date.as_str()
                        && text_is(c, day.weekday, "1")
                }),
            };
            if active && day.seconds >= start && day.seconds < end {
                matched = true;
            }
        }
        Some(matched)
    }

    fn v2_options<'a>(
        &'a self,
        candidate: &Candidate,
        leg: &FareLeg,
        service_date: &str,
    ) -> Result<Vec<Value>, &'static str> {
        if candidate.timed && leg.realtime_adjusted {
            return Err("schedule_unresolved");
        }
        let agency_timezone = js_text(field(&self.agency[candidate.agency], "agency_timezone"));
        let event_day = |seconds: f64, stop: &StopReference| {
            let zone = if stop.timezone.is_empty() {
                agency_timezone.as_str()
            } else {
                stop.timezone.as_str()
            };
            fare_event_day(service_date, seconds, &agency_timezone, zone)
        };
        let (start, end) = if candidate.timed {
            let start = event_day(leg.departure_seconds, &candidate.from);
            let end = event_day(leg.arrival_seconds, &candidate.to);
            if start.is_none() || end.is_none() {
                return Err("schedule_unresolved");
            }
            (start, end)
        } else {
            (None, None)
        };
        // Rules share a handful of timeframe groups. Key the memo by the
        // group text the rule already holds instead of allocating per rule.
        let mut memo: Vec<(bool, std::borrow::Cow<'a, str>, Option<bool>)> = Vec::new();
        let mut applicable = vec![];
        for &r in &candidate.rules {
            let rule = &self.leg_rules[r];
            let mut test = |to: bool, group: &'a Value, day: Option<&FareEventDay>| {
                let key = match group {
                    Value::String(text) => std::borrow::Cow::Borrowed(text.as_str()),
                    other if truthy(other) => std::borrow::Cow::Owned(js_text(other)),
                    _ => std::borrow::Cow::Borrowed(""),
                };
                if let Some((_, _, matched)) = memo
                    .iter()
                    .find(|(side, known, _)| *side == to && *known == key)
                {
                    return *matched;
                }
                let matched = self.timeframe_matches(group, day);
                memo.push((to, key, matched));
                matched
            };
            let from_match = test(
                false,
                field(rule, "from_timeframe_group_id"),
                start.as_ref(),
            );
            let to_match = test(true, field(rule, "to_timeframe_group_id"), end.as_ref());
            match (from_match, to_match) {
                (Some(a), Some(b)) => {
                    if a && b {
                        applicable.push(r);
                    }
                }
                _ => return Err("invalid_data"),
            }
        }
        if self.priority && !applicable.is_empty() {
            let priority = |r: usize| {
                let value = field(&self.leg_rules[r], "rule_priority");
                if !truthy(value) {
                    return Some(0.);
                }
                let text = js_text(value);
                decimal_digits(&text)
                    .then(|| text.parse::<f64>().ok())
                    .flatten()
                    .filter(|v| *v <= MAXIMUM_SAFE_INTEGER)
            };
            if applicable.iter().any(|&r| priority(r).is_none()) {
                return Err("invalid_data");
            }
            let highest = applicable
                .iter()
                .map(|&r| priority(r).unwrap())
                .fold(f64::MIN, f64::max);
            applicable.retain(|&r| priority(r) == Some(highest));
        }
        if applicable.iter().any(|&r| {
            let value = field(&self.leg_rules[r], "transfer_only");
            truthy(value) && !(value.as_str() == Some("0") || value.as_str() == Some("1"))
        }) {
            return Err("unsupported_rule");
        }
        let mut ids: Vec<Option<String>> = vec![];
        for &r in &applicable {
            let rule = &self.leg_rules[r];
            if field(rule, "transfer_only").as_str() != Some("1") {
                let id = raw_key(rule, "fare_product_id");
                if !ids.contains(&id) {
                    ids.push(id);
                }
            }
        }
        let mut options = vec![];
        for id in ids {
            match id.and_then(|id| self.products.get(&id)) {
                Some(Some(product)) => options.extend(product.iter().cloned()),
                _ => return Err("invalid_data"),
            }
        }
        Ok(options)
    }

    fn v1_options(&self, candidate: &Candidate, leg: &FareLeg) -> Result<Vec<Value>, &'static str> {
        let agency_id = field(&self.agency[candidate.agency], "agency_id");
        let mut options = vec![];
        for fare in &self.attributes {
            let skip = if truthy(field(fare, "agency_id")) {
                field(fare, "agency_id") != agency_id
            } else {
                self.agency_index.len() > 1
            };
            if skip {
                continue;
            }
            let rules = raw_key(fare, "fare_id")
                .and_then(|id| self.v1_rules.get(&id))
                .map_or(&[][..], Vec::as_slice);
            let matching: Vec<&Value> = rules
                .iter()
                .map(|&i| &self.v1_rules_table[i])
                .filter(|rule| {
                    (!truthy(field(rule, "route_id"))
                        || field(rule, "route_id").as_str() == Some(leg.route_id))
                        && (!truthy(field(rule, "origin_id"))
                            || field(rule, "origin_id") == &candidate.from.zone)
                        && (!truthy(field(rule, "destination_id"))
                            || field(rule, "destination_id") == &candidate.to.zone)
                })
                .collect();
            if !rules.is_empty() && matching.is_empty() {
                continue;
            }
            if matching
                .iter()
                .any(|rule| truthy(field(rule, "contains_id")))
            {
                return Err("unsupported_rule");
            }
            let amount = parse_fare_amount(field(fare, "price"), field(fare, "currency_type"));
            let method = field(fare, "payment_method").as_str();
            let (Some(amount), Some("0" | "1")) = (amount, method) else {
                return Err("invalid_data");
            };
            let mut option = Map::new();
            option.insert("productId".into(), field(fare, "fare_id").clone());
            option.insert("name".into(), json!("Published fare"));
            option.insert("amount".into(), amount_value(amount));
            option.insert("currency".into(), field(fare, "currency_type").clone());
            option.insert(
                "media".into(),
                json!(if method == Some("0") {
                    "Pay on board"
                } else {
                    "Pay before boarding"
                }),
            );
            options.push(Value::Object(option));
        }
        Ok(options)
    }
}

/// One ride to price, with feed-local identifiers. Service seconds are the
/// scheduled boarding and alighting clocks of the ride's service day.
pub(crate) struct FareLeg<'a> {
    pub route_id: &'a str,
    pub from_stop_id: &'a str,
    pub to_stop_id: &'a str,
    pub departure_seconds: f64,
    pub arrival_seconds: f64,
    pub realtime_adjusted: bool,
}

/// An imported catalog with derived indexes and bounded reuse of results.
pub(crate) struct FareEngine {
    #[cfg_attr(feature = "node", allow(dead_code))]
    catalog_bytes: usize,
    source: Option<Value>,
    unavailable_reason: Option<Value>,
    index: Option<Index>,
    candidates: HashMap<(String, String, String), Result<Arc<Candidate>, &'static str>>,
    quotes: HashMap<String, Value>,
}

impl FareEngine {
    pub(crate) fn new(catalog: &Value) -> Self {
        Self {
            catalog_bytes: 0,
            source: catalog.get("source").cloned(),
            unavailable_reason: catalog
                .get("unavailableReason")
                .filter(|v| truthy(v))
                .cloned(),
            index: Index::build(catalog),
            candidates: HashMap::new(),
            quotes: HashMap::new(),
        }
    }

    /// A catalog saved as JSON; unreadable data quotes as unavailable.
    pub(crate) fn from_json(text: &str) -> Self {
        let catalog = (text.len() <= 16 * 1024 * 1024)
            .then(|| serde_json::from_str::<Value>(text).ok())
            .flatten()
            .filter(|c| c["version"] == 1 && c["tables"].is_object())
            .unwrap_or_else(|| json!({"version":1,"tables":{},
                "unavailableReason":"The saved fare data could not be read. Your route is still available."}));
        Self {
            catalog_bytes: text.len(),
            ..Self::new(&catalog)
        }
    }

    /// A conservative resident size: parsed rows and indexes of the saved JSON.
    #[cfg_attr(feature = "node", allow(dead_code))]
    pub(crate) fn estimated_bytes(&self) -> usize {
        self.catalog_bytes * 4 + (self.candidates.len() + self.quotes.len()) * 256
    }

    /// Whether the catalog can be priced at all.
    #[cfg_attr(not(feature = "node"), allow(dead_code))]
    pub(crate) fn usable(&self) -> bool {
        self.unavailable_reason.is_none() && self.index.is_some()
    }

    fn candidate(&mut self, leg: &FareLeg) -> Result<Arc<Candidate>, &'static str> {
        let key = (
            leg.route_id.to_owned(),
            leg.from_stop_id.to_owned(),
            leg.to_stop_id.to_owned(),
        );
        if let Some(candidate) = self.candidates.get(&key) {
            return candidate.clone();
        }
        let candidate = self
            .index
            .as_ref()
            .ok_or("invalid_data")?
            .candidate(leg)
            .map(Arc::new);
        if self.candidates.len() >= CACHE_ENTRIES {
            self.candidates.clear();
        }
        self.candidates.insert(key, candidate.clone());
        candidate
    }

    /// Whether this ride's fare depends on its scheduled clock time.
    #[cfg_attr(not(feature = "node"), allow(dead_code))]
    pub(crate) fn needs_scheduled_time(&mut self, leg: &FareLeg) -> bool {
        self.index.as_ref().is_some_and(|i| i.v2) && self.candidate(leg).is_ok_and(|c| c.timed)
    }

    /// The published boarding fare options for one ride, or why none applies.
    pub(crate) fn quote(&mut self, leg: &FareLeg, service_date: &str) -> Value {
        if let Some(reason) = &self.unavailable_reason {
            return unavailable("unsupported_rule", Some(&json!(js_text(reason))));
        }
        let Some(v2) = self.index.as_ref().map(|i| i.v2) else {
            return unavailable("invalid_data", None);
        };
        let candidate = match self.candidate(leg) {
            Ok(candidate) => candidate,
            Err(code) => return unavailable(code, None),
        };
        let key = if candidate.timed {
            format!(
                "{}\u{0}{}\u{0}{}\u{0}{service_date}\u{0}{}\u{0}{}\u{0}{}",
                leg.route_id,
                leg.from_stop_id,
                leg.to_stop_id,
                leg.departure_seconds,
                leg.arrival_seconds,
                leg.realtime_adjusted
            )
        } else {
            format!(
                "{}\u{0}{}\u{0}{}",
                leg.route_id, leg.from_stop_id, leg.to_stop_id
            )
        };
        if let Some(quote) = self.quotes.get(&key) {
            return quote.clone();
        }
        let index = self.index.as_ref().unwrap();
        let options = if v2 {
            index.v2_options(&candidate, leg, service_date)
        } else {
            index.v1_options(&candidate, leg)
        };
        let result = match options {
            Err(code) => unavailable(code, None),
            Ok(options) if options.is_empty() => unavailable("no_rule", None),
            Ok(options) => {
                let mut published = Map::new();
                published.insert("status".into(), json!("published"));
                if let Some(source) = &self.source {
                    published.insert("source".into(), source.clone());
                }
                published.insert(
                    "standard".into(),
                    json!(if v2 { "GTFS Fares v2" } else { "GTFS Fares v1" }),
                );
                published.insert("options".into(), Value::Array(options));
                if let Some(url) = field(&index.agency[candidate.agency], "agency_fare_url")
                    .as_str()
                    .and_then(public_fare_url)
                {
                    published.insert("agencyUrl".into(), json!(url));
                }
                Value::Object(published)
            }
        };
        if self.quotes.len() >= CACHE_ENTRIES {
            self.quotes.clear();
        }
        self.quotes.insert(key, result.clone());
        result
    }
}

#[cfg(feature = "node")]
pub(crate) mod node {
    use super::*;
    use napi_derive::napi;

    /// The shared fare engine for one saved catalog, used by the Node runtime.
    #[napi(js_name = "FareCatalog")]
    pub struct NativeFareCatalog {
        engine: FareEngine,
    }

    #[napi]
    impl NativeFareCatalog {
        #[napi(constructor)]
        pub fn new(json: String) -> Self {
            Self {
                engine: FareEngine::from_json(&json),
            }
        }

        #[napi]
        pub fn usable(&self) -> bool {
            self.engine.usable()
        }

        #[napi]
        pub fn needs_scheduled_time(
            &mut self,
            route_id: String,
            from_stop_id: String,
            to_stop_id: String,
        ) -> bool {
            self.engine.needs_scheduled_time(&FareLeg {
                route_id: &route_id,
                from_stop_id: &from_stop_id,
                to_stop_id: &to_stop_id,
                departure_seconds: 0.,
                arrival_seconds: 0.,
                realtime_adjusted: false,
            })
        }

        /// The quote as JSON, shared byte-for-byte with the standalone runtime.
        #[napi]
        #[allow(clippy::too_many_arguments)]
        pub fn quote(
            &mut self,
            route_id: String,
            from_stop_id: String,
            to_stop_id: String,
            service_date: String,
            departure_seconds: f64,
            arrival_seconds: f64,
            realtime_adjusted: bool,
        ) -> String {
            let leg = FareLeg {
                route_id: &route_id,
                from_stop_id: &from_stop_id,
                to_stop_id: &to_stop_id,
                departure_seconds,
                arrival_seconds,
                realtime_adjusted,
            };
            self.engine.quote(&leg, &service_date).to_string()
        }
    }

    #[napi(object)]
    pub struct FareEventDayResult {
        pub date: String,
        pub weekday: String,
        pub seconds: u32,
    }

    /// Engine primitives exposed for parity checks against the JS runtime.
    #[napi]
    pub fn fare_currency_scales() -> Vec<String> {
        CURRENCY_DIGITS
            .iter()
            .map(|(code, digits)| format!("{code}:{digits}"))
            .collect()
    }

    #[napi]
    pub fn native_parse_fare_amount(amount: String, currency: String) -> Option<f64> {
        parse_fare_amount(&json!(amount), &json!(currency))
    }

    #[napi]
    pub fn native_fare_event_day(
        service_date: String,
        service_seconds: f64,
        agency_timezone: String,
        event_timezone: Option<String>,
    ) -> Option<FareEventDayResult> {
        let event = event_timezone.unwrap_or_else(|| agency_timezone.clone());
        fare_event_day(&service_date, service_seconds, &agency_timezone, &event).map(|day| {
            FareEventDayResult {
                date: day.date,
                weekday: day.weekday.into(),
                seconds: day.seconds,
            }
        })
    }

    #[napi]
    pub fn native_public_fare_url(text: String) -> Option<String> {
        public_fare_url(&text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn currency_table_is_sorted_for_binary_search() {
        assert!(CURRENCY_DIGITS.windows(2).all(|w| w[0].0 < w[1].0));
        assert_eq!(currency_digits("USD"), Some(2));
        assert_eq!(currency_digits("usd"), None);
    }

    #[test]
    fn amounts_keep_published_minor_units() {
        let parse = |a: &str, c: &str| parse_fare_amount(&json!(a), &json!(c));
        assert_eq!(parse("2.400", "USD"), Some(2.4));
        assert_eq!(parse("1.23", "JPY"), None);
        assert_eq!(parse("1.234", "KWD"), Some(1.234));
        assert_eq!(parse("90071992547409.91", "USD"), None);
        for bad in ["", "-1", "1e2", "NaN", "2.", ".2", " 2"] {
            assert_eq!(parse(bad, "USD"), None, "{bad}");
        }
    }

    #[test]
    fn service_day_clocks_follow_local_noon() {
        let day = fare_event_day("2026-03-08", 0., "America/New_York", "America/New_York").unwrap();
        assert_eq!(
            (day.date.as_str(), day.weekday, day.seconds),
            ("20260307", "saturday", 23 * 3600)
        );
        assert_eq!(
            fare_event_day(
                "2026-03-08",
                10_800.,
                "America/New_York",
                "America/New_York"
            )
            .unwrap()
            .seconds,
            3 * 3600
        );
        assert_eq!(
            fare_event_day("2026-11-01", 1_800., "America/New_York", "America/New_York")
                .unwrap()
                .seconds,
            90 * 60
        );
        assert_eq!(
            fare_event_day("2026-11-01", 5_400., "America/New_York", "America/New_York")
                .unwrap()
                .seconds,
            90 * 60
        );
        assert_eq!(
            fare_event_day("2026-09-14", 28_800., "America/New_York", "America/Chicago")
                .unwrap()
                .seconds,
            7 * 3600
        );
        assert!(
            fare_event_day(
                "2026-02-30",
                28_800.,
                "America/New_York",
                "America/New_York"
            )
            .is_none()
        );
        assert!(
            fare_event_day("2026-09-14", 28_800., "not-a-timezone", "not-a-timezone").is_none()
        );
    }

    #[test]
    fn fare_links_are_plain_public_urls() {
        assert_eq!(
            public_fare_url("https://example.com/fares").as_deref(),
            Some("https://example.com/fares")
        );
        assert_eq!(
            public_fare_url(" HTTP://Example.COM:80").as_deref(),
            Some("http://example.com/")
        );
        assert_eq!(
            public_fare_url("https://example.com:8443/a?b='c'#d").as_deref(),
            Some("https://example.com:8443/a?b=%27c%27#d")
        );
        for rejected in [
            "javascript:alert(1)",
            "https://user:pass@example.com/",
            "ftp://example.com/",
            "https://exa mple.com/",
            "https://example.com/../x",
            "http://1.2.3/",
        ] {
            assert!(public_fare_url(rejected).is_none(), "{rejected}");
        }
    }
}
