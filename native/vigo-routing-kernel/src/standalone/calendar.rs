//! Immutable calendar rules; dates are views over weekday masks and exceptions.
//! Service-clock offsets and overnight coverage are resolved by City, not here.
use super::Result;
use chrono::{Datelike, NaiveDate, TimeZone};
use rusqlite::Connection;
use std::collections::{BTreeMap, BTreeSet};
use std::mem::size_of;

/// GTFS service time starts twelve elapsed hours before local noon, even on DST days.
pub(crate) fn service_epoch(zone: chrono_tz::Tz, day: NaiveDate) -> Result<i64> {
    Ok(zone
        .from_local_datetime(&day.and_hms_opt(12, 0, 0).unwrap())
        .single()
        .ok_or("Service date has no unambiguous local noon")?
        .timestamp()
        - 43_200)
}

struct Weekly {
    service: usize,
    first: i32,
    last: i32,
    weekdays: u8,
}
pub(crate) struct CalendarIndex {
    services: Vec<String>,
    weekly: Vec<Weekly>,
    exceptions: BTreeMap<i32, Vec<(usize, bool)>>,
    scopes: BTreeSet<String>,
}
impl CalendarIndex {
    pub(crate) fn load(db: &Connection) -> Result<Self> {
        let services: Vec<String> = db
            .prepare("SELECT service_id FROM calendar UNION SELECT service_id FROM calendar_dates ORDER BY service_id")?
            .query_map([], |r| r.get(0))?
            .collect::<std::result::Result<_, _>>()?;
        let ids: BTreeMap<_, _> = services
            .iter()
            .enumerate()
            .map(|(i, s)| (s.as_str(), i))
            .collect();
        let weekly = db.prepare("SELECT service_id,start_date,end_date,COALESCE(monday,0),COALESCE(tuesday,0),COALESCE(wednesday,0),COALESCE(thursday,0),COALESCE(friday,0),COALESCE(saturday,0),COALESCE(sunday,0) FROM calendar WHERE start_date IS NOT NULL AND end_date IS NOT NULL")?
            .query_map([], |row| {
                let id: String = row.get(0)?;
                let mut weekdays = 0;
                for day in 0..7 {
                    if row.get::<_, i32>(3 + day)? == 1 { weekdays |= 1 << day; }
                }
                Ok(Weekly { service: ids[id.as_str()], first: row.get(1)?, last: row.get(2)?, weekdays })
            })?.collect::<std::result::Result<_, _>>()?;
        let mut exceptions: BTreeMap<i32, Vec<(usize, bool)>> = BTreeMap::new();
        for row in db
            .prepare("SELECT service_id,date,exception_type FROM calendar_dates")?
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i32>(1)?,
                    row.get::<_, i32>(2)?,
                ))
            })?
        {
            let (id, date, kind) = row?;
            if kind == 1 || kind == 2 {
                exceptions
                    .entry(date)
                    .or_default()
                    .push((ids[id.as_str()], kind == 1));
            }
        }
        let scopes = services
            .iter()
            .filter_map(|id| id.split_once('\u{1f}').map(|p| p.0.to_owned()))
            .collect();
        Ok(Self {
            services,
            weekly,
            exceptions,
            scopes,
        })
    }
    pub(crate) fn services_on(&self, date: NaiveDate) -> BTreeSet<String> {
        let number = date.year() * 10000 + date.month() as i32 * 100 + date.day() as i32;
        let weekday = 1 << date.weekday().num_days_from_monday();
        let mut active: BTreeSet<usize> = self
            .weekly
            .iter()
            .filter(|r| r.first <= number && number <= r.last && r.weekdays & weekday != 0)
            .map(|r| r.service)
            .collect();
        if let Some(exceptions) = self.exceptions.get(&number) {
            for &(id, added) in exceptions {
                if added {
                    active.insert(id);
                } else {
                    active.remove(&id);
                }
            }
        }
        active
            .into_iter()
            .map(|i| self.services[i].clone())
            .collect()
    }
    pub(crate) fn complete(&self, active: &BTreeSet<String>) -> bool {
        self.scopes.len() <= 1
            || self.scopes.iter().all(|scope| {
                active
                    .iter()
                    .any(|id| id.split_once('\u{1f}').is_some_and(|p| p.0 == scope))
            })
    }
    pub(crate) fn heap_bytes(&self) -> usize {
        self.services.capacity() * size_of::<String>()
            + self.services.iter().map(String::capacity).sum::<usize>()
            + self.weekly.capacity() * size_of::<Weekly>()
            + self
                .exceptions
                .values()
                .map(|v| 96 + v.capacity() * size_of::<(usize, bool)>())
                .sum::<usize>()
            + self.scopes.iter().map(|s| 96 + s.capacity()).sum::<usize>()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn compact_calendar_matches_sql_across_leap_day_exceptions_and_boundaries() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE calendar(service_id TEXT,start_date INTEGER,end_date INTEGER,monday INTEGER,tuesday INTEGER,wednesday INTEGER,thursday INTEGER,friday INTEGER,saturday INTEGER,sunday INTEGER);
            CREATE TABLE calendar_dates(service_id TEXT,date INTEGER,exception_type INTEGER);
            INSERT INTO calendar VALUES ('weekday',20240201,20240331,1,1,1,1,1,0,0),('weekend',20240201,20240331,0,0,0,0,0,1,1),('unset',NULL,20240331,1,1,1,1,1,1,1),('nullable',20240201,20240331,NULL,0,0,0,0,0,0);
            INSERT INTO calendar_dates VALUES ('weekday',20240229,2),('special',20240229,1),('weekend',20240401,1);").unwrap();
        let index = CalendarIndex::load(&db).unwrap();
        let start = NaiveDate::from_ymd_opt(2024, 1, 25).unwrap();
        for offset in 0..80 {
            let date = start + chrono::Duration::days(offset);
            let n = date.year() * 10000 + date.month() as i32 * 100 + date.day() as i32;
            let day = [
                "monday",
                "tuesday",
                "wednesday",
                "thursday",
                "friday",
                "saturday",
                "sunday",
            ][date.weekday().num_days_from_monday() as usize];
            let sql = format!(
                "SELECT service_id FROM calendar WHERE {day}=1 AND start_date<=?1 AND end_date>=?1 AND service_id NOT IN (SELECT service_id FROM calendar_dates WHERE date=?1 AND exception_type=2) UNION SELECT service_id FROM calendar_dates WHERE date=?1 AND exception_type=1"
            );
            let expected: BTreeSet<String> = db
                .prepare(&sql)
                .unwrap()
                .query_map([n], |r| r.get(0))
                .unwrap()
                .collect::<std::result::Result<_, _>>()
                .unwrap();
            assert_eq!(index.services_on(date), expected, "{date}");
        }
        assert!(index.heap_bytes() > 0);
    }
    #[test]
    fn completeness_includes_exception_only_sources() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE calendar(service_id TEXT,start_date INTEGER,end_date INTEGER,monday INTEGER,tuesday INTEGER,wednesday INTEGER,thursday INTEGER,friday INTEGER,saturday INTEGER,sunday INTEGER); CREATE TABLE calendar_dates(service_id TEXT,date INTEGER,exception_type INTEGER);").unwrap();
        for id in ["a\u{1f}weekday", "b\u{1f}special"] {
            db.execute("INSERT INTO calendar_dates VALUES (?1,20240229,1)", [id])
                .unwrap();
        }
        let index = CalendarIndex::load(&db).unwrap();
        assert!(!index.complete(&BTreeSet::from(["a\u{1f}weekday".into()])));
        assert!(index.complete(&index.services_on(NaiveDate::from_ymd_opt(2024, 2, 29).unwrap())));
    }
}

#[cfg(test)]
mod service_clock_tests {
    use super::*;
    #[test]
    fn service_epoch_tracks_dst_and_rejects_missing_local_dates() {
        let zone = chrono_tz::America::New_York;
        let epoch = |date| {
            service_epoch(zone, NaiveDate::parse_from_str(date, "%Y-%m-%d").unwrap()).unwrap()
        };
        assert_eq!(epoch("2026-03-08") - epoch("2026-03-07"), 23 * 3600);
        assert_eq!(epoch("2026-11-01") - epoch("2026-10-31"), 25 * 3600);
        assert!(
            service_epoch(
                chrono_tz::Pacific::Apia,
                NaiveDate::from_ymd_opt(2011, 12, 30).unwrap()
            )
            .is_err()
        );
    }
}
