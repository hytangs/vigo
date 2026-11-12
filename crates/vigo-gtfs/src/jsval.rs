//! JavaScript value semantics the routing-store compiler must reproduce.
//!
//! Stores built by earlier JavaScript compilers are the format baseline, so
//! source text is converted with ECMAScript rules: `Number(text)`, `trim()`,
//! object key order and `JSON.parse`.

use std::collections::HashMap;
use vigo_format::js::Js;

/// ECMAScript `WhiteSpace` and `LineTerminator` code points.
pub fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{09}'
            | '\u{0A}'
            | '\u{0B}'
            | '\u{0C}'
            | '\u{0D}'
            | '\u{20}'
            | '\u{A0}'
            | '\u{1680}'
            | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// `String.prototype.trim()`.
pub fn trim(text: &str) -> &str {
    text.trim_matches(is_js_whitespace)
}

/// `String(value ?? '').trim()` for an optional source field.
pub fn trimmed(value: Option<&str>) -> &str {
    trim(value.unwrap_or(""))
}

fn radix_value(digits: &str, radix: u32) -> f64 {
    if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
        return f64::NAN;
    }
    if let Ok(value) = u128::from_str_radix(digits, radix) {
        return value as f64;
    }
    // Beyond 128 bits a rounding difference is immaterial for GTFS fields.
    digits.chars().fold(0.0, |sum, c| {
        sum * radix as f64 + c.to_digit(radix).unwrap() as f64
    })
}

/// `Number(text)` (ECMAScript StringToNumber).
pub fn to_number(text: &str) -> f64 {
    // Fast path for plain integers, the common GTFS case; exact below 2^53.
    let bytes = text.as_bytes();
    if !bytes.is_empty() && bytes.len() <= 15 && bytes.iter().all(u8::is_ascii_digit) {
        return bytes
            .iter()
            .fold(0u64, |sum, b| sum * 10 + u64::from(b - b'0')) as f64;
    }
    let text = trim(text);
    if text.is_empty() {
        return 0.0;
    }
    let lower = text.get(..2).map(str::to_ascii_lowercase);
    match lower.as_deref() {
        Some("0x") => return radix_value(&text[2..], 16),
        Some("0o") => return radix_value(&text[2..], 8),
        Some("0b") => return radix_value(&text[2..], 2),
        _ => {}
    }
    let (sign, body) = match text.as_bytes()[0] {
        b'+' => (1.0, &text[1..]),
        b'-' => (-1.0, &text[1..]),
        _ => (1.0, text),
    };
    if body == "Infinity" {
        return sign * f64::INFINITY;
    }
    // StrUnsignedDecimalLiteral: digits [. digits] [exponent] with a digit somewhere.
    let bytes = body.as_bytes();
    let mut index = 0;
    let mut digits = 0;
    while index < bytes.len() && bytes[index].is_ascii_digit() {
        index += 1;
        digits += 1;
    }
    if index < bytes.len() && bytes[index] == b'.' {
        index += 1;
        while index < bytes.len() && bytes[index].is_ascii_digit() {
            index += 1;
            digits += 1;
        }
    }
    if digits == 0 {
        return f64::NAN;
    }
    if index < bytes.len() && (bytes[index] == b'e' || bytes[index] == b'E') {
        index += 1;
        if index < bytes.len() && (bytes[index] == b'+' || bytes[index] == b'-') {
            index += 1;
        }
        let start = index;
        while index < bytes.len() && bytes[index].is_ascii_digit() {
            index += 1;
        }
        if index == start {
            return f64::NAN;
        }
    }
    if index != bytes.len() {
        return f64::NAN;
    }
    match body.parse::<f64>() {
        Ok(value) => sign * value,
        Err(_) => f64::NAN,
    }
}

/// `Number(value)` where an absent source field is `undefined` (NaN).
pub fn number(value: Option<&str>) -> f64 {
    value.map_or(f64::NAN, to_number)
}

/// `numeric(value, fallback)` from number-utils.mjs.
pub fn numeric(value: Option<&str>, fallback: f64) -> f64 {
    let number = number(value);
    if number.is_finite() { number } else { fallback }
}

pub fn is_integer(value: f64) -> bool {
    value.is_finite() && value.trunc() == value
}

pub fn is_safe_integer(value: f64) -> bool {
    is_integer(value) && value.abs() <= 9_007_199_254_740_991.0
}

/// `value || null` for an optional source text.
pub fn or_null(value: Option<&str>) -> Option<&str> {
    value.filter(|text| !text.is_empty())
}

/// `text.slice(n)` measured in UTF-16 code units.
pub fn slice_utf16(text: &str, units: usize) -> String {
    let mut skipped = 0;
    let mut out = String::new();
    for c in text.chars() {
        if skipped >= units {
            out.push(c);
            continue;
        }
        let width = c.len_utf16();
        if skipped + width <= units {
            skipped += width;
        } else {
            // Slicing inside a surrogate pair leaves a lone low surrogate,
            // which no Rust string can hold; it is never source whitespace.
            skipped = units;
            out.push('\u{FFFD}');
        }
    }
    out
}

/// A canonical array index, which JavaScript objects order first.
pub fn array_index(key: &str) -> Option<u32> {
    if key.is_empty() || key.len() > 10 || (key.len() > 1 && key.starts_with('0')) {
        return None;
    }
    if !key.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    key.parse::<u64>()
        .ok()
        .filter(|value| *value < u32::MAX as u64)
        .map(|value| value as u32)
}

/// Members in JavaScript property order: array indices ascending, then the
/// remaining keys in insertion order.
pub fn object(members: Vec<(String, Js)>) -> Js {
    let (mut indices, rest): (Vec<_>, Vec<_>) = members
        .into_iter()
        .partition(|(key, _)| array_index(key).is_some());
    if !indices.is_empty() {
        indices.sort_by_key(|(key, _)| array_index(key));
        indices.extend(rest);
        return Js::Object(indices);
    }
    Js::Object(rest)
}

/// An insertion-ordered map with JavaScript object iteration order.
#[derive(Clone, Debug)]
pub struct JsMap<V> {
    slots: Vec<Option<(String, V)>>,
    index: HashMap<String, usize>,
}

impl<V> Default for JsMap<V> {
    fn default() -> Self {
        Self {
            slots: Vec::new(),
            index: HashMap::new(),
        }
    }
}

impl<V> JsMap<V> {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn len(&self) -> usize {
        self.index.len()
    }
    pub fn is_empty(&self) -> bool {
        self.index.is_empty()
    }
    pub fn contains_key(&self, key: &str) -> bool {
        self.index.contains_key(key)
    }
    pub fn get(&self, key: &str) -> Option<&V> {
        self.index
            .get(key)
            .and_then(|i| self.slots[*i].as_ref())
            .map(|(_, v)| v)
    }
    pub fn get_mut(&mut self, key: &str) -> Option<&mut V> {
        match self.index.get(key) {
            Some(i) => self.slots[*i].as_mut().map(|(_, v)| v),
            None => None,
        }
    }
    /// Assignment keeps an existing key's position.
    pub fn insert(&mut self, key: String, value: V) {
        if let Some(i) = self.index.get(&key) {
            self.slots[*i].as_mut().unwrap().1 = value;
        } else {
            self.index.insert(key.clone(), self.slots.len());
            self.slots.push(Some((key, value)));
        }
    }
    pub fn remove(&mut self, key: &str) -> Option<V> {
        let i = self.index.remove(key)?;
        self.slots[i].take().map(|(_, v)| v)
    }
    /// Keys in JavaScript property order.
    pub fn keys(&self) -> Vec<String> {
        let mut indices = Vec::new();
        let mut rest = Vec::new();
        for (key, _) in self.slots.iter().flatten() {
            match array_index(key) {
                Some(n) => indices.push((n, key.clone())),
                None => rest.push(key.clone()),
            }
        }
        indices.sort_by_key(|(n, _)| *n);
        indices
            .into_iter()
            .map(|(_, key)| key)
            .chain(rest)
            .collect()
    }
}

/// Truthiness of a parsed JSON value.
pub fn truthy(value: &Js) -> bool {
    match value {
        Js::Null => false,
        Js::Bool(v) => *v,
        Js::Number(v) => *v != 0.0 && !v.is_nan(),
        Js::String(v) => !v.is_empty(),
        Js::Array(_) | Js::Object(_) => true,
    }
}

/// `JSON.parse` into ordered values with JavaScript object semantics.
/// Errors carry V8's messages, positions in UTF-16 code units.
pub fn parse_json(text: &str) -> Result<Js, String> {
    let mut parser = JsonParser {
        bytes: text.as_bytes(),
        text,
        at: 0,
    };
    let result = (|| {
        parser.space();
        let value = parser.value(0)?;
        parser.space();
        if parser.at != parser.bytes.len() {
            return Err(Failure::At(
                "Unexpected non-whitespace character after JSON",
                parser.at,
            ));
        }
        Ok(value)
    })();
    result.map_err(|failure| parser.message(failure))
}

enum Failure {
    End,
    Token(usize),
    At(&'static str, usize),
}

struct JsonParser<'a> {
    bytes: &'a [u8],
    text: &'a str,
    at: usize,
}

impl JsonParser<'_> {
    fn units(&self, byte: usize) -> usize {
        self.text[..byte].encode_utf16().count()
    }
    fn message(&self, failure: Failure) -> String {
        let length = self.text.encode_utf16().count();
        match failure {
            Failure::End => "Unexpected end of JSON input".into(),
            Failure::At(what, byte) => {
                let position = self.units(byte);
                let line_start = self.text[..byte].rfind('\n').map_or(0, |i| i + 1);
                let line = self.text[..byte].matches('\n').count() + 1;
                let column = self.units(byte) - self.units(line_start) + 1;
                let place = if what.ends_with("JSON") {
                    ""
                } else {
                    " in JSON"
                };
                format!("{what}{place} at position {position} (line {line} column {column})")
            }
            Failure::Token(byte) => {
                if matches!(
                    self.text,
                    "NaN" | "Infinity" | "undefined" | "[object Object]"
                ) {
                    return format!("\"{}\" is not valid JSON", self.text);
                }
                let token = self.text[byte..].chars().next().unwrap_or('\u{FFFD}');
                // A character outside the BMP is reported by its first code unit.
                let token = if token.len_utf16() == 2 {
                    '\u{FFFD}'
                } else {
                    token
                };
                if length <= 21 {
                    return format!(
                        "Unexpected token '{token}', \"{}\" is not valid JSON",
                        self.text
                    );
                }
                let units: Vec<u16> = self.text.encode_utf16().collect();
                let position = self.units(byte);
                let start = position.saturating_sub(10);
                let end = (position + 10).min(length);
                let excerpt = String::from_utf16_lossy(&units[start..end]);
                let before = if start > 0 { "..." } else { "" };
                let after = if end < length { "..." } else { "" };
                format!(
                    "Unexpected token '{token}', {before}\"{excerpt}\"{after} is not valid JSON"
                )
            }
        }
    }
    fn space(&mut self) {
        while self.at < self.bytes.len()
            && matches!(self.bytes[self.at], b' ' | b'\t' | b'\n' | b'\r')
        {
            self.at += 1;
        }
    }
    fn unexpected(&self) -> Failure {
        if self.at >= self.bytes.len() {
            Failure::End
        } else {
            Failure::Token(self.at)
        }
    }
    fn literal(&mut self, word: &str, value: Js) -> Result<Js, Failure> {
        for expected in word.bytes() {
            match self.bytes.get(self.at) {
                None => return Err(Failure::End),
                Some(byte) if *byte == expected => self.at += 1,
                Some(_) => return Err(Failure::Token(self.at)),
            }
        }
        Ok(value)
    }
    fn value(&mut self, depth: usize) -> Result<Js, Failure> {
        if depth > 10_000 {
            return Err(Failure::At("Maximum nesting depth exceeded", self.at));
        }
        match self.bytes.get(self.at) {
            Some(b'{') => {
                self.at += 1;
                let mut members: Vec<(String, Js)> = Vec::new();
                let mut positions: HashMap<String, usize> = HashMap::new();
                self.space();
                if self.bytes.get(self.at) == Some(&b'}') {
                    self.at += 1;
                    return Ok(Js::Object(members));
                }
                let mut first = true;
                loop {
                    self.space();
                    if self.bytes.get(self.at) != Some(&b'"') {
                        let what = if first {
                            "Expected property name or '}'"
                        } else {
                            "Expected double-quoted property name"
                        };
                        return Err(Failure::At(what, self.at));
                    }
                    first = false;
                    let key = self.string()?;
                    self.space();
                    if self.bytes.get(self.at) != Some(&b':') {
                        return Err(Failure::At("Expected ':' after property name", self.at));
                    }
                    self.at += 1;
                    self.space();
                    let value = self.value(depth + 1)?;
                    match positions.get(&key) {
                        Some(i) => members[*i].1 = value,
                        None => {
                            positions.insert(key.clone(), members.len());
                            members.push((key, value));
                        }
                    }
                    self.space();
                    match self.bytes.get(self.at) {
                        Some(b',') => self.at += 1,
                        Some(b'}') => {
                            self.at += 1;
                            return Ok(object(members));
                        }
                        _ => {
                            return Err(Failure::At(
                                "Expected ',' or '}' after property value",
                                self.at,
                            ));
                        }
                    }
                }
            }
            Some(b'[') => {
                self.at += 1;
                let mut items = Vec::new();
                self.space();
                if self.bytes.get(self.at) == Some(&b']') {
                    self.at += 1;
                    return Ok(Js::Array(items));
                }
                loop {
                    self.space();
                    items.push(self.value(depth + 1)?);
                    self.space();
                    match self.bytes.get(self.at) {
                        Some(b',') => self.at += 1,
                        Some(b']') => {
                            self.at += 1;
                            return Ok(Js::Array(items));
                        }
                        _ => {
                            return Err(Failure::At(
                                "Expected ',' or ']' after array element",
                                self.at,
                            ));
                        }
                    }
                }
            }
            Some(b'"') => self.string().map(Js::String),
            Some(b't') => self.literal("true", Js::Bool(true)),
            Some(b'f') => self.literal("false", Js::Bool(false)),
            Some(b'n') => self.literal("null", Js::Null),
            Some(b'-' | b'0'..=b'9') => self.number(),
            _ => Err(self.unexpected()),
        }
    }
    fn digits(&mut self) -> usize {
        let start = self.at;
        while self.at < self.bytes.len() && self.bytes[self.at].is_ascii_digit() {
            self.at += 1;
        }
        self.at - start
    }
    fn number(&mut self) -> Result<Js, Failure> {
        let start = self.at;
        if self.bytes[self.at] == b'-' {
            self.at += 1;
        }
        match self.bytes.get(self.at) {
            Some(b'0') => {
                self.at += 1;
                if self.bytes.get(self.at).is_some_and(u8::is_ascii_digit) {
                    return Err(Failure::At("Unexpected number", self.at));
                }
            }
            Some(b'1'..=b'9') => {
                self.digits();
            }
            _ => return Err(Failure::At("No number after minus sign", self.at)),
        }
        if self.bytes.get(self.at) == Some(&b'.') {
            self.at += 1;
            if self.digits() == 0 {
                return Err(Failure::At("Unterminated fractional number", self.at));
            }
        }
        if matches!(self.bytes.get(self.at), Some(b'e' | b'E')) {
            self.at += 1;
            if matches!(self.bytes.get(self.at), Some(b'+' | b'-')) {
                self.at += 1;
            }
            if self.digits() == 0 {
                return Err(Failure::At("Exponent part is missing a number", self.at));
            }
        }
        Ok(Js::Number(
            self.text[start..self.at].parse::<f64>().unwrap_or(f64::NAN),
        ))
    }
    fn string(&mut self) -> Result<String, Failure> {
        self.at += 1;
        let mut out = String::new();
        let mut units: Vec<u16> = Vec::new();
        loop {
            let Some(&byte) = self.bytes.get(self.at) else {
                return Err(Failure::At("Unterminated string", self.at));
            };
            match byte {
                b'"' => {
                    self.at += 1;
                    flush_units(&mut units, &mut out);
                    return Ok(out);
                }
                b'\\' => {
                    self.at += 1;
                    let Some(&escape) = self.bytes.get(self.at) else {
                        return Err(Failure::End);
                    };
                    if escape == b'u' {
                        let mut unit = 0u16;
                        for offset in 1..=4 {
                            match self.bytes.get(self.at + offset) {
                                Some(digit) if digit.is_ascii_hexdigit() => {
                                    unit =
                                        unit * 16 + (*digit as char).to_digit(16).unwrap() as u16;
                                }
                                _ => {
                                    return Err(Failure::At(
                                        "Bad Unicode escape",
                                        self.at + offset,
                                    ));
                                }
                            }
                        }
                        self.at += 5;
                        units.push(unit);
                        continue;
                    }
                    flush_units(&mut units, &mut out);
                    out.push(match escape {
                        b'"' => '"',
                        b'\\' => '\\',
                        b'/' => '/',
                        b'b' => '\u{08}',
                        b'f' => '\u{0C}',
                        b'n' => '\n',
                        b'r' => '\r',
                        b't' => '\t',
                        _ => return Err(Failure::At("Bad escaped character", self.at)),
                    });
                    self.at += 1;
                }
                0..=0x1F => {
                    return Err(Failure::At(
                        "Bad control character in string literal",
                        self.at,
                    ));
                }
                _ => {
                    flush_units(&mut units, &mut out);
                    let c = self.text[self.at..].chars().next().unwrap();
                    out.push(c);
                    self.at += c.len_utf8();
                }
            }
        }
    }
}

fn flush_units(units: &mut Vec<u16>, out: &mut String) {
    if !units.is_empty() {
        out.extend(char::decode_utf16(units.drain(..)).map(|c| c.unwrap_or('\u{FFFD}')));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn number_matches_ecmascript() {
        for (text, expected) in [
            (" 0x1F ", 31.0),
            ("\u{a0}12\u{a0}", 12.0),
            ("+.5e1", 5.0),
            ("Infinity", f64::INFINITY),
            ("-Infinity", f64::NEG_INFINITY),
            ("0b11", 3.0),
            ("00012", 12.0),
            ("", 0.0),
            ("  ", 0.0),
            ("5.", 5.0),
            ("1e3", 1000.0),
        ] {
            assert_eq!(to_number(text), expected, "{text:?}");
        }
        for text in [
            "1_0", "12\u{85}", ".", "-0x5", "infinity", "1e", "-", "+", "inf", "nan", "0x", "1,0",
        ] {
            assert!(to_number(text).is_nan(), "{text:?}");
        }
        assert!(to_number("-0").is_sign_negative());
        assert_eq!(numeric(None, 3.0), 3.0);
        assert_eq!(numeric(Some(""), 3.0), 0.0);
    }

    #[test]
    fn objects_order_like_javascript() {
        let value = parse_json(r#"{"b":1,"10":2,"a":{"2":0,"1":0},"b":3,"01":4}"#).unwrap();
        assert_eq!(
            value.stringify(),
            r#"{"10":2,"b":3,"a":{"1":0,"2":0},"01":4}"#
        );
        let mut map = JsMap::new();
        map.insert("x".into(), 1);
        map.insert("7".into(), 2);
        map.insert("3".into(), 3);
        map.remove("x");
        map.insert("x".into(), 4);
        assert_eq!(map.keys(), ["3", "7", "x"]);
        assert_eq!(slice_utf16("ab   ", 2), "   ");
    }

    #[test]
    fn json_errors_match_v8() {
        for (text, message) in [
            ("", "Unexpected end of JSON input"),
            (" ", "Unexpected end of JSON input"),
            (
                "{",
                "Expected property name or '}' in JSON at position 1 (line 1 column 2)",
            ),
            ("[", "Unexpected end of JSON input"),
            (
                "{\"a\"",
                "Expected ':' after property name in JSON at position 4 (line 1 column 5)",
            ),
            ("{\"a\":", "Unexpected end of JSON input"),
            (
                "{\"a\":1",
                "Expected ',' or '}' after property value in JSON at position 6 (line 1 column 7)",
            ),
            (
                "{\"a\":1,",
                "Expected double-quoted property name in JSON at position 7 (line 1 column 8)",
            ),
            (
                "{\"a\" 1}",
                "Expected ':' after property name in JSON at position 5 (line 1 column 6)",
            ),
            (
                "{a:1}",
                "Expected property name or '}' in JSON at position 1 (line 1 column 2)",
            ),
            (
                "{\"a\":1,}",
                "Expected double-quoted property name in JSON at position 7 (line 1 column 8)",
            ),
            ("[1,]", "Unexpected token ']', \"[1,]\" is not valid JSON"),
            (
                "[1 2]",
                "Expected ',' or ']' after array element in JSON at position 3 (line 1 column 4)",
            ),
            (
                "[1",
                "Expected ',' or ']' after array element in JSON at position 2 (line 1 column 3)",
            ),
            (
                "\"abc",
                "Unterminated string in JSON at position 4 (line 1 column 5)",
            ),
            (
                "\"a\u{0001}b\"",
                "Bad control character in string literal in JSON at position 2 (line 1 column 3)",
            ),
            (
                "\"\\x\"",
                "Bad escaped character in JSON at position 2 (line 1 column 3)",
            ),
            (
                "\"\\u12G4\"",
                "Bad Unicode escape in JSON at position 5 (line 1 column 6)",
            ),
            (
                "-",
                "No number after minus sign in JSON at position 1 (line 1 column 2)",
            ),
            (
                "-a",
                "No number after minus sign in JSON at position 1 (line 1 column 2)",
            ),
            (
                "1.",
                "Unterminated fractional number in JSON at position 2 (line 1 column 3)",
            ),
            (
                "1.e5",
                "Unterminated fractional number in JSON at position 2 (line 1 column 3)",
            ),
            (
                "1e",
                "Exponent part is missing a number in JSON at position 2 (line 1 column 3)",
            ),
            (
                "1e+",
                "Exponent part is missing a number in JSON at position 3 (line 1 column 4)",
            ),
            (
                "01",
                "Unexpected number in JSON at position 1 (line 1 column 2)",
            ),
            ("tru", "Unexpected end of JSON input"),
            ("nul", "Unexpected end of JSON input"),
            ("x", "Unexpected token 'x', \"x\" is not valid JSON"),
            (
                "{\"a\":x}",
                "Unexpected token 'x', \"{\"a\":x}\" is not valid JSON",
            ),
            (
                "[1,2,3,4,5,6,7,8,9,10,11,12,13,14,x,16,17,18,19,20,21,22]",
                "Unexpected token 'x', ...\",12,13,14,x,16,17,18\"... is not valid JSON",
            ),
            (
                "xyzxyzxyzxyzxyzxyzxyzxyz",
                "Unexpected token 'x', \"xyzxyzxyzx\"... is not valid JSON",
            ),
            (
                "[1,2,3,4,5,6,7,8,9,10,x]",
                "Unexpected token 'x', ...\",7,8,9,10,x]\" is not valid JSON",
            ),
            (
                "{} x",
                "Unexpected non-whitespace character after JSON at position 3 (line 1 column 4)",
            ),
            (
                "[]]",
                "Unexpected non-whitespace character after JSON at position 2 (line 1 column 3)",
            ),
            (
                "{\"a\":1}}",
                "Unexpected non-whitespace character after JSON at position 7 (line 1 column 8)",
            ),
            (
                "\n\n {\n \"a\": ,\n}",
                "Unexpected token ',', \"\n\n {\n \"a\": ,\n}\" is not valid JSON",
            ),
            (
                "{\"type\":\"FeatureCollection\",\"features\":[}",
                "Unexpected token '}', ...\"eatures\":[}\" is not valid JSON",
            ),
            (
                "\" \"x",
                "Unexpected non-whitespace character after JSON at position 3 (line 1 column 4)",
            ),
            (
                "{\"é\":1 2}",
                "Expected ',' or '}' after property value in JSON at position 7 (line 1 column 8)",
            ),
            (
                "0x10",
                "Unexpected non-whitespace character after JSON at position 1 (line 1 column 2)",
            ),
            ("Infinity", "\"Infinity\" is not valid JSON"),
            (
                "[-]",
                "No number after minus sign in JSON at position 2 (line 1 column 3)",
            ),
            (
                "{\"a\":\"\\u\"}",
                "Bad Unicode escape in JSON at position 8 (line 1 column 9)",
            ),
            (
                "\"\\uD834\"x",
                "Unexpected non-whitespace character after JSON at position 8 (line 1 column 9)",
            ),
            ("+1", "Unexpected token '+', \"+1\" is not valid JSON"),
            (".5", "Unexpected token '.', \".5\" is not valid JSON"),
            ("[,1]", "Unexpected token ',', \"[,1]\" is not valid JSON"),
            (
                "{,}",
                "Expected property name or '}' in JSON at position 1 (line 1 column 2)",
            ),
            (
                "{\"a\"::1}",
                "Unexpected token ':', \"{\"a\"::1}\" is not valid JSON",
            ),
            ("trux", "Unexpected token 'x', \"trux\" is not valid JSON"),
            ("nulx", "Unexpected token 'x', \"nulx\" is not valid JSON"),
            ("fals", "Unexpected end of JSON input"),
            ("[tru]", "Unexpected token ']', \"[tru]\" is not valid JSON"),
            (
                "\"a\"b",
                "Unexpected non-whitespace character after JSON at position 3 (line 1 column 4)",
            ),
            (
                "falsey",
                "Unexpected non-whitespace character after JSON at position 5 (line 1 column 6)",
            ),
            (
                "[true false]",
                "Expected ',' or ']' after array element in JSON at position 6 (line 1 column 7)",
            ),
            (
                "{\"a\":tru}",
                "Unexpected token '}', \"{\"a\":tru}\" is not valid JSON",
            ),
            ("NaN", "\"NaN\" is not valid JSON"),
            ("undefined", "\"undefined\" is not valid JSON"),
            ("[object Object]", "\"[object Object]\" is not valid JSON"),
            (
                "abc\ndef",
                "Unexpected token 'a', \"abc\ndef\" is not valid JSON",
            ),
            ("\n\nx", "Unexpected token 'x', \"\n\nx\" is not valid JSON"),
            (
                "{\"a\":\n\n  x}",
                "Unexpected token 'x', \"{\"a\":\n\n  x}\" is not valid JSON",
            ),
            (
                "{\"a\":1}\n\nz",
                "Unexpected non-whitespace character after JSON at position 9 (line 3 column 1)",
            ),
            (
                "[1,2,3,4,5,6,7,8,9,10,11,12]x",
                "Unexpected non-whitespace character after JSON at position 28 (line 1 column 29)",
            ),
            (
                "\"\\u00e9\\uZ\"",
                "Bad Unicode escape in JSON at position 9 (line 1 column 10)",
            ),
            (
                "-01",
                "Unexpected number in JSON at position 2 (line 1 column 3)",
            ),
            (
                "1.5e",
                "Exponent part is missing a number in JSON at position 4 (line 1 column 5)",
            ),
            (
                "[1e5x]",
                "Expected ',' or ']' after array element in JSON at position 4 (line 1 column 5)",
            ),
            (
                "00",
                "Unexpected number in JSON at position 1 (line 1 column 2)",
            ),
            (
                "0.",
                "Unterminated fractional number in JSON at position 2 (line 1 column 3)",
            ),
            (
                "{\"a\":-}",
                "No number after minus sign in JSON at position 6 (line 1 column 7)",
            ),
            ("\"abc\\", "Unexpected end of JSON input"),
            (
                "\"\t\"",
                "Bad control character in string literal in JSON at position 1 (line 1 column 2)",
            ),
            (
                "123abc",
                "Unexpected non-whitespace character after JSON at position 3 (line 1 column 4)",
            ),
            (
                "[1.2.3]",
                "Expected ',' or ']' after array element in JSON at position 4 (line 1 column 5)",
            ),
            (
                "{\"a\":[1,2}",
                "Expected ',' or ']' after array element in JSON at position 9 (line 1 column 10)",
            ),
            (
                "{\"a\":{\"b\":}}",
                "Unexpected token '}', \"{\"a\":{\"b\":}}\" is not valid JSON",
            ),
            (" {}", "Unexpected token ' ', \" {}\" is not valid JSON"),
        ] {
            assert_eq!(parse_json(text).unwrap_err(), message, "{text:?}");
        }
    }
}
