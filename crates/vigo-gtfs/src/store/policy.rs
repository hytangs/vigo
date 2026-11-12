//! Walking, transfer, pathway and wheelchair policies the store compiler
//! applies (routing-policy.mjs, pathway-cost.mjs, wheelchair-policy.mjs).

use crate::jsval::{self, trimmed};
use crate::zip::Row;
use crate::{Error, Result};
use std::collections::HashMap;
use vigo_format::js::Js;

pub use vigo_format::js_math::{cos, haversine_km};

/// The process walking model (VIGO_ROUTING_WALK_* environment overrides).
pub struct WalkingModel {
    pub speed_kph: f64,
    pub padding_factor: f64,
    pub overhead_seconds: f64,
}

fn environment_number(name: &str, fallback: f64) -> f64 {
    match std::env::var(name) {
        Ok(text) => jsval::numeric(Some(&text), fallback),
        Err(_) => fallback,
    }
}

pub fn walking_model() -> WalkingModel {
    WalkingModel {
        speed_kph: 1.5f64.max(8f64.min(environment_number("VIGO_ROUTING_WALK_SPEED_KPH", 4.8))),
        padding_factor: 0.75f64
            .max(3f64.min(environment_number("VIGO_ROUTING_WALK_PADDING_FACTOR", 1.0))),
        overhead_seconds: 0f64.max(900f64.min(environment_number(
            "VIGO_ROUTING_WALK_OVERHEAD_SECONDS",
            0.0,
        ))),
    }
}

pub fn walk_seconds(distance_km: f64) -> f64 {
    let model = walking_model();
    (distance_km / model.speed_kph * 3600.0 * model.padding_factor + model.overhead_seconds).ceil()
}

/// A transfer row as seen by `transferDurationSeconds`.
#[derive(Clone, Debug, Default)]
pub struct TransferCost<'a> {
    pub provenance: Option<&'a str>,
    pub min_transfer_time: Option<f64>,
    pub path_distance_m: Option<f64>,
}

pub fn transfer_duration_seconds(transfer: &TransferCost) -> Option<f64> {
    match transfer.provenance {
        Some("gtfs_pathway_estimated") => {
            // Number(null) is 0; Math.max with NaN is NaN.
            let minimum = transfer.min_transfer_time.unwrap_or(0.0);
            let walk = transfer
                .path_distance_m
                .map_or(0.0, |d| walk_seconds(d / 1000.0));
            Some(if minimum.is_nan() || walk.is_nan() {
                f64::NAN
            } else {
                minimum.max(walk)
            })
        }
        Some("gtfs_pathway") if transfer.min_transfer_time.is_none() => transfer
            .path_distance_m
            .map(|d| walk_seconds(if d.is_finite() { d } else { 0.0 } / 1000.0)),
        _ => {
            let minimum = transfer
                .min_transfer_time
                .filter(|v| v.is_finite())
                .unwrap_or(0.0);
            Some(0f64.max(minimum))
        }
    }
}

/// `stationFallbackSeconds(from, to, walkingSpeedKph)`.
pub fn station_fallback_seconds(from: (f64, f64), to: (f64, f64), walking_speed_kph: f64) -> f64 {
    let distance_km = haversine_km(from.0, from.1, to.0, to.1);
    120f64.max((distance_km / walking_speed_kph * 3600.0).ceil())
}

/// `estimatedPathwaySeconds(row)`.
pub fn estimated_pathway_seconds(row: &Row) -> Result<Option<f64>> {
    let mode = jsval::number(row.get("pathway_mode"));
    let text = trimmed(row.get("stair_count"));
    if mode == 2.0 && !text.is_empty() {
        let count = jsval::to_number(text);
        if !jsval::is_safe_integer(count) || count == 0.0 {
            return Err(Error::new(format!(
                "Invalid GTFS pathway stair_count: {}",
                row.get("pathway_id").unwrap_or("undefined")
            )));
        }
        return Ok(Some(count.abs().ceil()));
    }
    if mode == 6.0 || mode == 7.0 {
        return Ok(Some(5.0));
    }
    Ok(None)
}

pub const WHEELCHAIR_PROFILE: &str = "wheelchair-strict-v1";

/// `wheelchairStreetPolicy(value)`.
pub fn wheelchair_street_policy(value: &str) -> Result<&'static str> {
    match value {
        "inferred" => Ok("inferred-step-free-v1"),
        "verified" => Ok("wheelchair-yes-only"),
        _ => Err(Error::new(
            "--wheelchair-streets must be inferred or verified",
        )),
    }
}

/// `wheelchairDescriptionFor(streets)`.
pub fn wheelchair_description(streets: &str) -> Result<Js> {
    let evidence = wheelchair_street_policy(streets)?;
    Ok(Js::object()
        .with("profile", WHEELCHAIR_PROFILE)
        .with("unknownData", "exclude")
        .with("streetEvidence", evidence)
        .with("stationPaths", "published-wheelchair-time-or-dimensioned-step-free")
        .with("fareGates", "accessible-endpoints-with-published-time-or-five-second-estimate")
        .with("sameLevelWalkways", "zero-wheelchair-length-with-published-walk-length-and-accessible-endpoints")
        .with("minimumWidthMeters", 0.9)
        .with("maximumSlope", 0.083)
        .with(
            "limitations",
            vec![
                "Unknown vehicle and boarding accessibility is excluded; coverage may be sparse.",
                "Fare gates between accessible nodes use published crossing time or a five-second estimate.",
                "Same-level walkways with accessible endpoints and a zero wheelchair length use their positive published walk length.",
                if streets == "verified" {
                    "Unknown street accessibility is excluded; only ways tagged wheelchair=yes are used."
                } else {
                    "Inferred streets can lack wheelchair or surface tags. An explicit wheelchair=yes overrides surface and trail filters; mapped dimensions and some barriers are still checked."
                },
                "Coordinate attachments are geometric; door-to-street access is not verified.",
                "Elevator outages, temporary obstructions and individual chair dimensions are not modeled.",
            ],
        ))
}

/// One stop's wheelchair source fields.
pub struct WheelchairStop {
    pub parent: Option<String>,
    pub level: String,
    pub boarding: f64,
}

/// `wheelchairBoardingValues(stops)`: unknown boarding inherits from parents.
/// Returns the values in resolution order, as the JavaScript Map iterates.
pub fn wheelchair_boarding_values(
    order: &[String],
    stops: &HashMap<String, WheelchairStop>,
) -> Result<Vec<(String, f64)>> {
    let mut resolved: HashMap<String, f64> = HashMap::new();
    let mut sequence: Vec<String> = Vec::new();
    for id in order {
        let mut chain = Vec::new();
        let mut seen = std::collections::HashSet::new();
        let mut cursor: Option<&str> = Some(id);
        let mut value = 0.0;
        while let Some(current) = cursor {
            let Some(stop) = stops.get(current) else {
                break;
            };
            if let Some(known) = resolved.get(current) {
                value = *known;
                break;
            }
            if !seen.insert(current) {
                return Err(Error::new("Cyclic GTFS wheelchair boarding inheritance"));
            }
            chain.push(current.to_owned());
            if stop.boarding != 0.0 {
                value = stop.boarding;
                break;
            }
            cursor = stop.parent.as_deref();
        }
        for member in chain {
            sequence.push(member.clone());
            resolved.insert(member, value);
        }
    }
    Ok(sequence
        .into_iter()
        .map(|id| {
            let value = resolved[&id];
            (id, value)
        })
        .collect())
}

fn tag(value: Option<&str>) -> String {
    trimmed(value).to_lowercase()
}

fn supplied_number(value: Option<&str>) -> Option<f64> {
    let number = jsval::number(value);
    (!tag(value).is_empty() && number.is_finite()).then_some(number)
}

/// A priced pathway: seconds and provenance.
pub struct PathwayCost {
    pub seconds: f64,
    pub provenance: &'static str,
}

/// `wheelchairPathwayCost(row, { accessibleEndpoints, sameLevel })`.
pub fn wheelchair_pathway_cost(
    row: &Row,
    accessible_endpoints: bool,
    same_level: bool,
) -> Result<Option<PathwayCost>> {
    let published = |seconds| {
        Some(PathwayCost {
            seconds,
            provenance: "gtfs_pathway",
        })
    };
    for field in [
        "stair_count",
        "max_slope",
        "min_width",
        "wheelchair_traversal_time",
        "wheelchair_length",
    ] {
        if !tag(row.get(field)).is_empty() && supplied_number(row.get(field)).is_none() {
            return Ok(None);
        }
    }
    let mode = jsval::number(row.get("pathway_mode"));
    if ![1.0, 5.0, 6.0, 7.0].contains(&mode) {
        return Ok(None);
    }
    let stairs = supplied_number(row.get("stair_count"));
    let slope = supplied_number(row.get("max_slope"));
    let width = supplied_number(row.get("min_width"));
    if stairs.is_some_and(|s| s != 0.0)
        || slope.is_some_and(|s| s.abs() > 0.083)
        || width.is_some_and(|w| w < 0.9)
    {
        return Ok(None);
    }
    if let Some(time) = supplied_number(row.get("wheelchair_traversal_time")) {
        return Ok(if time > 0.0 { published(time) } else { None });
    }
    if let Some(length) = supplied_number(row.get("wheelchair_length")) {
        if length > 0.0 && mode != 5.0 {
            return Ok(published((length / (4.8 / 3.6)).ceil()));
        }
        let walk = supplied_number(row.get("length"));
        if length == 0.0
            && mode == 1.0
            && accessible_endpoints
            && same_level
            && walk.is_some_and(|l| l > 0.0)
        {
            return Ok(Some(PathwayCost {
                seconds: (walk.unwrap() / (4.8 / 3.6)).ceil(),
                provenance: "gtfs_pathway_estimated",
            }));
        }
        return Ok(None);
    }
    let time = supplied_number(row.get("traversal_time"));
    if (mode == 6.0 || mode == 7.0) && accessible_endpoints {
        if !tag(row.get("traversal_time")).is_empty() && time.is_none_or(|t| t < 0.0) {
            return Ok(None);
        }
        // `time > 0` is false for null.
        return Ok(if time.is_some_and(|t| t > 0.0) {
            published(time.unwrap())
        } else {
            Some(PathwayCost {
                seconds: estimated_pathway_seconds(row)?.unwrap_or(f64::NAN),
                provenance: "gtfs_pathway_estimated",
            })
        });
    }
    if width.is_none() || (mode != 5.0 && slope.is_none()) {
        return Ok(None);
    }
    Ok(match time {
        Some(t) if t > 0.0 => published(t),
        _ => None,
    })
}
