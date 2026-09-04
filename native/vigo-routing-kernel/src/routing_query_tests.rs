use super::*;

fn fixture(seed: u32) -> cch::graph::Graph {
    let mut state = seed;
    let mut first_out = vec![0];
    let mut head = Vec::new();
    let mut weight = Vec::new();
    for source in 0..31 {
        for target in 0..31 {
            state = state.wrapping_mul(1664525).wrapping_add(1013904223);
            // Keep node 30 isolated and retain zero-weight edges and asymmetry.
            if source != target && source != 30 && target != 30 && state % 11 < 2 {
                head.push(target);
                weight.push((state >> 16) % 29);
            }
        }
        first_out.push(head.len() as u32);
    }
    cch::graph::Graph {
        first_out,
        head,
        weight,
    }
}

fn reference_distances(graph: &cch::graph::Graph, sources: &[(u32, u32)]) -> Vec<u32> {
    let mut distances = vec![cch::INF_WEIGHT; graph.first_out.len() - 1];
    let mut visited = vec![false; distances.len()];
    for &(node, initial) in sources {
        distances[node as usize] = distances[node as usize].min(initial);
    }
    for _ in 0..distances.len() {
        let Some(node) = (0..distances.len())
            .filter(|&node| !visited[node])
            .min_by_key(|&node| distances[node])
        else {
            break;
        };
        if distances[node] == cch::INF_WEIGHT {
            break;
        }
        visited[node] = true;
        for edge in graph.first_out[node] as usize..graph.first_out[node + 1] as usize {
            let target = graph.head[edge] as usize;
            distances[target] =
                distances[target].min(distances[node].saturating_add(graph.weight[edge]));
        }
    }
    distances
}

#[test]
fn reusable_cch_targets_match_dijkstra_after_empty_queries_and_epoch_wrap() {
    for seed in 1..=16 {
        let graph = fixture(seed);
        let structure = cch::Cch::build(&graph, &cch::degree_order(&graph));
        let metric = structure.customize(&graph.weight);
        let view = structure.view();
        let mut query = DynamicCchQuery::new(31);
        for round in 0..9 {
            if round == 4 {
                query.generation = u32::MAX;
            }
            let targets = if round % 3 == 0 {
                vec![30, 2, 0, 2]
            } else {
                (0..31).rev().collect::<Vec<_>>()
            };
            for sources in [
                vec![(0, 7), (13, 2), (0, 1)],
                vec![],
                vec![(30, 0)],
                vec![(13, 0)],
            ] {
                let expected = reference_distances(&graph, &sources);
                assert_eq!(
                    query.distances(&view, &metric.view(), &sources, &targets),
                    targets
                        .iter()
                        .map(|&node| expected[node as usize])
                        .collect::<Vec<_>>()
                );
                assert!(
                    query
                        .distances(&view, &metric.view(), &sources, &[])
                        .is_empty()
                );
            }
        }
        let targets = vec![30, 2, 0, 2, 13, 29];
        for maximum in [0, 14, 28, cch::INF_WEIGHT - 1] {
            let buckets =
                build_cch_target_buckets(&view, metric.view().backward, &targets, maximum).unwrap();
            for sources in [vec![], vec![(0, 7), (13, 2)], vec![(30, 0)], vec![(13, 0)]] {
                let expected = reference_distances(&graph, &sources);
                let (indices, distances, _) = query.range_targets(
                    &view,
                    metric.view().forward,
                    &buckets,
                    &sources,
                    maximum,
                    targets.len(),
                );
                let mut actual = vec![cch::INF_WEIGHT; targets.len()];
                for (&index, &distance) in indices.iter().zip(distances) {
                    actual[index as usize] = distance;
                }
                assert_eq!(
                    actual,
                    targets
                        .iter()
                        .map(|&node| {
                            let distance = expected[node as usize];
                            if distance <= maximum {
                                distance
                            } else {
                                cch::INF_WEIGHT
                            }
                        })
                        .collect::<Vec<_>>()
                );
                assert_eq!(
                    query.distances(&view, &metric.view(), &sources, &targets),
                    targets
                        .iter()
                        .map(|&node| expected[node as usize])
                        .collect::<Vec<_>>()
                );
            }
        }
    }
}

#[test]
fn owned_and_borrowed_paths_match_one_shot_across_metric_changes() {
    for seed in 1..=8 {
        let graph = fixture(seed);
        let structure = cch::Cch::build(&graph, &cch::degree_order(&graph));
        let metrics = [
            structure.customize(&graph.weight),
            structure.customize(
                &graph
                    .weight
                    .iter()
                    .map(|weight| 30 - weight)
                    .collect::<Vec<_>>(),
            ),
        ];
        let mut owned = cch::OwnedPathQuery::new(structure);
        for metric in [&metrics[0], &metrics[1], &metrics[0]] {
            for source in 0..31 {
                for target in (0..31).rev() {
                    let expected =
                        cch::node_path(&owned.structure().view(), &metric.view(), source, target);
                    assert_eq!(owned.path(&metric.view(), source, target), expected);
                    let view = owned.structure().view();
                    let mut borrowed = cch::PathQuery::new(&view);
                    assert_eq!(borrowed.path(&metric.view(), source, target), expected);
                    assert_eq!(
                        borrowed.path(&metric.view(), target, source),
                        cch::node_path(&view, &metric.view(), target, source)
                    );
                }
            }
        }
    }
}
