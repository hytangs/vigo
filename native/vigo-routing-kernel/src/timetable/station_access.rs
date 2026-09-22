//! Directed station paths with time/distance Pareto labels and packed witnesses.
use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::collections::{HashMap, HashSet};

#[napi(object)]
pub struct StationEdge {
    pub from: u32,
    pub to: u32,
    pub seconds: f64,
    pub distance: Option<f64>,
    pub source: u32,
    pub street: bool,
}
#[napi(object)]
pub struct StationGroup {
    pub members: Vec<u32>,
    pub declared: bool,
}
#[napi(object)]
pub struct StationPathsInput {
    pub coordinates: Float64Array,
    pub platforms: Uint8Array,
    pub edges: Vec<StationEdge>,
    pub groups: Vec<StationGroup>,
    pub forbidden_from: Uint32Array,
    pub forbidden_to: Uint32Array,
    pub fallback_source: u32,
    pub walking_speed_kph: f64,
}
#[napi(object)]
pub struct StationPathsResult {
    pub offsets: Uint32Array,
    pub path_offsets: Uint32Array,
    pub from: Uint32Array,
    pub to: Uint32Array,
    pub seconds: Float64Array,
    pub distance_m: Float64Array,
    pub path_stops: Uint32Array,
    pub path_sources: Uint32Array,
    pub source_ids: Uint32Array,
}
#[derive(Clone, Copy)]
struct Edge {
    to: usize,
    seconds: f64,
    distance: f64,
    source: u32,
}
struct Label {
    to: usize,
    seconds: f64,
    distance: f64,
    parent: Option<usize>,
    source: u32,
    active: bool,
}
fn invalid(message: &str) -> Error {
    Error::new(Status::InvalidArg, format!("Station paths: {message}"))
}
fn index(value: usize) -> Result<u32> {
    u32::try_from(value).map_err(|_| invalid("packed index exceeds Uint32"))
}
fn distance_km(coords: &[f64], from: usize, to: usize) -> f64 {
    let (a, b, c, d) = (
        coords[from * 2],
        coords[from * 2 + 1],
        coords[to * 2],
        coords[to * 2 + 1],
    );
    let radians = |v: f64| v * std::f64::consts::PI / 180.0;
    let h = (radians(d - b) / 2.0).sin().powi(2)
        + radians(b).cos() * radians(d).cos() * (radians(c - a) / 2.0).sin().powi(2);
    6371.0088 * 2.0 * h.sqrt().atan2((1.0 - h).sqrt())
}
#[napi]
pub fn compile_station_paths(input: StationPathsInput) -> Result<StationPathsResult> {
    let n = input.platforms.len();
    if input.coordinates.len() != n * 2
        || input.forbidden_from.len() != input.forbidden_to.len()
        || input.platforms.iter().any(|v| *v > 1)
        || !input.walking_speed_kph.is_finite()
        || input.walking_speed_kph <= 0.0
    {
        return Err(invalid(
            "invalid dimensions, platform mask or walking speed",
        ));
    }
    let mut forbidden = HashSet::new();
    for (&a, &b) in input.forbidden_from.iter().zip(input.forbidden_to.iter()) {
        if a as usize >= n || b as usize >= n {
            return Err(invalid("forbidden endpoint out of range"));
        }
        forbidden.insert((a as usize, b as usize));
    }
    let mut graph: Vec<Vec<Edge>> = vec![Vec::new(); n];
    let mut positions = HashMap::new();
    let mut declared_pairs = HashSet::new();
    for edge in input.edges {
        let (a, b) = (edge.from as usize, edge.to as usize);
        if a >= n || b >= n {
            return Err(invalid("edge endpoint out of range"));
        }
        declared_pairs.insert((a, b));
        if edge.street || a == b || forbidden.contains(&(a, b)) {
            continue;
        }
        let meters = edge
            .distance
            .unwrap_or_else(|| distance_km(&input.coordinates, a, b) * 1000.0);
        if !edge.seconds.is_finite() || edge.seconds < 0.0 || !meters.is_finite() || meters < 0.0 {
            return Err(invalid("non-finite or negative edge cost"));
        }
        let next = Edge {
            to: b,
            seconds: edge.seconds,
            distance: meters,
            source: edge.source,
        };
        if let Some(&p) = positions.get(&(a, b)) {
            let current: &mut Edge = &mut graph[a][p];
            if next.seconds < current.seconds {
                *current = next;
            }
        } else {
            positions.insert((a, b), graph[a].len());
            graph[a].push(next);
        }
    }
    for group in input.groups {
        if group.members.iter().any(|&s| s as usize >= n) {
            return Err(invalid("station member out of range"));
        }
        if group.declared {
            continue;
        }
        let members: Vec<usize> = group
            .members
            .iter()
            .map(|&s| s as usize)
            .filter(|&s| input.platforms[s] == 1)
            .collect();
        for &a in &members {
            for &b in &members {
                if a == b
                    || forbidden.contains(&(a, b))
                    || declared_pairs.contains(&(a, b))
                    || positions.contains_key(&(a, b))
                {
                    continue;
                }
                let km = distance_km(&input.coordinates, a, b);
                let meters = km * 1000.0;
                if !meters.is_finite() {
                    return Err(invalid("invalid station coordinates"));
                }
                // Preserve GTFS preparation arithmetic before converting distance to meters.
                let seconds = (km / input.walking_speed_kph * 3600.0).ceil().max(120.0);
                positions.insert((a, b), graph[a].len());
                graph[a].push(Edge {
                    to: b,
                    seconds,
                    distance: meters,
                    source: input.fallback_source,
                });
            }
        }
    }
    let mut offsets = vec![0];
    let mut path_offsets = vec![0];
    let (mut from, mut to, mut seconds, mut distance_m, mut path_stops, mut path_sources) = (
        Vec::new(),
        Vec::new(),
        Vec::new(),
        Vec::new(),
        Vec::new(),
        Vec::new(),
    );
    let mut source_ids = Vec::new();
    let mut source_indices = HashMap::new();
    for origin in 0..n {
        if graph[origin].is_empty() {
            offsets.push(index(from.len())?);
            continue;
        }
        let mut labels = vec![Label {
            to: origin,
            seconds: 0.0,
            distance: 0.0,
            parent: None,
            source: 0,
            active: true,
        }];
        let mut retained = HashMap::from([(origin, vec![0_usize])]);
        let mut discovered = vec![origin];
        let mut cursor = 0;
        while cursor < labels.len() {
            if labels[cursor].active {
                for edge in &graph[labels[cursor].to] {
                    let time = labels[cursor].seconds + edge.seconds;
                    let meters = labels[cursor].distance + edge.distance;
                    if !time.is_finite() || !meters.is_finite() {
                        return Err(invalid("path cost overflow"));
                    }
                    if !retained.contains_key(&edge.to) {
                        discovered.push(edge.to);
                    }
                    let frontier = retained.entry(edge.to).or_default();
                    if frontier
                        .iter()
                        .any(|&i| labels[i].seconds <= time && labels[i].distance <= meters)
                    {
                        continue;
                    }
                    frontier.retain(|&i| {
                        let dominated = time <= labels[i].seconds && meters <= labels[i].distance;
                        if dominated {
                            labels[i].active = false;
                        }
                        !dominated
                    });
                    frontier.push(labels.len());
                    labels.push(Label {
                        to: edge.to,
                        seconds: time,
                        distance: meters,
                        parent: Some(cursor),
                        source: edge.source,
                        active: true,
                    });
                }
            }
            cursor += 1;
        }
        for destination in discovered {
            if destination == origin {
                continue;
            }
            for &i in &retained[&destination] {
                from.push(index(origin)?);
                to.push(index(destination)?);
                seconds.push(labels[i].seconds);
                distance_m.push(labels[i].distance);
                let mut chain = Vec::new();
                let mut at = Some(i);
                while let Some(j) = at {
                    chain.push(j);
                    at = labels[j].parent;
                }
                for &j in chain.iter().rev() {
                    path_stops.push(index(labels[j].to)?);
                    if labels[j].parent.is_some() {
                        let source = labels[j].source;
                        let next = index(source_ids.len())?;
                        let code = *source_indices.entry(source).or_insert_with(|| {
                            source_ids.push(source);
                            next
                        });
                        path_sources.push(code);
                    }
                }
                path_offsets.push(index(path_stops.len())?);
            }
        }
        offsets.push(index(from.len())?);
    }
    Ok(StationPathsResult {
        offsets: offsets.into(),
        path_offsets: path_offsets.into(),
        from: from.into(),
        to: to.into(),
        seconds: seconds.into(),
        distance_m: distance_m.into(),
        path_stops: path_stops.into(),
        path_sources: path_sources.into(),
        source_ids: source_ids.into(),
    })
}
