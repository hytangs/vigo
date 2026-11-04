//! Opportunity indicators from destination-wise travel-time percentiles.
//! No network or raster duplication, and no stochastic rounding of counts.
use super::{Result, fail};
use serde_json::{Value, json};
use vigo_model::{AccessibilityOptions, DecayFunction};

fn weight(decay: &DecayFunction, seconds: f64, cutoff: f64) -> f64 {
    if !seconds.is_finite() {
        return 0.;
    }
    match decay {
        DecayFunction::Step => {
            if seconds < cutoff {
                1.
            } else {
                0.
            }
        }
        DecayFunction::Exponential => (-std::f64::consts::LN_2 * seconds / cutoff).exp(),
        DecayFunction::FixedExponential { decay_constant } => (-decay_constant.0 * seconds).exp(),
        DecayFunction::Logistic {
            standard_deviation_minutes,
        } => {
            let scale = standard_deviation_minutes.0 * 60. * 3_f64.sqrt() / std::f64::consts::PI;
            1. / (1. + ((seconds - cutoff) / scale).exp())
        }
        DecayFunction::Linear { width_minutes } => {
            (0.5 + (cutoff - seconds) / (width_minutes.0 * 60.)).clamp(0., 1.)
        }
    }
}

pub(super) fn validate(options: &AccessibilityOptions, destinations: usize) -> Result<()> {
    let positive = |n: f64| n.is_finite() && n > 0.;
    if destinations == 0
        || options.layers.is_empty()
        || options.layers.len() > 16
        || options.cutoffs_minutes.is_empty()
        || options.cutoffs_minutes.len() > 16
        || options
            .cutoffs_minutes
            .iter()
            .any(|n| !positive(n.0) || n.0 > 2880.)
    {
        return fail(
            "Accessibility needs 1..16 layers and 1..16 positive cutoffs up to 2880 minutes",
        );
    }
    let mut ids = std::collections::HashSet::new();
    for layer in &options.layers {
        if layer.id.trim().is_empty()
            || !ids.insert(&layer.id)
            || layer.counts.len() != destinations
            || layer
                .counts
                .iter()
                .any(|n| !n.0.is_finite() || n.0 < 0. || n.0 > 1e12)
            || !layer.counts.iter().map(|n| n.0).sum::<f64>().is_finite()
        {
            return fail(
                "Opportunity layers need unique nonempty IDs and one finite nonnegative count (at most 1e12) per destination",
            );
        }
    }
    if let Some(thresholds) = &options.dual_thresholds
        && (thresholds.len() > 16 || thresholds.iter().any(|n| !positive(n.0)))
    {
        return fail("dualThresholds must contain at most 16 finite positive opportunity counts");
    }
    let valid = match options
        .decay_function
        .as_ref()
        .unwrap_or(&DecayFunction::Step)
    {
        DecayFunction::Logistic {
            standard_deviation_minutes,
        } => positive(standard_deviation_minutes.0),
        DecayFunction::Linear { width_minutes } => positive(width_minutes.0),
        DecayFunction::FixedExponential { decay_constant } => {
            positive(decay_constant.0) && decay_constant.0 <= 1.
        }
        _ => true,
    };
    if !valid {
        return fail("Invalid accessibility decay parameters");
    }
    Ok(())
}

pub(super) fn summarize(
    options: &AccessibilityOptions,
    times: &[Vec<Value>],
    destinations: usize,
) -> Result<Value> {
    validate(options, destinations)?;
    let decay = options
        .decay_function
        .as_ref()
        .unwrap_or(&DecayFunction::Step);
    let thresholds = options.dual_thresholds.as_deref().unwrap_or(&[]);
    let mut layers = vec![];
    for layer in &options.layers {
        let mut access = vec![];
        let mut dual = vec![];
        for percentile in times {
            let mut access_rows = vec![];
            let mut dual_rows = vec![];
            for row in percentile.chunks_exact(destinations) {
                let row: Vec<f64> = row
                    .iter()
                    .map(|v| v.as_f64().unwrap_or(f64::INFINITY))
                    .collect();
                access_rows.push(
                    options
                        .cutoffs_minutes
                        .iter()
                        .map(|cutoff| {
                            row.iter()
                                .zip(&layer.counts)
                                .map(|(&t, count)| count.0 * weight(decay, t, cutoff.0 * 60.))
                                .sum::<f64>()
                        })
                        .collect::<Vec<_>>(),
                );
                if thresholds.is_empty() {
                    // Preserve the output axes without allocating or sorting
                    // destination times for an unrequested dual indicator.
                    dual_rows.push(Vec::new());
                    continue;
                }
                let mut ordered: Vec<_> = row
                    .iter()
                    .zip(&layer.counts)
                    .filter(|(t, count)| t.is_finite() && count.0 > 0.)
                    .map(|(&t, count)| (t, count.0))
                    .collect();
                ordered.sort_unstable_by(|a, b| a.0.total_cmp(&b.0));
                dual_rows.push(
                    thresholds
                        .iter()
                        .map(|threshold| {
                            let mut count = 0.;
                            for &(time, weight) in &ordered {
                                count += weight;
                                if count >= threshold.0 {
                                    return json!(time);
                                }
                            }
                            Value::Null
                        })
                        .collect::<Vec<_>>(),
                );
            }
            access.push(access_rows);
            dual.push(dual_rows);
        }
        let mut result = json!({"id":layer.id});
        result["access"] = serde_json::to_value(access)?;
        result["dualSeconds"] = Value::Array(
            dual.into_iter()
                .map(|rows| Value::Array(rows.into_iter().map(Value::Array).collect()))
                .collect(),
        );
        layers.push(result);
    }
    let mut result = json!({"method":"destination-percentile-opportunities-v1","decayFunction":decay,
        "cutoffsMinutes":options.cutoffs_minutes,"dualThresholds":thresholds});
    result["layers"] = Value::Array(layers);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use vigo_model::Number;
    #[test]
    fn decay_units_boundaries_and_infinite_times() {
        let families = [
            DecayFunction::Step,
            DecayFunction::Exponential,
            DecayFunction::FixedExponential {
                decay_constant: Number(0.001),
            },
            DecayFunction::Logistic {
                standard_deviation_minutes: Number(5.),
            },
            DecayFunction::Linear {
                width_minutes: Number(10.),
            },
        ];
        for family in &families {
            assert_eq!(weight(family, f64::INFINITY, 1800.), 0.);
            let mut previous = 1.;
            for seconds in (0..7200).step_by(10) {
                let w = weight(family, seconds as f64, 1800.);
                assert!((0. ..=previous).contains(&w));
                previous = w;
            }
        }
        assert_eq!(weight(&DecayFunction::Step, 1800., 1800.), 0.);
        for family in [&families[1], &families[3], &families[4]] {
            assert!((weight(family, 1800., 1800.) - 0.5).abs() < 1e-12);
        }
        assert_eq!(
            weight(&families[2], 100., 600.),
            weight(&families[2], 100., 1800.)
        );
    }
    #[test]
    fn dual_access_keeps_weights_zero_times_and_unreachable_destinations() {
        let options = serde_json::from_value(json!({"layers":[{"id":"jobs","counts":[2,3,100]}],
            "cutoffsMinutes":[1,2],"dualThresholds":[1,5,6]}))
        .unwrap();
        let result = summarize(&options, &[vec![json!(0), json!(60), Value::Null]], 3).unwrap();
        assert_eq!(result["layers"][0]["access"], json!([[[2., 5.]]]));
        assert_eq!(
            result["layers"][0]["dualSeconds"],
            json!([[[0., 60., null]]])
        );
    }

    #[test]
    fn absent_dual_thresholds_preserve_percentile_and_origin_axes() {
        let mut options: AccessibilityOptions = serde_json::from_value(json!({
            "layers":[{"id":"jobs","counts":[2,3,100]},{"id":"schools","counts":[1,4,50]}],
            "cutoffsMinutes":[1,2]}))
        .unwrap();
        let times = vec![
            vec![
                json!(0),
                json!(60),
                Value::Null,
                Value::Null,
                json!(0),
                json!(60),
            ],
            vec![Value::Null; 6],
        ];
        let absent = summarize(&options, &times, 3).unwrap();
        assert_eq!(
            absent["layers"][0]["access"],
            json!([[[2., 5.], [3., 103.]], [[0., 0.], [0., 0.]]])
        );
        assert_eq!(
            absent["layers"][1]["access"],
            json!([[[1., 5.], [4., 54.]], [[0., 0.], [0., 0.]]])
        );
        for layer in absent["layers"].as_array().unwrap() {
            assert_eq!(layer["dualSeconds"], json!([[[], []], [[], []]]));
        }
        options.dual_thresholds = Some(vec![]);
        assert_eq!(summarize(&options, &times, 3).unwrap(), absent);
    }
}
