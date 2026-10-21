use serde_json::Value;
use std::cmp::Ordering;

fn number(v: &Value, name: &str) -> f64 {
    v[name].as_f64().unwrap_or(0.)
}
pub(super) fn boardings(v: &Value) -> f64 {
    v["boardings"].as_f64().unwrap_or_else(|| {
        v["legs"].as_array().map_or(0, |a| {
            a.iter()
                .filter(|l| l["kind"] == "ride" && l["inSeatSeconds"].is_null())
                .count()
        }) as f64
    })
}
pub(super) fn walking(v: &Value) -> f64 {
    v["walkMinutes"].as_f64().unwrap_or_else(|| {
        v["legs"].as_array().map_or(0., |a| {
            a.iter()
                .filter(|l| l["kind"] == "walk")
                .map(|l| number(l, "durationMinutes"))
                .sum()
        })
    })
}
fn identity(v: &Value) -> String {
    let rides = v["legs"].as_array().map(|legs| {
        legs.iter()
            .filter(|leg| leg["kind"] == "ride")
            .map(|leg| {
                [
                    &leg["routeId"],
                    &leg["directionId"],
                    &leg["tripId"],
                    &leg["fromStopId"],
                    &leg["toStopId"],
                    &leg["departure"],
                    &leg["arrival"],
                ]
            })
            .collect::<Vec<_>>()
    });
    // Borrow the identity fields: geometry and presentation data are not copied.
    serde_json::to_string(&rides).expect("JSON values serialize")
}
struct Candidate {
    value: Value,
    arrival: f64,
    departure: f64,
    boardings: f64,
    walking: f64,
    identity: String,
}
impl Candidate {
    fn new(value: Value) -> Self {
        Self {
            arrival: number(&value, "arrivalMinutes"),
            departure: number(&value, "departureMinutes"),
            boardings: boardings(&value),
            walking: walking(&value),
            identity: identity(&value),
            value,
        }
    }
}
fn order(a: &Candidate, b: &Candidate, arrive: bool) -> Ordering {
    let primary = if arrive {
        b.departure.total_cmp(&a.departure)
    } else {
        a.arrival.total_cmp(&b.arrival)
    };
    primary
        .then_with(|| a.boardings.total_cmp(&b.boardings))
        .then_with(|| a.walking.total_cmp(&b.walking))
        .then_with(|| a.arrival.total_cmp(&b.arrival))
        .then_with(|| a.identity.cmp(&b.identity))
}
/// Ranked candidates have already passed the native route constraints. Promote
/// less walking only when the time objective ties; never trade away arrival.
pub(super) fn promote_ranked(primary: &mut Value, choices: &mut [Value], arrive: bool) {
    if primary["status"] != "ready" {
        return;
    }
    let arrival = number(primary, "arrivalMinutes");
    let departure = number(primary, "departureMinutes");
    let current_walk = walking(primary);
    let best = choices
        .iter()
        .enumerate()
        .filter(|(_, c)| {
            c["status"] == "ready"
                && number(c, "arrivalMinutes") == arrival
                && (!arrive || number(c, "departureMinutes") == departure)
                && walking(c) < current_walk
        })
        .min_by(|(_, a), (_, b)| {
            walking(a)
                .total_cmp(&walking(b))
                .then_with(|| boardings(a).total_cmp(&boardings(b)))
        })
        .map(|(i, _)| i);
    if let Some(index) = best {
        std::mem::swap(primary, &mut choices[index]);
    }
}
fn dominates(a: &Candidate, b: &Candidate, arrive: bool) -> bool {
    a.arrival <= b.arrival
        && (!arrive || a.departure >= b.departure)
        && a.boardings <= b.boardings
        && a.walking <= b.walking
}
pub(super) fn select(choices: Vec<Value>, arrive: bool, maximum: usize) -> Vec<Value> {
    if maximum == 0 {
        return vec![];
    }
    let mut choices: Vec<_> = choices
        .into_iter()
        .filter(|v| v["status"] == "ready")
        .map(Candidate::new)
        .collect();
    choices.sort_by(|a, b| order(a, b, arrive));
    let mut signatures = std::collections::HashSet::new();
    choices.retain(|v| signatures.insert(v.identity.clone()));
    let mut frontier: Vec<Candidate> = vec![];
    for candidate in choices {
        if frontier.iter().any(|v| dominates(v, &candidate, arrive)) {
            continue;
        }
        frontier.retain(|v| !dominates(&candidate, v, arrive));
        frontier.push(candidate);
    }
    frontier.sort_by(|a, b| order(a, b, arrive));
    if frontier.len() <= maximum {
        return frontier.into_iter().map(|v| v.value).collect();
    }
    let mut selected = vec![0];
    for metric in [|v: &Candidate| v.boardings, |v: &Candidate| v.walking] {
        if selected.len() == maximum {
            break;
        }
        let index = (0..frontier.len())
            .min_by(|a, b| metric(&frontier[*a]).total_cmp(&metric(&frontier[*b])))
            .unwrap();
        if !selected.contains(&index) {
            selected.push(index);
        }
    }
    for index in 0..frontier.len() {
        if selected.len() == maximum {
            break;
        }
        if !selected.contains(&index) {
            selected.push(index);
        }
    }
    frontier
        .into_iter()
        .enumerate()
        .filter_map(|(i, v)| selected.contains(&i).then_some(v.value))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn journey(id: &str, departure: f64, arrival: f64, rides: f64, walk: f64) -> Value {
        json!({"status": "ready", "id": id, "departureMinutes": departure,
            "arrivalMinutes": arrival, "boardings": rides, "walkMinutes": walk,
            "legs": [{"kind": "ride", "tripId": id}]})
    }

    fn ids(choices: Vec<Value>) -> Vec<String> {
        choices
            .iter()
            .map(|v| v["id"].as_str().unwrap().to_owned())
            .collect()
    }

    #[test]
    fn connected_transfer_wins_only_on_equal_time() {
        for arrive in [false, true] {
            let mut primary = journey("street", 0., 30., 2., 9.);
            let mut choices = vec![
                journey("connected", 0., 30., 3., 4.),
                journey("later", 0., 31., 1., 0.),
            ];
            promote_ranked(&mut primary, &mut choices, arrive);
            assert_eq!(primary["id"], "connected");
            let mut faster = journey("fast-street", 0., 29., 2., 9.);
            promote_ranked(&mut faster, &mut choices, arrive);
            assert_eq!(faster["id"], "fast-street");
        }
    }
    #[test]
    fn window_duplicates_keep_best_departure_and_arrival_choices() {
        let choices = vec![
            journey("a", 10., 30., 2., 5.),
            journey("a", 15., 30., 2., 5.),
            journey("b", 20., 35., 2., 5.),
            journey("dominated", 5., 40., 3., 6.),
            json!({"status": "blocked"}),
        ];
        let depart = select(choices.clone(), false, 5);
        assert_eq!(depart.len(), 1);
        assert_eq!(depart[0]["departureMinutes"], 10.);
        let arrive = select(choices, true, 5);
        assert_eq!(ids(arrive.clone()), ["b", "a"]);
        assert_eq!(arrive[1]["departureMinutes"], 15.);
    }

    #[test]
    fn leg_metrics_and_identity_break_ties_consistently() {
        let mut a = journey("a", 10., 30., 1., 2.);
        a.as_object_mut().unwrap().remove("boardings");
        a.as_object_mut().unwrap().remove("walkMinutes");
        a["legs"].as_array_mut().unwrap().push(json!({
            "kind": "walk", "durationMinutes": 2.
        }));
        let b = journey("b", 10., 30., 1., 2.);
        for arrive in [false, true] {
            assert_eq!(ids(select(vec![b.clone(), a.clone()], arrive, 5)), ["a"]);
        }
    }

    #[test]
    fn limited_choices_preserve_fastest_fewest_rides_and_least_walking() {
        let choices = vec![
            journey("fastest", 0., 20., 3., 10.),
            journey("balanced", 0., 25., 2., 7.),
            journey("fewest", 0., 30., 1., 9.),
            journey("least-walk", 0., 35., 2., 1.),
        ];
        assert!(select(choices.clone(), false, 0).is_empty());
        assert_eq!(ids(select(choices.clone(), false, 1)), ["fastest"]);
        assert_eq!(
            ids(select(choices, false, 3)),
            ["fastest", "fewest", "least-walk"]
        );
    }
}
