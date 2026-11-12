//! JSON text that matches JavaScript `JSON.stringify`.
//!
//! Prepared metadata written by earlier compilers is compared as text by
//! readers and fingerprints. Keep object keys in insertion order and format
//! numbers with the ECMAScript `Number::toString` rules: integral values carry
//! no fraction, and exponents start at 1e21 and below 1e-6.

use std::fmt::Write;

/// A JSON value with ordered object members.
#[derive(Clone, Debug, PartialEq)]
pub enum Js {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<Js>),
    Object(Vec<(String, Js)>),
}

impl Js {
    pub fn object() -> Self {
        Js::Object(Vec::new())
    }

    /// Append or replace a member, as assigning a JavaScript property does.
    pub fn set(&mut self, key: impl Into<String>, value: impl Into<Js>) -> &mut Self {
        let key = key.into();
        let value = value.into();
        if let Js::Object(members) = self {
            match members.iter_mut().find(|(name, _)| *name == key) {
                Some(member) => member.1 = value,
                None => members.push((key, value)),
            }
        }
        self
    }

    pub fn with(mut self, key: impl Into<String>, value: impl Into<Js>) -> Self {
        self.set(key, value);
        self
    }

    pub fn get(&self, key: &str) -> Option<&Js> {
        match self {
            Js::Object(members) => members.iter().find(|(name, _)| name == key).map(|(_, v)| v),
            _ => None,
        }
    }

    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Js::Number(value) => Some(*value),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Js::String(value) => Some(value),
            _ => None,
        }
    }

    pub fn stringify(&self) -> String {
        let mut out = String::new();
        self.write(&mut out);
        out
    }

    /// `JSON.stringify(value, null, indent)` for pretty manifests.
    pub fn stringify_pretty(&self, indent: usize) -> String {
        let mut out = String::new();
        self.write_pretty(&mut out, indent, 0);
        out
    }

    fn write(&self, out: &mut String) {
        match self {
            Js::Null => out.push_str("null"),
            Js::Bool(value) => out.push_str(if *value { "true" } else { "false" }),
            Js::Number(value) => out.push_str(&number(*value)),
            Js::String(value) => quote_into(value, out),
            Js::Array(items) => {
                out.push('[');
                for (index, item) in items.iter().enumerate() {
                    if index > 0 {
                        out.push(',');
                    }
                    item.write(out);
                }
                out.push(']');
            }
            Js::Object(members) => {
                out.push('{');
                for (index, (key, value)) in members.iter().enumerate() {
                    if index > 0 {
                        out.push(',');
                    }
                    quote_into(key, out);
                    out.push(':');
                    value.write(out);
                }
                out.push('}');
            }
        }
    }

    fn write_pretty(&self, out: &mut String, indent: usize, depth: usize) {
        let pad = |out: &mut String, depth: usize| {
            out.push('\n');
            out.extend(std::iter::repeat_n(' ', indent * depth));
        };
        match self {
            Js::Array(items) if !items.is_empty() => {
                out.push('[');
                for (index, item) in items.iter().enumerate() {
                    if index > 0 {
                        out.push(',');
                    }
                    pad(out, depth + 1);
                    item.write_pretty(out, indent, depth + 1);
                }
                pad(out, depth);
                out.push(']');
            }
            Js::Object(members) if !members.is_empty() => {
                out.push('{');
                for (index, (key, value)) in members.iter().enumerate() {
                    if index > 0 {
                        out.push(',');
                    }
                    pad(out, depth + 1);
                    quote_into(key, out);
                    out.push_str(": ");
                    value.write_pretty(out, indent, depth + 1);
                }
                pad(out, depth);
                out.push('}');
            }
            other => other.write(out),
        }
    }
}

impl From<bool> for Js {
    fn from(value: bool) -> Self {
        Js::Bool(value)
    }
}
impl From<f64> for Js {
    fn from(value: f64) -> Self {
        Js::Number(value)
    }
}
macro_rules! from_integer {
    ($($t:ty),*) => {$(
        impl From<$t> for Js {
            fn from(value: $t) -> Self { Js::Number(value as f64) }
        }
    )*};
}
from_integer!(i32, i64, u32, u64, usize);
impl From<&str> for Js {
    fn from(value: &str) -> Self {
        Js::String(value.to_owned())
    }
}
impl From<String> for Js {
    fn from(value: String) -> Self {
        Js::String(value)
    }
}
impl From<&String> for Js {
    fn from(value: &String) -> Self {
        Js::String(value.clone())
    }
}
impl<T: Into<Js>> From<Option<T>> for Js {
    fn from(value: Option<T>) -> Self {
        value.map_or(Js::Null, Into::into)
    }
}
impl<T: Into<Js>> From<Vec<T>> for Js {
    fn from(value: Vec<T>) -> Self {
        Js::Array(value.into_iter().map(Into::into).collect())
    }
}

/// Convert parsed JSON, keeping serde_json's member order.
impl From<&serde_json::Value> for Js {
    fn from(value: &serde_json::Value) -> Self {
        match value {
            serde_json::Value::Null => Js::Null,
            serde_json::Value::Bool(v) => Js::Bool(*v),
            serde_json::Value::Number(v) => Js::Number(v.as_f64().unwrap_or(f64::NAN)),
            serde_json::Value::String(v) => Js::String(v.clone()),
            serde_json::Value::Array(v) => Js::Array(v.iter().map(Js::from).collect()),
            serde_json::Value::Object(v) => {
                Js::Object(v.iter().map(|(k, v)| (k.clone(), Js::from(v))).collect())
            }
        }
    }
}

impl Js {
    /// `JSON.parse(text)`, keeping object members in document order.
    pub fn parse(text: &str) -> serde_json::Result<Js> {
        serde_json::from_str(text)
    }
}

impl<'de> serde::Deserialize<'de> for Js {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Visitor;
        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = Js;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("JSON")
            }
            fn visit_unit<E>(self) -> Result<Js, E> {
                Ok(Js::Null)
            }
            fn visit_none<E>(self) -> Result<Js, E> {
                Ok(Js::Null)
            }
            fn visit_bool<E>(self, v: bool) -> Result<Js, E> {
                Ok(Js::Bool(v))
            }
            fn visit_i64<E>(self, v: i64) -> Result<Js, E> {
                Ok(Js::Number(v as f64))
            }
            fn visit_u64<E>(self, v: u64) -> Result<Js, E> {
                Ok(Js::Number(v as f64))
            }
            fn visit_f64<E>(self, v: f64) -> Result<Js, E> {
                Ok(Js::Number(v))
            }
            fn visit_str<E>(self, v: &str) -> Result<Js, E> {
                Ok(Js::String(v.to_owned()))
            }
            fn visit_string<E>(self, v: String) -> Result<Js, E> {
                Ok(Js::String(v))
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut seq: A) -> Result<Js, A::Error> {
                let mut items = vec![];
                while let Some(item) = seq.next_element()? {
                    items.push(item);
                }
                Ok(Js::Array(items))
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(self, mut map: A) -> Result<Js, A::Error> {
                let mut object = Js::object();
                while let Some((key, value)) = map.next_entry::<String, Js>()? {
                    // JSON.parse keeps the last duplicate at the first position.
                    object.set(key, value);
                }
                Ok(object)
            }
        }
        deserializer.deserialize_any(Visitor)
    }
}

/// ECMAScript `Number.prototype.toString()` for JSON: NaN and infinities are
/// `null`, and negative zero is `0`.
pub fn number(value: f64) -> String {
    if !value.is_finite() {
        return "null".to_owned();
    }
    if value == 0.0 {
        return "0".to_owned();
    }
    // Rust prints the shortest round-trip digits, as ECMAScript requires.
    let scientific = format!("{:e}", value.abs());
    let (mantissa, exponent) = scientific.split_once('e').expect("float exponent");
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    let n = exponent.parse::<i32>().expect("float exponent") + 1;
    let mut out = String::new();
    if value < 0.0 {
        out.push('-');
    }
    if k <= n && n <= 21 {
        out.push_str(&digits);
        out.extend(std::iter::repeat_n('0', (n - k) as usize));
    } else if 0 < n && n <= 21 {
        out.push_str(&digits[..n as usize]);
        out.push('.');
        out.push_str(&digits[n as usize..]);
    } else if -6 < n && n <= 0 {
        out.push_str("0.");
        out.extend(std::iter::repeat_n('0', (-n) as usize));
        out.push_str(&digits);
    } else {
        out.push_str(&digits[..1]);
        if k > 1 {
            out.push('.');
            out.push_str(&digits[1..]);
        }
        let _ = write!(out, "e{}{}", if n > 0 { '+' } else { '-' }, (n - 1).abs());
    }
    out
}

/// `left.localeCompare(right)` with Node's default en-US ICU collator:
/// tertiary strength, punctuation not ignored, control characters ignorable.
/// Earlier compilers ordered stop identifiers and scopes this way.
pub fn locale_compare(left: &str, right: &str) -> std::cmp::Ordering {
    use icu_collator::{Collator, CollatorBorrowed, options::CollatorOptions};
    use std::sync::OnceLock;
    static COLLATOR: OnceLock<CollatorBorrowed<'static>> = OnceLock::new();
    COLLATOR
        .get_or_init(|| {
            Collator::try_new(Default::default(), CollatorOptions::default())
                .expect("compiled root collation data")
        })
        .compare(left, right)
}

/// `JSON.stringify(text)`.
pub fn quote(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    quote_into(text, &mut out);
    out
}

fn quote_into(text: &str, out: &mut String) {
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// `value.toLocaleString()` in the en-US locale for integers: digit groups.
pub fn grouped(value: i64) -> String {
    let digits = value.unsigned_abs().to_string();
    let mut out = String::new();
    if value < 0 {
        out.push('-');
    }
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            out.push(',');
        }
        out.push(digit);
    }
    out
}

/// `new Date().toISOString()`.
pub fn iso_now() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let millis = now.as_millis() as i64;
    let days = millis.div_euclid(86_400_000);
    let ms_of_day = millis.rem_euclid(86_400_000);
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        ms_of_day / 3_600_000,
        ms_of_day / 60_000 % 60,
        ms_of_day / 1000 % 60,
        ms_of_day % 1000
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_match_ecmascript() {
        for (value, text) in [
            (0.0, "0"),
            (-0.0, "0"),
            (5.0, "5"),
            (-5.0, "-5"),
            (0.25, "0.25"),
            (1e21, "1e+21"),
            (123456789012345680000.0, "123456789012345680000"),
            (1.5e-7, "1.5e-7"),
            (0.000001, "0.000001"),
            (1e-7, "1e-7"),
            (0.1 + 0.2, "0.30000000000000004"),
            (2f64.powi(53), "9007199254740992"),
            (1234.5678, "1234.5678"),
            (f64::NAN, "null"),
            (f64::INFINITY, "null"),
        ] {
            assert_eq!(number(value), text, "{value}");
        }
    }

    #[test]
    fn strings_and_objects_match_json_stringify() {
        let value = Js::object()
            .with("b", 1)
            .with("a", vec![Js::from("x\u{1f}\"\n"), Js::Null, Js::from(true)])
            .with("é", Js::object());
        assert_eq!(
            value.stringify(),
            r#"{"b":1,"a":["x\u001f\"\n",null,true],"é":{}}"#
        );
        assert_eq!(
            Js::object().with("a", vec![1, 2]).stringify_pretty(2),
            "{\n  \"a\": [\n    1,\n    2\n  ]\n}"
        );
        assert_eq!(grouped(1234567), "1,234,567");
        let mut words = vec![
            "b", "B", "a-b", "ab", "a_b", "A", "10", "9", "é", "e", "f", "🚌-bus", "bus", "Rail",
            "rail",
        ];
        words.sort_by(|a, b| locale_compare(a, b));
        assert_eq!(
            words,
            [
                "🚌-bus", "10", "9", "A", "a_b", "a-b", "ab", "b", "B", "bus", "e", "é", "f",
                "rail", "Rail"
            ]
        );
        assert_eq!(
            locale_compare("bus\u{1f}X", "busX"),
            std::cmp::Ordering::Equal
        );
        let parsed = Js::parse(r#"{"z":1,"a":[2.5,null,{"y":true,"b":"x"}],"z":3}"#).unwrap();
        assert_eq!(
            parsed.stringify(),
            r#"{"z":3,"a":[2.5,null,{"y":true,"b":"x"}]}"#
        );
        assert_eq!(grouped(12), "12");
    }
}
