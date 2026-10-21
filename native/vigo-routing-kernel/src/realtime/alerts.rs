//! GTFS-Realtime Service Alerts against one realtime view (RFC 0002).
//!
//! `NO_SERVICE` removes the selected service, or closes the selected stops to
//! boarding and alighting, for the alert's active periods. Vehicles still pass
//! through a closed stop. Every fresh alert is also kept for the legs it
//! describes, so a Result shows riders the alerts that affect their journey.
//!
//! An informed entity matches when all of its fields match; an alert applies
//! when any of its entities matches. Agency-only entities are reported as not
//! applied, because a City does not record the agency of each route.
use super::{Result, TimetableNames, fail, local_id, same_id};
use serde_json::{Map, Value, json};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

const MAXIMUM_ALERTS: usize = 10_000;
const MAXIMUM_ENTITIES: usize = 10_000;

pub(crate) struct Alerts {
    alerts: Vec<Alert>,
    /// POSIX seconds of the view's service-time origin.
    day_start: i64,
    names: TimetableNames,
    route_types: Arc<HashMap<String, i64>>,
}

struct Alert {
    summary: Value,
    periods: Vec<(i64, i64)>,
    selectors: Vec<Selector>,
    no_service: bool,
}

#[derive(Default)]
struct Selector {
    scope: Option<String>,
    route: Option<String>,
    route_type: Option<i64>,
    direction: Option<String>,
    trips: Option<Vec<u32>>,
    stops: Option<Vec<u32>>,
}

/// The compiled view's mutable service and the arrays that locate it.
pub(crate) struct Service<'a> {
    pub departure_seconds: &'a [u32],
    pub arrival_seconds: &'a [u32],
    pub from_stop: &'a [u32],
    pub to_stop: &'a [u32],
    pub trip_start: &'a [u32],
    pub can_board: &'a mut [u8],
    pub can_alight: &'a mut [u8],
}

fn text(value: &Value) -> Option<String> {
    match value {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}
fn effect(value: &Value) -> &str {
    match value {
        Value::Number(n) => vigo_gtfs::realtime::effect_label(n.as_u64().unwrap_or(0)),
        Value::String(s) => s,
        _ => "UNKNOWN_EFFECT",
    }
}

impl Selector {
    fn trip_level(&self) -> bool {
        self.route.is_some() || self.route_type.is_some() || self.trips.is_some()
    }
    fn matches_trip(
        &self,
        names: &TimetableNames,
        types: &HashMap<String, i64>,
        trip: u32,
    ) -> bool {
        let index = trip as usize;
        self.trips
            .as_ref()
            .is_none_or(|t| t.binary_search(&trip).is_ok())
            && self
                .route
                .as_ref()
                .is_none_or(|r| same_id(r, &names.route_ids[index]))
            && self
                .route_type
                .is_none_or(|t| types.get(&names.route_ids[index]) == Some(&t))
            && self
                .direction
                .as_ref()
                .is_none_or(|d| *d == names.direction_ids[index])
            && self
                .scope
                .as_ref()
                .is_none_or(|s| names.trip_ids[index].split('\u{1f}').next() == Some(s.as_str()))
    }
    fn matches_stop(&self, stop: u32) -> bool {
        self.stops
            .as_ref()
            .is_none_or(|s| s.binary_search(&stop).is_ok())
    }
}

impl Alert {
    fn active(&self, time: i64) -> bool {
        self.periods.is_empty() || self.periods.iter().any(|&(s, e)| s <= time && time <= e)
    }
    fn active_between(&self, start: i64, end: i64) -> bool {
        self.periods.is_empty() || self.periods.iter().any(|&(s, e)| s <= end && start <= e)
    }
}

impl Alerts {
    /// Resolves alert records against `names`. `parents` maps each stop to its
    /// parent station's index (`u32::MAX` for none), so a station closes its
    /// platforms. Stale records are counted and ignored.
    pub(crate) fn compile(
        records: &Value,
        names: &TimetableNames,
        route_types: Arc<HashMap<String, i64>>,
        parents: &[u32],
        day_start: i64,
        fresh: impl Fn(&Value) -> bool,
        diagnostics: &mut Value,
    ) -> Result<Self> {
        let records = records
            .as_array()
            .ok_or("realtimeSnapshot.alerts must be an array")?;
        if records.len() > MAXIMUM_ALERTS {
            return fail(format!("Realtime snapshot exceeds {MAXIMUM_ALERTS} alerts"));
        }
        let mut alerts = vec![];
        let (mut stale, mut unsupported, mut entities) = (0, 0, 0);
        for record in records {
            if !record.is_object() {
                return fail("Each realtime alert must be an object");
            }
            if !fresh(record) {
                stale += 1;
                continue;
            }
            let mut periods = vec![];
            for period in record["activePeriods"].as_array().into_iter().flatten() {
                let bound = |key: &str, open: i64| {
                    period
                        .get(key)
                        .filter(|v| !v.is_null())
                        .map_or(Ok(open), |v| {
                            v.as_i64()
                                .ok_or("Alert active periods must be integer POSIX seconds")
                        })
                };
                periods.push((bound("start", i64::MIN)?, bound("end", i64::MAX)?));
            }
            let mut selectors = vec![];
            for entity in record["informedEntities"].as_array().into_iter().flatten() {
                entities += 1;
                if entities > MAXIMUM_ENTITIES {
                    return fail(format!(
                        "Realtime alerts exceed {MAXIMUM_ENTITIES} informed entities"
                    ));
                }
                match Self::selector(entity, record, names, parents) {
                    Some(selector) => selectors.push(selector),
                    None => unsupported += 1,
                }
            }
            let mut summary = Map::new();
            summary.insert("effect".into(), json!(effect(&record["effect"])));
            for key in ["id", "cause", "severity", "header", "description", "url"] {
                if let Some(value) = record.get(key).filter(|v| !v.is_null()) {
                    summary.insert(key.into(), value.clone());
                }
            }
            alerts.push(Alert {
                no_service: effect(&record["effect"]) == "NO_SERVICE",
                summary: Value::Object(summary),
                periods,
                selectors,
            });
        }
        diagnostics["alerts"] = json!({"received":records.len(),"fresh":alerts.len(),"stale":stale,
            "noService":alerts.iter().filter(|a| a.no_service).count(),"unsupportedEntities":unsupported,
            "closedBoardings":0,"closedAlightings":0});
        Ok(Self {
            alerts,
            day_start,
            names: names.clone(),
            route_types,
        })
    }

    fn selector(
        entity: &Value,
        record: &Value,
        names: &TimetableNames,
        parents: &[u32],
    ) -> Option<Selector> {
        let mut selector = Selector {
            scope: text(&record["sourceScope"]),
            route: text(&entity["routeId"]).or_else(|| text(&entity["trip"]["routeId"])),
            route_type: entity["routeType"].as_i64(),
            direction: text(&entity["directionId"])
                .or_else(|| text(&entity["trip"]["directionId"])),
            ..Selector::default()
        };
        if let Some(trip) = text(&entity["trip"]["tripId"]) {
            let mut trips: Vec<u32> = names
                .trip_index()
                .matches(&names.trip_ids, &trip)
                .map(|i| i as u32)
                .collect();
            trips.sort_unstable();
            selector.trips = Some(trips);
        }
        if let Some(stop) = text(&entity["stopId"]) {
            // A station selects its own platforms, entrances and nodes, within
            // the alert's static feed when it names one.
            let scope = selector.scope.as_deref();
            let selected = |index: usize| {
                if scope.is_some_and(|s| names.stop_ids[index].split('\u{1f}').next() != Some(s)) {
                    return false;
                }
                let mut current = index;
                for _ in 0..4 {
                    if same_id(&stop, &names.stop_ids[current]) {
                        return true;
                    }
                    match parents.get(current) {
                        Some(&parent) if parent != u32::MAX => current = parent as usize,
                        _ => return false,
                    }
                }
                false
            };
            selector.stops = Some(
                (0..names.stop_ids.len())
                    .filter(|&i| selected(i))
                    .map(|i| i as u32)
                    .collect(),
            );
        }
        // A direction only qualifies a route, and an agency is not resolvable.
        let resolvable = selector.trip_level() || selector.stops.is_some();
        (resolvable
            && (selector.direction.is_none()
                || selector.route.is_some()
                || selector.trips.is_some()))
        .then_some(selector)
    }

    /// Applies NO_SERVICE to the compiled view and counts what it closed.
    pub(crate) fn apply(&self, service: Service, diagnostics: &mut Value) {
        let (names, types) = (&self.names, self.route_types.as_ref());
        let routes = names.route_trips();
        let (mut boardings, mut alightings) = (0_u64, 0_u64);
        let at = |seconds: u32| self.day_start + i64::from(seconds);
        // Stop-only closures share one pass over every segment.
        let mut closed: HashMap<u32, Vec<&Alert>> = HashMap::new();
        for alert in self.alerts.iter().filter(|a| a.no_service) {
            for selector in &alert.selectors {
                if !selector.trip_level() {
                    for &stop in selector.stops.iter().flatten() {
                        closed.entry(stop).or_default().push(alert);
                    }
                    continue;
                }
                let candidates: Box<dyn Iterator<Item = u32>> =
                    match (&selector.trips, &selector.route) {
                        (Some(trips), _) => Box::new(trips.iter().copied()),
                        (None, Some(route)) => {
                            Box::new(routes.get(local_id(route)).into_iter().flatten().copied())
                        }
                        (None, None) => Box::new(0..names.trip_ids.len() as u32),
                    };
                for trip in candidates.filter(|&t| selector.matches_trip(names, types, t)) {
                    let segments = service.trip_start[trip as usize] as usize
                        ..service.trip_start[trip as usize + 1] as usize;
                    for s in segments {
                        if service.can_board[s] == 1
                            && selector.matches_stop(service.from_stop[s])
                            && alert.active(at(service.departure_seconds[s]))
                        {
                            service.can_board[s] = 0;
                            boardings += 1;
                        }
                        if service.can_alight[s] == 1
                            && selector.matches_stop(service.to_stop[s])
                            && alert.active(at(service.arrival_seconds[s]))
                        {
                            service.can_alight[s] = 0;
                            alightings += 1;
                        }
                    }
                }
            }
        }
        if !closed.is_empty() {
            for s in 0..service.departure_seconds.len() {
                if service.can_board[s] == 1
                    && closed.get(&service.from_stop[s]).is_some_and(|a| {
                        a.iter().any(|a| a.active(at(service.departure_seconds[s])))
                    })
                {
                    service.can_board[s] = 0;
                    boardings += 1;
                }
                if service.can_alight[s] == 1
                    && closed
                        .get(&service.to_stop[s])
                        .is_some_and(|a| a.iter().any(|a| a.active(at(service.arrival_seconds[s]))))
                {
                    service.can_alight[s] = 0;
                    alightings += 1;
                }
            }
        }
        diagnostics["alerts"]["closedBoardings"] = json!(boardings);
        diagnostics["alerts"]["closedAlightings"] = json!(alightings);
    }

    /// The alerts active during a ride that describe its trip, route or any
    /// stop it calls at.
    pub(crate) fn for_ride(
        &self,
        trip: u32,
        stops: &[u32],
        departure: f64,
        arrival: f64,
    ) -> Vec<Value> {
        let (names, types) = (&self.names, self.route_types.as_ref());
        let (start, end) = (
            self.day_start + departure as i64,
            self.day_start + arrival.ceil() as i64,
        );
        let stops: HashSet<u32> = stops.iter().copied().collect();
        self.alerts
            .iter()
            .filter(|a| a.active_between(start, end))
            .filter(|a| {
                a.selectors.iter().any(|s| {
                    (!s.trip_level() || s.matches_trip(names, types, trip))
                        && s.stops
                            .as_ref()
                            .is_none_or(|selected| selected.iter().any(|x| stops.contains(x)))
                })
            })
            .map(|a| a.summary.clone())
            .collect()
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.alerts.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Two feeds share local IDs. Feed `a` has station P with platform S1 and
    // trips on R1 and R2 calling at S1; feed `b` has its own S1.
    fn names() -> TimetableNames {
        let ids = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Arc<[_]>>();
        TimetableNames::new(
            ids(&["a\u{1f}P", "a\u{1f}S1", "a\u{1f}S2", "b\u{1f}S1", "b\u{1f}S2"]),
            ids(&["a\u{1f}T1", "a\u{1f}T2", "b\u{1f}T1"]),
            ids(&["a\u{1f}R1", "a\u{1f}R2", "b\u{1f}R1"]),
            ids(&["0", "1", "0"]),
            ids(&["", "", ""]),
        )
    }
    fn compile(alerts: Value) -> (Alerts, Value) {
        let mut diagnostics = json!({});
        let parents = [u32::MAX, 0, u32::MAX, u32::MAX, u32::MAX];
        let alerts = Alerts::compile(
            &alerts,
            &names(),
            Arc::default(),
            &parents,
            0,
            |_| true,
            &mut diagnostics,
        )
        .unwrap();
        (alerts, diagnostics)
    }
    // One segment per trip: S1 -> S2 at 100..200 (feed a), and feed b's own.
    fn closed(alerts: &Alerts) -> (Vec<u8>, Vec<u8>) {
        let (mut board, mut alight) = (vec![1; 3], vec![1; 3]);
        alerts.apply(
            Service {
                departure_seconds: &[100, 100, 100],
                arrival_seconds: &[200, 200, 200],
                from_stop: &[1, 1, 3],
                to_stop: &[2, 2, 4],
                trip_start: &[0, 1, 2, 3],
                can_board: &mut board,
                can_alight: &mut alight,
            },
            &mut json!({"alerts":{}}),
        );
        (board, alight)
    }

    #[test]
    fn stations_scopes_and_route_stop_pairs_select_exactly_their_service() {
        // The station closes its platform, but only within its own feed.
        let (alerts, _) = compile(
            json!([{"effect":"NO_SERVICE","sourceScope":"a","informedEntities":[{"stopId":"P"}]}]),
        );
        assert_eq!(closed(&alerts), (vec![0, 0, 1], vec![1, 1, 1]));
        // Without a scope, a local ID selects that stop in every feed.
        let (alerts, _) = compile(json!([{"effect":1,"informedEntities":[{"stopId":"S2"}]}]));
        assert_eq!(closed(&alerts), (vec![1, 1, 1], vec![0, 0, 0]));
        // A route and stop together close only that route at that stop.
        let (alerts, _) = compile(
            json!([{"effect":"NO_SERVICE","sourceScope":"a","informedEntities":[{"routeId":"R2","stopId":"S1"}]}]),
        );
        assert_eq!(closed(&alerts), (vec![1, 0, 1], vec![1, 1, 1]));
        // A direction narrows a route; a period outside the ride changes nothing.
        let (alerts, _) = compile(json!([
            {"effect":"NO_SERVICE","informedEntities":[{"routeId":"R1","directionId":0}],"activePeriods":[{"start":0,"end":150}]},
            {"effect":"NO_SERVICE","informedEntities":[{"routeId":"R2"}],"activePeriods":[{"start":300}]},
        ]));
        assert_eq!(closed(&alerts), (vec![0, 1, 0], vec![1, 1, 1]));
    }

    #[test]
    fn unresolvable_entities_are_reported_and_rides_list_their_alerts() {
        let (alerts, diagnostics) = compile(json!([
            {"id":"agency","effect":"NO_SERVICE","informedEntities":[{"agencyId":"a"},{"directionId":1}]},
            {"id":"detour","effect":"DETOUR","header":"Detour","informedEntities":[{"trip":{"tripId":"T2"}}]},
            {"id":"stop","effect":"STOP_MOVED","informedEntities":[{"stopId":"S2"}],"activePeriods":[{"end":50}]},
        ]));
        assert_eq!(diagnostics["alerts"]["unsupportedEntities"], 2);
        assert_eq!(closed(&alerts), (vec![1; 3], vec![1; 3]));
        // T2 matches in both feeds by its local ID; the ride window excludes
        // the stop alert that ended before departure.
        let ride = alerts.for_ride(1, &[1, 2], 100., 200.);
        assert_eq!(
            ride,
            vec![json!({"id":"detour","effect":"DETOUR","header":"Detour"})]
        );
        assert!(alerts.for_ride(0, &[1, 2], 100., 200.).is_empty());
        assert_eq!(alerts.for_ride(0, &[1, 2], 0., 40.)[0]["id"], "stop");
    }
}
