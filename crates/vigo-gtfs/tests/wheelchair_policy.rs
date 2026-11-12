//! Wheelchair boarding inheritance and pathway pricing, ported from
//! test/check-wheelchair-routing.mjs with the same inputs and expectations.
//! JavaScript rows held numbers; CSV rows hold their decimal text.
use std::collections::HashMap;
use vigo_gtfs::store::policy::{
    WheelchairStop, wheelchair_boarding_values, wheelchair_pathway_cost,
};
use vigo_gtfs::zip::{Header, Row};

/// `wheelchairPathwayCost(row, options)` as `(seconds, provenance)`.
fn cost(
    fields: &[(&str, &str)],
    accessible_endpoints: bool,
    same_level: bool,
) -> Option<(f64, &'static str)> {
    // Later fields override earlier ones, as object spreads do.
    let mut names: Vec<String> = Vec::new();
    let mut values: Vec<String> = Vec::new();
    for (name, value) in fields {
        match names.iter().position(|n| n == name) {
            Some(index) => values[index] = (*value).to_owned(),
            None => {
                names.push((*name).to_owned());
                values.push((*value).to_owned());
            }
        }
    }
    let header = Header { names };
    let row = Row {
        header: &header,
        values,
    };
    wheelchair_pathway_cost(&row, accessible_endpoints, same_level)
        .unwrap()
        .map(|cost| (cost.seconds, cost.provenance))
}

fn seconds(fields: &[(&str, &str)], accessible_endpoints: bool, same_level: bool) -> Option<f64> {
    cost(fields, accessible_endpoints, same_level).map(|(seconds, _)| seconds)
}

#[test]
fn boarding_values_inherit_unknown_values_from_parents() {
    let stop = |boarding: f64, parent: Option<&str>| WheelchairStop {
        parent: parent.map(str::to_owned),
        level: String::new(),
        boarding,
    };
    let order: Vec<String> = ["child", "parent", "denied", "unknown"]
        .map(str::to_owned)
        .to_vec();
    let stops = HashMap::from([
        ("child".to_owned(), stop(0.0, Some("parent"))),
        ("parent".to_owned(), stop(1.0, None)),
        ("denied".to_owned(), stop(2.0, Some("parent"))),
        ("unknown".to_owned(), stop(0.0, None)),
    ]);
    assert_eq!(
        wheelchair_boarding_values(&order, &stops).unwrap(),
        [
            ("child".to_owned(), 1.0),
            ("parent".to_owned(), 1.0),
            ("denied".to_owned(), 2.0),
            ("unknown".to_owned(), 0.0)
        ]
    );
    let cyclic = HashMap::from([
        ("a".to_owned(), stop(0.0, Some("b"))),
        ("b".to_owned(), stop(0.0, Some("a"))),
    ]);
    let error = wheelchair_boarding_values(&["a".to_owned(), "b".to_owned()], &cyclic).unwrap_err();
    assert!(error.to_string().contains("Cyclic"), "{error}");
}

#[test]
fn pathway_costs_follow_the_wheelchair_profile() {
    for row in [
        &[("pathway_mode", "2"), ("wheelchair_traversal_time", "20")][..],
        &[("pathway_mode", "4"), ("wheelchair_traversal_time", "20")],
        &[("pathway_mode", "1"), ("traversal_time", "20")],
        &[("pathway_mode", "5"), ("wheelchair_traversal_time", "-1")],
        &[
            ("pathway_mode", "1"),
            ("wheelchair_traversal_time", "20"),
            ("stair_count", "-1"),
        ],
        &[
            ("pathway_mode", "1"),
            ("wheelchair_traversal_time", "20"),
            ("max_slope", "-0.2"),
        ],
    ] {
        assert_eq!(seconds(row, false, false), None, "{row:?}");
    }
    assert_eq!(
        seconds(
            &[("pathway_mode", "5"), ("wheelchair_traversal_time", "40")],
            false,
            false
        ),
        Some(40.0)
    );
    assert_eq!(
        seconds(
            &[("pathway_mode", "1"), ("wheelchair_length", "40")],
            false,
            false
        ),
        Some(30.0)
    );
    for row in [
        &[("pathway_mode", "2"), ("wheelchair_length", "40")][..],
        &[("pathway_mode", "5"), ("wheelchair_length", "40")],
        &[
            ("pathway_mode", "1"),
            ("wheelchair_length", "40"),
            ("stair_count", "1"),
        ],
        &[
            ("pathway_mode", "1"),
            ("wheelchair_length", "40"),
            ("max_slope", "0.2"),
        ],
        &[
            ("pathway_mode", "1"),
            ("wheelchair_length", "40"),
            ("min_width", "0.5"),
        ],
        &[("pathway_mode", "1"), ("wheelchair_length", "0")],
        &[("pathway_mode", "1"), ("wheelchair_length", "-1")],
        &[("pathway_mode", "1"), ("wheelchair_length", "invalid")],
        &[("pathway_mode", "6")],
    ] {
        assert_eq!(seconds(row, false, false), None, "{row:?}");
    }
    assert_eq!(
        seconds(
            &[
                ("pathway_mode", "1"),
                ("traversal_time", "15"),
                ("max_slope", "0.02"),
                ("min_width", "1.2")
            ],
            false,
            false
        ),
        Some(15.0)
    );
}

#[test]
fn zero_wheelchair_length_walkways_keep_their_walk_length() {
    let walk = [
        ("pathway_mode", "1"),
        ("wheelchair_length", "0"),
        ("length", "20"),
    ];
    assert_eq!(
        cost(&walk, true, true),
        Some((15.0, "gtfs_pathway_estimated"))
    );
    for (accessible, same_level) in [(false, false), (true, false), (false, true)] {
        assert_eq!(seconds(&walk, accessible, same_level), None);
    }
    for denied in [
        ("length", "0"),
        ("length", ""),
        ("length", "invalid"),
        ("wheelchair_length", "-1"),
        ("wheelchair_traversal_time", "-1"),
        ("pathway_mode", "2"),
        ("pathway_mode", "5"),
        ("min_width", "0.5"),
        ("max_slope", "0.2"),
    ] {
        let mut row = walk.to_vec();
        row.push(denied);
        assert_eq!(seconds(&row, true, true), None, "{denied:?}");
    }
}

#[test]
fn accessible_fare_gates_use_published_time_or_an_estimate() {
    for mode in ["6", "7"] {
        assert_eq!(
            cost(&[("pathway_mode", mode)], true, false),
            Some((5.0, "gtfs_pathway_estimated"))
        );
        assert_eq!(
            cost(
                &[("pathway_mode", mode), ("traversal_time", "12")],
                true,
                false
            ),
            Some((12.0, "gtfs_pathway"))
        );
        assert_eq!(seconds(&[("pathway_mode", mode)], false, false), None);
        for denied in [
            ("min_width", "0.5"),
            ("max_slope", "0.2"),
            ("stair_count", "1"),
            ("wheelchair_traversal_time", "-1"),
            ("wheelchair_length", "-1"),
            ("traversal_time", "invalid"),
        ] {
            assert_eq!(
                seconds(&[("pathway_mode", mode), denied], true, false),
                None,
                "{mode} {denied:?}"
            );
        }
    }
    for mode in ["1", "2", "4", "5"] {
        assert_eq!(
            seconds(&[("pathway_mode", mode)], true, false),
            None,
            "Accessible nodes cannot turn unknown walkways, stairs, escalators or elevators into usable paths"
        );
    }
}
