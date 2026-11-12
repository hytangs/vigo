//! Walking policy and identities that prepared access data is bound to.
//!
//! These values are part of the persisted City: the access context, station
//! paths and timetable snapshots record the policy identity, and readers reject
//! data prepared under another one.
use std::sync::LazyLock;
use vigo_format::js::{self, Js};
use vigo_format::js_math;

pub(crate) const OSM_TRANSFER_SCHEMA: &str = "vigo.routing.osm-stop-transfers.v6";
/// Stored transfer seconds are a topology lower bound; resident stores price
/// the walk from `path_distance_m` with the configured pace.
pub(crate) const OSM_TRANSFER_LOWER_BOUND_KPH: f64 = 8.0;
pub(crate) const WHEELCHAIR_PROFILE: &str = "wheelchair-strict-v1";

pub(crate) struct Policy {
    pub walking_speed_kph: f64,
    pub access_padding_factor: f64,
    pub access_overhead_seconds: f64,
    pub transfer_maximum_walk_m: f64,
    pub transfer_maximum_neighbors: u32,
    /// `stableJson` of the policy object: sorted keys, JavaScript numbers.
    pub identity: String,
    /// The policy object in its published member order.
    pub object: Js,
}

fn environment_number(name: &str) -> Option<f64> {
    let text = std::env::var(name).ok()?;
    // `numeric(process.env[name], fallback)`: an unset variable selects the
    // fallback, while a blank one converts to 0 as Number('') does.
    let number = js_number(&text);
    number.is_finite().then_some(number)
}

/// JavaScript `Number(text)` for decimal, hexadecimal, binary and octal text.
pub(crate) fn js_number(text: &str) -> f64 {
    let trimmed = text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    if trimmed.is_empty() {
        return 0.0;
    }
    let radix = |prefix: &str, radix: u32| {
        trimmed
            .strip_prefix(prefix)
            .or_else(|| trimmed.strip_prefix(&prefix.to_uppercase()))
            .map(|digits| {
                if digits.is_empty() {
                    f64::NAN
                } else {
                    u128::from_str_radix(digits, radix).map_or(f64::NAN, |v| v as f64)
                }
            })
    };
    if let Some(value) = radix("0x", 16)
        .or_else(|| radix("0b", 2))
        .or_else(|| radix("0o", 8))
    {
        return value;
    }
    match trimmed {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    let valid = trimmed
        .trim_start_matches(['+', '-'])
        .chars()
        .all(|c| c.is_ascii_digit() || matches!(c, '.' | 'e' | 'E' | '+' | '-'))
        && !trimmed.contains("inf")
        && !trimmed.to_ascii_lowercase().contains("nan");
    if !valid {
        return f64::NAN;
    }
    trimmed.parse::<f64>().unwrap_or(f64::NAN)
}

pub(crate) static POLICY: LazyLock<Policy> = LazyLock::new(|| {
    let custom = [
        "VIGO_ROUTING_WALK_SPEED_KPH",
        "VIGO_ROUTING_WALK_PADDING_FACTOR",
        "VIGO_ROUTING_WALK_OVERHEAD_SECONDS",
    ]
    .iter()
    .any(|name| std::env::var(name).is_ok_and(|v| !v.trim().is_empty()));
    let bounded = |name: &str, default: f64, min: f64, max: f64| {
        environment_number(name).unwrap_or(default).clamp(min, max)
    };
    let walking_speed_kph = bounded("VIGO_ROUTING_WALK_SPEED_KPH", 4.8, 1.5, 8.0);
    let access_padding_factor = bounded("VIGO_ROUTING_WALK_PADDING_FACTOR", 1.0, 0.75, 3.0);
    let access_overhead_seconds = bounded("VIGO_ROUTING_WALK_OVERHEAD_SECONDS", 0.0, 0.0, 900.0);
    let transfer_maximum_walk_m = bounded("VIGO_ROUTING_TRANSFER_RADIUS_M", 500.0, 50.0, 1_200.0);
    let transfer_maximum_neighbors =
        bounded("VIGO_ROUTING_TRANSFER_MAX_NEIGHBORS", 0.0, 0.0, 4_096.0).floor() as u32;
    let policy = Js::object()
        .with("schemaVersion", "vigo.routing.access-policy.v9")
        .with(
            "id",
            if custom {
                "vigo-national-configured-access"
            } else {
                "vigo-national-regular-access"
            },
        )
        .with("durationModel", "osm-distance-at-configured-walking-speed")
        .with(
            "parentStationTransferMinimums",
            "published-type-2-floors-v1",
        )
        .with("sameStopTransferProhibitionScope", "direct-reboarding-only")
        .with(
            "transferWalkingTimeFloor",
            "distance-at-configured-speed-v1",
        )
        .with("unpricedPathways", "typed-estimates-otherwise-excluded-v2")
        .with(
            "pathwayCostModel",
            Js::object()
                .with("id", "stairs-one-second-per-step-gates-five-seconds-v1")
                .with("secondsPerStair", 1)
                .with("gateSeconds", 5),
        )
        .with("streetAttachment", "nearest-vertex-or-reciprocal-edge-v3")
        .with("stationStreetAnchors", "declared-entrances-v1")
        .with("stationStreetTransfers", "entrance-pathway-chain-v1")
        .with("stationPathDistance", "source-or-located-chord-v1")
        .with("walkingSpeedKph", walking_speed_kph)
        .with("accessPaddingFactor", access_padding_factor)
        .with("accessOverheadSeconds", access_overhead_seconds)
        .with("physicalLimitScope", "per-endpoint")
        .with("customOverride", custom)
        .with(
            "configuration",
            if custom {
                "environment"
            } else {
                "product-default"
            },
        );
    Policy {
        walking_speed_kph,
        access_padding_factor,
        access_overhead_seconds,
        transfer_maximum_walk_m,
        transfer_maximum_neighbors,
        identity: stable_json(&policy),
        object: policy,
    }
});

/// `stableJson`: object keys in UTF-16 code-unit order at every level.
pub(crate) fn stable_json(value: &Js) -> String {
    match value {
        Js::Array(items) => format!(
            "[{}]",
            items.iter().map(stable_json).collect::<Vec<_>>().join(",")
        ),
        Js::Object(members) => {
            let mut sorted: Vec<_> = members.iter().collect();
            sorted.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
            format!(
                "{{{}}}",
                sorted
                    .iter()
                    .map(|(k, v)| format!("{}:{}", js::quote(k), stable_json(v)))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        other => other.stringify(),
    }
}

/// Seconds to walk `distance_km` under the policy (`walkSeconds`).
pub(crate) fn walk_seconds(distance_km: f64) -> f64 {
    let policy = &*POLICY;
    (distance_km / policy.walking_speed_kph * 3600.0 * policy.access_padding_factor
        + policy.access_overhead_seconds)
        .ceil()
}

/// The transfer fields the duration rules read.
pub(crate) struct TransferTiming<'a> {
    pub provenance: &'a str,
    pub min_transfer_time: Option<f64>,
    pub path_distance_m: Option<f64>,
    pub transfer_type: Option<f64>,
}

/// `transferDurationSeconds`: `None` for an unpriced pathway.
pub(crate) fn transfer_duration_seconds(transfer: &TransferTiming) -> Option<f64> {
    if transfer.provenance == "gtfs_pathway_estimated" {
        let minimum = transfer.min_transfer_time.unwrap_or(0.0);
        let walk = transfer
            .path_distance_m
            .map_or(0.0, |distance| walk_seconds(distance / 1000.0));
        // Math.max propagates NaN; minima are finite here.
        return Some(minimum.max(walk));
    }
    if transfer.provenance == "gtfs_pathway" && transfer.min_transfer_time.is_none() {
        return transfer
            .path_distance_m
            .map(|distance| walk_seconds(distance / 1000.0));
    }
    Some(transfer.min_transfer_time.unwrap_or(0.0).max(0.0))
}

/// `stationTransferDurationSeconds`: a published transfers.txt minimum never
/// lets a rider walk faster than the configured pace between located stops.
pub(crate) fn station_transfer_duration_seconds(
    transfer: &TransferTiming,
    from: Option<(f64, f64)>,
    to: Option<(f64, f64)>,
    speed_kph: f64,
) -> Option<f64> {
    let minimum = transfer_duration_seconds(transfer);
    if transfer.provenance != "gtfs_transfer" || transfer.transfer_type == Some(3.0) {
        return minimum;
    }
    let (Some((from_lon, from_lat)), Some((to_lon, to_lat))) = (from, to) else {
        return minimum;
    };
    if ![from_lon, from_lat, to_lon, to_lat]
        .iter()
        .all(|v| v.is_finite())
    {
        return minimum;
    }
    let distance_km = js_math::haversine_km(from_lon, from_lat, to_lon, to_lat)
        .max(transfer.path_distance_m.unwrap_or(0.0) / 1000.0);
    let walk = (distance_km / speed_kph * 3600.0).ceil();
    minimum.map(|minimum| minimum.max(walk))
}

/// `encodeURIComponent` for UTF-8 text.
pub(crate) fn encode_uri_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
        {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// JavaScript `String(number)`, including `NaN`.
pub(crate) fn js_string(value: f64) -> String {
    if value.is_nan() {
        "NaN".into()
    } else if value.is_infinite() {
        if value > 0.0 { "Infinity" } else { "-Infinity" }.into()
    } else {
        js::number(value)
    }
}

/// `stableKeySuffix(value)`: a compact deterministic key over UTF-16 units.
pub(crate) fn stable_key_suffix(value: &str) -> String {
    crate::route_materialization::stable_key_suffix(value.encode_utf16().collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn javascript_conversions() {
        assert_eq!(js_number(" 12 "), 12.0);
        assert_eq!(js_number("0x10"), 16.0);
        assert!(js_number("12px").is_nan());
        assert_eq!(js_number(""), 0.0);
        assert_eq!(encode_uri_component("a b/é:|"), "a%20b%2F%C3%A9%3A%7C");
        assert_eq!(js_string(f64::NAN), "NaN");
        assert_eq!(js_string(-1.0), "-1");
    }

    #[test]
    fn default_policy_identity_is_stable_json() {
        let identity = &POLICY.identity;
        assert!(identity.starts_with("{\"accessOverheadSeconds\":0,\"accessPaddingFactor\":1,"));
        assert!(identity.contains("\"walkingSpeedKph\":4.8}"));
    }
}
