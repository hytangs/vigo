export function finalizeCurrentStreetFixture(database) {
  database.exec(`
    CREATE TABLE drive_nodes(node_id INTEGER PRIMARY KEY, lat REAL NOT NULL, lon REAL NOT NULL);
    CREATE TABLE drive_edges(
      from_node INTEGER NOT NULL,
      to_node INTEGER NOT NULL,
      distance_m REAL NOT NULL,
      travel_time_s REAL NOT NULL,
      way_id INTEGER NOT NULL,
      road_class INTEGER NOT NULL
    );
    CREATE INDEX drive_nodes_lat_lon ON drive_nodes(lat,lon);
    CREATE INDEX drive_edges_from ON drive_edges(from_node);
    CREATE INDEX drive_edges_to ON drive_edges(to_node);
    UPDATE metadata SET value='"vigo.street.store.v4"' WHERE key='schemaVersion';
    INSERT OR REPLACE INTO metadata VALUES(
      'nodeCount',
      CAST((SELECT COUNT(*) FROM walk_nodes) AS TEXT)
    );
    INSERT OR REPLACE INTO metadata VALUES(
      'edgeCount',
      CAST((SELECT COUNT(*) FROM edges) AS TEXT)
    );
    INSERT OR REPLACE INTO metadata VALUES('driveNodeCount', '0');
    INSERT OR REPLACE INTO metadata VALUES('driveEdgeCount', '0');
    INSERT OR REPLACE INTO metadata VALUES('storageLayout', '"walk-drive-role-tables-v2"');
    INSERT OR REPLACE INTO metadata VALUES('driveNodeStorage', '"walk-shared-plus-drive-only-v1"');
    INSERT OR REPLACE INTO metadata VALUES('driveIndexState', '"ready"');
  `)
}
