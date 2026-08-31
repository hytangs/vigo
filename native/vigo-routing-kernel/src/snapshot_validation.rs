use std::ops::Range;

pub(crate) fn checked_array_byte_range(
    offset: usize,
    length: usize,
    element_size: usize,
) -> Option<Range<usize>> {
    let byte_length = length.checked_mul(element_size)?;
    let end = offset.checked_add(byte_length)?;
    Some(offset..end)
}

pub(crate) fn validate_array_layouts<'a>(
    bytes: &[u8],
    header_bytes: usize,
    descriptors: impl IntoIterator<Item = (&'a str, usize, usize, usize, usize)>,
) -> Result<(), String> {
    let mut ranges = Vec::new();
    for (name, offset, length, element_size, alignment) in descriptors {
        let range = checked_array_byte_range(offset, length, element_size)
            .ok_or_else(|| format!("Street snapshot {name} range overflows."))?;
        if range.start < header_bytes || range.end > bytes.len() {
            return Err(format!("Street snapshot {name} exceeds its file."));
        }
        let start = bytes
            .get(range.start..)
            .ok_or_else(|| format!("Street snapshot {name} has an invalid offset."))?
            .as_ptr() as usize;
        if !start.is_multiple_of(alignment) {
            return Err(format!("Street snapshot {name} is misaligned."));
        }
        if !range.is_empty() {
            ranges.push((range, name));
        }
    }
    ranges.sort_unstable_by_key(|(range, _)| range.start);
    for pair in ranges.windows(2) {
        if pair[0].0.end > pair[1].0.start {
            return Err(format!(
                "Street snapshot arrays {} and {} overlap.",
                pair[0].1, pair[1].1
            ));
        }
    }
    Ok(())
}

pub(crate) fn csr_offsets_are_valid(offsets: &[u32], entry_count: usize) -> bool {
    let Ok(entry_count) = u32::try_from(entry_count) else {
        return false;
    };
    offsets.first() == Some(&0)
        && offsets.last().copied() == Some(entry_count)
        && offsets.windows(2).all(|range| range[0] <= range[1])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_overlapping_and_overflowing_ranges() {
        let bytes = vec![0_u8; 64];
        assert!(
            validate_array_layouts(&bytes, 8, [("left", 8, 4, 4, 4), ("right", 20, 2, 4, 4)],)
                .is_err()
        );
        assert!(checked_array_byte_range(usize::MAX, 1, 4).is_none());
    }

    #[test]
    fn validates_complete_monotonic_csr_offsets() {
        assert!(csr_offsets_are_valid(&[0, 2, 3], 3));
        assert!(!csr_offsets_are_valid(&[0, 3, 2], 2));
    }
}
