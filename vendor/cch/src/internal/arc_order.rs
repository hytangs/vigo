//! Stable lexicographic arc ordering without comparison sorting or key copies.
pub(crate) fn arc_order(node_count: usize, tail: &[u32], head: &[u32]) -> Vec<u32> {
    assert_eq!(tail.len(), head.len());
    let mut order: Vec<u32> = (0..u32::try_from(tail.len()).expect("arc count fits u32")).collect();
    if tail.len() < 512 {
        order.sort_by_key(|&i| (tail[i as usize], head[i as usize]));
        return order;
    }
    let mut scratch = vec![0; order.len()];
    let mut positions = vec![0usize; node_count + 1];
    for keys in [head, tail] {
        positions.fill(0);
        for &key in keys {
            positions[key as usize + 1] += 1;
        }
        for i in 0..node_count {
            positions[i + 1] += positions[i];
        }
        for &index in &order {
            let key = keys[index as usize] as usize;
            scratch[positions[key]] = index;
            positions[key] += 1;
        }
        std::mem::swap(&mut order, &mut scratch);
    }
    order
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn matches_stable_comparison_with_duplicate_arcs() {
        for count in [0, 1, 511, 512, 4096, 100_000] {
            let tail: Vec<u32> = (0..count).map(|i| (i * 31 + i / 7) % 257).collect();
            let head: Vec<u32> = (0..count).map(|i| (i * 23 + i / 3) % 257).collect();
            let mut expected: Vec<u32> = (0..count).collect();
            expected.sort_by_key(|&i| (tail[i as usize], head[i as usize]));
            assert_eq!(arc_order(257, &tail, &head), expected);
        }
    }
}
