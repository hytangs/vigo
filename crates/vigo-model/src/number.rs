//! Public JSON numbers.

use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::borrow::Cow;

/// Largest integer every JSON reader can hold exactly (2^53 − 1).
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// A JSON number in VIGO's public form.
///
/// VIGO writes an integral value without a fractional part, so `1200.0` is
/// written `1200` and every runtime produces the same bytes for the same value.
/// Reading accepts either form.
#[derive(Clone, Copy, Debug, Default, PartialEq, PartialOrd)]
pub struct Number(pub f64);

impl Number {
    pub fn get(self) -> f64 {
        self.0
    }
}

impl From<f64> for Number {
    fn from(value: f64) -> Self {
        Self(value)
    }
}

impl From<Number> for f64 {
    fn from(value: Number) -> Self {
        value.0
    }
}

impl Serialize for Number {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let value = self.0;
        if value.is_finite() && value.fract() == 0.0 && value.abs() <= MAX_SAFE_INTEGER {
            serializer.serialize_i64(value as i64)
        } else {
            serializer.serialize_f64(value)
        }
    }
}

impl<'de> Deserialize<'de> for Number {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        f64::deserialize(deserializer).map(Self)
    }
}

impl JsonSchema for Number {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        "Number".into()
    }

    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        json_schema!({ "type": "number" })
    }
}

#[cfg(test)]
mod tests {
    use super::Number;

    #[test]
    fn integral_values_drop_the_fraction() {
        let written = serde_json::to_string(&[1200.0, 0.5, -0.0, 1e300].map(Number)).unwrap();
        assert_eq!(written, "[1200,0.5,0,1e+300]");
        let read: Vec<Number> = serde_json::from_str("[1200,1200.0,0.5]").unwrap();
        assert_eq!(read, [1200.0, 1200.0, 0.5].map(Number));
    }
}
