//! The GTFS connection compiler against the frozen 0.5.2 evidence in
//! test/fixtures/gtfs-connections-052.json: counters and persisted rows of
//! hand-built routing stores, 80 seeded feeds with scoped identities, gaps,
//! frequencies and permissions, malformed input, and rollback on failure.
use rusqlite::{Connection, params, types::ValueRef};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use vigo_format::js::Js;
use vigo_prepare::{GtfsConnectionInput, compile_gtfs_connections};

const TABLES: [&str; 5] = [
    "connections",
    "connection_permissions",
    "trips",
    "trip_shapes",
    "trip_details",
];

/// One stop_times row: trip, sequence, stop, arrival, departure, board, alight.
type StopTime = (String, i64, String, Option<i64>, Option<i64>, i64, i64);
/// trip, start, end, headway, exact_times.
type Frequency = (String, i64, i64, i64, i64);

#[derive(Default, Clone)]
struct Feed {
    rows: Vec<StopTime>,
    trips: Vec<String>,
    frequencies: Vec<Frequency>,
    excluded: Vec<String>,
}

fn feed(rows: Vec<StopTime>) -> Feed {
    Feed {
        rows,
        trips: vec!["T".into()],
        ..Feed::default()
    }
}

fn stop(
    sequence: i64,
    id: &str,
    arrival: Option<i64>,
    departure: Option<i64>,
    board: i64,
    alight: i64,
    trip: &str,
) -> StopTime {
    (
        trip.into(),
        sequence,
        id.into(),
        arrival,
        departure,
        board,
        alight,
    )
}

/// `stop(sequence, id, time)`: boardable and alightable at one time.
fn timed(sequence: i64, id: &str, time: i64) -> StopTime {
    stop(sequence, id, Some(time), Some(time), 1, 1, "T")
}

struct Fixtures {
    root: PathBuf,
    baseline: Js,
}

impl Fixtures {
    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("vigo-connection-parity-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let text = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../test/fixtures/gtfs-connections-052.json"
        ))
        .unwrap();
        let baseline = Js::parse(&text).unwrap().get("cases").unwrap().clone();
        Fixtures { root, baseline }
    }

    /// A routing store with stops A, B and C and the feed's trips, and a
    /// separate stop_times stage.
    fn store(&self, name: &str, feed: &Feed) -> (PathBuf, PathBuf) {
        let store = self.root.join(format!("{name}.sqlite"));
        let stage = self.root.join(format!("{name}-stops.sqlite"));
        let db = Connection::open(&store).unwrap();
        vigo_gtfs::store::create_schema(&db).unwrap();
        db.execute_batch("INSERT INTO stops VALUES('A','A',0,0,NULL,0,NULL),('B','B',0,1,NULL,0,NULL),('C','C',0,2,NULL,0,NULL)").unwrap();
        for trip in &feed.trips {
            db.execute(
                "INSERT INTO trips VALUES(?,?,?,?)",
                params![trip, "R", "D", None::<String>],
            )
            .unwrap();
            db.execute(
                "INSERT INTO trip_details VALUES(?,?,?)",
                params![trip, "To 车站", None::<String>],
            )
            .unwrap();
            db.execute(
                "INSERT INTO trip_shapes VALUES(?,?)",
                params![trip, "shape"],
            )
            .unwrap();
        }
        for (trip, start, end, headway, exact) in &feed.frequencies {
            db.execute(
                "INSERT INTO frequencies VALUES(?,?,?,?,?)",
                params![trip, start, end, headway, exact],
            )
            .unwrap();
        }
        let stage_db = Connection::open(&stage).unwrap();
        stage_db.execute_batch("CREATE TABLE stop_times(trip_id TEXT,stop_sequence INTEGER,stop_id TEXT,arrival INTEGER,departure INTEGER,can_board INTEGER,can_alight INTEGER,pickup_type INTEGER,drop_off_type INTEGER); CREATE INDEX stop_times_trip_sequence ON stop_times(trip_id,stop_sequence)").unwrap();
        for (trip, sequence, id, arrival, departure, board, alight) in &feed.rows {
            stage_db
                .execute(
                    "INSERT INTO stop_times VALUES(?,?,?,?,?,?,?,?,?)",
                    params![trip, sequence, id, arrival, departure, board, alight, 0, 0],
                )
                .unwrap();
        }
        (store, stage)
    }

    /// Compile a copy of the feed's store, then hold it to the frozen
    /// counters and rows, or to `error` and an unchanged store.
    fn compare(&self, name: &str, mut feed: Feed, error: Option<&str>) -> (Js, Js) {
        // Frozen 0.5.2 evidence includes its old inclusive frequency endpoint.
        // Express those same departures with exclusive bounds; never rewrite
        // the retained evidence. The window cases verify the new boundary.
        for frequency in &mut feed.frequencies {
            if frequency.4 == 1 {
                frequency.2 += 1;
            }
        }
        let (store, stage) = self.store(name, &feed);
        let native = PathBuf::from(format!("{}.native", store.display()));
        std::fs::copy(&store, &native).unwrap();
        let before = contents(&native);
        let outcome = compile(&native, &stage, &feed.excluded, 4096);
        match error {
            Some(pattern) => {
                let message = outcome.expect_err(name);
                assert!(message.contains(pattern), "{name}: {message}");
                assert_eq!(
                    contents(&native),
                    before,
                    "{name}: failure must roll back every row"
                );
                (Js::Null, Js::Null)
            }
            None => {
                let counters = outcome.unwrap_or_else(|e| panic!("{name}: {e}"));
                let expected = self
                    .baseline
                    .get(name)
                    .unwrap_or_else(|| panic!("no evidence for {name}"));
                assert_eq!(
                    sorted(&counters),
                    sorted(expected.get("counters").unwrap()),
                    "{name}: retained counters"
                );
                let rows = contents(&native);
                assert_eq!(
                    digest(&rows),
                    expected.get("rowsSha256").and_then(Js::as_str).unwrap(),
                    "{name}: retained persisted rows"
                );
                (counters, rows)
            }
        }
    }
}

impl Drop for Fixtures {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn compile(store: &Path, stage: &Path, excluded: &[String], cache_kib: u32) -> Result<Js, String> {
    let result = compile_gtfs_connections(GtfsConnectionInput {
        store_path: store.to_string_lossy().into_owned(),
        stop_times_path: stage.to_string_lossy().into_owned(),
        excluded_trip_ids: excluded.to_vec(),
        cache_kib,
        invalid_time_policy: None,
    })
    .map_err(|error| error.to_string())?;
    Ok(Js::parse(&serde_json::to_string(&result).unwrap()).unwrap())
}

/// The compared tables, read as node:sqlite reads them, after an integrity check.
fn contents(file: &Path) -> Js {
    let db = Connection::open_with_flags(file, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let integrity: String = db
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .unwrap();
    assert_eq!(integrity, "ok");
    let mut tables = Js::object();
    for table in TABLES {
        let mut statement = db
            .prepare(&format!("SELECT * FROM {table} ORDER BY 1,2"))
            .unwrap();
        let names: Vec<String> = statement
            .column_names()
            .map(|name| name.to_string())
            .collect();
        let mut rows = statement.query([]).unwrap();
        let mut list = Vec::new();
        while let Some(row) = rows.next().unwrap() {
            let mut object = Js::object();
            for (index, name) in names.iter().enumerate() {
                let value = match row.get_ref(index).unwrap() {
                    ValueRef::Null => Js::Null,
                    ValueRef::Integer(n) => Js::from(n as f64),
                    ValueRef::Real(n) => Js::from(n),
                    ValueRef::Text(text) => Js::from(String::from_utf8(text.to_vec()).unwrap()),
                    ValueRef::Blob(_) => panic!("unexpected blob in {table}"),
                };
                object.set(name.clone(), value);
            }
            list.push(object);
        }
        tables.set(table, Js::Array(list));
    }
    tables
}

/// SHA-256 of `JSON.stringify(rows)`.
fn digest(rows: &Js) -> String {
    Sha256::digest(rows.stringify().as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// An object's members by name, for comparison regardless of order.
fn sorted(value: &Js) -> Vec<(String, Js)> {
    let Js::Object(members) = value else {
        panic!("expected an object")
    };
    let mut members = members.clone();
    members.sort_by(|a, b| a.0.cmp(&b.0));
    members
}

#[test]
fn connection_compiler_reproduces_retained_evidence() {
    let fixtures = Fixtures::new();
    fixtures.compare("empty", feed(vec![]), None);
    fixtures.compare("singleton", feed(vec![timed(1, "A", 0)]), None);
    let (gap_counters, gap_rows) = fixtures.compare(
        "gap-and-after-midnight",
        feed(vec![
            stop(4, "C", Some(90060), None, 1, 0, "T"),
            stop(1, "A", None, Some(90000), 0, 1, "T"),
            stop(2, "B", None, None, 1, 1, "T"),
        ]),
        None,
    );
    assert_eq!(
        gap_counters
            .get("bridgedUntimedGapCount")
            .and_then(Js::as_f64),
        Some(1.0)
    );
    let Some(Js::Array(permissions)) = gap_rows.get("connection_permissions") else {
        panic!()
    };
    let Js::Object(first) = &permissions[0] else {
        panic!()
    };
    let values: Vec<Js> = first.iter().map(|(_, value)| value.clone()).collect();
    assert_eq!(
        values,
        vec![Js::from("T"), Js::from(1.0), Js::from(0.0), Js::from(0.0)]
    );

    let windows = |frequencies: Vec<(i64, i64, i64)>| -> Vec<Frequency> {
        frequencies
            .into_iter()
            .map(|(start, end, headway)| ("T".into(), start, end, headway, 1))
            .collect()
    };
    let (overlap, _) = fixtures.compare(
        "overlapping-exact-windows",
        Feed {
            frequencies: windows(vec![(100, 160, 30), (130, 190, 30)]),
            ..feed(vec![timed(1, "A", 100), timed(2, "B", 120)])
        },
        None,
    );
    assert_eq!(
        overlap.get("connectionCount").and_then(Js::as_f64),
        Some(4.0)
    );
    assert_eq!(
        overlap
            .get("exactFrequencyExpandedTripCount")
            .and_then(Js::as_f64),
        Some(4.0)
    );
    fixtures.compare(
        "untimed-first-frequency",
        Feed {
            frequencies: windows(vec![(100, 160, 30)]),
            ..feed(vec![
                stop(1, "A", None, None, 1, 1, "T"),
                timed(2, "B", 120),
                timed(3, "C", 140),
            ])
        },
        None,
    );
    fixtures.compare(
        "excluded-inexact",
        Feed {
            excluded: vec!["T".into()],
            frequencies: vec![("T".into(), 100, 160, 30, 0)],
            ..feed(vec![timed(1, "A", 100), timed(2, "B", 120)])
        },
        None,
    );
    fixtures.compare(
        "missing-stop",
        Feed {
            frequencies: windows(vec![(100, 160, 30)]),
            ..feed(vec![
                timed(1, "A", 100),
                timed(2, "B", 120),
                timed(3, "missing", 130),
            ])
        },
        Some("Broken GTFS reference stop_times.stop_id"),
    );
    fixtures.compare(
        "missing-trip",
        feed(vec![stop(1, "A", Some(100), Some(100), 1, 1, "absent")]),
        Some("Broken GTFS reference stop_times.trip_id"),
    );
    fixtures.compare(
        "duplicate-sequence",
        feed(vec![timed(1, "A", 100), timed(1, "B", 120)]),
        Some("Non-increasing or duplicate GTFS stop_sequence"),
    );
    fixtures.compare(
        "non-monotone",
        feed(vec![timed(1, "A", 100), timed(2, "B", 90)]),
        Some("Non-monotone GTFS trip time"),
    );
    fixtures.compare(
        "excluded-still-validates",
        Feed {
            excluded: vec!["T".into()],
            ..feed(vec![timed(1, "A", 100), timed(2, "B", 90)])
        },
        Some("Non-monotone GTFS trip time"),
    );
    fixtures.compare(
        "expansion-bound",
        Feed {
            frequencies: windows(vec![(0, 100_000, 1)]),
            ..feed(vec![timed(1, "A", 100), timed(2, "B", 120)])
        },
        Some("supported expansion bound"),
    );
    fixtures.compare(
        "frequency-id-collision",
        Feed {
            trips: vec!["T".into(), "T#frequency-100".into()],
            frequencies: windows(vec![(100, 100, 1)]),
            ..feed(vec![timed(1, "A", 100), timed(2, "B", 120)])
        },
        Some("UNIQUE constraint failed"),
    );

    // Exclusive frequency ends, compiled in place without the evidence shift.
    for (name, frequencies, expected) in [
        ("exclusive-end", vec![(100, 160, 30)], vec![100, 130]),
        ("partial-headway", vec![(100, 161, 30)], vec![100, 130, 160]),
        (
            "adjacent-windows",
            vec![(100, 160, 30), (160, 221, 60)],
            vec![100, 130, 160, 220],
        ),
    ] {
        let (store, stage) = fixtures.store(
            name,
            &Feed {
                frequencies: windows(frequencies),
                ..feed(vec![timed(1, "A", 100), timed(2, "B", 120)])
            },
        );
        let counters = compile(&store, &stage, &[], 4096).unwrap();
        assert_eq!(
            counters
                .get("exactFrequencyExpandedTripCount")
                .and_then(Js::as_f64),
            Some(expected.len() as f64)
        );
        let rows = contents(&store);
        let Some(Js::Array(connections)) = rows.get("connections") else {
            panic!()
        };
        let mut departures: Vec<f64> = connections
            .iter()
            .map(|row| row.get("departure").and_then(Js::as_f64).unwrap())
            .collect();
        departures.sort_by(f64::total_cmp);
        assert_eq!(
            departures,
            expected.iter().map(|&d| d as f64).collect::<Vec<_>>(),
            "{name}"
        );
        assert!(
            connections.iter().all(|row| {
                row.get("arrival").and_then(Js::as_f64).unwrap()
                    - row.get("departure").and_then(Js::as_f64).unwrap()
                    == 20.0
            }),
            "Expansion must retain riding time"
        );
    }

    // The JavaScript check's linear congruential generator.
    let mut seed: u32 = 80321;
    let mut random = |n: u32| {
        seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        i64::from(seed % n)
    };
    for trial in 0..80 {
        let (mut trips, mut rows, mut frequencies, mut excluded) = (vec![], vec![], vec![], vec![]);
        for i in 0..8 {
            let trip = format!("scope\u{1f}车站-{trial}-{i}");
            trips.push(trip.clone());
            let start = 80_000 + random(1000);
            let length = 2 + random(15);
            for j in 0..length {
                let id = ["A", "B", "C"][random(3) as usize];
                let arrival = if j != 0 && random(5) == 0 {
                    None
                } else {
                    Some(start + j * 120)
                };
                let departure = if j != 0 && random(5) == 0 {
                    None
                } else {
                    Some(start + j * 120 + 10)
                };
                let board = random(2);
                let alight = random(2);
                rows.push(stop(j * 2, id, arrival, departure, board, alight, &trip));
            }
            if random(3) == 0 {
                frequencies.push((trip.clone(), start, start + 1800, 600, 1));
            }
            if random(6) == 0 {
                excluded.push(trip);
            }
        }
        rows.reverse();
        fixtures.compare(
            &format!("seed-{trial}"),
            Feed {
                rows,
                trips,
                frequencies,
                excluded,
            },
            None,
        );
    }

    let (store, stage) = fixtures.store("bad-paths", &feed(vec![]));
    assert!(
        compile(&store, &store, &[], 4096)
            .unwrap_err()
            .contains("distinct")
    );
    let missing = PathBuf::from(format!("{}.missing", store.display()));
    assert!(compile(&missing, &stage, &[], 4096).is_err());
    assert!(!missing.exists());
    assert!(
        compile(&store, &stage, &[], 0)
            .unwrap_err()
            .contains("cacheKiB")
    );
}
