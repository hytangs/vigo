//! Mapbox Vector Tile (MVT 2.1) primitives: protobuf writing, geometry
//! commands, and clipping and quantizing in tile units.

/// Tile units per edge.
pub(crate) const EXTENT: f64 = 4096.0;
/// Tile units kept outside each edge so strokes join seamlessly across tiles.
pub(crate) const BUFFER: f64 = 64.0;
pub(crate) const MAX_LATITUDE: f64 = 85.051_128_78;
pub(crate) const GEOMETRY_POINT: u32 = 1;
pub(crate) const GEOMETRY_LINE: u32 = 2;

pub(crate) type Point = [f64; 2];

pub(crate) fn write_varint(buffer: &mut Vec<u8>, mut value: u64) {
    while value >= 0x80 {
        buffer.push((value as u8 & 0x7f) | 0x80);
        value >>= 7;
    }
    buffer.push(value as u8);
}

pub(crate) fn write_key(buffer: &mut Vec<u8>, field: u32, wire: u32) {
    write_varint(buffer, u64::from((field << 3) | wire));
}

pub(crate) fn write_bytes(buffer: &mut Vec<u8>, field: u32, bytes: &[u8]) {
    write_key(buffer, field, 2);
    write_varint(buffer, bytes.len() as u64);
    buffer.extend_from_slice(bytes);
}

pub(crate) fn zigzag(value: i32) -> u32 {
    ((value << 1) ^ (value >> 31)) as u32
}

pub(crate) fn command(id: u32, count: usize) -> u32 {
    (id & 0x7) | ((count as u32) << 3)
}

/// Liang–Barsky: the part of segment `a`→`b` inside an axis-aligned box.
fn clip_segment(a: Point, b: Point, min: Point, max: Point) -> Option<(Point, Point)> {
    let dx = b[0] - a[0];
    let dy = b[1] - a[1];
    let mut enter = 0.0_f64;
    let mut leave = 1.0_f64;
    for (p, q) in [
        (-dx, a[0] - min[0]),
        (dx, max[0] - a[0]),
        (-dy, a[1] - min[1]),
        (dy, max[1] - a[1]),
    ] {
        if p == 0.0 {
            if q < 0.0 {
                return None;
            }
            continue;
        }
        let t = q / p;
        if p < 0.0 {
            enter = enter.max(t);
        } else {
            leave = leave.min(t);
        }
        if enter >= leave {
            return None;
        }
    }
    Some((
        [a[0] + enter * dx, a[1] + enter * dy],
        [a[0] + leave * dx, a[1] + leave * dy],
    ))
}

fn same_point(left: Point, right: Point) -> bool {
    (left[0] - right[0]).abs() < 1e-9 && (left[1] - right[1]).abs() < 1e-9
}

/// Split a polyline into the runs that fall inside the box.
pub(crate) fn clip_polyline(line: &[Point], min: Point, max: Point) -> Vec<Vec<Point>> {
    let mut parts: Vec<Vec<Point>> = Vec::new();
    let mut current: Option<Vec<Point>> = None;
    for pair in line.windows(2) {
        match clip_segment(pair[0], pair[1], min, max) {
            None => {
                if let Some(part) = current.take() {
                    parts.push(part);
                }
            }
            Some((start, end)) => match current.as_mut() {
                Some(part) if same_point(*part.last().unwrap(), start) => part.push(end),
                _ => {
                    if let Some(part) = current.take() {
                        parts.push(part);
                    }
                    current = Some(vec![start, end]);
                }
            },
        }
    }
    if let Some(part) = current {
        parts.push(part);
    }
    parts
}

/// Round to tile units, dropping repeated points.
pub(crate) fn quantize(points: impl IntoIterator<Item = Point>) -> Vec<[i32; 2]> {
    let mut result: Vec<[i32; 2]> = Vec::new();
    for [x, y] in points {
        let point = [x.round() as i32, y.round() as i32];
        if result.last() != Some(&point) {
            result.push(point);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lines_split_where_they_leave_the_box() {
        let parts = clip_polyline(
            &[
                [-10.0, 5.0],
                [5.0, 5.0],
                [5.0, 20.0],
                [8.0, 20.0],
                [8.0, 6.0],
            ],
            [0.0, 0.0],
            [10.0, 10.0],
        );
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0], vec![[0.0, 5.0], [5.0, 5.0], [5.0, 10.0]]);
        assert_eq!(parts[1], vec![[8.0, 10.0], [8.0, 6.0]]);
    }

    #[test]
    fn quantizing_drops_repeated_units_and_zigzag_is_signed() {
        assert_eq!(
            quantize([[0.2, 0.2], [0.4, -0.3], [1.6, 0.0]]),
            vec![[0, 0], [2, 0]]
        );
        assert_eq!((zigzag(0), zigzag(-1), zigzag(1), zigzag(-2)), (0, 1, 2, 3));
        let mut buffer = Vec::new();
        write_varint(&mut buffer, 300);
        assert_eq!(buffer, [0xac, 0x02]);
    }
}
