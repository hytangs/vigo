//! Preserve JavaScript toFixed's decimal tie rule at migrated display boundaries.

pub(crate) fn rounded(value: f64, digits: usize) -> f64 {
    assert!(digits <= 12);
    // Rust formatting rounds exact halfway cases to even; toFixed rounds them
    // away from zero. Detect a genuine tie in the binary value, without a float
    // multiplication that can turn a nearby value into an apparent tie.
    if value.is_finite() {
        let bits = value.abs().to_bits();
        let exponent = ((bits >> 52) & 0x7ff) as i32;
        let fraction = bits & ((1_u64 << 52) - 1);
        let (mantissa, power) = if exponent == 0 {
            (fraction, -1074)
        } else {
            (fraction | (1_u64 << 52), exponent - 1023 - 52)
        };
        let shift = -power - digits as i32;
        if (1..128).contains(&shift) {
            let numerator = mantissa as u128 * 5_u128.pow(digits as u32);
            let mask = (1_u128 << shift) - 1;
            if numerator & mask == 1_u128 << (shift - 1) {
                let integer = (numerator >> shift) + 1;
                let scale = 10_u128.pow(digits as u32);
                let sign = if value.is_sign_negative() { "-" } else { "" };
                return format!("{sign}{}.{:0digits$}", integer / scale, integer % scale)
                    .parse()
                    .unwrap();
            }
        }
    }
    format!("{value:.digits$}").parse().unwrap_or(value)
}

#[cfg(test)]
mod tests {
    use super::rounded;
    #[test]
    fn decimal_ties_match_javascript_without_rounding_nearby_values_twice() {
        assert_eq!(rounded(0.125, 2), 0.13);
        assert_eq!(rounded(-0.125, 2), -0.13);
        assert_eq!(rounded(1.005, 2), 1.00);
        assert_eq!(rounded(0.0078125, 6), 0.007813);
        assert_eq!(rounded(0.0001220703125, 12), 0.000122070313);
        assert_eq!(rounded(1.0000000000005, 12), 1.000000000001);
        assert_eq!(rounded(f64::from_bits(0.125_f64.to_bits() - 1), 2), 0.12);
        assert_eq!(rounded(f64::from_bits(0.125_f64.to_bits() + 1), 2), 0.13);
    }
}
