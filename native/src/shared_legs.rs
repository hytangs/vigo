//! Conservative path equivalence for shared-leg display. Matching stop IDs
//! alone cannot prove that two services follow the same path.
#[cfg(feature = "node")]
use napi_derive::napi;

fn canonical_path(points: &[f64]) -> Option<Vec<[i64; 2]>> {
    if points.len() < 4 || !points.len().is_multiple_of(2) {
        return None;
    }
    let mut path: Vec<[i64; 2]> = vec![];
    for p in points.chunks_exact(2) {
        if !p[0].is_finite() || !p[1].is_finite() || p[0].abs() > 180. || p[1].abs() > 90. {
            return None;
        }
        let p = [(p[0] * 1e6).round() as i64, (p[1] * 1e6).round() as i64];
        if path.last() == Some(&p) {
            continue;
        }
        while path.len() >= 2 {
            let a = path[path.len() - 2];
            let b = path[path.len() - 1];
            let ab = [b[0] - a[0], b[1] - a[1]];
            let bp = [p[0] - b[0], p[1] - b[1]];
            if i128::from(ab[0]) * i128::from(bp[1]) != i128::from(ab[1]) * i128::from(bp[0])
                || i128::from(ab[0]) * i128::from(bp[0]) + i128::from(ab[1]) * i128::from(bp[1]) < 0
            {
                break;
            }
            path.pop();
        }
        path.push(p);
    }
    (path.len() >= 2).then_some(path)
}

#[cfg_attr(feature = "node", napi)]
pub fn shared_leg_paths_match(a: Vec<f64>, b: Vec<f64>) -> bool {
    canonical_path(&a).is_some_and(|a| canonical_path(&b).is_some_and(|b| a == b))
}

#[cfg(feature = "standalone")]
pub(crate) fn proven_path(leg: &serde_json::Value) -> bool {
    matches!(
        leg["geometrySource"].as_str(),
        Some("gtfs_shape" | "shape" | "scenario_plan")
    )
}

#[cfg(feature = "node")]
#[napi]
pub fn shared_leg_frequency(departures: Vec<f64>, start: f64, end: f64, truncated: bool) -> String {
    serde_json::to_string(&vigo_route::timetable::shared_departure_frequency(
        departures, start, end, truncated,
    ))
    .expect("finite shared-leg frequency")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn paths_preserve_direction_and_detours_but_ignore_straight_line_sampling() {
        let a = vec![0., 0., 0.01, 0.];
        assert!(shared_leg_paths_match(
            a.clone(),
            vec![0., 0., 0.005, 0., 0.01, 0.]
        ));
        assert!(!shared_leg_paths_match(a.clone(), vec![0.01, 0., 0., 0.]));
        assert!(!shared_leg_paths_match(
            a.clone(),
            vec![0., 0., 0.005, 0.001, 0.01, 0.]
        ));
        assert!(!shared_leg_paths_match(a, vec![]));
    }
}
