//! The JavaScript string and number semantics the earlier compiler relied on.

use std::borrow::Cow;

/// ECMAScript WhiteSpace and LineTerminator, as `trim` and regex `\s` use.
pub fn is_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// `String.prototype.trim`.
pub fn trim(text: &str) -> &str {
    text.trim_matches(is_space)
}

/// `String(value ?? '').trim().toLowerCase()`.
pub fn norm(text: &str) -> Cow<'_, str> {
    let trimmed = trim(text);
    if trimmed
        .bytes()
        .all(|b| b.is_ascii() && !b.is_ascii_uppercase())
    {
        Cow::Borrowed(trimmed)
    } else {
        Cow::Owned(trimmed.to_lowercase())
    }
}

/// `norm` of an optional tag value: absent is the empty string.
pub fn norm_opt(value: Option<&str>) -> Cow<'_, str> {
    value.map_or(Cow::Borrowed(""), norm)
}

/// `Math.round`: halves round toward positive infinity.
pub fn round(value: f64) -> f64 {
    if !value.is_finite() {
        return value;
    }
    let floor = value.floor();
    let rounded = if value - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    };
    // Math.round(-0.4) is -0; preserve the sign of a zero result.
    if rounded == 0.0 && value.is_sign_negative() {
        -0.0
    } else {
        rounded
    }
}

/// `Number.prototype.toFixed(digits)` for finite values below 1e21.
pub fn to_fixed(value: f64, digits: usize) -> String {
    let negative = value < 0.0;
    let magnitude = value.abs();
    let scale = 2.0 * 10f64.powi(digits as i32);
    let product = magnitude * scale;
    // An exact half: ECMAScript picks the larger candidate, Rust the even one.
    let exact_half = product.fract() == 0.0
        && product < 9_007_199_254_740_992.0
        && (product as u64) % 2 == 1
        && magnitude.mul_add(scale, -product) == 0.0;
    let body = if exact_half {
        let units = (product as u64).div_ceil(2);
        let text = units.to_string();
        if digits == 0 {
            text
        } else {
            let padded = format!("{text:0>width$}", width = digits + 1);
            let split = padded.len() - digits;
            format!("{}.{}", &padded[..split], &padded[split..])
        }
    } else {
        format!("{magnitude:.digits$}")
    };
    if negative { format!("-{body}") } else { body }
}

/// `Number(string)` (ECMAScript StringToNumber).
pub fn string_to_number(text: &str) -> f64 {
    let text = trim(text);
    if text.is_empty() {
        return 0.0;
    }
    let radix = |digits: &str, base: u32| -> f64 {
        if digits.is_empty() {
            return f64::NAN;
        }
        let mut value = 0f64;
        for c in digits.chars() {
            match c.to_digit(base) {
                Some(d) => value = value * f64::from(base) + f64::from(d),
                None => return f64::NAN,
            }
        }
        value
    };
    let lower = text.as_bytes();
    if lower.len() > 2 && lower[0] == b'0' {
        match lower[1] {
            b'x' | b'X' => return radix(&text[2..], 16),
            b'o' | b'O' => return radix(&text[2..], 8),
            b'b' | b'B' => return radix(&text[2..], 2),
            _ => {}
        }
    }
    match text {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    if !text
        .bytes()
        .all(|b| b.is_ascii_digit() || matches!(b, b'+' | b'-' | b'.' | b'e' | b'E'))
    {
        return f64::NAN;
    }
    text.parse::<f64>().unwrap_or(f64::NAN)
}

/// `Number.isInteger`.
pub fn is_integer(value: f64) -> bool {
    value.is_finite() && value.fract() == 0.0
}

/// `value.toLocaleString()` for the integer counts in progress details.
pub fn grouped(value: f64) -> String {
    vigo_format::js::grouped(value as i64)
}

/// `Math.min(a, b)`, including NaN and signed-zero handling.
pub fn min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == b {
        if a.is_sign_negative() { a } else { b }
    } else if a < b {
        a
    } else {
        b
    }
}

/// `Math.max(a, b)`, including NaN and signed-zero handling.
pub fn max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == b {
        if a.is_sign_positive() { a } else { b }
    } else if a > b {
        a
    } else {
        b
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rounding_and_fixed_match_javascript() {
        assert_eq!(round(2.5), 3.0);
        assert_eq!(round(-2.5), -2.0);
        assert_eq!(round(0.49999999999999994), 0.0);
        assert_eq!(to_fixed(0.0078125, 6), "0.007813");
        assert_eq!(to_fixed(-0.0078125, 6), "-0.007813");
        assert_eq!(to_fixed(1.005, 2), "1.00");
        assert_eq!(to_fixed(-71.0589123456, 6), "-71.058912");
        assert_eq!(to_fixed(-0.0, 6), "0.000000");
        assert_eq!(to_fixed(2.5, 0), "3");
        assert_eq!(string_to_number(" 3 "), 3.0);
        assert_eq!(string_to_number("0x10"), 16.0);
        assert!(string_to_number("1.2.3").is_nan());
        assert!(string_to_number("inf").is_nan());
        assert_eq!(string_to_number("2.0"), 2.0);
        assert_eq!(string_to_number(""), 0.0);
        assert_eq!(norm(" Yes "), "yes");
    }
}
