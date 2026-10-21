//! Explicit GTFS linked trips compiled once per active timetable. Original
//! trips remain available for partial journeys, exclusions and presentation.
//! Through runs reuse the ordinary Rust search in both clock directions.
use super::{Result, fail};
use crate::realtime::TimetableNames;
use rusqlite::Connection;
use std::collections::HashMap;
use vigo_format::ServiceTimetableResult;

#[derive(Clone)]
pub(crate) struct Part {
    pub trip: u32,
    pub first: u32,
    pub sequences: Vec<u32>,
    pub departures: Vec<u32>,
    pub arrivals: Vec<u32>,
    pub from: Vec<u32>,
    pub to: Vec<u32>,
}
pub(super) type Links = HashMap<u32, Vec<Part>>;

fn has_table(db: &Connection, name: &str) -> Result<bool> {
    Ok(db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?)",
        [name],
        |r| r.get(0),
    )?)
}

pub(super) fn present(db: &Connection) -> Result<bool> {
    let explicit = has_table(db, "trip_links")?
        && db.query_row(
            "SELECT EXISTS(SELECT 1 FROM trip_links WHERE transfer_type=4)",
            [],
            |r| r.get::<_, bool>(0),
        )?;
    let blocks = has_table(db, "trip_operations")?
        && db.query_row(
            "SELECT EXISTS(SELECT 1 FROM trip_operations WHERE block_id IS NOT NULL)",
            [],
            |r| r.get::<_, bool>(0),
        )?;
    Ok(explicit || blocks)
}

fn paths(
    node: usize,
    edges: &[Vec<usize>],
    path: &mut Vec<usize>,
    out: &mut Vec<Vec<usize>>,
    retained: &mut usize,
) -> Result<()> {
    if path.contains(&node) {
        return fail("GTFS linked trips contain a cycle");
    }
    if path.len() >= 512 || out.len() >= 200_000 {
        return fail("GTFS linked-trip expansion exceeds the bounded preparation limit");
    }
    path.push(node);
    if edges[node].is_empty() {
        if path.len() > 1 {
            *retained = retained.saturating_add(path.len());
            if *retained > 1_000_000 {
                return fail("GTFS linked-trip paths exceed the preparation memory budget");
            }
            out.push(path.clone());
        }
    } else {
        for &next in &edges[node] {
            paths(next, edges, path, out, retained)?;
        }
    }
    path.pop();
    Ok(())
}

pub(super) fn compile(
    db: &Connection,
    a: &mut ServiceTimetableResult,
    names: &mut TimetableNames,
) -> Result<Links> {
    if !present(db)? {
        return Ok(HashMap::new());
    }
    let mut instances: HashMap<&str, Vec<usize>> = HashMap::new();
    for (i, id) in names.trip_ids.iter().enumerate() {
        if a.trip_start[i] < a.trip_start[i + 1] {
            instances.entry(id).or_default().push(i);
        }
    }
    let mut edges = vec![Vec::new(); names.trip_ids.len()];
    let mut incoming = vec![false; edges.len()];
    let mut candidates = Vec::new();
    if has_table(db, "trip_links")? {
        let mut statement = db.prepare("SELECT l.from_trip_id,l.to_trip_id,MAX(c.stop_sequence) FROM trip_links l JOIN connections c ON c.trip_id=l.from_trip_id WHERE l.transfer_type=4 GROUP BY l.from_trip_id,l.to_trip_id ORDER BY l.from_trip_id,l.to_trip_id")?;
        for row in statement.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, u32>(2)?,
                false,
            ))
        })? {
            candidates.push(row?);
        }
    }
    if has_table(db, "trip_operations")? {
        // Derive adjacency from the static schedule, never from the surviving
        // realtime trips: canceling the middle vehicle must not bridge a gap.
        // Shared service_id establishes a common calendar. Other block models
        // require explicit links instead of guessing cross-calendar continuity.
        let mut statement = db.prepare("WITH bounds AS (
          SELECT t.trip_id,t.service_id,o.block_id,MIN(c.departure) AS departure,
            MAX(c.arrival) AS arrival,MAX(c.stop_sequence) AS terminal
          FROM trip_operations o JOIN trips t USING(trip_id) JOIN connections c USING(trip_id)
          WHERE o.block_id IS NOT NULL GROUP BY t.trip_id
        ), ordered AS (
          SELECT *,LEAD(trip_id) OVER (PARTITION BY block_id,service_id ORDER BY departure,trip_id) AS next,
            MAX(arrival) OVER (PARTITION BY block_id,service_id ORDER BY departure,trip_id
              ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS previous_arrival,
            COUNT(*) OVER (PARTITION BY block_id,service_id,departure) AS departure_count
          FROM bounds
        ) SELECT a.trip_id,b.trip_id,a.terminal FROM ordered a JOIN ordered b ON b.trip_id=a.next
          WHERE a.arrival<=b.departure
          AND a.departure_count=1 AND b.departure_count=1
          AND (a.previous_arrival IS NULL OR a.previous_arrival<=a.departure)
          AND b.previous_arrival<=b.departure
          AND NOT EXISTS (SELECT 1 FROM trip_links l WHERE
            (l.from_trip_id=a.trip_id AND l.to_trip_id=b.trip_id)
            OR (l.transfer_type=4 AND (l.from_trip_id=a.trip_id OR l.to_trip_id=b.trip_id)))")?;
        for row in statement.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, u32>(2)?,
                true,
            ))
        })? {
            candidates.push(row?);
        }
    }
    for (from, to, terminal, inferred) in candidates {
        let (Some(sources), Some(targets)) =
            (instances.get(from.as_str()), instances.get(to.as_str()))
        else {
            continue;
        };
        for &source in sources {
            let end = a.trip_start[source + 1] as usize - 1;
            // A truncated horizon or canceled tail is not the end of a trip.
            if a.sequence[end] != terminal {
                continue;
            }
            let target = targets
                .iter()
                .copied()
                .filter(|&target| {
                    let start = a.trip_start[target] as usize;
                    let date_a = &names.trip_service_dates[source];
                    let date_b = &names.trip_service_dates[target];
                    let dates = date_a == date_b
                        || chrono::NaiveDate::parse_from_str(date_a, "%Y-%m-%d")
                            .ok()
                            .and_then(|d| d.succ_opt())
                            .is_some_and(|d| d.to_string() == *date_b);
                    dates
                        && (!inferred || (date_a == date_b && a.to_stop[end] == a.from_stop[start]))
                        && source != target
                        && a.departure_seconds[start] >= a.arrival_seconds[end]
                })
                .min_by_key(|&target| a.departure_seconds[a.trip_start[target] as usize]);
            if let Some(target) = target {
                // Never bridge a cancellation, an untimed discontinuity, or a
                // removed trip prefix merely because the remaining clocks fit.
                let intact = [source, target].iter().all(|&trip| {
                    let start = a.trip_start[trip] as usize;
                    let end = a.trip_start[trip + 1] as usize;
                    (start + 1..end).all(|i| {
                        a.segment_run[i] == a.segment_run[start] && a.continuity_break[i] == 0
                    })
                });
                let first: u32 = db.query_row(
                    "SELECT MIN(stop_sequence) FROM connections WHERE trip_id=?",
                    [&to],
                    |r| r.get(0),
                )?;
                if intact && a.sequence[a.trip_start[target] as usize] == first {
                    edges[source].push(target);
                    incoming[target] = true;
                }
            }
        }
    }
    // Explicit splitting/coupling is represented by complete through paths.
    // Refuse pathological input instead of silently dropping continuations.
    let mut chains = Vec::new();
    let mut retained = 0;
    for start in 0..edges.len() {
        if !incoming[start] && !edges[start].is_empty() {
            paths(start, &edges, &mut Vec::new(), &mut chains, &mut retained)?;
        }
    }
    let mut reached = vec![false; edges.len()];
    for chain in &chains {
        for &trip in chain {
            reached[trip] = true;
        }
    }
    if edges
        .iter()
        .enumerate()
        .any(|(i, e)| !e.is_empty() && !reached[i])
    {
        return fail("GTFS linked trips contain a cycle");
    }
    if chains.is_empty() {
        return Ok(HashMap::new());
    }
    let added: usize = chains
        .iter()
        .flatten()
        .map(|&t| (a.trip_start[t + 1] - a.trip_start[t]) as usize)
        .sum();
    if added > a.departure_seconds.len().max(100_000) * 4 {
        return fail("GTFS linked-trip expansion exceeds the bounded segment limit");
    }
    // Budget additional preparation allocations before cloning any columns.
    // Includes spare vector capacity, physical-part copies, path storage and
    // name tables. This is an allocation estimate, not an RSS guarantee.
    let name_bytes = chains
        .iter()
        .map(|chain| {
            let head = chain[0];
            names.trip_ids[head].len()
                + names.route_ids[head].len()
                + names.direction_ids[head].len()
                + names.trip_service_dates[head].len()
        })
        .sum::<usize>();
    let estimated_bytes = added
        .saturating_mul(160)
        .saturating_add(retained.saturating_mul(2 * std::mem::size_of::<Part>()))
        .saturating_add(chains.len().saturating_mul(256))
        .saturating_add(name_bytes.saturating_mul(2));
    let budget = crate::resources::memory_capacity().map_or(128 * 1024 * 1024, |capacity| {
        (capacity / 8).min(128 * 1024 * 1024)
    });
    if estimated_bytes > budget {
        return fail(format!(
            "GTFS linked-trip expansion needs an estimated {estimated_bytes} additional bytes, exceeding its {budget}-byte preparation budget"
        ));
    }
    let mut trips = names.trip_ids.to_vec();
    let mut routes = names.route_ids.to_vec();
    let mut directions = names.direction_ids.to_vec();
    let mut dates = names.trip_service_dates.to_vec();
    let mut links = HashMap::new();
    macro_rules! column {
        ($field:ident) => {
            let mut $field = std::mem::take(&mut a.$field).into_vec();
        };
    }
    column!(departure_seconds);
    column!(arrival_seconds);
    column!(from_stop);
    column!(to_stop);
    column!(sequence);
    column!(segment_trip);
    column!(segment_run);
    column!(continuity_break);
    column!(can_board);
    column!(can_alight);
    column!(trip_start);
    for chain in chains {
        let trip = trips.len() as u32;
        let head = chain[0];
        let mut parts = Vec::new();
        let mut next = 1;
        for physical in chain {
            let range = trip_start[physical] as usize..trip_start[physical + 1] as usize;
            parts.push(Part {
                trip: physical as u32,
                first: next,
                sequences: sequence[range.clone()].to_vec(),
                departures: departure_seconds[range.clone()].to_vec(),
                arrivals: arrival_seconds[range.clone()].to_vec(),
                from: from_stop[range.clone()].to_vec(),
                to: to_stop[range.clone()].to_vec(),
            });
            for i in range {
                departure_seconds.push(departure_seconds[i]);
                arrival_seconds.push(arrival_seconds[i]);
                from_stop.push(from_stop[i]);
                to_stop.push(to_stop[i]);
                sequence.push(next);
                next += 1;
                segment_trip.push(trip);
                segment_run.push(a.run_count);
                continuity_break.push(0);
                can_board.push(can_board[i]);
                can_alight.push(can_alight[i]);
            }
        }
        a.run_count += 1;
        trip_start.push(sequence.len() as u32);
        trips.push(names.trip_ids[head].clone());
        routes.push(names.route_ids[head].clone());
        directions.push(names.direction_ids[head].clone());
        dates.push(names.trip_service_dates[head].clone());
        links.insert(trip, parts);
    }
    macro_rules! install {($($field:ident),*) => {$ (a.$field=$field.into();)*};}
    install!(
        departure_seconds,
        arrival_seconds,
        from_stop,
        to_stop,
        sequence,
        segment_trip,
        segment_run,
        continuity_break,
        can_board,
        can_alight,
        trip_start
    );
    *names = TimetableNames::new(
        names.stop_ids.clone(),
        trips.into(),
        routes.into(),
        directions.into(),
        dates.into(),
    );
    Ok(links)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(
        departures: &[u32],
        arrivals: &[u32],
        dates: &[&str],
    ) -> (Connection, ServiceTimetableResult, TimetableNames) {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE trip_links(from_trip_id TEXT,to_trip_id TEXT,transfer_type INTEGER); INSERT INTO trip_links VALUES('A','B',4); CREATE TABLE connections(trip_id TEXT,stop_sequence INTEGER); INSERT INTO connections VALUES('A',1),('B',1);").unwrap();
        let names = TimetableNames::new(
            vec!["s0".into(), "s1".into(), "s2".into()].into(),
            vec!["A".into(), "B".into()].into(),
            vec!["R".into(); 2].into(),
            vec!["0".into(); 2].into(),
            dates
                .iter()
                .map(|s| s.to_string())
                .collect::<Vec<_>>()
                .into(),
        );
        let a = ServiceTimetableResult {
            stop_ids: vec![],
            departure_seconds: departures.to_vec().into(),
            arrival_seconds: arrivals.to_vec().into(),
            from_stop: vec![0, 1].into(),
            to_stop: vec![1, 2].into(),
            sequence: vec![1, 1].into(),
            segment_trip: vec![0, 1].into(),
            segment_run: vec![0, 1].into(),
            continuity_break: vec![1, 1].into(),
            can_board: vec![1, 1].into(),
            can_alight: vec![1, 1].into(),
            trip_start: vec![0, 1, 2].into(),
            trip_ids: vec![],
            route_ids: vec![],
            service_ids: vec![],
            direction_ids: vec![],
            trip_service_dates: vec![],
            run_count: 2,
            stop_count: 3,
        };
        (db, a, names)
    }
    #[test]
    fn branching_paths_stop_before_unbounded_retention() {
        // Two choices at each layer create over a million complete paths.
        let layers = 21;
        let mut edges = vec![Vec::new(); layers * 2 + 1];
        edges[0] = vec![1, 2];
        for layer in 0..layers - 1 {
            for node in [layer * 2 + 1, layer * 2 + 2] {
                edges[node] = vec![layer * 2 + 3, layer * 2 + 4];
            }
        }
        let mut chains = Vec::new();
        let mut retained = 0;
        let error = paths(0, &edges, &mut Vec::new(), &mut chains, &mut retained).unwrap_err();
        assert!(error.to_string().contains("memory budget"));
        assert!(chains.iter().map(Vec::len).sum::<usize>() <= 1_000_000);
        assert!(chains.len() < 200_000);
    }
    #[test]
    fn keeps_next_service_day_clocks_and_original_sequences() {
        let (db, mut a, mut names) = fixture(
            &[85800, 86700],
            &[86400, 87600],
            &["2026-07-15", "2026-07-16"],
        );
        let links = compile(&db, &mut a, &mut names).unwrap();
        assert_eq!(links.len(), 1);
        assert_eq!(&*a.departure_seconds, &[85800, 86700, 85800, 86700]);
        assert_eq!(&*a.sequence, &[1, 1, 1, 2]);
        assert_eq!(links[&2][1].trip, 1);
        assert_eq!(&*a.segment_run, &[0, 1, 2, 2]);
    }
    #[test]
    fn rejects_invalid_continuity_without_inventing_a_trip() {
        for (departures, arrivals, dates) in [
            ([100, 150], [200, 300], ["2026-07-15", "2026-07-15"]),
            ([100, 500], [200, 600], ["2026-07-15", "2026-07-17"]),
        ] {
            let (db, mut a, mut names) = fixture(&departures, &arrivals, &dates);
            assert!(compile(&db, &mut a, &mut names).unwrap().is_empty());
            assert_eq!(a.run_count, 2);
        }
        let (db, mut a, mut names) = fixture(&[100, 200], &[200, 300], &["2026-07-15"; 2]);
        a.from_stop[1] = 0;
        assert_eq!(compile(&db, &mut a, &mut names).unwrap().len(), 1);
    }
    #[test]
    fn block_continuity_respects_calendar_endpoints_and_explicit_prohibition() {
        for (forbidden, other_date, other_stop) in [
            (false, false, false),
            (true, false, false),
            (false, true, false),
            (false, false, true),
        ] {
            let (db, mut a, mut names) = fixture(
                &[100, 220],
                &[200, 300],
                if other_date {
                    &["2026-07-15", "2026-07-16"]
                } else {
                    &["2026-07-15"; 2]
                },
            );
            db.execute_batch(
                "DELETE FROM trip_links;
              CREATE TABLE trips(trip_id TEXT,service_id TEXT);
              INSERT INTO trips VALUES('A','S'),('B','S');
              CREATE TABLE trip_operations(trip_id TEXT,block_id TEXT);
              INSERT INTO trip_operations VALUES('A','block'),('B','block');
              ALTER TABLE connections ADD COLUMN departure INTEGER;
              ALTER TABLE connections ADD COLUMN arrival INTEGER;
              UPDATE connections SET departure=100,arrival=200 WHERE trip_id='A';
              UPDATE connections SET departure=220,arrival=300 WHERE trip_id='B';",
            )
            .unwrap();
            if forbidden {
                db.execute("INSERT INTO trip_links VALUES('A','B',5)", [])
                    .unwrap();
            }
            if other_stop {
                a.from_stop[1] = 0;
            }
            let links = compile(&db, &mut a, &mut names).unwrap();
            assert_eq!(
                links.len(),
                usize::from(!forbidden && !other_date && !other_stop)
            );
        }
    }
    #[test]
    fn rejects_a_zero_time_cycle() {
        let (db, mut a, mut names) = fixture(&[100, 100], &[100, 100], &["2026-07-15"; 2]);
        a.from_stop = vec![0, 0].into();
        a.to_stop = vec![0, 0].into();
        db.execute("INSERT INTO trip_links VALUES('B','A',4)", [])
            .unwrap();
        assert!(compile(&db, &mut a, &mut names).is_err());
    }
}
