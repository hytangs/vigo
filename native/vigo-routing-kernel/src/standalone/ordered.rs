use super::alternatives::{boardings, walking};
use serde_json::{Value, json};
use std::{cmp::Ordering, sync::Arc};

pub(super) const LIMIT: usize = 8;

#[derive(Clone)]
pub(super) struct Candidate {
    pub pieces: Vec<Arc<Value>>,
    pub clock: f64,
    boardings: f64,
    walking: f64,
}

impl Candidate {
    pub fn start(clock: f64) -> Self {
        Self {
            pieces: vec![],
            clock,
            boardings: 0.,
            walking: 0.,
        }
    }
    pub fn extend(&self, piece: Arc<Value>, arrive: bool) -> Self {
        let mut next = self.clone();
        next.clock = piece[if arrive {
            "departureMinutes"
        } else {
            "arrivalMinutes"
        }]
        .as_f64()
        .unwrap();
        next.boardings += boardings(&piece);
        next.walking += walking(&piece);
        let previous = if arrive {
            self.pieces.first()
        } else {
            self.pieces.last()
        };
        if let Some(previous) = previous {
            let (left, right) = if arrive {
                (piece.as_ref(), previous.as_ref())
            } else {
                (previous.as_ref(), piece.as_ref())
            };
            if let (Some(a), Some(b)) = (boundary_leg(left, false), boundary_leg(right, true))
                && a["kind"] == "ride"
                && b["kind"] == "ride"
                && !a["tripId"].is_null()
                && a["tripId"] == b["tripId"]
                && a["toStopId"] == b["fromStopId"]
                && (a["arrival"].as_f64().unwrap_or(-1.) - b["departure"].as_f64().unwrap_or(-2.))
                    .abs()
                    < 0.001
            {
                next.boardings -= 1.;
            }
        }
        if arrive {
            next.pieces.insert(0, piece);
        } else {
            next.pieces.push(piece);
        }
        // Prefix/suffix geometry remains in one shared segment allocation.
        next
    }
    fn boundary(&self, arrive: bool) -> String {
        let piece = if arrive {
            self.pieces.first()
        } else {
            self.pieces.last()
        };
        let leg = piece.and_then(|v| boundary_leg(v, arrive));
        leg.filter(|v| v["kind"] == "ride")
            .map_or(String::new(), |v| {
                json!([
                    v["tripId"],
                    v[if arrive { "fromStopId" } else { "toStopId" }]
                ])
                .to_string()
            })
    }
    fn identity(&self) -> String {
        json!(
            self.pieces
                .iter()
                .map(|piece| json!([
                    piece["mode"],
                    piece["legs"].as_array().map(|legs| legs
                        .iter()
                        .filter(|leg| leg["kind"] == "ride")
                        .map(|leg| json!([
                            leg["tripId"],
                            leg["fromStopId"],
                            leg["toStopId"],
                            leg["departure"],
                            leg["arrival"]
                        ]))
                        .collect::<Vec<_>>())
                ]))
                .collect::<Vec<_>>()
        )
        .to_string()
    }
    fn metrics(&self, arrive: bool) -> [f64; 3] {
        [
            if arrive { -self.clock } else { self.clock },
            self.boardings,
            self.walking,
        ]
    }
    pub fn finish(&self, via: &Value) -> Value {
        let departure = self.pieces[0]["departureMinutes"].as_f64().unwrap();
        let arrival = self.pieces.last().unwrap()["arrivalMinutes"]
            .as_f64()
            .unwrap();
        let mode = if self.pieces.iter().all(|v| v["mode"] == "walk") {
            "walk"
        } else if self.pieces.iter().all(|v| v["mode"] == "drive") {
            "drive"
        } else {
            "transit"
        };
        json!({"status":"ready","mode":mode,"departureMinutes":departure,"arrivalMinutes":arrival,
            "durationMinutes":arrival-departure,"boardings":self.boardings,"walkMinutes":self.walking,
            "segments":self.pieces.iter().map(AsRef::as_ref).collect::<Vec<&Value>>(),"via":via})
    }
}

fn boundary_leg(piece: &Value, first: bool) -> Option<&Value> {
    let mut legs = piece["legs"].as_array()?.iter().filter(|leg| {
        leg["kind"] != "walk" || leg["durationMinutes"].as_f64().unwrap_or(0.) > 0.000001
    });
    if first { legs.next() } else { legs.next_back() }
}

fn compare(a: &Candidate, b: &Candidate, arrive: bool) -> Ordering {
    let a = a.metrics(arrive);
    let b = b.metrics(arrive);
    a[0].total_cmp(&b[0])
        .then_with(|| a[1].total_cmp(&b[1]))
        .then_with(|| a[2].total_cmp(&b[2]))
}

pub(super) fn select(
    mut candidates: Vec<Candidate>,
    arrive: bool,
    final_step: bool,
) -> Vec<Candidate> {
    candidates.sort_by(|a, b| compare(a, b, arrive));
    let mut seen = std::collections::HashSet::new();
    candidates.retain(|v| seen.insert(v.identity()));
    let mut frontier: Vec<Candidate> = vec![];
    for candidate in candidates {
        let c = candidate.metrics(arrive);
        if frontier.iter().any(|v| {
            (final_step || v.boundary(arrive) == candidate.boundary(arrive))
                && v.metrics(arrive).iter().zip(c).all(|(a, b)| *a <= b)
        }) {
            continue;
        }
        frontier.push(candidate);
    }
    let maximum = if final_step { 5 } else { LIMIT };
    if frontier.len() <= maximum {
        return frontier;
    }
    let mut selected = vec![0];
    for metric in [1, 2] {
        let index = (0..frontier.len())
            .min_by(|a, b| {
                frontier[*a].metrics(arrive)[metric]
                    .total_cmp(&frontier[*b].metrics(arrive)[metric])
            })
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
    selected.sort_unstable();
    frontier
        .into_iter()
        .enumerate()
        .filter_map(|(i, v)| selected.contains(&i).then_some(v))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn piece(departure: f64, arrival: f64, walk: bool, trip: &str) -> Arc<Value> {
        Arc::new(
            json!({"status":"ready","mode":if walk {"walk"} else {"transit"},
            "departureMinutes":departure,"arrivalMinutes":arrival,"durationMinutes":arrival-departure,
            "boardings":if walk {0} else {1},"walkMinutes":if walk {arrival-departure} else {0.},
            "legs":[{"kind":if walk {"walk"} else {"ride"},"tripId":trip,"departure":departure*60.,"arrival":arrival*60.}]}),
        )
    }
    #[test]
    fn a_later_walk_can_remove_a_boarding_before_the_same_bus() {
        let start = Candidate::start(0.);
        let walk = start.extend(piece(0., 5., true, "walk"), false);
        let ride = start.extend(piece(1., 4., false, "first"), false);
        let onward = piece(10., 20., false, "onward");
        let a = walk.extend(onward.clone(), false);
        let b = ride.extend(onward.clone(), false);
        assert!(Arc::ptr_eq(&a.pieces[1], &b.pieces[1]));
        let selected = select(vec![b, a], false, true);
        assert_eq!(selected[0].metrics(false), [20., 1., 5.]);
    }
    #[test]
    fn reverse_search_keeps_the_walking_suffix() {
        let start = Candidate::start(20.);
        let walk = start.extend(piece(15., 20., true, "walk"), true);
        let ride = start.extend(piece(17., 19., false, "last"), true);
        let incoming = piece(5., 10., false, "incoming");
        let selected = select(
            vec![
                ride.extend(incoming.clone(), true),
                walk.extend(incoming, true),
            ],
            true,
            true,
        );
        assert_eq!(selected[0].metrics(true), [-5., 1., 5.]);
    }
    #[test]
    fn capacity_keeps_walk_and_temporal_extremes() {
        let start = Candidate::start(0.);
        let mut candidates: Vec<_> = (1..20)
            .map(|i| start.extend(piece(0., i as f64, false, &i.to_string()), false))
            .collect();
        candidates.push(start.extend(piece(0., 21., true, "walk"), false));
        let selected = select(candidates, false, false);
        assert!(selected.len() <= LIMIT);
        assert_eq!(selected[0].clock, 1.);
        assert!(selected.iter().any(|v| v.boardings == 0.));
    }
}
