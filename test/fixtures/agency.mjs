import { DatabaseSync } from 'node:sqlite'

export const observationTime = Date.parse('2026-09-13T12:00:00Z') / 1000
export const sourceUrl = 'https://example.org/trip-updates.pb'

export function createAgencyFixture(file) {
  const db = new DatabaseSync(file)
  db.exec(`
    CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT);
    INSERT INTO metadata VALUES('agencyTimezones','["Etc/UTC"]');
    CREATE TABLE routes(route_id TEXT PRIMARY KEY,short_name TEXT,long_name TEXT,route_type INTEGER,color TEXT);
    INSERT INTO routes VALUES('R','R','River service',3,'007D77');
    CREATE TABLE stops(stop_id TEXT PRIMARY KEY,name TEXT,lat REAL,lon REAL,parent_station TEXT,location_type INTEGER,platform_code TEXT);
    INSERT INTO stops VALUES('A','River',42.36,-71.06,'',0,''),('B','Library',42.37,-71.05,'',0,''),('C','Terminal',42.38,-71.04,'',0,'');
    CREATE TABLE trips(trip_id TEXT PRIMARY KEY,route_id TEXT,service_id TEXT,direction_id TEXT);
    INSERT INTO trips VALUES('T1','R','S','0'),('T2','R','S','0'),('T3','R','S','0');
    CREATE TABLE calendar(service_id TEXT PRIMARY KEY,monday INTEGER,tuesday INTEGER,wednesday INTEGER,thursday INTEGER,friday INTEGER,saturday INTEGER,sunday INTEGER,start_date INTEGER,end_date INTEGER);
    INSERT INTO calendar VALUES('S',1,1,1,1,1,1,1,20260901,20260930);
    CREATE TABLE calendar_dates(service_id TEXT,date INTEGER,exception_type INTEGER);
    CREATE TABLE frequencies(trip_id TEXT,start_time INTEGER,end_time INTEGER,headway_secs INTEGER,exact_times INTEGER);
    CREATE TABLE connections(departure INTEGER,arrival INTEGER,trip_id TEXT,route_id TEXT,service_id TEXT,direction_id TEXT,from_stop_id TEXT,to_stop_id TEXT,stop_sequence INTEGER,PRIMARY KEY(trip_id,stop_sequence));
    INSERT INTO connections VALUES
      (43500,43740,'T1','R','S','0','A','B',10),(43800,44040,'T1','R','S','0','B','C',30),
      (44100,44340,'T2','R','S','0','A','B',10),(44400,44640,'T2','R','S','0','B','C',30),
      (44700,44940,'T3','R','S','0','A','B',10),(45000,45240,'T3','R','S','0','B','C',30);
  `)
  db.close()
}

export function tripUpdate(id, delay = 0, changes = {}) {
  return { id, tripId: id, routeId: 'R', directionId: 0, startDate: '20260913', vehicleId: `vehicle-${id}`, sourceUrl, timestamp: observationTime,
    stopTimeUpdates: [{ stopId: 'A', stopSequence: 10, departure: { delay } }], ...changes }
}

export function realtimeFixture(updates = [tripUpdate('T1'), tripUpdate('T2'), tripUpdate('T3')]) {
  return { fetchedAt: new Date(observationTime * 1000).toISOString(), feedTimestamp: observationTime,
    feeds: [{ sourceUrl, kind: 'tripUpdates', feedTimestamp: observationTime, fetchedAt: new Date(observationTime * 1000).toISOString() }],
    vehicles: [], tripUpdates: updates, alerts: [] }
}
