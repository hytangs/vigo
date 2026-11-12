//! Bicycle profile, weekly conditions and traffic stress (bike-profile.mjs,
//! bike-conditions.mjs, bike-stress.mjs).

use crate::jsrt::{self, is_space, norm_opt, string_to_number, trim};
use crate::rules::{self, Directions};
use crate::store::NodeLookup;
use crate::tags::Tags;
use crate::{Error, Result};
use rusqlite::{Connection, params};
use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use vigo_format::js::Js;
use vigo_format::js_math;

const WEEK: i32 = 7 * 1440;
const WEEKDAYS: [&str; 7] = ["mo", "tu", "we", "th", "fr", "sa", "su"];
const ALLOWED: [&str; 6] = [
    "yes",
    "designated",
    "official",
    "permissive",
    "destination",
    "optional_sidepath",
];
const DENIED: [&str; 7] = [
    "no",
    "private",
    "agricultural",
    "forestry",
    "customers",
    "delivery",
    "use_sidepath",
];
const ROADS: [&str; 15] = [
    "cycleway",
    "residential",
    "living_street",
    "unclassified",
    "service",
    "tertiary",
    "tertiary_link",
    "secondary",
    "secondary_link",
    "primary",
    "primary_link",
    "trunk",
    "trunk_link",
    "track",
    "path",
];

fn allowed(value: &str) -> bool {
    ALLOWED.contains(&value)
}

fn denied(value: &str) -> bool {
    DENIED.contains(&value)
}

fn tag<'a>(tags: &Tags<'a>, key: &str) -> Cow<'a, str> {
    norm_opt(tags.get(key))
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Direction {
    Forward,
    Backward,
}

impl Direction {
    fn name(self) -> &'static str {
        match self {
            Direction::Forward => "forward",
            Direction::Backward => "backward",
        }
    }
    const BOTH: [Direction; 2] = [Direction::Forward, Direction::Backward];
}

/// `${prefix}:${direction}` without allocating for the tag keys in use.
fn directional(prefix: &str, direction: Direction) -> std::borrow::Cow<'static, str> {
    use Direction::{Backward, Forward};
    std::borrow::Cow::Borrowed(match (prefix, direction) {
        ("bicycle", Forward) => "bicycle:forward",
        ("bicycle", Backward) => "bicycle:backward",
        ("vehicle", Forward) => "vehicle:forward",
        ("vehicle", Backward) => "vehicle:backward",
        ("access", Forward) => "access:forward",
        ("access", Backward) => "access:backward",
        ("cycleway", Forward) => "cycleway:forward",
        ("cycleway", Backward) => "cycleway:backward",
        ("lts", Forward) => "lts:forward",
        ("lts", Backward) => "lts:backward",
        ("maxspeed", Forward) => "maxspeed:forward",
        ("maxspeed", Backward) => "maxspeed:backward",
        ("foot", Forward) => "foot:forward",
        ("foot", Backward) => "foot:backward",
        _ => return std::borrow::Cow::Owned(format!("{prefix}:{}", direction.name())),
    })
}

/// `${key}:conditional` for the keys the bicycle rules read.
fn conditional_key(key: &str) -> std::borrow::Cow<'static, str> {
    std::borrow::Cow::Borrowed(match key {
        "bicycle" => "bicycle:conditional",
        "bicycle:forward" => "bicycle:forward:conditional",
        "bicycle:backward" => "bicycle:backward:conditional",
        "vehicle" => "vehicle:conditional",
        "vehicle:forward" => "vehicle:forward:conditional",
        "vehicle:backward" => "vehicle:backward:conditional",
        "access" => "access:conditional",
        "access:forward" => "access:forward:conditional",
        "access:backward" => "access:backward:conditional",
        "foot" => "foot:conditional",
        "foot:forward" => "foot:forward:conditional",
        "foot:backward" => "foot:backward:conditional",
        "oneway" => "oneway:conditional",
        "oneway:bicycle" => "oneway:bicycle:conditional",
        _ => return std::borrow::Cow::Owned(format!("{key}:conditional")),
    })
}

fn pick(directions: Directions, direction: Direction) -> bool {
    match direction {
        Direction::Forward => directions.forward,
        Direction::Backward => directions.backward,
    }
}

fn clear(directions: &mut Directions, direction: Direction) {
    match direction {
        Direction::Forward => directions.forward = false,
        Direction::Backward => directions.backward = false,
    }
}

/// `access(tags, direction)`.
fn access<'a>(tags: &Tags<'a>, direction: Option<Direction>) -> Cow<'a, str> {
    for key in ["bicycle", "vehicle", "access"] {
        let value = match direction {
            Some(direction) => tags.get(&directional(key, direction)).or(tags.get(key)),
            None => tags.get(key),
        };
        let value = norm_opt(value);
        if !value.is_empty() {
            return value;
        }
    }
    Cow::Borrowed("")
}

fn conditional_access(tags: &Tags, direction: Direction) -> bool {
    for mode in ["bicycle", "vehicle", "access"] {
        for key in [
            directional(mode, direction),
            std::borrow::Cow::Borrowed(mode),
        ] {
            if tags.truthy(&conditional_key(&key)) {
                return true;
            }
            if !norm_opt(tags.get(&key)).is_empty() {
                return false;
            }
        }
    }
    false
}

/// `bikeFacility(tags, direction, comfort)`: 0 none, 1 lane, 2 track.
pub fn facility(tags: &Tags, direction: Direction, comfort: bool) -> i32 {
    let kind = |value: &str| match value {
        "track" | "opposite_track" => 2,
        "lane" | "opposite_lane" => 1,
        "shared_lane" if comfort => 1,
        _ => 0,
    };
    let specific = tag(tags, &directional("cycleway", direction));
    if !specific.is_empty() {
        return kind(&specific);
    }
    let oneway = tag(tags, "oneway");
    let road_one: Cow<str> = if !oneway.is_empty() {
        oneway
    } else if tag(tags, "junction") == "roundabout" {
        Cow::Borrowed("yes")
    } else {
        Cow::Borrowed("")
    };
    let flow = if road_one == "-1" {
        Some(Direction::Backward)
    } else if ["yes", "1", "true"].contains(&road_one.as_ref()) {
        Some(Direction::Forward)
    } else {
        None
    };
    let opposite = if road_one == "-1" {
        Direction::Forward
    } else {
        Direction::Backward
    };
    let generic = tag(tags, "cycleway");
    let both = tag(tags, "cycleway:both");
    if both.is_empty()
        && tag(tags, "cycleway:left").is_empty()
        && tag(tags, "cycleway:right").is_empty()
    {
        let mapped = if generic.starts_with("opposite") {
            Some(opposite)
        } else {
            flow
        };
        return if mapped.is_none_or(|mapped| mapped == direction) {
            kind(&generic)
        } else {
            0
        };
    }
    let mut result = 0;
    for side in ["left", "right"] {
        let value = norm_opt(
            tags.get(&format!("cycleway:{side}"))
                .or(tags.get("cycleway:both"))
                .or(tags.get("cycleway")),
        );
        let level = kind(&value);
        if level == 0 {
            continue;
        }
        let one = norm_opt(
            tags.get(&format!("cycleway:{side}:oneway"))
                .or(tags.get("cycleway:both:oneway")),
        );
        let driving_side = tag(tags, "driving_side");
        let mapped = if ["no", "0", "false"].contains(&one.as_ref()) {
            None
        } else if ["yes", "1", "true"].contains(&one.as_ref()) {
            Some(Direction::Forward)
        } else if one == "-1" {
            Some(Direction::Backward)
        } else if !one.is_empty() {
            continue;
        } else if value.starts_with("opposite") {
            Some(opposite)
        } else if flow.is_some() {
            flow
        } else if driving_side == "left" || driving_side == "right" {
            Some(if side == driving_side {
                Direction::Forward
            } else {
                Direction::Backward
            })
        } else if !both.is_empty()
            && tag(tags, "cycleway:left").is_empty()
            && tag(tags, "cycleway:right").is_empty()
            && !tags.truthy("cycleway:left:oneway")
            && !tags.truthy("cycleway:right:oneway")
        {
            None
        } else {
            if comfort {
                result = result.max(1);
            }
            continue;
        };
        if mapped.is_none_or(|mapped| mapped == direction) {
            result = result.max(level);
        }
    }
    result
}

/// `bikeStress(tags, direction, allowsCars)`: LTS in bits 0..2, bit 4 when supplied.
pub fn stress(tags: &Tags, direction: Direction, allows_cars: bool) -> Result<i32> {
    let supplied = tags.get(&directional("lts", direction)).or(tags.get("lts"));
    if let Some(supplied) = supplied {
        let level = string_to_number(supplied);
        if trim(supplied).is_empty() || !jsrt::is_integer(level) || !(1.0..=4.0).contains(&level) {
            return Err(Error::new(format!(
                "Bicycle lts must be an integer from 1 to 4; received {supplied}"
            )));
        }
        return Ok(level as i32 | 16);
    }
    let highway = tag(tags, "highway");
    if !allows_cars {
        return Ok(1);
    }
    let raw = norm_opt(
        tags.get(&directional("maxspeed", direction))
            .or(tags.get("maxspeed")),
    );
    let speed = match rules::leading_decimal(&raw) {
        Some(digits) => {
            let unit = raw[digits.len()..].trim_start_matches(is_space);
            let scale = match unit {
                "" | "km/h" | "kmh" | "kph" => Some(1.0),
                "mph" => Some(1.609344),
                "knots" => Some(1.852),
                _ => None,
            };
            scale.map_or(f64::NAN, |scale| string_to_number(digits) * scale)
        }
        None => f64::NAN,
    };
    let raw_lanes = tag(tags, "lanes");
    let lanes = if !raw_lanes.is_empty()
        && raw_lanes.as_bytes()[0] != b'0'
        && raw_lanes.bytes().all(|b| b.is_ascii_digit())
    {
        string_to_number(&raw_lanes)
    } else {
        f64::INFINITY
    };
    let few_lanes = lanes <= 3.0 || !lanes.is_finite();
    if ["residential", "living_street", "service"].contains(&highway.as_ref())
        && speed.partial_cmp(&40.25) != Some(std::cmp::Ordering::Greater)
        && few_lanes
    {
        return Ok(1);
    }
    let small_slow = speed <= 40.25 && few_lanes;
    let has_lane = facility(tags, direction, false) > 0;
    if ["unclassified", "tertiary", "tertiary_link"].contains(&highway.as_ref()) {
        return Ok(
            if has_lane || small_slow || (lanes <= 3.0 && speed.is_nan()) {
                2
            } else {
                3
            },
        );
    }
    Ok(if has_lane {
        if small_slow { 2 } else { 3 }
    } else {
        4
    })
}

/// `bikeDirections(tags)`.
pub fn directions(tags: &Tags) -> Directions {
    let none = Directions::default();
    let highway = tag(tags, "highway");
    let bicycle = tag(tags, "bicycle");
    let explicit = [
        bicycle.clone(),
        tag(tags, "bicycle:forward"),
        tag(tags, "bicycle:backward"),
    ]
    .iter()
    .any(|value| allowed(value) || value == "dismount");
    if highway.is_empty()
        || ["construction", "proposed", "abandoned", "razed"].contains(&highway.as_ref())
        || tag(tags, "area") == "yes"
        || (!ROADS.contains(&highway.as_ref()) && !explicit)
        || (tag(tags, "motorroad") == "yes" && !explicit)
        || ["impassable", "very_horrible"].contains(&tag(tags, "smoothness").as_ref())
    {
        return none;
    }
    let oneway_bicycle = tags.get("oneway:bicycle");
    if tags.truthy("oneway:bicycle:conditional")
        || (oneway_bicycle.is_none() && tags.truthy("oneway:conditional"))
    {
        return none;
    }
    let mut one = norm_opt(oneway_bicycle.or(tags.get("oneway")));
    if one.is_empty() && tag(tags, "junction") == "roundabout" {
        one = Cow::Borrowed("yes");
    }
    if one == "reversible" || one == "alternating" {
        return none;
    }
    let mut result = Directions {
        forward: one != "-1",
        backward: !["yes", "1", "true"].contains(&one.as_ref()),
    };
    if oneway_bicycle.is_none() {
        let unmarked_opposite = [
            "cycleway",
            "cycleway:left",
            "cycleway:right",
            "cycleway:both",
        ]
        .iter()
        .any(|key| tag(tags, key) == "opposite");
        result.forward =
            result.forward || unmarked_opposite || facility(tags, Direction::Forward, false) > 0;
        result.backward =
            result.backward || unmarked_opposite || facility(tags, Direction::Backward, false) > 0;
        if allowed(&tag(tags, "bicycle:forward")) {
            result.forward = true;
        }
        if allowed(&tag(tags, "bicycle:backward")) {
            result.backward = true;
        }
    }
    if denied(&access(tags, Some(Direction::Forward))) {
        result.forward = false;
    }
    if denied(&access(tags, Some(Direction::Backward))) {
        result.backward = false;
    }
    for direction in Direction::BOTH {
        let specific = norm_opt(
            tags.get(&directional("bicycle", direction))
                .or(tags.get("bicycle")),
        );
        let conditional = conditional_access(tags, direction);
        let foot = norm_opt(
            tags.get(&directional("foot", direction))
                .or(tags.get("foot")),
        );
        let foot_conditional = tags.truthy(&conditional_key(&directional("foot", direction)))
            || (tags.get(&directional("foot", direction)).is_none()
                && tags.truthy("foot:conditional"));
        let explicit_direction = allowed(&specific) || specific == "dismount";
        if conditional
            || ((!ROADS.contains(&highway.as_ref()) || tag(tags, "motorroad") == "yes")
                && !explicit_direction)
            || ((specific == "dismount" || highway == "steps")
                && (denied(&foot) || foot_conditional))
        {
            clear(&mut result, direction);
        }
    }
    result
}

/// `bikeNodeAllowed(tags)`.
pub fn node_allowed(tags: &Tags) -> bool {
    let permit = access(tags, None);
    if denied(&permit)
        || ["yes", "true", "1"].contains(&tag(tags, "locked").as_ref())
        || tags.truthy("locked:conditional")
        || tags.truthy("bicycle:conditional")
        || (tags.truthy("opening_hours") && tag(tags, "opening_hours") != "24/7")
    {
        return false;
    }
    let bicycle = tag(tags, "bicycle");
    if allowed(&bicycle) || bicycle == "dismount" {
        return true;
    }
    if tags.truthy("access:conditional") || tags.truthy("vehicle:conditional") {
        return false;
    }
    ![
        "wall",
        "fence",
        "retaining_wall",
        "block",
        "jersey_barrier",
        "stile",
        "turnstile",
        "full-height_turnstile",
        "kissing_gate",
    ]
    .contains(&tag(tags, "barrier").as_ref())
        || allowed(&permit)
}

/// `/^[-+]?\d+(\.\d+)?%?$/`.
fn numeric_incline(text: &str) -> bool {
    let body = text.strip_suffix('%').unwrap_or(text);
    let body = body.strip_prefix(['-', '+']).unwrap_or(body);
    rules::leading_decimal(body).is_some_and(|digits| digits.len() == body.len())
}

/// `bikeAttributes(tags, direction)`: one packed 32-bit word.
pub fn attributes(tags: &Tags, direction: Direction) -> i32 {
    let highway = tag(tags, "highway");
    let road_class = match highway.as_ref() {
        "cycleway" => 0,
        "path" | "footway" | "pedestrian" | "steps" | "bridleway" => 1,
        "living_street" => 2,
        "residential" | "service" | "unclassified" => 3,
        h if h.starts_with("tertiary") => 4,
        h if h.starts_with("secondary") => 5,
        "track" => 7,
        _ => 6,
    };
    let facility = if highway == "cycleway" {
        2
    } else {
        facility(tags, direction, true)
    };
    let surface = tag(tags, "surface");
    let roughness = match surface.as_ref() {
        "sand" | "mud" | "deep_gravel" => 3,
        "gravel" | "ground" | "dirt" | "earth" | "grass" | "unpaved" | "cobblestone" | "sett" => 2,
        "compacted" | "fine_gravel" | "paving_stones" | "pebblestone" => 1,
        "" if highway == "track" => 2,
        _ => 0,
    };
    let dismount = norm_opt(
        tags.get(&directional("bicycle", direction))
            .or(tags.get("bicycle")),
    ) == "dismount"
        || highway == "steps";
    let raw_incline = tag(tags, "incline");
    let mut incline = if numeric_incline(&raw_incline) {
        string_to_number(&raw_incline.replacen('%', "", 1))
    } else if raw_incline == "up" {
        8.0
    } else if raw_incline == "down" {
        -8.0
    } else {
        0.0
    };
    if direction == Direction::Backward {
        incline = -incline;
    }
    let incline = jsrt::round(jsrt::max(-30.0, jsrt::min(30.0, incline))) + 30.0;
    let raw_speed = norm_opt(
        tags.get(&directional("maxspeed", direction))
            .or(tags.get("maxspeed")),
    );
    let parsed = rules::leading_decimal(&raw_speed).and_then(|digits| {
        let unit = raw_speed[digits.len()..].trim_start_matches(is_space);
        match unit {
            "" | "km/h" | "kph" => Some(string_to_number(digits)),
            "mph" => Some(string_to_number(digits) * 1.609344),
            _ => None,
        }
    });
    let speed =
        parsed.unwrap_or([15.0, 15.0, 10.0, 30.0, 50.0, 60.0, 80.0, 20.0][road_class as usize]);
    let speed = jsrt::round(jsrt::min(140.0, speed)) as i32;
    let destination = access(tags, Some(direction)) == "destination";
    road_class
        | (facility << 3)
        | (roughness << 5)
        | (i32::from(dismount) << 7)
        | ((incline as i32) << 8)
        | (speed.wrapping_shl(14))
        | (i32::from(destination) << 22)
}

fn clock(value: &str, end: bool) -> Option<i32> {
    let bytes = value.as_bytes();
    if bytes.len() != 5
        || bytes[2] != b':'
        || !bytes[..2].iter().chain(&bytes[3..]).all(u8::is_ascii_digit)
    {
        return None;
    }
    let hour = i32::from(bytes[0] - b'0') * 10 + i32::from(bytes[1] - b'0');
    let minute = i32::from(bytes[3] - b'0') * 10 + i32::from(bytes[4] - b'0');
    if minute > 59 || hour > 24 || (hour == 24 && (!end || minute != 0)) {
        return None;
    }
    Some(hour * 60 + minute)
}

fn day_set(value: Option<&str>) -> Option<Vec<i32>> {
    let Some(value) = value.filter(|v| !v.is_empty()) else {
        return Some((0..7).collect());
    };
    let mut result: Vec<i32> = Vec::new();
    for part in value.split(',') {
        let names: Vec<&str> = part.split('-').collect();
        let first = WEEKDAYS.iter().position(|day| *day == names[0]);
        let last = WEEKDAYS
            .iter()
            .position(|day| *day == names[names.len() - 1]);
        let (Some(first), Some(last)) = (first, last) else {
            return None;
        };
        if names.len() > 2 {
            return None;
        }
        let mut day = first;
        loop {
            if !result.contains(&(day as i32)) {
                result.push(day as i32);
            }
            if day == last {
                break;
            }
            day = (day + 1) % 7;
        }
    }
    Some(result)
}

fn day_token(text: &str, at: usize) -> Option<usize> {
    let token = text.get(at..at + 2)?;
    WEEKDAYS.contains(&token).then_some(at + 2)
}

fn day_range(text: &str, at: usize) -> Option<usize> {
    let end = day_token(text, at)?;
    if text[end..].starts_with('-')
        && let Some(after) = day_token(text, end + 1)
    {
        return Some(after);
    }
    Some(end)
}

fn time_range(text: &str, at: usize) -> Option<usize> {
    let bytes = text.as_bytes();
    let pattern = b"dd:dd-dd:dd";
    if bytes.len() < at + pattern.len() {
        return None;
    }
    for (offset, expected) in pattern.iter().enumerate() {
        let byte = bytes[at + offset];
        let ok = if *expected == b'd' {
            byte.is_ascii_digit()
        } else {
            byte == *expected
        };
        if !ok {
            return None;
        }
    }
    Some(at + pattern.len())
}

fn skip_spaces(text: &str, mut at: usize) -> usize {
    while let Some(c) = text[at..].chars().next() {
        if !is_space(c) {
            break;
        }
        at += c.len_utf8();
    }
    at
}

/// `weeklyBikeCondition(input)`: half-open minutes in a Monday-first week.
pub fn weekly_condition(input: &str) -> Option<Vec<(i32, i32)>> {
    let value = trim(input).to_lowercase();
    if value == "24/7" {
        return Some(vec![(0, WEEK)]);
    }
    if value.is_empty() || value.encode_utf16().count() > 2048 || value.contains(';') {
        return None;
    }
    // ^\s*(days)?(?:\s+|(?=\d))?(times)?\s*$
    let mut at = skip_spaces(&value, 0);
    let days_start = at;
    let mut days_end = None;
    if let Some(mut end) = day_range(&value, at) {
        while value[end..].starts_with(',') {
            match day_range(&value, end + 1) {
                Some(next) => end = next,
                None => break,
            }
        }
        days_end = Some(end);
        at = end;
    }
    at = skip_spaces(&value, at);
    let times_start = at;
    let mut times_end = None;
    if let Some(mut end) = time_range(&value, at) {
        while value[end..].starts_with(',') {
            match time_range(&value, end + 1) {
                Some(next) => end = next,
                None => break,
            }
        }
        times_end = Some(end);
        at = end;
    }
    if skip_spaces(&value, at) != value.len() || (days_end.is_none() && times_end.is_none()) {
        return None;
    }
    let days = day_set(days_end.map(|end| &value[days_start..end]))?;
    let times: Vec<(&str, &str)> = match times_end {
        Some(end) => value[times_start..end]
            .split(',')
            .map(|range| range.split_once('-').unwrap_or((range, "")))
            .collect(),
        None => vec![("00:00", "24:00")],
    };
    let mut intervals = Vec::new();
    for (a, b) in times {
        let (Some(start), Some(end)) = (clock(a, false), clock(b, true)) else {
            return None;
        };
        if start == end {
            return None;
        }
        for &day in &days {
            let low = day * 1440 + start;
            let high = day * 1440 + end + if end < start { 1440 } else { 0 };
            if high <= WEEK {
                intervals.push((low, high));
            } else {
                intervals.push((low, WEEK));
                intervals.push((0, high - WEEK));
            }
        }
    }
    if intervals.len() > 128 {
        return None;
    }
    intervals.sort();
    let mut merged: Vec<(i32, i32)> = Vec::new();
    for (start, end) in intervals {
        match merged.last_mut() {
            Some(last) if start <= last.1 => last.1 = last.1.max(end),
            _ => merged.push((start, end)),
        }
    }
    Some(merged)
}

fn clauses(input: &str) -> Option<Vec<&str>> {
    let mut parts = Vec::new();
    let mut depth = 0i32;
    let mut start = 0;
    for (index, byte) in input.bytes().enumerate() {
        match byte {
            b'(' => {
                depth += 1;
                if depth > 1 {
                    return None;
                }
            }
            b')' => {
                depth -= 1;
                if depth < 0 {
                    return None;
                }
            }
            b';' if depth == 0 => {
                parts.push(&input[start..index]);
                start = index + 1;
            }
            _ => {}
        }
    }
    if depth != 0 {
        return None;
    }
    parts.push(&input[start..]);
    (parts.len() <= 32).then_some(parts)
}

/// Ordered `rule -> intervals`, as the JavaScript Map.
pub type WeeklyValues = Vec<(String, Vec<(i32, i32)>)>;

/// `compileWeeklyValues(base, conditional, accepts)`.
pub fn compile_weekly_values(
    base: &str,
    conditional: &str,
    accepts: &dyn Fn(&str) -> bool,
) -> Option<WeeklyValues> {
    if conditional.is_empty()
        || conditional.encode_utf16().count() > 4096
        || (!base.is_empty() && !accepts(base))
    {
        return None;
    }
    let mut parsed: Vec<(&str, Vec<(i32, i32)>)> = Vec::new();
    for part in clauses(conditional)? {
        // /^\s*([a-z_0-9-]+)\s*@\s*(.*?)\s*$/
        let at = skip_spaces(part, 0);
        let rule_length = part[at..]
            .bytes()
            .take_while(|b| {
                b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'_' || *b == b'-'
            })
            .count();
        if rule_length == 0 {
            return None;
        }
        let rule = &part[at..at + rule_length];
        let after = skip_spaces(part, at + rule_length);
        if !part[after..].starts_with('@') {
            return None;
        }
        let rest = &part[skip_spaces(part, after + 1)..];
        let mut expression = rest.trim_end_matches(is_space);
        if expression.contains(['\n', '\r', '\u{2028}', '\u{2029}']) || !accepts(rule) {
            return None;
        }
        if expression.starts_with('(') && expression.ends_with(')') && !expression.is_empty() {
            expression = if expression.len() >= 2 {
                &expression[1..expression.len() - 1]
            } else {
                ""
            };
        }
        parsed.push((rule, weekly_condition(expression)?));
    }
    let mut boundaries = vec![0, WEEK];
    for (_, intervals) in &parsed {
        for (a, b) in intervals {
            boundaries.push(*a);
            boundaries.push(*b);
        }
    }
    boundaries.sort_unstable();
    boundaries.dedup();
    let mut result: WeeklyValues = Vec::new();
    for window in boundaries.windows(2) {
        let (start, end) = (window[0], window[1]);
        let mut rule = base;
        for (candidate, intervals) in &parsed {
            if intervals.iter().any(|(a, b)| *a <= start && start < *b) {
                rule = candidate;
            }
        }
        let index = match result.iter().position(|(name, _)| name == rule) {
            Some(index) => index,
            None => {
                result.push((rule.to_owned(), Vec::new()));
                result.len() - 1
            }
        };
        let intervals = &mut result[index].1;
        match intervals.last_mut() {
            Some(last) if last.1 == start => last.1 = end,
            _ => intervals.push((start, end)),
        }
    }
    if result.iter().any(|(_, intervals)| intervals.len() > 256) {
        return None;
    }
    Some(result)
}

fn turn_rule(value: &str) -> bool {
    value == "none"
        || ["no_", "only_"].iter().any(|prefix| {
            value.strip_prefix(prefix).is_some_and(|rest| {
                !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
            })
        })
}

/// `compileBikeTurnWindows(base, conditional)`.
pub fn compile_turn_windows(base: &str, conditional: &str) -> Option<WeeklyValues> {
    let base = if base.is_empty() { "none" } else { base };
    let mut result = compile_weekly_values(base, conditional, &turn_rule)?;
    result.retain(|(rule, _)| rule != "none");
    Some(result)
}

pub struct Variant {
    pub direction: Direction,
    pub attributes: i32,
    pub stress: Option<i32>,
    pub intervals: Vec<(i32, i32)>,
    window: Option<f64>,
}

type StressFor<'f> = &'f dyn Fn(&Tags, Direction) -> Result<i32>;

/// `bikeWayWindows(tags, stressFor)`.
pub fn way_windows(tags: &Tags, stress_for: Option<StressFor>) -> Result<Vec<Variant>> {
    let mut keys: Vec<String> = vec!["oneway".to_owned(), "oneway:bicycle".to_owned()];
    for mode in ["access", "vehicle", "bicycle", "foot"] {
        keys.push(mode.to_owned());
        keys.push(format!("{mode}:forward"));
        keys.push(format!("{mode}:backward"));
    }
    let mut schedules: Vec<(&str, String, WeeklyValues)> = Vec::new();
    for key in &keys {
        let conditional_key = format!("{key}:conditional");
        if !tags.truthy(&conditional_key) {
            continue;
        }
        let accepts: &dyn Fn(&str) -> bool = if key.starts_with("oneway") {
            &|value: &str| {
                [
                    "yes",
                    "1",
                    "true",
                    "no",
                    "0",
                    "false",
                    "-1",
                    "reversible",
                    "alternating",
                ]
                .contains(&value)
            }
        } else {
            &|value: &str| allowed(value) || denied(value) || value == "dismount"
        };
        if let Some(values) =
            compile_weekly_values(&tag(tags, key), &tag(tags, &conditional_key), accepts)
        {
            schedules.push((key.as_str(), conditional_key, values));
        }
    }
    if schedules.is_empty() {
        return Ok(Vec::new());
    }
    let mut boundaries = vec![0, 10080];
    for (_, _, values) in &schedules {
        for (_, spans) in values {
            for (a, b) in spans {
                boundaries.push(*a);
                boundaries.push(*b);
            }
        }
    }
    boundaries.sort_unstable();
    boundaries.dedup();
    let baseline = directions(tags);
    let mut result: Vec<Variant> = Vec::new();
    for window in boundaries.windows(2) {
        let (start, end) = (window[0], window[1]);
        let mut resolved = tags.clone();
        for (key, conditional_key, values) in &schedules {
            resolved.remove(conditional_key);
            let value = values
                .iter()
                .find(|(_, spans)| spans.iter().any(|(a, b)| *a <= start && start < *b))
                .map(|(value, _)| value.as_str())
                .unwrap_or("");
            if value.is_empty() {
                resolved.remove(key);
            } else {
                resolved.set(key, value);
            }
        }
        let permissions = directions(&resolved);
        for direction in Direction::BOTH {
            if !pick(permissions, direction) {
                continue;
            }
            let attributes = attributes(&resolved, direction);
            let stress = match stress_for {
                Some(stress_for) => Some(stress_for(&resolved, direction)?),
                None => None,
            };
            let index = match result.iter().position(|v| {
                v.direction == direction && v.attributes == attributes && v.stress == stress
            }) {
                Some(index) => index,
                None => {
                    result.push(Variant {
                        direction,
                        attributes,
                        stress,
                        intervals: Vec::new(),
                        window: None,
                    });
                    result.len() - 1
                }
            };
            let intervals = &mut result[index].intervals;
            match intervals.last_mut() {
                Some(last) if last.1 == start => last.1 = end,
                _ => intervals.push((start, end)),
            }
        }
    }
    let mut timed = Vec::new();
    for variant in result {
        let same_as_static = pick(baseline, variant.direction)
            && variant.attributes == attributes(tags, variant.direction)
            && match stress_for {
                None => true,
                Some(stress_for) => variant.stress == Some(stress_for(tags, variant.direction)?),
            }
            && variant.intervals.len() == 1
            && variant.intervals[0] == (0, 10080);
        if !same_as_static {
            timed.push(variant);
        }
    }
    if timed.iter().any(|v| v.intervals.len() > 256) {
        return Ok(Vec::new());
    }
    Ok(timed)
}

/// `createBikeWriter(db, ...)`, writing directly into the street store.
pub struct BikeWriter {
    blocked: HashSet<i64>,
    /// `bike_junction_stress`, applied in memory with the upserts' semantics
    /// and written to its TEMP table before stresses are propagated.
    junctions: HashMap<i64, Junction>,
    /// Nodes already in `bike_nodes`: a repeated `INSERT OR IGNORE` is skipped.
    bike_nodes: HashSet<i64>,
    edge_schedules: HashMap<String, f64>,
    timed_tables: bool,
    turn_window_table: bool,
    edge_count: f64,
    unsupported_restrictions: f64,
    conditional_restrictions: f64,
    timed_edge_count: f64,
    edge_window_count: f64,
    timed_window_count: f64,
}

#[derive(Clone, Copy)]
struct Junction {
    level: i64,
    highest_way: i64,
    other_level: i64,
    signal: i64,
    walk: i64,
}

impl Default for Junction {
    fn default() -> Self {
        Junction {
            level: 1,
            highest_way: 0,
            other_level: 1,
            signal: 0,
            walk: 1,
        }
    }
}

/// `/\b(no_[a-z_]+|only_[a-z_]+)\s*@/g` capture groups, in order.
fn conditional_turn_rules(text: &str) -> Vec<String> {
    let bytes = text.as_bytes();
    let word = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
    let mut rules = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        let boundary = at == 0 || !word(bytes[at - 1]);
        let prefix = if boundary {
            if text[at..].starts_with("no_") {
                Some(3)
            } else if text[at..].starts_with("only_") {
                Some(5)
            } else {
                None
            }
        } else {
            None
        };
        if let Some(prefix) = prefix {
            let body = bytes[at + prefix..]
                .iter()
                .take_while(|b| b.is_ascii_lowercase() || **b == b'_')
                .count();
            if body > 0 {
                let end = at + prefix + body;
                let after = skip_spaces(text, end);
                if text[after..].starts_with('@') {
                    rules.push(text[at..end].to_owned());
                    at = after + 1;
                    continue;
                }
            }
        }
        at += 1;
    }
    rules
}

impl BikeWriter {
    pub fn create(db: &Connection) -> Result<Self> {
        db.execute_batch(
            "CREATE TABLE bike_nodes(node_id INTEGER PRIMARY KEY, lon_e7 INTEGER NOT NULL, lat_e7 INTEGER NOT NULL);
    CREATE TABLE bike_edges(from_node INTEGER NOT NULL, to_node INTEGER NOT NULL, distance_cm INTEGER NOT NULL, way_id INTEGER NOT NULL, attributes INTEGER NOT NULL, stress INTEGER NOT NULL);
    CREATE TEMP TABLE bike_junction_stress(node_id INTEGER PRIMARY KEY, level INTEGER NOT NULL DEFAULT 1,
      highest_way INTEGER NOT NULL DEFAULT 0, other_level INTEGER NOT NULL DEFAULT 1,
      signal INTEGER NOT NULL DEFAULT 0, walk INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE bike_turns(via_node INTEGER NOT NULL, from_way INTEGER NOT NULL, to_way INTEGER NOT NULL, only_turn INTEGER NOT NULL);
    CREATE TABLE bike_way_turns(from_way INTEGER NOT NULL, via_ways TEXT NOT NULL, to_way INTEGER NOT NULL, only_turn INTEGER NOT NULL);",
        )?;
        Ok(Self {
            blocked: HashSet::new(),
            junctions: HashMap::new(),
            bike_nodes: HashSet::new(),
            edge_schedules: HashMap::new(),
            timed_tables: false,
            turn_window_table: false,
            edge_count: 0.0,
            unsupported_restrictions: 0.0,
            conditional_restrictions: 0.0,
            timed_edge_count: 0.0,
            edge_window_count: 0.0,
            timed_window_count: 0.0,
        })
    }

    pub fn node(&mut self, id: i64, tags: &Tags) -> Result<()> {
        if !node_allowed(tags) {
            self.blocked.insert(id);
        }
        let signal =
            tag(tags, "highway") == "traffic_signals" || tag(tags, "crossing") == "traffic_signals";
        let walk = rules::node_walkable(tags);
        if signal || !walk {
            // ON CONFLICT DO UPDATE SET signal=max(signal,excluded.signal),walk=min(walk,excluded.walk)
            let (signal, walk) = (i64::from(signal), i64::from(walk));
            match self.junctions.entry(id) {
                std::collections::hash_map::Entry::Occupied(mut entry) => {
                    let row = entry.get_mut();
                    row.signal = row.signal.max(signal);
                    row.walk = row.walk.min(walk);
                }
                std::collections::hash_map::Entry::Vacant(entry) => {
                    entry.insert(Junction {
                        signal,
                        walk,
                        ..Junction::default()
                    });
                }
            }
        }
        Ok(())
    }

    fn edge_schedule(&mut self, db: &Connection, intervals: &[(i32, i32)]) -> Result<f64> {
        let key = Js::Array(
            intervals
                .iter()
                .map(|(a, b)| Js::from(vec![*a, *b]))
                .collect(),
        )
        .stringify();
        if let Some(id) = self.edge_schedules.get(&key) {
            return Ok(*id);
        }
        if !self.timed_tables {
            db.execute_batch(
                "CREATE TABLE bike_timed_edges(from_node INTEGER NOT NULL, to_node INTEGER NOT NULL, distance_cm INTEGER NOT NULL, way_id INTEGER NOT NULL, attributes INTEGER NOT NULL, window_id INTEGER NOT NULL, stress INTEGER NOT NULL);
        CREATE TABLE bike_edge_windows(window_id INTEGER NOT NULL, start_minute INTEGER NOT NULL, end_minute INTEGER NOT NULL);",
            )?;
            self.timed_tables = true;
        }
        let id = (self.edge_schedules.len() + 1) as f64;
        self.edge_schedules.insert(key, id);
        let mut insert = db.prepare_cached("INSERT INTO bike_edge_windows VALUES(?,?,?)")?;
        for (start, end) in intervals {
            insert.execute(params![id, f64::from(*start), f64::from(*end)])?;
            self.edge_window_count += 1.0;
        }
        Ok(id)
    }

    pub fn way(
        &mut self,
        db: &Connection,
        id: i64,
        tags: &Tags,
        refs: &[i64],
        nodes: &dyn NodeLookup,
    ) -> Result<()> {
        let stress_for = |resolved: &Tags, direction: Direction| -> Result<i32> {
            let level = stress(resolved, direction, rules::drivable(resolved))?;
            let mut foot = resolved.clone();
            match resolved
                .get(&directional("foot", direction))
                .or(resolved.get("foot"))
            {
                Some(value) => foot.set("foot", value),
                None => foot.remove("foot"),
            }
            let walk = !resolved.truthy("foot:conditional")
                && !resolved.truthy(&conditional_key(&directional("foot", direction)))
                && !(tag(resolved, "motorroad") == "yes" && !allowed(&tag(&foot, "foot")))
                && rules::way_walkable(&foot, refs)
                && pick(rules::walk_directions(resolved), direction);
            Ok(level | (i32::from(walk) << 3))
        };
        let forward_stress = stress_for(tags, Direction::Forward)?;
        let backward_stress = stress_for(tags, Direction::Backward)?;
        let level = (forward_stress & 7).max(backward_stress & 7);
        if tags.truthy("highway") && tag(tags, "area") != "yes" && level > 1 {
            let (level, way) = (i64::from(level), id);
            for reference in refs {
                match self.junctions.entry(*reference) {
                    std::collections::hash_map::Entry::Occupied(mut entry) => {
                        // SET expressions all read the row's previous values.
                        let old = *entry.get();
                        let row = entry.get_mut();
                        row.other_level = if old.highest_way == way {
                            old.other_level
                        } else {
                            old.other_level.max(old.level.min(level))
                        };
                        row.highest_way = if level > old.level {
                            way
                        } else {
                            old.highest_way
                        };
                        row.level = old.level.max(level);
                    }
                    std::collections::hash_map::Entry::Vacant(entry) => {
                        entry.insert(Junction {
                            level,
                            highest_way: way,
                            ..Junction::default()
                        });
                    }
                }
            }
        }
        let mut permitted = directions(tags);
        let mut timed = way_windows(tags, Some(&stress_for))?;
        for variant in &timed {
            clear(&mut permitted, variant.direction);
        }
        if !permitted.any() && timed.is_empty() {
            return Ok(());
        }
        let forward = attributes(tags, Direction::Forward);
        let backward = attributes(tags, Direction::Backward);
        let mut previous: Option<(i64, f64, f64)> = None;
        for &node_id in refs {
            let point = if self.blocked.contains(&node_id) {
                None
            } else {
                nodes.get(node_id)
            };
            if let (Some((previous_id, previous_lat, previous_lon)), Some((lat, lon))) =
                (previous, point)
            {
                let rad = std::f64::consts::PI / 180.0;
                let s1 = js_math::sin((lat - previous_lat) * rad / 2.0);
                let s2 = js_math::sin((lon - previous_lon) * rad / 2.0);
                let a = s1 * s1
                    + js_math::cos(previous_lat * rad) * js_math::cos(lat * rad) * (s2 * s2);
                let cm = (2.0 * 6371008.8 * js_math::asin(jsrt::min(1.0, a.sqrt())) * 100.0).ceil();
                if cm > 0.0 && cm <= 4_294_967_295.0 {
                    for (id, lon, lat) in [
                        (previous_id, previous_lon, previous_lat),
                        (node_id, lon, lat),
                    ] {
                        if self.bike_nodes.insert(id) {
                            db.prepare_cached("INSERT OR IGNORE INTO bike_nodes VALUES(?,?,?)")?
                                .execute(params![
                                    id as f64,
                                    jsrt::round(lon * 1e7),
                                    jsrt::round(lat * 1e7)
                                ])?;
                        }
                    }
                    let mut edge =
                        db.prepare_cached("INSERT INTO bike_edges VALUES(?,?,?,?,?,?)")?;
                    if permitted.forward {
                        edge.execute(params![
                            previous_id as f64,
                            node_id as f64,
                            cm,
                            id as f64,
                            f64::from(forward),
                            f64::from(forward_stress)
                        ])?;
                        self.edge_count += 1.0;
                    }
                    if permitted.backward {
                        edge.execute(params![
                            node_id as f64,
                            previous_id as f64,
                            cm,
                            id as f64,
                            f64::from(backward),
                            f64::from(backward_stress)
                        ])?;
                        self.edge_count += 1.0;
                    }
                    drop(edge);
                    for variant in &mut timed {
                        let (from, to) = match variant.direction {
                            Direction::Forward => (previous_id, node_id),
                            Direction::Backward => (node_id, previous_id),
                        };
                        let window = match variant.window {
                            Some(window) => window,
                            None => {
                                let window = self.edge_schedule(db, &variant.intervals)?;
                                variant.window = Some(window);
                                window
                            }
                        };
                        db.prepare_cached("INSERT INTO bike_timed_edges VALUES(?,?,?,?,?,?,?)")?
                            .execute(params![
                                from as f64,
                                to as f64,
                                cm,
                                id as f64,
                                f64::from(variant.attributes),
                                window,
                                variant.stress.map(f64::from)
                            ])?;
                        self.timed_edge_count += 1.0;
                    }
                }
            }
            previous = point.map(|(lat, lon)| (node_id, lat, lon));
        }
        Ok(())
    }

    fn windows(
        &mut self,
        db: &Connection,
        kind: f64,
        row: i64,
        intervals: Option<&Vec<(i32, i32)>>,
    ) -> Result<()> {
        let Some(intervals) = intervals else {
            return Ok(());
        };
        if intervals.len() == 1 && intervals[0] == (0, 10080) {
            return Ok(());
        }
        if !self.turn_window_table {
            db.execute_batch("CREATE TABLE bike_turn_windows(turn_table INTEGER NOT NULL, turn_row INTEGER NOT NULL, start_minute INTEGER NOT NULL, end_minute INTEGER NOT NULL);")?;
            self.turn_window_table = true;
        }
        let mut insert = db.prepare_cached("INSERT INTO bike_turn_windows VALUES(?,?,?,?)")?;
        for (start, end) in intervals {
            insert.execute(params![
                kind,
                row as f64,
                f64::from(*start),
                f64::from(*end)
            ])?;
            self.timed_window_count += 1.0;
        }
        Ok(())
    }

    pub fn relation(
        &mut self,
        db: &Connection,
        block: &crate::pbf::Block,
        relation: &crate::pbf::Relation,
        tags: &Tags,
    ) -> Result<()> {
        if tag(tags, "type") != "restriction" {
            return Ok(());
        }
        let except = tag(tags, "except")
            .split(';')
            .map(trim)
            .any(|value| value == "bicycle");
        let specific = tags.get("restriction:bicycle");
        let specific_conditional = tag(tags, "restriction:bicycle:conditional");
        if specific.is_none() && specific_conditional.is_empty() && except {
            return Ok(());
        }
        let rule = norm_opt(specific.or(if except {
            Some("")
        } else {
            tags.get("restriction")
        }))
        .into_owned();
        let generic_conditional = if specific.is_none() && !except {
            tag(tags, "restriction:conditional")
        } else {
            Cow::Borrowed("")
        };
        let conditional = if specific_conditional.is_empty() {
            generic_conditional.clone()
        } else {
            specific_conditional.clone()
        };
        let combined = !specific_conditional.is_empty() && !generic_conditional.is_empty();
        let text = if combined {
            format!("{generic_conditional}; {specific_conditional}")
        } else {
            conditional.to_string()
        };
        let conditional_rules = conditional_turn_rules(&text);
        self.conditional_restrictions += conditional_rules.len() as f64;
        let compiled = if combined {
            None
        } else {
            compile_turn_windows(&rule, &conditional)
        };
        let rule_list: Vec<String> = match &compiled {
            Some(compiled) => compiled.iter().map(|(rule, _)| rule.clone()).collect(),
            None => {
                let mut unique: Vec<String> = Vec::new();
                for candidate in std::iter::once(&rule).chain(conditional_rules.iter()) {
                    if !unique.contains(candidate) {
                        unique.push(candidate.clone());
                    }
                }
                unique
                    .into_iter()
                    .filter(|r| r.starts_with("no_") || r.starts_with("only_"))
                    .collect()
            }
        };
        if rule_list.is_empty() {
            return Ok(());
        }
        let role = |index: usize| block.string(relation.roles[index]);
        let from: Vec<i64> = (0..relation.refs.len())
            .filter(|&i| role(i) == Some("from") && relation.types[i] == 1)
            .map(|i| relation.refs[i])
            .collect();
        let to: Vec<i64> = (0..relation.refs.len())
            .filter(|&i| role(i) == Some("to") && relation.types[i] == 1)
            .map(|i| relation.refs[i])
            .collect();
        let via: Vec<(i64, u32)> = (0..relation.refs.len())
            .filter(|&i| role(i) == Some("via"))
            .map(|i| (relation.refs[i], relation.types[i]))
            .collect();
        if from.is_empty() || to.is_empty() || via.is_empty() || from.len() * to.len() > 256 {
            self.unsupported_restrictions += 1.0;
            return Ok(());
        }
        for rule in &rule_list {
            if (from.len() > 1 && rule != "no_entry") || (to.len() > 1 && rule != "no_exit") {
                self.unsupported_restrictions += 1.0;
                continue;
            }
            let intervals = compiled.as_ref().and_then(|compiled| {
                compiled
                    .iter()
                    .find(|(name, _)| name == rule)
                    .map(|(_, v)| v)
            });
            let only = rule.starts_with("only_");
            let conditional_only = only && conditional_rules.contains(rule);
            for &source in &from {
                for &target in &to {
                    if via.iter().all(|(_, kind)| *kind == 1) && via.len() <= 16 {
                        let via_ways =
                            Js::Array(via.iter().map(|(id, _)| Js::Number(*id as f64)).collect())
                                .stringify();
                        db.prepare_cached("INSERT INTO bike_way_turns VALUES(?,?,?,?)")?
                            .execute(params![
                                source as f64,
                                via_ways,
                                target as f64,
                                f64::from(i32::from(only) | if conditional_only { 2 } else { 0 })
                            ])?;
                        let row = db.last_insert_rowid();
                        self.windows(db, 1.0, row, intervals)?;
                    } else if via.len() == 1 && via[0].1 == 0 {
                        let same = source == target;
                        let movement = if same && rule.ends_with("u_turn") {
                            2
                        } else if same && rule.ends_with("straight_on") {
                            4
                        } else {
                            0
                        };
                        db.prepare_cached("INSERT INTO bike_turns VALUES(?,?,?,?)")?
                            .execute(params![
                                via[0].0 as f64,
                                source as f64,
                                target as f64,
                                f64::from(
                                    i32::from(only)
                                        | movement
                                        | if conditional_only { 8 } else { 0 }
                                )
                            ])?;
                        let row = db.last_insert_rowid();
                        self.windows(db, 0.0, row, intervals)?;
                    } else {
                        self.unsupported_restrictions += 1.0;
                    }
                }
            }
        }
        Ok(())
    }

    /// Write the junction rows gathered during the street pass into the
    /// TEMP table; the main store is unaffected.
    pub fn flush(&mut self, db: &Connection) -> Result<()> {
        let mut rows: Vec<(i64, Junction)> = self.junctions.drain().collect();
        rows.sort_unstable_by_key(|(id, _)| *id);
        let mut insert = db.prepare("INSERT INTO bike_junction_stress VALUES(?,?,?,?,?,?)")?;
        for (id, row) in rows {
            insert.execute(params![
                id,
                row.level,
                row.highest_way,
                row.other_level,
                row.signal,
                row.walk
            ])?;
        }
        Ok(())
    }

    /// `finish()`: propagate junction stress and return the metadata fields.
    /// Junction rows not yet flushed are written first, so a caller that
    /// skips `flush` gets the JavaScript writer's result; after a street
    /// build's `flush` this writes nothing.
    pub fn finish(mut self, db: &Connection) -> Result<Vec<(String, Js)>> {
        self.flush(db)?;
        let tables: &[&str] = if self.timed_tables {
            &["bike_edges", "bike_timed_edges"]
        } else {
            &["bike_edges"]
        };
        for table in tables {
            db.execute_batch(&format!(
                "UPDATE {table} SET stress =
          (CASE WHEN (stress & 16) != 0 THEN stress & 7 ELSE max(stress & 7,
            coalesce((SELECT CASE WHEN signal!=0 THEN 1 WHEN highest_way=way_id THEN other_level ELSE level END
              FROM bike_junction_stress WHERE node_id=from_node),1),
            coalesce((SELECT CASE WHEN signal!=0 THEN 1 WHEN highest_way=way_id THEN other_level ELSE level END
              FROM bike_junction_stress WHERE node_id=to_node),1)) END)
          | (CASE WHEN coalesce((SELECT walk FROM bike_junction_stress WHERE node_id=from_node),1)=1
            AND coalesce((SELECT walk FROM bike_junction_stress WHERE node_id=to_node),1)=1 THEN stress & 8 ELSE 0 END)"
            ))?;
        }
        db.execute_batch("DROP TABLE bike_junction_stress; CREATE INDEX bike_edges_from ON bike_edges(from_node);")?;
        let node_count: i64 =
            db.query_row("SELECT count(*) AS n FROM bike_nodes", [], |row| row.get(0))?;
        let mut fields: Vec<(String, Js)> = vec![
            ("bikeProfileVersion".into(), Js::from(1)),
            ("bikeStressVersion".into(), Js::from(1)),
            ("bikeEdgeCount".into(), Js::from(self.edge_count)),
            ("bikeNodeCount".into(), Js::from(node_count)),
            (
                "bikeUnsupportedRestrictionCount".into(),
                Js::from(self.unsupported_restrictions),
            ),
            (
                "bikeConditionalRestrictionCount".into(),
                Js::from(self.conditional_restrictions),
            ),
        ];
        if !self.edge_schedules.is_empty() {
            fields.push(("bikeEdgeWindowVersion".into(), Js::from(1)));
            fields.push(("bikeTimedEdgeCount".into(), Js::from(self.timed_edge_count)));
            fields.push((
                "bikeEdgeWindowCount".into(),
                Js::from(self.edge_window_count),
            ));
        }
        if self.timed_window_count > 0.0 {
            fields.push(("bikeTurnWindowVersion".into(), Js::from(1)));
            fields.push((
                "bikeTimedTurnWindowCount".into(),
                Js::from(self.timed_window_count),
            ));
        }
        Ok(fields)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn weekly_conditions_parse_like_the_regex() {
        assert_eq!(
            weekly_condition("Mo-Fr 07:00-09:00"),
            Some((0..5).map(|d| (d * 1440 + 420, d * 1440 + 540)).collect())
        );
        assert_eq!(weekly_condition("24/7"), Some(vec![(0, WEEK)]));
        assert_eq!(weekly_condition("08:00-09:00").map(|v| v.len()), Some(7));
        assert_eq!(
            weekly_condition("su 22:00-02:00"),
            Some(vec![(0, 120), (6 * 1440 + 1320, WEEK)])
        );
        assert_eq!(weekly_condition("mo, tu"), None);
        assert_eq!(weekly_condition("mon"), None);
        assert_eq!(weekly_condition("mo;tu"), None);
        assert_eq!(weekly_condition("sa"), Some(vec![(5 * 1440, 6 * 1440)]));
        let values = compile_weekly_values("", "no @ (Mo-Fr 08:00-09:00)", &|v| v == "no").unwrap();
        assert_eq!(values[0].0, "");
        assert_eq!(values[1].0, "no");
        assert_eq!(
            conditional_turn_rules("no_left_turn @ (Mo); only_straight_on@x; xno_u_turn @ y"),
            vec!["no_left_turn", "only_straight_on"]
        );
    }

    // Ported from test/check-bike-profile.mjs.

    use super::Direction::{Backward, Forward};
    use crate::pbf::{Block, Relation};

    type Pairs<'a> = &'a [(&'a str, &'a str)];

    const BOTH: Directions = Directions {
        forward: true,
        backward: true,
    };
    const NEITHER: Directions = Directions {
        forward: false,
        backward: false,
    };

    fn only(forward: bool, backward: bool) -> Directions {
        Directions { forward, backward }
    }

    fn bike(pairs: Pairs) -> Directions {
        directions(&Tags::of(pairs))
    }

    fn joined<'a>(first: Pairs<'a>, rest: Pairs<'a>) -> Vec<(&'a str, &'a str)> {
        first.iter().chain(rest).copied().collect()
    }

    /// `{get: id => ({lon: id * .001, lat: 0})}`.
    struct Line;

    impl NodeLookup for Line {
        fn get(&self, id: i64) -> Option<(f64, f64)> {
            Some((0.0, id as f64 * 0.001))
        }
    }

    /// `new Map([[1, {lon: 0, lat: 0}], [2, {lon: .2, lat: .2}]])`.
    struct Diagonal;

    impl NodeLookup for Diagonal {
        fn get(&self, id: i64) -> Option<(f64, f64)> {
            match id {
                1 => Some((0.0, 0.0)),
                2 => Some((0.2, 0.2)),
                _ => None,
            }
        }
    }

    fn count(db: &Connection, sql: &str, values: impl rusqlite::Params) -> i64 {
        db.query_row(sql, values, |row| row.get(0)).unwrap()
    }

    fn field(receipt: &[(String, Js)], key: &str) -> Option<f64> {
        receipt
            .iter()
            .find(|(name, _)| name == key)
            .and_then(|(_, value)| value.as_f64())
    }

    fn rule_windows<'v>(values: &'v WeeklyValues, rule: &str) -> Option<&'v Vec<(i32, i32)>> {
        values
            .iter()
            .find(|(name, _)| name == rule)
            .map(|(_, intervals)| intervals)
    }

    fn covers(intervals: &[(i32, i32)], minute: i32) -> bool {
        intervals.iter().any(|(a, b)| *a <= minute && minute < *b)
    }

    /// Extra tags on a primary road; permitted directions, facility and stress
    /// per `[forward, backward]`.
    type FacilityCase<'a> = (Pairs<'a>, [bool; 2], [i32; 2], [i32; 2]);

    #[test]
    fn facility_directions_follow_way_geometry() {
        let cases: [FacilityCase; 17] = [
            (
                &[
                    ("oneway", "yes"),
                    ("cycleway:left", "track"),
                    ("cycleway:left:oneway", "-1"),
                ],
                [true, true],
                [0, 2],
                [4, 3],
            ),
            (
                &[
                    ("oneway", "-1"),
                    ("cycleway:right", "lane"),
                    ("cycleway:right:oneway", "yes"),
                ],
                [true, true],
                [1, 0],
                [3, 4],
            ),
            (
                &[
                    ("oneway", "-1"),
                    ("cycleway:right", "track"),
                    ("cycleway:right:oneway", "-1"),
                ],
                [false, true],
                [0, 2],
                [4, 3],
            ),
            (
                &[("oneway", "yes"), ("cycleway", "opposite_track")],
                [true, true],
                [0, 2],
                [4, 3],
            ),
            (
                &[("oneway", "-1"), ("cycleway", "opposite_track")],
                [true, true],
                [2, 0],
                [3, 4],
            ),
            (
                &[
                    ("oneway", "yes"),
                    ("driving_side", "right"),
                    ("cycleway:left", "lane"),
                ],
                [true, false],
                [1, 0],
                [3, 4],
            ),
            (
                &[
                    ("oneway", "-1"),
                    ("driving_side", "left"),
                    ("cycleway:left", "track"),
                ],
                [false, true],
                [0, 2],
                [4, 3],
            ),
            (
                &[("junction", "roundabout"), ("cycleway:left", "lane")],
                [true, false],
                [1, 0],
                [3, 4],
            ),
            (
                &[("cycleway:both", "lane"), ("cycleway:both:oneway", "yes")],
                [true, true],
                [1, 0],
                [3, 4],
            ),
            (
                &[("cycleway:both", "track"), ("cycleway:both:oneway", "-1")],
                [true, true],
                [0, 2],
                [4, 3],
            ),
            (
                &[
                    ("oneway", "yes"),
                    ("cycleway:both", "track"),
                    ("cycleway:both:oneway", "no"),
                ],
                [true, true],
                [2, 2],
                [3, 3],
            ),
            (
                &[("cycleway", "track"), ("cycleway:backward", "no")],
                [true, true],
                [2, 0],
                [3, 4],
            ),
            (&[("cycleway:left", "track")], [true, true], [1, 1], [4, 4]),
            (
                &[("cycleway:left", "track"), ("driving_side", "left")],
                [true, true],
                [2, 0],
                [3, 4],
            ),
            (
                &[
                    ("oneway", "yes"),
                    ("cycleway:left", "shared_lane"),
                    ("cycleway:left:oneway", "-1"),
                ],
                [true, false],
                [0, 1],
                [4, 4],
            ),
            (
                &[
                    ("oneway", "yes"),
                    ("cycleway:left", "track"),
                    ("cycleway:left:oneway", "-1"),
                    ("oneway:bicycle", "yes"),
                ],
                [true, false],
                [0, 2],
                [4, 3],
            ),
            (
                &[
                    ("oneway", "yes"),
                    ("cycleway:left", "track"),
                    ("cycleway:left:oneway", "-1"),
                    ("bicycle:backward", "no"),
                ],
                [true, false],
                [0, 2],
                [4, 3],
            ),
        ];
        for (extra, permitted, facilities, stresses) in cases {
            let pairs = joined(&[("highway", "primary")], extra);
            let tags = Tags::of(&pairs);
            let found = directions(&tags);
            assert_eq!([found.forward, found.backward], permitted, "{pairs:?}");
            assert_eq!(
                Direction::BOTH.map(|direction| (attributes(&tags, direction) >> 3) & 3),
                facilities,
                "{pairs:?}"
            );
            assert_eq!(
                Direction::BOTH.map(|direction| stress(&tags, direction, true).unwrap()),
                stresses,
                "{pairs:?}"
            );
        }
    }

    #[test]
    fn timed_reversal_keeps_facility_stress_and_pushing() {
        let db = Connection::open_in_memory().unwrap();
        let mut writer = BikeWriter::create(&db).unwrap();
        let tags = Tags::of(&[
            ("highway", "primary"),
            ("oneway", "yes"),
            ("oneway:bicycle", "no"),
            ("cycleway", "lane"),
            ("oneway:conditional", "-1 @ (Mo 08:00-09:00)"),
            ("foot", "yes"),
            ("foot:conditional", "no @ (Mo 08:00-09:00)"),
        ]);
        writer.way(&db, 1, &tags, &[1, 2], &Line).unwrap();
        assert_eq!(count(&db, "SELECT count(*) n FROM bike_edges", []), 0);
        let mut statement = db
            .prepare(
                "SELECT e.*,w.start_minute,w.end_minute FROM bike_timed_edges e
      JOIN bike_edge_windows w USING(window_id)",
            )
            .unwrap();
        // (from_node, attributes, window_id, stress, start_minute, end_minute)
        let rows: Vec<(i64, i64, i64, i64, i64, i64)> = statement
            .query_map([], |row| {
                Ok((
                    row.get("from_node")?,
                    row.get("attributes")?,
                    row.get("window_id")?,
                    row.get("stress")?,
                    row.get("start_minute")?,
                    row.get("end_minute")?,
                ))
            })
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        drop(statement);
        for minute in 0..10080 {
            let active: Vec<_> = rows
                .iter()
                .filter(|r| r.4 <= minute && minute < r.5)
                .collect();
            assert_eq!(
                active.len(),
                2,
                "one variant per direction at minute {minute}"
            );
            for r in active {
                let reversed = (480..540).contains(&minute);
                let lane = (r.0 == 1) != reversed;
                assert_eq!((r.1 >> 3) & 3, i64::from(lane));
                assert_eq!(
                    r.3,
                    (if lane { 3 } else { 4 }) | (if reversed { 0 } else { 8 })
                );
            }
        }
        writer.finish(&db).unwrap();
        let mut statement = db
            .prepare("SELECT stress FROM bike_timed_edges ORDER BY rowid")
            .unwrap();
        let stored: Vec<i64> = statement
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        let mut by_window: Vec<((i64, i64), i64)> = Vec::new();
        for r in &rows {
            match by_window.iter_mut().find(|(key, _)| *key == (r.0, r.2)) {
                Some(entry) => entry.1 = r.3,
                None => by_window.push(((r.0, r.2), r.3)),
            }
        }
        assert_eq!(
            stored,
            by_window
                .into_iter()
                .map(|(_, stress)| stress)
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn long_segments_keep_their_endpoints() {
        for timed in [false, true] {
            let db = Connection::open_in_memory().unwrap();
            let mut writer = BikeWriter::create(&db).unwrap();
            let mut pairs = vec![("highway", "cycleway"), ("oneway", "yes")];
            if timed {
                pairs.push(("bicycle:conditional", "no @ (Mo 08:00-09:00)"));
            }
            writer
                .way(&db, 1, &Tags::of(&pairs), &[1, 2], &Diagonal)
                .unwrap();
            writer.finish(&db).unwrap();
            let table = if timed {
                "bike_timed_edges"
            } else {
                "bike_edges"
            };
            let mut statement = db.prepare(&format!("SELECT * FROM {table}")).unwrap();
            let rows: Vec<(i64, i64, i64)> = statement
                .query_map([], |row| {
                    Ok((
                        row.get("from_node")?,
                        row.get("to_node")?,
                        row.get("distance_cm")?,
                    ))
                })
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap();
            assert_eq!(
                rows.len(),
                1,
                "A segment longer than 10 km must survive import"
            );
            assert_eq!(rows[0].0, 1);
            assert_eq!(rows[0].1, 2);
            assert!(rows[0].2 > 3_000_000 && rows[0].2 < 3_200_000);
            assert_eq!(count(&db, "SELECT count(*) n FROM bike_nodes", []), 2);
        }
    }

    #[test]
    fn road_stress_estimates() {
        let cases: [(Pairs, bool, i32, i32); 17] = [
            (&[("highway", "cycleway")], false, 1, 1),
            (&[("highway", "residential")], true, 1, 1),
            (
                &[("highway", "residential"), ("maxspeed", "80")],
                true,
                4,
                4,
            ),
            (&[("highway", "residential"), ("lanes", "4")], true, 4, 4),
            (&[("highway", "tertiary")], true, 3, 3),
            (&[("highway", "tertiary"), ("lanes", "2")], true, 2, 2),
            (
                &[
                    ("highway", "primary"),
                    ("lanes", "2"),
                    ("maxspeed", "20 mph"),
                ],
                true,
                4,
                4,
            ),
            (
                &[
                    ("highway", "primary"),
                    ("lanes", "2"),
                    ("maxspeed", "20 mph"),
                    ("cycleway", "lane"),
                ],
                true,
                2,
                2,
            ),
            (&[("highway", "primary"), ("cycleway", "lane")], true, 3, 3),
            (
                &[("highway", "primary"), ("cycleway:right", "lane")],
                true,
                4,
                4,
            ),
            (
                &[
                    ("highway", "primary"),
                    ("cycleway:right", "lane"),
                    ("driving_side", "right"),
                ],
                true,
                3,
                4,
            ),
            (
                &[
                    ("highway", "primary"),
                    ("cycleway:left", "lane"),
                    ("driving_side", "left"),
                ],
                true,
                3,
                4,
            ),
            (
                &[
                    ("highway", "primary"),
                    ("cycleway:right", "lane"),
                    ("cycleway:right:oneway", "no"),
                ],
                true,
                3,
                3,
            ),
            (
                &[("highway", "primary"), ("cycleway", "opposite_lane")],
                true,
                4,
                3,
            ),
            (
                &[
                    ("highway", "primary"),
                    ("cycleway", "opposite_lane"),
                    ("oneway", "-1"),
                ],
                true,
                3,
                4,
            ),
            (&[("highway", "primary"), ("lts", "2")], true, 18, 18),
            (
                &[("highway", "primary"), ("lts", "2"), ("lts:backward", "4")],
                true,
                18,
                20,
            ),
        ];
        for (pairs, cars, forward, backward) in cases {
            let tags = Tags::of(pairs);
            assert_eq!(stress(&tags, Forward, cars).unwrap(), forward, "{pairs:?}");
            assert_eq!(
                stress(&tags, Backward, cars).unwrap(),
                backward,
                "{pairs:?}"
            );
        }
        for value in ["", "0", "5", "1.5", "unknown"] {
            let error = stress(
                &Tags::of(&[("highway", "primary"), ("lts", value)]),
                Forward,
                true,
            )
            .unwrap_err();
            assert!(error.to_string().contains("lts must be"), "{value:?}");
        }
    }

    #[test]
    fn junction_stress_signals_and_walking() {
        for signal in [false, true] {
            let db = Connection::open_in_memory().unwrap();
            let mut writer = BikeWriter::create(&db).unwrap();
            let signal_tags = if signal {
                Tags::of(&[("highway", "traffic_signals")])
            } else {
                Tags::default()
            };
            writer.node(2, &signal_tags).unwrap();
            writer
                .node(5, &Tags::of(&[("foot", "no"), ("bicycle", "yes")]))
                .unwrap();
            let ways: [(i64, Pairs, &[i64]); 5] = [
                (10, &[("highway", "cycleway")], &[1, 2, 3, 4]),
                (20, &[("highway", "primary"), ("bicycle", "no")], &[6, 2, 7]),
                (30, &[("highway", "cycleway"), ("lts", "2")], &[2, 8]),
                (40, &[("highway", "primary"), ("foot", "no")], &[4, 5]),
                (
                    50,
                    &[("highway", "cycleway"), ("foot:backward", "no")],
                    &[9, 10],
                ),
            ];
            for (id, pairs, refs) in ways {
                writer.way(&db, id, &Tags::of(pairs), refs, &Line).unwrap();
            }
            let receipt = writer.finish(&db).unwrap();
            assert_eq!(field(&receipt, "bikeStressVersion"), Some(1.0));
            let mut statement = db
                .prepare(
                    "SELECT from_node,to_node,stress FROM bike_edges WHERE way_id=10 ORDER BY from_node,to_node",
                )
                .unwrap();
            let rows: Vec<(i64, i64, i64)> = statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap();
            let edge = |from: i64, to: i64| {
                rows.iter()
                    .find(|r| r.0 == from && r.1 == to)
                    .map(|r| r.2)
                    .unwrap()
            };
            assert_eq!(edge(1, 2), if signal { 9 } else { 12 });
            assert_eq!(edge(2, 3), if signal { 9 } else { 12 });
            // Junction 4 independently touches the high-stress way 40; its effect
            // reaches 3->4, without recursively changing the preceding 2->3 segment.
            assert_eq!(edge(3, 4), 12);
            let stresses = |way: i64| -> Vec<i64> {
                let mut statement = db
                    .prepare("SELECT stress FROM bike_edges WHERE way_id=?")
                    .unwrap();
                statement
                    .query_map([way], |row| row.get(0))
                    .unwrap()
                    .collect::<rusqlite::Result<_>>()
                    .unwrap()
            };
            assert!(
                stresses(30).iter().all(|stress| *stress == 10),
                "Explicit LTS survives intersections"
            );
            assert!(
                stresses(40).iter().all(|stress| *stress == 4),
                "Walking permission does not follow bicycle permission"
            );
            assert_eq!(
                count(
                    &db,
                    "SELECT stress FROM bike_edges WHERE way_id=50 AND from_node=10",
                    []
                ),
                1
            );
            assert_eq!(
                count(
                    &db,
                    "SELECT count(*) n FROM sqlite_temp_master WHERE name='bike_junction_stress'",
                    []
                ),
                0
            );
        }
    }

    #[test]
    fn weekly_conditions_and_turn_windows() {
        assert_eq!(
            weekly_condition("Mo-Fr 07:00-09:00"),
            Some((0..5).map(|i| (i * 1440 + 420, i * 1440 + 540)).collect())
        );
        assert_eq!(
            weekly_condition("Su 23:00-02:00"),
            Some(vec![(0, 120), (10020, 10080)])
        );
        assert_eq!(
            weekly_condition("Fr-Mo"),
            Some(vec![(0, 1440), (5760, 10080)])
        );
        assert_eq!(
            weekly_condition("Mo,We 07:00-08:00,17:00-18:00"),
            Some(vec![(420, 480), (1020, 1080), (3300, 3360), (3900, 3960)])
        );
        assert_eq!(weekly_condition("24/7"), Some(vec![(0, 10080)]));
        for unsupported in [
            "PH",
            "sunset-sunrise",
            "Mo 08:00-09:00; Mo 10:00-11:00",
            "Mo-Fr 08:00-09:00 AND wet",
            "Dec 25",
            "08:60-09:00",
            "24:00-01:00",
            "08:00-08:00",
            "Mo-Fr 08:00-09:00 \"school\"",
        ] {
            assert_eq!(weekly_condition(unsupported), None, "{unsupported}");
        }
        let precedence = compile_turn_windows(
            "no_left_turn",
            "none @ (Mo 08:00-09:00); only_right_turn @ (Mo 08:30-08:45)",
        )
        .unwrap();
        assert_eq!(
            rule_windows(&precedence, "no_left_turn"),
            Some(&vec![(0, 480), (540, 10080)])
        );
        assert_eq!(
            rule_windows(&precedence, "only_right_turn"),
            Some(&vec![(510, 525)])
        );
        assert_eq!(compile_turn_windows("no_left_turn", "none @ (PH)"), None);
        assert_eq!(
            compile_turn_windows("", "no_left_turn @ ((Mo 08:00-09:00))"),
            None
        );
        assert_eq!(
            compile_turn_windows("", "no_left_turn @ (Mo 08:00-09:00; Tu 08:00-09:00)"),
            None
        );
        // Independently evaluate every minute, including overnight and wraparound.
        let overnight = compile_turn_windows(
            "no_left_turn",
            "none @ (Su 23:00-02:00); only_right_turn @ (Mo 01:00-03:00)",
        )
        .unwrap();
        for minute in 0..10080 {
            let mut expected = if (120..10020).contains(&minute) {
                "no_left_turn"
            } else {
                "none"
            };
            if (60..180).contains(&minute) {
                expected = "only_right_turn";
            }
            let active: Vec<&str> = overnight
                .iter()
                .filter(|(_, intervals)| covers(intervals, minute))
                .map(|(rule, _)| rule.as_str())
                .collect();
            let wanted: Vec<&str> = if expected == "none" {
                Vec::new()
            } else {
                vec![expected]
            };
            assert_eq!(active, wanted, "weekly minute {minute}");
        }
    }

    #[test]
    fn conditional_access_resolves_by_week() {
        assert_eq!(
            bike(&[("highway", "footway"), ("bicycle:forward", "yes")]),
            only(true, false)
        );
        assert_eq!(
            bike(&[
                ("highway", "residential"),
                ("bicycle:forward", "yes"),
                ("access:conditional", "no @ (PH)"),
            ]),
            only(true, false)
        );
        assert_eq!(
            bike(&[
                ("highway", "residential"),
                ("bicycle", "dismount"),
                ("foot:conditional", "no @ (PH)"),
            ]),
            NEITHER
        );
        let windows = |pairs: Pairs| way_windows(&Tags::of(pairs), None).unwrap();
        assert!(
            windows(&[
                ("highway", "residential"),
                ("bicycle", "yes"),
                ("access:conditional", "no @ (PH)"),
            ])
            .is_empty()
        );
        assert!(
            windows(&[
                ("highway", "residential"),
                ("access:conditional", "no @ (PH)")
            ])
            .is_empty()
        );
        let reversal = windows(&[
            ("highway", "residential"),
            ("oneway", "yes"),
            ("oneway:conditional", "-1 @ (Mo 08:00-09:00)"),
        ]);
        assert_eq!(
            reversal
                .iter()
                .map(|variant| (variant.direction, variant.intervals.clone()))
                .collect::<Vec<_>>(),
            vec![
                (Forward, vec![(0, 480), (540, 10080)]),
                (Backward, vec![(480, 540)]),
            ]
        );
        let timed_directions = windows(&[
            ("highway", "residential"),
            ("access:conditional", "no @ (Mo 08:00-10:00)"),
            ("bicycle:conditional", "yes @ (Mo 09:00-11:00)"),
        ]);
        let timed_dismount = windows(&[
            ("highway", "residential"),
            ("bicycle", "yes"),
            ("foot", "yes"),
            ("bicycle:conditional", "dismount @ (Su 23:00-02:00)"),
        ]);
        for minute in 0..10080 {
            let active = |variants: &[Variant]| -> Vec<(Direction, i32)> {
                variants
                    .iter()
                    .filter(|variant| covers(&variant.intervals, minute))
                    .map(|variant| (variant.direction, variant.attributes))
                    .collect()
            };
            let mut names: Vec<&str> = active(&timed_directions)
                .iter()
                .map(|(direction, _)| direction.name())
                .collect();
            names.sort_unstable();
            let expected: Vec<&str> = if (480..540).contains(&minute) {
                Vec::new()
            } else {
                vec!["backward", "forward"]
            };
            assert_eq!(names, expected, "mode precedence at {minute}");
            let dismount = active(&timed_dismount);
            assert_eq!(dismount.len(), 2);
            assert!(
                dismount
                    .iter()
                    .all(|(_, attributes)| (attributes & 128 != 0)
                        == !(120..10020).contains(&minute)),
                "dismount at {minute}"
            );
        }
    }

    #[test]
    fn static_permissions_nodes_and_attributes() {
        for highway in [
            "cycleway",
            "residential",
            "path",
            "track",
            "trunk",
            "trunk_link",
        ] {
            assert_eq!(bike(&[("highway", highway)]), BOTH);
        }
        for highway in ["motorway", "footway", "pedestrian", "steps", "construction"] {
            assert_eq!(bike(&[("highway", highway)]), NEITHER);
        }
        assert_eq!(
            bike(&[("highway", "residential"), ("oneway", "yes")]),
            only(true, false)
        );
        assert_eq!(
            bike(&[("highway", "residential"), ("oneway", "-1")]),
            only(false, true)
        );
        let contraflow: [Pairs; 3] = [
            &[("oneway:bicycle", "no")],
            &[("cycleway", "opposite_lane")],
            &[("cycleway:left", "track"), ("cycleway:left:oneway", "no")],
        ];
        for extra in contraflow {
            assert_eq!(
                bike(&joined(
                    &[("highway", "residential"), ("oneway", "yes")],
                    extra
                )),
                BOTH
            );
        }
        assert_eq!(
            bike(&[
                ("highway", "residential"),
                ("oneway", "yes"),
                ("cycleway", "opposite_lane"),
                ("oneway:bicycle", "yes"),
            ]),
            only(true, false)
        );
        assert_eq!(
            bike(&[("highway", "residential"), ("junction", "roundabout")]),
            only(true, false)
        );
        assert_eq!(
            bike(&[
                ("highway", "cycleway"),
                ("access", "no"),
                ("bicycle", "designated")
            ]),
            BOTH
        );
        assert_eq!(
            bike(&[
                ("highway", "cycleway"),
                ("bicycle", "no"),
                ("access", "yes")
            ]),
            NEITHER
        );
        assert_eq!(
            bike(&[
                ("highway", "cycleway"),
                ("bicycle", "no"),
                ("bicycle:forward", "yes")
            ]),
            only(true, false)
        );
        assert_eq!(
            bike(&[("highway", "residential"), ("vehicle", "private")]),
            NEITHER
        );
        assert_eq!(bike(&[("highway", "trunk"), ("motorroad", "yes")]), NEITHER);
        assert_eq!(
            bike(&[("highway", "primary"), ("bicycle", "use_sidepath")]),
            NEITHER
        );
        assert_eq!(
            bike(&[("highway", "primary"), ("bicycle", "optional_sidepath")]),
            BOTH
        );
        assert_eq!(
            bike(&[("highway", "residential"), ("bicycle:backward", "no")]),
            only(true, false)
        );
        assert_eq!(
            bike(&[
                ("highway", "cycleway"),
                ("bicycle:conditional", "no @ (sunset-sunrise)")
            ]),
            NEITHER
        );
        assert_eq!(
            bike(&[
                ("highway", "cycleway"),
                ("bicycle:forward:conditional", "no @ (sunset-sunrise)"),
            ]),
            only(false, true)
        );
        assert_eq!(
            bike(&[
                ("highway", "residential"),
                ("oneway:conditional", "yes @ (Mo-Fr 07:00-09:00)"),
            ]),
            NEITHER
        );
        assert_eq!(
            bike(&[("highway", "footway"), ("bicycle", "dismount")]),
            BOTH
        );
        assert_eq!(
            bike(&[
                ("highway", "residential"),
                ("oneway", "yes"),
                ("bicycle:backward", "yes")
            ]),
            BOTH
        );
        let attributes_of =
            |pairs: Pairs, direction: Direction| attributes(&Tags::of(pairs), direction);
        assert!(
            attributes_of(
                &[("highway", "service"), ("access", "destination")],
                Forward
            ) & (1 << 22)
                != 0
        );
        let node = |pairs: Pairs| node_allowed(&Tags::of(pairs));
        assert!(node(&[("barrier", "bollard")]));
        assert!(!node(&[("barrier", "gate"), ("access", "private")]));
        assert!(node(&[("barrier", "gate"), ("bicycle", "yes")]));
        assert!(!node(&[
            ("barrier", "gate"),
            ("bicycle", "yes"),
            ("locked", "yes")
        ]));
        assert!(node(&[("barrier", "gate")]));
        assert!(!node(&[
            ("barrier", "lift_gate"),
            ("opening_hours", "Mo-Fr 08:00-17:00")
        ]));
        assert!(!node(&[("barrier", "retaining_wall")]));
        assert_eq!(
            attributes_of(
                &[("highway", "residential"), ("bicycle:backward", "dismount")],
                Backward
            ) & 128,
            128
        );
        assert_eq!(
            attributes_of(&[("highway", "footway"), ("bicycle", "dismount")], Forward) & 128,
            128
        );
        assert_eq!(
            (attributes_of(&[("highway", "residential"), ("incline", "10%")], Backward) >> 8) & 63,
            20
        );
        assert_eq!(
            (attributes_of(
                &[("highway", "residential"), ("maxspeed", "30 mph")],
                Forward
            ) >> 14)
                & 255,
            48
        );
    }

    /// `{refs, roles, types}` with roles indexing `['from', 'via', 'to']`.
    fn members(refs: &[i64], roles: &[u32], types: &[u32]) -> Relation {
        Relation {
            id: 0,
            keys: Vec::new(),
            vals: Vec::new(),
            roles: roles.to_vec(),
            refs: refs.to_vec(),
            types: types.to_vec(),
        }
    }

    #[test]
    fn blocked_nodes_and_turn_restrictions() {
        let db = Connection::open_in_memory().unwrap();
        let mut writer = BikeWriter::create(&db).unwrap();
        let block = Block::with_strings(&["from", "via", "to"]);
        writer
            .node(2, &Tags::of(&[("barrier", "gate"), ("access", "private")]))
            .unwrap();
        writer
            .way(
                &db,
                10,
                &Tags::of(&[("highway", "cycleway")]),
                &[1, 2, 3],
                &Line,
            )
            .unwrap();
        assert_eq!(
            count(&db, "SELECT count(*) AS n FROM bike_edges", []),
            0,
            "Blocked nodes must break the way, never bridge it"
        );
        let contraflow = Tags::of(&[
            ("highway", "residential"),
            ("oneway", "yes"),
            ("oneway:bicycle", "no"),
        ]);
        writer.way(&db, 20, &contraflow, &[3, 4], &Line).unwrap();
        assert_eq!(count(&db, "SELECT count(*) AS n FROM bike_edges", []), 2);
        let relation = members(&[20, 4, 30], &[0, 1, 2], &[1, 0, 1]);
        writer
            .relation(
                &db,
                &block,
                &relation,
                &Tags::of(&[
                    ("type", "restriction"),
                    ("restriction", "no_left_turn"),
                    ("except", "bus;bicycle"),
                ]),
            )
            .unwrap();
        assert_eq!(count(&db, "SELECT count(*) AS n FROM bike_turns", []), 0);
        writer
            .relation(
                &db,
                &block,
                &relation,
                &Tags::of(&[("type", "restriction"), ("restriction", "no_left_turn")]),
            )
            .unwrap();
        let turn: (i64, i64, i64, i64) = db
            .query_row(
                "SELECT via_node, from_way, to_way, only_turn FROM bike_turns",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(turn, (4, 20, 30, 0));
        writer
            .relation(
                &db,
                &block,
                &members(&[20, 30, 40], &[0, 1, 2], &[1, 1, 1]),
                &Tags::of(&[
                    ("type", "restriction"),
                    ("restriction:bicycle", "no_left_turn"),
                ]),
            )
            .unwrap();
        let way_turn: (i64, String, i64, i64) = db
            .query_row(
                "SELECT from_way, via_ways, to_way, only_turn FROM bike_way_turns",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(way_turn, (20, "[30]".to_owned(), 40, 0));
        writer
            .relation(
                &db,
                &block,
                &relation,
                &Tags::of(&[
                    ("type", "restriction"),
                    (
                        "restriction:conditional",
                        "no_left_turn @ (Mo-Fr 07:00-09:00)",
                    ),
                ]),
            )
            .unwrap();
        writer
            .relation(
                &db,
                &block,
                &relation,
                &Tags::of(&[
                    ("type", "restriction"),
                    (
                        "restriction:bicycle:conditional",
                        "only_right_turn @ (Mo-Fr 07:00-09:00)",
                    ),
                ]),
            )
            .unwrap();
        assert_eq!(
            count(
                &db,
                "SELECT only_turn FROM bike_turns ORDER BY rowid DESC LIMIT 1",
                []
            ),
            9
        );
        writer
            .relation(
                &db,
                &block,
                &members(&[20, 21, 4, 30], &[0, 0, 1, 2], &[1, 1, 0, 1]),
                &Tags::of(&[("type", "restriction"), ("restriction", "no_entry")]),
            )
            .unwrap();
        assert_eq!(
            count(
                &db,
                "SELECT count(*) n FROM bike_turns WHERE from_way=21",
                []
            ),
            1
        );
        let receipt = writer.finish(&db).unwrap();
        assert_eq!(
            field(&receipt, "bikeConditionalRestrictionCount"),
            Some(2.0)
        );
        assert_eq!(field(&receipt, "bikeTurnWindowVersion"), Some(1.0));
        assert_eq!(field(&receipt, "bikeTimedTurnWindowCount"), Some(10.0));
        assert_eq!(field(&receipt, "bikeEdgeCount"), Some(2.0));
    }

    #[test]
    fn conditional_turn_exceptions_keep_their_windows() {
        let db = Connection::open_in_memory().unwrap();
        let mut writer = BikeWriter::create(&db).unwrap();
        let block = Block::with_strings(&["from", "via", "to"]);
        let relation = members(&[1, 2, 3], &[0, 1, 2], &[1, 0, 1]);
        writer
            .relation(
                &db,
                &block,
                &relation,
                &Tags::of(&[
                    ("type", "restriction"),
                    ("restriction", "no_left_turn"),
                    ("restriction:bicycle:conditional", "none @ (Mo 08:00-09:00)"),
                ]),
            )
            .unwrap();
        let (row, only_turn): (i64, i64) = db
            .query_row("SELECT rowid, only_turn FROM bike_turns", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .unwrap();
        assert_eq!(
            only_turn, 0,
            "A bicycle exception must retain the general base restriction outside its window"
        );
        let mut statement = db
            .prepare("SELECT start_minute,end_minute FROM bike_turn_windows WHERE turn_row=?")
            .unwrap();
        let windows: Vec<(i64, i64)> = statement
            .query_map([row], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        drop(statement);
        assert_eq!(windows, vec![(0, 480), (540, 10080)]);
        writer
            .relation(
                &db,
                &block,
                &members(&[1, 2, 3], &[0, 1, 2], &[1, 1, 1]),
                &Tags::of(&[
                    ("type", "restriction"),
                    ("restriction:conditional", "no_left_turn @ (Su 23:00-02:00)"),
                ]),
            )
            .unwrap();
        assert_eq!(
            count(
                &db,
                "SELECT count(*) n FROM bike_turn_windows WHERE turn_table=1",
                []
            ),
            2
        );
        writer
            .relation(
                &db,
                &block,
                &relation,
                &Tags::of(&[
                    ("type", "restriction"),
                    ("restriction:conditional", "no_left_turn @ (PH)"),
                ]),
            )
            .unwrap();
        let unknown = count(&db, "SELECT max(rowid) id FROM bike_turns", []);
        assert_eq!(
            count(
                &db,
                "SELECT count(*) n FROM bike_turn_windows WHERE turn_table=0 AND turn_row=?",
                [unknown]
            ),
            0,
            "Unknown conditions retain all-day conservative enforcement"
        );
    }
}
