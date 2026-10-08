use cch::{CchBundle, MetricBundle};
use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

fn temporary_path(suffix: &str) -> std::path::PathBuf {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock must follow Unix epoch")
        .as_nanos();
    std::env::temp_dir().join(format!(
        "vigo-cch-safety-{}-{unique}.{suffix}",
        std::process::id()
    ))
}

fn append_section(bytes: &mut Vec<u8>, values: &[u32]) {
    bytes.extend_from_slice(&(std::mem::size_of_val(values) as u64).to_le_bytes());
    for value in values {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
}

#[test]
fn rejects_cch_section_cursor_overflow() {
    let path = temporary_path("cch-struct");
    let mut bytes = vec![0_u8; 48];
    bytes[0..8].copy_from_slice(&0x4343_485F_5354_5243_u64.to_le_bytes());
    bytes[8..12].copy_from_slice(&2_u32.to_le_bytes());
    bytes[40..48].copy_from_slice(&u64::MAX.to_le_bytes());
    fs::write(&path, bytes).unwrap();
    let error = CchBundle::open(&path).map(|_| ()).unwrap_err();
    assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
    fs::remove_file(path).unwrap();
}

#[test]
fn rejects_metric_section_cursor_overflow() {
    let path = temporary_path("cch-metric");
    let mut bytes = vec![0_u8; 32];
    bytes[0..8].copy_from_slice(&0x4343_485F_4D45_5452_u64.to_le_bytes());
    bytes[8..12].copy_from_slice(&1_u32.to_le_bytes());
    bytes[24..32].copy_from_slice(&u64::MAX.to_le_bytes());
    fs::write(&path, bytes).unwrap();
    let error = MetricBundle::open(&path).map(|_| ()).unwrap_err();
    assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
    fs::remove_file(path).unwrap();
}

#[test]
fn rejects_semantically_invalid_cch_rank() {
    let path = temporary_path("cch-struct");
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&0x4343_485F_5354_5243_u64.to_le_bytes());
    bytes.extend_from_slice(&2_u32.to_le_bytes());
    bytes.extend_from_slice(&0_u32.to_le_bytes());
    bytes.extend_from_slice(&1_u64.to_le_bytes());
    bytes.extend_from_slice(&0_u64.to_le_bytes());
    bytes.extend_from_slice(&0_u64.to_le_bytes());
    append_section(&mut bytes, &[1]);
    append_section(&mut bytes, &[u32::MAX]);
    append_section(&mut bytes, &[0, 0]);
    append_section(&mut bytes, &[]);
    append_section(&mut bytes, &[0, 0]);
    append_section(&mut bytes, &[]);
    append_section(&mut bytes, &[]);
    fs::write(&path, bytes).unwrap();
    let error = CchBundle::open(&path).map(|_| ()).unwrap_err();
    assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
    assert!(error.to_string().contains("rank"));
    fs::remove_file(path).unwrap();
}

// Exercise persistence through the public CCH API, including parallel input
// arcs and repeated traffic customization. Expected distances come directly
// from the original directed graph, independently of contraction or storage.
#[test]
fn compact_indexes_preserve_routes_and_traffic_updates() {
    use cch::{Cch, INF_WEIGHT, distance_matrix, graph::Graph};
    for n in [0_usize, 1, 7, 25, 72] {
        let mut offsets = vec![0];
        let mut head = Vec::new();
        let mut weights = Vec::new();
        for u in 0..n {
            for v in 0..n {
                if u != v && (u.abs_diff(v) == 1 || (u * 17 + v * 13) % 19 == 0) {
                    head.push(v as u32);
                    weights.push(1 + (u * 7 + v * 3) as u32 % 40);
                    if (u + v) % 3 == 0 {
                        head.push(v as u32);
                        weights.push(90);
                    }
                }
            }
            offsets.push(head.len() as u32);
        }
        let graph = Graph {
            first_out: offsets,
            head,
            weight: weights,
        };
        let order: Vec<_> = (0..n as u32).rev().collect();
        let cch = Cch::build(&graph, &order);
        let full = temporary_path("drive.cch-struct");
        let query = temporary_path("walk.cch-struct");
        cch.save_struct(&full).unwrap();
        cch.save_query_struct(&query).unwrap();
        let restored = Cch::load_struct(&full).unwrap();
        let mapped = CchBundle::open(&query).unwrap();
        assert_eq!(mapped.view().rank, cch.rank);
        assert_eq!(restored.order, cch.order);
        assert_eq!(restored.up_tail, cch.up_tail);
        assert_eq!(restored.input_arc_to_cch_arc, cch.input_arc_to_cch_arc);
        assert_eq!(
            restored.extra_forward_input_arc_of_cch,
            cch.extra_forward_input_arc_of_cch
        );
        assert_eq!(
            restored.extra_backward_input_arc_of_cch,
            cch.extra_backward_input_arc_of_cch
        );
        assert!(
            Cch::load_struct(&query)
                .err()
                .unwrap()
                .to_string()
                .contains("query-only")
        );
        assert_eq!(
            fs::metadata(&query).unwrap().len(),
            104 + n as u64 * 16 + cch.cch_arc_count() as u64 * 12
        );
        for generation in 0..4 {
            let weights: Vec<_> = graph
                .weight
                .iter()
                .enumerate()
                .map(|(i, &w)| {
                    if generation != 0 && (i + generation) % 7 == 0 {
                        INF_WEIGHT
                    } else {
                        w * (1 + (i + generation) as u32 % 4)
                    }
                })
                .collect();
            let metric = restored.customize(&weights);
            let original = cch.customize(&weights);
            assert_eq!(metric.forward, original.forward);
            assert_eq!(metric.backward, original.backward);
            let nodes: Vec<_> = (0..n as u32).collect();
            let actual = distance_matrix(&mapped.view(), &metric.view(), &nodes, &nodes);
            for source in 0..n {
                let mut distance = vec![INF_WEIGHT; n];
                let mut visited = vec![false; n];
                distance[source] = 0;
                for _ in 0..n {
                    let u = (0..n)
                        .filter(|&v| !visited[v])
                        .min_by_key(|&v| distance[v])
                        .unwrap();
                    visited[u] = true;
                    for (arc, &weight) in weights
                        .iter()
                        .enumerate()
                        .take(graph.first_out[u + 1] as usize)
                        .skip(graph.first_out[u] as usize)
                    {
                        let v = graph.head[arc] as usize;
                        distance[v] =
                            distance[v].min(distance[u].saturating_add(weight).min(INF_WEIGHT));
                    }
                }
                assert_eq!(&actual[source * n..(source + 1) * n], distance);
            }
        }
        drop(mapped);
        fs::remove_file(full).unwrap();
        fs::remove_file(query).unwrap();
    }
}

#[test]
fn compact_indexes_reject_old_truncated_and_corrupt_payloads() {
    use cch::{Cch, graph::Graph};
    let graph = Graph {
        first_out: vec![0, 2, 3, 4],
        head: vec![1, 2, 0, 1],
        weight: vec![1; 4],
    };
    let cch = Cch::build(&graph, &[1, 0, 2]);
    let path = temporary_path("cch-struct");
    cch.save_struct(&path).unwrap();
    let original = fs::read(&path).unwrap();
    for length in 0..original.len() {
        fs::write(&path, &original[..length]).unwrap();
        assert!(Cch::load_struct(&path).is_err(), "truncated at {length}");
    }
    for (offset, value) in [(8, 1_u8), (12, 2), (48, 255), (original.len() - 8, 255)] {
        let mut bytes = original.clone();
        bytes[offset] = value;
        fs::write(&path, bytes).unwrap();
        assert!(Cch::load_struct(&path).is_err(), "corrupt at {offset}");
    }
    let mut extra = original;
    extra.push(0);
    fs::write(&path, extra).unwrap();
    assert!(Cch::load_struct(&path).is_err());
    cch.save_query_struct(&path).unwrap();
    let mut extra = fs::read(&path).unwrap();
    extra.push(0);
    fs::write(&path, extra).unwrap();
    assert!(CchBundle::open(&path).is_err());
    fs::remove_file(path).unwrap();
}
