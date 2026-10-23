//! Explicit GTFS linked trips compiled once per active timetable. Original
//! trips remain available for partial journeys, exclusions and presentation.
//! Through runs reuse the ordinary Rust search in both clock directions.
use super::{Result, fail};
use crate::realtime::TimetableNames;
use rusqlite::Connection;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
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
/// Through runs by their timetable trip, with each linked physical trip's
/// place in a run. Linked physical trips keep no segments of their own.
#[derive(Clone, Default)]
pub(crate) struct Links {
    runs: HashMap<u32, Vec<Part>>,
    physical: HashMap<u32, (u32, usize)>,
}

impl std::ops::Deref for Links {
    type Target = HashMap<u32, Vec<Part>>;
    fn deref(&self) -> &Self::Target {
        &self.runs
    }
}

impl<'a> IntoIterator for &'a Links {
    type Item = (&'a u32, &'a Vec<Part>);
    type IntoIter = std::collections::hash_map::Iter<'a, u32, Vec<Part>>;
    fn into_iter(self) -> Self::IntoIter {
        self.runs.iter()
    }
}

impl Links {
    fn new(runs: HashMap<u32, Vec<Part>>) -> Self {
        let mut physical = HashMap::new();
        for (&run, parts) in &runs {
            for (index, part) in parts.iter().enumerate() {
                physical.entry(part.trip).or_insert((run, index));
            }
        }
        Self { runs, physical }
    }

    /// The through run carrying a linked physical trip, with a call of that
    /// trip (`sequence`, possibly an x.5 bridge) and the trip's whole span,
    /// all in the run's own sequence numbering.
    pub(crate) fn through(&self, trip: u32, sequence: f64) -> Option<(u32, f64, [f64; 2])> {
        let &(run, index) = self.physical.get(&trip)?;
        let part = &self.runs[&run][index];
        let whole = sequence.floor();
        let offset = part.sequences.iter().position(|&s| f64::from(s) == whole)?;
        let first = f64::from(part.first);
        let last = first + part.sequences.len() as f64 - 1.;
        Some((
            run,
            first + offset as f64 + (sequence - whole),
            [first, last],
        ))
    }
}

fn has_table(db: &Connection, name: &str) -> Result<bool> {
    Ok(db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?)",
        [name],
        |r| r.get(0),
    )?)
}

fn has_block_trips(db: &Connection) -> Result<bool> {
    Ok(has_table(db, "trip_operations")?
        && db.query_row(
            "SELECT EXISTS(SELECT 1 FROM trip_operations WHERE block_id IS NOT NULL)",
            [],
            |r| r.get::<_, bool>(0),
        )?)
}

pub(super) fn present(db: &Connection) -> Result<bool> {
    let explicit = has_table(db, "trip_links")?
        && db.query_row(
            "SELECT EXISTS(SELECT 1 FROM trip_links WHERE transfer_type=4)",
            [],
            |r| r.get::<_, bool>(0),
        )?;
    Ok(explicit || has_block_trips(db)?)
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

/// Static adjacency for the requested service calendars. Each calendar includes
/// all its source trips, including canceled trips, so filtering calendars cannot
/// create a continuation across a missing vehicle.
struct Candidate {
    from: String,
    to: String,
    terminal: u32,
    inferred: bool,
    first: Option<u32>,
}

// Only inferred block adjacency depends on the selected calendars. Explicit
// links are static; compile still checks the active trip instances on each date.
pub(super) struct Candidates {
    explicit: Arc<Explicit>,
    inferred: Vec<Arc<Vec<Candidate>>>,
}

/// GTFS in-seat links, read once per City and shared by every calendar set:
/// the continuations themselves and the trips whose explicit links (of any
/// type) override block inference.
#[derive(Default)]
pub(super) struct Explicit {
    links: Vec<Candidate>,
    from: HashSet<String>,
    to: HashSet<String>,
    pairs: HashMap<String, HashSet<String>>,
}

/// Linked-trip candidates a City keeps between timetables. Block inference
/// partitions trips by block and service_id, so each service's continuations
/// are independent of the others: consecutive dates mostly share services and
/// need no new query. Least recently used services beyond the budget are
/// dropped; the services of the active timetable always stay.
#[derive(Default)]
pub(super) struct CandidateCache {
    explicit: Option<Arc<Explicit>>,
    by_service: HashMap<String, Arc<Vec<Candidate>>>,
    /// Least recently used first.
    recent: std::collections::VecDeque<String>,
    present: Option<bool>,
    has_blocks: Option<bool>,
}

/// Inferred continuations kept for services outside the active timetable.
const RETAINED_SERVICE_BYTES: usize = 8 * 1024 * 1024;

impl CandidateCache {
    /// Candidates for `services`, and whether every part was already cached.
    pub(super) fn candidates(
        &mut self,
        db: &Connection,
        services: &[String],
    ) -> Result<(Candidates, bool)> {
        let present = match self.present {
            Some(present) => present,
            None => *self.present.insert(present(db)?),
        };
        if !present {
            return Ok((
                Candidates {
                    explicit: Default::default(),
                    inferred: Vec::new(),
                },
                true,
            ));
        }
        let mut reused = true;
        let explicit = match &self.explicit {
            Some(explicit) => explicit.clone(),
            None => {
                reused = false;
                self.explicit.insert(Arc::new(load_explicit(db)?)).clone()
            }
        };
        let has_blocks = match self.has_blocks {
            Some(has_blocks) => has_blocks,
            None => *self.has_blocks.insert(has_block_trips(db)?),
        };
        if !has_blocks {
            return Ok((
                Candidates {
                    explicit,
                    inferred: Vec::new(),
                },
                reused,
            ));
        }
        let missing: Vec<String> = services
            .iter()
            .filter(|s| !self.by_service.contains_key(*s))
            .cloned()
            .collect();
        if !missing.is_empty() {
            reused = false;
            let mut found = infer_block_links(db, &missing, &explicit)?;
            for service in missing {
                let links = found.remove(&service).unwrap_or_default();
                self.by_service.insert(service, Arc::new(links));
            }
        }
        // Mark the requested services most recent, then trim older ones.
        let requested: HashSet<&String> = services.iter().collect();
        self.recent.retain(|s| !requested.contains(s));
        self.recent.extend(services.iter().cloned());
        let mut retained: usize = self.by_service.values().map(|c| candidate_bytes(c)).sum();
        while retained > RETAINED_SERVICE_BYTES {
            let Some(oldest) = self.recent.front() else {
                break;
            };
            if requested.contains(oldest) {
                break;
            }
            let oldest = self.recent.pop_front().unwrap();
            if let Some(links) = self.by_service.remove(&oldest) {
                retained -= candidate_bytes(&links);
            }
        }
        let inferred = services
            .iter()
            .filter_map(|s| self.by_service.get(s).cloned())
            .collect();
        Ok((Candidates { explicit, inferred }, reused))
    }

    pub(super) fn estimated_bytes(&self) -> usize {
        self.explicit
            .as_deref()
            .map_or(0, Explicit::estimated_bytes)
            + self
                .by_service
                .iter()
                .map(|(service, links)| service.capacity() + candidate_bytes(links))
                .sum::<usize>()
            + self.recent.iter().map(String::capacity).sum::<usize>()
    }
}

fn candidate_bytes(candidates: &[Candidate]) -> usize {
    std::mem::size_of_val(candidates)
        + candidates
            .iter()
            .map(|c| c.from.capacity() + c.to.capacity())
            .sum::<usize>()
}

fn string_set_bytes(set: &HashSet<String>) -> usize {
    set.capacity() * (std::mem::size_of::<String>() + 1)
        + set.iter().map(String::capacity).sum::<usize>()
}

impl Explicit {
    fn estimated_bytes(&self) -> usize {
        candidate_bytes(&self.links)
            + string_set_bytes(&self.from)
            + string_set_bytes(&self.to)
            + self.pairs.capacity() * (std::mem::size_of::<(String, HashSet<String>)>() + 1)
            + self
                .pairs
                .iter()
                .map(|(k, v)| k.capacity() + string_set_bytes(v))
                .sum::<usize>()
    }
}

impl Candidates {
    fn all(&self) -> impl Iterator<Item = &Candidate> {
        self.explicit
            .links
            .iter()
            .chain(self.inferred.iter().flat_map(|links| links.iter()))
    }
}

fn load_explicit(db: &Connection) -> Result<Explicit> {
    let mut explicit = Explicit::default();
    if !has_table(db, "trip_links")? {
        return Ok(explicit);
    }
    // The (trip_id, stop_sequence) key answers MAX with an endpoint lookup.
    // Joining every connection before grouping repeatedly scanned entire
    // trips just to find their terminal sequence.
    let mut statement = db.prepare(
        "SELECT l.from_trip_id,l.to_trip_id,
          (SELECT MAX(stop_sequence) FROM connections WHERE trip_id=l.from_trip_id) AS terminal,
          (SELECT MIN(stop_sequence) FROM connections WHERE trip_id=l.to_trip_id)
          FROM trip_links l WHERE l.transfer_type=4 AND terminal IS NOT NULL
          GROUP BY l.from_trip_id,l.to_trip_id ORDER BY l.from_trip_id,l.to_trip_id",
    )?;
    for row in statement.query_map([], |r| {
        Ok(Candidate {
            from: r.get(0)?,
            to: r.get(1)?,
            terminal: r.get(2)?,
            inferred: false,
            first: r.get(3)?,
        })
    })? {
        explicit.links.push(row?);
    }
    // Index explicit overrides once. A correlated OR subquery scans the
    // complete links table for every block pair on real regional feeds.
    let mut statement =
        db.prepare("SELECT from_trip_id,to_trip_id,transfer_type FROM trip_links")?;
    for row in statement.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, u32>(2)?,
        ))
    })? {
        let (from, to, kind) = row?;
        if kind == 4 {
            explicit.from.insert(from.clone());
            explicit.to.insert(to.clone());
        }
        explicit.pairs.entry(from).or_default().insert(to);
    }
    Ok(explicit)
}

/// Inferred block continuations of `services`, by service. Derive adjacency
/// from the static schedule, never from the surviving realtime trips:
/// canceling the middle vehicle must not bridge a gap. Shared service_id
/// establishes a common calendar. Other block models require explicit links
/// instead of guessing cross-calendar continuity.
fn infer_block_links(
    db: &Connection,
    services: &[String],
    explicit: &Explicit,
) -> Result<HashMap<String, Vec<Candidate>>> {
    let mut inferred: HashMap<String, Vec<Candidate>> = HashMap::new();
    let mut statement = db.prepare(
        "SELECT trip_id,service_id,block_id,head,tail FROM (
        SELECT t.trip_id,t.service_id,o.block_id,
          (SELECT (stop_sequence<<32)|departure FROM connections WHERE trip_id=t.trip_id
            ORDER BY stop_sequence LIMIT 1) AS head,
          (SELECT (stop_sequence<<32)|arrival FROM connections WHERE trip_id=t.trip_id
            ORDER BY stop_sequence DESC LIMIT 1) AS tail
        FROM trip_operations o JOIN trips t USING(trip_id)
        WHERE o.block_id IS NOT NULL AND t.service_id IN (SELECT value FROM json_each(?1)))
      WHERE head IS NOT NULL",
    )?;
    struct Bound {
        trip: String,
        service: String,
        block: String,
        departure: i64,
        arrival: i64,
        terminal: u32,
        first: u32,
    }
    let mut bounds = statement
        .query_map([serde_json::to_string(services)?], |r| {
            let (head, tail): (i64, i64) = (r.get(3)?, r.get(4)?);
            Ok(Bound {
                trip: r.get(0)?,
                service: r.get(1)?,
                block: r.get(2)?,
                departure: head & 0xffff_ffff,
                arrival: tail & 0xffff_ffff,
                terminal: (tail >> 32) as u32,
                first: (head >> 32) as u32,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    // Adjacent trips of one block and calendar, in departure order (SQL
    // binary text order breaks ties). Unique adjacent departure times are
    // equivalent to both COUNT guards; the running arrival maximum prevents
    // an earlier overlapping trip from being bridged. One sort and one pass
    // replace three SQL window functions that dominated preparation.
    bounds.sort_unstable_by(|a, b| {
        (&a.block, &a.service, a.departure, &a.trip).cmp(&(
            &b.block,
            &b.service,
            b.departure,
            &b.trip,
        ))
    });
    let mut group = 0;
    let mut previous_arrival = None::<i64>;
    for k in 0..bounds.len() {
        let row = &bounds[k];
        if k > 0 && (&bounds[k - 1].block, &bounds[k - 1].service) != (&row.block, &row.service) {
            group = k;
            previous_arrival = None;
        }
        let same = |j: usize| {
            bounds
                .get(j)
                .filter(|b| b.block == row.block && b.service == row.service)
        };
        let previous_departure = (k > group).then(|| bounds[k - 1].departure);
        if let Some(next) = same(k + 1)
            && row.arrival <= next.departure
            && row.departure < next.departure
            && previous_departure.is_none_or(|d| d < row.departure)
            && same(k + 2).is_none_or(|following| next.departure < following.departure)
            && previous_arrival.is_none_or(|a| a <= row.departure)
            && !explicit.from.contains(&row.trip)
            && !explicit.to.contains(&next.trip)
            && !explicit
                .pairs
                .get(&row.trip)
                .is_some_and(|targets| targets.contains(&next.trip))
        {
            inferred
                .entry(row.service.clone())
                .or_default()
                .push(Candidate {
                    from: row.trip.clone(),
                    to: next.trip.clone(),
                    terminal: row.terminal,
                    inferred: true,
                    first: Some(next.first),
                });
        }
        previous_arrival = Some(previous_arrival.map_or(row.arrival, |a| a.max(row.arrival)));
    }
    Ok(inferred)
}

/// Candidates for `services` from a fresh cache; activation keeps a
/// [`CandidateCache`] per City instead.
#[cfg(test)]
fn load_candidates(db: &Connection, services: &[String]) -> Result<Candidates> {
    Ok(CandidateCache::default().candidates(db, services)?.0)
}

pub(super) fn compile(
    candidates: &Candidates,
    a: &mut ServiceTimetableResult,
    names: &mut TimetableNames,
) -> Result<Links> {
    if candidates.all().next().is_none() {
        return Ok(Links::default());
    }
    let mut instances: HashMap<&str, Vec<usize>> = HashMap::new();
    for (i, id) in names.trip_ids.iter().enumerate() {
        if a.trip_start[i] < a.trip_start[i + 1] {
            instances.entry(id).or_default().push(i);
        }
    }
    let mut edges = vec![Vec::new(); names.trip_ids.len()];
    let mut incoming = vec![false; edges.len()];
    for Candidate {
        from,
        to,
        terminal,
        inferred,
        first,
    } in candidates.all()
    {
        let (Some(sources), Some(targets)) =
            (instances.get(from.as_str()), instances.get(to.as_str()))
        else {
            continue;
        };
        for &source in sources {
            let end = a.trip_start[source + 1] as usize - 1;
            // A truncated horizon or canceled tail is not the end of a trip.
            if a.sequence[end] != *terminal {
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
                        && (!*inferred
                            || (date_a == date_b && a.to_stop[end] == a.from_stop[start]))
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
                if intact && Some(a.sequence[a.trip_start[target] as usize]) == *first {
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
        return Ok(Links::default());
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
    // A through run already serves every call of its physical trips, and a
    // rider may board or alight at any of them. Keeping the original copies
    // too doubled the scanned connections on Cities whose blocks link most
    // trips. Retain each linked trip's identity, but not its segments, as
    // for a canceled trip; presentation maps through-run rides to its parts.
    let original_trips = names.trip_ids.len();
    let mut chained = vec![false; original_trips];
    for part in links.values().flatten() {
        chained[part.trip as usize] = true;
    }
    let original_segments = trip_start[original_trips] as usize;
    let keep: Vec<bool> = (0..departure_seconds.len())
        .map(|i| i >= original_segments || !chained[segment_trip[i] as usize])
        .collect();
    let mut removed = 0;
    for trip in 0..trip_start.len() {
        let start = trip_start[trip];
        trip_start[trip] = start - removed;
        if trip < original_trips && chained[trip] {
            removed += trip_start[trip + 1] - start;
        }
    }
    macro_rules! compact {($($field:ident),*) => {$(
        let mut kept = keep.iter();
        $field.retain(|_| *kept.next().unwrap());
    )*};}
    compact!(
        departure_seconds,
        arrival_seconds,
        from_stop,
        to_stop,
        sequence,
        segment_trip,
        segment_run,
        continuity_break,
        can_board,
        can_alight
    );
    // Every kernel run must keep at least one segment: renumber the runs
    // that remain, preserving their order.
    let mut run_ids = vec![u32::MAX; a.run_count as usize];
    for &run in &segment_run {
        run_ids[run as usize] = 0;
    }
    let mut next_run = 0;
    for id in &mut run_ids {
        if *id == 0 {
            *id = next_run;
            next_run += 1;
        }
    }
    for run in &mut segment_run {
        *run = run_ids[*run as usize];
    }
    a.run_count = next_run;
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
    Ok(Links::new(links))
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
    fn explicit_candidates_preserve_terminals_missing_trips_and_calendar_reuse() {
        let (db, _, _) = fixture(&[100, 200], &[200, 300], &["2026-07-15"; 2]);
        db.execute_batch("INSERT INTO connections VALUES('A',9),('A',3),('B',7);
          INSERT INTO trip_links VALUES('A','B',4),('missing','B',4),('A','missing',4),('B','A',5);").unwrap();
        let candidates = load_candidates(&db, &["S".into()]).unwrap();
        let actual: Vec<_> = candidates
            .all()
            .map(|c| (c.from.as_str(), c.to.as_str(), c.terminal, c.first))
            .collect();
        // Duplicate links stay deduplicated, absent source trips are excluded,
        // absent targets stay unusable, and type 5 never creates a continuation.
        assert_eq!(actual, [("A", "B", 9, Some(1)), ("A", "missing", 9, None)]);
        // Explicit links do not depend on the calendar: other dates reuse them.
        let mut cache = CandidateCache::default();
        assert!(!cache.candidates(&db, &["S".into()]).unwrap().1);
        assert!(
            cache
                .candidates(&db, &["different-calendar".into()])
                .unwrap()
                .1
        );
        assert!(cache.candidates(&db, &[]).unwrap().1);
        db.execute_batch(
            "CREATE TABLE trip_operations(trip_id TEXT,block_id TEXT);
          INSERT INTO trip_operations VALUES('A',NULL),('B',NULL);",
        )
        .unwrap();
        // Empty block metadata never forces a per-calendar query.
        let mut cache = CandidateCache::default();
        cache.candidates(&db, &["S".into()]).unwrap();
        assert!(cache.candidates(&db, &["other".into()]).unwrap().1);
    }
    #[test]
    fn keeps_next_service_day_clocks_and_original_sequences() {
        let (db, mut a, mut names) = fixture(
            &[85800, 86700],
            &[86400, 87600],
            &["2026-07-15", "2026-07-16"],
        );
        let links = compile(
            &load_candidates(&db, &["S".into()]).unwrap(),
            &mut a,
            &mut names,
        )
        .unwrap();
        assert_eq!(links.len(), 1);
        // Only the through run carries the calls; the linked trips keep their
        // identities and original sequences through its parts.
        assert_eq!(&*a.departure_seconds, &[85800, 86700]);
        assert_eq!(&*a.sequence, &[1, 2]);
        assert_eq!(&*a.trip_start, &[0, 0, 0, 2]);
        assert_eq!(links[&2][1].trip, 1);
        assert_eq!(links[&2][1].sequences, vec![1]);
        assert_eq!(&*a.segment_run, &[0, 0]);
        assert_eq!(a.run_count, 1);
        assert_eq!(links.through(1, 1.), Some((2, 2., [2., 2.])));
    }
    #[test]
    fn rejects_invalid_continuity_without_inventing_a_trip() {
        for (departures, arrivals, dates) in [
            ([100, 150], [200, 300], ["2026-07-15", "2026-07-15"]),
            ([100, 500], [200, 600], ["2026-07-15", "2026-07-17"]),
        ] {
            let (db, mut a, mut names) = fixture(&departures, &arrivals, &dates);
            assert!(
                compile(
                    &load_candidates(&db, &["S".into()]).unwrap(),
                    &mut a,
                    &mut names
                )
                .unwrap()
                .is_empty()
            );
            assert_eq!(a.run_count, 2);
        }
        let (db, mut a, mut names) = fixture(&[100, 200], &[200, 300], &["2026-07-15"; 2]);
        a.from_stop[1] = 0;
        assert_eq!(
            compile(
                &load_candidates(&db, &["S".into()]).unwrap(),
                &mut a,
                &mut names
            )
            .unwrap()
            .len(),
            1
        );
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
            let links = compile(
                &load_candidates(&db, &["S".into()]).unwrap(),
                &mut a,
                &mut names,
            )
            .unwrap();
            assert_eq!(
                links.len(),
                usize::from(!forbidden && !other_date && !other_stop)
            );
        }
    }
    #[test]
    fn block_candidates_keep_duplicate_and_overlap_guards() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE trips(trip_id TEXT PRIMARY KEY,service_id TEXT);
          CREATE TABLE trip_operations(trip_id TEXT PRIMARY KEY,block_id TEXT);
          CREATE TABLE connections(trip_id TEXT,stop_sequence INTEGER,departure INTEGER,arrival INTEGER);").unwrap();
        for (id, block, service, departure, arrival) in [
            ("A", "valid", "S", 100, 200),
            ("B", "valid", "S", 200, 300),
            ("C", "valid", "S", 400, 500),
            ("D", "duplicate", "S", 100, 200),
            ("E", "duplicate", "S", 100, 150),
            ("F", "duplicate", "S", 250, 300),
            ("G", "overlap", "S", 100, 500),
            ("H", "overlap", "S", 200, 250),
            ("I", "overlap", "S", 300, 350),
            ("J", "overlap", "S", 550, 600),
            ("K", "overlap", "S", 650, 700),
            ("L", "valid", "other", 200, 300),
            ("M", "valid", "other", 400, 500),
        ] {
            db.execute("INSERT INTO trips VALUES(?,?)", (id, service))
                .unwrap();
            db.execute("INSERT INTO trip_operations VALUES(?,?)", (id, block))
                .unwrap();
            db.execute(
                "INSERT INTO connections VALUES(?,1,?,?)",
                (id, departure, arrival),
            )
            .unwrap();
        }
        let candidates = load_candidates(&db, &["S".into()]).unwrap();
        let mut pairs: Vec<_> = candidates
            .all()
            .map(|c| (c.from.as_str(), c.to.as_str()))
            .collect();
        pairs.sort_unstable();
        assert_eq!(pairs, [("A", "B"), ("B", "C"), ("J", "K")]);
        // Each service's continuations are independent and cached: another
        // calendar reuses the explicit links and queries only its own service.
        let mut cache = CandidateCache::default();
        let (_, reused) = cache.candidates(&db, &["S".into()]).unwrap();
        assert!(!reused);
        let (other, reused) = cache.candidates(&db, &["other".into()]).unwrap();
        assert!(!reused);
        let (both, reused) = cache
            .candidates(&db, &["other".into(), "S".into()])
            .unwrap();
        assert!(reused);
        assert!(Arc::ptr_eq(&other.explicit, &both.explicit));
        assert_eq!(both.all().count(), 4);
        let other: Vec<_> = other.all().collect();
        assert_eq!(other.len(), 1);
        assert_eq!((&*other[0].from, &*other[0].to), ("L", "M"));
    }

    #[test]
    fn rejects_a_zero_time_cycle() {
        let (db, mut a, mut names) = fixture(&[100, 100], &[100, 100], &["2026-07-15"; 2]);
        a.from_stop = vec![0, 0].into();
        a.to_stop = vec![0, 0].into();
        db.execute("INSERT INTO trip_links VALUES('B','A',4)", [])
            .unwrap();
        assert!(
            compile(
                &load_candidates(&db, &["S".into()]).unwrap(),
                &mut a,
                &mut names
            )
            .is_err()
        );
    }
}
