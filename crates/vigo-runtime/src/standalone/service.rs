//! Resolve lossless GTFS transfer selectors into the active native timetable.
use super::{Result, linked_trips::Links};
use crate::realtime::TimetableNames;
use rusqlite::Connection;
use std::collections::HashMap;
use vigo_route::timetable::{HeadwayWindow, ServiceSemantics, TransferRule};

pub(super) fn present(db: &Connection) -> Result<bool> {
    let exists: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='transfer_rules')",
        [],
        |r| r.get(0),
    )?;
    let rules=exists && db.query_row("SELECT EXISTS(SELECT 1 FROM transfer_rules WHERE transfer_type<4 AND (transfer_type=1 OR from_route_id IS NOT NULL OR to_route_id IS NOT NULL OR from_trip_id IS NOT NULL OR to_trip_id IS NOT NULL))",[],|r|r.get::<_,bool>(0))?;
    let frequencies: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='headway_connections')",
        [],
        |r| r.get(0),
    )?;
    Ok(rules
        || (frequencies
            && db.query_row(
                "SELECT EXISTS(SELECT 1 FROM headway_connections)",
                [],
                |r| r.get::<_, bool>(0),
            )?))
}
pub(super) fn load(
    db: &Connection,
    names: &TimetableNames,
    links: &Links,
    source: &vigo_format::ServiceTimetableResult,
    service_offsets: &HashMap<String, i32>,
) -> Result<Option<ServiceSemantics>> {
    if !present(db)? {
        return Ok(None);
    }
    let routes: HashMap<&str, u32> = names
        .route_ids
        .iter()
        .map(String::as_str)
        .enumerate()
        .map(|(i, id)| (id, i as u32))
        .collect();
    let trip_routes = names
        .route_ids
        .iter()
        .map(|id| routes[id.as_str()])
        .collect();
    let mut physical_trips = vec![vec![]; names.trip_ids.len()];
    for (&trip, parts) in links {
        physical_trips[trip as usize] = parts.iter().map(|p| (p.first, p.trip)).collect();
    }
    let mut parents = HashMap::<String, String>::new();
    let mut stmt=db.prepare("SELECT stop_id,parent_station FROM stops WHERE parent_station IS NOT NULL AND parent_station<>''")?;
    for row in stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
        let (a, b) = row?;
        parents.insert(a, b);
    }
    let stops = |id: &str| -> Vec<u32> {
        names
            .stop_ids
            .iter()
            .enumerate()
            .filter_map(|(i, stop)| {
                let mut current = stop.as_str();
                let mut remaining = parents.len() + 1;
                while remaining > 0 {
                    if current == id {
                        return Some(i as u32);
                    }
                    let Some(parent) = parents.get(current) else {
                        break;
                    };
                    current = parent;
                    remaining -= 1;
                }
                None
            })
            .collect()
    };
    let mut origins = HashMap::<String, String>::new();
    if db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='trip_origins')",
        [],
        |r| r.get::<_, bool>(0),
    )? {
        let mut stmt = db.prepare("SELECT trip_id,source_trip_id FROM trip_origins")?;
        for row in stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
            let (trip, source) = row?;
            origins.insert(trip, source);
        }
    }
    let trips = |id: &Option<String>| -> Vec<Option<u32>> {
        match id {
            None => vec![None],
            Some(id) => names
                .trip_ids
                .iter()
                .enumerate()
                .filter_map(|(i, t)| (origins.get(t).unwrap_or(t) == id).then_some(Some(i as u32)))
                .collect(),
        }
    };
    let mut rules = Vec::new();
    let mut stmt=db.prepare("SELECT from_stop_id,to_stop_id,from_route_id,to_route_id,from_trip_id,to_trip_id,transfer_type,min_transfer_time FROM transfer_rules WHERE transfer_type<4")?;
    for row in stmt.query_map([], |r| {
        Ok((
            r.get::<_, Option<String>>(0)?,
            r.get::<_, Option<String>>(1)?,
            r.get::<_, Option<String>>(2)?,
            r.get::<_, Option<String>>(3)?,
            r.get::<_, Option<String>>(4)?,
            r.get::<_, Option<String>>(5)?,
            r.get::<_, u8>(6)?,
            r.get::<_, u32>(7)?,
        ))
    })? {
        let (from, to, fr, tr, ft, tt, kind, minimum) = row?;
        let (Some(from), Some(to)) = (from, to) else {
            return Err("Ordinary transfer rules require both stop selectors".into());
        };
        let from_route = fr.as_ref().and_then(|r| routes.get(r.as_str()).copied());
        let to_route = tr.as_ref().and_then(|r| routes.get(r.as_str()).copied());
        if (fr.is_some() && from_route.is_none()) || (tr.is_some() && to_route.is_none()) {
            continue;
        }
        for from_stop in stops(&from) {
            for to_stop in stops(&to) {
                for from_trip in trips(&ft) {
                    for to_trip in trips(&tt) {
                        if rules.len() >= 1_000_000 {
                            return Err(
                                "Expanded transfer rules exceed the native rule budget".into()
                            );
                        }
                        rules.push(TransferRule {
                            from_stop,
                            to_stop,
                            from_route,
                            to_route,
                            from_trip,
                            to_trip,
                            kind,
                            minimum,
                        });
                    }
                }
            }
        }
    }
    let mut headways = Vec::new();
    let mut stmt=db.prepare("SELECT trip_id,start_time,end_time,headway_secs,MIN(start_time) OVER (PARTITION BY trip_id) FROM frequencies WHERE exact_times=0")?;
    for row in stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, f64>(1)?,
            r.get::<_, f64>(2)?,
            r.get::<_, u32>(3)?,
            r.get::<_, f64>(4)?,
        ))
    })? {
        let (id, start, end, headway, first) = row?;
        for (trip, name) in names.trip_ids.iter().enumerate() {
            if *name != id || source.trip_start[trip] == source.trip_start[trip + 1] {
                continue;
            }
            let offset = service_offsets
                .get(&names.trip_service_dates[trip])
                .map(|offset| f64::from(*offset))
                .unwrap_or_else(|| {
                    f64::from(source.departure_seconds[source.trip_start[trip] as usize]) - first
                });
            headways.push(HeadwayWindow {
                trip: trip as u32,
                start: start + offset,
                end: end + offset,
                headway,
            });
        }
    }
    Ok(Some(ServiceSemantics {
        rules,
        trip_routes,
        physical_trips,
        headways,
    }))
}
