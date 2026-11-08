//! Great-circle distances on the mean Earth sphere, between
//! `[longitude, latitude]` points in decimal degrees.
//!
//! Two arithmetic forms exist on purpose. Published distances, durations and
//! tie-breaks depend on each form's exact rounding, so every caller keeps the
//! form it was built with; the two are not interchangeable.

/// Mean Earth radius, in kilometres.
pub const EARTH_RADIUS_KM: f64 = 6371.0088;
/// Mean Earth radius, in metres.
pub const EARTH_RADIUS_M: f64 = 6_371_008.8;

/// Haversine distance in kilometres. Degrees convert as `value * PI / 180`,
/// the arithmetic order of the JavaScript station fallback and shape
/// alignment, so both runtimes produce the same bits.
pub fn haversine_km(a: [f64; 2], b: [f64; 2]) -> f64 {
    let radians = |value: f64| value * std::f64::consts::PI / 180.0;
    let value = (radians(b[1] - a[1]) / 2.0).sin().powi(2)
        + radians(a[1]).cos() * radians(b[1]).cos() * (radians(b[0] - a[0]) / 2.0).sin().powi(2);
    EARTH_RADIUS_KM * 2.0 * value.sqrt().atan2((1.0 - value).sqrt())
}

/// Haversine distance in metres, converting degrees with `f64::to_radians`.
/// Rounding can lift the haversine term just above one for near-antipodal
/// points; the complement is clamped there so the distance stays finite.
pub fn haversine_m(a: [f64; 2], b: [f64; 2]) -> f64 {
    let value = ((b[1] - a[1]).to_radians() / 2.0).sin().powi(2)
        + a[1].to_radians().cos()
            * b[1].to_radians().cos()
            * ((b[0] - a[0]).to_radians() / 2.0).sin().powi(2);
    EARTH_RADIUS_M * 2.0 * value.sqrt().atan2((1.0 - value).max(0.0).sqrt())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_forms_measure_the_same_arc() {
        let (a, b) = ([-71.0589, 42.3601], [-71.0942, 42.3601]);
        let km = haversine_km(a, b);
        assert!((km * 1000.0 - haversine_m(a, b)).abs() < 1e-6);
        assert!((km - 2.900_417).abs() < 1e-6);
        assert_eq!(haversine_km(a, a), 0.0);
        assert_eq!(haversine_m(b, b), 0.0);
    }

    #[test]
    fn antipodal_metres_stay_finite() {
        assert!(haversine_m([0.0, 0.0], [180.0, 0.0]).is_finite());
    }
}
