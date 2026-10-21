//! Studio Reach shading between reached streets. Each cell of land enclosed by
//! the reached network takes its fastest reached street plus a straight walk of
//! at most 100 m, never through mapped water. Street samples stay the routing
//! evidence; these values only fill the display between them.
use serde_json::Value;
use std::cmp::Ordering;
use std::collections::BinaryHeap;

/// Longest straight walk from a reached street into the land beside it.
pub(crate) const MAX_OFF_STREET_METERS: f64 = 100.;
const MAX_CELLS: usize = 1_048_576;
const METERS_PER_DEGREE: f64 = 111_320.;
const WATER_KINDS: [&str; 4] = ["water", "river", "ocean", "coastline"];

/// Off-street arrival minutes per cell, `INFINITY` where none is shown.
/// Street cells keep their own samples and are never replaced. Without
/// complete water coverage nothing is filled: missing water is not dry land.
pub(crate) fn off_street_estimates(
    values: &[f64],
    w: usize,
    h: usize,
    bounds: &[f64],
    water: Option<&Value>,
    walk_speed_kph: f64,
) -> Result<Vec<f64>, String> {
    let count = w.checked_mul(h).ok_or("Invalid Reach raster dimensions")?;
    if w == 0 || h == 0 || count > MAX_CELLS || count != values.len() {
        return Err("Reach raster dimensions exceed the off-street budget".into());
    }
    if bounds.len() != 4
        || bounds.iter().any(|v| !v.is_finite())
        || bounds[0] >= bounds[2]
        || bounds[1] >= bounds[3]
        || bounds[1] < -90.
        || bounds[3] > 90.
        || !(walk_speed_kph.is_finite() && walk_speed_kph > 0.)
    {
        return Err("Invalid Reach bounds or walking speed".into());
    }
    let mut estimates = vec![f64::INFINITY; count];
    let Some(water) = water.filter(|water| coverage_complete(water)) else {
        return Ok(estimates);
    };
    let [west, south, east, north] = [bounds[0], bounds[1], bounds[2], bounds[3]];
    let dx =
        (east - west) * METERS_PER_DEGREE * ((south + north) / 2.).to_radians().cos() / w as f64;
    let dy = (north - south) * METERS_PER_DEGREE / h as f64;
    if !(dx > 0. && dy > 0.) || dx.max(dy) > MAX_OFF_STREET_METERS {
        return Ok(estimates);
    }
    let street: Vec<bool> = values.iter().map(|v| v.is_finite()).collect();
    let enclosed = enclosed_cells(&street, w, h);
    let wet = water_cells(water, w, h, bounds);
    let open = |cell: usize| !street[cell] && enclosed[cell] && !wet[cell];

    // A label is a walk from one street: (arrival, meters walked). Arrival
    // order settles each cell's fastest street first; a later label survives
    // only while it has walked less, so a slower but nearer street can still
    // carry the 100 m budget past a cell the faster walk reached at its limit.
    let meters_per_minute = walk_speed_kph * 1000. / 60.;
    let diagonal = dx.hypot(dy);
    let steps = [
        (-1, 0, dx),
        (1, 0, dx),
        (0, -1, dy),
        (0, 1, dy),
        (-1, -1, diagonal),
        (1, -1, diagonal),
        (-1, 1, diagonal),
        (1, 1, diagonal),
    ];
    let mut walked = vec![f64::INFINITY; count];
    let mut queue: BinaryHeap<Label> = (0..count)
        .filter(|&cell| street[cell])
        .map(|cell| Label {
            minutes: values[cell],
            meters: 0.,
            cell,
        })
        .collect();
    while let Some(Label {
        minutes,
        meters,
        cell,
    }) = queue.pop()
    {
        if meters >= walked[cell] {
            continue;
        }
        walked[cell] = meters;
        if !street[cell] && minutes < estimates[cell] {
            estimates[cell] = minutes;
        }
        let (x, y) = ((cell % w) as isize, (cell / w) as isize);
        for &(ox, oy, step) in &steps {
            let (nx, ny) = (x + ox, y + oy);
            if nx < 0 || ny < 0 || nx as usize >= w || ny as usize >= h {
                continue;
            }
            let next = ny as usize * w + nx as usize;
            let meters = meters + step;
            if open(next) && meters <= MAX_OFF_STREET_METERS && meters < walked[next] {
                queue.push(Label {
                    minutes: minutes + step / meters_per_minute,
                    meters,
                    cell: next,
                });
            }
        }
    }
    Ok(estimates)
}

#[derive(PartialEq)]
struct Label {
    minutes: f64,
    meters: f64,
    cell: usize,
}
impl Eq for Label {}
impl Ord for Label {
    // BinaryHeap is a max-heap: the earliest arrival, then the shortest walk, pops first.
    fn cmp(&self, other: &Self) -> Ordering {
        other
            .minutes
            .total_cmp(&self.minutes)
            .then(other.meters.total_cmp(&self.meters))
            .then(other.cell.cmp(&self.cell))
    }
}
impl PartialOrd for Label {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(value)) => *value,
        Some(Value::Number(value)) => value.as_f64().is_some_and(|v| v != 0.),
        Some(Value::String(value)) => !value.is_empty(),
        Some(_) => true,
    }
}

fn coverage_complete(water: &Value) -> bool {
    let metadata = &water["metadata"];
    metadata["status"] == "ready"
        && !truthy(metadata.get("sampled"))
        && metadata.get("coastlineComplete") != Some(&Value::Bool(false))
}

/// Unsampled cells whose 8-connected region never touches the raster edge:
/// land surrounded by reached streets. Diagonal street steps do not close it.
fn enclosed_cells(street: &[bool], w: usize, h: usize) -> Vec<bool> {
    let mut enclosed = vec![false; street.len()];
    let mut seen = vec![false; street.len()];
    let mut region = Vec::new();
    for seed in 0..street.len() {
        if seen[seed] || street[seed] {
            continue;
        }
        seen[seed] = true;
        region.clear();
        region.push(seed);
        let mut closed = true;
        let mut head = 0;
        while head < region.len() {
            let cell = region[head];
            head += 1;
            let (x, y) = (cell % w, cell / w);
            if x == 0 || y == 0 || x + 1 == w || y + 1 == h {
                closed = false;
            }
            for ny in y.saturating_sub(1)..=(y + 1).min(h - 1) {
                for nx in x.saturating_sub(1)..=(x + 1).min(w - 1) {
                    let next = ny * w + nx;
                    if !street[next] && !seen[next] {
                        seen[next] = true;
                        region.push(next);
                    }
                }
            }
        }
        if closed {
            for &cell in &region {
                enclosed[cell] = true;
            }
        }
    }
    enclosed
}

/// Cells touched by mapped water: polygon interiors by even-odd scanlines (so
/// islands stay dry) and every cell a water line or ring crosses.
fn water_cells(water: &Value, w: usize, h: usize, bounds: &[f64]) -> Vec<bool> {
    let mut grid = WaterGrid {
        mask: vec![false; w * h],
        w,
        h,
        bounds: [bounds[0], bounds[1], bounds[2], bounds[3]],
    };
    for feature in water["features"].as_array().into_iter().flatten() {
        let kind = feature["properties"]["kind"].as_str().unwrap_or_default();
        if !WATER_KINDS.contains(&kind) {
            continue;
        }
        let coordinates = &feature["geometry"]["coordinates"];
        let parts = coordinates.as_array().into_iter().flatten();
        match feature["geometry"]["type"].as_str() {
            Some("Polygon") => grid.polygon(coordinates),
            Some("MultiPolygon") => parts.for_each(|part| grid.polygon(part)),
            Some("LineString") => {
                grid.line(coordinates);
            }
            Some("MultiLineString") => parts.for_each(|part| {
                grid.line(part);
            }),
            _ => {}
        }
    }
    grid.mask
}

struct WaterGrid {
    mask: Vec<bool>,
    w: usize,
    h: usize,
    bounds: [f64; 4],
}

impl WaterGrid {
    /// Longitude/latitude to fractional cell units, row 0 at the north edge.
    fn project(&self, point: &Value) -> Option<[f64; 2]> {
        let [west, south, east, north] = self.bounds;
        let (lon, lat) = (point.get(0)?.as_f64()?, point.get(1)?.as_f64()?);
        Some([
            (lon - west) / (east - west) * self.w as f64,
            (north - lat) / (north - south) * self.h as f64,
        ])
    }

    fn mark(&mut self, x: f64, y: f64) {
        if x >= 0. && y >= 0. && x < self.w as f64 && y < self.h as f64 {
            self.mask[y as usize * self.w + x as usize] = true;
        }
    }

    /// Marks every cell the line crosses: one sample between consecutive grid
    /// crossings, so a line never skips a cell it passes through.
    fn line(&mut self, coordinates: &Value) -> Vec<[f64; 2]> {
        let points: Vec<[f64; 2]> = coordinates
            .as_array()
            .map(|points| {
                points
                    .iter()
                    .filter_map(|point| self.project(point))
                    .collect()
            })
            .unwrap_or_default();
        for pair in points.windows(2) {
            let [a, b] = [pair[0], pair[1]];
            let mut ts = vec![0., 1.];
            for (axis, size) in [(0, self.w), (1, self.h)] {
                let d = b[axis] - a[axis];
                let last = a[axis].max(b[axis]).floor().min(size as f64);
                if d == 0. || last < 0. {
                    continue;
                }
                for k in a[axis].min(b[axis]).ceil().max(0.) as usize..=last as usize {
                    let t = (k as f64 - a[axis]) / d;
                    if t > 0. && t < 1. {
                        ts.push(t);
                    }
                }
            }
            ts.sort_by(f64::total_cmp);
            for i in 0..ts.len() {
                let t = if i > 0 {
                    (ts[i - 1] + ts[i]) / 2.
                } else {
                    ts[i]
                };
                self.mark(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
            }
            self.mark(b[0], b[1]);
        }
        points
    }

    fn polygon(&mut self, coordinates: &Value) {
        let rings: Vec<Vec<[f64; 2]>> = coordinates
            .as_array()
            .map(|rings| rings.iter().map(|ring| self.line(ring)).collect())
            .unwrap_or_default();
        for y in 0..self.h {
            let row = y as f64 + 0.5;
            let mut crossings: Vec<f64> = rings
                .iter()
                .flat_map(|ring| ring.windows(2))
                .filter(|pair| (pair[0][1] > row) != (pair[1][1] > row))
                .map(|pair| {
                    let [a, b] = [pair[0], pair[1]];
                    a[0] + (row - a[1]) / (b[1] - a[1]) * (b[0] - a[0])
                })
                .collect();
            crossings.sort_by(f64::total_cmp);
            for span in crossings.chunks_exact(2) {
                let mut x = (span[0] - 0.5).ceil().max(0.);
                while x + 0.5 < span[1].min(self.w as f64) {
                    self.mask[y * self.w + x as usize] = true;
                    x += 1.;
                }
            }
        }
    }
}

#[cfg(feature = "node")]
#[napi_derive::napi]
pub fn reach_off_street_estimates(
    values: napi::bindgen_prelude::Float64Array,
    width: u32,
    height: u32,
    bounds: Vec<f64>,
    water_json: Option<String>,
    walk_speed_kph: f64,
) -> napi::Result<napi::bindgen_prelude::Float64Array> {
    let invalid = |message: String| napi::Error::new(napi::Status::InvalidArg, message);
    let water = water_json
        .map(|json| serde_json::from_str::<Value>(&json))
        .transpose()
        .map_err(|error| invalid(format!("Invalid Reach water coverage: {error}")))?;
    off_street_estimates(
        &values,
        width as usize,
        height as usize,
        &bounds,
        water.as_ref(),
        walk_speed_kph,
    )
    .map(Into::into)
    .map_err(invalid)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // 20 cells of about 22 m across a 0.004° square at the equator.
    const W: usize = 20;
    const BOUNDS: [f64; 4] = [0., 0., 0.004, 0.004];
    const INF: f64 = f64::INFINITY;

    fn dry() -> Value {
        json!({"metadata":{"status":"ready","sampled":false,"coastlineComplete":true},"features":[]})
    }
    fn streets(minutes: f64) -> Vec<f64> {
        vec![minutes; W * W]
    }
    fn clear(
        values: &mut [f64],
        x: std::ops::RangeInclusive<usize>,
        y: std::ops::RangeInclusive<usize>,
    ) {
        for row in y {
            for column in x.clone() {
                values[row * W + column] = INF;
            }
        }
    }
    fn estimate(values: &[f64], water: Option<&Value>) -> Vec<f64> {
        off_street_estimates(values, W, W, &BOUNDS, water, 4.8).unwrap()
    }

    #[test]
    fn fills_an_enclosed_block_from_its_streets() {
        let mut values = streets(5.);
        clear(&mut values, 8..=11, 8..=11);
        let before = values.clone();
        let filled = estimate(&values, Some(&dry()));
        assert_eq!(values, before);
        assert_eq!(filled.iter().filter(|v| v.is_finite()).count(), 16);
        assert!(filled[8 * W + 8] > 5., "an off-street walk costs time");
        assert!(
            filled[9 * W + 9] > filled[8 * W + 8],
            "deeper cells take longer"
        );
        assert!(!filled[0].is_finite(), "street samples are never replaced");
    }

    #[test]
    fn each_cell_uses_its_fastest_street() {
        let mut values = streets(5.);
        clear(&mut values, 4..=15, 8..=11);
        for column in 4..=15 {
            values[7 * W + column] = 20.;
        }
        let filled = estimate(&values, Some(&dry()));
        let meters = 0.004 / W as f64 * METERS_PER_DEGREE;
        let walk = |cells: f64| cells * meters / 80.;
        // Beside the late street but one cell nearer the early one.
        assert!((filled[8 * W + 4] - (5. + walk(1.))).abs() < 1e-9);
        assert!(
            filled[8 * W + 9] < 20.,
            "a late boundary no longer delays the whole block"
        );
    }

    #[test]
    fn walks_at_most_100_metres_from_a_street() {
        let mut values = streets(5.);
        clear(&mut values, 1..=18, 1..=18);
        let filled = estimate(&values, Some(&dry()));
        assert!(
            filled[W + 1].is_finite(),
            "a large block still shades its edge"
        );
        assert!(
            !filled[10 * W + 10].is_finite(),
            "its middle lies beyond 100 m"
        );
        assert!(
            filled
                .iter()
                .filter(|v| v.is_finite())
                .all(|&v| v <= 5. + 100. / 80. + 1e-9)
        );
    }

    #[test]
    fn open_land_and_diagonal_gaps_stay_empty() {
        let mut open = streets(5.);
        clear(&mut open, 8..=11, 8..=11);
        clear(&mut open, 8..=8, 0..=8);
        assert!(estimate(&open, Some(&dry())).iter().all(|v| !v.is_finite()));
        let mut diagonal = streets(5.);
        clear(&mut diagonal, 8..=11, 8..=11);
        for i in 0..9 {
            diagonal[i * W + i] = INF;
        }
        assert!(
            estimate(&diagonal, Some(&dry()))
                .iter()
                .all(|v| !v.is_finite())
        );
    }

    #[test]
    fn water_cells_stay_empty_and_are_not_crossed() {
        let mut values = streets(30.);
        clear(&mut values, 2..=17, 2..=17);
        for column in 2..=17 {
            values[W + column] = 0.;
        }
        // A river along row 11 splits the block: the south half keeps the late street.
        let river = json!({"metadata":{"status":"ready"},"features":[{"properties":{"kind":"river"},
            "geometry":{"type":"LineString","coordinates":[[0.0002,0.0018],[0.0038,0.0018]]}}]});
        let filled = estimate(&values, Some(&river));
        assert!(
            !filled[11 * W + 9].is_finite(),
            "the river itself is not shaded"
        );
        assert!(
            filled[3 * W + 9] < 30.,
            "the north side walks in from the early street"
        );
        assert!(
            filled[16 * W + 9] > 30.,
            "the south side cannot cross the river"
        );
        let lake = json!({"metadata":{"status":"ready"},"features":[{"properties":{"kind":"water"},
            "geometry":{"type":"Polygon","coordinates":[[[0.0012,0.0012],[0.0028,0.0012],[0.0028,0.0028],[0.0012,0.0028],[0.0012,0.0012]]]}}]});
        let filled = estimate(&values, Some(&lake));
        assert!(
            !filled[10 * W + 10].is_finite() && filled[3 * W + 3].is_finite(),
            "only the lake's cells stay empty"
        );
    }

    #[test]
    fn incomplete_water_coverage_fills_nothing() {
        let mut values = streets(5.);
        clear(&mut values, 8..=11, 8..=11);
        for water in [
            None,
            Some(json!({"metadata":{"status":"needs-import"}})),
            Some(json!({"metadata":{"status":"ready","sampled":true}})),
            Some(json!({"metadata":{"status":"ready","coastlineComplete":false}})),
        ] {
            assert!(
                estimate(&values, water.as_ref())
                    .iter()
                    .all(|v| !v.is_finite())
            );
        }
    }

    #[test]
    fn coarse_or_malformed_grids_are_handled() {
        let mut values = vec![5.; 9];
        values[4] = INF;
        let coarse =
            off_street_estimates(&values, 3, 3, &[0., 0., 0.01, 0.01], Some(&dry()), 4.8).unwrap();
        assert!(
            coarse.iter().all(|v| !v.is_finite()),
            "cells wider than 100 m are not shaded"
        );
        assert!(off_street_estimates(&values, 2, 3, &[0., 0., 1., 1.], None, 4.8).is_err());
        assert!(off_street_estimates(&values, 3, 3, &[0., 0., f64::NAN, 1.], None, 4.8).is_err());
        assert!(off_street_estimates(&values, 3, 3, &[0., 0., 1., 1.], None, 0.).is_err());
    }
}
