//! Departure-window distributions. Only per-destination observations are
//! retained; resident street and timetable indexes are reused across draws.
use super::{City, Result, fail};
use serde::Deserialize;
use serde_json::{Value, json};

const MAX_OBSERVATIONS: usize = 8 * 1024 * 1024; // 64 MiB of f64 observations.

fn rank(percentile: u8, count: usize) -> usize {
    (usize::from(percentile) * count)
        .div_ceil(100)
        .saturating_sub(1)
        .min(count - 1)
}

impl City {
    pub(super) fn monte_carlo(
        &mut self,
        command: &str,
        request: &Value,
        detailed: bool,
    ) -> Result<Value> {
        // Restore ordinary routing even when a sample fails. No realization is
        // persisted in the City or leaks into the next resident-stream query.
        let result = self.monte_carlo_inner(command, request, detailed);
        self.frequency_sample = None;
        self.pinned_timetable = false;
        if let Some(t) = &self.timetable {
            t.kernel.set_frequency_sample(None);
        }
        result
    }

    fn monte_carlo_inner(
        &mut self,
        command: &str,
        request: &Value,
        detailed: bool,
    ) -> Result<Value> {
        let started = std::time::Instant::now();
        if !matches!(command, "route" | "matrix" | "reach" | "isochrone") {
            return fail("monteCarlo supports Route, Matrix and Reach");
        }
        crate::presentation::validate(request)?;
        self.validate_wheelchair_request(request)?;
        // Deserialize borrowed input: opportunity counts can be large, and an
        // intermediate clone of their JSON tree serves no routing purpose.
        let options = vigo_model::MonteCarloOptions::deserialize(&request["monteCarlo"])?;
        if options.start_minutes >= options.end_minutes || options.end_minutes > 1440 {
            return fail("monteCarlo requires 0 <= startMinutes < endMinutes <= 1440");
        }
        let requested = options.draws.unwrap_or(200);
        if !(1..=10_000).contains(&requested) {
            return fail("monteCarlo.draws must be in 1..10000");
        }
        let percentiles = options.percentiles.unwrap_or(vec![5, 25, 50, 75, 95]);
        if percentiles.is_empty()
            || percentiles.len() > 21
            || percentiles.iter().any(|&p| p > 100)
            || percentiles.windows(2).any(|w| w[0] >= w[1])
        {
            return fail("monteCarlo.percentiles must contain 1..21 increasing integers in 0..100");
        }
        for key in [
            "allDay",
            "time",
            "timeMinutes",
            "departNow",
            "surfaceReuse",
            "realtimeSnapshot",
            "traffic",
            "flex",
            "via",
            "waypoints",
            "windowMinutes",
            "windowStepMinutes",
            "windowChoices",
            "sharedLegs",
            "alternatives",
            "alternativeRanking",
            "alternativeSlackMinutes",
            "journeyPolicy",
            "expandedWalkKm",
            "includeEarliestTransit",
            "arrivalBufferMinutes",
            "arrayEncoding",
        ] {
            if request.get(key).is_some() {
                return fail(format!("{key} does not apply to monteCarlo routing"));
            }
        }
        if request["mode"].as_str().unwrap_or("transit") != "transit"
            || !matches!(
                request["timePreference"].as_str(),
                None | Some("depart" | "depart_at")
            )
            || request
                .get("routingDataMode")
                .or_else(|| request.get("dataMode"))
                .is_some_and(|v| v != "scheduled")
        {
            return fail("monteCarlo requires scheduled depart-at transit routing");
        }
        if request["includeJourneys"] == true
            || request["includeGeometry"] == true
            || request["includeNodes"] == true
            || request["includeStreetEdges"] == true
        {
            return fail(
                "monteCarlo returns distributions; per-sample geometry and journey evidence are unsupported",
            );
        }
        let surface = matches!(command, "reach" | "isochrone");
        if surface
            && request["reachFormat"]
                .as_str()
                .is_some_and(|v| v != "surface")
        {
            return fail("monteCarlo Reach requires reachFormat surface");
        }
        let mut q = Value::Object(
            request
                .as_object()
                .ok_or("Request must be an object")?
                .iter()
                .filter(|(key, _)| {
                    !matches!(
                        key.as_str(),
                        "monteCarlo" | "diagnostics" | "includeLimitations"
                    )
                })
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect(),
        );
        crate::presentation::normalize_points(&mut q)?;
        let o = q.as_object_mut().ok_or("Request must be an object")?;
        let scenario = o.remove("scenario");
        if let Some(s) = &scenario {
            self.validate_scenario(s)?;
            if s.get("flexZones")
                .is_some_and(|v| !v.as_array().is_some_and(Vec::is_empty))
            {
                return fail("Monte Carlo scenario Flex zones are not supported");
            }
        }
        if command == "route" {
            o.remove("includeGeometry");
        }
        super::query::validate_request(command, &q, self.polling_enabled, self.live.is_some())?;
        if q.get("routingDataMode").is_none() && q.get("dataMode").is_none() {
            q["routingDataMode"] = json!("scheduled");
        }
        // Cover the last departure before pinning a view: otherwise a window
        // crossing a prepared coverage boundary can lose next-day trips.
        q["timeMinutes"] = json!(options.end_minutes - 1);
        if command == "route" {
            q["origins"] = json!([q["origin"]]);
            q["destinations"] = json!([q["destination"]]);
            let o = q.as_object_mut().unwrap();
            o.remove("origin");
            o.remove("destination");
        }
        if surface {
            q["reachFormat"] = json!("surface");
        } else {
            q["includeJourneys"] = json!(false);
            q["includeGeometry"] = json!(false);
        }
        let destinations = if surface {
            let size = super::number(&q, "rasterSize", 96., 16., 1024.)?;
            if size.fract() != 0. {
                return fail("rasterSize must be an integer");
            }
            let size = size as usize;
            size * size
        } else {
            q["destinations"]
                .as_array()
                .ok_or("destinations must be an array")?
                .len()
        };
        let origins = if surface {
            1
        } else {
            q["origins"]
                .as_array()
                .ok_or("origins must be an array")?
                .len()
        };
        let output_width = origins.saturating_mul(destinations);
        if !surface && (output_width == 0 || output_width > 65_536) {
            return fail("Matrix must contain 1..65536 pairs");
        }
        if output_width.saturating_mul(percentiles.len()) > 1_000_000 {
            return fail(
                "monteCarlo output exceeds one million percentile values; reduce destinations or percentiles",
            );
        }
        if let Some(options) = &options.accessibility {
            super::accessibility::validate(options, destinations)?;
            if options.layers.len()
                * percentiles.len()
                * origins
                * (options.cutoffs_minutes.len()
                    + options.dual_thresholds.as_ref().map_or(0, Vec::len))
                > 1_000_000
            {
                return fail(
                    "Accessibility output exceeds one million indicators; reduce layers, origins, cutoffs or percentiles",
                );
            }
        }
        self.ensure_pedestrian_hierarchy()?;
        self.activate(&q)?;
        if let Some(scenario) = &scenario {
            self.frequency_sample = Some((u64::from(options.seed.unwrap_or(0)), 0));
            self.install_scenario(scenario, &q)?;
        }
        self.pinned_timetable = true;
        let search_end = if surface {
            f64::from(options.end_minutes - 1) * 60.
                + q["cutoffsMinutes"].as_array().map_or(60., |a| {
                    a.iter().filter_map(Value::as_f64).fold(0., f64::max)
                }) * 60.
        } else {
            super::query::Options::parse(&q)?.end
        };
        let stochastic = self
            .timetable
            .as_ref()
            .unwrap()
            .kernel
            .has_frequency_service_between(f64::from(options.start_minutes) * 60., search_end);
        let minutes = options.end_minutes - options.start_minutes;
        let per_minute = if stochastic {
            requested.div_ceil(minutes)
        } else {
            1
        };
        let count = (minutes * per_minute) as usize;
        let seed = options.seed.unwrap_or(0);
        let plan = if surface {
            None
        } else {
            Some(self.sample_matrix_plan(&q, MAX_OBSERVATIONS / count)?)
        };
        let width = plan.as_ref().map_or(destinations, |p| p.width);
        let capacity = width.checked_mul(count).filter(|&n| n <= MAX_OBSERVATIONS)
            .ok_or("monteCarlo exceeds the 64 MiB observation limit; reduce pairs, rasterSize or draws")?;
        let mut observations = vec![f64::INFINITY; capacity];
        let mut grid = Value::Null;
        let warnings = self.metadata["routingLimitations"].clone();
        let mut sample = 0usize;
        for minute in options.start_minutes..options.end_minutes {
            q["timeMinutes"] = json!(minute);
            for _ in 0..per_minute {
                self.frequency_sample = stochastic.then_some((u64::from(seed), sample as u64));
                self.apply_transfer_buffer(&q)?;
                // Activation applies this realization to any reused or newly
                // activated timetable; all OD pairs see that same schedule.
                let (values, current_grid) = if let Some(plan) = &plan {
                    (
                        self.sample_matrix(plan, &super::query::Options::parse(&q)?)?,
                        Value::Null,
                    )
                } else {
                    let raw = self.reach_sample(&q)?;
                    let values = raw["surface"]["values"]
                        .as_array()
                        .ok_or("Missing Reach raster")?
                        .iter()
                        .map(|v| v.as_f64().map(|m| m * 60.).unwrap_or(f64::INFINITY))
                        .collect();
                    (
                        values,
                        json!({"width":raw["surface"]["width"],
                    "height":raw["surface"]["height"],"bounds":raw["surface"]["bounds"],
                    "sampling":raw["surface"]["sampling"]}),
                    )
                };
                if sample == 0 {
                    grid = current_grid.clone();
                }
                if values.len() != width || current_grid != grid {
                    return fail("Destination layout changed during monteCarlo aggregation");
                }
                for (i, value) in values.into_iter().enumerate() {
                    if value.is_finite() && value >= 0. {
                        observations[i * count + sample] = value;
                    }
                }
                sample += 1;
            }
        }
        let mut durations = vec![Vec::with_capacity(width); percentiles.len()];
        let mut reachable = Vec::with_capacity(width);
        for row in observations.chunks_exact_mut(count) {
            row.sort_unstable_by(f64::total_cmp);
            reachable.push(row.partition_point(|v| v.is_finite()));
            for (p, values) in percentiles.iter().zip(&mut durations) {
                let value = row[rank(*p, count)];
                values.push(if value.is_finite() {
                    json!(value)
                } else {
                    Value::Null
                });
            }
        }
        let observation_bytes = observations.len() * 8;
        drop(observations);
        if let Some(plan) = &plan {
            for values in &mut durations {
                *values = plan.cells.iter().map(|&i| values[i].clone()).collect();
            }
            reachable = plan.cells.iter().map(|&i| reachable[i]).collect();
        }
        let layout = if surface {
            grid
        } else {
            json!({"origins":q["origins"], "destinations":q["destinations"],
            "rows":q["origins"].as_array().unwrap().len(), "columns":q["destinations"].as_array().unwrap().len(), "order":"row-major"})
        };
        let mut provenance = request.clone();
        crate::presentation::normalize_points(&mut provenance)?;
        for key in ["id", "kind", "diagnostics", "includeLimitations"] {
            provenance.as_object_mut().unwrap().remove(key);
        }
        let mut fingerprint_input =
            json!({"kind":command,"cityRevision":self.manifest["revisionId"]});
        fingerprint_input["query"] = provenance;
        let fingerprint = crate::presentation::digest(&fingerprint_input);
        let provenance = fingerprint_input
            .as_object_mut()
            .unwrap()
            .remove("query")
            .unwrap();
        let accessibility = options
            .accessibility
            .as_ref()
            .map(|options| super::accessibility::summarize(options, &durations, destinations))
            .transpose()?;
        let mut result = json!({"schema":"vigo.distribution.v1", "status":"ok", "kind":if surface { "reach" } else { command },
            "meta":{"engineVersion":env!("CARGO_PKG_VERSION"),"cityRevision":self.manifest["revisionId"],
                "requestId":request.get("id").cloned().unwrap_or_else(||json!(crate::presentation::request_id())),
                "queryFingerprint":fingerprint,"computeUs":started.elapsed().as_micros() as u64,
                "computeScope":"query_dispatch_including_materialization"},
            "sampling":{"method":"frequency-phase-v1","seed":seed,"stochastic":stochastic,"requestedDraws":requested,
                "sampleCount":count,"departureMinutes":minutes,"samplesPerMinute":per_minute,"stepMinutes":1,
                "quantileMethod":"nearest-rank","unreachable":"positive-infinity","observationBytes":observation_bytes},
            "percentiles":percentiles,"reachableSamples":reachable,
            "assumptions":["Published trips operate on time; frequency entries receive uniform integer-second phases, independently unless explicitly coordinated with phaseFrom.",
                "Percentiles describe departure-time and unknown-schedule variation, not observed operational reliability."],
            "timing":{"totalMs":started.elapsed().as_secs_f64()*1000.}});
        // json! serializes expressions by reference. Move the large owned values
        // into the response so materialization does not duplicate the raster.
        result["query"] = provenance;
        result["layout"] = layout;
        result["durationsSeconds"] =
            Value::Array(durations.into_iter().map(Value::Array).collect());
        result["warnings"] = warnings;
        if let Some(accessibility) = accessibility {
            result["accessibility"] = accessibility;
        }
        Ok(if detailed {
            let mut envelope = json!({"schema":"vigo.stream.detail.v1","status":"ok"});
            envelope["trace"] = result;
            envelope
        } else {
            result
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn nearest_rank_keeps_unreachable_mass_and_endpoints() {
        let values = [10., 20., f64::INFINITY, f64::INFINITY];
        assert_eq!(values[rank(0, 4)], 10.);
        assert_eq!(values[rank(50, 4)], 20.);
        assert!(values[rank(75, 4)].is_infinite());
        assert!(values[rank(100, 4)].is_infinite());
    }
}
