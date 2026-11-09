//! Compact weekly turn windows; no per-edge time data or expanded graph.
use chrono::{Datelike, Duration, LocalResult, NaiveDate, Offset, TimeZone, Timelike};
use chrono_tz::Tz;
use rusqlite::Connection;
use std::collections::HashMap;

// Prepared object kind and source identifier to compact permission window.
type WindowIds = HashMap<(u8, i64), u32>;

#[derive(Clone, Copy)]
pub(crate) struct BikeClock {
    pub epoch: f64,
    pub zone: Tz,
}
impl BikeClock {
    pub fn service(date: &str, zone: &str, seconds: f64) -> Result<Self, String> {
        let day = NaiveDate::parse_from_str(date, "%Y-%m-%d")
            .map_err(|_| "Invalid bicycle serviceDate")?;
        if day.format("%Y-%m-%d").to_string() != date
            || !(1..=9999).contains(&day.year())
            || !seconds.is_finite()
            || seconds.abs() > 604800.
        {
            return Err("Invalid bicycle service clock".into());
        }
        let zone: Tz = zone.parse().map_err(|_| "Invalid bicycle timeZone")?;
        let epoch =
            crate::realtime::service_epoch(zone, day).map_err(|e| e.to_string())? as f64 + seconds;
        Ok(Self { epoch, zone })
    }

    /// A skipped weekly permission must be revisited in the next civil week.
    /// Window boundaries inside a gap are represented by its ending instant.
    pub fn offset_changes_at(self, elapsed: f64) -> Result<bool, String> {
        let at = chrono::DateTime::from_timestamp((self.epoch + elapsed).floor() as i64, 0)
            .ok_or("Bicycle movement exceeds the supported calendar")?;
        let before = at
            .checked_sub_signed(Duration::seconds(1))
            .ok_or("Bicycle movement precedes the supported calendar")?;
        Ok(at.with_timezone(&self.zone).offset().fix()
            != before.with_timezone(&self.zone).offset().fix())
    }
}

#[derive(Default, serde::Serialize, serde::Deserialize)]
pub(crate) struct TurnWindows {
    // Index zero always applies, including old Cities and unknown conditions.
    pub schedules: Vec<Vec<(u16, u16)>>,
}
impl TurnWindows {
    /// Supplemental road permissions are separate from legacy bicycle edges.
    /// Their schedules describe allowed entry times; a missing request clock
    /// must never turn them into unconditional permissions.
    pub fn load_edges(
        &mut self,
        db: &Connection,
    ) -> Result<HashMap<i64, u32>, Box<dyn std::error::Error>> {
        let tables: u32 = db.query_row("SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN ('bike_timed_edges','bike_edge_windows')", [], |r| r.get(0))?;
        if tables == 0 {
            return Ok(HashMap::new());
        }
        if tables != 2 {
            return Err("Incomplete bicycle edge-window tables".into());
        }
        let version: String = db.query_row(
            "SELECT value FROM metadata WHERE key='bikeEdgeWindowVersion'",
            [],
            |r| r.get(0),
        )?;
        if version != "1" {
            return Err("Unsupported bicycle edge-window version".into());
        }
        let mut rows = HashMap::<i64, Vec<(u16, u16)>>::new();
        for row in db.prepare("SELECT window_id,start_minute,end_minute FROM bike_edge_windows ORDER BY window_id,start_minute")?.query_map([], |r| Ok((r.get::<_,i64>(0)?,r.get::<_,u16>(1)?,r.get::<_,u16>(2)?)))? {
            let (id,start,end) = row?;
            if id <= 0 || start >= end || end > 10080 { return Err("Invalid bicycle edge window".into()); }
            let intervals = rows.entry(id).or_default();
            if intervals.len() >= 256 || intervals.last().is_some_and(|&(_,previous)| start < previous) {
                return Err("Overlapping or excessive bicycle edge windows".into());
            }
            intervals.push((start,end));
        }
        let references: std::collections::HashSet<i64> = db
            .prepare("SELECT DISTINCT window_id FROM bike_timed_edges")?
            .query_map([], |r| r.get(0))?
            .collect::<Result<_, _>>()?;
        if references.len() != rows.len() || references.iter().any(|id| !rows.contains_key(id)) {
            return Err("Bicycle timed edges and windows do not match".into());
        }
        let mut intern: HashMap<Vec<(u16, u16)>, u32> = self
            .schedules
            .iter()
            .enumerate()
            .map(|(i, s)| (s.clone(), i as u32 + 1))
            .collect();
        let mut ids = HashMap::new();
        for (key, intervals) in rows {
            let id = *intern.entry(intervals.clone()).or_insert_with(|| {
                self.schedules.push(intervals);
                self.schedules.len() as u32
            });
            ids.insert(key, id);
        }
        Ok(ids)
    }

    pub fn load(db: &Connection) -> Result<(Self, WindowIds), Box<dyn std::error::Error>> {
        let mut result = Self::default();
        let mut ids = HashMap::new();
        if db.query_row(
            "SELECT count(*) FROM sqlite_master WHERE name='bike_turn_windows'",
            [],
            |r| r.get::<_, u32>(0),
        )? == 0
        {
            return Ok((result, ids));
        }
        let version: String = db.query_row(
            "SELECT value FROM metadata WHERE key='bikeTurnWindowVersion'",
            [],
            |r| r.get(0),
        )?;
        if version != "1" {
            return Err("Unsupported bicycle turn-window version".into());
        }
        let mut rows = HashMap::<(u8, i64), Vec<(u16, u16)>>::new();
        for row in db.prepare("SELECT turn_table,turn_row,start_minute,end_minute FROM bike_turn_windows ORDER BY turn_table,turn_row,start_minute")?.query_map([], |r| Ok((r.get::<_,u8>(0)?,r.get::<_,i64>(1)?,r.get::<_,u16>(2)?,r.get::<_,u16>(3)?)))? {
            let (kind, id, start, end) = row?;
            if kind > 1 || id <= 0 || start >= end || end > 10080 { return Err("Invalid bicycle turn window".into()); }
            let intervals = rows.entry((kind,id)).or_default();
            if intervals.len() >= 256 || intervals.last().is_some_and(|&(_,previous)| start < previous) {
                return Err("Overlapping or excessive bicycle turn windows".into());
            }
            intervals.push((start,end));
        }
        // Unknown row references must not silently disable a restriction.
        for &(kind, id) in rows.keys() {
            let sql = if kind == 0 {
                "SELECT count(*) FROM bike_turns WHERE rowid=?"
            } else {
                "SELECT count(*) FROM bike_way_turns WHERE rowid=?"
            };
            if db.query_row(sql, [id], |r| r.get::<_, u32>(0))? != 1 {
                return Err("Bicycle turn window has no matching restriction".into());
            }
        }
        let mut intern = HashMap::<Vec<(u16, u16)>, u32>::new();
        for (key, intervals) in rows {
            let id = *intern.entry(intervals.clone()).or_insert_with(|| {
                result.schedules.push(intervals);
                result.schedules.len() as u32
            });
            ids.insert(key, id);
        }
        Ok((result, ids))
    }

    #[cfg(any(feature = "standalone", test))]
    pub fn byte_length(&self) -> usize {
        self.schedules.capacity() * std::mem::size_of::<Vec<(u16, u16)>>()
            + self
                .schedules
                .iter()
                .map(|s| s.capacity() * 4)
                .sum::<usize>()
    }

    pub fn stable_until(&self, clock: BikeClock, horizon: f64) -> bool {
        horizon.is_finite()
            && horizon >= 0.
            && (1..=self.schedules.len() as u32).all(|id| {
                self.next_change(id, clock, 0.)
                    .is_none_or(|next| next > horizon)
            })
    }

    /// Constant permissions inside a proven improving-path horizon. A changing
    /// window remains unknown, so a relaxed search admits every possibility.
    pub fn scope(&self, clock: BikeClock, horizon: f64) -> Vec<Option<bool>> {
        std::iter::once(Some(true))
            .chain((1..=self.schedules.len() as u32).map(|id| {
                self.next_change(id, clock, 0.)
                    .is_none_or(|next| next > horizon)
                    .then(|| self.active(id, Some(clock), 0.))
            }))
            .collect()
    }

    /// Horizons between the same two events have identical scoped permissions.
    /// Compute once per shared search instead of retaining one window vector
    /// per target group.
    pub fn scope_events(&self, clock: BikeClock) -> Vec<f64> {
        let mut events: Vec<_> = (1..=self.schedules.len() as u32)
            .filter_map(|id| self.next_change(id, clock, 0.))
            .collect();
        events.sort_unstable_by(f64::total_cmp);
        events.dedup();
        events
    }

    /// Permissions that cannot change between a departure and its arrival
    /// deadline. A boundary exactly at the deadline remains unknown: the
    /// preceding segment may have entered immediately before it.
    pub fn scope_before(&self, clock: BikeClock, horizon: f64) -> Vec<Option<bool>> {
        std::iter::once(Some(true))
            .chain((1..=self.schedules.len() as u32).map(|id| {
                (horizon.is_finite()
                    && horizon >= 0.
                    && self
                        .previous_change(id, clock, 0.)
                        .is_none_or(|previous| previous < -horizon))
                .then(|| self.active(id, Some(clock), 0.))
            }))
            .collect()
    }

    pub fn active(&self, id: u32, clock: Option<BikeClock>, elapsed: f64) -> bool {
        let Some(clock) = clock.filter(|_| id != 0) else {
            return true;
        };
        let Some(now) = chrono::DateTime::from_timestamp((clock.epoch + elapsed).floor() as i64, 0)
        else {
            return true;
        };
        let local = now.with_timezone(&clock.zone);
        let minute =
            local.weekday().num_days_from_monday() * 1440 + local.hour() * 60 + local.minute();
        self.schedules[id as usize - 1]
            .iter()
            .any(|&(a, b)| a as u32 <= minute && minute < b as u32)
    }

    /// Next possible change in absolute elapsed seconds. Include both instants
    /// of repeated local times, and skip nonexistent local times at DST gaps.
    pub fn next_change(&self, id: u32, clock: BikeClock, elapsed: f64) -> Option<f64> {
        self.change(id, clock, elapsed, true)
    }

    /// Latest possible change at or before an absolute elapsed time. This is
    /// inclusive so a closed interval end can be crossed when searching back.
    /// Callers must inspect the preceding representable instant before asking
    /// again; subtracting a minute would skip legal sub-minute traversals.
    pub fn previous_change(&self, id: u32, clock: BikeClock, elapsed: f64) -> Option<f64> {
        self.change(id, clock, elapsed, false)
    }

    fn change(&self, id: u32, clock: BikeClock, elapsed: f64, forward: bool) -> Option<f64> {
        if id == 0 {
            return None;
        }
        let timestamp = clock.epoch + elapsed;
        let now = chrono::DateTime::from_timestamp(timestamp.floor() as i64, 0)?
            .with_timezone(&clock.zone);
        let monday = now
            .date_naive()
            .checked_sub_signed(Duration::days(now.weekday().num_days_from_monday() as i64))?;
        let midnight = monday.and_hms_opt(0, 0, 0)?;
        let mut closest = if forward {
            f64::INFINITY
        } else {
            f64::NEG_INFINITY
        };
        for week in if forward { 0..=1 } else { -1..=0 } {
            for &(a, b) in &self.schedules[id as usize - 1] {
                for minute in [a, b] {
                    let local = midnight
                        .checked_add_signed(Duration::minutes(week * 10080 + minute as i64))?;
                    let mut consider = |date: chrono::DateTime<Tz>| {
                        let epoch = date.timestamp() as f64;
                        if forward && epoch > timestamp {
                            closest = closest.min(epoch - clock.epoch);
                        } else if !forward && epoch <= timestamp {
                            closest = closest.max(epoch - clock.epoch);
                        }
                    };
                    match clock.zone.from_local_datetime(&local) {
                        LocalResult::Single(date) => consider(date),
                        LocalResult::Ambiguous(a, b) => {
                            consider(a);
                            consider(b);
                            // A clock rollback can enter/leave the interval
                            // between its two repeated boundary instances.
                            let (mut low, mut high) = (
                                a.timestamp().min(b.timestamp()),
                                a.timestamp().max(b.timestamp()),
                            );
                            let offset = clock.zone.timestamp_opt(low, 0).single()?.offset().fix();
                            while high - low > 1 {
                                let middle = low + (high - low) / 2;
                                if clock.zone.timestamp_opt(middle, 0).single()?.offset().fix()
                                    == offset
                                {
                                    low = middle;
                                } else {
                                    high = middle;
                                }
                            }
                            consider(clock.zone.timestamp_opt(high, 0).single()?);
                        }
                        LocalResult::None => {
                            if let Some(end) =
                                chrono_tz::GapInfo::new(&local, &clock.zone).and_then(|gap| gap.end)
                            {
                                consider(end);
                            }
                        }
                    }
                }
            }
        }
        closest.is_finite().then_some(closest)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn clock(time: &str) -> BikeClock {
        BikeClock {
            epoch: chrono::DateTime::parse_from_rfc3339(time)
                .unwrap()
                .timestamp() as f64,
            zone: chrono_tz::America::New_York,
        }
    }
    #[test]
    fn edge_windows_share_schedules_and_reject_incomplete_or_dangling_data() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE metadata(key TEXT,value TEXT);
            INSERT INTO metadata VALUES('bikeEdgeWindowVersion','1');
            CREATE TABLE bike_timed_edges(window_id INTEGER); INSERT INTO bike_timed_edges VALUES(1),(2);
            CREATE TABLE bike_edge_windows(window_id INTEGER,start_minute INTEGER,end_minute INTEGER);
            INSERT INTO bike_edge_windows VALUES(1,480,540),(2,480,540);").unwrap();
        let mut windows = TurnWindows {
            schedules: vec![vec![(480, 540)]],
        };
        let ids = windows.load_edges(&db).unwrap();
        assert_eq!(windows.schedules.len(), 1);
        assert_eq!(ids[&1], 1);
        assert_eq!(ids[&2], 1);
        for row in [
            "(3,0,1)",
            "(1,490,550)",
            "(1,-1,1)",
            "(1,540,10081)",
            "(1,540,540)",
        ] {
            db.execute_batch(&format!("INSERT INTO bike_edge_windows VALUES{row}"))
                .unwrap();
            assert!(windows.load_edges(&db).is_err(), "{row}");
            db.execute("DELETE FROM bike_edge_windows WHERE rowid=(SELECT max(rowid) FROM bike_edge_windows)",[]).unwrap();
        }
        db.execute("INSERT INTO bike_timed_edges VALUES(99)", [])
            .unwrap();
        assert!(windows.load_edges(&db).is_err());
        db.execute("DELETE FROM bike_timed_edges WHERE window_id=99", [])
            .unwrap();
        db.execute("UPDATE metadata SET value='2'", []).unwrap();
        assert!(windows.load_edges(&db).is_err());
        db.execute("DROP TABLE bike_edge_windows", []).unwrap();
        assert!(windows.load_edges(&db).is_err());
        db.execute("DROP TABLE bike_timed_edges", []).unwrap();
        assert!(windows.load_edges(&db).unwrap().is_empty());
    }

    #[test]
    fn weekly_windows_use_local_time_through_both_dst_transitions() {
        let windows = TurnWindows {
            schedules: vec![vec![(6 * 1440 + 90, 6 * 1440 + 105)]],
        };
        let first = clock("2026-11-01T05:35:00Z");
        let second = clock("2026-11-01T06:35:00Z");
        for c in [first, second] {
            assert!(windows.active(1, Some(c), 0.));
            assert!(!windows.active(1, Some(c), 600.));
            assert_eq!(windows.next_change(1, c, 0.), Some(600.));
            assert!(windows.stable_until(c, 599.));
            assert!(!windows.stable_until(c, 600.));
            assert!(!windows.stable_until(c, f64::INFINITY));
            assert_eq!(windows.scope(c, 599.), vec![Some(true), Some(true)]);
            assert_eq!(windows.scope(c, 600.), vec![Some(true), None]);
            let events = windows.scope_events(c);
            assert_eq!(events, vec![600.]);
            assert_eq!(events.partition_point(|&event| event <= 599.), 0);
            assert_eq!(events.partition_point(|&event| event <= 600.), 1);
        }
        let between = clock("2026-11-01T05:50:00Z");
        assert!(!windows.active(1, Some(between), 0.));
        assert_eq!(windows.scope(between, 599.), vec![Some(true), Some(false)]);
        assert_eq!(windows.scope(between, 600.), vec![Some(true), None]);
        assert_eq!(windows.next_change(1, between, 0.), Some(600.));
        assert!(!windows.active(1, Some(between), 600.));
        assert_eq!(windows.next_change(1, between, 600.), Some(2400.));
        let gap = TurnWindows {
            schedules: vec![vec![(6 * 1440 + 120, 6 * 1440 + 180)]],
        };
        let spring = clock("2026-03-08T06:59:00Z");
        assert!(!gap.active(1, Some(spring), 0.));
        assert!(!gap.active(1, Some(spring), 60.));
        assert_eq!(gap.next_change(1, spring, 0.), Some(60.));
        assert!(gap.stable_until(spring, 59.));
        assert_eq!(gap.scope(spring, 59.), vec![Some(true), Some(false)]);
        assert_eq!(gap.scope(spring, 60.), vec![Some(true), None]);
        assert_eq!(gap.scope_events(spring), vec![60.]);
        assert!(!gap.stable_until(spring, 60.));
        assert!(windows.active(1, None, 0.));
        assert!(windows.active(0, Some(first), 0.));
        let spans_fold = TurnWindows {
            schedules: vec![vec![(6 * 1440 + 105, 6 * 1440 + 135)]],
        };
        assert!(spans_fold.active(1, Some(between), 0.));
        assert_eq!(spans_fold.next_change(1, between, 0.), Some(600.));
        assert!(!spans_fold.active(1, Some(between), 600.));
        let starts_in_gap = TurnWindows {
            schedules: vec![vec![(6 * 1440 + 150, 6 * 1440 + 240)]],
        };
        assert_eq!(starts_in_gap.next_change(1, spring, 0.), Some(60.));
        assert!(starts_in_gap.active(1, Some(spring), 60.));
    }

    #[test]
    fn turn_windows_validate_references_and_share_repeated_schedules() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE metadata(key TEXT,value TEXT);
            INSERT INTO metadata VALUES('bikeTurnWindowVersion','1');
            CREATE TABLE bike_turns(x INTEGER); INSERT INTO bike_turns VALUES(1),(2);
            CREATE TABLE bike_way_turns(x INTEGER); INSERT INTO bike_way_turns VALUES(1);
            CREATE TABLE bike_turn_windows(turn_table INTEGER,turn_row INTEGER,start_minute INTEGER,end_minute INTEGER);
            INSERT INTO bike_turn_windows VALUES(0,1,480,540),(0,2,480,540),(1,1,480,540);").unwrap();
        let (windows, ids) = TurnWindows::load(&db).unwrap();
        assert_eq!(windows.schedules.len(), 1);
        assert_eq!(ids[&(0, 1)], ids[&(0, 2)]);
        assert_eq!(ids[&(0, 1)], ids[&(1, 1)]);
        for row in [
            "(0,99,0,1)",
            "(2,1,0,1)",
            "(0,1,540,10081)",
            "(0,1,-1,1)",
            "(0,1,490,550)",
            "(0,1,540,540)",
        ] {
            db.execute_batch(&format!("INSERT INTO bike_turn_windows VALUES{row}"))
                .unwrap();
            assert!(TurnWindows::load(&db).is_err(), "{row}");
            db.execute("DELETE FROM bike_turn_windows WHERE rowid=(SELECT max(rowid) FROM bike_turn_windows)",[]).unwrap();
        }
        db.execute("UPDATE metadata SET value='2'", []).unwrap();
        assert!(TurnWindows::load(&db).is_err());
        db.execute("DROP TABLE bike_turn_windows", []).unwrap();
        let (windows, ids) = TurnWindows::load(&db).unwrap();
        assert_eq!(windows.byte_length(), 0);
        assert!(ids.is_empty());
        assert!(BikeClock::service("2026-11-02", "not-a-zone", 0.).is_err());
        assert!(BikeClock::service("2026-11-2", "UTC", 0.).is_err());
        assert!(BikeClock::service("2026-11-02", "UTC", f64::NAN).is_err());
    }

    #[test]
    fn event_candidates_cover_every_second_of_clock_discontinuities() {
        for (zone, start, a, b) in [
            (
                "America/New_York",
                "2026-11-01T04:30:00Z",
                6 * 1440 + 105,
                6 * 1440 + 135,
            ),
            (
                "America/New_York",
                "2026-03-08T06:00:00Z",
                6 * 1440 + 150,
                6 * 1440 + 240,
            ),
            (
                "Australia/Lord_Howe",
                "2026-04-04T14:00:00Z",
                6 * 1440 + 100,
                6 * 1440 + 110,
            ),
            (
                "Africa/Monrovia",
                "1972-01-07T00:00:00Z",
                4 * 1440,
                4 * 1440 + 60,
            ),
        ] {
            let mut c = clock(start);
            c.zone = zone.parse().unwrap();
            let windows = TurnWindows {
                schedules: vec![vec![(a, b)]],
            };
            let mut candidates = Vec::new();
            let mut at = 0.;
            while let Some(next) = windows.next_change(1, c, at).filter(|&n| n <= 14400.) {
                assert!(next > at);
                candidates.push(next);
                at = next;
            }
            let mut reverse = Vec::new();
            let mut at = 14400.;
            while let Some(previous) = windows.previous_change(1, c, at).filter(|&n| n > 0.) {
                assert!(previous <= at);
                reverse.push(previous);
                at = (c.epoch + previous).next_down() - c.epoch;
                assert!(
                    at < previous,
                    "The backward cursor must cross the actual epoch boundary"
                );
            }
            reverse.reverse();
            assert_eq!(
                reverse, candidates,
                "{zone}: forward/reverse events disagree"
            );
            let mut previous = windows.active(1, Some(c), 0.);
            for second in 1..=14400 {
                let active = windows.active(1, Some(c), second as f64);
                if active != previous {
                    assert!(
                        candidates.contains(&(second as f64)),
                        "{zone}: missing {second}"
                    );
                }
                previous = active;
            }
        }
    }

    #[test]
    fn backward_windows_preserve_fractional_deadlines_and_week_boundaries() {
        let windows = TurnWindows {
            schedules: vec![vec![(480, 540)], vec![(0, 1), (10079, 10080)]],
        };
        let c = BikeClock::service("2026-11-02", "America/New_York", 9. * 3600.).unwrap();
        assert!(!windows.active(1, Some(c), 0.));
        assert_eq!(windows.previous_change(1, c, 0.), Some(0.));
        let before = c.epoch.next_down() - c.epoch;
        assert!(before < 0.);
        assert!(windows.active(1, Some(c), before));
        assert_eq!(windows.previous_change(1, c, before), Some(-3600.));
        assert_eq!(windows.previous_change(1, c, -3600.), Some(-3600.));
        // The preceding Monday was still on daylight time: not exactly 7 days.
        let preceding_close =
            BikeClock::service("2026-10-26", "America/New_York", 9. * 3600.).unwrap();
        assert_eq!(
            windows.previous_change(1, c, -3600.25),
            Some(preceding_close.epoch - c.epoch)
        );
        let inside = BikeClock {
            epoch: c.epoch - 120.25,
            ..c
        };
        assert_eq!(
            windows.scope_before(inside, 3479.),
            vec![Some(true), Some(true), Some(false)]
        );
        assert_eq!(
            windows.scope_before(inside, 3480.),
            vec![Some(true), None, Some(false)]
        );
        assert_eq!(windows.scope_before(c, 0.)[1], None);
        assert_eq!(windows.scope_before(c, -1.)[1], None);
        assert_eq!(windows.scope_before(c, f64::INFINITY)[1], None);
        let monday = BikeClock::service("2026-11-02", "UTC", 0.).unwrap();
        assert_eq!(windows.previous_change(2, monday, 0.), Some(0.));
        assert_eq!(windows.previous_change(2, monday, -0.25), Some(-60.));
        assert!(windows.active(2, Some(monday), -0.25));
        assert!(windows.active(2, Some(monday), 0.25));
        assert_eq!(windows.previous_change(0, monday, 0.), None);
    }

    #[test]
    fn backward_scopes_never_certify_a_changing_permission() {
        for (zone, end) in [
            ("America/New_York", "2026-11-01T08:00:00Z"),
            ("America/New_York", "2026-03-08T09:00:00Z"),
            ("Australia/Lord_Howe", "2026-04-04T18:00:00Z"),
            ("Africa/Monrovia", "1972-01-07T04:00:00Z"),
        ] {
            let c = BikeClock {
                zone: zone.parse().unwrap(),
                ..clock(end)
            };
            let day = chrono::DateTime::from_timestamp(c.epoch as i64, 0)
                .unwrap()
                .with_timezone(&c.zone)
                .weekday()
                .num_days_from_monday() as u16
                * 1440;
            for start in [0, 30, 60, 90, 105, 120, 135, 150, 180] {
                for length in [15, 30, 60, 120] {
                    let windows = TurnWindows {
                        schedules: vec![vec![(day + start, day + start + length)]],
                    };
                    for horizon in [0., 900., 3600., 7200., 14400.] {
                        if let Some(active) = windows.scope_before(c, horizon)[1] {
                            for elapsed in -(horizon as i64)..=0 {
                                assert_eq!(
                                    windows.active(1, Some(c), elapsed as f64),
                                    active,
                                    "{zone}: false backward certificate {start}/{length}, {horizon}, {elapsed}"
                                );
                            }
                        }
                    }
                }
            }
        }
    }
}
