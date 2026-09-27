"""Forecast explorer: proxies GridToEv's two models for the Forecast page.

V1 (short-term) predicts half-hour dispatch-down 30 and 60 minutes after a
historical dataset issue time. V2 (daily) predicts whether curtailment occurs
and its total MWh over one UTC day. Only dataset dates/times are accepted, so
the browser can never ask the model for a target it has no inputs for.
The API key stays on the server; the browser only sees normalized results.
"""
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
import json
import math
import os
import threading
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen

# Window replays can take ~15 s on the hosted service, and a sleeping service
# can take up to a minute to wake, so explorer calls get a longer budget.
TIMEOUT = 60
INFO_CACHE_SECONDS = 600
_cache_lock = threading.Lock()
_cache = {}


def _base_url():
    return os.environ.get('GRID_TO_EV_API_BASE_URL', 'http://127.0.0.1:8000').rstrip('/')


def call(path, body=None):
    """GET (no body) or POST JSON to the model; errors propagate for server.diagnose."""
    headers = {'Accept': 'application/json'}
    key = os.environ.get('GRID_TO_EV_API_KEY')
    if key:
        headers['X-API-Key'] = key
    data = None
    if body is not None:
        headers['Content-Type'] = 'application/json'
        data = json.dumps(body).encode()
    request = Request(f'{_base_url()}{path}', data=data, headers=headers, method='POST' if data else 'GET')
    with urlopen(request, timeout=TIMEOUT) as response:
        return json.load(response)


def cached(key, seconds, build):
    now = time.monotonic()
    with _cache_lock:
        hit = _cache.get(key)
        if hit and (seconds is None or now - hit[0] < seconds):
            return hit[1]
    value = build()
    with _cache_lock:
        _cache[key] = (now, value)
    return value


def parallel(*calls):
    with ThreadPoolExecutor(max_workers=len(calls)) as pool:
        return [f.result() for f in [pool.submit(fn) for fn in calls]]


def finite(value, name, minimum=None, maximum=None, optional=False):
    if value is None and optional:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f'Invalid {name}')
    if (minimum is not None and value < minimum) or (maximum is not None and value > maximum):
        raise ValueError(f'Invalid {name}')
    return float(value)


def utc(value):
    parsed = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        raise ValueError('Timestamp must include timezone')
    return parsed.astimezone(timezone.utc)


def iso(value):
    return value.strftime('%Y-%m-%dT%H:%M:%SZ')


def partition_of(moment, partitions):
    for name in ('train', 'validation', 'test'):
        span = partitions.get(name)
        if span and span['from'] <= moment <= span['to']:
            return name
    return None


# ---------------------------------------------------------------- V1 short-term

def _v1_partitions(info):
    return {name: {'from': iso(utc(p['issue_timestamp_min_utc'])), 'to': iso(utc(p['issue_timestamp_max_utc'])),
                   'rows': p['rows']} for name, p in info['partitions'].items()}


def _available_times(dataset, listed):
    """The API lists at most 1000 latest times; earlier ones are contiguous half-hours
    from the dataset minimum (verified against the reported count when possible)."""
    listed = sorted(utc(t) for t in listed)
    earliest = utc(dataset['available_issue_timestamp_min_utc'])
    earlier, cursor = [], earliest
    while listed and cursor < listed[0]:
        earlier.append(cursor)
        cursor += timedelta(minutes=30)
    return [iso(t) for t in earlier + listed]


def short_term_info():
    def build():
        dataset, listed, info = parallel(lambda: call('/dataset/info'),
                                         lambda: call('/dataset/available-times?limit=1000'),
                                         lambda: call('/model-info'))
        times = _available_times(dataset, listed['issue_timestamps_utc'])
        components = info.get('prediction_components', {})
        evaluation = info.get('evaluation', {})
        test = evaluation.get('test', {})
        baselines = evaluation.get('baselines', {})
        classifier = components.get('event_classifier', {}).get('test_metrics', {})
        return {
            'model': {
                'id': 'v1', 'version': info['model_version'], 'trainedAt': info.get('trained_at_utc'),
                'target': info.get('target_description'),
                'horizonsMinutes': info.get('forecast_horizons_minutes', [30, 60]),
                'classificationThreshold': info.get('classification_threshold'),
                'featureCount': info.get('feature_count'),
                'datasetRows': info.get('dataset_rows'),
                'mlWeightByHorizon': info.get('dispatch_regression_ml_weight_by_horizon'),
                'trendAlphaByHorizon': info.get('dispatch_trend_alpha_by_horizon'),
                'estimators': [{'name': name, 'estimator': c.get('estimator'), 'role': c.get('role')}
                               for name, c in components.items() if c.get('estimator')],
                'test': {
                    'rows': test.get('rows'),
                    'maeMwh': test.get('dispatch_down_mae_mwh'), 'rmseMwh': test.get('dispatch_down_rmse_mwh'),
                    'wape': test.get('dispatch_down_wape'),
                    'eventAveragePrecision': test.get('event_average_precision'), 'eventF1': test.get('event_f1'),
                    'eventRate': classifier.get('event_rate'), 'rocAuc': classifier.get('roc_auc'),
                    'intervalCoverage': test.get('interval_coverage_p10_p90'),
                    'latestObservationMaeMwh': baselines.get('latest_observation', {}).get('mae'),
                    'stalePersistenceMaeMwh': baselines.get('stale_persistence', {}).get('mae'),
                },
                'partitions': _v1_partitions(info),
                'caveats': evaluation.get('caveats', []),
            },
            'dataset': {'from': times[0], 'to': times[-1], 'count': len(times),
                        'reportedCount': dataset.get('available_issue_timestamp_count'),
                        'intervalMinutes': dataset.get('interval_minutes', 30)},
            'times': times,
        }
    return cached('v1-info', INFO_CACHE_SECONDS, build)


def _v1_point(row):
    total = finite(row['predicted_dispatch_down_mwh'], 'energy', 0)
    lower, median, upper = (finite(row[f'prediction_interval_{q}_mwh'], q, 0) for q in ('p10', 'p50', 'p90'))
    return {
        'horizonMinutes': int(finite(row['forecast_horizon_minutes'], 'horizon')),
        'issuedAt': iso(utc(row['issue_timestamp_utc'])), 'targetAt': iso(utc(row['target_timestamp_utc'])),
        'probability': finite(row['dispatch_down_probability'], 'probability', 0, 1),
        'eventPredicted': bool(row.get('dispatch_down_event_prediction')),
        'risk': str(row.get('risk_level', '')),
        'atRiskMwh': total,
        'curtailmentMwh': finite(row['predicted_curtailment_mwh'], 'curtailment', 0),
        'constraintMwh': finite(row['predicted_constraint_mwh'], 'constraint', 0),
        'lowerMwh': min(lower, median, upper), 'medianMwh': median, 'upperMwh': max(lower, median, upper),
        'recoverableMwh': finite(row.get('recoverable_surplus_mwh', 0), 'recovery', 0),
    }


def _v1_actual(row):
    return {'targetAt': iso(utc(row['target_timestamp_utc'])), 'status': row.get('status'),
            'dispatchDownMwh': finite(row.get('actual_dispatch_down_mwh'), 'actual', optional=True),
            'curtailmentMwh': finite(row.get('actual_curtailment_mwh'), 'actual', optional=True),
            'constraintMwh': finite(row.get('actual_constraint_mwh'), 'actual', optional=True)}


def _v1_actuals(targets):
    if not targets:
        return {}
    body = call('/actuals/v1/batch', {'target_timestamps_utc': targets})
    return {a['targetAt']: a for a in map(_v1_actual, body.get('actuals', []))}


def validate_issue(value):
    info = short_term_info()
    moment = iso(utc(value))
    if moment not in set(info['times']):
        raise LookupError('That issue time is not in the short-term model dataset.')
    return moment, info


def _missing_row(error):
    """The model answers 404 when a horizon's target row is outside the dataset (e.g. its last half-hour)."""
    return isinstance(error, HTTPError) and error.code == 404


def short_term_predict(issue, capacity):
    issue, info = validate_issue(issue)

    def one(horizon):
        try:
            return call('/predict/from-dataset', {'issue_timestamp_utc': issue, 'forecast_horizon_minutes': horizon,
                                                  'flexible_load_capacity_mw': capacity})
        except HTTPError as error:
            if _missing_row(error):
                return None
            raise
    rows = [row for row in parallel(lambda: one(30), lambda: one(60)) if row]
    if not rows:
        raise LookupError('The model has no prediction for that issue time.')
    points = sorted(map(_v1_point, rows), key=lambda p: p['horizonMinutes'])
    actuals = _v1_actuals([p['targetAt'] for p in points])
    for p in points:
        p['actual'] = actuals.get(p['targetAt'])
    return {'issuedAt': issue, 'modelVersion': rows[0].get('model_version'), 'capacityMw': capacity,
            'partition': partition_of(issue, info['model']['partitions']), 'predictions': points}


def contiguous_runs(times):
    runs = []
    for t in map(utc, times):
        if runs and t - runs[-1][-1] == timedelta(minutes=30):
            runs[-1].append(t)
        else:
            runs.append([t])
    return runs


def _window(run, horizon):
    """Replay one gap-free run of issue times at one horizon; if its final target falls
    outside the dataset, drop the last half-hour."""
    def replay(hours):
        return call('/predict/window/from-dataset', {'start_timestamp_utc': iso(run[0]), 'duration_hours': hours,
                                                     'forecast_horizons_minutes': [horizon]}).get('predictions', [])
    try:
        return replay(len(run) / 2)
    except HTTPError as error:
        if not _missing_row(error):
            raise
    return replay(len(run) / 2 - 0.5) if len(run) > 1 else []


def day_targets(day):
    start = datetime.fromisoformat(f'{day}T00:00:00+00:00')
    return [iso(start + timedelta(minutes=30 * i)) for i in range(48)]


def short_term_day(day):
    """Replay the 48 target half-hours (00:00-23:30 UTC) of one day at both horizons, with actuals.

    A target at 00:00 is predicted from 23:30 (+30) or 23:00 (+60) the day before, so each
    horizon replays its own issue times, shifted back by the horizon.
    """
    day = date.fromisoformat(day).isoformat()
    info = short_term_info()
    if not any(t.startswith(day) for t in info['times']):
        raise LookupError('That date is not in the short-term model dataset.')
    available, targets = set(info['times']), day_targets(day)

    def issues(horizon):
        shifted = (iso(utc(t) - timedelta(minutes=horizon)) for t in targets)
        return [t for t in shifted if t in available]

    def build():
        jobs = [lambda r=r, h=h: _window(r, h) for h in (30, 60) for r in contiguous_runs(issues(h))]
        rows = [row for batch in parallel(*jobs) for row in batch]
        points = [p for p in map(_v1_point, rows) if p['targetAt'].startswith(day)]
        actuals = _v1_actuals(targets)
        for p in points:
            actual = actuals.get(p['targetAt'])
            p['actualMwh'] = actual['dispatchDownMwh'] if actual else None
        observed = [{'targetAt': t, 'actualMwh': actuals[t]['dispatchDownMwh'] if t in actuals else None} for t in targets]
        return {'date': day, 'modelVersion': rows[0].get('model_version') if rows else None,
                'points': points, 'observed': observed}
    return cached(('v1-day', day), None, build)


# ---------------------------------------------------------------- V2 daily

def daily_info():
    def build():
        info, coverage = parallel(lambda: call('/model-info/daily-curtailment'),
                                  lambda: call('/dataset/daily-curtailment/coverage'))
        evaluation = info.get('evaluation', {})
        test = evaluation.get('test', {})
        zero = evaluation.get('test_zero_amount_baseline', {})
        components = info.get('prediction_components', {})
        return {
            'model': {
                'id': 'v2', 'version': info['model_version'], 'experimental': bool(info.get('experimental')),
                'task': info.get('task'), 'target': info.get('target_description'),
                'trainedThrough': (info.get('trained_through_utc') or '')[:10] or None,
                'features': info.get('feature_columns', []),
                'amountMethod': info.get('selected_amount_method'),
                'estimators': [{'name': name, 'estimator': c.get('estimator'), 'role': c.get('role')}
                               for name, c in components.items() if c.get('estimator')],
                'test': {
                    'rows': test.get('rows'), 'eventRate': test.get('event_rate'),
                    'eventAveragePrecision': test.get('event_average_precision'),
                    'rocAuc': test.get('event_roc_auc'), 'brierScore': test.get('event_brier_score'),
                    'dailyMaeMwh': test.get('daily_mae_mwh'), 'positiveDayMaeMwh': test.get('positive_day_mae_mwh'),
                    'zeroBaselineMaeMwh': zero.get('daily_mae_mwh'),
                    'monthlyMedianBaselineMaeMwh': evaluation.get('test_monthly_median_baseline_mae_mwh'),
                    'byQuarter': evaluation.get('test_by_quarter', {}),
                },
                'caveats': [c for c in (evaluation.get('source_caveat'), evaluation.get('future_window_notice')) if c],
                'forecastSource': coverage.get('forecast_source'),
            },
            'dataset': {
                'from': coverage['historical_date_min_utc'], 'to': coverage['historical_date_max_utc'],
                'count': coverage.get('historical_complete_day_count'),
                'fittedThrough': coverage.get('fitted_through_date_utc'),
                'partitions': {name: {'from': p['first_target_date_utc'], 'to': p['last_target_date_utc'],
                                      'rows': p['complete_day_count']}
                               for name, p in coverage.get('partitions', {}).items()},
            },
        }
    return cached('v2-info', INFO_CACHE_SECONDS, build)


def validate_day(value):
    info = daily_info()
    day = date.fromisoformat(value).isoformat()
    if not info['dataset']['from'] <= day <= info['dataset']['to']:
        raise LookupError('That date is not in the daily model dataset.')
    return day, info


def _daily_one(day):
    def build():
        prediction, actual = parallel(
            lambda: call('/predict/curtailment/day', {'target_date_utc': day}),
            lambda: call(f'/actuals/daily-curtailment?target_date_utc={day}'))
        return {
            'date': day, 'modelVersion': prediction.get('model_version'),
            'issuedAt': prediction.get('issue_timestamp_utc'),
            'weatherAvailableAt': prediction.get('forecast_max_available_at_utc'),
            'probability': finite(prediction['curtailment_event_probability'], 'probability', 0, 1),
            'predictedMwh': finite(prediction['predicted_curtailment_mwh'], 'energy', 0),
            'actual': {'status': actual.get('status'),
                       'curtailmentMwh': finite(actual.get('actual_curtailment_mwh'), 'actual', optional=True),
                       'event': actual.get('actual_curtailment_event')},
        }
    return cached(('v2-day', day), None, build)


def daily_predict(day):
    day, info = validate_day(day)
    result = dict(_daily_one(day))
    result['partition'] = partition_of(day, info['dataset']['partitions'])
    return result


def daily_week(day):
    """Seven days starting on the selection, for context. Near the dataset end the week
    shifts back so it still shows seven days and includes the selection."""
    day, info = validate_day(day)
    first, last = date.fromisoformat(info['dataset']['from']), date.fromisoformat(info['dataset']['to'])
    start = min(date.fromisoformat(day), max(first, last - timedelta(days=6)))
    days = [(start + timedelta(days=i)).isoformat() for i in range(7)
            if start + timedelta(days=i) <= last]
    results = parallel(*[lambda d=d: _daily_one(d) for d in days])
    return {'selected': day, 'days': results}
