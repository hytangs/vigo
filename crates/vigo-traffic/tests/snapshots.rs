use serde_json::json;
use vigo_traffic::{Graph, TrafficEngine, ndw::Configuration, timestamp};
const NOW: i64 = 1_792_389_000_000; // tests use an injected clock, never wall time
fn graph() -> Graph<'static> {
    Graph {
        lons: &[5., 5.001, 5.002],
        lats: &[52., 52., 52.],
        offsets: &[0, 1, 2, 2],
        targets: &[1, 2],
        distances: &[6846, 6846],
        times: &[100, 200],
    }
}
fn observation() -> serde_json::Value {
    json!({"observedAt":NOW,"ttlSeconds":300,"snapRadiusMeters":30,"observations":[{"coordinates":[[5.,52.],[5.002,52.]],"travelTimeSeconds":30}]})
}
#[test]
fn multi_edge_time_is_conserved_and_cache_is_immutable() {
    let mut engine = TrafficEngine::default();
    let s = engine.compile(graph(), "graph-a", &observation()).unwrap();
    assert_eq!(s.weights.edge_indices, vec![0, 1]);
    assert_eq!(s.weights.edge_time_units, vec![1000, 2000]);
    assert!(std::sync::Arc::ptr_eq(
        &s,
        &engine.compile(graph(), "graph-a", &observation()).unwrap()
    ));
    let mut next = observation();
    next["observations"][0]["travelTimeSeconds"] = json!(60);
    let newer = engine.compile(graph(), "graph-a", &next).unwrap();
    assert_ne!(s.weights.snapshot_key, newer.weights.snapshot_key);
    assert_eq!(s.weights.edge_time_units, vec![1000, 2000]);
}
#[test]
fn expiry_is_inclusive_and_prepared_cannot_bypass_it() {
    let mut engine = TrafficEngine::default();
    let s = engine.compile(graph(), "g", &observation()).unwrap();
    assert_eq!(s.admit(NOW + 299999).unwrap()["status"], "applied");
    assert_eq!(s.admit(NOW + 300000).unwrap()["status"], "stale_fallback");
    assert!(s.admit(NOW - 60001).is_err());
    let p = s.prepared();
    let p = engine.compile(graph(), "g", &p).unwrap();
    assert_eq!(p.admit(NOW + 300000).unwrap()["status"], "stale_fallback");
    assert_eq!(p.weights.snapshot_key, s.weights.snapshot_key);
    let mut missing = s.prepared();
    missing.as_object_mut().unwrap().remove("observedAt");
    assert!(engine.compile(graph(), "g", &missing).is_err());
}
#[test]
fn empty_and_malformed_prepared_snapshots() {
    let mut engine = TrafficEngine::default();
    let v =
        json!({"observedAt":NOW,"streetSourceFingerprint":"g","edgeIndices":[],"edgeTimeUnits":[]});
    assert_eq!(
        engine
            .compile(graph(), "g", &v)
            .unwrap()
            .admit(NOW)
            .unwrap()["status"],
        "no_matches"
    );
    for change in [
        json!({"edgeIndices":[0]}),
        json!({"edgeIndices":[2],"edgeTimeUnits":[1000]}),
        json!({"edgeIndices":[0],"edgeTimeUnits":[0]}),
        json!({"expiresAt":NOW+1800001}),
        json!({"ttlSeconds":0}),
    ] {
        let mut bad = v.clone();
        bad.as_object_mut()
            .unwrap()
            .extend(change.as_object().unwrap().clone());
        assert!(engine.compile(graph(), "g", &bad).is_err(), "{bad}");
    }
    assert!(engine.compile(graph(), "other", &v).is_err());
}
#[test]
fn direction_and_disconnected_paths_are_not_guessed() {
    let mut v = observation();
    v["observations"][0]["coordinates"] = json!([[5.002, 52.], [5., 52.]]);
    assert_eq!(
        TrafficEngine::default()
            .compile(graph(), "g", &v)
            .unwrap()
            .matched_observations,
        0
    );
    let g = Graph {
        offsets: &[0, 1, 1, 1],
        targets: &[1],
        distances: &[6846],
        times: &[100],
        ..graph()
    };
    assert_eq!(
        TrafficEngine::default()
            .compile(g, "g", &observation())
            .unwrap()
            .matched_observations,
        0
    );
}
#[test]
fn parallel_roads_and_equal_forks_are_rejected() {
    let g = Graph {
        lons: &[5., 5.001, 5.002, 5., 5.001, 5.002],
        lats: &[52., 52., 52., 52.00001, 52.00001, 52.00001],
        offsets: &[0, 1, 2, 2, 3, 4, 4],
        targets: &[1, 2, 4, 5],
        distances: &[6846; 4],
        times: &[100; 4],
    };
    let s = TrafficEngine::default()
        .compile(g, "g", &observation())
        .unwrap();
    assert_eq!(s.matched_observations, 0);
    assert_eq!(s.rejected["ambiguous_path"], 1);
    let g = Graph {
        lons: &[5., 5.001, 5.001, 5.002],
        lats: &[52.; 4],
        offsets: &[0, 2, 3, 4, 4],
        targets: &[1, 2, 3, 3],
        distances: &[6846; 4],
        times: &[100; 4],
    };
    assert_eq!(
        TrafficEngine::default()
            .compile(g, "g", &observation())
            .unwrap()
            .matched_observations,
        0
    );
}
#[test]
fn overlap_is_maximum_closure_wins_and_ids_are_content_based() {
    let mut engine = TrafficEngine::default();
    let v = json!({"observedAt":NOW,"streetSourceFingerprint":"g","observations":[{"edgeIndices":[0],"delayFactor":3},{"edgeIndices":[0],"closed":true}]});
    let s = engine.compile(graph(), "g", &v).unwrap();
    assert_eq!(s.weights.edge_time_units, vec![vigo_traffic::CLOSED]);
    let mut swapped = v.clone();
    swapped["observations"].as_array_mut().unwrap().reverse();
    swapped["observedAt"] = json!(NOW + 1000);
    assert_eq!(
        s.weights.snapshot_key,
        engine
            .compile(graph(), "g", &swapped)
            .unwrap()
            .weights
            .snapshot_key
    );
}
const SITES: &str = include_str!("fixtures/sites.xml");
const MEASURES: &str = include_str!("fixtures/measurements.xml");
fn ndw_now() -> i64 {
    timestamp(&json!("2026-10-19T06:07:00Z")).unwrap()
}
#[test]
fn ndw_join_coordinates_units_and_time() {
    let config = Configuration::read(SITES.as_bytes()).unwrap();
    assert_eq!(config.site_count(), 1);
    let batch = config.ingest(MEASURES.as_bytes(), ndw_now(), 300).unwrap();
    assert_eq!(batch.observations.len(), 1);
    assert_eq!(
        batch.observations[0]["coordinates"],
        json!([[5., 52.], [5.002, 52.]])
    );
    let s = TrafficEngine::default()
        .compile(graph(), "g", &batch.snapshot("g"))
        .unwrap();
    assert_eq!(s.weights.edge_time_units, vec![1000, 2000]);
    assert_eq!(
        s.admit(ndw_now() + 240000).unwrap()["status"],
        "stale_fallback"
    );
}
#[test]
fn ndw_rejects_stale_versions_indices_errors_forecasts_and_missing_values() {
    let config = Configuration::read(SITES.as_bytes()).unwrap();
    for xml in [
        MEASURES.replace("version=\"7\"", "version=\"8\""),
        MEASURES.replace("index=\"1\"", "index=\"2\""),
        MEASURES.replace("accuracy=\"100\"", "accuracy=\"100\" dataError=\"true\""),
        MEASURES.replace("<roa:duration>30", "<roa:duration>-1"),
        MEASURES.replace(
            "<roa:travelTimeType>",
            "<roa:forecast>true</roa:forecast><roa:travelTimeType>",
        ),
    ] {
        let b = config.ingest(xml.as_bytes(), ndw_now(), 300).unwrap();
        assert!(b.observations.is_empty());
        assert!(!b.rejected.is_empty());
    }
    assert!(
        config
            .ingest(MEASURES.as_bytes(), ndw_now() + 240000, 300)
            .unwrap()
            .observations
            .is_empty()
    );
    assert!(
        config
            .ingest(
                MEASURES.replace("TEST_TRAVELTIME", "OTHER").as_bytes(),
                ndw_now(),
                300
            )
            .is_err()
    );
}
#[test]
fn ndw_namespaces_dtd_and_duplicates() {
    let renamed = SITES
        .replace("roa:", "r:")
        .replace("xmlns:roa=", "xmlns:r=");
    assert_eq!(
        Configuration::read(renamed.as_bytes())
            .unwrap()
            .site_count(),
        1
    );
    assert!(
        Configuration::read(
            SITES
                .replace("schema/3/roadTrafficData", "schema/2/roadTrafficData")
                .as_bytes()
        )
        .is_err()
    );
    assert!(
        Configuration::read(
            SITES
                .replace(
                    "<?xml version=\"1.0\"?>",
                    "<!DOCTYPE x [<!ENTITY x SYSTEM 'file:///etc/passwd'>]>"
                )
                .as_bytes()
        )
        .is_err()
    );
    assert!(
        Configuration::read(
            SITES
                .replace(
                    "</roa:measurementSiteTable>",
                    &format!(
                        "{} </roa:measurementSiteTable>",
                        SITES
                            .split("<roa:measurementSite id=")
                            .nth(1)
                            .unwrap()
                            .split("</roa:measurementSite>")
                            .next()
                            .map(|x| format!("<roa:measurementSite id={x}</roa:measurementSite>"))
                            .unwrap()
                    )
                )
                .as_bytes()
        )
        .is_err()
    );
}

#[test]
fn ndw_all_stale_retains_observation_age_instead_of_download_time() {
    let c = Configuration::read(SITES.as_bytes()).unwrap();
    let now = ndw_now() + 600000;
    let batch = c.ingest(MEASURES.as_bytes(), now, 300).unwrap();
    assert!(batch.observations.is_empty());
    let s = TrafficEngine::default()
        .compile(graph(), "g", &batch.snapshot("g"))
        .unwrap();
    assert_eq!(s.admit(now).unwrap()["status"], "stale_fallback");
    assert_eq!(s.freshness.observed_at, ndw_now() - 60000);
}
#[test]
fn ndw_rejects_point_lane_and_class_specific_measurements() {
    for xml in [
        SITES.replace("<com:vehicleType>anyVehicle", "<com:vehicleType>lorry"),
        SITES.replace(
            "<roa:period>",
            "<roa:specificLane>lane1</roa:specificLane><roa:period>",
        ),
        SITES.replace("loc:posList", "loc:pointCoordinates"),
        SITES.replace("index=\"0\"", "index=\"2\""),
    ] {
        let c = Configuration::read(xml.as_bytes()).unwrap();
        assert_eq!(c.site_count(), 0);
        assert!(!c.rejected.is_empty());
    }
}
#[test]
fn timestamp_aliases_and_precision_are_consistent() {
    let s = timestamp(&json!("2026-10-19T06:07:00.000396315Z")).unwrap();
    assert_eq!(s, ndw_now());
    assert_eq!(timestamp(&json!(s / 1000)).unwrap(), s);
    assert_eq!(timestamp(&json!(s)).unwrap(), s);
    let mut v = observation();
    v.as_object_mut().unwrap().remove("observedAt");
    v["fetchedAt"] = json!(NOW);
    assert_eq!(
        TrafficEngine::default()
            .compile(graph(), "g", &v)
            .unwrap()
            .freshness
            .observed_at,
        NOW
    );
}

#[test]
fn curved_path_cannot_cut_a_corner_within_the_endpoint_radius() {
    // The diagonal is shorter and inside a 120 m search radius, but it does
    // not follow the provider's bend. Only the two-edge L path is admissible.
    let g = Graph {
        lons: &[5., 5.0015, 5.0015],
        lats: &[52., 52., 52.001],
        offsets: &[0, 2, 3, 3],
        targets: &[1, 2, 2],
        distances: &[10269, 15137, 11120],
        times: &[100, 150, 100],
    };
    let v = json!({"observedAt":NOW,"observations":[{"coordinates":[[5.,52.],[5.0015,52.],[5.0015,52.001]],"closed":true}]});
    let s = TrafficEngine::default().compile(g, "g", &v).unwrap();
    assert_eq!(s.weights.edge_indices, vec![0, 2]);
}
#[test]
fn retained_memory_is_lazy_and_bounded_for_repeated_snapshots() {
    let mut e = TrafficEngine::default();
    assert_eq!(e.estimated_heap_bytes(), 0);
    e.compile(graph(), "g", &observation()).unwrap();
    let size = e.estimated_heap_bytes();
    assert!(size > 0);
    for i in 0..100 {
        let mut v = observation();
        v["observedAt"] = json!(NOW + i * 1000);
        e.compile(graph(), "g", &v).unwrap();
    }
    assert_eq!(e.estimated_heap_bytes(), size);
}

#[test]
fn xml_character_references_do_not_change_coordinates_or_costs() {
    let xml = SITES
        .replace("52 5 52 5.002", " 52 &#53; 52 5.002 ")
        .replace(">real<", "> real <");
    let config = Configuration::read(xml.as_bytes()).unwrap();
    let input = MEASURES.replace("<roa:duration>30", "<roa:duration>&#51;0");
    let batch = config.ingest(input.as_bytes(), ndw_now(), 300).unwrap();
    assert_eq!(
        batch.observations[0]["coordinates"],
        json!([[5., 52.], [5.002, 52.]])
    );
    assert_eq!(batch.observations[0]["travelTimeSeconds"], 30.);
    assert!(
        config
            .ingest(
                MEASURES
                    .replace("<roa:duration>30", "<roa:duration>&unknown;0")
                    .as_bytes(),
                ndw_now(),
                300
            )
            .is_err()
    );
}

#[test]
fn dense_shape_vertices_are_one_chain_but_parallel_roads_still_reject() {
    let n = 100usize;
    let mut lons = Vec::new();
    let mut lats = Vec::new();
    let mut offsets = vec![0];
    let mut targets = Vec::new();
    for road in 0..2 {
        for i in 0..n {
            lons.push(5. + i as f64 * 0.00003);
            lats.push(52. + road as f64 * 0.00001);
            if i + 1 < n {
                targets.push((road * n + i + 1) as u32);
            }
            offsets.push(targets.len() as u32);
        }
    }
    let distances = vec![205; targets.len()];
    let times = vec![100; targets.len()];
    let g = Graph {
        lons: &lons,
        lats: &lats,
        offsets: &offsets,
        targets: &targets,
        distances: &distances,
        times: &times,
    };
    let observation = json!({"observedAt":NOW,"observations":[{"coordinates":[[5.,52.],[5.00297,52.]],"delayFactor":2}]});
    let one = Graph {
        lons: &lons[..n],
        lats: &lats[..n],
        offsets: &offsets[..=n],
        targets: &targets[..n - 1],
        distances: &distances[..n - 1],
        times: &times[..n - 1],
    };
    let result = TrafficEngine::default()
        .compile(one, "one", &observation)
        .unwrap();
    assert_eq!(result.matched_observations, 1);
    assert_eq!(result.weights.edge_indices.len(), n - 1);
    let result = TrafficEngine::default()
        .compile(g, "parallel", &observation)
        .unwrap();
    assert_eq!(result.matched_observations, 0);
    assert_eq!(result.rejected["ambiguous_path"], 1);
}

#[test]
fn off_city_measurements_do_not_shorten_local_freshness() {
    let local = SITES
        .split("<roa:measurementSite id=")
        .nth(1)
        .unwrap()
        .split("</roa:measurementSite>")
        .next()
        .unwrap();
    let outside = format!(
        "<roa:measurementSite id={}</roa:measurementSite>",
        local
            .replace("TEST01", "OUTSIDE")
            .replace("52 5 52 5.002", "53 6 53 6.002")
    );
    let xml = SITES.replace(
        "</roa:measurementSiteTable>",
        &format!("{outside}</roa:measurementSiteTable>"),
    );
    let mut config = Configuration::read(xml.as_bytes()).unwrap();
    assert_eq!(config.site_count(), 2);
    config.retain_near(&[5., 5.002], &[52., 52.], 120.).unwrap();
    assert_eq!(config.site_count(), 1);
    assert_eq!(config.excluded_site_count(), 1);
    let record = MEASURES
        .split("<roa:siteMeasurements>")
        .nth(1)
        .unwrap()
        .split("</roa:siteMeasurements>")
        .next()
        .unwrap();
    let outside = format!(
        "<roa:siteMeasurements>{}</roa:siteMeasurements>",
        record
            .replace("TEST01", "OUTSIDE")
            .replace("06:06:00", "06:04:00")
    );
    let measurements = MEASURES.replace("</mc:payload>", &format!("{outside}</mc:payload>"));
    let result = config
        .ingest(measurements.as_bytes(), ndw_now(), 300)
        .unwrap();
    assert_eq!(result.observations.len(), 1);
    assert_eq!(result.rejected["out_of_city_site"], 1);
    assert_eq!(result.observed_at, ndw_now() - 60_000);
}

#[test]
fn traffic_rejects_non_objects_before_field_validation() {
    for value in [
        json!([]),
        json!(null),
        json!(false),
        json!(42),
        json!("traffic"),
    ] {
        let error = TrafficEngine::default()
            .compile(graph(), "g", &value)
            .unwrap_err();
        assert_eq!(error, "traffic must be an object");
    }
}

#[test]
fn traffic_rejects_unrepresentable_timestamps_without_panicking() {
    for value in [
        json!(9_223_372_036_854_774_784_i64),
        json!(9e18),
        json!("9e18"),
    ] {
        assert!(timestamp(&value).is_err(), "{value}");
        let request = json!({"observedAt": value, "observations": []});
        assert!(
            TrafficEngine::default()
                .compile(graph(), "g", &request)
                .is_err()
        );
    }
}
