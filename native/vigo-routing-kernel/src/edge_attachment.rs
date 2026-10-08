//! Travel between projections on the same directed street segment. The vertex
//! search covers every path that leaves that segment; this supplies the missing
//! interior path without changing either endpoint's selected street attachment.
use super::*;

#[derive(Clone, Copy)]
pub(super) struct EdgeAttachment {
    from: u32,
    to: u32,
    fraction: f64,
    offset_m: f64,
    coordinate: [f64; 2],
}

pub(super) fn from_snaps(
    snapshot: &Snapshot,
    snaps: &[Snap],
    point: [f64; 2],
) -> napi::Result<Option<EdgeAttachment>> {
    if snaps.len() != 2 {
        return Ok(None);
    }
    let (a, b) = if snaps[0].node < snaps[1].node {
        (snaps[0], snaps[1])
    } else {
        (snaps[1], snaps[0])
    };
    let lons = snapshot.f64_array("nodeLons")?;
    let lats = snapshot.f64_array("nodeLats")?;
    let scale = 111.32 * point[1].to_radians().cos();
    let x = (lons[a.node as usize] - point[0]) * scale;
    let y = (lats[a.node as usize] - point[1]) * 110.574;
    let dx = (lons[b.node as usize] - lons[a.node as usize]) * scale;
    let dy = (lats[b.node as usize] - lats[a.node as usize]) * 110.574;
    let norm = dx * dx + dy * dy;
    if norm <= 0.0 {
        return Ok(None);
    }
    let fraction = -(x * dx + y * dy) / norm;
    if !(0.0..=1.0).contains(&fraction) {
        return Ok(None);
    }
    let offset_m = (x + fraction * dx).hypot(y + fraction * dy) * 1000.0;
    if offset_m > SNAP_RADIUS_M {
        return Ok(None);
    }
    let forward = edge_length(snapshot, a.node, b.node)?;
    let backward = edge_length(snapshot, b.node, a.node)?;
    let Some((forward, backward)) = forward.zip(backward) else {
        return Ok(None);
    };
    // A merged station or restricted-access frontier must not be mistaken for
    // one anonymous-coordinate projection. Verify both original snap costs.
    if ![forward, backward].into_iter().any(|length| {
        (a.distance_m - offset_m - fraction * length).abs() < 1e-6
            && (b.distance_m - offset_m - (1.0 - fraction) * length).abs() < 1e-6
    }) {
        return Ok(None);
    }
    Ok(Some(EdgeAttachment {
        from: a.node,
        to: b.node,
        fraction,
        offset_m,
        coordinate: [
            lons[a.node as usize] + fraction * (lons[b.node as usize] - lons[a.node as usize]),
            lats[a.node as usize] + fraction * (lats[b.node as usize] - lats[a.node as usize]),
        ],
    }))
}

fn edge_length(snapshot: &Snapshot, from: u32, to: u32) -> napi::Result<Option<f64>> {
    let offsets = snapshot.u32_array("edgeOffsets")?;
    let targets = snapshot.u32_array("edgeTargets")?;
    let distances = snapshot.f64_array("edgeDistances")?;
    Ok(
        (offsets[from as usize] as usize..offsets[from as usize + 1] as usize)
            .filter(|&edge| targets[edge] == to)
            .map(|edge| distances[edge])
            .min_by(f64::total_cmp),
    )
}

pub(super) fn distance(
    snapshot: &Snapshot,
    a: Option<EdgeAttachment>,
    b: Option<EdgeAttachment>,
) -> napi::Result<Option<f64>> {
    let Some((a, b)) = a.zip(b) else {
        return Ok(None);
    };
    if (a.from, a.to) != (b.from, b.to) {
        return Ok(None);
    }
    let (from, to) = if a.fraction <= b.fraction {
        (a.from, a.to)
    } else {
        (a.to, a.from)
    };
    Ok(edge_length(snapshot, from, to)?
        .map(|length| a.offset_m + b.offset_m + (b.fraction - a.fraction).abs() * length))
}

pub(super) fn path(
    snapshot: &Snapshot,
    origins: &[Snap],
    destinations: &[Snap],
    coordinates: [[f64; 2]; 2],
    maximum: f64,
) -> napi::Result<Option<PointPath>> {
    if coordinates[0] == coordinates[1] && !origins.is_empty() && !destinations.is_empty() {
        return Ok(Some(PointPath {
            distance_m: 0.0,
            origin_snap_distance_m: 0.0,
            destination_snap_distance_m: 0.0,
            nodes: Vec::new(),
            projected_coordinates: Some(coordinates.concat()),
            settled_nodes: 0,
            relaxed_edges: 0,
            chain_skipped_nodes: 0,
            contracted_arc_relaxations: 0,
            cch_accelerated: false,
        }));
    }
    let a = from_snaps(snapshot, origins, coordinates[0])?;
    let b = from_snaps(snapshot, destinations, coordinates[1])?;
    let Some(distance_m) = distance(snapshot, a, b)?.filter(|d| *d <= maximum) else {
        return Ok(None);
    };
    let (a, b) = a
        .zip(b)
        .expect("same-edge distance requires two projections");
    Ok(Some(PointPath {
        distance_m,
        origin_snap_distance_m: a.offset_m,
        destination_snap_distance_m: b.offset_m,
        nodes: Vec::new(),
        projected_coordinates: Some([a.coordinate, b.coordinate].concat()),
        settled_nodes: 0,
        relaxed_edges: 0,
        chain_skipped_nodes: 0,
        contracted_arc_relaxations: 0,
        cch_accelerated: false,
    }))
}

pub(super) fn choose(current: Option<PointPath>, direct: Option<PointPath>) -> Option<PointPath> {
    match direct {
        Some(direct)
            if current
                .as_ref()
                .is_none_or(|p| direct.distance_m < p.distance_m) =>
        {
            Some(direct)
        }
        _ => current,
    }
}

pub(super) fn member_path(
    snapshot: &Snapshot,
    profile: &AccessProfile,
    frontier: &FrontierSearch,
    member: usize,
) -> napi::Result<Option<PointPath>> {
    if frontier.terminal_attachment.is_some() {
        return Ok(None);
    }
    let point = [frontier.source_longitude, frontier.source_latitude];
    let mut best = None;
    for &anchor in profile.member_anchor_indices(member) {
        let anchor = anchor as usize;
        let coordinate = [profile.anchor_lons[anchor], profile.anchor_lats[anchor]];
        let (origins, destinations, coordinates) = if frontier.reverse_direction {
            (
                &profile.anchor_snaps[anchor],
                &frontier.source_snaps,
                [coordinate, point],
            )
        } else {
            (
                &frontier.source_snaps,
                &profile.anchor_snaps[anchor],
                [point, coordinate],
            )
        };
        best = choose(
            best,
            path(
                snapshot,
                origins,
                destinations,
                coordinates,
                frontier.maximum_distance_m,
            )?,
        );
    }
    Ok(best)
}

pub(super) fn improve_frontier(
    snapshot: &Snapshot,
    profile: &AccessProfile,
    frontier: &mut FrontierSearch,
) -> napi::Result<()> {
    if frontier.terminal_attachment.is_some() {
        return Ok(());
    }
    let Some(edge) = from_snaps(
        snapshot,
        &frontier.source_snaps,
        [frontier.source_longitude, frontier.source_latitude],
    )?
    else {
        return Ok(());
    };
    let mut candidates = profile
        .targets_for_node(edge.from)
        .iter()
        .chain(profile.targets_for_node(edge.to))
        .map(|t| t.member)
        .collect::<Vec<_>>();
    candidates.sort_unstable();
    candidates.dedup();
    frontier
        .source_terminals
        .resize(frontier.member_indices.len(), NO_PREDECESSOR);
    let mut changed = false;
    for member in candidates {
        let eligible = if frontier.reverse_direction {
            profile.member_destination_eligible[member as usize]
        } else {
            profile.member_origin_eligible[member as usize]
        };
        if eligible == 0 {
            continue;
        }
        let Some(path) = member_path(snapshot, profile, frontier, member as usize)? else {
            continue;
        };
        if let Some(i) = frontier.member_indices.iter().position(|&m| m == member) {
            if path.distance_m >= frontier.distances_m[i] {
                continue;
            }
            frontier.distances_m[i] = path.distance_m;
            frontier.terminals[i] = NO_PREDECESSOR;
            frontier.source_terminals[i] = NO_PREDECESSOR;
        } else {
            frontier.member_indices.push(member);
            frontier.distances_m.push(path.distance_m);
            frontier.terminals.push(NO_PREDECESSOR);
            frontier.source_terminals.push(NO_PREDECESSOR);
        }
        changed = true;
    }
    if changed {
        let mut order = (0..frontier.member_indices.len()).collect::<Vec<_>>();
        order.sort_by(|&a, &b| {
            frontier.distances_m[a]
                .total_cmp(&frontier.distances_m[b])
                .then_with(|| frontier.member_indices[a].cmp(&frontier.member_indices[b]))
        });
        frontier.member_indices = order.iter().map(|&i| frontier.member_indices[i]).collect();
        frontier.distances_m = order.iter().map(|&i| frontier.distances_m[i]).collect();
        frontier.terminals = order.iter().map(|&i| frontier.terminals[i]).collect();
        frontier.source_terminals = order
            .iter()
            .map(|&i| frontier.source_terminals[i])
            .collect();
    }
    Ok(())
}

/// Include the charged partial-edge geometry and optionally the coordinate
/// connector. Transit access exposes an off-street connector separately from
/// its mapped path. Private terminal paths already contain their own witness.
pub(super) fn include_endpoint_geometry(
    snapshot: &Snapshot,
    coordinates: &mut Vec<f64>,
    snaps: &[Snap],
    point: [f64; 2],
    reverse: bool,
    include_coordinate: bool,
) -> napi::Result<()> {
    if coordinates.len() < 2 {
        return Ok(());
    }
    let i = if reverse { coordinates.len() - 2 } else { 0 };
    let end = [coordinates[i], coordinates[i + 1]];
    let same =
        |a: [f64; 2], b: [f64; 2]| (a[0] - b[0]).abs() < 1e-10 && (a[1] - b[1]).abs() < 1e-10;
    if same(end, point) {
        return Ok(());
    }
    let lons = snapshot.f64_array("nodeLons")?;
    let lats = snapshot.f64_array("nodeLats")?;
    let projected = from_snaps(snapshot, snaps, point)?.map(|a| a.coordinate);
    let is_snap = snaps
        .iter()
        .any(|s| same([lons[s.node as usize], lats[s.node as usize]], end));
    if !is_snap && !projected.is_some_and(|p| same(p, end)) {
        return Ok(());
    }
    let mut connector = if include_coordinate {
        point.to_vec()
    } else {
        Vec::new()
    };
    if let Some(projection) = projected
        && !same(projection, end)
        && (!include_coordinate || !same(projection, point))
    {
        connector.extend_from_slice(&projection);
    }
    if reverse {
        for p in connector.chunks_exact(2).rev() {
            coordinates.extend_from_slice(p);
        }
    } else {
        connector.append(coordinates);
        *coordinates = connector;
    }
    Ok(())
}

pub(super) fn include_path_endpoints(
    snapshot: &Snapshot,
    result: &mut StreetPathResult,
    snaps: [&[Snap]; 2],
    points: [[f64; 2]; 2],
) -> napi::Result<()> {
    if result.found {
        for endpoint in 0..2 {
            include_endpoint_geometry(
                snapshot,
                &mut result.coordinates,
                snaps[endpoint],
                points[endpoint],
                endpoint == 1,
                true,
            )?;
        }
    }
    Ok(())
}

/// Surface seeds use the same attachment as point/transit queries and retain
/// the connector in both elapsed time and walking distance.
pub(super) fn surface_endpoint(
    snapshot: &Snapshot,
    graph: Option<&TerminalAccessGraph>,
    profile: Option<&AccessProfile>,
    point: [f64; 2],
    maximum: f64,
) -> napi::Result<([f64; 2], f64)> {
    let primary = snaps_for_coordinate(
        snapshot,
        snapshot.reciprocal_edge_flags(),
        point[0],
        point[1],
    )?;
    let (snaps, attachment) = terminal_endpoint_snaps(
        snapshot,
        graph,
        profile,
        primary.clone(),
        point[0],
        point[1],
        maximum,
        false,
    )?;
    if attachment.is_some()
        || snaps.is_empty()
        || snaps
            .iter()
            .any(|s| primary.iter().any(|p| s.node == p.node))
    {
        return Ok((point, 0.0));
    }
    if let Some(edge) = from_snaps(snapshot, &snaps, point)? {
        return Ok((edge.coordinate, edge.offset_m));
    }
    let node = snaps[0].node as usize;
    Ok((
        [
            snapshot.f64_array("nodeLons")?[node],
            snapshot.f64_array("nodeLats")?[node],
        ],
        snaps[0].distance_m,
    ))
}
