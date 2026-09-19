import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import pandas as pd
from lamp.model import evaluate
from lamp.data import match_segments

rows = []
for day, values in [(20260901, [100, 110]), (20260902, [120, 130]), (20260903, [140, 150]), (20260904, [200, 10000]), (20260905, [220, 230])]:
    for i, value in enumerate(values):
        rows.append({'service_date': day, 'route_id': 'X', 'direction_id': False, 'from_stop_id': 'A', 'stop_id': 'B', 'from_name': 'Alpha', 'to_name': 'Beta', 'travel_time_seconds': value, 'scheduled_seconds': 180, 'trip_id': str(i), 'start_time': 30000})
frame = pd.DataFrame(rows)
a, scores = evaluate(frame, 20260903)
assert all(scores.predicted_seconds == 125), 'Median of daily medians uses earlier days only'
assert a['comparison']['historical']['cases'] == a['comparison']['scheduled']['cases'] == 4
changed = frame.copy()
changed.loc[changed.service_date > 20260903, 'travel_time_seconds'] *= 100
_, changed_scores = evaluate(changed, 20260903)
assert list(scores.predicted_seconds) == list(changed_scores.predicted_seconds), 'Targets cannot alter the fitted model'
assert 10000 in set(scores.travel_time_seconds), 'Long runs are not removed to improve accuracy'
unseen = frame.iloc[[-1]].copy()
unseen['from_stop_id'] = 'Never-trained'
b, _ = evaluate(pd.concat([frame, unseen]), 20260903)
assert b['comparison']['eligibleTestSegments'] == 5 and b['comparison']['scoredTestSegments'] == 4
assert b['comparison']['coverage'] == .8
try:
    evaluate(frame, 20260905)
    raise AssertionError('An empty holdout must fail')
except ValueError:
    pass
base = {'service_date':20260901,'route_id':'X','trip_id':'t','direction_id':False,'start_time':30000,'travel_time_seconds':100,'scheduled_travel_time':180}
data = pd.DataFrame([{**base,'stop_id':'A','stop_sequence':10}, {**base,'stop_id':'B','stop_sequence':30}])
pairs = pd.DataFrame([{'service_date':20260901,'trip_id':'t','stop_id':'B','stop_sequence':30,'static_route_id':'X','static_direction_id':0,'from_stop_id':'A','from_sequence':10,'scheduled_seconds':180,'scheduled_start':30000}])
matched, counts = match_segments(data,pairs)
assert len(matched) == 1, 'Nonconsecutive sequence numbers are legitimate when GTFS establishes adjacency'
wrong = pairs.copy(); wrong['from_sequence'] = 20
assert len(match_segments(data,wrong)[0]) == 0, 'A missing intermediate stop is not an adjacent segment'
wrong = pairs.copy(); wrong['static_direction_id'] = 1
assert len(match_segments(data,wrong)[0]) == 0
wrong = pairs.copy(); wrong['scheduled_seconds'] = 181
assert len(match_segments(data,wrong)[0]) == 0, 'Timetable disagreements are excluded, not silently mixed'
duplicate = pd.concat([data, data.iloc[[0]]])
assert len(match_segments(duplicate,pairs)[0]) == 0, 'Ambiguity excludes the entire trip instance'
print('LAMP: chronological holdout, frozen training predictions, matched baseline rows, abstention coverage, no outlier trimming, exact adjacency/direction, schedule agreement and ambiguous-instance exclusion passed.')
from lamp.data import validate_source, SourceRedirect
for bad in ['http://performancedata.mbta.com/', 'https://localhost/file', 'https://performancedata.mbta.com:8443/file', 'https://user:secret@performancedata.mbta.com/file']:
    try:
        validate_source(bad)
        raise AssertionError('An unapproved source must fail')
    except ValueError:
        pass
try:
    SourceRedirect().redirect_request(None,None,302,'redirect',{},'https://127.0.0.1/private')
    raise AssertionError('Redirects must be checked before following them')
except ValueError:
    pass
wrong = pairs.copy(); wrong['static_direction_id'] = None
assert len(match_segments(data,wrong)[0]) == 0, 'Missing GTFS direction must not silently become direction 0'
assert counts['inputRows'] == counts['excludedAmbiguousTripRows'] + counts['unmatchedRows'] + counts['excludedTimeComparisons'] + counts['eligibleSegments']
# A completed research note must keep its evidence when another study runs or fails.
import importlib.util
import tempfile
import argparse
import contextlib
import io
import json
spec=importlib.util.spec_from_file_location('lamp_study',Path(__file__).resolve().parents[1]/'scripts/lamp-runtime-study.py')
runner=importlib.util.module_from_spec(spec); spec.loader.exec_module(runner)
prepared=frame.copy(); prepared['service_date']=prepared.service_date-20260900+20000100
runner.load_days=lambda *_:(prepared,[])
runner.archive_pairs=lambda *_:(None,[])
runner.match_segments=lambda *_:(prepared,{'eligibleSegments':len(prepared)})
with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()):
    args=argparse.Namespace(start='2000-01-01',train_end='2000-01-03',end='2000-01-05',output=directory,route=None,minimum_days=3)
    first=runner.run(args); original=(Path(directory)/first['evaluationFile']).read_bytes()
    second=runner.run(args)
    assert first['studyId'] != second['studyId']
    assert (Path(directory)/first['evaluationFile']).read_bytes() == original
    latest=(Path(directory)/'study.json').read_bytes()
    def fail(*_): raise ValueError('Study interrupted before publication')
    runner.evaluate=fail
    try:
        runner.run(args)
        raise AssertionError('Failed study must not publish')
    except ValueError:
        pass
    assert (Path(directory)/'study.json').read_bytes() == latest
print('LAMP publication: each run retains its own CSV and source record; failed studies preserve the previous completed result.')
