#!/usr/bin/env python3
"""Run one reproducible LAMP running-time study; keep raw data outside the repo."""
import argparse
import datetime as dt
import json
import os
from pathlib import Path
from lamp.data import load_days, archive_pairs, match_segments, INDEX, ARCHIVE
from lamp.model import evaluate


def run(args):
    start, split, end = map(dt.date.fromisoformat, [args.start, args.train_end, args.end])
    if not start <= split < end or (end - start).days > 30:
        raise ValueError('Choose up to 31 days with training ending before evaluation.')
    if end >= dt.datetime.now(dt.timezone.utc).date():
        raise ValueError('Evaluation must use past service dates.')
    directory = Path(args.output)
    cache = directory / 'cache'
    cache.mkdir(parents=True, exist_ok=True)
    data, daily_sources = load_days(cache, args.start, args.end)
    if args.route:
        data = data[data.route_id == args.route].copy()
        if data.empty:
            raise ValueError('The requested route is absent from the selected exports.')
    pairs, schedules = archive_pairs(cache, data, args.start, args.end)
    rows, counts = match_segments(data, pairs)
    result, scored = evaluate(rows, int(args.train_end.replace('-', '')), args.minimum_days)
    result.update({'version': 1, 'dataset': 'MBTA LAMP subway performance', 'generatedAt': dt.datetime.now(dt.timezone.utc).isoformat(),
        'question': 'Can a median of earlier daily segment running times improve on the matched timetable for later service dates?',
        'range': {'start': args.start, 'trainEnd': args.train_end, 'end': args.end}, 'filters': counts,
        'method': 'Median of daily segment running-time medians from earlier service dates, grouped by exact route, direction and adjacent stops. Entire later dates are held out. Compare both models on identical eligible test segments; unsupported segments abstain.',
        'limits': ['LAMP reconstructed stop events can include final TripUpdate arrivals when VehiclePosition events are absent; these are not an independent sensor ground truth.',
            'Historical archives can include retrospective corrections. This is a retrospective holdout evaluation, not proof of what an online model could know at every event time.',
            'Historical running time is not current departure delay, a causal explanation, a recovery forecast, or passenger impact.',
            'One short window is not a production accuracy guarantee. Long genuine runs remain included; no outlier winsorization or accuracy-based route selection.'],
        'sources': {'index': INDEX, 'archiveCatalog': ARCHIVE, 'dictionary': 'https://github.com/mbta/lamp/blob/main/Data_Dictionary.md', 'dailyFiles': daily_sources, 'timetables': schedules}})
    directory.mkdir(parents=True, exist_ok=True)
    result['studyId'] = result['generatedAt'].replace(':', '-')
    run_directory = directory / 'runs' / result['studyId']
    run_directory.mkdir(parents=True, exist_ok=False)
    result['evaluationFile'] = f"runs/{result['studyId']}/evaluation.csv"
    # Publish the latest pointer only after this run's complete evidence exists.
    # Later studies cannot overwrite the row-level evidence of a saved note.
    scored[['service_date','route_id','direction_id','trip_id','start_time','from_stop_id','stop_id','travel_time_seconds','scheduled_seconds','predicted_seconds']].to_csv(run_directory / 'evaluation.csv', index=False)
    (run_directory / 'study.json').write_text(json.dumps(result, indent=2, allow_nan=False) + '\n')
    temporary = directory / 'study.json.partial'
    temporary.write_text(json.dumps(result, indent=2, allow_nan=False) + '\n')
    os.replace(temporary, directory / 'study.json')
    print(json.dumps({'phase': 'complete', 'result': str(directory / 'study.json'), 'comparison': result['comparison']}), flush=True)
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--start', required=True)
    parser.add_argument('--train-end', required=True)
    parser.add_argument('--end', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--route')
    parser.add_argument('--minimum-days', type=int, choices=range(2, 15), default=3)
    run(parser.parse_args())
