//! Values shared by requests and Results.

use crate::Number;
use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::borrow::Cow;

/// `[longitude, latitude]` in WGS84 degrees.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Coordinate(pub [Number; 2]);

impl Coordinate {
    pub fn new(longitude: f64, latitude: f64) -> Self {
        Self([Number(longitude), Number(latitude)])
    }

    pub fn longitude(self) -> f64 {
        self.0[0].0
    }

    pub fn latitude(self) -> f64 {
        self.0[1].0
    }
}

impl JsonSchema for Coordinate {
    fn schema_name() -> Cow<'static, str> {
        "Coordinate".into()
    }

    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "description": "`[longitude, latitude]` in WGS84 degrees.",
            "type": "array",
            "prefixItems": [
                { "type": "number", "minimum": -180, "maximum": 180 },
                { "type": "number", "minimum": -90, "maximum": 90 },
            ],
            "items": false,
            "minItems": 2,
            "maxItems": 2,
        })
    }
}

/// `[west, south, east, north]` in WGS84 degrees.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Bounds(pub [Number; 4]);

impl JsonSchema for Bounds {
    fn schema_name() -> Cow<'static, str> {
        "Bounds".into()
    }

    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "description": "`[west, south, east, north]` in WGS84 degrees.",
            "type": "array",
            "prefixItems": [{ "type": "number" }, { "type": "number" }, { "type": "number" }, { "type": "number" }],
            "items": false,
            "minItems": 4,
            "maxItems": 4,
        })
    }
}

/// Reads an optional request field that may be omitted but not sent as
/// `null`, as the engine requires.
pub(crate) fn present<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(deserializer).map(Some)
}

/// A field that can be absent, present as `null`, or present with a value.
///
/// Use it with `#[serde(default, skip_serializing_if = "Maybe::is_absent")]`
/// where VIGO distinguishes the three, so a value round-trips unchanged.
#[derive(Clone, Debug, Default, PartialEq)]
pub enum Maybe<T> {
    #[default]
    Absent,
    Null,
    Value(T),
}

impl<T> Maybe<T> {
    pub fn is_absent(&self) -> bool {
        matches!(self, Self::Absent)
    }

    pub fn as_option(&self) -> Option<&T> {
        match self {
            Self::Value(value) => Some(value),
            Self::Absent | Self::Null => None,
        }
    }
}

impl<T: Serialize> Serialize for Maybe<T> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Value(value) => value.serialize(serializer),
            Self::Absent | Self::Null => serializer.serialize_none(),
        }
    }
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for Maybe<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Ok(Option::<T>::deserialize(deserializer)?.map_or(Self::Null, Self::Value))
    }
}

impl<T: JsonSchema> JsonSchema for Maybe<T> {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        <Option<T>>::schema_name()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        let mut schema = <Option<T>>::json_schema(generator);
        // Lets Result schemas keep `null` here while dropping it from fields
        // that are only ever omitted; see `schema::absent_not_null`.
        schema.insert(crate::schema::TRI_STATE.into(), true.into());
        schema
    }
}

/// A feed-scoped GTFS identifier, such as a stop, route, trip or service.
/// `feed` is `null` in a City built from a single unscoped feed.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Identifier {
    pub feed: Option<String>,
    pub id: String,
}

/// A service-day clock: `HH:MM` or `HH:MM:SS` (hours may exceed 23), or minutes
/// after the start of the service day.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum Clock {
    Text(String),
    Minutes(Number),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Transit,
    Walk,
    Drive,
}

/// Reach covers transit, walking, and driving travel times.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ReachMode {
    Transit,
    Walk,
    Drive,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum DataMode {
    Scheduled,
    Realtime,
}

/// The time preference a Result reports, after aliases are resolved.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TimePreference {
    DepartAt,
    ArriveBy,
}

/// A GeoJSON `LineString`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename = "LineString")]
#[schemars(rename = "LineString", transform = crate::schema::type_tag("LineString"))]
pub struct LineString {
    pub coordinates: Vec<Coordinate>,
}
