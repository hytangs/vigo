//! Opt-in route alternatives. Both runtimes parse one request contract, ask
//! the timetable kernel for the same candidates, and apply one public
//! selection rule to the formatted journeys.
use serde_json::{Value, json};
use std::cmp::Ordering;

#[cfg(feature = "node")]
use napi_derive::napi;

/// The validated alternative request; `count` excludes the primary journey.
/// `limit` bounds the kernel's ranked completions, which may include the
/// primary journey; Pareto frontiers are returned complete.
#[cfg_attr(feature = "node", napi(object))]
#[derive(Clone, Debug, PartialEq)]
pub struct RouteAlternativeRequest {
    pub count: u32,
    pub ranking: String,
    pub arrival_slack_seconds: f64,
    pub limit: Option<u32>,
}

impl RouteAlternativeRequest {
    /// The public `alternativeSearch` record. Runtimes report only the
    /// search status; the request supplies everything else.
    pub(crate) fn descriptor(&self, status: &Value) -> Value {
        let mut search = json!({"coverage":"requested_time","ranking":self.ranking,
            "maximumJourneys":self.count + 1,
            "arrivalSlackMinutes":self.arrival_slack_seconds / 60.,
            "status":status["status"].as_str().unwrap_or("complete")});
        if let Some(reason) = status["reason"].as_str() {
            search["reason"] = json!(reason);
        }
        search
    }
}

pub(crate) fn parse(q: &Value) -> Result<Option<RouteAlternativeRequest>, String> {
    let count = match q.get("alternatives") {
        None => 0,
        Some(v) => v
            .as_u64()
            .filter(|n| *n <= 9)
            .ok_or("alternatives must be an integer 0..9")?,
    };
    let ranking = match q.get("alternativeRanking") {
        None => "pareto",
        Some(v) => v
            .as_str()
            .filter(|s| matches!(*s, "pareto" | "ranked"))
            .ok_or("alternativeRanking must be pareto or ranked")?,
    };
    let slack = match q.get("alternativeSlackMinutes") {
        None => 15.,
        Some(v) => v
            .as_f64()
            .filter(|n| (0. ..=120.).contains(n))
            .ok_or("alternativeSlackMinutes must be a number 0..120")?,
    };
    if count == 0 {
        if q.get("alternativeRanking").is_some() || q.get("alternativeSlackMinutes").is_some() {
            return Err(
                "alternativeRanking and alternativeSlackMinutes require alternatives".into(),
            );
        }
        return Ok(None);
    }
    if matches!(q["timePreference"].as_str(), Some("arrive_by" | "arrive")) {
        return Err("alternatives support depart_at searches".into());
    }
    if q["mode"].as_str().is_some_and(|mode| mode != "transit") {
        return Err("alternatives require transit mode".into());
    }
    if ["via", "waypoints"]
        .iter()
        .any(|key| q[key].as_array().is_some_and(|a| !a.is_empty()))
    {
        return Err("alternatives cannot be combined with via points".into());
    }
    // Supported window choices merge alternatives at the requested time.
    if q["windowChoices"] != "supported"
        && ["windowMinutes", "departureWindowMinutes"]
            .iter()
            .any(|key| q[key].as_f64().is_some_and(|n| n > 0.))
    {
        return Err("alternatives cannot be combined with journey windows".into());
    }
    Ok(Some(RouteAlternativeRequest {
        count: count as u32,
        ranking: ranking.into(),
        arrival_slack_seconds: slack * 60.,
        limit: (ranking == "ranked").then_some(count as u32 + 1),
    }))
}

/// Validate a JSON request and return its alternative settings, if enabled.
#[cfg(feature = "node")]
#[napi]
pub fn route_alternative_request(request: String) -> napi::Result<Option<RouteAlternativeRequest>> {
    let q: Value =
        serde_json::from_str(&request).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    parse(&q).map_err(napi::Error::from_reason)
}

struct Metrics {
    arrival: f64,
    boardings: f64,
    walking: f64,
    identity: String,
    /// Trips ridden, consecutive rides on one trip collapsed.
    vehicles: Vec<Value>,
    /// The distinct routes ridden.
    routes: Vec<String>,
}

fn clock_seconds(v: &Value) -> f64 {
    v.as_str()
        .and_then(|s| {
            let mut parts = s.split(':').map(str::parse::<f64>);
            Some(parts.next()?.ok()? * 3600. + parts.next()?.ok()? * 60. + parts.next()?.ok()?)
        })
        .unwrap_or(f64::INFINITY)
}

/// One vehicle chain: the same trips, or one chain continuing the other with
/// added trailing rides. Such journeys differ only by where the rider leaves a
/// vehicle they are already on, or by an extra ride after it.
fn same_chain(a: &[Value], b: &[Value]) -> bool {
    let (short, long) = if a.len() <= b.len() { (a, b) } else { (b, a) };
    !short.is_empty() && long.starts_with(short)
}

impl Metrics {
    fn new(journey: &Value) -> Self {
        let rides: Vec<_> = journey["legs"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|leg| leg["type"] == "transit")
            .map(|leg| {
                [
                    &leg["trip"],
                    &leg["from"]["stop"],
                    &leg["to"]["stop"],
                    &leg["departureTime"],
                    &leg["arrivalTime"],
                ]
            })
            .collect();
        let mut vehicles: Vec<Value> = rides.iter().map(|ride| ride[0].clone()).collect();
        vehicles.dedup();
        let mut routes: Vec<String> = journey["legs"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|leg| leg["type"] == "transit")
            .map(|leg| leg["route"]["id"].to_string())
            .collect();
        routes.sort();
        routes.dedup();
        Self {
            vehicles,
            routes,
            arrival: clock_seconds(&journey["arrivalTime"]),
            boardings: journey["boardings"].as_f64().unwrap_or(0.),
            walking: journey["walkingSeconds"].as_f64().unwrap_or(0.),
            identity: serde_json::to_string(&rides).expect("JSON values serialize"),
        }
    }
    fn order(&self, other: &Self) -> Ordering {
        self.arrival
            .total_cmp(&other.arrival)
            .then_with(|| self.walking.total_cmp(&other.walking))
            .then_with(|| self.boardings.total_cmp(&other.boardings))
            .then_with(|| self.identity.cmp(&other.identity))
    }
}

/// Choose public alternatives from distinct formatted journeys. Journeys on
/// one vehicle chain (see `same_chain`) are one choice: the earliest
/// arrival, then less walking and fewer boardings, wins, the primary's chain
/// included. Ranked keeps the earliest remaining arrivals. Pareto drops
/// journeys dominated by the primary or an earlier alternative; when more
/// remain than requested, the fewest boardings and least walking are kept
/// before the earliest arrivals. Free places then go to journeys within the
/// arrival slack that ride a set of routes no listed journey rides.
pub(crate) fn select(primary: &Value, candidates: Vec<Value>, search: &Value) -> Vec<Value> {
    let maximum = search["maximumJourneys"]
        .as_u64()
        .map_or(0, |n| n.saturating_sub(1) as usize);
    let mut candidates: Vec<_> = candidates
        .into_iter()
        .map(|journey| (Metrics::new(&journey), journey))
        .collect();
    candidates.sort_by(|a, b| a.0.order(&b.0));
    let mut identities = std::collections::HashSet::new();
    candidates.retain(|(metrics, _)| identities.insert(metrics.identity.clone()));
    let primary_metrics = (!primary.is_null()).then(|| Metrics::new(primary));
    {
        let mut chains: Vec<Vec<Value>> =
            primary_metrics.iter().map(|m| m.vehicles.clone()).collect();
        candidates.retain(|(metrics, _)| {
            if metrics.vehicles.is_empty() {
                return true;
            }
            let fresh = !chains
                .iter()
                .any(|chain| same_chain(chain, &metrics.vehicles));
            if fresh {
                chains.push(metrics.vehicles.clone());
            }
            fresh
        });
    }
    if search["ranking"] == "ranked" {
        // Chains are distinct already; keep the earliest arrivals.
    } else {
        // Pareto mode never removes an already accepted journey: candidates
        // arrive in order, so a later one cannot dominate an earlier one.
        let point = |m: &Metrics| [m.arrival, m.boardings, m.walking];
        let mut frontier: Vec<[f64; 3]> = if primary.is_null() {
            vec![]
        } else {
            vec![point(&Metrics::new(primary))]
        };
        let (kept, dominated): (Vec<_>, Vec<_>) =
            candidates.into_iter().partition(|(metrics, _)| {
                let candidate = point(metrics);
                let keep = !frontier
                    .iter()
                    .any(|kept| kept.iter().zip(&candidate).all(|(a, b)| a <= b));
                if keep {
                    frontier.push(candidate);
                }
                keep
            });
        candidates = kept;
        if candidates.len() > maximum {
            let mut chosen = vec![false; candidates.len()];
            let mut remaining = maximum;
            for metric in [|m: &Metrics| m.boardings, |m: &Metrics| m.walking] {
                if remaining == 0 {
                    break;
                }
                let index = (0..candidates.len())
                    .min_by(|a, b| metric(&candidates[*a].0).total_cmp(&metric(&candidates[*b].0)))
                    .unwrap();
                if !chosen[index] {
                    chosen[index] = true;
                    remaining -= 1;
                }
            }
            for flag in chosen.iter_mut() {
                if remaining == 0 {
                    break;
                }
                if !*flag {
                    *flag = true;
                    remaining -= 1;
                }
            }
            let mut flags = chosen.into_iter();
            candidates.retain(|_| flags.next().unwrap());
        }
        let latest = primary_metrics
            .as_ref()
            .map(|m| m.arrival + search["arrivalSlackMinutes"].as_f64().unwrap_or(0.) * 60.);
        if let Some(latest) = latest
            && candidates.len() < maximum
        {
            let mut route_sets: Vec<Vec<String>> = primary_metrics
                .iter()
                .chain(candidates.iter().map(|(m, _)| m))
                .map(|m| m.routes.clone())
                .collect();
            let mut extra = vec![];
            for (metrics, journey) in dominated {
                if extra.len() + candidates.len() == maximum {
                    break;
                }
                if metrics.arrival <= latest
                    && !metrics.routes.is_empty()
                    && !route_sets.contains(&metrics.routes)
                {
                    route_sets.push(metrics.routes.clone());
                    extra.push((metrics, journey));
                }
            }
            candidates.extend(extra);
            candidates.sort_by(|a, b| a.0.order(&b.0));
        }
    }
    candidates.truncate(maximum);
    candidates.into_iter().map(|(_, journey)| journey).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn journey(trip: &str, arrival: &str, boardings: u64, walking: u64) -> Value {
        json!({"departureTime":"08:00:00","arrivalTime":arrival,"boardings":boardings,
            "walkingSeconds":walking,"legs":[{"type":"transit","trip":{"id":trip}}]})
    }
    fn trips(v: &[Value]) -> Vec<&str> {
        v.iter()
            .map(|j| j["legs"][0]["trip"]["id"].as_str().unwrap())
            .collect()
    }

    #[test]
    fn parses_and_rejects_requests() {
        assert_eq!(parse(&json!({})).unwrap(), None);
        let request = parse(&json!({"alternatives":3,"alternativeRanking":"ranked"}))
            .unwrap()
            .unwrap();
        assert_eq!(request.limit, Some(4));
        assert_eq!(request.arrival_slack_seconds, 900.);
        assert_eq!(
            parse(&json!({"alternatives":2})).unwrap().unwrap().limit,
            None
        );
        for bad in [
            json!({"alternatives":10}),
            json!({"alternatives":-1}),
            json!({"alternatives":1.5}),
            json!({"alternatives":2,"alternativeRanking":"best"}),
            json!({"alternatives":2,"alternativeSlackMinutes":121}),
            json!({"alternativeRanking":"ranked"}),
            json!({"alternatives":2,"timePreference":"arrive_by"}),
            json!({"alternatives":2,"mode":"walk"}),
            json!({"alternatives":2,"via":[{"stopId":"A"}]}),
            json!({"alternatives":2,"windowMinutes":10}),
        ] {
            assert!(parse(&bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn ranked_keeps_dominated_journeys_in_order() {
        let primary = journey("p", "08:30:00", 1, 100);
        let candidates = vec![
            journey("late", "08:50:00", 1, 100),
            journey("b", "08:35:00", 2, 300),
            journey("a", "08:35:00", 1, 400),
        ];
        let search = json!({"ranking":"ranked","maximumJourneys":3});
        assert_eq!(
            trips(&select(&primary, candidates.clone(), &search)),
            ["b", "a"]
        );
        // The primary's vehicles, alighting elsewhere, are not an alternative.
        let mut same_vehicle = journey("p", "08:31:00", 1, 60);
        same_vehicle["legs"][0]["to"] = json!({"stop":{"id":"other"}});
        let search = json!({"ranking":"ranked","maximumJourneys":5});
        assert_eq!(
            trips(&select(
                &primary,
                [vec![same_vehicle], candidates].concat(),
                &search
            )),
            ["b", "a", "late"]
        );
    }

    #[test]
    fn pareto_drops_dominated_and_keeps_trade_offs() {
        let primary = journey("p", "08:30:00", 2, 300);
        let candidates = vec![
            journey("dominated", "08:40:00", 2, 300),
            journey("fewer", "08:45:00", 1, 400),
            journey("less-walk", "08:50:00", 2, 60),
            journey("later-fewer", "08:55:00", 1, 350),
        ];
        let search = json!({"ranking":"pareto","maximumJourneys":4});
        assert_eq!(
            trips(&select(&primary, candidates.clone(), &search)),
            ["fewer", "less-walk", "later-fewer"]
        );
        let two = json!({"ranking":"pareto","maximumJourneys":3});
        assert_eq!(
            trips(&select(&primary, candidates, &two)),
            ["fewer", "less-walk"]
        );
    }

    fn rides(arrival: &str, walking: u64, legs: &[(&str, &str)]) -> Value {
        json!({"departureTime":"08:00:00","arrivalTime":arrival,"boardings":legs.len(),
            "walkingSeconds":walking,"legs":legs.iter().map(|(trip, route)| json!({
                "type":"transit","trip":{"id":trip},"route":{"id":{"id":route}}})).collect::<Vec<_>>()})
    }

    #[test]
    fn pareto_keeps_route_distinct_journeys_within_the_slack() {
        let search = json!({"ranking":"pareto","maximumJourneys":4,"arrivalSlackMinutes":15});
        // The primary walks least and arrives first: it dominates everything.
        let primary = rides("09:00:00", 300, &[("59a", "59"), ("71a", "71")]);
        let picked = select(
            &primary,
            vec![
                rides("09:07:00", 420, &[("Da", "D"), ("Reda", "Red")]),
                rides("09:12:00", 600, &[("Db", "D"), ("Redb", "Red")]),
                rides("09:20:00", 400, &[("86a", "86"), ("66a", "66")]),
                rides("09:05:00", 400, &[("59b", "59"), ("71b", "71")]),
            ],
            &search,
        );
        // One D -> Red journey (the earliest); the 86 arrives beyond the slack;
        // the later 59 -> 71 rides the primary's routes.
        assert_eq!(trips(&picked), ["Da"]);
    }

    #[test]
    fn variants_of_one_vehicle_chain_are_one_choice() {
        for ranking in ["pareto", "ranked"] {
            let search = json!({"ranking":ranking,"maximumJourneys":5,"arrivalSlackMinutes":15});
            let primary = rides("09:53:00", 620, &[("D1", "D"), ("86x", "86")]);
            let picked = select(
                &primary,
                vec![
                    // The same two vehicles, alighting elsewhere.
                    rides("09:53:39", 490, &[("D1", "D"), ("86x", "86")]),
                    // The same vehicles with a bus added after them.
                    rides(
                        "09:56:00",
                        300,
                        &[("D1", "D"), ("86x", "86"), ("66z", "66")],
                    ),
                    rides("10:02:00", 410, &[("D1", "D"), ("RedA", "Red")]),
                ],
                &search,
            );
            assert_eq!(trips(&picked), ["D1"], "{ranking}");
            assert_eq!(picked[0]["legs"][1]["trip"]["id"], "RedA");
        }
    }
}
