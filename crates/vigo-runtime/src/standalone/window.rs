//! Journey choices for trip planning, composed from exact searches.
//!
//! These route options are opt-in; without them a Route keeps its 0.5 answer.
//!
//! `windowChoices: "supported"` lists the journeys a rider could prefer when
//! leaving within `windowMinutes` after the requested time:
//!
//! - Every minute of the window is a sample. A sample's earliest-arrival
//!   journey stays optimal until the last minute that still catches its first
//!   vehicle, so those samples reuse it, retimed, instead of searching again.
//!   Reuse is sound while the journey's arrival plus the alternative slack lies
//!   inside the sample's own scan horizon; a later horizon could otherwise
//!   admit an earlier-arriving trip. A direct walk that beats transit is reused
//!   the same way until transit could arrive first.
//! - Endpoint access and the direct walk do not depend on the clock, so each
//!   is searched once per window.
//! - Every search also contributes its bounded Pareto alternatives (arriving
//!   up to 15 minutes later with no more boardings), retimed to the latest
//!   minute in the window that still catches them.
//! - The pool keeps journeys that are nondominated in elapsed time from the
//!   requested departure, journey time, boardings and walking, and that
//!   minimize elapsed + a·journey + b·boardings + c·walking for some
//!   nonnegative a, b, c. At most five remain, one per public line family,
//!   each labeled by the criterion it wins.
//!
//! `alternatives` with supported windows adds the ranked alternatives at the
//! requested time; the combined list keeps distinct, nondominated services.
//! `expandedWalkKm` adds transit journeys that a wider walking limit makes
//! strictly faster: they arrive at least a minute before every ordinary
//! choice. `includeEarliestTransit` reports the earliest scheduled boarding,
//! searching transit alone when walking wins every choice.
use super::point::{self, WINDOW_ARRIVAL_SLACK_SECONDS};
use super::query::{Candidates, Options, Point};
use super::{City, Result, fail, flag, materialize::MatrixMaterializationCache, number};
use crate::TimetableMatrixJourney;
use crate::route_alternatives::RouteAlternativeRequest;
use serde_json::{Value, json};
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

/// Options this module owns; a fixed-departure search never sees them.
const OPTIONS: [&str; 3] = ["windowChoices", "expandedWalkKm", "includeEarliestTransit"];
const MAXIMUM_WINDOW_CHOICES: usize = 5;
const MAXIMUM_MERGED_CHOICES: usize = 10;

/// Whether a route request asks for composed journey choices.
pub(super) fn requested(q: &Value) -> bool {
    q["windowChoices"] == "supported"
        || q.get("expandedWalkKm").is_some()
        || q["includeEarliestTransit"] == true
}

pub(super) fn validate(q: &Value) -> Result<()> {
    if let Some(choices) = q.get("windowChoices")
        && choices != "supported"
        && choices != "frontier"
    {
        return fail("windowChoices must be frontier or supported");
    }
    flag(q, "includeEarliestTransit", false)?;
    if q.get("expandedWalkKm").is_some() {
        let km = number(q, "expandedWalkKm", 2.4, 0.2, 5.)?;
        if km <= number(q, "maxWalkKm", 1.2, 0., 100.)? {
            return fail("expandedWalkKm must exceed maxWalkKm");
        }
    }
    if q["windowChoices"] == "supported" {
        let window = number(q, "windowMinutes", 0., 0., 60.)?;
        if window > 0. && matches!(q["timePreference"].as_str(), Some("arrive_by" | "arrive")) {
            return fail("Supported window choices list later departures; use depart_at");
        }
        if window.fract() != 0. {
            return fail("Supported window choices require whole windowMinutes up to 60");
        }
        if window > 0. && via(q).is_some_and(|points| !points.is_empty()) {
            return fail(
                "Supported window choices search waypoints at their exact clocks; omit windowMinutes",
            );
        }
    }
    Ok(())
}

struct Endpoints {
    origin: Point,
    destination: Point,
    a: Candidates,
    b: Candidates,
}

/// A candidate journey and, for transit, the exact search that proved it.
struct Plan {
    value: Value,
    source: Option<(TimetableMatrixJourney, f64)>,
}

#[derive(Default)]
struct Search {
    alternatives: Vec<TimetableMatrixJourney>,
    unsupported: Option<String>,
}

/// Choices compare clocks and durations at display precision, a thousandth
/// of a minute, so equal journeys tie instead of differing by float noise.
fn minutes(v: &Value, key: &str) -> f64 {
    v[key]
        .as_f64()
        .map_or(f64::INFINITY, |m| (m * 1000.).round() / 1000.)
}
fn depart(v: &Value) -> f64 {
    minutes(v, "departureMinutes")
}
fn arrive(v: &Value) -> f64 {
    if v["arrivalMinutes"].is_number() {
        minutes(v, "arrivalMinutes")
    } else {
        depart(v) + minutes(v, "durationMinutes")
    }
}
fn journey_minutes(v: &Value) -> f64 {
    let (start, end) = (depart(v), arrive(v));
    if end.is_finite() && end >= start {
        end - start
    } else {
        minutes(v, "durationMinutes")
    }
}
fn elapsed(v: &Value, center: f64) -> f64 {
    journey_minutes(v) + (depart(v) - center).max(0.)
}
fn legs(v: &Value) -> &[Value] {
    v["legs"].as_array().map_or(&[], Vec::as_slice)
}
fn rides(v: &Value) -> impl Iterator<Item = &Value> {
    legs(v).iter().filter(|leg| leg["kind"] == "ride")
}
fn boardings(v: &Value) -> usize {
    rides(v).count()
}
/// Walking as a rider reads it: the sum of the displayed walking legs.
fn walking(v: &Value) -> f64 {
    let total: f64 = legs(v)
        .iter()
        .filter(|leg| leg["kind"] == "walk")
        .map(|leg| minutes(leg, "durationMinutes"))
        .filter(|m| m.is_finite())
        .sum();
    (total * 1000.).round() / 1000.
}
fn text(v: &Value) -> &str {
    v.as_str().map_or("", str::trim)
}
/// The line a rider reads: short name, else long name, else route ID.
pub(super) fn route_label(leg: &Value) -> String {
    [
        &leg["route"]["shortName"],
        &leg["route"]["longName"],
        &leg["routeId"],
    ]
    .into_iter()
    .map(text)
    .find(|label| !label.is_empty())
    .unwrap_or("")
    .to_owned()
}
fn mode_sequence(v: &Value) -> String {
    let mode = text(&v["mode"]);
    if mode.is_empty() {
        "unknown".into()
    } else {
        mode.into()
    }
}
/// Boarding sequence by line and stops; repeat departures share it.
fn sequence(v: &Value) -> String {
    let sequence: Vec<_> = rides(v)
        .map(|leg| {
            format!(
                "{}:{}:{}",
                text(&leg["routeId"]),
                text(&leg["fromStopId"]),
                text(&leg["toStopId"])
            )
        })
        .collect();
    if sequence.is_empty() {
        mode_sequence(v)
    } else {
        sequence.join("|")
    }
}
/// Consecutive public line labels, the family a rider recognizes.
fn family(v: &Value) -> String {
    let mut labels: Vec<String> = rides(v)
        .map(route_label)
        .filter(|l| !l.is_empty())
        .collect();
    labels.dedup();
    if labels.is_empty() {
        let routes: Vec<_> = rides(v)
            .map(|leg| text(&leg["routeId"]).to_owned())
            .collect();
        if routes.is_empty() {
            mode_sequence(v)
        } else {
            routes.join(">")
        }
    } else {
        labels.join(">")
    }
}
/// The exact vehicles and clocks of a journey; equal only for one witness.
fn witness(v: &Value) -> String {
    let rides: Vec<_> = rides(v)
        .map(|leg| {
            json!([
                leg["tripId"],
                leg["fromStopId"],
                leg["toStopId"],
                leg["departureMinutes"],
                leg["arrivalMinutes"]
            ])
        })
        .collect();
    if rides.is_empty() {
        format!("{}:{}", mode_sequence(v), depart(v))
    } else {
        serde_json::to_string(&rides).unwrap()
    }
}
/// The last minute that still catches the first vehicle, from leg clocks at
/// display precision.
fn latest_catch(v: &Value) -> Option<f64> {
    let legs = legs(v);
    let first = legs.iter().position(|leg| leg["kind"] == "ride")?;
    let before: f64 = legs[..first]
        .iter()
        .map(|leg| minutes(leg, "durationMinutes"))
        .filter(|m| m.is_finite())
        .sum();
    Some(minutes(&legs[first], "departureMinutes") - before)
}
fn shift(leg: &mut Value, delta: f64) {
    for (key, scale) in [
        ("departureMinutes", 1.),
        ("arrivalMinutes", 1.),
        ("departure", 60.),
        ("arrival", 60.),
    ] {
        if let Some(value) = leg[key].as_f64() {
            leg[key] = json!(value + delta * scale);
        }
    }
}
/// Leave `delta` minutes later: only the legs before the first boarding move,
/// and the wait at the first stop absorbs the change. A walk moves entirely.
fn move_start(v: &mut Value, delta: f64) {
    let first = legs(v).iter().position(|leg| leg["kind"] == "ride");
    if let Some(items) = v["legs"].as_array_mut() {
        for leg in items.iter_mut().take(first.unwrap_or(usize::MAX)) {
            shift(leg, delta);
        }
    }
    if first.is_none() {
        shift(v, delta);
        return;
    }
    let arrival = v["arrivalMinutes"].as_f64().unwrap_or_else(|| arrive(v));
    for (key, scale) in [("departureMinutes", 1.), ("departure", 60.)] {
        if let Some(value) = v[key].as_f64() {
            v[key] = json!(value + delta * scale);
        }
    }
    if let Some(start) = v["departureMinutes"].as_f64() {
        v["durationMinutes"] = json!(arrival - start);
    }
    if let Some(wait) = v["waitMinutes"].as_f64() {
        v["waitMinutes"] = json!((wait - delta).max(0.));
    }
    if let Some(wait) = v["waitingSeconds"].as_f64() {
        v["waitingSeconds"] = json!((wait - delta * 60.).max(0.));
    }
}
/// The same journey left at `start`.
fn retime(plan: &Value, start: f64, latest_catch: Option<f64>) -> Value {
    let mut v = plan.clone();
    // Shift from the exact clock: a rounded source would offset every moved
    // leg by the rounding error.
    let source = plan["departureMinutes"]
        .as_f64()
        .unwrap_or_else(|| depart(plan));
    move_start(&mut v, start - source);
    v["windowSample"] = json!({"sourceSearchMinutes":source,"sampleMinutes":start,
        "reused":(start - source).abs() > 1e-9,"latestCatchMinutes":latest_catch});
    v
}

fn compare_fastest(l: &Value, r: &Value, center: f64) -> Ordering {
    elapsed(l, center)
        .total_cmp(&elapsed(r, center))
        .then(boardings(l).cmp(&boardings(r)))
        .then(walking(l).total_cmp(&walking(r)))
        .then(journey_minutes(l).total_cmp(&journey_minutes(r)))
        .then(
            (depart(l) - center)
                .abs()
                .total_cmp(&(depart(r) - center).abs()),
        )
        .then(depart(r).total_cmp(&depart(l)))
        .then_with(|| witness(l).cmp(&witness(r)))
}
fn compare_fewest_transfers(l: &Value, r: &Value, center: f64) -> Ordering {
    boardings(l)
        .cmp(&boardings(r))
        .then(elapsed(l, center).total_cmp(&elapsed(r, center)))
        .then(journey_minutes(l).total_cmp(&journey_minutes(r)))
        .then(walking(l).total_cmp(&walking(r)))
        .then(
            (depart(l) - center)
                .abs()
                .total_cmp(&(depart(r) - center).abs()),
        )
        .then_with(|| witness(l).cmp(&witness(r)))
}
fn compare_least_walking(l: &Value, r: &Value, center: f64) -> Ordering {
    walking(l)
        .total_cmp(&walking(r))
        .then(elapsed(l, center).total_cmp(&elapsed(r, center)))
        .then(journey_minutes(l).total_cmp(&journey_minutes(r)))
        .then(boardings(l).cmp(&boardings(r)))
        .then(
            (depart(l) - center)
                .abs()
                .total_cmp(&(depart(r) - center).abs()),
        )
        .then_with(|| witness(l).cmp(&witness(r)))
}
fn compare_shortest(l: &Value, r: &Value, center: f64) -> Ordering {
    journey_minutes(l)
        .total_cmp(&journey_minutes(r))
        .then_with(|| compare_fastest(l, r, center))
}
fn strictly_dominates(l: &Value, r: &Value, center: f64) -> bool {
    let left = [
        elapsed(l, center),
        journey_minutes(l),
        boardings(l) as f64,
        walking(l),
    ];
    let right = [
        elapsed(r, center),
        journey_minutes(r),
        boardings(r) as f64,
        walking(r),
    ];
    left.iter().zip(&right).all(|(a, b)| a <= b) && left.iter().zip(&right).any(|(a, b)| a < b)
}

/// Weights under which `candidate` minimizes elapsed + a·journey +
/// b·boardings + c·walking over `pool`, if any nonnegative ones exist. The
/// feasible set is a three-variable polyhedron; the origin and every triple
/// boundary intersection are tested.
fn supporting_weights(candidate: usize, pool: &[&Value], center: f64) -> Option<[f64; 3]> {
    let c = pool[candidate];
    let (elapsed_c, journey_c) = (elapsed(c, center), journey_minutes(c));
    let (boardings_c, walking_c) = (boardings(c) as f64, walking(c));
    // Each row is [journey, boarding, walking coefficients, upper bound].
    let mut rows = vec![[-1., 0., 0., 0.], [0., -1., 0., 0.], [0., 0., -1., 0.]];
    for (i, other) in pool.iter().enumerate() {
        if i != candidate {
            rows.push([
                journey_c - journey_minutes(other),
                boardings_c - boardings(other) as f64,
                walking_c - walking(other),
                elapsed(other, center) - elapsed_c,
            ]);
        }
    }
    let feasible = |p: [f64; 3]| {
        p.iter().all(|&w| w >= 0.)
            && rows.iter().all(|[a, b, c, bound]| {
                let value = a * p[0] + b * p[1] + c * p[2];
                let tolerance = f64::EPSILON * 64. * value.abs().max(bound.abs()).max(1.);
                value <= bound + tolerance
            })
    };
    if feasible([0.; 3]) {
        return Some([0.; 3]);
    }
    for i in 0..rows.len() {
        for j in i + 1..rows.len() {
            for k in j + 1..rows.len() {
                let ([a, b, c, x], [d, e, f, y], [g, h, l, z]) = (rows[i], rows[j], rows[k]);
                let determinant = a * (e * l - f * h) - b * (d * l - f * g) + c * (d * h - e * g);
                if determinant.abs() <= f64::EPSILON * 128. {
                    continue;
                }
                let p = [
                    (x * (e * l - f * h) - b * (y * l - f * z) + c * (y * h - e * z)) / determinant,
                    (a * (y * l - f * z) - x * (d * l - f * g) + c * (d * z - y * g)) / determinant,
                    (a * (e * z - y * h) - b * (d * z - y * g) + x * (d * h - e * g)) / determinant,
                ];
                if p.iter().all(|w| w.is_finite()) && feasible(p) {
                    return Some(p);
                }
            }
        }
    }
    None
}

/// The supported, labeled window choices; see the module documentation.
fn select_supported(plans: Vec<Plan>, center: f64, limit: usize) -> Vec<Plan> {
    let exact = |v: &Value| (depart(v) - center).abs() < 1e-6;
    let mut representatives: Vec<Plan> = vec![];
    let mut by_sequence = HashMap::new();
    for plan in plans.into_iter().filter(|p| p.value["status"] == "ready") {
        let key = sequence(&plan.value);
        match by_sequence.get(&key) {
            None => {
                by_sequence.insert(key, representatives.len());
                representatives.push(plan);
            }
            Some(&index) => {
                let current = &representatives[index].value;
                let (new, old) = (exact(&plan.value), exact(current));
                if (new && !old)
                    || (new == old && compare_fastest(&plan.value, current, center).is_lt())
                {
                    representatives[index] = plan;
                }
            }
        }
    }
    representatives.sort_by(|l, r| compare_fastest(&l.value, &r.value, center));
    let nondominated: Vec<Plan> = {
        let values: Vec<&Value> = representatives.iter().map(|p| &p.value).collect();
        let keep: Vec<bool> = values
            .iter()
            .map(|c| {
                !values
                    .iter()
                    .any(|o| !std::ptr::eq(*o, *c) && strictly_dominates(o, c, center))
            })
            .collect();
        representatives
            .into_iter()
            .zip(keep)
            .filter_map(|(plan, keep)| keep.then_some(plan))
            .collect()
    };
    let weights: Vec<Option<[f64; 3]>> = {
        let pool: Vec<&Value> = nondominated.iter().map(|p| &p.value).collect();
        (0..pool.len())
            .map(|i| supporting_weights(i, &pool, center))
            .collect()
    };
    let mut supported: Vec<(Plan, [f64; 3])> = nondominated
        .into_iter()
        .zip(weights)
        .filter_map(|(plan, weights)| Some((plan, weights?)))
        .collect();
    supported.sort_by(|l, r| compare_fastest(&l.0.value, &r.0.value, center));
    if supported.is_empty() {
        return vec![];
    }
    let values: Vec<&Value> = supported.iter().map(|(p, _)| &p.value).collect();
    let best = |compare: fn(&Value, &Value, f64) -> Ordering| {
        (0..values.len())
            .min_by(|&l, &r| compare(values[l], values[r], center))
            .unwrap()
    };
    let roles = [
        0,
        best(compare_shortest),
        best(compare_fewest_transfers),
        best(compare_least_walking),
    ];
    let families: Vec<String> = values.iter().map(|v| family(v)).collect();
    let mut selected: Vec<usize> = vec![];
    let add_family = |selected: &mut Vec<usize>, index: usize| {
        if selected.len() < limit
            && !selected.contains(&index)
            && !selected.iter().any(|&s| families[s] == families[index])
        {
            selected.push(index);
        }
    };
    for index in roles {
        add_family(&mut selected, index);
    }
    // The requested clock keeps a choice, replacing its own family's journey.
    if let Some(exact) = (0..values.len()).find(|&i| exact(values[i]))
        && !selected.contains(&exact)
    {
        if let Some(same) = selected
            .iter()
            .position(|&s| families[s] == families[exact])
        {
            selected[same] = exact;
        } else if selected.len() >= limit {
            *selected.last_mut().unwrap() = exact;
        } else {
            selected.push(exact);
        }
    }
    for index in 0..values.len() {
        add_family(&mut selected, index);
    }
    // Distinct boarding stations on one line remain choices only when each
    // survives the frontier; never refill from dominated journeys.
    for index in 0..values.len() {
        if selected.len() >= limit {
            break;
        }
        if !selected.contains(&index) {
            selected.push(index);
        }
    }
    selected.sort_by(|&l, &r| compare_fastest(values[l], values[r], center));
    let ordered: Vec<&Value> = selected.iter().map(|&i| values[i]).collect();
    let visible = |compare: fn(&Value, &Value, f64) -> Ordering| {
        (0..ordered.len())
            .min_by(|&l, &r| compare(ordered[l], ordered[r], center))
            .unwrap()
    };
    let (shortest, fewest, least) = (
        visible(compare_shortest),
        visible(compare_fewest_transfers),
        visible(compare_least_walking),
    );
    let labels: Vec<String> = {
        let mut alternate = 0;
        (0..ordered.len())
            .map(|i| {
                if ordered[i]["mode"] == "walk" {
                    "Walk only".into()
                } else if i == 0 {
                    "Earliest arrival".into()
                } else if i == shortest {
                    "Shortest journey".into()
                } else if i == fewest {
                    "Fewest transfers".into()
                } else if i == least {
                    "Least walking".into()
                } else {
                    alternate += 1;
                    if alternate == 1 {
                        "Alternate".into()
                    } else {
                        format!("Alternate {alternate}")
                    }
                }
            })
            .collect()
    };
    let mut slots: Vec<Option<(Plan, [f64; 3])>> = supported.into_iter().map(Some).collect();
    selected
        .iter()
        .zip(labels)
        .enumerate()
        .map(|(rank, (&index, label))| {
            let (mut plan, weights) = slots[index].take().unwrap();
            plan.value["choiceLabel"] = json!(label);
            plan.value["recommended"] = json!(rank == 0);
            plan.value["choiceSupport"] = json!({
                "objective":"elapsed_plus_journey_plus_weighted_boardings_plus_weighted_walking",
                "elapsedWeight":1,"journeyWeight":weights[0],
                "boardingPenaltyMinutesPerBoarding":weights[1],"walkingReluctance":weights[2],
                "nonnegativeWeightFeasibility":"exact_half_plane_intersection"});
            plan.value["selectedTimeChoice"] = json!(exact(&plan.value));
            plan
        })
        .collect()
}

/// A ride sequence that returns to a station it already used: the first
/// such return, by station (parent) group.
fn returned_station_cycle(city: &City, v: &Value) -> Option<Value> {
    let group = |stop: &str| -> String {
        city.stop(stop)
            .ok()
            .map(|s| s.parent.trim().to_owned())
            .filter(|parent| !parent.is_empty())
            .unwrap_or_else(|| stop.to_owned())
    };
    let mut seen: HashMap<String, (String, usize, usize)> = HashMap::new();
    let mut previous: Option<String> = None;
    for (ride, (leg_index, leg)) in legs(v)
        .iter()
        .enumerate()
        .filter(|(_, leg)| leg["kind"] == "ride")
        .enumerate()
    {
        let listed: Vec<&str> = leg["stopIds"]
            .as_array()
            .map(|ids| ids.iter().map(text).collect())
            .filter(|ids: &Vec<&str>| !ids.is_empty())
            .unwrap_or_else(|| vec![text(&leg["fromStopId"]), text(&leg["toStopId"])]);
        for stop in listed {
            if stop.is_empty() {
                continue;
            }
            let station = group(stop);
            if previous.as_deref() == Some(station.as_str()) {
                continue;
            }
            if let Some((first_stop, first_leg, first_ride)) = seen.get(&station) {
                let mut cycle = json!({"policy":"represented","advisory":true,
                    "firstLegIndex":first_leg,"lastLegIndex":leg_index,
                    "firstRideIndex":first_ride,"lastRideIndex":ride,
                    "departureStopId":first_stop,"returnedStopId":stop,
                    "stationGroupId":station,"exactStopReturn":first_stop == stop,
                    "cycleBoardings":ride - first_ride + 1});
                if *first_ride == ride {
                    cycle["withinSingleRide"] = json!(true);
                }
                return Some(cycle);
            }
            seen.insert(station.clone(), (stop.to_owned(), leg_index, ride));
            previous = Some(station);
        }
    }
    None
}

// Match the displayed feasible leave time: defer a leading walk to the
// first boarding, without altering the exact query or returned leg clocks.
fn choice_depart(v: &Value) -> f64 {
    if legs(v).first().is_some_and(|leg| leg["kind"] == "walk") {
        latest_catch(v).unwrap_or_else(|| depart(v)).max(depart(v))
    } else {
        depart(v)
    }
}

/// Distinct, nondominated services from a window's choices and ranked
/// alternatives. The first plan, the exact primary witness, always stays.
fn merge_services(plans: &[Value], limit: usize) -> Vec<usize> {
    let ride_trips =
        |v: &Value| -> Vec<Value> { rides(v).map(|leg| leg["tripId"].clone()).collect() };
    let mut candidates: Vec<usize> = (0..plans.len())
        .filter(|&i| plans[i]["status"] == "ready")
        .collect();
    candidates.retain(|&i| {
        if i == 0 {
            return true;
        }
        let candidate = &plans[i];
        let candidate_trips = ride_trips(candidate);
        !plans.iter().enumerate().any(|(j, other)| {
            if j == i || other["status"] != "ready" {
                return false;
            }
            let simpler = ride_trips(other);
            let dominates = arrive(other) <= arrive(candidate)
                && walking(other) <= walking(candidate)
                && choice_depart(other) >= choice_depart(candidate)
                && simpler.len() <= candidate_trips.len()
                && (arrive(other) < arrive(candidate)
                    || walking(other) < walking(candidate)
                    || simpler.len() < candidate_trips.len());
            // Stop variants on the same public lines often trade seconds of
            // walking against seconds of arrival. Keep one when those changes
            // disappear at the minute precision of the journey cards. This
            // only selects optional alternatives; exact clocks and the primary
            // witness above remain untouched.
            if family(other) == family(candidate) {
                let metrics = |v: &Value| {
                    [
                        arrive(v).round(),
                        walking(v).round(),
                        -choice_depart(v).round(),
                    ]
                };
                let (a, b) = (metrics(other), metrics(candidate));
                let no_worse =
                    a.iter().zip(b).all(|(a, b)| *a <= b) && simpler.len() <= candidate_trips.len();
                let preferred_tie = arrive(other)
                    .total_cmp(&arrive(candidate))
                    .then(walking(other).total_cmp(&walking(candidate)))
                    .then(choice_depart(candidate).total_cmp(&choice_depart(other)))
                    .then(j.cmp(&i))
                    .is_lt();
                return no_worse
                    && (a != b || simpler.len() < candidate_trips.len() || preferred_tie);
            }
            if !dominates {
                return false;
            }
            // A station return may be required by directed platforms. Drop it
            // only with a feasible dominating witness, never on geometry alone.
            let returns = candidate["returnedStationCycle"].is_object();
            let needless_change = !simpler.is_empty()
                && simpler.len() < candidate_trips.len()
                && simpler
                    .iter()
                    .all(|trip| trip.is_string() && candidate_trips.contains(trip));
            returns || needless_change
        })
    });
    candidates.sort_by(|&a, &b| {
        arrive(&plans[a])
            .total_cmp(&arrive(&plans[b]))
            .then(boardings(&plans[a]).cmp(&boardings(&plans[b])))
            .then(walking(&plans[a]).total_cmp(&walking(&plans[b])))
            .then(a.cmp(&b))
    });
    let mut witnesses = HashSet::new();
    candidates.retain(|&i| witnesses.insert(witness(&plans[i])));
    let mut families = HashSet::new();
    let mut selected = vec![];
    // Distinct line, boarding and alighting combinations come before repeat
    // departures of one, which the UI can group.
    for &i in &candidates {
        let line: Vec<_> = rides(&plans[i])
            .map(|leg| json!([leg["routeId"], leg["fromStopId"], leg["toStopId"]]))
            .collect();
        let key = if line.is_empty() {
            witness(&plans[i])
        } else {
            serde_json::to_string(&line).unwrap()
        };
        if families.insert(key) && selected.len() < limit {
            selected.push(i);
        }
    }
    for &i in &candidates {
        if selected.len() >= limit {
            break;
        }
        if !selected.contains(&i) {
            selected.push(i);
        }
    }
    selected.sort_by_key(|i| candidates.iter().position(|c| c == i).unwrap());
    selected
}
/// The earliest first boarding among ready transit plans.
fn earliest_transit<'a>(plans: impl IntoIterator<Item = &'a Value>) -> Option<Value> {
    let mut earliest: Option<(f64, f64, f64, Value)> = None;
    for plan in plans {
        if plan["status"] != "ready" || plan["mode"] != "transit" {
            continue;
        }
        let Some(first) = rides(plan).next() else {
            continue;
        };
        let (Some(boarding), arrival) = (first["departureMinutes"].as_f64(), arrive(plan)) else {
            continue;
        };
        if !arrival.is_finite() {
            continue;
        }
        let transfers = boardings(plan).saturating_sub(1) as f64;
        let better = earliest.as_ref().is_none_or(|(b, a, t, _)| {
            boarding < *b || (boarding == *b && (arrival < *a || (arrival == *a && transfers < *t)))
        });
        if better {
            let label = route_label(first);
            earliest = Some((
                boarding,
                arrival,
                transfers,
                json!({"status":"ready",
                "departMinutes":depart(plan),"firstBoardingMinutes":boarding,"arriveMinutes":arrival,
                "routeShortName":if label.is_empty() { Value::Null } else { json!(label) },
                "transfers":transfers}),
            ));
        }
    }
    earliest.map(|(.., evidence)| evidence)
}

fn via(q: &Value) -> Option<&Vec<Value>> {
    q.get("via")
        .or_else(|| q.get("waypoints"))
        .and_then(Value::as_array)
}

fn without_options(q: &Value) -> Value {
    let mut request = q.clone();
    if let Some(object) = request.as_object_mut() {
        for key in OPTIONS {
            object.remove(key);
        }
    }
    request
}

impl City {
    /// The earliest-arrival journey at one clock, from the window's endpoints.
    fn window_search(
        &mut self,
        ends: &Endpoints,
        opt: &Options,
    ) -> Result<Option<TimetableMatrixJourney>> {
        if ends.a.stops.is_empty() || ends.b.stops.is_empty() {
            return Ok(None);
        }
        let input = Self::matrix_input(
            std::slice::from_ref(&ends.a),
            std::slice::from_ref(&ends.b),
            opt,
            true,
        );
        let kernel = &mut self
            .timetable
            .as_mut()
            .ok_or("Timetable is not active")?
            .kernel;
        let mut result = match point::route(kernel, &input)? {
            Some(result) => result,
            None => kernel.route_matrix_csa(input)?,
        };
        Ok(result
            .journeys
            .take()
            .and_then(|mut rows| rows.pop().flatten()))
    }

    /// A sample's certified journey and bounded Pareto frontier.
    fn window_sample(
        &mut self,
        ends: &Endpoints,
        opt: &Options,
    ) -> Result<Option<(TimetableMatrixJourney, Vec<TimetableMatrixJourney>)>> {
        if ends.a.stops.is_empty() || ends.b.stops.is_empty() {
            return Ok(None);
        }
        let input = Self::matrix_input(
            std::slice::from_ref(&ends.a),
            std::slice::from_ref(&ends.b),
            opt,
            true,
        );
        let kernel = &mut self
            .timetable
            .as_mut()
            .ok_or("Timetable is not active")?
            .kernel;
        point::window_sample(kernel, &input)
    }

    /// Ranked alternatives around `best` at the requested time.
    fn window_alternatives(
        &mut self,
        ends: &Endpoints,
        opt: &Options,
        best: &TimetableMatrixJourney,
        request: Option<&RouteAlternativeRequest>,
    ) -> Result<Search> {
        let input = Self::matrix_input(
            std::slice::from_ref(&ends.a),
            std::slice::from_ref(&ends.b),
            opt,
            true,
        );
        let kernel = &mut self
            .timetable
            .as_mut()
            .ok_or("Timetable is not active")?
            .kernel;
        let (alternatives, unsupported) = point::alternatives(kernel, &input, best, request)?;
        Ok(Search {
            alternatives,
            unsupported,
        })
    }

    /// A materialized journey. Searched journeys carry a station-return
    /// advisory; frontier tradeoffs are shown as found.
    fn window_journey(
        &mut self,
        ends: &Endpoints,
        journey: &TimetableMatrixJourney,
        opt: &Options,
        cache: &mut MatrixMaterializationCache,
        advisory: bool,
    ) -> Result<Value> {
        let mut value = self.materialize(
            journey,
            [&ends.origin, &ends.destination],
            true,
            opt,
            [&ends.a, &ends.b],
            Some(cache),
        )?;
        value["status"] = json!("ready");
        value["mode"] = json!("transit");
        if advisory && let Some(cycle) = returned_station_cycle(self, &value) {
            value["returnedStationCycle"] = cycle;
        }
        Ok(value)
    }

    /// Composed journey choices for a Route; see the module documentation.
    pub(super) fn route_journeys(&mut self, q: &Value) -> Result<Value> {
        validate(q)?;
        let evidence = flag(q, "includeEarliestTransit", false)?;
        let mut result = self.journeys_once(q, evidence)?;
        let Some(km) = q
            .get("expandedWalkKm")
            .map(|_| number(q, "expandedWalkKm", 2.4, 0.2, 5.))
            .transpose()?
        else {
            return Ok(result);
        };
        if q["mode"].as_str().unwrap_or("transit") != "transit" || q["wheelchair"] == true {
            return Ok(result);
        }
        let mut wider = q.clone();
        let object = wider.as_object_mut().unwrap();
        object.remove("expandedWalkKm");
        object.remove("includeEarliestTransit");
        object.insert("maxWalkKm".into(), json!(km));
        object.insert("requireTransitRide".into(), json!(true));
        object.insert("allowLongWalk".into(), json!(false));
        // A failed wider search leaves the ordinary choices unchanged.
        let Ok(wider) = self.journeys_once(&wider, false) else {
            return Ok(result);
        };
        // The same vehicles left or reached at other minutes are another choice.
        let key = |plan: &Value| format!("{}-{}@{}", depart(plan), arrive(plan), witness(plan));
        let mut baseline: Vec<Value> = vec![];
        let mut seen = HashSet::new();
        for plan in result["choices"].as_array().into_iter().flatten() {
            if plan["status"] == "ready" && seen.insert(key(plan)) {
                baseline.push(plan.clone());
            }
        }
        let best_arrival = baseline.iter().map(arrive).fold(f64::INFINITY, f64::min);
        let mut extra = vec![];
        for plan in wider["choices"].as_array().into_iter().flatten() {
            if plan["status"] != "ready" || rides(plan).next().is_none() || !seen.insert(key(plan))
            {
                continue;
            }
            // More walking must buy a strictly earlier arrival, by at least
            // the displayed minute; a shorter but later journey is not offered.
            if arrive(plan) <= best_arrival - 1. {
                let mut plan = plan.clone();
                plan["recommended"] = json!(false);
                plan["expandedWalkingLimitKm"] = json!(km);
                extra.push(plan);
            }
        }
        if extra.is_empty() {
            return Ok(result);
        }
        let combined: Vec<Value> = baseline.into_iter().chain(extra).collect();
        let mut choices: Vec<Value> = merge_services(&combined, MAXIMUM_MERGED_CHOICES)
            .into_iter()
            .map(|i| combined[i].clone())
            .collect();
        choices.sort_by(|l, r| {
            arrive(l)
                .total_cmp(&arrive(r))
                .then(minutes(l, "durationMinutes").total_cmp(&minutes(r, "durationMinutes")))
        });
        result["choices"] = json!(choices);
        result["selectedChoice"] = json!(0);
        Ok(result)
    }

    fn journeys_once(&mut self, q: &Value, evidence: bool) -> Result<Value> {
        let window = number(q, "windowMinutes", 0., 0., 240.)?;
        if q["windowChoices"] == "supported"
            && let Some(points) = via(q).filter(|points| !points.is_empty())
        {
            return self.supported_via(q, points);
        }
        let mut result = if window > 0. && q["windowChoices"] == "supported" {
            self.supported_window(q, window)?
        } else if window > 0. {
            // A frontier window keeps its own sampled choices.
            let mut result = self.route_options(&without_options(q), false)?;
            if result["choices"].is_null() {
                result["choices"] = json!([result.clone()]);
            }
            result["selectedChoice"] = json!(0);
            result
        } else {
            let request = without_options(q);
            let mut result = self.route_options(&request, false)?;
            let alternatives = result
                .as_object_mut()
                .and_then(|o| o.remove("choices"))
                .and_then(|v| v.as_array().cloned())
                .unwrap_or_default();
            result.as_object_mut().unwrap().remove("alternativeSearch");
            let mut plans = vec![result.clone()];
            plans.extend(alternatives);
            let selected = merge_services(&plans, MAXIMUM_MERGED_CHOICES);
            let choices: Vec<Value> = if selected.is_empty() {
                vec![result.clone()]
            } else {
                selected.iter().map(|&i| plans[i].clone()).collect()
            };
            let position = choices.iter().position(|c| c == &result).unwrap_or(0);
            result["choices"] = json!(choices);
            result["selectedChoice"] = json!(position);
            result
        };
        if evidence {
            let mut found = result
                .get_mut("window")
                .and_then(|w| w.get_mut("earliestTransit"))
                .map_or(Value::Null, Value::take);
            if found.is_null() {
                found = earliest_transit(result["choices"].as_array().into_iter().flatten())
                    .unwrap_or(Value::Null);
            }
            if found.is_null() {
                // Walking wins every choice: search transit alone.
                let mut probe = without_options(q);
                probe["requireTransitRide"] = json!(true);
                if window > 0. && q["windowChoices"] == "supported" {
                    probe["windowChoices"] = json!("supported");
                }
                found = match self.journeys_once(&probe, false) {
                    Ok(probed) => earliest_transit(probed["choices"].as_array().into_iter().flatten())
                        .unwrap_or_else(|| json!({"status":"none",
                            "detail":"No scheduled transit option was found in the selected search window."})),
                    Err(error) => json!({"status":"unavailable","detail":error.to_string()}),
                };
            }
            result["earliestTransit"] = found;
        }
        if let Some(window) = result.get_mut("window").and_then(Value::as_object_mut) {
            window.remove("earliestTransit");
        }
        Ok(result)
    }

    fn supported_window(&mut self, q: &Value, window: f64) -> Result<Value> {
        let started = std::time::Instant::now();
        let opt = Options::parse(q)?;
        let step = number(q, "windowStepMinutes", 1., 1., 60.)?;
        let center = opt.time / 60.;
        let end = center + window;
        let horizon = opt.end - opt.start;
        let samples: Vec<f64> = (0..)
            .map(|i| center + f64::from(i) * step)
            .take_while(|&m| m <= end + 1e-9)
            .collect();
        // One activation for the latest sample covers every sample's horizon.
        let mut activation = without_options(q);
        let object = activation.as_object_mut().unwrap();
        object.remove("time");
        object.insert("timeMinutes".into(), json!(end));
        self.activate(&activation)?;
        let origin = self.point(&q["origin"])?;
        let destination = self.point(&q["destination"])?;
        let (a, b) = self.point_candidates(&origin, &destination, &opt)?;
        let ends = Endpoints {
            origin,
            destination,
            a,
            b,
        };
        let ride_required = flag(q, "requireTransitRide", false)?;
        let mut cache = MatrixMaterializationCache::default();
        // The direct walk does not depend on the clock: search it once.
        let mut walk: Option<Option<Value>> = None;
        let mut plans: Vec<Plan> = vec![];
        let mut tradeoffs: Vec<Plan> = vec![];
        let (mut searches, mut walk_reuses) = (0, 0);
        let mut first_blocked = None;
        let mut index = 0;
        while index < samples.len() {
            let t = samples[index];
            let at = Options {
                time: t * 60.,
                start: t * 60.,
                end: t * 60. + horizon,
                ..opt
            };
            let (journey, frontier) = match self.window_sample(&ends, &at)? {
                Some((journey, frontier)) => (Some(journey), frontier),
                None => (None, vec![]),
            };
            searches += 1;
            let transit = match &journey {
                Some(journey) => Some(self.window_journey(&ends, journey, &at, &mut cache, true)?),
                None => None,
            };
            let considers_walk = !ride_required
                && (transit.is_some()
                    || (ends.origin.stop.is_none() && ends.destination.stop.is_none()));
            let walk_plan = if considers_walk {
                if walk.is_none() {
                    let found =
                        self.street_route(q, &ends.origin, &ends.destination, &opt, "walk")?;
                    walk = Some((found["status"] == "ready").then_some(found));
                }
                walk.clone().flatten()
            } else {
                None
            };
            if let Some(w) = walk_plan.filter(|w| {
                transit
                    .as_ref()
                    .is_none_or(|j| t + minutes(w, "durationMinutes") <= arrive(j))
            }) {
                // Later departures cannot arrive before this transit arrival
                // inside the original horizon; walking wins until then.
                let through = transit
                    .as_ref()
                    .map_or(f64::INFINITY, |j| arrive(j) * 60.)
                    .min(at.end)
                    / 60.
                    - minutes(&w, "durationMinutes");
                plans.push(Plan {
                    value: retime(&w, t, None),
                    source: None,
                });
                index += 1;
                while index < samples.len() && samples[index] <= through {
                    plans.push(Plan {
                        value: retime(&w, samples[index], None),
                        source: None,
                    });
                    index += 1;
                    walk_reuses += 1;
                }
                continue;
            }
            let (Some(journey), Some(value)) = (journey, transit) else {
                first_blocked.get_or_insert(t);
                plans.push(Plan {
                    value: json!({"status":"blocked","departureMinutes":t}),
                    source: None,
                });
                index += 1;
                continue;
            };
            // Transit wins this sample: its bounded Pareto alternatives are
            // tradeoffs, shown at the latest window minute that catches them.
            for alternative in frontier {
                let value = self.window_journey(&ends, &alternative, &at, &mut cache, false)?;
                let Some(catch) = latest_catch(&value) else {
                    continue;
                };
                // Keep the requested clock when boardable.
                let start = if center >= t && center <= catch {
                    center
                } else {
                    end.min(catch)
                };
                tradeoffs.push(Plan {
                    value: retime(&value, start, Some(catch)),
                    source: Some((alternative, t)),
                });
            }
            let Some(catch) = latest_catch(&value) else {
                plans.push(Plan {
                    value,
                    source: Some((journey, t)),
                });
                index += 1;
                continue;
            };
            let sound = (arrive(&value) + 0.001) * 60. + WINDOW_ARRIVAL_SLACK_SECONDS
                <= (t * 60.).round() + horizon;
            let mut filled = 0;
            while index < samples.len() && samples[index] <= catch + 1e-9 && (filled == 0 || sound)
            {
                plans.push(Plan {
                    value: retime(&value, samples[index], Some(catch)),
                    source: Some((journey.clone(), t)),
                });
                index += 1;
                filled += 1;
            }
            if filled == 0 {
                plans.push(Plan {
                    value,
                    source: Some((journey, t)),
                });
                index += 1;
            }
        }
        let earliest = earliest_transit(plans.iter().map(|p| &p.value));
        let ready_count = plans
            .iter()
            .filter(|p| p.value["status"] == "ready")
            .count();
        // A complete walk is a peer choice, not only an access leg, up to the
        // preferred walking limit.
        let mut direct = vec![];
        if !ride_required {
            let preferred_km = if flag(q, "allowLongWalk", true)? {
                number(q, "maxWalkKm", 1.2, 0., 100.)?.clamp(0.05, 100.)
            } else {
                number(q, "maxWalkKm", 1.2, 0., 100.)?.clamp(0.2, 5.)
            };
            let limit_m = (preferred_km * 1000.)
                .min(horizon / 3600. * opt.walk_speed.unwrap_or(self.speed) * 1000.);
            if walk.is_none() {
                let found = self.street_route(q, &ends.origin, &ends.destination, &opt, "walk")?;
                walk = Some((found["status"] == "ready").then_some(found));
            }
            if let Some(w) = walk.clone().flatten()
                && w["distanceMeters"]
                    .as_f64()
                    .is_some_and(|d| d <= limit_m + 1e-6)
            {
                let mut value = retime(&w, center, None);
                value["alternativeStrategy"] = json!("long_walk_direct");
                direct.push(Plan {
                    value,
                    source: None,
                });
            }
        }
        let primary_center = plans
            .iter()
            .find(|p| (depart(&p.value) - center).abs() < 1e-6)
            .map(|p| p.value.clone());
        let pool: Vec<Plan> = plans.into_iter().chain(tradeoffs).chain(direct).collect();
        let mut choices = select_supported(pool, center, MAXIMUM_WINDOW_CHOICES);
        // Ranked alternatives at the requested time join the window's choices.
        let mut ranked_search = None;
        if let Some(request) = crate::route_alternatives::parse(q)? {
            let request = RouteAlternativeRequest {
                limit: Some(64),
                ..request
            };
            let at = Options { ..opt };
            let search = match self.window_search(&ends, &at)? {
                Some(best) => self.window_alternatives(&ends, &at, &best, Some(&request))?,
                None => Search::default(),
            };
            ranked_search = Some(match &search.unsupported {
                None => json!({"status":"complete"}),
                Some(reason) => json!({"status":"unavailable","reason":reason}),
            });
            let mut values: Vec<Value> = choices.iter().map(|p| p.value.clone()).collect();
            let window_count = values.len();
            let mut sources: Vec<Option<(TimetableMatrixJourney, f64)>> =
                choices.iter_mut().map(|p| p.source.take()).collect();
            for alternative in search.alternatives {
                let mut value = self.window_journey(&ends, &alternative, &at, &mut cache, true)?;
                value["recommended"] = json!(false);
                value["choiceLabel"] = json!("Another route");
                values.push(value);
                sources.push(Some((alternative, center)));
            }
            if window_count > 0 {
                // The window's first choice is the primary witness.
                values.insert(0, values[0].clone());
                sources.insert(0, None);
            }
            let selected = merge_services(&values, MAXIMUM_MERGED_CHOICES);
            let mut slots: Vec<Option<Plan>> = values
                .into_iter()
                .zip(sources)
                .map(|(value, source)| Some(Plan { value, source }))
                .collect();
            if window_count > 0 {
                // The duplicated primary and its original share one source.
                slots[0].as_mut().unwrap().source = slots[1].as_mut().unwrap().source.take();
            }
            choices = selected.iter().filter_map(|&i| slots[i].take()).collect();
        }
        let shared_legs = flag(q, "sharedLegs", false)?;
        let window_record = json!({"minutes":window,"stepMinutes":step,"searches":searches,
            "coverage":"sampled_with_catch_reuse","direction":"later_departures",
            "choices":"supported","maximumJourneys":if ranked_search.is_some() {MAXIMUM_MERGED_CHOICES} else {MAXIMUM_WINDOW_CHOICES},
            "readyCount":ready_count,"sampleCount":samples.len(),"directWalkSampleReuses":walk_reuses,
            "startMinutes":center,"endMinutes":end,"windowQueryMs":started.elapsed().as_secs_f64() * 1000.,
            "earliestTransit":earliest});
        let mut values = vec![];
        for mut plan in choices {
            if shared_legs
                && plan.value["mode"] == "transit"
                && let Some((journey, t)) = &plan.source
            {
                let at = Options {
                    time: t * 60.,
                    start: t * 60.,
                    end: t * 60. + horizon,
                    ..opt
                };
                plan.value["sharedLegAlternatives"] = self.shared_leg_alternatives(
                    &plan.value,
                    journey,
                    [&ends.origin, &ends.destination],
                    &at,
                    [&ends.a, &ends.b],
                )?;
            }
            values.push(plan.value);
        }
        let mut output = match values.first() {
            Some(first) => first.clone(),
            None => {
                // No journey: the requested clock's failure, with its access evidence.
                let reason = if ends.a.stops.is_empty() || ends.b.stops.is_empty() {
                    "no_access"
                } else {
                    "no_path"
                };
                let mut blocked = primary_center
                    .filter(|p| p["status"] == "blocked")
                    .unwrap_or_else(|| json!({"status":"blocked"}));
                blocked["reason"] = json!(reason);
                blocked["mode"] = json!("transit");
                blocked["departureMinutes"] = json!(first_blocked.unwrap_or(center));
                blocked["access"] = json!({"origin":self.access_status(&ends.origin,"origin",&ends.a,&opt,true)?,
                    "destination":self.access_status(&ends.destination,"destination",&ends.b,&opt,true)?});
                blocked
            }
        };
        // A window without a journey reports its failure as the only choice.
        output["choices"] = if values.is_empty() {
            json!([output.clone()])
        } else {
            json!(values)
        };
        output["selectedChoice"] = json!(0);
        output["window"] = window_record;
        if let Some(search) = ranked_search {
            output["window"]["alternativeSearch"] = search;
        }
        output["serviceDate"] = q["serviceDate"].clone();
        output["diagnostics"]["realtime"] = self.timetable.as_ref().unwrap().realtime.clone();
        output["diagnostics"]["originAccess"] = json!({"candidateCount":ends.a.stops.len()});
        output["diagnostics"]["destinationAccess"] = json!({"candidateCount":ends.b.stops.len()});
        output["warnings"] = self.metadata["routingLimitations"].clone();
        output["dataMode"] = json!(if q.get("realtimeSnapshot").is_some()
            || self.query_live.is_some()
        {
            "realtime"
        } else {
            "scheduled"
        });
        Ok(output)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ride(trip: &str, route: &str, from: &str, to: &str, start: f64, end: f64) -> Value {
        json!({"kind":"ride","tripId":trip,"routeId":route,"route":{"shortName":route},
            "fromStopId":from,"toStopId":to,"departureMinutes":start,"arrivalMinutes":end,
            "durationMinutes":end - start})
    }
    fn walk(start: f64, end: f64) -> Value {
        json!({"kind":"walk","departureMinutes":start,"arrivalMinutes":end,"durationMinutes":end - start})
    }
    fn plan(depart: f64, legs: Vec<Value>) -> Value {
        let arrival = legs.last().unwrap()["arrivalMinutes"].as_f64().unwrap();
        let walk: f64 = legs
            .iter()
            .filter(|l| l["kind"] == "walk")
            .map(|l| l["durationMinutes"].as_f64().unwrap())
            .sum();
        json!({"status":"ready","mode":"transit","departureMinutes":depart,"arrivalMinutes":arrival,
            "durationMinutes":arrival - depart,"walkMinutes":walk,"waitMinutes":0,"legs":legs})
    }

    #[test]
    fn retiming_moves_only_the_legs_before_the_first_boarding() {
        let journey = plan(
            480.,
            vec![
                walk(480., 485.),
                ride("t", "1", "A", "B", 492., 500.),
                walk(500., 503.),
            ],
        );
        assert_eq!(latest_catch(&journey), Some(487.));
        let later = retime(&journey, 486., Some(487.));
        assert_eq!(later["departureMinutes"], 486.);
        assert_eq!(later["legs"][0]["departureMinutes"], 486.);
        assert_eq!(later["legs"][1]["departureMinutes"], 492.);
        assert_eq!(later["durationMinutes"], 17.);
        assert_eq!(later["windowSample"]["reused"], true);
    }

    #[test]
    fn supported_choices_keep_a_shorter_later_departure_and_label_roles() {
        let center = 480.;
        let early = plan(
            480.,
            vec![
                walk(480., 482.),
                ride("a", "1", "A", "B", 485., 520.),
                walk(520., 522.),
            ],
        );
        // Leaves later, arrives later, but rides much shorter: a real choice.
        let short = plan(
            500.,
            vec![
                walk(500., 502.),
                ride("b", "2", "C", "D", 503., 525.),
                walk(525., 526.),
            ],
        );
        // Dominated in every criterion by `early`.
        let worse = plan(
            480.,
            vec![
                walk(480., 484.),
                ride("c", "3", "E", "F", 486., 530.),
                walk(530., 534.),
            ],
        );
        let pool = [early, short, worse].map(|value| Plan {
            value,
            source: None,
        });
        let chosen = select_supported(pool.into_iter().collect(), center, 5);
        let labels: Vec<_> = chosen
            .iter()
            .map(|p| p.value["choiceLabel"].clone())
            .collect();
        assert_eq!(
            labels,
            vec![json!("Earliest arrival"), json!("Shortest journey")]
        );
        assert_eq!(chosen[0].value["recommended"], true);
        assert_eq!(chosen[0].value["selectedTimeChoice"], true);
    }

    #[test]
    fn one_representative_per_line_sequence_prefers_the_requested_clock() {
        let center = 480.;
        let exact = plan(
            480.,
            vec![walk(480., 482.), ride("a1", "1", "A", "B", 490., 500.)],
        );
        let later = plan(
            486.,
            vec![walk(486., 488.), ride("a1", "1", "A", "B", 490., 500.)],
        );
        let chosen = select_supported(
            vec![
                Plan {
                    value: later,
                    source: None,
                },
                Plan {
                    value: exact,
                    source: None,
                },
            ],
            center,
            5,
        );
        assert_eq!(chosen.len(), 1);
        assert_eq!(chosen[0].value["departureMinutes"], 480.);
    }

    #[test]
    fn merged_services_keep_distinct_lines_before_repeat_departures() {
        let primary = plan(480., vec![ride("m1", "M", "A", "B", 480., 504.)]);
        let repeat = plan(480., vec![ride("m2", "M", "A", "B", 482., 506.)]);
        let rail = plan(480., vec![ride("r", "Rail", "A", "B", 483., 507.)]);
        assert_eq!(
            merge_services(&[primary.clone(), repeat, rail], 2),
            vec![0, 2]
        );
        // A dominated detour that rides the same final vehicle is dropped.
        let detour = plan(
            480.,
            vec![
                ride("x", "X", "A", "C", 480., 490.),
                ride("m1", "M", "C", "B", 491., 510.),
            ],
        );
        assert_eq!(merge_services(&[primary, detour], 10), vec![0]);
    }

    #[test]
    fn merged_services_drop_dominated_stop_variants_but_keep_walking_tradeoffs() {
        let best = plan(
            480.,
            vec![
                ride("bus", "86", "A", "X", 481., 495.),
                ride("rail", "Red", "X", "Y", 499., 520.),
                ride("last", "15", "Y", "B", 522., 540.),
                walk(540., 550.),
            ],
        );
        let worse = plan(
            480.,
            vec![
                ride("bus", "86", "A", "X", 481., 495.),
                ride("rail", "Red", "X", "Y", 499., 520.),
                ride("later", "15", "Y", "C", 524., 544.),
                walk(544., 556.),
            ],
        );
        let less_walk = plan(
            480.,
            vec![
                ride("bus", "86", "A", "X", 481., 495.),
                ride("rail", "Red", "X", "Y", 499., 520.),
                ride("closest", "15", "Y", "D", 524., 550.),
                walk(550., 552.),
            ],
        );
        assert_eq!(merge_services(&[best, worse, less_walk], 10), vec![0, 2]);
    }

    #[test]
    fn merged_services_collapse_subminute_variants_without_changing_primary() {
        let primary = plan(
            480.,
            vec![ride("a", "15", "A", "B", 481., 500.), walk(500., 510.2)],
        );
        let variant = plan(
            480.,
            vec![ride("a", "15", "A", "C", 481., 500.5), walk(500.5, 510.4)],
        );
        let later = plan(
            482.,
            vec![ride("b", "15", "A", "B", 483., 502.), walk(502., 512.4)],
        );
        let less_walk = plan(
            480.,
            vec![ride("a", "15", "A", "D", 481., 503.), walk(503., 511.)],
        );
        let other_line = plan(
            480.,
            vec![ride("c", "17", "A", "C", 481., 500.5), walk(500.5, 510.4)],
        );
        let duplicate = primary.clone();
        assert_eq!(
            merge_services(
                &[primary, variant, later, less_walk, other_line, duplicate],
                10
            ),
            vec![0, 4, 3, 2]
        );
    }

    #[test]
    fn merged_services_compare_displayed_leave_times_and_rounded_clocks() {
        let primary = plan(480., vec![ride("p", "Rail", "A", "B", 480., 530.)]);
        let more_walk = plan(
            480.,
            vec![
                walk(480., 482.),
                ride("a", "51", "A", "B", 490., 534.9),
                walk(534.9, 549.9),
            ],
        );
        let less_walk = plan(
            488.,
            vec![
                walk(488., 490.),
                ride("a", "51", "A", "C", 490., 542.1),
                walk(542.1, 550.1),
            ],
        );
        assert_eq!(choice_depart(&more_walk), choice_depart(&less_walk));
        assert_eq!(
            merge_services(&[primary, more_walk, less_walk], 10),
            vec![0, 2]
        );
    }

    #[test]
    fn merged_services_drop_useless_extra_rides_but_keep_later_departures() {
        let best = plan(
            480.,
            vec![ride("bus", "14", "A", "B", 481., 500.), walk(500., 510.)],
        );
        let extra = plan(
            480.,
            vec![
                ride("bus", "14", "A", "B", 481., 500.),
                ride("extra", "22", "B", "C", 502., 505.),
                walk(505., 515.),
            ],
        );
        let later = plan(
            490.,
            vec![ride("later", "14", "A", "B", 491., 505.), walk(505., 515.)],
        );
        assert_eq!(merge_services(&[best, extra, later], 10), vec![0, 2]);
    }

    #[test]
    fn earliest_transit_prefers_the_first_boarding() {
        let a = plan(
            480.,
            vec![walk(480., 490.), ride("a", "1", "A", "B", 495., 510.)],
        );
        let b = plan(
            480.,
            vec![walk(480., 482.), ride("b", "2", "C", "D", 485., 520.)],
        );
        let evidence = earliest_transit([&a, &b]).unwrap();
        assert_eq!(evidence["firstBoardingMinutes"], 485.);
        assert_eq!(evidence["routeShortName"], "2");
    }
}

/// Ordered waypoints with supported choices: every segment offers the
/// choices a fixed-clock Route would, the user's point order is kept, and a
/// bounded frontier of complete prefixes carries alternatives forward.
mod ordered {
    use super::*;
    use std::sync::Arc;

    const PREFIX_LIMIT: usize = 8;
    const FINAL_LIMIT: usize = 5;

    pub(super) struct Prefix {
        pub components: Vec<Arc<Value>>,
        pub plan: Value,
        key: String,
    }

    fn no_op_walk(leg: &Value) -> bool {
        leg["kind"] == "walk"
            && leg["durationMinutes"].as_f64().unwrap_or(0.).max(0.) <= 0.01
            && leg["distanceMeters"].as_f64().unwrap_or(0.).max(0.) <= 0.001
    }

    /// One vehicle continuing through a waypoint is one ride.
    fn through_ride(left: &Value, right: &Value) -> Option<Value> {
        if left["kind"] != "ride"
            || right["kind"] != "ride"
            || !left["tripId"].is_string()
            || left["tripId"] != right["tripId"]
            || left["toStopId"] != right["fromStopId"]
            || (left["arrivalMinutes"].as_f64()? - right["departureMinutes"].as_f64()?).abs() > 0.01
        {
            return None;
        }
        let mut merged = left.clone();
        let object = merged.as_object_mut()?;
        // Extending the endpoints invalidates a boarding quote for the shorter leg.
        object.remove("fare");
        for key in [
            "toStopId",
            "to",
            "toStop",
            "arrival",
            "arrivalMinutes",
            "alightSequence",
        ] {
            object.insert(key.into(), right[key].clone());
        }
        let duration = right["arrivalMinutes"].as_f64()? - left["departureMinutes"].as_f64()?;
        object.insert("durationMinutes".into(), json!(duration.max(0.)));
        for key in ["distanceMeters", "stopCount"] {
            let total = left[key].as_f64().unwrap_or(0.).max(0.)
                + right[key].as_f64().unwrap_or(0.).max(0.);
            object.insert(key.into(), json!(total));
        }
        if let (Some(a), Some(b)) = (left["stopIds"].as_array(), right["stopIds"].as_array()) {
            object.insert(
                "stopIds".into(),
                json!(a.iter().chain(b.iter().skip(1)).collect::<Vec<_>>()),
            );
        }
        if let (Some(a), Some(b)) = (
            left["coordinates"].as_array(),
            right["coordinates"].as_array(),
        ) {
            let mut coordinates = a.clone();
            for point in b {
                if coordinates.last() != Some(point) {
                    coordinates.push(point.clone());
                }
            }
            object.insert("coordinates".into(), json!(coordinates));
        }
        Some(merged)
    }

    /// The complete journey through `components`, in point order.
    pub(super) fn compose(components: &[Arc<Value>]) -> Value {
        let mut legs: Vec<Value> = vec![];
        for (segment, plan) in components.iter().enumerate() {
            for leg in plan["legs"].as_array().into_iter().flatten() {
                if no_op_walk(leg) {
                    continue;
                }
                if let Some(merged) = legs.last().and_then(|last| through_ride(last, leg)) {
                    *legs.last_mut().unwrap() = merged;
                } else {
                    let mut leg = leg.clone();
                    leg["orderedSegmentIndex"] = json!(segment);
                    legs.push(leg);
                }
            }
        }
        let mode = if legs.iter().any(|leg| leg["kind"] == "ride") {
            "transit"
        } else if legs.iter().any(|leg| leg["kind"] == "drive") {
            "drive"
        } else {
            "walk"
        };
        // Exact clocks: the next segment starts at this arrival.
        let departure = components[0]["departureMinutes"]
            .as_f64()
            .unwrap_or(f64::NAN);
        let arrival = components.last().unwrap()["arrivalMinutes"]
            .as_f64()
            .unwrap_or(f64::NAN);
        let walking: f64 = legs
            .iter()
            .filter(|leg| leg["kind"] == "walk")
            .map(|leg| leg["durationMinutes"].as_f64().unwrap_or(0.).max(0.))
            .sum();
        json!({"status":"ready","mode":mode,"departureMinutes":departure,"arrivalMinutes":arrival,
            "durationMinutes":(arrival - departure).max(0.),"walkMinutes":(walking * 1000.).round() / 1000.,
            "legs":legs,"orderedSegments":components.len()})
    }

    impl Prefix {
        pub fn new(components: Vec<Arc<Value>>) -> Self {
            // The empty prefix only carries the requested clock.
            let plan = if components.is_empty() {
                Value::Null
            } else {
                compose(&components)
            };
            let key = components
                .iter()
                .map(|c| format!("{}-{}@{}", depart(c), arrive(c), witness(c)))
                .collect::<Vec<_>>()
                .join("|");
            Self {
                components,
                plan,
                key,
            }
        }
        fn metrics(&self, arrive_by: bool) -> [f64; 3] {
            [
                if arrive_by {
                    -depart(&self.plan)
                } else {
                    arrive(&self.plan)
                },
                boardings(&self.plan) as f64,
                walking(&self.plan),
            ]
        }
        fn boundary(&self, arrive_by: bool) -> String {
            let legs = legs(&self.plan);
            let leg = if arrive_by { legs.first() } else { legs.last() };
            leg.filter(|leg| leg["kind"] == "ride")
                .map_or(String::new(), |leg| {
                    format!(
                        "{}|{}",
                        text(&leg["tripId"]),
                        text(&leg[if arrive_by { "fromStopId" } else { "toStopId" }])
                    )
                })
        }
        fn family(&self) -> String {
            serde_json::to_string(
                &legs(&self.plan)
                    .iter()
                    .map(|leg| {
                        json!([
                            leg["orderedSegmentIndex"],
                            leg["kind"],
                            leg["routeId"],
                            leg["fromStopId"],
                            leg["toStopId"]
                        ])
                    })
                    .collect::<Vec<_>>(),
            )
            .unwrap()
        }
    }

    fn compare(a: &Prefix, b: &Prefix, arrive_by: bool) -> Ordering {
        let (x, y) = (a.metrics(arrive_by), b.metrics(arrive_by));
        x[0].total_cmp(&y[0])
            .then(x[1].total_cmp(&y[1]))
            .then(x[2].total_cmp(&y[2]))
            .then(
                minutes(&a.plan, "durationMinutes").total_cmp(&minutes(&b.plan, "durationMinutes")),
            )
            .then_with(|| a.key.cmp(&b.key))
    }

    /// The bounded frontier of prefixes; at the last point, of whole journeys.
    pub(super) fn frontier(
        mut candidates: Vec<Prefix>,
        arrive_by: bool,
        last: bool,
    ) -> Vec<Prefix> {
        candidates.sort_by(|a, b| compare(a, b, arrive_by));
        let mut keys = HashSet::new();
        candidates.retain(|c| keys.insert(c.key.clone()));
        let keep: Vec<bool> = (0..candidates.len())
            .map(|i| {
                !(0..candidates.len()).any(|j| {
                    if i == j
                        || (!last
                            && candidates[i].boundary(arrive_by)
                                != candidates[j].boundary(arrive_by))
                    {
                        return false;
                    }
                    let (a, b) = (
                        candidates[j].metrics(arrive_by),
                        candidates[i].metrics(arrive_by),
                    );
                    a.iter().zip(&b).all(|(x, y)| x <= y)
                        && (a.iter().zip(&b).any(|(x, y)| x < y) || j < i)
                })
            })
            .collect();
        let frontier: Vec<Prefix> = candidates
            .into_iter()
            .zip(keep)
            .filter_map(|(c, keep)| keep.then_some(c))
            .collect();
        let limit = if last { FINAL_LIMIT } else { PREFIX_LIMIT };
        let mut selected: Vec<usize> = vec![];
        let add = |selected: &mut Vec<usize>, index: Option<usize>| {
            let Some(index) = index else { return };
            if selected.contains(&index) || selected.len() >= limit {
                return;
            }
            if last
                && selected
                    .iter()
                    .any(|&s| frontier[s].family() == frontier[index].family())
            {
                return;
            }
            selected.push(index);
        };
        // The earliest-arrival (latest-departure) witness, then fewest
        // boardings and least walking, then the rest of the frontier.
        add(&mut selected, (!frontier.is_empty()).then_some(0));
        for metric in [1, 2] {
            let best = (0..frontier.len()).min_by(|&a, &b| {
                frontier[a].metrics(arrive_by)[metric]
                    .total_cmp(&frontier[b].metrics(arrive_by)[metric])
                    .then_with(|| compare(&frontier[a], &frontier[b], arrive_by))
            });
            add(&mut selected, best);
        }
        for index in 0..frontier.len() {
            add(&mut selected, Some(index));
        }
        let mut slots: Vec<Option<Prefix>> = frontier.into_iter().map(Some).collect();
        let mut chosen: Vec<Prefix> = selected.iter().filter_map(|&i| slots[i].take()).collect();
        chosen.sort_by(|a, b| compare(a, b, arrive_by));
        chosen
    }
}

impl City {
    /// One waypoint segment at an exact clock: its plan and the choices a
    /// fixed-clock Studio Route offers for it.
    fn via_segment(
        &mut self,
        q: &Value,
        origin: &Value,
        destination: &Value,
        clock: f64,
        arrive_by: bool,
    ) -> Result<Value> {
        let mut request = without_options(q);
        let object = request.as_object_mut().unwrap();
        for key in ["via", "waypoints", "time", "timeMinutes", "windowMinutes"] {
            object.remove(key);
        }
        // Every segment leaves (or arrives) at the exact clock, so no leg
        // starts before the previous one ends.
        object.insert("timeMinutes".into(), json!(clock));
        object.insert("origin".into(), origin.clone());
        object.insert("destination".into(), destination.clone());
        let transit = q["mode"].as_str().unwrap_or("transit") == "transit";
        if transit && !arrive_by {
            return self.supported_window(&request, 0.);
        }
        let mut plan = self.route_options(&request, false)?;
        let mut choices = vec![plan.clone()];
        // A complete walk remains a choice beside an arrive-by transit segment.
        if transit
            && plan["status"] == "ready"
            && rides(&plan).next().is_some()
            && !flag(q, "requireTransitRide", false)?
        {
            let opt = Options::parse(&request)?;
            let (a, b) = (self.point(origin)?, self.point(destination)?);
            let walk = self.street_route(&request, &a, &b, &opt, "walk")?;
            if walk["status"] == "ready" {
                choices.push(walk);
            }
        }
        plan["choices"] = json!(choices);
        Ok(plan)
    }

    fn supported_via(&mut self, q: &Value, via: &[Value]) -> Result<Value> {
        let opt = Options::parse(q)?;
        let arrive_by = opt.arrive;
        let mut points = vec![q["origin"].clone()];
        points.extend(via.iter().cloned());
        points.push(q["destination"].clone());
        if points.len() > 8 {
            return fail("Ordered routing requires 2-8 points");
        }
        let resolved = points
            .iter()
            .map(|p| self.point(p))
            .collect::<Result<Vec<_>>>()?;
        if let Some(i) =
            (1..resolved.len()).find(|&i| resolved[i].coordinate == resolved[i - 1].coordinate)
        {
            return fail(format!("Routing points {i} and {} are duplicates", i + 1));
        }
        if q["mode"].as_str().unwrap_or("transit") == "transit" {
            if q.get("maxTransfers").is_some() {
                return fail(
                    "maxTransfers with ordered transit waypoints is not supported; omit the waypoints or the cap",
                );
            }
            if number(q, "minimumTransferBufferMinutes", 0., 0., 60.)? > 0. {
                return fail(
                    "minimumTransferBufferMinutes with ordered transit waypoints is not supported; omit the waypoints or set the buffer to zero",
                );
            }
        }
        let indices: Vec<usize> = if arrive_by {
            (0..points.len() - 1).rev().collect()
        } else {
            (0..points.len() - 1).collect()
        };
        let mut states = vec![ordered::Prefix::new(vec![])];
        let (mut searches, mut peak) = (0, 1);
        for (step, &index) in indices.iter().enumerate() {
            let mut responses: HashMap<u64, Arc<Value>> = HashMap::new();
            let mut candidates = vec![];
            let mut failure: Option<Value> = None;
            for state in &states {
                // A later segment starts at the prefix's displayed
                // (thousandth-minute) clock.
                let clock = if state.components.is_empty() {
                    opt.time / 60.
                } else if arrive_by {
                    depart(&state.plan)
                } else {
                    arrive(&state.plan)
                };
                let key = clock.to_bits();
                if let std::collections::hash_map::Entry::Vacant(entry) = responses.entry(key) {
                    let response =
                        self.via_segment(q, &points[index], &points[index + 1], clock, arrive_by)?;
                    entry.insert(Arc::new(response));
                    searches += 1;
                }
                let response = responses[&key].clone();
                failure.get_or_insert_with(|| response.as_ref().clone());
                for plan in response["choices"].as_array().into_iter().flatten() {
                    if plan["status"] != "ready" {
                        continue;
                    }
                    let mut components = state.components.clone();
                    let plan = Arc::new(plan.clone());
                    if arrive_by {
                        components.insert(0, plan);
                    } else {
                        components.push(plan);
                    }
                    candidates.push(ordered::Prefix::new(components));
                }
            }
            if candidates.is_empty() {
                let mut leg = failure.unwrap_or_else(|| json!({"status":"blocked"}));
                if let Some(object) = leg.as_object_mut() {
                    object.remove("choices");
                }
                return Ok(
                    json!({"status":"blocked","reason":"via_leg_blocked","mode":q["mode"].as_str().unwrap_or("transit"),
                    "legIndex":index,"leg":leg,"via":via,"choices":[]}),
                );
            }
            states = ordered::frontier(candidates, arrive_by, step + 1 == indices.len());
            peak = peak.max(states.len());
        }
        let choices: Vec<Value> = states
            .iter()
            .enumerate()
            .map(|(rank, state)| {
                let mut plan = state.plan.clone();
                plan["recommended"] = json!(rank == 0);
                plan["choiceLabel"] = json!(if plan["mode"] == "walk" {
                    "Walk only"
                } else if rank > 0 {
                    "Alternative journey"
                } else if arrive_by {
                    "Latest departure"
                } else {
                    "Earliest arrival"
                });
                plan["via"] = json!(via);
                plan
            })
            .collect();
        let mut result = choices[0].clone();
        result["choices"] = json!(choices);
        result["selectedChoice"] = json!(0);
        result["serviceDate"] = q["serviceDate"].clone();
        result["diagnostics"]["orderedSearch"] = json!({"segmentQueries":searches,"peakCandidates":peak,
            "candidateLimit":8,"alternatives":"bounded_waypoint_frontier"});
        Ok(result)
    }
}
