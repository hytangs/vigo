"""MBTA LAMP adapter. Downloads public daily exports; matches archived GTFS exactly."""
import csv
import io
import json
import urllib.request
import urllib.parse
import zipfile
from pathlib import Path
import pandas as pd
import pyarrow.parquet as pq

INDEX = 'https://performancedata.mbta.com/lamp/subway-on-time-performance-v1/index.csv'
ARCHIVE = 'https://cdn.mbta.com/archive/archived_feeds.txt'
HOSTS = {'performancedata.mbta.com', 'cdn.mbta.com', 'cdn.mbtace.com'}
COLUMNS = ['service_date', 'route_id', 'trip_id', 'direction_id', 'start_time', 'stop_id', 'parent_station', 'stop_sequence', 'stop_timestamp', 'move_timestamp', 'travel_time_seconds', 'scheduled_travel_time', 'scheduled_arrival_time', 'scheduled_departure_time']


def validate_source(url):
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != 'https' or parsed.hostname not in HOSTS or parsed.username or parsed.password or parsed.port not in (None, 443):
        raise ValueError('The LAMP adapter only reads its public data hosts.')


class SourceRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        validate_source(newurl)
        return super().redirect_request(request, fp, code, msg, headers, newurl)


def fetch(url, destination, maximum=50_000_000, expected=None):
    validate_source(url)
    destination = Path(destination)
    if destination.exists() and destination.stat().st_size <= maximum and (expected is None or destination.stat().st_size == expected):
        return destination
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + '.partial')
    try:
        with urllib.request.build_opener(SourceRedirect()).open(url, timeout=45) as response, temporary.open('wb') as output:
            if urllib.parse.urlparse(response.url).hostname not in HOSTS:
                raise ValueError('Unexpected data redirect.')
            total = 0
            while block := response.read(1024 * 1024):
                total += len(block)
                if total > maximum:
                    raise ValueError('The public file exceeds the study download limit.')
                output.write(block)
        if expected is not None and total != expected:
            raise ValueError('The data file size differs from the published index; retry with a fresh index.')
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)
    return destination


def clock_seconds(value):
    h, m, s = map(int, value.split(':'))
    if min(h, m, s) < 0 or m >= 60 or s >= 60:
        raise ValueError('Invalid GTFS time.')
    return h * 3600 + m * 60 + s


def load_days(cache, start, end):
    cache = Path(cache)
    # Refresh catalogs each study; daily sources are reused only at the indexed size.
    for name in ['index.csv', 'archived_feeds.txt']:
        (cache / name).unlink(missing_ok=True)
    index = list(csv.DictReader(fetch(INDEX, cache / 'index.csv', 2_000_000).open()))
    selected = [row for row in index if start <= row['service_date'] <= end]
    expected_dates = {d.strftime('%Y-%m-%d') for d in pd.date_range(start, end)}
    if {row['service_date'] for row in selected} != expected_dates or len(selected) != len(expected_dates):
        raise ValueError('Every requested service date must have exactly one published daily file.')
    if sum(int(row['size_bytes']) for row in selected) > 100_000_000:
        raise ValueError('Select a smaller study window (daily data limit: 100 MB).')
    frames, sources = [], []
    for row in selected:
        print(json.dumps({'phase': 'download', 'date': row['service_date']}), flush=True)
        file = fetch(row['file_url'], cache / f"{row['service_date']}-{urllib.parse.quote(row['last_modified'], safe='')}.parquet", expected=int(row['size_bytes']))
        frame = pq.read_table(file, columns=COLUMNS).to_pandas()
        if not frame.empty and set(frame.service_date) != {int(row['service_date'].replace('-', ''))}:
            raise ValueError('Daily export contains a different service date.')
        frames.append(frame)
        sources.append({**row, 'size_bytes': int(row['size_bytes'])})
    return pd.concat(frames, ignore_index=True), sources


def archive_pairs(cache, data, start, end):
    rows = list(csv.DictReader(fetch(ARCHIVE, Path(cache) / 'archived_feeds.txt', 2_000_000).open()))
    dates = sorted(set(data.service_date.astype(int)))
    choices = {}
    for date in dates:
        matches = [r for r in rows if int(r['feed_start_date']) <= date <= int(r['feed_end_date'])]
        if len(matches) != 1:
            raise ValueError(f'No unique archived timetable applies to service date {date}.')
        choices[date] = matches[0]
    archives = {row['archive_url']: row for row in choices.values()}
    if len(archives) > 4:
        raise ValueError('The focused study supports at most four archived timetables.')
    extracted = []
    provenance = []
    for index, (url, info) in enumerate(archives.items()):
        print(json.dumps({'phase': 'timetable', 'version': info['feed_version']}), flush=True)
        file = fetch(url, Path(cache) / f"gtfs-{info['feed_start_date']}-{urllib.parse.quote(info['feed_version'], safe='')}.zip")
        applicable = [date for date, row in choices.items() if row['archive_url'] == url]
        wanted = set(data[data.service_date.isin(applicable)].trip_id)
        with zipfile.ZipFile(file) as archive:
            if sum(item.file_size for item in archive.infolist()) > 2_000_000_000:
                raise ValueError('Archived timetable uncompressed size exceeds the study limit.')
            def records(name):
                with archive.open(name) as source:
                    yield from csv.DictReader(io.TextIOWrapper(source, encoding='utf-8-sig'))
            trips = {r['trip_id']: r for r in records('trips.txt') if r['trip_id'] in wanted}
            stops = {r['stop_id']: r for r in records('stops.txt')}
            calendar = list(records('calendar.txt')) if 'calendar.txt' in archive.namelist() else []
            exceptions = list(records('calendar_dates.txt')) if 'calendar_dates.txt' in archive.namelist() else []
            active = {}
            for date in applicable:
                day = pd.Timestamp(str(date)).day_name().lower()
                services = {r['service_id'] for r in calendar if int(r['start_date']) <= date <= int(r['end_date']) and r[day] == '1'}
                for r in exceptions:
                    if int(r['date']) == date:
                        if r['exception_type'] == '1':
                            services.add(r['service_id'])
                        elif r['exception_type'] == '2':
                            services.discard(r['service_id'])
                active[date] = services
            by_trip = {}
            for r in records('stop_times.txt'):
                if r['trip_id'] in trips:
                    by_trip.setdefault(r['trip_id'], []).append(r)
            for trip_id, calls in by_trip.items():
                trip = trips[trip_id]
                calls.sort(key=lambda r: int(r['stop_sequence']))
                sequences = [int(r['stop_sequence']) for r in calls]
                if len(sequences) != len(set(sequences)):
                    continue
                for before, after in zip(calls, calls[1:]):
                    if not before['departure_time'] or not after['arrival_time']:
                        continue
                    departure, arrival = clock_seconds(before['departure_time']), clock_seconds(after['arrival_time'])
                    if arrival < departure:
                        continue
                    for date in applicable:
                        if trip['service_id'] not in active[date]:
                            continue
                        extracted.append({'service_date': date, 'trip_id': trip_id, 'stop_id': after['stop_id'], 'stop_sequence': int(after['stop_sequence']),
                            'static_route_id': trip['route_id'], 'static_direction_id': int(trip['direction_id']) if trip.get('direction_id') in ('0', '1') else None,
                            'from_stop_id': before['stop_id'], 'from_sequence': int(before['stop_sequence']),
                            'from_name': stops.get(before['stop_id'], {}).get('stop_name', before['stop_id']),
                            'to_name': stops.get(after['stop_id'], {}).get('stop_name', after['stop_id']),
                            'scheduled_seconds': arrival - departure, 'scheduled_start': departure,
                            'archive_version': index})
        provenance.append({**info, 'bytes': file.stat().st_size, 'service_dates': applicable})
    return pd.DataFrame(extracted), provenance


def match_segments(data, pairs):
    keys = ['service_date', 'trip_id', 'direction_id', 'start_time']
    rows = data.sort_values(keys + ['stop_sequence']).copy()
    counts = {'inputRows': len(rows), 'inputRowsByRoute': rows.groupby('route_id').size().astype(int).to_dict()}
    duplicate = rows.duplicated(keys + ['stop_sequence'], keep=False)
    counts['ambiguousStopRows'] = int(duplicate.sum())
    # Remove the entire ambiguous trip instance, not just a row that could then
    # make two nonconsecutive stops appear adjacent.
    ambiguous = rows[duplicate][keys].drop_duplicates().assign(ambiguous=True)
    rows = rows.merge(ambiguous, on=keys, how='left')
    counts['excludedAmbiguousTripRows'] = int(rows.ambiguous.notna().sum())
    rows = rows[rows.ambiguous.isna()].drop(columns=['ambiguous'])
    rows['observed_from_stop'] = rows.groupby(keys, dropna=False).stop_id.shift()
    rows['observed_from_sequence'] = rows.groupby(keys, dropna=False).stop_sequence.shift()
    rows = rows.merge(pairs, on=['service_date', 'trip_id', 'stop_id', 'stop_sequence'], how='left', validate='many_to_one')
    matched = (rows.route_id == rows.static_route_id) & (rows.direction_id == rows.static_direction_id) & (rows.observed_from_stop == rows.from_stop_id) & (rows.observed_from_sequence == rows.from_sequence)
    counts['exactAdjacentMatches'] = int(matched.sum())
    counts['unmatchedRows'] = int((~matched).sum())
    counts['unmatchedRowsByRoute'] = rows[~matched].groupby('route_id').size().astype(int).to_dict()
    rows = rows[matched].copy()
    comparable = rows.travel_time_seconds.notna() & (rows.travel_time_seconds > 0) & (rows.scheduled_seconds > 0) & rows.scheduled_travel_time.notna() & (rows.scheduled_travel_time == rows.scheduled_seconds)
    counts['missingScheduleComparisons'] = int(rows.scheduled_travel_time.isna().sum())
    counts['excludedTimeComparisons'] = int((~comparable).sum())
    counts['scheduleDisagreements'] = int((rows.scheduled_travel_time.notna() & (rows.scheduled_travel_time != rows.scheduled_seconds)).sum())
    counts['missingOrNonpositiveTimes'] = int((rows.travel_time_seconds.isna() | (rows.travel_time_seconds <= 0) | (rows.scheduled_seconds <= 0)).sum())
    rows = rows[comparable].copy()
    counts['eligibleSegments'] = len(rows)
    counts['eligibleSegmentsByRoute'] = rows.groupby('route_id').size().astype(int).to_dict()
    assert counts['inputRows'] == counts['excludedAmbiguousTripRows'] + counts['unmatchedRows'] + counts['excludedTimeComparisons'] + counts['eligibleSegments']
    return rows, counts
