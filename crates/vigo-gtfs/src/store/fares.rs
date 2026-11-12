//! GTFS fare catalogs (gtfs-fare-store.mjs). Fares never change paths; the
//! catalog is stored beside the routing graph as JSON.

use crate::Result;
use crate::jsval;
use crate::zip::{Archive, Budget, stream_csv};
use rusqlite::Connection;
use std::collections::HashSet;
use vigo_format::js::Js;

const FARE_TABLES: &[&str] = &[
    "fare_attributes",
    "fare_rules",
    "fare_products",
    "fare_media",
    "rider_categories",
    "fare_leg_rules",
    "fare_leg_join_rules",
    "fare_transfer_rules",
    "timeframes",
    "areas",
    "stop_areas",
    "networks",
    "route_networks",
];
const CONTEXT_FIELDS: &[(&str, &[&str])] = &[
    (
        "agency",
        &[
            "agency_id",
            "agency_name",
            "agency_fare_url",
            "agency_timezone",
        ],
    ),
    ("routes", &["route_id", "agency_id", "network_id"]),
    (
        "stops",
        &["stop_id", "parent_station", "zone_id", "stop_timezone"],
    ),
    (
        "calendar",
        &[
            "service_id",
            "start_date",
            "end_date",
            "monday",
            "tuesday",
            "wednesday",
            "thursday",
            "friday",
            "saturday",
            "sunday",
        ],
    ),
    ("calendar_dates", &["service_id", "date", "exception_type"]),
];

/// `readGtfsFareCatalog(archive, { budget })`.
pub fn read_fare_catalog(archive: &Archive, budget: &mut Budget) -> Result<Option<Js>> {
    if !["fare_products", "fare_attributes"]
        .iter()
        .any(|name| archive.table(&format!("{name}.txt")).is_some())
    {
        return Ok(None);
    }
    let mut tables: Vec<(String, Vec<Js>)> = Vec::new();
    let mut bytes = 0usize;
    let mut overflow = false;
    let names = FARE_TABLES
        .iter()
        .copied()
        .chain(CONTEXT_FIELDS.iter().map(|(name, _)| *name));
    for name in names {
        let Some(entry) = archive.table(&format!("{name}.txt")) else {
            continue;
        };
        // new Set(timeframes.map(row => row.service_id)); absent ids are undefined.
        let fare_services: HashSet<Option<String>> = tables
            .iter()
            .find(|(table, _)| table == "timeframes")
            .map(|(_, rows)| {
                rows.iter()
                    .map(|row| {
                        row.get("service_id")
                            .and_then(Js::as_str)
                            .map(str::to_owned)
                    })
                    .collect()
            })
            .unwrap_or_default();
        let context = CONTEXT_FIELDS
            .iter()
            .find(|(table, _)| *table == name)
            .map(|(_, fields)| *fields);
        let mut items = Vec::new();
        stream_csv(archive, entry, budget, None, &mut |row| {
            if matches!(name, "calendar" | "calendar_dates") {
                // fareServices.has(row.service_id); undefined never matches a stored id.
                let known = fare_services.contains(&row.get("service_id").map(str::to_owned));
                if !known {
                    return Ok(());
                }
            }
            let members: Vec<(String, Js)> = match context {
                Some(fields) => fields
                    .iter()
                    .filter_map(|field| {
                        row.get(field)
                            .map(|value| ((*field).to_owned(), Js::from(value)))
                    })
                    .collect(),
                None => row
                    .keys()
                    .into_iter()
                    .map(|key| (key.to_owned(), Js::from(row.get(key).unwrap_or(""))))
                    .collect(),
            };
            let item = jsval::object(members);
            if !overflow {
                bytes += item.stringify().len();
                overflow = bytes > 16 * 1024 * 1024;
                if !overflow {
                    items.push(item);
                }
            }
            Ok(())
        })?;
        tables.push((name.to_owned(), items));
        if overflow {
            return Ok(Some(
                Js::object()
                    .with("version", 1)
                    .with("tables", Js::object())
                    .with("unavailableReason", "Fare references exceed the supported catalog size. Boarding prices are unavailable."),
            ));
        }
    }
    let source = archive
        .zip_path
        .to_string_lossy()
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .to_owned();
    Ok(Some(
        Js::object().with("version", 1).with("source", source).with(
            "tables",
            jsval::object(
                tables
                    .into_iter()
                    .map(|(name, rows)| (name, Js::Array(rows)))
                    .collect(),
            ),
        ),
    ))
}

/// `writeGtfsFareCatalog(db, catalog, scope)`.
pub fn write_fare_catalog(db: &Connection, catalog: Option<&Js>, scope: &str) -> Result<()> {
    let Some(catalog) = catalog else {
        return Ok(());
    };
    db.execute_batch("CREATE TABLE IF NOT EXISTS fare_catalogs(scope TEXT PRIMARY KEY, data TEXT NOT NULL) WITHOUT ROWID")?;
    db.execute(
        "INSERT OR REPLACE INTO fare_catalogs VALUES(?,?)",
        rusqlite::params![scope, catalog.stringify()],
    )?;
    Ok(())
}

/// `copyGtfsFareCatalogs(db, alias, scope)`.
pub fn copy_fare_catalogs(db: &Connection, alias: &str, scope: &str) -> Result<()> {
    let present = db
        .query_row(
            &format!(
                "SELECT 1 FROM {alias}.sqlite_master WHERE name='fare_catalogs' AND type='table'"
            ),
            [],
            |_| Ok(()),
        )
        .ok()
        .is_some();
    if !present {
        return Ok(());
    }
    let rows: Vec<(String, String)> = db
        .prepare(&format!("SELECT scope, data FROM {alias}.fare_catalogs"))?
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<std::result::Result<_, _>>()?;
    for (source_scope, data) in rows {
        let catalog = jsval::parse_json(&data).map_err(crate::Error::new)?;
        let target = if source_scope.is_empty() {
            scope.to_owned()
        } else {
            format!("{scope}\u{1f}{source_scope}")
        };
        write_fare_catalog(db, Some(&catalog), &target)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn catalog(amount: &str) -> Js {
        let product = Js::object()
            .with("fare_product_id", "adult")
            .with("amount", amount)
            .with("currency", "USD");
        Js::object()
            .with("version", 1)
            .with("source", "fixture.zip")
            .with(
                "tables",
                Js::object().with("fare_products", Js::Array(vec![product])),
            )
    }

    fn rows(db: &Connection) -> Vec<(String, String)> {
        db.prepare("SELECT scope, data FROM fare_catalogs ORDER BY scope")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .map(|row| row.unwrap())
            .collect()
    }

    /// Ported from the catalog writes in test/check-gtfs-fares.mjs: each
    /// scope holds one immutable catalog and a rewrite replaces it.
    #[test]
    fn catalogs_are_written_once_per_scope() {
        let db = Connection::open_in_memory().unwrap();
        write_fare_catalog(&db, None, "").unwrap();
        let table = db.query_row(
            "SELECT 1 FROM sqlite_master WHERE name='fare_catalogs'",
            [],
            |_| Ok(()),
        );
        assert!(table.is_err(), "No catalog creates no table.");
        for _ in 0..3 {
            write_fare_catalog(&db, Some(&catalog("2.40")), "").unwrap();
        }
        write_fare_catalog(&db, Some(&catalog("4.00")), "").unwrap();
        let stored = rows(&db);
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].1, catalog("4.00").stringify());
        for index in 0..10 {
            write_fare_catalog(&db, Some(&catalog("2.40")), &format!("scope{index}")).unwrap();
        }
        assert_eq!(rows(&db).len(), 11);
    }

    #[test]
    fn copied_catalogs_are_namespaced_by_feed() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("ATTACH DATABASE ':memory:' AS source_0")
            .unwrap();
        db.execute_batch("CREATE TABLE source_0.fare_catalogs(scope TEXT PRIMARY KEY, data TEXT NOT NULL) WITHOUT ROWID")
            .unwrap();
        db.execute(
            "INSERT INTO source_0.fare_catalogs VALUES('', ?)",
            [catalog("2.40").stringify()],
        )
        .unwrap();
        db.execute(
            "INSERT INTO source_0.fare_catalogs VALUES('inner', ?)",
            [catalog("3.00").stringify()],
        )
        .unwrap();
        copy_fare_catalogs(&db, "source_0", "one").unwrap();
        let stored = rows(&db);
        assert_eq!(
            stored
                .iter()
                .map(|(scope, _)| scope.as_str())
                .collect::<Vec<_>>(),
            ["one", "one\u{1f}inner"]
        );
        assert_eq!(stored[0].1, catalog("2.40").stringify());
    }
}
