//! Boarding fares for published route journeys from the City's saved fare
//! catalogs. The fare engine is shared with Node; this only scopes catalogs.
use super::City;
use crate::fares::{FareEngine, FareLeg};
use rusqlite::OptionalExtension;
use serde_json::{Value, json};

fn unavailable(code: &str, reason: &str) -> Value {
    json!({"status":"unavailable","code":code,"reason":reason})
}

fn missing() -> Value {
    unavailable(
        "missing_catalog",
        "Fare data was not imported with this timetable.",
    )
}

impl City {
    /// The catalog saved for one feed scope; None when that scope has none.
    fn fare_engine(&mut self, scope: &str) -> Option<&mut FareEngine> {
        if !self.fare_engines.contains_key(scope) {
            let present = self
                .db
                .query_row(
                    "SELECT 1 FROM sqlite_master WHERE name='fare_catalogs' AND type='table'",
                    [],
                    |_| Ok(()),
                )
                .optional()
                .ok()
                .flatten()
                .is_some();
            let engine = present
                .then(|| {
                    self.db
                        .query_row(
                            "SELECT data FROM fare_catalogs WHERE scope=?",
                            [scope],
                            |r| r.get::<_, rusqlite::types::Value>(0),
                        )
                        .optional()
                        .ok()
                        .flatten()
                        .map(|data| match data {
                            rusqlite::types::Value::Text(text) => FareEngine::from_json(&text),
                            _ => FareEngine::from_json(""),
                        })
                })
                .flatten();
            self.fare_engines.insert(scope.to_owned(), engine);
        }
        self.fare_engines.get_mut(scope).and_then(Option::as_mut)
    }

    fn ride_fare(&mut self, leg: &Value, service_date: &str) -> Value {
        let text = |key: &str| leg[key].as_str().unwrap_or("").to_owned();
        let (route, from, to) = (text("routeId"), text("fromStopId"), text("toStopId"));
        let (scope, prefix) = match route.rfind('\u{1f}') {
            Some(i) => (route[..i].to_owned(), format!("{}\u{1f}", &route[..i])),
            None => (String::new(), String::new()),
        };
        let Some(engine) = self.fare_engine(&scope) else {
            return missing();
        };
        if !prefix.is_empty() && !(from.starts_with(&prefix) && to.starts_with(&prefix)) {
            return missing();
        }
        let local = |id: &str| id.strip_prefix(prefix.as_str()).unwrap_or(id).to_owned();
        let seconds = |key: &str| leg[key].as_f64().map_or(f64::NAN, f64::round);
        engine.quote(
            &FareLeg {
                route_id: &local(&route),
                from_stop_id: &local(&from),
                to_stop_id: &local(&to),
                departure_seconds: seconds("departure"),
                arrival_seconds: seconds("arrival"),
                realtime_adjusted: false,
            },
            service_date,
        )
    }

    /// Price each boarding of a ready journey, as Node does for the same City.
    pub(crate) fn annotate_fares(&mut self, plan: &mut Value, service_date: &str) {
        if let Some(options) = plan
            .get_mut("sharedLegAlternatives")
            .and_then(|v| v.get_mut("options"))
            .and_then(Value::as_array_mut)
        {
            for option in options {
                self.annotate_fares(&mut option["plan"], service_date);
            }
        }
        if plan["status"] != "ready" {
            return;
        }
        let Some(legs) = plan.get_mut("legs").and_then(Value::as_array_mut) else {
            return;
        };
        // Existing fare catalogs quote individual boardings, not linked-trip
        // fare-leg joins. Do not quote a second fare or promise a free transfer.
        let linked = legs.iter().any(|leg| leg.get("inSeatSeconds").is_some());
        for leg in legs.iter_mut().filter(|leg| leg["kind"] == "ride") {
            if linked {
                leg["fare"] = unavailable(
                    "linked_trip_fare",
                    "The fare catalog cannot price this through journey.",
                );
                continue;
            }
            let fare = self.ride_fare(leg, service_date);
            leg["fare"] = fare;
        }
    }
}
