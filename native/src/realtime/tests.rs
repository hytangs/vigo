use super::*;

fn ids(values: &[&str]) -> Arc<[String]> {
    values.iter().map(|s| s.to_string()).collect()
}
fn names(stops: &[&str], trips: usize) -> TimetableNames {
    let trip_ids: Vec<_> = (0..trips).map(|i| format!("T{i}")).collect();
    TimetableNames::new(
        ids(stops),
        trip_ids.into(),
        vec!["R".to_string(); trips].into(),
        vec!["0".to_string(); trips].into(),
        vec![String::new(); trips].into(),
    )
}

// A four-call trip in whole minutes: stops A..D at sequences 10..40, with a
// five-minute dwell at B.
const ROWS: [(u32, f64, f64); 4] = [
    (0, 600., 600.),
    (1, 610., 615.),
    (2, 625., 625.),
    (3, 635., 635.),
];
fn calls(rows: &[(u32, f64, f64)], sequences: &[f64]) -> Vec<RealtimeCallInput> {
    rows.iter()
        .zip(sequences)
        .map(
            |(&(stop, arrival, departure), &sequence)| RealtimeCallInput {
                stop,
                arrival: arrival * 60.,
                departure: departure * 60.,
                sequence,
                can_board: true,
                can_alight: true,
            },
        )
        .collect()
}
// Predicted calls in a comparable form.
#[derive(Debug, PartialEq)]
struct Call {
    stop: u32,
    arrival: f64,
    departure: f64,
    sequence: f64,
}
type Resolved = std::result::Result<(Vec<Call>, usize), Rejection>;
fn resolved(result: std::result::Result<(Vec<RealtimeCallInput>, usize), Rejection>) -> Resolved {
    result.map(|(calls, omitted)| {
        let calls = calls
            .into_iter()
            .map(|c| Call {
                stop: c.stop,
                arrival: c.arrival,
                departure: c.departure,
                sequence: c.sequence,
            })
            .collect();
        (calls, omitted)
    })
}
const ABCD: [&str; 4] = ["A", "B", "C", "D"];
const SEQUENCES: [f64; 4] = [10., 20., 30., 40.];
fn resolve_with(
    rows: &[(u32, f64, f64)],
    sequences: &[f64],
    stops: &[&str],
    update: Value,
) -> Resolved {
    let stops: Vec<_> = stops.iter().map(|s| s.to_string()).collect();
    // Service seconds here equal epoch seconds, so expected values are explicit.
    let clock = |epoch: i64| Some(epoch as f64);
    resolved(predict(
        calls(rows, sequences),
        &stops,
        &update,
        &clock,
        None,
        &mut 0,
    ))
}
fn resolve(stop_time_updates: Value, delay: Option<Value>) -> Resolved {
    let mut update = json!({"stopTimeUpdates":stop_time_updates});
    if let Some(delay) = delay {
        update["delaySeconds"] = delay;
    }
    resolve_with(&ROWS, &SEQUENCES, &ABCD, update)
}
fn minutes(result: Resolved) -> Vec<[f64; 2]> {
    let (calls, _) = result.expect("ready");
    calls
        .iter()
        .map(|c| [c.arrival / 60., c.departure / 60.])
        .collect()
}
fn stops(result: Resolved) -> Vec<u32> {
    result.expect("ready").0.iter().map(|c| c.stop).collect()
}

#[test]
fn delays_propagate_through_dwell_until_new_predictions() {
    assert_eq!(
        minutes(resolve(json!([]), Some(json!(300)))),
        [[605., 605.], [615., 620.], [630., 630.], [640., 640.]]
    );
    for delay in [120., -60.] {
        let d = delay / 60.;
        assert_eq!(
            minutes(resolve(
                json!([{"stopSequence":20,"arrival":{"delay":delay as i64},"departure":{"delay":delay as i64}}]),
                None
            )),
            [
                [600., 600.],
                [610. + d, 615. + d],
                [625. + d, 625. + d],
                [635. + d, 635. + d]
            ]
        );
    }
    assert_eq!(
        minutes(resolve(
            json!([{"stopSequence":20,"arrival":{"delay":120},"departure":{"delay":60}},{"stopSequence":40,"arrival":{"delay":0},"departure":{"delay":0}}]),
            Some(json!(300))
        )),
        [[605., 605.], [612., 616.], [626., 626.], [635., 635.]]
    );
    // Epoch times take precedence over conflicting delay fields.
    assert_eq!(
        minutes(resolve(
            json!([{"stopId":"B","arrival":{"time":612 * 60,"delay":900},"departure":{"time":616 * 60}}]),
            None
        )),
        [[600., 600.], [612., 616.], [626., 626.], [636., 636.]]
    );
    assert_eq!(
        minutes(resolve(
            json!([{"stopSequence":20,"arrival":{"delay":120}}]),
            None
        )),
        [[600., 600.], [612., 617.], [627., 627.], [637., 637.]]
    );
    assert_eq!(
        minutes(resolve(
            json!([{"stopSequence":20,"departure":{"delay":120}}]),
            None
        )),
        [[600., 600.], [610., 617.], [627., 627.], [637., 637.]]
    );
    assert_eq!(
        minutes(resolve_with(&ROWS, &SEQUENCES, &ABCD, json!({}))),
        [[600., 600.], [610., 615.], [625., 625.], [635., 635.]],
        "absent predictions keep the schedule"
    );
    // An early first departure needs no invented earlier arrival.
    assert_eq!(
        minutes(resolve(
            json!([{"stopSequence":10,"departure":{"delay":-60}}]),
            None
        )),
        [[599., 599.], [609., 614.], [624., 624.], [634., 634.]]
    );
    assert_eq!(
        resolve(
            json!([{"stopSequence":10,"arrival":{"delay":0},"departure":{"delay":-60}}]),
            None
        ),
        Err(Invalid),
        "explicit contradictory predictions remain invalid"
    );
}

#[test]
fn no_data_and_skipped_calls() {
    for relationship in [json!("NO_DATA"), json!(2)] {
        assert_eq!(
            minutes(resolve(
                json!([{"stopSequence":20,"scheduleRelationship":relationship}]),
                Some(json!(300))
            )),
            [[605., 605.], [610., 615.], [625., 625.], [635., 635.]]
        );
    }
    assert_eq!(
        minutes(resolve(
            json!([{"stopSequence":20,"arrival":{"delay":120},"departure":{"delay":120}},{"stopSequence":30,"scheduleRelationship":"NO_DATA"}]),
            None
        )),
        [[600., 600.], [612., 617.], [625., 625.], [635., 635.]]
    );
    let skipped = || {
        resolve(
            json!([{"stopSequence":20,"scheduleRelationship":"SKIPPED"}]),
            Some(json!(120)),
        )
    };
    assert_eq!(
        minutes(skipped()),
        [[602., 602.], [627., 627.], [637., 637.]]
    );
    assert_eq!(stops(skipped()), [0, 2, 3]);
    assert_eq!(
        minutes(resolve(
            json!([{"stopSequence":20,"scheduleRelationship":"SKIPPED"},{"stopSequence":30,"arrival":{"time":605 * 60},"departure":{"time":605 * 60}}]),
            None
        )),
        [[600., 600.], [605., 605.], [615., 615.]],
        "a skipped call must not inject its scheduled time between actual predictions"
    );
    assert_eq!(
        minutes(resolve(
            json!([{"stopSequence":20,"scheduleRelationship":"SKIPPED","departure":{"delay":120}}]),
            None
        )),
        [[600., 600.], [627., 627.], [637., 637.]],
        "a provided skipped-call delay still propagates"
    );
    assert_eq!(
        resolve(
            json!([{"stopSequence":20,"scheduleRelationship":"SKIPPED","departure":{"time":0.5}}]),
            None
        ),
        Err(Invalid)
    );
    let skip = |sequences: &[f64]| {
        Value::Array(
            sequences
                .iter()
                .map(|s| json!({"stopSequence":*s as u64,"scheduleRelationship":"SKIPPED"}))
                .collect(),
        )
    };
    assert_eq!(stops(resolve(skip(&SEQUENCES), None)), [] as [u32; 0]);
    assert_eq!(stops(resolve(skip(&SEQUENCES[1..]), None)), [0]);
}

#[test]
fn predictions_bind_to_exactly_one_actual_call() {
    // A stop sequence identifies one call on a loop; a stop alone cannot.
    let looped = [ROWS[0], ROWS[1], (0, 625., 625.), ROWS[3]];
    assert_eq!(
        minutes(resolve_with(
            &looped,
            &SEQUENCES,
            &ABCD,
            json!({"stopTimeUpdates":[{"stopSequence":30,"stopId":"A","arrival":{"delay":60},"departure":{"delay":60}}]})
        )),
        [[600., 600.], [610., 615.], [626., 626.], [636., 636.]]
    );
    assert_eq!(
        resolve_with(
            &looped,
            &SEQUENCES,
            &ABCD,
            json!({"stopTimeUpdates":[{"stopId":"A","departure":{"delay":60}}]})
        ),
        Err(Invalid)
    );
    for updates in [
        json!([{"stopSequence":20,"stopId":"C","departure":{"delay":60}}]),
        json!([{"stopSequence":20},{"stopSequence":20}]),
        json!([{"stopSequence":20,"arrival":{"delay":600},"departure":{"delay":0}}]),
        json!([{"stopSequence":20,"arrival":{"delay":-1200},"departure":{"delay":-1200}}]),
        json!([{"stopSequence":999,"departure":{"delay":60}}]),
        json!([{"stopId":"unknown","departure":{"delay":60}}]),
        // Two forms of the same call must not silently override one another.
        json!([{"stopSequence":20},{"stopId":"B"}]),
    ] {
        assert_eq!(resolve(updates.clone(), None), Err(Invalid), "{updates}");
    }
    assert_eq!(
        resolve(
            json!([{"stopSequence":20,"scheduleRelationship":"UNSCHEDULED"}]),
            None
        ),
        Err(Unsupported)
    );
    // Scoped identifiers must match exactly; local ones match any feed.
    let scoped = [
        "feedA\u{1f}A",
        "feedA\u{1f}B",
        "feedA\u{1f}C",
        "feedA\u{1f}D",
    ];
    let scoped_update =
        |u: Value| resolve_with(&ROWS, &SEQUENCES, &scoped, json!({"stopTimeUpdates":[u]}));
    assert_eq!(
        scoped_update(json!({"stopSequence":20,"stopId":"feedB\u{1f}B","arrival":{"delay":60}})),
        Err(Invalid)
    );
    assert_eq!(
        scoped_update(json!({"stopId":"feedB\u{1f}B","arrival":{"delay":60}})),
        Err(Invalid)
    );
    assert!(scoped_update(json!({"stopId":"feedA\u{1f}B","arrival":{"delay":60}})).is_ok());
    assert!(scoped_update(json!({"stopId":"B","arrival":{"delay":60}})).is_ok());
}

#[test]
fn the_inferred_terminal_sequence_yields_to_a_reported_one() {
    // Connections record each boarding sequence, so the terminal's follows the last.
    let inferred = [10., 20., 30., 31.];
    let terminal = || json!({"stopSequence":40,"stopId":"D","arrival":{"delay":60}});
    let at =
        |updates: Value| resolve_with(&ROWS, &inferred, &ABCD, json!({"stopTimeUpdates":updates}));
    let restored = at(json!([terminal()]));
    assert_eq!(restored.as_ref().unwrap().0.last().unwrap().sequence, 40.);
    assert_eq!(
        minutes(restored),
        [[600., 600.], [610., 615.], [625., 625.], [636., 636.]]
    );
    for updates in [
        json!([{"stopSequence":20,"stopId":"D","arrival":{"delay":60}}]),
        json!([{"stopSequence":31,"stopId":"D"}, terminal()]),
        json!([terminal(), {"stopSequence":50,"stopId":"D"}]),
    ] {
        assert_eq!(at(updates.clone()), Err(Invalid), "{updates}");
    }
}

#[test]
fn malformed_records_and_native_bounds_reject_the_trip() {
    // Feed numbers are JSON numbers; numeric strings are not coerced.
    assert_eq!(
        resolve(
            json!([{"stopSequence":"20","departure":{"delay":"120"}}]),
            None
        ),
        Err(Invalid)
    );
    for sequence in [
        json!(20.5),
        json!(-1),
        json!(0x1_0000_0000_u64),
        json!("bad"),
        json!(true),
        json!(""),
    ] {
        assert_eq!(
            resolve(
                json!([{"stopSequence":sequence,"stopId":"B","departure":{"delay":60}}]),
                None
            ),
            Err(Invalid)
        );
    }
    for value in [
        json!(0.5),
        json!(f64::MAX),
        json!("bad"),
        json!(true),
        json!(""),
    ] {
        assert_eq!(resolve(json!([]), Some(value.clone())), Err(Invalid));
        assert_eq!(
            resolve(
                json!([{"stopSequence":20,"departure":{"delay":value}}]),
                None
            ),
            Err(Invalid)
        );
        // A malformed time must not silently fall back to the delay.
        assert_eq!(
            resolve(
                json!([{"stopSequence":20,"departure":{"time":value,"delay":0}}]),
                None
            ),
            Err(Invalid)
        );
    }
    assert_eq!(resolve(json!({}), None), Err(Invalid));
    // Times outside the packed native domain are rejected before compilation.
    assert_eq!(resolve(json!([]), Some(json!(1 << 20))), Err(Invalid));
    assert_eq!(
        resolve(
            json!([{"stopSequence":20,"departure":{"time":1 << 20}}]),
            None
        ),
        Err(Invalid)
    );
    assert_eq!(
        resolve(json!([{"stopSequence":20,"departure":{"time":-1}}]), None),
        Err(Invalid)
    );
    assert_eq!(
        resolve(json!([{"stopSequence":20,"departure":"bad"}]), None),
        Err(Invalid)
    );
    let stops: Vec<_> = ABCD.iter().map(|s| s.to_string()).collect();
    let update = json!({"stopTimeUpdates":[{"stopSequence":20,"departure":{"time":1}}]});
    for converted in [
        Some(f64::INFINITY),
        Some(123.5),
        Some(f64::from(1 << 20)),
        None,
    ] {
        let clock = move |_: i64| converted;
        assert_eq!(
            resolved(predict(
                calls(&ROWS, &SEQUENCES),
                &stops,
                &update,
                &clock,
                None,
                &mut 0
            )),
            Err(Invalid)
        );
    }
    // The schedule itself must be a valid call sequence.
    assert_eq!(
        resolve_with(&ROWS, &[10., 10., 30., 40.], &ABCD, json!({})),
        Err(Invalid)
    );
    let half_second = [ROWS[0], (1, 610. + 0.5 / 60., 615.), ROWS[2], ROWS[3]];
    assert_eq!(
        resolve_with(&half_second, &SEQUENCES, &ABCD, json!({})),
        Err(Invalid)
    );
    // Past the 500,000 prediction limit every further trip is rejected.
    let clock = |epoch: i64| Some(epoch as f64);
    let mut total = 499_999;
    let two = json!({"stopTimeUpdates":[{"stopSequence":10},{"stopSequence":20}]});
    assert_eq!(
        resolved(predict(
            calls(&ROWS, &SEQUENCES),
            &stops,
            &two,
            &clock,
            None,
            &mut total
        )),
        Err(Invalid)
    );
}

// An early first prediction can follow omitted scheduled calls. Only that
// unusable past prefix is excluded; omitted calls get no invented times.
const SERVICE_EPOCH: i64 = 1_789_444_800; // 2026-09-15T04:00:00Z
fn epoch_at(minutes: i64) -> i64 {
    SERVICE_EPOCH + minutes * 60
}
fn suffix(update: Value, feed: Option<i64>, now: f64) -> Resolved {
    let snapshot = feed.map_or(json!({}), |feed| json!({"feedTimestamp":feed}));
    let clock = |epoch: i64| Some((epoch - SERVICE_EPOCH) as f64);
    let boundary = source_boundary(&snapshot, &update, now, &clock);
    let stops: Vec<_> = ABCD.iter().map(|s| s.to_string()).collect();
    resolved(predict(
        calls(&ROWS, &SEQUENCES),
        &stops,
        &update,
        &clock,
        boundary,
        &mut 0,
    ))
}
fn early() -> Value {
    json!({"timestamp":epoch_at(619),"stopTimeUpdates":[
        {"stopSequence":30,"arrival":{"time":epoch_at(605)},"departure":{"time":epoch_at(607)}},
        {"stopSequence":40,"arrival":{"time":epoch_at(620)},"departure":{"time":epoch_at(620)}}]})
}

#[test]
fn an_early_first_prediction_omits_only_a_past_prefix() {
    let now = epoch_at(620) as f64;
    let trimmed = suffix(early(), Some(epoch_at(620)), now);
    assert_eq!(trimmed.as_ref().unwrap().1, 2);
    assert_eq!(stops(suffix(early(), Some(epoch_at(620)), now)), [2, 3]);
    assert_eq!(minutes(trimmed), [[605., 607.], [620., 620.]]);
    // An unchanged snapshot keeps the same suffix as the query clock advances.
    assert_eq!(
        suffix(early(), Some(epoch_at(620)), epoch_at(650) as f64),
        suffix(early(), Some(epoch_at(620)), now)
    );
    let with = |change: Value| {
        let mut update = early();
        for (key, value) in change.as_object().unwrap() {
            update[key] = value.clone();
        }
        update
    };
    for (update, feed, now, reason) in [
        (early(), None, now, "a source clock is required"),
        (
            early(),
            Some(epoch_at(620)),
            epoch_at(619) as f64,
            "a future feed clock cannot authorize omission",
        ),
        (
            with(json!({"timestamp":epoch_at(621)})),
            Some(epoch_at(620)),
            now,
            "nor a future record clock",
        ),
        (
            with(json!({"timestamp":epoch_at(614)})),
            Some(epoch_at(620)),
            now,
            "the record clock must also pass every prefix departure",
        ),
        (
            early(),
            Some(epoch_at(615)),
            now,
            "a departure at the boundary is not past",
        ),
        (
            early(),
            Some(epoch_at(614)),
            now,
            "a future scheduled prefix cannot be removed",
        ),
        (
            with(json!({"delaySeconds":0})),
            Some(epoch_at(620)),
            now,
            "a trip delay describes the prefix",
        ),
        (
            with(
                json!({"stopTimeUpdates":[{"stopSequence":30,"arrival":{"delay":-1200},"departure":{"delay":-1080}}]}),
            ),
            Some(epoch_at(620)),
            now,
            "a delay alone cannot establish that the first prediction is past",
        ),
        (
            with(
                json!({"stopTimeUpdates":[early()["stopTimeUpdates"][0], {"stopSequence":40,"arrival":{"time":epoch_at(604)},"departure":{"time":epoch_at(604)}}]}),
            ),
            Some(epoch_at(620)),
            now,
            "a second contradiction remains invalid",
        ),
        (
            with(
                json!({"stopTimeUpdates":[{"stopSequence":30,"arrival":{"time":epoch_at(607)},"departure":{"time":epoch_at(605)}}]}),
            ),
            Some(epoch_at(620)),
            now,
            "contradictory arrival and departure stay invalid after trimming",
        ),
    ] {
        assert_eq!(suffix(update, feed, now), Err(Invalid), "{reason}");
    }
    // Never discard an earlier explicit stop update to repair a conflict.
    for previous in [
        json!({"stopSequence":20,"arrival":{"time":epoch_at(610)},"departure":{"time":epoch_at(615)}}),
        json!({"stopSequence":10,"scheduleRelationship":"NO_DATA"}),
        json!({"stopSequence":10,"scheduleRelationship":"SKIPPED"}),
    ] {
        let mut updates = vec![previous];
        updates.extend(
            early()["stopTimeUpdates"]
                .as_array()
                .unwrap()
                .iter()
                .cloned(),
        );
        assert_eq!(
            suffix(
                with(json!({"stopTimeUpdates":updates})),
                Some(epoch_at(620)),
                now
            ),
            Err(Invalid)
        );
    }
    let departure_only = suffix(
        with(json!({"stopTimeUpdates":[{"stopSequence":30,"departure":{"time":epoch_at(607)}}]})),
        Some(epoch_at(620)),
        now,
    );
    assert_eq!(departure_only.as_ref().unwrap().1, 2);
    assert_eq!(minutes(departure_only), [[607., 607.], [617., 617.]]);
}

#[test]
fn retained_boston_predictions_keep_their_past_uncertainty() {
    // Minimal excerpts from a retained Boston snapshot: Route 70 trip 78477452
    // and Green-D trip 77744710. A past prediction can still carry
    // uncertainty; keeping it does not make that prediction an observation.
    for (timestamp, uncertainty, rows, predictions) in [
        (
            1_789_518_962_i64,
            Value::Null,
            [
                (41., "883321", 74160.),
                (42., "88334", 74280.),
                (43., "88335", 74280.),
            ],
            [
                (42, "88334", 1_789_518_750_i64, 1_789_518_750_i64),
                (43, "88335", 1_789_518_759, 1_789_518_759),
            ],
        ),
        (
            1_789_518_954,
            json!(60),
            [
                (480., "70179", 74040.),
                (490., "70177", 74220.),
                (500., "70175", 74400.),
            ],
            [
                (490, "70177", 1_789_518_803, 1_789_518_842),
                (500, "70175", 1_789_518_989, 1_789_519_033),
            ],
        ),
    ] {
        let stop_ids: Vec<_> = rows.iter().map(|r| r.1.to_string()).collect();
        let calls: Vec<_> = rows
            .iter()
            .enumerate()
            .map(|(i, &(sequence, _, time))| RealtimeCallInput {
                stop: i as u32,
                arrival: time,
                departure: time,
                sequence,
                can_board: true,
                can_alight: true,
            })
            .collect();
        let update = json!({"timestamp":timestamp,"sourceFeedTimestamp":1_789_518_986,
            "stopTimeUpdates":predictions.iter().map(|&(sequence, stop, arrival, departure)| json!({
                "stopSequence":sequence,"stopId":stop,
                "arrival":{"time":arrival,"uncertainty":uncertainty},"departure":{"time":departure,"uncertainty":uncertainty}})).collect::<Vec<_>>()});
        let clock = |epoch: i64| Some((epoch - SERVICE_EPOCH) as f64);
        let boundary = source_boundary(&json!({}), &update, 1_789_518_986., &clock);
        let (calls, omitted) =
            predict(calls, &stop_ids, &update, &clock, boundary, &mut 0).unwrap();
        assert_eq!(omitted, 1);
        assert_eq!(
            calls
                .iter()
                .map(|c| [c.arrival, c.departure])
                .collect::<Vec<_>>(),
            predictions
                .iter()
                .map(|&(_, _, a, d)| [(a - SERVICE_EPOCH) as f64, (d - SERVICE_EPOCH) as f64])
                .collect::<Vec<_>>()
        );
    }
}

// Segment columns of a test schedule; every call may board and alight.
struct Columns {
    departure: Vec<u32>,
    arrival: Vec<u32>,
    from: Vec<u32>,
    to: Vec<u32>,
    sequence: Vec<u32>,
    run: Vec<u32>,
    trip_start: Vec<u32>,
    open: Vec<u8>,
    breaks: Vec<u8>,
}
impl Columns {
    fn new(columns: [Vec<u32>; 7]) -> Self {
        let [departure, arrival, from, to, sequence, run, trip_start] = columns;
        let segments = departure.len();
        Self {
            departure,
            arrival,
            from,
            to,
            sequence,
            run,
            trip_start,
            open: vec![1; segments],
            breaks: vec![0; segments],
        }
    }
    fn schedule<'a>(&'a self, names: &'a TimetableNames) -> Schedule<'a> {
        Schedule {
            stop_count: names.stop_ids.len() as u32,
            departure_seconds: &self.departure,
            arrival_seconds: &self.arrival,
            from_stop: &self.from,
            to_stop: &self.to,
            sequence: &self.sequence,
            segment_run: &self.run,
            continuity_break: &self.breaks,
            can_board: &self.open,
            can_alight: &self.open,
            trip_start: &self.trip_start,
            names,
        }
    }
}

#[test]
fn omitted_past_calls_follow_source_clock_and_remove_prefix_boarding() {
    let names = names(&["A", "B", "C", "D", "E"], 1);
    let columns = Columns::new([
        vec![34800, 35400, 36000, 36600],
        vec![35400, 36000, 36600, 37200],
        vec![0, 1, 2, 3],
        vec![1, 2, 3, 4],
        vec![1, 2, 3, 4],
        vec![0; 4],
        vec![0, 4],
    ]);
    let schedule = columns.schedule(&names);
    let midnight = NaiveDate::from_ymd_opt(2026, 9, 15)
        .unwrap()
        .and_hms_opt(0, 0, 0)
        .unwrap()
        .and_utc()
        .timestamp();
    let feed = midnight + 36000;
    let updates: Vec<_> = [(3, 589), (4, 602), (5, 610)].iter().map(|(seq, minute)| json!({"stopSequence":seq,"arrival":{"time":midnight+minute*60},"departure":{"time":midnight+minute*60}})).collect();
    let snapshot =
        json!({"feedTimestamp":feed,"tripUpdates":[{"tripId":"T0","stopTimeUpdates":updates}]});
    let input = Input {
        snapshot: &snapshot,
        start_date: None,
    };
    let clock = Clock {
        date: NaiveDate::from_ymd_opt(2026, 9, 15).unwrap(),
        zone: Some(chrono_tz::UTC),
    };
    let before = apply(&schedule, &input, clock, (feed - 1) as f64).unwrap();
    assert_eq!(before.outcomes, [Outcome::Invalid]);
    assert_eq!(before.view.from_stop.as_ref(), &[0, 1, 2, 3]);
    let after = apply(&schedule, &input, clock, (feed + 1) as f64).unwrap();
    assert_eq!(
        after.outcomes,
        [Outcome::Applied {
            trip: 0,
            omitted: 2
        }]
    );
    assert_eq!(Counts::of(&after.outcomes).omitted_past_prefix_stops, 2);
    assert_eq!(after.view.from_stop.as_ref(), &[2, 3]);
    assert_eq!(after.view.departure_seconds.as_ref(), &[35340, 36120]);
    assert_eq!(after.view.arrival_seconds.as_ref(), &[36120, 36600]);
    assert!(
        after.view.departure_offset.is_empty(),
        "callers index the final view"
    );
    // Views never edit the resident schedule they were derived from.
    assert_eq!(columns.from, [0, 1, 2, 3]);
    assert_eq!(columns.departure, [34800, 35400, 36000, 36600]);
    assert_ne!(
        validity(&snapshot, (feed - 1) as f64),
        validity(&snapshot, (feed + 1) as f64)
    );
    assert_eq!(
        validity(&snapshot, (feed + 1) as f64),
        validity(&snapshot, (feed + 30) as f64)
    );
}

#[test]
fn outcomes_classify_every_update_in_feed_order() {
    let names = names(&["A", "B", "C"], 3);
    // Trips 0 and 1 run A-B-C; trip 2 runs A-C.
    let columns = Columns::new([
        vec![100, 160, 110, 170, 120],
        vec![150, 200, 160, 210, 220],
        vec![0, 1, 0, 1, 0],
        vec![1, 2, 1, 2, 2],
        vec![1, 2, 1, 2, 1],
        vec![0, 0, 1, 1, 2],
        vec![0, 2, 4, 5],
    ]);
    let schedule = columns.schedule(&names);
    let feed = 1_789_444_800_i64;
    let now = feed as f64;
    let snapshot = json!({"feedTimestamp":feed,"tripUpdates":[
        {"tripId":"T0","delaySeconds":60},
        {"tripId":"T1","scheduleRelationship":"CANCELED"},
        {"tripId":"T2","scheduleRelationship":"ADDED"},
        {"tripId":"T2","routeId":"other","sourceFeedTimestamp":feed - 600},
        {"tripId":"missing"},
        {"tripId":"T0","startDate":"20260916"},
        {"tripId":"T2","directionId":1},
    ]});
    let clock = Clock {
        date: NaiveDate::from_ymd_opt(2026, 9, 15).unwrap(),
        zone: None,
    };
    let input = Input {
        snapshot: &snapshot,
        start_date: None,
    };
    let overlay = apply(&schedule, &input, clock, now).unwrap();
    assert_eq!(
        overlay.outcomes,
        [
            Outcome::Applied {
                trip: 0,
                omitted: 0
            },
            Outcome::Canceled { trip: 1 },
            // Two fresh updates name T2.
            Outcome::Duplicate,
            Outcome::Stale,
            Outcome::Unmatched,
            Outcome::DateMismatch,
            Outcome::Duplicate,
        ]
    );
    let counts = Counts::of(&overlay.outcomes);
    assert_eq!(
        (
            counts.feed_updates,
            counts.applied,
            counts.canceled,
            counts.duplicate
        ),
        (7, 1, 1, 2)
    );
    assert_eq!(
        overlay.view.trip_start.as_ref(),
        &[0, 2, 2, 3],
        "cancellation keeps trip indices"
    );
    assert_eq!(overlay.view.departure_seconds.as_ref(), &[160, 220, 120]);
    assert_eq!(overlay.view.realtime_trip_indices.as_ref(), &[0]);
    let unique = json!({"feedTimestamp":feed,"tripUpdates":[{"tripId":"T2","scheduleRelationship":"ADDED"},{"tripId":"T1","directionId":1}]});
    let input = Input {
        snapshot: &unique,
        start_date: None,
    };
    assert_eq!(
        apply(&schedule, &input, clock, now).unwrap().outcomes,
        [Outcome::Unsupported, Outcome::Invalid]
    );
}

#[test]
fn retained_clocks_revalidate_like_the_snapshot() {
    let snapshot = json!({"feedTimestamp":1000,"tripUpdates":[
        {"tripId":"a","timestamp":990,"stopTimeUpdates":[{"stopSequence":1}]},
        {"tripId":"b","sourceFeedTimestamp":1100},
    ],"alerts":[{"id":"x","sourceFeedTimestamp":900},{"id":"y"}]});
    let retained = clocks(&snapshot);
    assert!(retained["tripUpdates"][0].get("stopTimeUpdates").is_none());
    for now in [900., 995., 1000., 1050., 1100., 1200., 1400.] {
        assert_eq!(validity(&retained, now), validity(&snapshot, now), "{now}");
    }
}
