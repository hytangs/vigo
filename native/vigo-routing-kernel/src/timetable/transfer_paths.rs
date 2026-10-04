//! Compose directed station pathways around at most one external transfer.
//! Preparation retains the original edge witness; queries still relax one edge
//! per boarding episode and never turn two street transfers into a shortcut.
#[cfg(not(feature = "node"))]
use crate::standalone_types as napi;
use napi::bindgen_prelude::*;
#[cfg(feature = "node")]
use napi_derive::napi;
use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashSet};

#[cfg_attr(feature = "node", napi(object))]
pub struct TransferPathInput {
    pub eligible: Uint8Array,
    pub from: Uint32Array,
    pub to: Uint32Array,
    pub seconds: Uint32Array,
    pub pathway: Uint8Array,
    pub forbidden_from: Uint32Array,
    pub forbidden_to: Uint32Array,
}

#[cfg_attr(feature = "node", napi(object))]
pub struct TransferPathResult {
    pub from: Uint32Array,
    pub to: Uint32Array,
    pub seconds: Uint32Array,
    pub path_offsets: Uint32Array,
    pub path_edges: Uint32Array,
}

#[cfg_attr(feature = "node", napi)]
pub fn compile_transfer_paths(input: TransferPathInput) -> Result<TransferPathResult> {
    let n = input.eligible.len();
    let m = input.from.len();
    if n > u32::MAX as usize / 2
        || m > u32::MAX as usize
        || input.to.len() != m
        || input.seconds.len() != m
        || input.pathway.len() != m
        || input.forbidden_from.len() != input.forbidden_to.len()
        || input
            .from
            .iter()
            .chain(input.to.iter())
            .chain(input.forbidden_from.iter())
            .chain(input.forbidden_to.iter())
            .any(|&s| s as usize >= n)
        || input
            .eligible
            .iter()
            .chain(input.pathway.iter())
            .any(|&v| v > 1)
    {
        return Err(Error::from_reason("Invalid transfer path arrays"));
    }
    let forbidden: HashSet<_> = input
        .forbidden_from
        .iter()
        .copied()
        .zip(input.forbidden_to.iter().copied())
        .collect();
    let mut edges = vec![vec![]; n];
    for i in 0..m {
        if !forbidden.contains(&(input.from[i], input.to[i])) {
            edges[input.from[i] as usize].push(i);
        }
    }
    let mut distance = vec![u64::MAX; 2 * n];
    let mut previous = vec![(usize::MAX, usize::MAX); 2 * n];
    let mut touched = vec![];
    let mut queue = BinaryHeap::new();
    let (mut from, mut to, mut seconds, mut offsets, mut paths) =
        (vec![], vec![], vec![], vec![0], vec![]);
    for source in 0..n {
        if input.eligible[source] == 0 {
            continue;
        }
        distance[source] = 0;
        touched.push(source);
        queue.push(Reverse((0_u64, source)));
        while let Some(Reverse((cost, state))) = queue.pop() {
            if cost != distance[state] {
                continue;
            }
            let used = state >= n;
            for &edge in &edges[state % n] {
                let external = input.pathway[edge] == 0;
                if used && external {
                    continue;
                }
                let next = input.to[edge] as usize + if used || external { n } else { 0 };
                let cost = cost + u64::from(input.seconds[edge]);
                if cost >= distance[next] || cost > u64::from(u32::MAX) {
                    continue;
                }
                if distance[next] == u64::MAX {
                    touched.push(next);
                }
                distance[next] = cost;
                previous[next] = (state, edge);
                queue.push(Reverse((cost, next)));
            }
        }
        // Visit only the small reached neighborhood, not the entire City.
        let mut targets: Vec<_> = touched.iter().map(|s| s % n).collect();
        targets.sort_unstable();
        targets.dedup();
        for target in targets {
            if target == source
                || input.eligible[target] == 0
                || forbidden.contains(&(source as u32, target as u32))
            {
                continue;
            }
            let mut state = if distance[target] <= distance[target + n] {
                target
            } else {
                target + n
            };
            let duration = distance[state];
            let mut path = vec![];
            while state != source {
                let (parent, edge) = previous[state];
                path.push(edge as u32);
                state = parent;
            }
            if path.len() <= 1 {
                continue;
            }
            path.reverse();
            from.push(source as u32);
            to.push(target as u32);
            seconds.push(duration as u32);
            paths.extend(path);
            offsets.push(
                u32::try_from(paths.len())
                    .map_err(|_| Error::from_reason("Transfer witness exceeds index capacity"))?,
            );
        }
        for state in touched.drain(..) {
            distance[state] = u64::MAX;
        }
    }
    Ok(TransferPathResult {
        from: from.into(),
        to: to.into(),
        seconds: seconds.into(),
        path_offsets: offsets.into(),
        path_edges: paths.into(),
    })
}
