//! Walking, driving and wheelchair tag rules (national-osm-store.mjs and
//! wheelchair-policy.mjs).

use crate::jsrt::{is_space, norm_opt, string_to_number, trim};
use crate::tags::Tags;
use vigo_format::js::Js;

const EXPLICIT_PEDESTRIAN: [&str; 4] = ["yes", "designated", "permissive", "official"];
const RESTRICTED_PEDESTRIAN: [&str; 3] = ["no", "private", "use_sidepath"];

pub const DRIVABLE_HIGHWAYS: [&str; 16] = [
    "motorway",
    "motorway_link",
    "trunk",
    "trunk_link",
    "primary",
    "primary_link",
    "secondary",
    "secondary_link",
    "tertiary",
    "tertiary_link",
    "unclassified",
    "residential",
    "living_street",
    "service",
    "road",
    "track",
];

fn explicit(value: &str) -> bool {
    EXPLICIT_PEDESTRIAN.contains(&value)
}

fn restricted(value: &str) -> bool {
    RESTRICTED_PEDESTRIAN.contains(&value)
}

fn tag<'a>(tags: &Tags<'a>, key: &str) -> std::borrow::Cow<'a, str> {
    norm_opt(tags.get(key))
}

/// `String(tags[key] ?? '').trim()` is non-empty.
fn present(tags: &Tags, key: &str) -> bool {
    tags.get(key).is_some_and(|value| !trim(value).is_empty())
}

/// The sorted drivable classes; codes are positions plus one.
pub fn road_class_catalog() -> Vec<&'static str> {
    let mut catalog = DRIVABLE_HIGHWAYS.to_vec();
    catalog.sort_unstable();
    catalog
}

pub fn drive_road_class_code(value: Option<&str>) -> crate::Result<f64> {
    let normalized = norm_opt(value);
    match road_class_catalog()
        .iter()
        .position(|class| *class == normalized)
    {
        Some(index) => Ok((index + 1) as f64),
        None => Err(crate::Error::new(format!(
            "Unsupported drivable OSM highway class: {}",
            value.unwrap_or("")
        ))),
    }
}

fn has_completely_separate_sidewalk_geometry(tags: &Tags) -> bool {
    let sidewalk = tag(tags, "sidewalk");
    let both = tag(tags, "sidewalk:both");
    let left = tag(tags, "sidewalk:left");
    let right = tag(tags, "sidewalk:right");
    sidewalk == "separate" || both == "separate" || (left == "separate" && right == "separate")
}

pub fn way_walkable(tags: &Tags, refs: &[i64]) -> bool {
    let highway = tag(tags, "highway");
    let access = tag(tags, "access");
    let foot = tag(tags, "foot");
    if tag(tags, "area") == "yes"
        && ["highway", "railway", "public_transport"]
            .iter()
            .any(|key| tag(tags, key) == "platform")
    {
        return false;
    }
    if highway == "elevator"
        && (tag(tags, "area") == "yes" || (refs.len() > 2 && refs[0] == refs[refs.len() - 1]))
    {
        return false;
    }
    if has_unresolved_pedestrian_hours(tags) {
        return false;
    }
    if highway.is_empty() || restricted(&foot) {
        return false;
    }
    if restricted(&access) && !explicit(&foot) {
        return false;
    }
    if restricted(&access)
        && explicit(&foot)
        && DRIVABLE_HIGHWAYS.contains(&highway.as_ref())
        && has_completely_separate_sidewalk_geometry(tags)
    {
        return false;
    }
    ![
        "motorway",
        "motorway_link",
        "raceway",
        "construction",
        "proposed",
    ]
    .contains(&highway.as_ref())
}

pub fn platform_area_walkable(tags: &Tags) -> bool {
    if tag(tags, "area") != "yes"
        || !["railway", "public_transport", "highway"]
            .iter()
            .any(|key| tag(tags, key) == "platform")
        || has_unresolved_pedestrian_hours(tags)
    {
        return false;
    }
    let foot = tag(tags, "foot");
    let access = tag(tags, "access");
    !restricted(&foot)
        && (!restricted(&access) || explicit(&foot))
        && (explicit(&foot) || explicit(&access))
}

pub fn platform_area_has_walking_junctions(
    refs: &[i64],
    mut is_walking_node: impl FnMut(i64) -> bool,
) -> bool {
    if refs.len() < 4 || refs[0] != refs[refs.len() - 1] {
        return false;
    }
    let body = &refs[..refs.len() - 1];
    let mut distinct: Vec<i64> = Vec::with_capacity(body.len());
    let mut seen = std::collections::HashSet::with_capacity(body.len());
    for &id in body {
        if seen.insert(id) {
            distinct.push(id);
        }
    }
    if distinct.len() != body.len() {
        return false;
    }
    let mut junctions = 0;
    for id in distinct {
        if is_walking_node(id) {
            junctions += 1;
            if junctions == 2 {
                return true;
            }
        }
    }
    false
}

/// `(?:yes|designated|permissive|official)` case-insensitively at `at`.
fn permissive_word(text: &str, at: usize) -> Option<usize> {
    for word in EXPLICIT_PEDESTRIAN {
        if text.len() >= at + word.len() && text[at..at + word.len()].eq_ignore_ascii_case(word) {
            return Some(at + word.len());
        }
    }
    None
}

fn skip_space(text: &str, mut at: usize) -> usize {
    while let Some(c) = text[at..].chars().next() {
        if !is_space(c) {
            break;
        }
        at += c.len_utf8();
    }
    at
}

/// One `word \s* @ \s* (\([^()]+\)|[^;()]+)` clause; returns its end.
fn permissive_clause(text: &str, at: usize) -> Option<usize> {
    let at = permissive_word(text, at)?;
    let at = skip_space(text, at);
    if !text[at..].starts_with('@') {
        return None;
    }
    let after_at = at + 1;
    let value = skip_space(text, after_at);
    if text[value..].starts_with('(') {
        let inner = &text[value + 1..];
        let length = inner.find(['(', ')']).unwrap_or(inner.len());
        if length > 0 && inner[length..].starts_with(')') {
            return Some(value + 1 + length + 1);
        }
    }
    // `[^;()]+` from directly after '@' (it may absorb the spaces).
    let rest = &text[after_at..];
    let length = rest.find([';', '(', ')']).unwrap_or(rest.len());
    if length == 0 {
        return None;
    }
    Some(after_at + length)
}

fn only_permissive_conditions(value: Option<&str>) -> bool {
    let text = trim(value.unwrap_or(""));
    if text.is_empty() {
        return true;
    }
    let Some(mut at) = permissive_clause(text, 0) else {
        return false;
    };
    loop {
        if at == text.len() {
            return true;
        }
        let separator = skip_space(text, at);
        if !text[separator..].starts_with(';') {
            return false;
        }
        let next = skip_space(text, separator + 1);
        match permissive_clause(text, next) {
            Some(end) => at = end,
            None => return false,
        }
    }
}

fn has_unresolved_pedestrian_hours(tags: &Tags) -> bool {
    let foot = tag(tags, "foot");
    let explicit_foot = explicit(&foot);
    let foot_conditional = present(tags, "foot:conditional");
    let access_conditional = present(tags, "access:conditional");
    (foot_conditional
        && !(explicit_foot && only_permissive_conditions(tags.get("foot:conditional"))))
        || (access_conditional
            && !explicit_foot
            && !(explicit(&tag(tags, "access"))
                && only_permissive_conditions(tags.get("access:conditional"))))
        || present(tags, "oneway:foot:conditional")
        || (present(tags, "opening_hours") && tag(tags, "opening_hours") != "24/7")
}

pub fn node_walkable(tags: &Tags) -> bool {
    if has_unresolved_pedestrian_hours(tags) {
        return false;
    }
    if ["yes", "true", "1"].contains(&tag(tags, "locked").as_ref())
        || present(tags, "locked:conditional")
    {
        return false;
    }
    let foot = tag(tags, "foot");
    let access = tag(tags, "access");
    if restricted(&foot) || (restricted(&access) && !explicit(&foot)) {
        return false;
    }
    if explicit(&foot) {
        return true;
    }
    let barrier = tag(tags, "barrier");
    if ["wall", "fence", "retaining_wall", "block", "jersey_barrier"].contains(&barrier.as_ref()) {
        return false;
    }
    if ["gate", "lift_gate", "swing_gate", "sliding_gate"].contains(&barrier.as_ref()) {
        return access.is_empty() || explicit(&access);
    }
    if barrier == "full-height_turnstile" {
        return explicit(&access);
    }
    true
}

fn denies_motor_vehicle_access(value: Option<&str>) -> bool {
    ["no", "private", "agricultural", "forestry"].contains(&norm_opt(value).as_ref())
}

pub fn drivable(tags: &Tags) -> bool {
    let highway = tag(tags, "highway");
    if !DRIVABLE_HIGHWAYS.contains(&highway.as_ref()) {
        return false;
    }
    let access = tags
        .get("motorcar")
        .or(tags.get("motor_vehicle"))
        .or(tags.get("vehicle"))
        .or(tags.get("access"));
    if denies_motor_vehicle_access(access) {
        return false;
    }
    highway != "track" || ["yes", "designated", "permissive"].contains(&norm_opt(access).as_ref())
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Directions {
    pub forward: bool,
    pub backward: bool,
}

impl Directions {
    pub fn any(self) -> bool {
        self.forward || self.backward
    }
}

pub fn walk_directions(tags: &Tags) -> Directions {
    let mut forward = true;
    let mut backward = true;
    let one_way_foot = tag(tags, "oneway:foot");
    let conveying = tag(tags, "conveying");
    if ["yes", "1", "true"].contains(&one_way_foot.as_ref()) {
        backward = false;
    } else if ["-1", "reverse"].contains(&one_way_foot.as_ref()) {
        forward = false;
    } else if conveying == "forward" {
        backward = false;
    } else if conveying == "backward" {
        forward = false;
    } else if conveying == "yes" || conveying == "reversible" {
        forward = false;
        backward = false;
    }
    if restricted(&tag(tags, "foot:forward")) {
        forward = false;
    }
    if restricted(&tag(tags, "foot:backward")) {
        backward = false;
    }
    Directions { forward, backward }
}

pub fn drive_directions(tags: &Tags) -> Directions {
    let mut forward = true;
    let mut backward = true;
    let one_way = norm_opt(tags.get("oneway:motor_vehicle").or(tags.get("oneway")));
    if ["yes", "1", "true"].contains(&one_way.as_ref()) {
        backward = false;
    } else if ["-1", "reverse"].contains(&one_way.as_ref()) {
        forward = false;
    } else if !["no", "0", "false"].contains(&one_way.as_ref()) {
        let highway = tag(tags, "highway");
        let junction = tag(tags, "junction");
        if junction == "roundabout"
            || junction == "circular"
            || highway == "motorway"
            || highway == "motorway_link"
        {
            backward = false;
        }
    }
    let forward_access = tags
        .get("motorcar:forward")
        .or(tags.get("motor_vehicle:forward"))
        .or(tags.get("vehicle:forward"));
    let backward_access = tags
        .get("motorcar:backward")
        .or(tags.get("motor_vehicle:backward"))
        .or(tags.get("vehicle:backward"));
    if denies_motor_vehicle_access(forward_access) {
        forward = false;
    }
    if denies_motor_vehicle_access(backward_access) {
        backward = false;
    }
    Directions { forward, backward }
}

fn highway_speed_kph(highway: &str) -> Option<f64> {
    Some(match highway {
        "motorway" => 100.0,
        "motorway_link" => 60.0,
        "trunk" => 90.0,
        "trunk_link" => 55.0,
        "primary" => 60.0,
        "primary_link" => 45.0,
        "secondary" => 50.0,
        "secondary_link" => 40.0,
        "tertiary" => 45.0,
        "tertiary_link" => 35.0,
        "unclassified" => 40.0,
        "residential" => 30.0,
        "living_street" => 10.0,
        "service" => 20.0,
        "road" => 30.0,
        "track" => 15.0,
        _ => return None,
    })
}

/// `\d+(?:\.\d+)?` at the start of `text`.
pub fn leading_decimal(text: &str) -> Option<&str> {
    let bytes = text.as_bytes();
    let mut end = bytes.iter().take_while(|b| b.is_ascii_digit()).count();
    if end == 0 {
        return None;
    }
    if bytes.get(end) == Some(&b'.') {
        let fraction = bytes[end + 1..]
            .iter()
            .take_while(|b| b.is_ascii_digit())
            .count();
        if fraction > 0 {
            end += 1 + fraction;
        }
    }
    Some(&text[..end])
}

fn parsed_speed_kph(value: Option<&str>) -> Option<f64> {
    let normalized = norm_opt(value);
    if normalized.is_empty()
        || ["none", "signals", "variable", "walk"].contains(&normalized.as_ref())
    {
        return None;
    }
    // /(?:^|;)\s*(\d+(?:\.\d+)?)/: the start, then each ';' in order.
    let starts =
        std::iter::once(0).chain(normalized.match_indices(';').map(|(index, _)| index + 1));
    let digits = starts
        .into_iter()
        .find_map(|start| leading_decimal(&normalized[skip_space(&normalized, start)..]))?;
    let number = string_to_number(digits);
    if number.is_nan() || number <= 0.0 {
        return None;
    }
    if normalized.contains("mph") {
        return Some(number * 1.609344);
    }
    if normalized.contains("knot") {
        return Some(number * 1.852);
    }
    Some(number)
}

pub fn driving_speed_kph(tags: &Tags, backward: bool) -> f64 {
    let directional = if backward {
        tags.get("maxspeed:backward")
    } else {
        tags.get("maxspeed:forward")
    };
    let parsed = parsed_speed_kph(directional).or_else(|| parsed_speed_kph(tags.get("maxspeed")));
    let value = parsed
        .or_else(|| highway_speed_kph(&tag(tags, "highway")))
        .unwrap_or(30.0);
    crate::jsrt::max(5.0, crate::jsrt::min(140.0, value))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WheelchairStreets {
    Inferred,
    Verified,
}

impl WheelchairStreets {
    pub fn parse(value: &str) -> crate::Result<Self> {
        match value {
            "inferred" => Ok(Self::Inferred),
            "verified" => Ok(Self::Verified),
            _ => Err(crate::Error::new(
                "--wheelchair-streets must be inferred or verified",
            )),
        }
    }
}

/// `wheelchairDescriptionFor(streets)`.
pub fn wheelchair_description(streets: WheelchairStreets) -> Js {
    let verified = streets == WheelchairStreets::Verified;
    Js::object()
        .with("profile", "wheelchair-strict-v1")
        .with("unknownData", "exclude")
        .with("streetEvidence", if verified { "wheelchair-yes-only" } else { "inferred-step-free-v1" })
        .with("stationPaths", "published-wheelchair-time-or-dimensioned-step-free")
        .with("fareGates", "accessible-endpoints-with-published-time-or-five-second-estimate")
        .with("sameLevelWalkways", "zero-wheelchair-length-with-published-walk-length-and-accessible-endpoints")
        .with("minimumWidthMeters", 0.9)
        .with("maximumSlope", 0.083)
        .with(
            "limitations",
            vec![
                "Unknown vehicle and boarding accessibility is excluded; coverage may be sparse.",
                "Fare gates between accessible nodes use published crossing time or a five-second estimate.",
                "Same-level walkways with accessible endpoints and a zero wheelchair length use their positive published walk length.",
                if verified {
                    "Unknown street accessibility is excluded; only ways tagged wheelchair=yes are used."
                } else {
                    "Inferred streets can lack wheelchair or surface tags. An explicit wheelchair=yes overrides surface and trail filters; mapped dimensions and some barriers are still checked."
                },
                "Coordinate attachments are geometric; door-to-street access is not verified.",
                "Elevator outages, temporary obstructions and individual chair dimensions are not modeled.",
            ],
        )
}

const ROUGH_SURFACES: [&str; 22] = [
    "unpaved",
    "gravel",
    "fine_gravel",
    "pebblestone",
    "dirt",
    "earth",
    "ground",
    "grass",
    "grass_paver",
    "mud",
    "sand",
    "woodchips",
    "rock",
    "stone",
    "cobblestone",
    "unhewn_cobblestone",
    "sett",
    "stepping_stones",
    "snow",
    "ice",
    "salt",
    "",
];
const ROUGH_SMOOTHNESS: [&str; 5] = ["bad", "very_bad", "horrible", "very_horrible", "impassable"];
const PAVED_SURFACES: [&str; 11] = [
    "paved",
    "asphalt",
    "concrete",
    "concrete:plates",
    "concrete:lanes",
    "paving_stones",
    "metal",
    "wood",
    "rubber",
    "tartan",
    "chipseal",
];
const PASSABLE_BARRIERS: [&str; 8] = [
    "gate",
    "bollard",
    "lift_gate",
    "swing_gate",
    "sliding_gate",
    "entrance",
    "height_restrictor",
    "no",
];

pub fn wheelchair_way_allowed(tags: &Tags, streets: WheelchairStreets) -> bool {
    let access = tag(tags, "wheelchair");
    if !tag(tags, "wheelchair:conditional").is_empty() {
        return false;
    }
    if ["steps", "construction", "proposed"].contains(&tag(tags, "highway").as_ref()) {
        return false;
    }
    let conveying = tag(tags, "conveying");
    if !conveying.is_empty() && conveying != "no" {
        return false;
    }
    if access != "yes" {
        if streets != WheelchairStreets::Inferred || access == "no" || access == "limited" {
            return false;
        }
        let surface = tag(tags, "surface");
        // The empty string is not a rough surface; ROUGH_SURFACES ends with a sentinel.
        if (!surface.is_empty() && ROUGH_SURFACES.contains(&surface.as_ref()))
            || ROUGH_SMOOTHNESS.contains(&tag(tags, "smoothness").as_ref())
        {
            return false;
        }
        let sac = tag(tags, "sac_scale");
        if !sac.is_empty() && sac != "hiking" {
            return false;
        }
        if ["path", "track", "bridleway"].contains(&tag(tags, "highway").as_ref())
            && !PAVED_SURFACES.contains(&surface.as_ref())
        {
            return false;
        }
    }
    wheelchair_node_allowed(tags, streets)
}

/// `^([\d.]+)\s*(m|cm|mm)?$` lengths in metres.
fn metric_length(value: Option<&str>) -> Option<f64> {
    let text = norm_opt(value);
    let digits = text
        .bytes()
        .take_while(|b| b.is_ascii_digit() || *b == b'.')
        .count();
    if digits == 0 {
        return None;
    }
    let unit = trim_start_space(&text[digits..]);
    let scale = match unit {
        "" | "m" => 1.0,
        "cm" => 0.01,
        "mm" => 0.001,
        _ => return None,
    };
    let number = string_to_number(&text[..digits]);
    if !number.is_finite() {
        return None;
    }
    Some(number * scale)
}

fn trim_start_space(text: &str) -> &str {
    text.trim_start_matches(is_space)
}

/// `/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)%$/`.
fn percent_grade(text: &str) -> bool {
    let Some(body) = text.strip_suffix('%') else {
        return false;
    };
    let body = body.strip_prefix(['+', '-']).unwrap_or(body);
    let bytes = body.as_bytes();
    let integer = bytes.iter().take_while(|b| b.is_ascii_digit()).count();
    if integer > 0 {
        let rest = &bytes[integer..];
        return rest.is_empty() || (rest[0] == b'.' && rest[1..].iter().all(u8::is_ascii_digit));
    }
    bytes.first() == Some(&b'.') && bytes.len() > 1 && bytes[1..].iter().all(u8::is_ascii_digit)
}

pub fn wheelchair_node_allowed(tags: &Tags, streets: WheelchairStreets) -> bool {
    let wheelchair = tag(tags, "wheelchair");
    if wheelchair == "no"
        || wheelchair == "limited"
        || !tag(tags, "wheelchair:conditional").is_empty()
    {
        return false;
    }
    let kerb = tag(tags, "kerb");
    if tag(tags, "highway") == "steps" || kerb == "raised" || kerb == "yes" {
        return false;
    }
    let barrier = tag(tags, "barrier");
    if barrier == "kerb"
        && !["lowered", "flush", "no"].contains(&kerb.as_ref())
        && wheelchair != "yes"
    {
        return false;
    }
    if !tag(tags, "kerb:height").is_empty() {
        match metric_length(tags.get("kerb:height")) {
            Some(height) if height <= 0.03 => {}
            _ => return false,
        }
    }
    if [
        "stile",
        "turnstile",
        "full-height_turnstile",
        "kissing_gate",
        "wall",
        "fence",
    ]
    .contains(&barrier.as_ref())
    {
        return false;
    }
    let inferred = streets == WheelchairStreets::Inferred;
    let passable =
        inferred && PASSABLE_BARRIERS.contains(&barrier.as_ref()) && tag(tags, "locked") != "yes";
    let lowered = inferred && barrier == "kerb";
    if ((!barrier.is_empty() && barrier != "no" && !lowered && !passable)
        || tag(tags, "highway") == "elevator")
        && wheelchair != "yes"
    {
        return false;
    }
    if !tag(tags, "width").is_empty() {
        match metric_length(tags.get("width")) {
            Some(width) if width >= 0.9 => {}
            _ => return false,
        }
    }
    let incline = tag(tags, "incline");
    let grade_free = ["up", "down", "yes"].contains(&incline.as_ref());
    if grade_free && wheelchair != "yes" {
        return false;
    }
    if !incline.is_empty() && !grade_free && incline != "0" && incline != "0%" {
        let percent = string_to_number(
            &incline[..incline.len() - incline.chars().last().map_or(0, char::len_utf8)],
        );
        if !percent_grade(&incline) || !percent.is_finite() || percent.abs() > 8.3 {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permissive_conditions_follow_the_regex() {
        assert!(only_permissive_conditions(Some(
            "yes @ (Mo-Fr 08:00-18:00)"
        )));
        assert!(only_permissive_conditions(Some(
            "YES@sunset-sunrise; designated @ (Sa)"
        )));
        assert!(only_permissive_conditions(Some("yes @ ; yes @ x")));
        assert!(!only_permissive_conditions(Some("no @ (Mo)")));
        assert!(!only_permissive_conditions(Some("yes @ (Mo")));
        assert!(!only_permissive_conditions(Some("yes @")));
        assert!(only_permissive_conditions(None));
    }

    #[test]
    fn grades_and_speeds() {
        assert!(percent_grade("5%"));
        assert!(percent_grade("-5.%"));
        assert!(percent_grade(".5%"));
        assert!(!percent_grade("5"));
        assert!(!percent_grade("."));
        assert_eq!(parsed_speed_kph(Some("30 mph")), Some(30.0 * 1.609344));
        assert_eq!(parsed_speed_kph(Some("none;50")), Some(50.0));
        assert_eq!(parsed_speed_kph(Some("signals")), None);
        assert_eq!(metric_length(Some("3 cm")), Some(0.03));
        assert_eq!(metric_length(Some("1.2.3")), None);
    }

    type Pairs<'a> = &'a [(&'a str, &'a str)];

    fn way(pairs: Pairs) -> bool {
        way_walkable(&Tags::of(pairs), &[])
    }

    fn walk(pairs: Pairs) -> Directions {
        walk_directions(&Tags::of(pairs))
    }

    fn both(forward: bool, backward: bool) -> Directions {
        Directions { forward, backward }
    }

    /// Ported from test/check-osm-platform-area.mjs.
    #[test]
    fn platform_and_elevator_outlines_are_not_walking_ways() {
        let elevator = Tags::of(&[("highway", "elevator"), ("wheelchair", "yes")]);
        assert!(!way_walkable(&elevator, &[1, 2, 3, 1]));
        assert!(!way(&[("highway", "elevator"), ("area", "yes")]));
        assert!(
            way_walkable(&elevator, &[1, 2]),
            "An open inclined elevator is not a cabin outline."
        );
        assert!(!way(&[("highway", "platform"), ("area", "yes")]));
        assert!(
            way(&[("highway", "platform")]),
            "A mapped platform centre line remains a walking way."
        );
        assert!(way(&[("highway", "platform"), ("area", "no")]));
        assert!(!way(&[("highway", "footway"), ("access", "private")]));
    }

    /// Ported from test/check-osm-node-access.mjs.
    #[test]
    fn node_and_way_access_follow_pedestrian_permissions() {
        assert!(node_walkable(&Tags::of(&[("barrier", "bollard")])));
        assert!(!node_walkable(&Tags::of(&[
            ("entrance", "emergency"),
            ("access", "private")
        ])));
        assert!(!way(&[("highway", "footway"), ("access", "private")]));
        assert!(!way(&[("railway", "rail")]));
        assert!(!way(&[("railway", "light_rail")]));
        assert!(!way(&[("highway", "footway"), ("foot", "use_sidepath")]));
        assert!(way(&[("highway", "footway"), ("opening_hours", "24/7")]));
        assert!(!way(&[
            ("highway", "footway"),
            ("opening_hours", "Mo-Fr 08:00-17:00")
        ]));
        let cases: [(Pairs, bool); 11] = [
            (
                &[
                    ("foot", "permissive"),
                    (
                        "foot:conditional",
                        "yes @ (Mo-Fr 09:00-17:00; Sa-Su 08:00-17:00)",
                    ),
                ],
                true,
            ),
            (
                &[
                    ("foot", "yes"),
                    ("foot:conditional", "yes @ (Mo-Fr); permissive @ (Sa-Su)"),
                ],
                true,
            ),
            (
                &[
                    ("foot", "yes"),
                    ("foot:conditional", "yes @ (Mo-Fr); no @ (Sa-Su)"),
                ],
                false,
            ),
            (
                &[
                    ("foot", "yes"),
                    ("foot:conditional", "yes @ (Mo-Fr); private @ (Sa-Su)"),
                ],
                false,
            ),
            (&[("foot", "yes"), ("foot:conditional", "yes @ (")], false),
            (&[("foot:conditional", "yes @ (Mo-Su 08:00-17:00)")], false),
            (
                &[
                    ("access", "yes"),
                    ("access:conditional", "permissive @ (Mo-Fr)"),
                ],
                true,
            ),
            (
                &[
                    ("access", "private"),
                    ("access:conditional", "yes @ (Mo-Fr)"),
                ],
                false,
            ),
            (
                &[
                    ("foot", "yes"),
                    ("access:conditional", "no @ (Mo-Fr)"),
                    ("foot:conditional", "no @ (Sa-Su)"),
                ],
                false,
            ),
            (
                &[
                    ("foot", "yes"),
                    ("oneway:foot:conditional", "yes @ (Mo-Fr)"),
                ],
                false,
            ),
            (
                &[
                    ("foot", "yes"),
                    ("foot:conditional", "yes @ (Mo-Fr)"),
                    ("opening_hours", "08:00-17:00"),
                ],
                false,
            ),
        ];
        for (extra, allowed) in cases {
            let mut pairs = vec![("highway", "service")];
            pairs.extend_from_slice(extra);
            assert_eq!(way(&pairs), allowed, "{extra:?}");
        }
    }

    /// Ported from test/check-street-routing-modes.mjs.
    #[test]
    fn drive_directions_and_speeds() {
        assert_eq!(
            drive_directions(&Tags::of(&[("highway", "residential"), ("oneway", "-1")])),
            both(false, true)
        );
        assert_eq!(
            drive_directions(&Tags::of(&[
                ("highway", "primary"),
                ("junction", "roundabout")
            ])),
            both(true, false)
        );
        let mph = driving_speed_kph(
            &Tags::of(&[("highway", "residential"), ("maxspeed", "30 mph")]),
            false,
        );
        assert_eq!(string_to_number(&crate::jsrt::to_fixed(mph, 3)), 48.28);
        assert_eq!(
            driving_speed_kph(&Tags::of(&[("highway", "motorway")]), false),
            100.0
        );
    }

    /// Ported from test/check-national-routing-store.mjs.
    #[test]
    fn walk_directions_and_pedestrian_overrides() {
        assert_eq!(walk(&[("oneway:foot", "yes")]), both(true, false));
        assert_eq!(walk(&[("oneway:foot", "-1")]), both(false, true));
        assert_eq!(
            walk(&[("conveying", "forward"), ("foot:forward", "no")]),
            both(false, false)
        );
        assert_eq!(walk(&[("conveying", "yes")]), both(false, false));
        assert_eq!(walk(&[("conveying", "reversible")]), both(false, false));
        assert_eq!(walk(&[("foot:backward", "no")]), both(true, false));
        assert!(
            way(&[
                ("highway", "path"),
                ("access", "no"),
                ("foot", "permissive")
            ]),
            "A pedestrian-specific permission must override a general OSM access denial."
        );
        assert!(
            !way(&[("highway", "path"), ("access", "no")]),
            "A general OSM access denial remains binding without a pedestrian-specific permission."
        );
        assert!(
            !way(&[("highway", "footway"), ("access", "private")]),
            "An unqualified private way must not enter the public pedestrian graph."
        );
        for access in [None, Some("yes"), Some("permissive")] {
            let mut pairs = vec![("highway", "footway")];
            pairs.extend(access.map(|access| ("access", access)));
            pairs.push(("foot", "private"));
            assert!(
                !way(&pairs),
                "Private pedestrian access must not become a public shortcut through a general mode permission."
            );
        }
        assert!(
            way(&[
                ("highway", "footway"),
                ("access", "private"),
                ("foot", "permissive")
            ]),
            "An explicit pedestrian permission must override private general access."
        );
        assert!(
            !way(&[("highway", "path"), ("access", "yes"), ("foot", "no")]),
            "A pedestrian-specific denial must override general OSM access."
        );
        assert!(
            !way(&[
                ("highway", "unclassified"),
                ("access", "no"),
                ("foot", "yes"),
                ("sidewalk:both", "separate"),
            ]),
            "A restricted carriageway must not duplicate its explicitly separate pedestrian geometry."
        );
        assert!(
            way(&[
                ("highway", "unclassified"),
                ("foot", "yes"),
                ("sidewalk:both", "separate"),
            ]),
            "Separate sidewalks alone must not remove an otherwise walkable road needed for graph connectivity."
        );
        assert!(
            way(&[
                ("highway", "path"),
                ("access", "no"),
                ("foot", "permissive"),
                ("sidewalk:both", "separate"),
            ]),
            "Separate-sidewalk metadata must not suppress the pedestrian way itself."
        );
    }
}

/// Ported from test/check-wheelchair-routing.mjs: the same tags and expected
/// decisions for wheelchair ways and nodes under both street-evidence policies.
#[cfg(test)]
mod wheelchair_tests {
    use super::*;
    use WheelchairStreets::{Inferred, Verified};

    type Pairs<'a> = &'a [(&'a str, &'a str)];

    fn way(pairs: Pairs, streets: WheelchairStreets) -> bool {
        wheelchair_way_allowed(&Tags::of(pairs), streets)
    }

    fn node(pairs: Pairs, streets: WheelchairStreets) -> bool {
        wheelchair_node_allowed(&Tags::of(pairs), streets)
    }

    #[test]
    fn verified_streets_use_only_wheelchair_yes() {
        assert!(way(
            &[("highway", "footway"), ("wheelchair", "yes")],
            Inferred
        ));
        for tags in [
            &[("highway", "footway")][..],
            &[("highway", "steps"), ("wheelchair", "yes")],
            &[("wheelchair", "limited")],
            &[("wheelchair", "yes"), ("incline", "20%")],
        ] {
            assert!(!way(tags, Verified), "{tags:?}");
        }
        for tags in [
            &[("barrier", "stile"), ("wheelchair", "yes")][..],
            &[("barrier", "gate")],
            &[("barrier", "kerb"), ("kerb", "lowered")],
            &[("kerb", "raised")],
            &[("wheelchair", "no")],
            &[("wheelchair:conditional", "yes @ (Mo-Fr)")],
        ] {
            assert!(!node(tags, Verified), "{tags:?}");
        }
    }

    #[test]
    fn inferred_streets_admit_untagged_paved_ways() {
        assert!(!way(
            &[("highway", "footway"), ("surface", "gravel")],
            Inferred
        ));
        assert!(way(
            &[
                ("highway", "footway"),
                ("surface", "gravel"),
                ("wheelchair", "yes")
            ],
            Inferred
        ));
        assert!(!way(
            &[
                ("highway", "footway"),
                ("surface", "gravel"),
                ("wheelchair", "yes"),
                ("width", ".6")
            ],
            Inferred
        ));
        for tags in [
            &[("highway", "footway")][..],
            &[("highway", "residential")],
            &[("highway", "path"), ("surface", "asphalt")],
            &[("highway", "footway"), ("incline", "5%")],
        ] {
            assert!(way(tags, Inferred), "{tags:?}");
        }
        for tags in [
            &[("highway", "path")][..],
            &[("highway", "track"), ("surface", "gravel")],
            &[("highway", "footway"), ("surface", "cobblestone")],
            &[("highway", "footway"), ("smoothness", "bad")],
            &[
                ("highway", "path"),
                ("surface", "asphalt"),
                ("sac_scale", "mountain_hiking"),
            ],
            &[("highway", "steps")],
            &[("highway", "footway"), ("wheelchair", "no")],
            &[("highway", "footway"), ("incline", "12%")],
            &[("highway", "footway"), ("width", "0.6")],
        ] {
            assert!(!way(tags, Inferred), "{tags:?}");
        }
        for tags in [
            &[("barrier", "gate")][..],
            &[("barrier", "bollard")],
            &[("barrier", "kerb"), ("kerb", "lowered")],
            &[],
        ] {
            assert!(node(tags, Inferred), "{tags:?}");
        }
        for tags in [
            &[("barrier", "gate"), ("locked", "yes")][..],
            &[("barrier", "kerb")],
            &[("barrier", "stile")],
            &[("barrier", "cycle_barrier")],
            &[("kerb", "raised")],
            &[("wheelchair", "no")],
        ] {
            assert!(!node(tags, Inferred), "{tags:?}");
        }
        assert!(WheelchairStreets::parse("assumed").is_err());
    }

    #[test]
    fn inclines_need_a_bounded_grade_or_wheelchair_yes() {
        // Malformed slope tags must not turn unknown access into an accessible edge.
        for incline in [".%", "1.2.3%", "+.%", "--2%", "NaN%", "Infinity%"] {
            assert!(
                !way(
                    &[
                        ("highway", "footway"),
                        ("wheelchair", "yes"),
                        ("incline", incline)
                    ],
                    Inferred
                ),
                "{incline}"
            );
            assert!(
                !node(&[("wheelchair", "yes"), ("incline", incline)], Inferred),
                "{incline}"
            );
        }
        for incline in ["0", "0%", "+8.3%", "-8.3%", ".5%"] {
            assert!(
                way(
                    &[
                        ("highway", "footway"),
                        ("wheelchair", "yes"),
                        ("incline", incline)
                    ],
                    Inferred
                ),
                "{incline}"
            );
        }
        // up, down and yes give a slope without a grade. wheelchair=yes vouches
        // for it; on a way of unknown accessibility the slope stays unproved.
        for incline in ["up", "down", "yes", "UP"] {
            for streets in [Inferred, Verified] {
                assert!(
                    way(
                        &[
                            ("highway", "footway"),
                            ("wheelchair", "yes"),
                            ("incline", incline)
                        ],
                        streets
                    ),
                    "{incline}"
                );
            }
            assert!(
                !way(&[("highway", "footway"), ("incline", incline)], Inferred),
                "{incline}"
            );
            assert!(
                !way(
                    &[
                        ("highway", "footway"),
                        ("wheelchair", "limited"),
                        ("incline", incline)
                    ],
                    Inferred
                ),
                "{incline}"
            );
            assert!(!node(&[("incline", incline)], Inferred), "{incline}");
        }
        for incline in ["steep", "5°", "12%", "-9%"] {
            assert!(
                !way(
                    &[
                        ("highway", "footway"),
                        ("wheelchair", "yes"),
                        ("incline", incline)
                    ],
                    Inferred
                ),
                "{incline}"
            );
        }
        assert!(!way(
            &[
                ("highway", "steps"),
                ("wheelchair", "yes"),
                ("incline", "up")
            ],
            Inferred
        ));
        assert!(!way(
            &[
                ("highway", "footway"),
                ("wheelchair", "yes"),
                ("incline", "up"),
                ("width", "0.6")
            ],
            Inferred
        ));
        assert!(node(&[], Inferred));
        assert!(node(
            &[("barrier", "gate"), ("wheelchair", "yes")],
            Inferred
        ));
    }
}
