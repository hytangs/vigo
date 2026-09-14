"""Chronological running-time benchmark; no future day or same-trip leakage."""
import numpy as np
import pandas as pd

SEGMENT = ['route_id', 'direction_id', 'from_stop_id', 'stop_id']


def metrics(actual, predicted):
    errors = np.asarray(actual) - np.asarray(predicted)
    return {'cases': len(errors), 'maeSeconds': float(np.abs(errors).mean()) if len(errors) else None,
            'p90AbsoluteErrorSeconds': float(np.quantile(np.abs(errors), .9)) if len(errors) else None,
            'biasSeconds': float(errors.mean()) if len(errors) else None}


def evaluate(rows, train_end, minimum_days=3):
    train = rows[rows.service_date <= train_end].copy()
    test = rows[rows.service_date > train_end].copy()
    if train.empty or test.empty or train.service_date.max() >= test.service_date.min():
        raise ValueError('Training and evaluation need distinct chronological service dates.')
    # Day medians prevent a high-frequency training day from outweighing every
    # other date. The prediction uses only the preceding training period.
    daily = train.groupby(SEGMENT + ['service_date'], dropna=False).travel_time_seconds.median().reset_index()
    models = daily.groupby(SEGMENT, dropna=False).travel_time_seconds.agg(['median', 'count']).reset_index().rename(columns={'median': 'predicted_seconds', 'count': 'training_days'})
    models = models[models.training_days >= minimum_days]
    scored = test.merge(models, on=SEGMENT, how='left', validate='many_to_one')
    eligible = scored[scored.predicted_seconds.notna()].copy()
    if eligible.empty:
        raise ValueError('No held-out segments have enough independent training days.')
    comparisons = {'eligibleTestSegments': len(test), 'scoredTestSegments': len(eligible), 'coverage': len(eligible) / len(test),
        'scheduled': metrics(eligible.travel_time_seconds, eligible.scheduled_seconds),
        'historical': metrics(eligible.travel_time_seconds, eligible.predicted_seconds)}
    comparisons['maeChangeSeconds'] = comparisons['historical']['maeSeconds'] - comparisons['scheduled']['maeSeconds']
    days = []
    for date, group in eligible.groupby('service_date'):
        days.append({'serviceDate': str(date), 'scheduled': metrics(group.travel_time_seconds, group.scheduled_seconds), 'historical': metrics(group.travel_time_seconds, group.predicted_seconds)})
    segments = []
    for key, group in eligible.groupby(SEGMENT, dropna=False):
        route, direction, origin, destination = key
        first = group.iloc[0]
        segments.append({'routeId': route, 'directionId': int(direction), 'fromStopId': origin, 'toStopId': destination,
            'fromName': first.from_name, 'toName': first.to_name, 'trainingDays': int(first.training_days),
            'predictedSeconds': float(first.predicted_seconds), 'scheduledSeconds': float(group.scheduled_seconds.median()),
            'observedMedianSeconds': float(group.travel_time_seconds.median()),
            'scheduled': metrics(group.travel_time_seconds, group.scheduled_seconds), 'historical': metrics(group.travel_time_seconds, group.predicted_seconds)})
    routes = []
    for route, group in eligible.groupby('route_id'):
        routes.append({'routeId': route, 'scheduled': metrics(group.travel_time_seconds, group.scheduled_seconds), 'historical': metrics(group.travel_time_seconds, group.predicted_seconds)})
    return {'comparison': comparisons, 'days': days, 'routes': routes, 'segments': segments,
        'trainingRows': len(train), 'testRows': len(test), 'trainingDates': [str(v) for v in sorted(train.service_date.unique())],
        'testDates': [str(v) for v in sorted(test.service_date.unique())], 'minimumTrainingDays': minimum_days}, eligible
