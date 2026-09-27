"""Forecast explorer: proxies GridToEv's two models for the Forecast page.

V1 (short-term) predicts half-hour dispatch-down 30 and 60 minutes after a
historical dataset issue time. V2 (daily) predicts whether curtailment occurs
and its total MWh over one UTC day. Only dataset dates/times are accepted, so
the browser can never ask the model for a target it has no inputs for.
The API key stays on the server; the browser only sees normalized results.
"""
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
import io
import json
import math
import os
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

# Window replays can take ~15 s on the hosted service, and a sleeping service
# can take up to a minute to wake, so explorer calls get a longer budget.
TIMEOUT = 60
INFO_CACHE_SECONDS = 600
# Error codes GridToEv returns (HTTP 404, detail.error) when a requested row or
# window is outside its fixed historical dataset. Any other 404 is a real failure.
MISSING_ROW_ERRORS = {'dataset_timestamp_not_available', 'dataset_window_not_available'}
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
    try:
        with urlopen(request, timeout=TIMEOUT) as response:
            return json.load(response)
    except HTTPError as error:
        raw = error.read()
        error.close()
        # Re-raise with a re-readable body so server.diagnose can still report the upstream detail.
        replay = HTTPError(error.url, error.code, error.reason, error.headers, io.BytesIO(raw))
        replay.model_detail = _model_detail(raw)
        raise replay from None


def _model_detail(raw):
    """The structured FastAPI `detail` object from an error body, or {}."""
    try:
        detail = json.loads(raw or b'null').get('detail')
    except (ValueError, AttributeError):
        return {}
    return detail if isinstance(detail, dict) else {}


def missing_row(error):
    """True only for the model's own 'not in the dataset' 404s, e.g. the +60 min row
    after the final issue time. Wrong routes or other 404s are not swallowed."""
    return (isinstance(error, HTTPError) and error.code == 404
            and getattr(error, 'model_detail', {}).get('error') in MISSING_ROW_ERRORS)


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


def _verify_by_replay(candidates):
    """Ask the model which candidate issue times exist by replaying them in windows.

    A window error names the first missing issue time; everything before it in that
    window exists, so that time is dropped and the scan continues after it.
    """
    verified, i = [], 0
    while i < len(candidates):
        chunk = candidates[i:i + 48]  # the window route accepts at most 24 hours
        try:
            rows = call('/predict/window/from-dataset', {'start_timestamp_utc': iso(chunk[0]), 'duration_hours': len(chunk) / 2,
                                                         'forecast_horizons_minutes': [30]}).get('predictions', [])
            verified += [utc(r['issue_timestamp_utc']) for r in rows]
            i += len(chunk)
        except HTTPError as error:
            if not missing_row(error):
                raise
            missing = error.model_detail.get('first_missing_issue_timestamp_utc')
            gap = utc(missing) if missing else chunk[0]
            verified += [t for t in chunk if t < gap]
            i += max(1, sum(1 for t in chunk if t <= gap))
    return verified


def _available_times(dataset, listed):
    """Every V1 issue time, verified against the model.

    /dataset/available-times lists at most the latest 1000. The earlier half-hours are
    only accepted without further calls when the reported total proves there is no gap
    among them; otherwise each one is confirmed by replaying it.
    Returns (times, how they were verified).
    """
    listed = sorted(utc(t) for t in listed)
    earliest = utc(dataset['available_issue_timestamp_min_utc'])
    candidates, cursor = [], earliest
    while listed and cursor < listed[0]:
        candidates.append(cursor)
        cursor += timedelta(minutes=30)
    if not candidates:
        return [iso(t) for t in listed], 'listed'
    if len(candidates) + len(listed) == dataset.get('available_issue_timestamp_count'):
        return [iso(t) for t in candidates + listed], 'count'
    key = ('v1-verified', iso(earliest), iso(listed[0]), dataset.get('available_issue_timestamp_count'))
    return [iso(t) for t in cached(key, None, lambda: _verify_by_replay(candidates)) + listed], 'replay'


def forecast_issues(target, times, last_issue=None):
    """{horizon: issue time} for each forecast the model can make for this target half-hour.

    A dataset row exists for (issue, horizon) only when the issue time is in the dataset and
    the target is no later than the last labelled target (last issue time + 30 minutes); e.g.
    the final 22:30 issue has a +30 row (23:00) but no +60 row (23:30).
    """
    available = times if isinstance(times, set) else set(times)
    last_target = utc(last_issue or max(available)) + timedelta(minutes=30)
    moment = utc(target)
    if moment > last_target:
        return {}
    issues = {h: iso(moment - timedelta(minutes=h)) for h in (30, 60)}
    return {h: t for h, t in issues.items() if t in available}


def valid_targets(times):
    """Every target half-hour with at least one forecast row in the dataset."""
    available, last = set(times), max(times)
    candidates = {iso(utc(t) + timedelta(minutes=h)) for t in times for h in (30, 60)}
    return sorted(t for t in candidates if forecast_issues(t, available, last))


def short_term_info():
    def build():
        dataset, listed, info = parallel(lambda: call('/dataset/info'),
                                         lambda: call('/dataset/available-times?limit=1000'),
                                         lambda: call('/model-info'))
        times, verification = _available_times(dataset, listed['issue_timestamps_utc'])
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
                        'verification': verification,
                        'intervalMinutes': dataset.get('interval_minutes', 30)},
            'times': times,
            'targets': valid_targets(times),
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


def day_observed(day):
    """The 48 observed half-hours (00:00-23:30 UTC) of a day from one /actuals/v1/window call.

    This takes ~0.3 s, while replaying the model's predictions for the same day takes ~13 s,
    so the page can draw reality immediately and add the forecast line when it arrives.
    """
    day = date.fromisoformat(day).isoformat()
    if not any(t.startswith(day) for t in short_term_info()['times']):
        raise LookupError('That date is not in the short-term model dataset.')

    def build():
        body = call('/actuals/v1/window', {'start_target_timestamp_utc': f'{day}T00:00:00Z', 'duration_hours': 24})
        actuals = {a['targetAt']: a for a in map(_v1_actual, body.get('actuals', []))}
        return {'date': day, 'observed': [{'targetAt': t, 'actualMwh': actuals[t]['dispatchDownMwh'] if t in actuals else None}
                                          for t in day_targets(day)]}
    return cached(('v1-observed', day), None, build)


def _v1_actuals(targets):
    if not targets:
        return {}
    body = call('/actuals/v1/batch', {'target_timestamps_utc': targets})
    return {a['targetAt']: a for a in map(_v1_actual, body.get('actuals', []))}


def short_term_predict(target, capacity):
    """Both forecasts of one target half-hour: +30 min (issued 30 min before) and
    +60 min (issued 60 min before), with the observed value for that half-hour.

    Working by target keeps the selected half-hour on its own day even when a
    forecast for 00:00 was issued the previous evening.
    """
    info = short_term_info()
    target, available = iso(utc(target)), set(info['times'])
    issues = forecast_issues(target, available)
    if not issues:
        raise LookupError('No dataset issue time forecasts that target half-hour.')

    def one(horizon):
        try:
            return call('/predict/from-dataset', {'issue_timestamp_utc': issues[horizon], 'forecast_horizon_minutes': horizon,
                                                  'flexible_load_capacity_mw': capacity})
        except HTTPError as error:
            if missing_row(error):
                return None
            raise
    rows = [row for row in parallel(*[lambda h=h: one(h) for h in issues]) if row]
    if not rows:
        raise LookupError('The model has no prediction for that target half-hour.')
    points = sorted(map(_v1_point, rows), key=lambda p: p['horizonMinutes'])
    if any(p['targetAt'] != target for p in points):
        raise ValueError('Prediction target does not match the requested half-hour')
    actual = _v1_actuals([target]).get(target)
    for p in points:
        p['partition'] = partition_of(p['issuedAt'], info['model']['partitions'])
    return {'targetAt': target, 'modelVersion': rows[0].get('model_version'), 'capacityMw': capacity,
            'actual': actual, 'predictions': points}


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
        if not missing_row(error):
            raise
    return replay(len(run) / 2 - 0.5) if len(run) > 1 else []


def day_targets(day):
    start = datetime.fromisoformat(f'{day}T00:00:00+00:00')
    return [iso(start + timedelta(minutes=30 * i)) for i in range(48)]


def _with_retry(fn):
    """One retry for a timeout or 5xx: the hosted service queues heavy replays and can time out."""
    try:
        return fn()
    except HTTPError as error:
        if error.code < 500:
            raise
    except (URLError, TimeoutError, OSError):
        pass
    return fn()


def short_term_day(day, horizon=30):
    """Replay the 48 target half-hours (00:00-23:30 UTC) of one day at one horizon, with actuals.

    A target at 00:00 is predicted from 23:30 (+30) or 23:00 (+60) the day before, so each
    horizon replays its own issue times, shifted back by the horizon. The hosted service
    processes replays one at a time (a 24 h window takes ~13 s alone, ~39 s when two run
    together), so one horizon is replayed per request and its runs are fetched sequentially.
    """
    if horizon not in (30, 60):
        raise ValueError('Horizon must be 30 or 60 minutes')
    day = date.fromisoformat(day).isoformat()
    info = short_term_info()
    if not any(t.startswith(day) for t in info['times']):
        raise LookupError('That date is not in the short-term model dataset.')
    available, targets = set(info['times']), day_targets(day)
    last = max(available)
    issues = [i for i in (forecast_issues(t, available, last).get(horizon) for t in targets) if i]

    def build():
        rows = [row for run in contiguous_runs(issues) for row in _with_retry(lambda run=run: _window(run, horizon))]
        points = [p for p in map(_v1_point, rows) if p['targetAt'].startswith(day)]
        observed = day_observed(day)['observed']  # usually already cached by the page's fast request
        by_target = {o['targetAt']: o['actualMwh'] for o in observed}
        for p in points:
            p['actualMwh'] = by_target.get(p['targetAt'])
        return {'date': day, 'horizonMinutes': horizon, 'modelVersion': rows[0].get('model_version') if rows else None,
                'points': points, 'observed': observed}
    return cached(('v1-day', day, horizon), None, build)


# ---------------------------------------------------------------- V2 daily

def _daily_caveats(info, evaluation):
    """The daily model's own caveats, plus what its metadata implies for reading one day.

    Text notes in `evaluation` are collected generically, since the hosted service has
    renamed them before. Notes about the multi-day window route are skipped: this page
    only uses the single-day route.
    """
    caveats = []
    if info.get('experimental'):
        caveats.append('Experimental model: the service marks V2 as experimental, not production-approved.')
    if info.get('selected_amount_method') == 'two_stage':
        caveats.append('The MWh estimate is event probability × expected size on a curtailment day, '
                       'so it understates big days and is never exactly zero.')
    caveats += [text for key, text in evaluation.items()
                if isinstance(text, str) and text and 'window' not in key]
    return caveats


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
                'caveats': _daily_caveats(info, evaluation),
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


def _daily_actual(row):
    return {'status': row.get('status'),
            'curtailmentMwh': finite(row.get('actual_curtailment_mwh'), 'actual', optional=True),
            'event': row.get('actual_curtailment_event')}


def _daily_actuals(days):
    """{day: actual} for consecutive days. Uncached days come from one window call
    (/actuals/daily-curtailment/window) instead of one request per day."""
    with _cache_lock:
        missing = [d for d in days if ('v2-actual', d) not in _cache]
    if len(missing) == 1:
        rows = [call(f'/actuals/daily-curtailment?target_date_utc={missing[0]}')]
    elif missing:
        rows = call('/actuals/daily-curtailment/window', {'start_date_utc': missing[0], 'days': len(missing)}).get('actuals', [])
    else:
        rows = []
    for row in rows:
        day = row.get('target_date_utc') or missing[0]
        cached(('v2-actual', day), None, lambda row=row: _daily_actual(row))
    return {d: cached(('v2-actual', d), None, lambda: {'status': 'missing', 'curtailmentMwh': None, 'event': None})
            for d in days}


def _daily_prediction(day):
    def build():
        prediction = call('/predict/curtailment/day', {'target_date_utc': day})
        return {
            'date': day, 'modelVersion': prediction.get('model_version'),
            'issuedAt': prediction.get('issue_timestamp_utc'),
            'weatherAvailableAt': prediction.get('forecast_max_available_at_utc'),
            'probability': finite(prediction['curtailment_event_probability'], 'probability', 0, 1),
            'predictedMwh': finite(prediction['predicted_curtailment_mwh'], 'energy', 0),
        }
    return cached(('v2-day', day), None, build)


def _daily_one(day):
    prediction, actuals = parallel(lambda: _daily_prediction(day), lambda: _daily_actuals([day]))
    return {**prediction, 'actual': actuals[day]}


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
    actuals, *predictions = parallel(lambda: _daily_actuals(days), *[lambda d=d: _daily_prediction(d) for d in days])
    return {'selected': day, 'days': [{**p, 'actual': actuals[p['date']]} for p in predictions]}
