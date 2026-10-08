use serde_json::{Value, json};
use std::cmp::Ordering;

fn number(v: &Value, name: &str) -> f64 {
    v[name].as_f64().unwrap_or(0.)
}
pub(super) fn boardings(v: &Value) -> f64 {
    v["boardings"].as_f64().unwrap_or_else(|| {
        v["legs"]
            .as_array()
            .map_or(0, |a| a.iter().filter(|l| l["kind"] == "ride").count()) as f64
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
    json!(v["legs"].as_array().map(|a| {
        a.iter()
            .filter(|l| l["kind"] == "ride")
            .map(|l| {
                json!([
                    l["routeId"],
                    l["directionId"],
                    l["tripId"],
                    l["fromStopId"],
                    l["toStopId"],
                    l["departure"],
                    l["arrival"]
                ])
            })
            .collect::<Vec<_>>()
    }))
    .to_string()
}
fn order(a: &Value, b: &Value, arrive: bool) -> Ordering {
    let primary = if arrive {
        number(b, "departureMinutes").total_cmp(&number(a, "departureMinutes"))
    } else {
        number(a, "arrivalMinutes").total_cmp(&number(b, "arrivalMinutes"))
    };
    primary
        .then_with(|| boardings(a).total_cmp(&boardings(b)))
        .then_with(|| walking(a).total_cmp(&walking(b)))
        .then_with(|| number(a, "arrivalMinutes").total_cmp(&number(b, "arrivalMinutes")))
        .then_with(|| identity(a).cmp(&identity(b)))
}
fn dominates(a: &Value, b: &Value, arrive: bool) -> bool {
    let arrival = number(a, "arrivalMinutes") <= number(b, "arrivalMinutes");
    let departure = !arrive || number(a, "departureMinutes") >= number(b, "departureMinutes");
    arrival && departure && boardings(a) <= boardings(b) && walking(a) <= walking(b)
}
pub(super) fn select(mut choices: Vec<Value>, arrive: bool, maximum: usize) -> Vec<Value> {
    choices.retain(|v| v["status"] == "ready");
    choices.sort_by(|a, b| order(a, b, arrive));
    let mut signatures = std::collections::HashSet::new();
    choices.retain(|v| signatures.insert(identity(v)));
    let mut frontier: Vec<Value> = vec![];
    for candidate in choices {
        if frontier.iter().any(|v| dominates(v, &candidate, arrive)) {
            continue;
        }
        frontier.retain(|v| !dominates(&candidate, v, arrive));
        frontier.push(candidate);
    }
    frontier.sort_by(|a, b| order(a, b, arrive));
    if frontier.len() <= maximum { return frontier; }
    if maximum == 0 { return vec![]; }
    let mut selected = vec![0];
    for metric in [boardings, walking] {
        if selected.len() == maximum { break; }
        let index = (0..frontier.len()).min_by(|a,b| metric(&frontier[*a]).total_cmp(&metric(&frontier[*b]))).unwrap();
        if !selected.contains(&index) { selected.push(index); }
    }
    for index in 0..frontier.len() {
        if selected.len() == maximum { break; }
        if !selected.contains(&index) { selected.push(index); }
    }
    frontier.into_iter().enumerate().filter_map(|(i,v)| selected.contains(&i).then_some(v)).collect()
}
