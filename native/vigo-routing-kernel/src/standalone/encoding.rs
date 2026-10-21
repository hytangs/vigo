//! Little-endian arrays as base64 text, for callers that read typed arrays
//! directly: no decimal formatting here, no number parsing there.

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64(bytes: &[u8]) -> String {
    let mut text = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let word = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        for (position, shift) in [18, 12, 6, 0].into_iter().enumerate() {
            text.push(if position <= chunk.len() {
                ALPHABET[(word >> shift & 63) as usize] as char
            } else {
                '='
            });
        }
    }
    text
}

/// Each value as a little-endian f64; a value JSON would write as null
/// (unreached, or not a number) is +infinity.
pub(super) fn f64s(values: &[f64]) -> String {
    let bytes: Vec<u8> = values
        .iter()
        .flat_map(|&value| {
            if value.is_finite() {
                value
            } else {
                f64::INFINITY
            }
            .to_le_bytes()
        })
        .collect();
    base64(&bytes)
}

pub(super) fn u32s(values: &[u32]) -> String {
    let bytes: Vec<u8> = values
        .iter()
        .flat_map(|value| value.to_le_bytes())
        .collect();
    base64(&bytes)
}

#[cfg(test)]
mod tests {
    #[test]
    fn matches_standard_base64_with_padding() {
        assert_eq!(super::base64(b""), "");
        assert_eq!(super::base64(b"f"), "Zg==");
        assert_eq!(super::base64(b"fo"), "Zm8=");
        assert_eq!(super::base64(b"foo"), "Zm9v");
        assert_eq!(super::base64(b"foobar"), "Zm9vYmFy");
        assert_eq!(super::u32s(&[1]), "AQAAAA==");
        assert_eq!(super::f64s(&[f64::NAN]), super::f64s(&[f64::INFINITY]));
    }
}
