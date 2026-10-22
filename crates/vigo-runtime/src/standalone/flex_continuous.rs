//! Query-specific continuous stops are projected onto the directed GTFS shape.
//! Their clocks are estimates between published calls, never exact departures.
use super::{City, Result, query::Point};
use serde_json::{Value, json};

fn project(shape: &[[f64; 2]], p: [f64; 2], lo: f64, hi: f64) -> (f64, [f64; 2]) {
    let scale = p[1].to_radians().cos();
    let mut best = (f64::INFINITY, lo, shape[lo.floor() as usize]);
    for (i, pair) in shape.windows(2).enumerate() {
        if (i + 1) as f64 <= lo || i as f64 >= hi {
            continue;
        }
        let dx = (pair[1][0] - pair[0][0]) * scale;
        let dy = pair[1][1] - pair[0][1];
        let length = dx * dx + dy * dy;
        let t = if length == 0. {
            0.
        } else {
            (((p[0] - pair[0][0]) * scale * dx + (p[1] - pair[0][1]) * dy) / length)
                .clamp((lo - i as f64).max(0.), (hi - i as f64).min(1.))
        };
        let point = [
            pair[0][0] + t * (pair[1][0] - pair[0][0]),
            pair[0][1] + t * dy,
        ];
        let d = ((p[0] - point[0]) * scale).powi(2) + (p[1] - point[1]).powi(2);
        if d < best.0 {
            best = (d, i as f64 + t, point);
        }
    }
    (best.1, best.2)
}
impl City {
    pub(super) fn continuous_calls(
        &self,
        shape_value: &Value,
        calls: &mut Vec<Value>,
        origin: &Point,
        destination: &Point,
    ) -> Result<()> {
        let Some(rows) = shape_value.as_array() else {
            return Ok(());
        };
        let shape: Vec<[f64; 2]> = rows
            .iter()
            .map(|p| {
                Ok([
                    p[0].as_f64().ok_or("Invalid shape longitude")?,
                    p[1].as_f64().ok_or("Invalid shape latitude")?,
                ])
            })
            .collect::<Result<_>>()?;
        if shape.len() < 2 {
            return Err("Continuous stopping requires a shape".into());
        }
        let mut positions = vec![];
        let mut previous = 0.;
        for call in calls.iter() {
            let stop = self.point(&json!({"stopId":call["location"]}))?;
            let position = if let Some(distance) = call["shapeDistance"].as_f64() {
                rows.windows(2)
                    .enumerate()
                    .find_map(|(i, p)| {
                        let (a, b) = (p[0][3].as_f64()?, p[1][3].as_f64()?);
                        (b > a && distance >= a && distance <= b)
                            .then(|| i as f64 + (distance - a) / (b - a))
                    })
                    .ok_or("Stop shape distance is outside its shape")?
            } else {
                project(&shape, stop.coordinate, previous, (shape.len() - 1) as f64).0
            };
            if position < previous {
                return Err("Stop shape distances are not ordered".into());
            }
            previous = position;
            positions.push(position);
        }
        let mut lengths = vec![0.];
        for pair in shape.windows(2) {
            let scale = ((pair[0][1] + pair[1][1]) / 2.).to_radians().cos();
            lengths.push(
                lengths.last().unwrap()
                    + ((pair[1][0] - pair[0][0]) * scale).hypot(pair[1][1] - pair[0][1]),
            );
        }
        if rows.iter().all(|row| row[3].as_f64().is_some()) {
            lengths = rows.iter().map(|row| row[3].as_f64().unwrap()).collect();
        }
        let distance = |position: f64| {
            let i = (position.floor() as usize).min(shape.len() - 2);
            lengths[i] + (lengths[i + 1] - lengths[i]) * (position - i as f64)
        };
        for (call, position) in calls.iter_mut().zip(&positions) {
            call["shapePosition"] = json!(position);
        }
        let mut additions = vec![];
        for (i, pair) in calls.windows(2).enumerate() {
            let (lo, hi) = (positions[i], positions[i + 1]);
            if hi <= lo {
                continue;
            }
            for (point, permission, boarding) in [
                (origin, "continuousPickup", true),
                (destination, "continuousDropoff", false),
            ] {
                let kind = pair[0][permission].as_u64().unwrap_or(1);
                if kind == 1 {
                    continue;
                }
                let (position, coordinate) = project(&shape, point.coordinate, lo, hi);
                if position <= lo || position >= hi {
                    continue;
                }
                let span = distance(hi) - distance(lo);
                if span <= 0. {
                    continue;
                }
                let fraction = (distance(position) - distance(lo)) / span;
                let start = pair[0]["start"].as_f64().ok_or("Untimed continuous stop")?;
                let end = pair[1]["end"].as_f64().ok_or("Untimed continuous stop")?;
                if end < start {
                    continue;
                }
                let time = start + (end - start) * fraction;
                let sequence = pair[0]["sequence"].as_f64().unwrap()
                    + (pair[1]["sequence"].as_f64().unwrap()
                        - pair[0]["sequence"].as_f64().unwrap())
                        * fraction;
                additions.push(json!({"shapePosition":position,"sequence":sequence,"location":"","coordinate":coordinate,"start":time,"end":time,"window":false,"continuous":true,
                    "pickup":if boarding {kind} else {1},"dropoff":if boarding {1} else {kind},"driverCoordination":kind==3}));
            }
        }
        calls.extend(additions);
        calls.sort_by(|a, b| {
            a["sequence"]
                .as_f64()
                .unwrap()
                .total_cmp(&b["sequence"].as_f64().unwrap())
        });
        Ok(())
    }
}
pub(super) fn geometry(shape: &Value, a: &Value, b: &Value) -> Option<Vec<[f64; 2]>> {
    let rows = shape.as_array()?;
    let lo = a["shapePosition"].as_f64()?;
    let hi = b["shapePosition"].as_f64()?;
    let point = |p: f64| -> Option<[f64; 2]> {
        let i = (p.floor() as usize).min(rows.len().checked_sub(2)?);
        let t = p - i as f64;
        Some([
            rows[i][0].as_f64()? + (rows[i + 1][0].as_f64()? - rows[i][0].as_f64()?) * t,
            rows[i][1].as_f64()? + (rows[i + 1][1].as_f64()? - rows[i][1].as_f64()?) * t,
        ])
    };
    let mut result = vec![point(lo)?];
    for i in (lo.floor() as usize + 1)..=(hi.floor() as usize) {
        if (i as f64) < hi {
            result.push(point(i as f64)?);
        }
    }
    result.push(point(hi)?);
    Some(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn projection_stays_on_directed_interval() {
        let s = [[0., 0.], [1., 0.], [1., 1.]];
        assert_eq!(project(&s, [0.5, 0.1], 0., 1.).0, 0.5);
        assert_eq!(project(&s, [0.5, 0.1], 1., 2.).0, 1.1);
        assert_eq!(project(&s, [2., 0.], 0., 0.5).0, 0.5);
    }
}
