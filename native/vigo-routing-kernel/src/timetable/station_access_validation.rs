//! Validate persisted station witnesses before any native routing consumes them.
use napi::bindgen_prelude::*;
use napi_derive::napi;

#[napi(object)]
pub struct StationPathsValidationInput {
    pub stop_count: u32,
    pub source_count: u32,
    pub offsets: Uint32Array,
    pub path_offsets: Uint32Array,
    pub from: Uint32Array,
    pub to: Uint32Array,
    pub seconds: Float64Array,
    pub distance_m: Float64Array,
    pub path_stops: Uint32Array,
    pub path_sources: Uint32Array,
}
fn invalid() -> Error {
    Error::new(Status::InvalidArg, "Prepared station paths are invalid.")
}
#[napi]
pub fn validate_station_paths(p: StationPathsValidationInput) -> Result<()> {
    let stops = p.stop_count as usize;
    let count = p.from.len();
    if p.offsets.len() != stops + 1
        || p.offsets.first() != Some(&0)
        || p.offsets.last().copied().map(|v| v as usize) != Some(count)
        || p.to.len() != count
        || p.seconds.len() != count
        || p.distance_m.len() != count
        || p.path_offsets.len() != count + 1
        || p.path_offsets.first() != Some(&0)
        || p.path_offsets.last().copied().map(|v| v as usize) != Some(p.path_stops.len())
        || p.path_stops.len().checked_sub(count) != Some(p.path_sources.len())
        || p.offsets
            .windows(2)
            .any(|v| v[0] > v[1] || v[1] as usize > count)
        || p.path_offsets.windows(2).any(|v| {
            v[1] as usize > p.path_stops.len() || (v[1] as usize).saturating_sub(v[0] as usize) < 2
        })
    {
        return Err(invalid());
    }
    for stop in 0..stops {
        for i in p.offsets[stop] as usize..p.offsets[stop + 1] as usize {
            if p.from[i] as usize != stop
                || p.to[i] >= p.stop_count
                || !p.seconds[i].is_finite()
                || p.seconds[i] < 0.0
                || !p.distance_m[i].is_finite()
                || p.distance_m[i] < 0.0
                || p.path_stops[p.path_offsets[i] as usize] as usize != stop
                || p.path_stops[p.path_offsets[i + 1] as usize - 1] != p.to[i]
            {
                return Err(invalid());
            }
        }
    }
    if p.path_stops.iter().any(|&s| s >= p.stop_count)
        || p.path_sources.iter().any(|&s| s >= p.source_count)
    {
        return Err(invalid());
    }
    Ok(())
}
