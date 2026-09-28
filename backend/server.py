"""Small product API and static frontend host. Run: python backend/server.py."""
from datetime import date, datetime, timedelta, timezone
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import math
import os
import socket
import ssl
import threading
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlsplit
from urllib.request import Request, urlopen
from scenario import build_scenario, validate_demand, validate_ev, DEFAULT_KWH_PER_CHARGE, DEFAULT_CHARGER_KW, worked_example
import dayplan
from demo import demo_day_rows, demo_payload
from http.client import HTTPException
from config import load_env
import business
import chat
import explorer
import sources
import fleet as fleets
import offers
import optimizer
import storage
import synthetic
import targets
from gate import FOREGROUND, PREFETCH, Busy, Superseded, gate

ROOT = Path(__file__).resolve().parents[1]
load_env(ROOT / '.env')
MODEL_URL = os.environ.get('GRID_TO_EV_API_BASE_URL', 'http://127.0.0.1:8000').rstrip('/')
TIMEOUT = float(os.environ.get('GRID_TO_EV_TIMEOUT_SECONDS', '3'))
if not math.isfinite(TIMEOUT) or not 0 < TIMEOUT <= 10:
    raise ValueError('GRID_TO_EV_TIMEOUT_SECONDS must be between 0 (exclusive) and 10 seconds.')


def number(value, name, minimum=0, maximum=None):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f'Invalid {name}')
    if not math.isfinite(value) or value < minimum or (maximum is not None and value > maximum):
        raise ValueError(f'Invalid {name}')
    return value


def timestamp(value):
    if not isinstance(value, str):
        raise ValueError('Invalid timestamp')
    parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        raise ValueError('Timestamp must include timezone')
    return parsed.astimezone(timezone.utc)


def normalize_row(row, capacity):
    """Validate one GridToEv V1 prediction row and map it to product fields."""
    horizon = number(row['forecast_horizon_minutes'], 'horizon')
    if horizon not in (30, 60):
        raise ValueError('Unsupported horizon')
    issued, target = timestamp(row['issue_timestamp_utc']), timestamp(row['target_timestamp_utc'])
    if (target - issued).total_seconds() != horizon * 60:
        raise ValueError('Inconsistent target timestamp')
    total = number(row['predicted_dispatch_down_mwh'], 'energy')
    curtailment = number(row['predicted_curtailment_mwh'], 'curtailment')
    constraint = number(row['predicted_constraint_mwh'], 'constraint')
    recovered = number(row['recoverable_surplus_mwh'], 'recovery')
    supplied_capacity = number(row['flexible_load_capacity_mw'], 'capacity')
    if not math.isclose(supplied_capacity, capacity) or not math.isclose(total, curtailment + constraint, abs_tol=0.001):
        raise ValueError('Inconsistent capacity or components')
    if not math.isclose(recovered, min(total, capacity * 0.5), abs_tol=0.001):
        raise ValueError('Inconsistent recoverable energy')
    lower, median, upper = [number(row[f'prediction_interval_{q}_mwh'], q) for q in ('p10', 'p50', 'p90')]
    if not lower <= median <= upper:
        raise ValueError('Invalid uncertainty range')
    risk = row['risk_level']
    version = row['model_version']
    if risk not in ('low', 'medium', 'high') or not isinstance(version, str) or not version:
        raise ValueError('Invalid model metadata')
    return dict(horizonMinutes=int(horizon), issuedAt=issued.isoformat(), targetAt=target.isoformat(),
                modelVersion=version, probability=number(row['dispatch_down_probability'], 'probability', maximum=1),
                risk=risk, atRiskMwh=total, curtailmentMwh=curtailment, constraintMwh=constraint,
                lowerMwh=lower, medianMwh=median, upperMwh=upper, potentialRecoveryMwh=recovered)


def normalize(payload, capacity):
    rows = payload['predictions']
    if not isinstance(rows, list) or len(rows) != 2:
        raise ValueError('Expected both forecast horizons')
    points = [normalize_row(row, capacity) for row in rows]
    points.sort(key=lambda p: p['horizonMinutes'])
    # Both horizons forecast the same target half-hour, each from its own issue time.
    if [p['horizonMinutes'] for p in points] != [30, 60] or len({p['targetAt'] for p in points}) != 1 or len({p['modelVersion'] for p in points}) != 1:
        raise ValueError('Forecast horizons must share a target time and model')
    return dict(generatedAt=datetime.now(timezone.utc).isoformat(), source='grid-to-ev-model',
                dataMode='historical-prediction', dataLabel='Historical dataset prediction', live=False,
                region='Ireland', intervalMinutes=30, targetAt=points[0]['targetAt'],
                flexibleCapacityMw=capacity, modelVersion=points[0]['modelVersion'], predictions=points,
                fallback={'active': False, 'reason': None})


# The dashboard shows one target half-hour from GridToEv's V1 historical dataset. Each
# horizon is requested from its own issue time so both predict the same target (e.g. for
# 23:00: +30 min issued 22:30, +60 min issued 22:00). Pages get a random target the model
# predicts to have extra dispatch-down, chosen from predictions only (see targets.py); TARGET_TIMESTAMP, the dataset's
# final half-hour, is only the fixed target for the health probe. These are historical
# dataset predictions, not live forecasts.
TARGET_TIMESTAMP = os.environ.get('GRID_TO_EV_TARGET_TIMESTAMP', '2026-01-31T23:00:00Z')


def issue_timestamp(horizon, target=None):
    """The dataset issue time whose +horizon forecast lands on the target half-hour."""
    issued = timestamp(target or TARGET_TIMESTAMP) - timedelta(minutes=horizon)
    return issued.strftime('%Y-%m-%dT%H:%M:%SZ')


def post_prediction(capacity, horizon, target=None):
    headers = {'Accept': 'application/json', 'Content-Type': 'application/json'}
    key = os.environ.get('GRID_TO_EV_API_KEY')
    if key:
        headers['X-API-Key'] = key
    body = json.dumps({
        'issue_timestamp_utc': issue_timestamp(horizon, target),
        'forecast_horizon_minutes': horizon,
        'flexible_load_capacity_mw': capacity,
    }).encode()
    request = Request(f'{MODEL_URL}/predict/from-dataset', data=body, headers=headers, method='POST')
    for attempt in range(2):
        try:
            with urlopen(request, timeout=TIMEOUT) as response:
                return json.load(response)
        except HTTPError as error:
            if attempt or error.code < 500:
                raise
        except (URLError, TimeoutError, OSError):
            if attempt:
                raise


def fetch_forecast(capacity, target=None):
    rows = [post_prediction(capacity, horizon, target) for horizon in (30, 60)]
    return normalize({'predictions': rows}, capacity)


# A 24-hour window replay takes ~15 s upstream (well beyond the per-call TIMEOUT), and the
# hosted model serves requests one at a time, so allow for one queued replay ahead of it.
WINDOW_TIMEOUT = 90
# Days either side of a served day to replay in the background. Off (0): the Impact page follows
# the live forecast day and has no date picker, so neighbours would only occupy the single-worker
# model. The page requests the previous day itself for its day-over-day comparison. Set to e.g. 3
# if date browsing returns.
PREFETCH_DAYS = 0
_day_cache = {}
_day_inflight = {}  # key -> Event set when the owning fetch finishes (success or failure)
_day_cache_lock = threading.Lock()
# Prefetch plan: replaced (not appended) on each served day, so stale neighbours of days the
# user has moved away from are dropped. The worker waits while any user replay is in flight,
# because the upstream model processes one request at a time.
_prefetch_plan = []
_prefetch_wakeup = threading.Condition(_day_cache_lock)
_user_replays = 0
_prefetch_worker = None
_dataset_range = None


class DateOutOfRange(Exception):
    def __init__(self, first, last):
        super().__init__(f'Choose a date between {first} and {last}.')


def model_request(path, body=None, timeout=TIMEOUT):
    headers = {'Accept': 'application/json'}
    key = os.environ.get('GRID_TO_EV_API_KEY')
    if key:
        headers['X-API-Key'] = key
    data = None
    if body is not None:
        headers['Content-Type'] = 'application/json'
        data = json.dumps(body).encode()
    request = Request(f'{MODEL_URL}{path}', data=data, headers=headers, method='POST' if data else 'GET')
    with urlopen(request, timeout=timeout) as response:
        return json.load(response)


def dataset_range():
    """First/last replayable issue times of the fixed historical dataset (cached per process)."""
    global _dataset_range
    if _dataset_range is None:
        info = model_request('/dataset/info')
        first = timestamp(info['available_issue_timestamp_min_utc'])
        last = timestamp(info['available_issue_timestamp_max_utc'])
        if last < first:
            raise ValueError('Invalid dataset range')
        _dataset_range = first, last
    return _dataset_range


def fetch_day_replay(day, capacity, prefetch=False):
    """48 consecutive +30 minute predictions issued across one UTC day (cached by day and capacity).

    Concurrent requests for the same day share one upstream call: a user request for a
    day that is already being prefetched waits for that result instead of starting a second
    ~15 s replay.
    """
    key = (day.isoformat(), capacity)
    for _ in range(2):
        with _day_cache_lock:
            if key in _day_cache:
                return _day_cache[key]
            pending = _day_inflight.get(key)
            if pending is None:
                pending = _day_inflight[key] = threading.Event()
                break
        pending.wait(WINDOW_TIMEOUT)  # owner failed or timed out if the cache is still empty
    else:  # the previous owner never produced a result; fetch it ourselves
        with _day_cache_lock:
            pending = _day_inflight[key] = threading.Event()
    try:
        replay = gate.run(('impact-day', day.isoformat(), capacity), lambda: _replay_day(day, capacity),
                          PREFETCH if prefetch else FOREGROUND)
        with _day_cache_lock:
            _day_cache[key] = replay
        return replay
    finally:
        with _day_cache_lock:
            if _day_inflight.get(key) is pending:
                del _day_inflight[key]
        pending.set()


def _replay_day(day, capacity):
    first, last = dataset_range()
    start = datetime(day.year, day.month, day.day, tzinfo=timezone.utc)
    # The dataset's last day can be partial; only request issue times that exist.
    hours = min(24.0, ((last - start).total_seconds() / 3600) + 0.5)
    if start < first or hours <= 0:
        raise DateOutOfRange(first.date(), last.date())
    payload = model_request('/predict/window/from-dataset', dict(
        start_timestamp_utc=start.isoformat().replace('+00:00', 'Z'), duration_hours=hours,
        forecast_horizons_minutes=[30], flexible_load_capacity_mw=capacity), timeout=WINDOW_TIMEOUT)
    rows = payload['predictions']
    if not isinstance(rows, list) or not rows:
        raise ValueError('Empty window replay')
    points = sorted((normalize_row(row, capacity) for row in rows), key=lambda p: p['targetAt'])
    if any(p['horizonMinutes'] != 30 for p in points) or len({p['targetAt'] for p in points}) != len(points):
        raise ValueError('Window replay must contain distinct +30 minute targets')
    if len({p['modelVersion'] for p in points}) != 1:
        raise ValueError('Window replay mixes model versions')
    return dict(date=day.isoformat(), range=dict(min=first.date().isoformat(), max=last.date().isoformat()),
                source='grid-to-ev-model', modelVersion=points[0]['modelVersion'], intervalMinutes=30,
                horizonMinutes=30, flexibleCapacityMw=capacity, predictions=points)


def demo_day_replay(day, capacity):
    """Synthetic day replay used when the model cannot be reached, so the Impact page keeps its full layout."""
    last = default_replay_day()
    points = [normalize_row(row, capacity) for row in demo_day_rows(capacity, day)]
    return dict(date=day.isoformat(), range=dict(min=(last - timedelta(days=364)).isoformat(), max=last.isoformat()),
                source='local-demo-fixture', dataMode='simulated', modelVersion=points[0]['modelVersion'],
                intervalMinutes=30, horizonMinutes=30, flexibleCapacityMw=capacity, predictions=points)


def neighbour_days(day, first, last, span=None):
    """Days within span (default PREFETCH_DAYS) of day, nearest first (-1, +1, -2, ...), clipped to the dataset.

    The previous day goes first because the Impact page compares each day with it."""
    span = PREFETCH_DAYS if span is None else span
    offsets = [sign * n for n in range(1, span + 1) for sign in (-1, 1)]
    return [d for d in (day + timedelta(days=o) for o in offsets) if first <= d <= last]


def _next_prefetch():
    """Block until a planned day can be fetched without delaying a user request."""
    with _prefetch_wakeup:
        while True:
            while _prefetch_plan and (_prefetch_plan[0] in _day_cache or _prefetch_plan[0] in _day_inflight):
                _prefetch_plan.pop(0)
            if _prefetch_plan and _user_replays == 0:
                return _prefetch_plan.pop(0)
            _prefetch_wakeup.wait()


def _prefetch_loop():
    while True:
        day, capacity = _next_prefetch()
        try:
            fetch_day_replay(date.fromisoformat(day), capacity, prefetch=True)
        except Exception:  # best effort; a real request will surface any error
            pass


def schedule_prefetch(day, capacity):
    """Replace the prefetch plan with this day's uncached neighbours (one background worker)."""
    global _prefetch_worker
    if PREFETCH_DAYS <= 0:
        return
    first, last = (t.date() for t in dataset_range())
    with _prefetch_wakeup:
        _prefetch_plan[:] = [key for key in ((d.isoformat(), capacity) for d in neighbour_days(day, first, last))
                             if key not in _day_cache and key not in _day_inflight]
        if _prefetch_worker is None:
            _prefetch_worker = threading.Thread(target=_prefetch_loop, name='day-prefetch', daemon=True)
            _prefetch_worker.start()
        _prefetch_wakeup.notify_all()


class user_replay:
    """Marks a user-facing replay as in flight so the prefetch worker holds off."""
    def __enter__(self):
        global _user_replays
        with _prefetch_wakeup:
            _user_replays += 1

    def __exit__(self, *exc):
        global _user_replays
        with _prefetch_wakeup:
            _user_replays -= 1
            _prefetch_wakeup.notify_all()


def default_replay_day(now=None):
    """Impact day when the page does not name one: the day of the fixed dataset target.

    The Impact page normally sends the day of the dashboard's current (random high-MWh)
    target, so its day replay and the scenario cards agree.
    """
    return timestamp(TARGET_TIMESTAMP).date()


# def fetch_forecast(capacity):
#     headers = {'Accept': 'application/json'}
#     key = os.environ.get('GRID_TO_EV_API_KEY')
#     if key:
#         headers['X-API-Key'] = key
#     request = Request(f'{MODEL_URL}/predict/latest?flexible_load_capacity_mw={capacity}', headers=headers)
#     with urlopen(request, timeout=TIMEOUT) as response:
#         return normalize(json.load(response), capacity)


HTTP_DIAGNOSES = {
    400: ('MODEL_REJECTED_REQUEST', 'The model rejected the forecast request.'),
    401: ('MODEL_AUTH_FAILED', 'The model rejected the API key. Check GRID_TO_EV_API_KEY in .env.'),
    403: ('MODEL_AUTH_FAILED', 'The model rejected the API key. Check GRID_TO_EV_API_KEY in .env.'),
    404: ('MODEL_ENDPOINT_NOT_FOUND', 'The model is reachable but /predict/from-dataset was not found. Check GRID_TO_EV_API_BASE_URL.'),
    422: ('MODEL_REJECTED_REQUEST', 'The model rejected the forecast request.'),
    429: ('MODEL_RATE_LIMITED', 'The model is rate limiting requests. Wait and retry.'),
}


def upstream_detail(error):
    """Short FastAPI-style 'detail' from an upstream error body, if any."""
    try:
        body = json.loads(error.read(2000) or b'null')
    except (ValueError, OSError, HTTPException):
        return None
    detail = body.get('detail') if isinstance(body, dict) else None
    if isinstance(detail, list):
        detail = '; '.join(str(item.get('msg', item)) if isinstance(item, dict) else str(item) for item in detail)
    return str(detail)[:300] if detail else None


def diagnose(error):
    """Explain why a model call failed as a stable code, message and fallback reason."""
    if isinstance(error, HTTPError):
        code, message = HTTP_DIAGNOSES.get(error.code, ('MODEL_SERVER_ERROR', 'The model service returned an internal error.')
                                           if error.code >= 500 else ('MODEL_HTTP_ERROR', 'The model returned an unexpected HTTP status.'))
        detail = upstream_detail(error)
        return dict(code=code, message=message, httpStatus=error.code, detail=detail, fallbackReason='MODEL_UNAVAILABLE')
    if isinstance(error, (ValueError, KeyError, TypeError, OverflowError)):
        detail = f'Missing field {error}' if isinstance(error, KeyError) else str(error)
        return dict(code='INVALID_MODEL_RESPONSE', message='The model responded, but the forecast failed validation.',
                    httpStatus=None, detail=detail[:300] or None, fallbackReason='INVALID_MODEL_RESPONSE')
    reason = error.reason if isinstance(error, URLError) else error
    if isinstance(reason, (TimeoutError, socket.timeout)):
        code, message = 'MODEL_TIMEOUT', f'The model did not answer within {TIMEOUT:g} seconds. A sleeping hosted service can take about a minute to wake; retry shortly.'
    elif isinstance(reason, ConnectionRefusedError):
        code, message = 'MODEL_CONNECTION_REFUSED', 'Nothing is listening at the model address. Start GridToEv or check GRID_TO_EV_API_BASE_URL.'
    elif isinstance(reason, socket.gaierror):
        code, message = 'MODEL_DNS_FAILURE', 'The model host name could not be resolved. Check GRID_TO_EV_API_BASE_URL and the internet connection.'
    elif isinstance(reason, ssl.SSLError):
        code, message = 'MODEL_TLS_ERROR', 'A secure connection to the model could not be established.'
    elif isinstance(error, HTTPException):
        code, message = 'MODEL_INCOMPLETE_RESPONSE', 'The model connection closed before the response was complete.'
    else:
        code, message = 'MODEL_UNREACHABLE', 'The model could not be reached.'
    return dict(code=code, message=message, httpStatus=None, detail=None, fallbackReason='MODEL_UNAVAILABLE')


model_status_lock = threading.Lock()
model_status = dict(state='unknown', checkedAt=None, latencyMs=None, modelVersion=None, error=None)


def record_model_status(started, version=None, error=None):
    diagnosis = diagnose(error) if error is not None else None
    with model_status_lock:
        model_status.update(state='up' if error is None else 'down', checkedAt=datetime.now(timezone.utc).isoformat(),
                            latencyMs=round((time.monotonic() - started) * 1000),
                            modelVersion=version if error is None else model_status['modelVersion'],
                            error={k: v for k, v in diagnosis.items() if k != 'fallbackReason'} if diagnosis else None)
    return diagnosis


def available_forecast(capacity, target=None, mode='predicted'):
    """Always try the model, then use validated demo data for upstream failures.

    Without a target, one is sampled (see targets.py). Demo data never pretends to be the
    requested target: it keeps its own example time and records the target it stands in for.
    """
    started = time.monotonic()
    try:
        if target:
            forecast = fetch_forecast(capacity, target)
            forecast['selection'] = targets.selection_for(target)
        else:
            forecast = targets.pick(capacity, fetch_forecast, mode)
    except (URLError, TimeoutError, OSError, HTTPException, ValueError, KeyError, TypeError, OverflowError) as error:
        reason = record_model_status(started, error=error)['fallbackReason']
    else:
        record_model_status(started, forecast['modelVersion'])
        forecast.update(pinnedTarget=forecast['targetAt'].replace('+00:00', 'Z'), stale=None)
        return forecast
    forecast = normalize(demo_payload(capacity, datetime.now(timezone.utc)), capacity)
    forecast.update(source='local-demo-fixture', dataMode='simulated', dataLabel='Offline example (simulated)',
                    fallback={'active': True, 'reason': reason, 'requestedTarget': target},
                    pinnedTarget=target, stale=None)
    return forecast

FORECAST_CACHE_SECONDS = 300
STALE_FORECAST_SECONDS = 1800
KEEP_WARM_SECONDS = 480
forecast_cache_lock = threading.Lock()
# Real (never demo) forecasts only, keyed by (capacity, target half-hour).
forecast_cache = {}


def cached_forecast(capacity, target=None, refresh=False, mode='predicted'):
    """Forecast shared by the pages and Volt, so they all quote the same validated figures.

    The pages pin the target they were given and send it back, so live refreshes, Charging,
    Impact and Volt stay on one half-hour. During a model outage a pinned target gets its own
    last real forecast (marked stale) for up to STALE_FORECAST_SECONDS, never another
    target's. Otherwise demo data is returned, labelled as an unrelated offline example.
    """
    now = time.monotonic()
    with forecast_cache_lock:
        hit = forecast_cache.get((capacity, target)) if target else None
        if hit and not refresh and now - hit[0] < FORECAST_CACHE_SECONDS:
            return json.loads(json.dumps(hit[1]))
    forecast = available_forecast(capacity, target, mode)
    with forecast_cache_lock:
        if forecast['fallback']['active']:
            previous = forecast_cache.get((capacity, target)) if target else None
            if previous and now - previous[0] < STALE_FORECAST_SECONDS:
                kept = json.loads(json.dumps(previous[1]))
                kept['stale'] = {'since': kept['generatedAt'], 'reason': forecast['fallback']['reason']}
                # Keep its original time (so it still expires) but mark it stale for every reader, e.g. Volt.
                forecast_cache[(capacity, target)] = (previous[0], kept)
                return json.loads(json.dumps(kept))
        else:
            forecast_cache[(capacity, forecast['pinnedTarget'])] = (now, forecast)
    return json.loads(json.dumps(forecast))


def dashboard_target(value):
    """A requested dashboard target: a UTC half-hour with both horizons in the V1 dataset."""
    if value is None:
        return None
    moment = timestamp(value)
    if moment.minute not in (0, 30) or moment.second or moment.microsecond:
        raise ValueError('Target must be a UTC half-hour')
    target = moment.strftime('%Y-%m-%dT%H:%M:%SZ')
    try:
        known = targets.is_dataset_target(target)
    except (URLError, TimeoutError, OSError, HTTPException, KeyError):
        known = True  # dataset list unavailable: the model call decides (and falls back if needed)
    if not known:
        raise ValueError('Target is not in the V1 dataset')
    return target


def keep_model_warm():
    """Wake the hosted model at startup, cache a first forecast and its day replay, start the
    Impact page's week of replays and the background prediction index used to mix risk levels,
    then ping the model so it never sleeps."""
    try:
        model_request('/health', timeout=60)
        targets.dataset_targets()  # the population the dashboard's target is sampled from
        forecast = cached_forecast(100.0)
        fetch_day_replay(timestamp(forecast['targetAt']).date(), 100.0, prefetch=True)
        business.start_prefetch()  # Impact page: ~8 day replays at prefetch priority
    except Exception:  # the pages fall back to labelled demo data and retry on their own
        pass
    targets.start_index_build()  # ~30 day replays at prefetch priority, or loaded from disk
    while True:
        time.sleep(KEEP_WARM_SECONDS)
        try:
            model_request('/health', timeout=30)
        except Exception:
            pass


def health(probe=True):
    """Backend status plus why the model is (un)available. Never exposes the URL or key."""
    if probe:
        available_forecast(1, TARGET_TIMESTAMP)
    with model_status_lock:
        model = dict(model_status)
    host = urlsplit(MODEL_URL).hostname or ''
    model.update(target='local' if host in ('127.0.0.1', 'localhost', '::1') else 'hosted',
                 apiKeyConfigured=bool(os.environ.get('GRID_TO_EV_API_KEY')), timeoutSeconds=TIMEOUT)
    mode = {'up': 'live', 'down': 'fallback'}.get(model['state'], 'unknown')
    return dict(status='ok' if mode == 'live' else 'degraded', checkedAt=datetime.now(timezone.utc).isoformat(),
                targetIndex=targets.index_status(),
                backend={'status': 'ok'}, mode=mode, fallbackAvailable=True, model=model)


class ProductServer(ThreadingHTTPServer):
    # Windows SO_REUSEADDR permits two servers to bind the same address, routing
    # requests to an obsolete process. Require one owner of the listening port.
    allow_reuse_address = os.name != 'nt'

    def server_bind(self):
        if os.name == 'nt':
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()

DAY_PLAN_PRESET = 'depot-and-retail'  # the Dashboard's default fleet preset


class Handler(SimpleHTTPRequestHandler):
    def send_json(self, status, body, headers=None):
        encoded = json.dumps(body, allow_nan=False).encode()
        self.send_response(status)
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def charging_optimize(self):
        """Fleet plans for the server's own forecast. The browser supplies the fleet, never the forecast."""
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 256_000:
                raise ValueError('Request body must be between 1 byte and 256 kB.')
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise ValueError('Send a JSON object.')
            capacity = body.get('capacityMw', 100.0)
            number(capacity, 'capacity', minimum=0.001, maximum=10000)
            mode = body.get('uncertainty', 'expected')
            if 'fleet' in body:
                fleet_input, fixture = body['fleet'], None
            else:
                fixture = body.get('preset', 'depot-and-retail')
                if not isinstance(fixture, str):
                    raise ValueError('preset must be a string')
                fleet_input = fleets.preset(fixture)
            fleet_clean = fleets.validate(fleet_input)
            # The page's pinned target half-hour, so the plan uses the same forecast as every other view.
            target = dashboard_target(body.get('target'))
        except (ValueError, TypeError, UnicodeDecodeError) as error:
            message = str(error) if isinstance(error, ValueError) and not isinstance(error, json.JSONDecodeError) else 'Send valid JSON.'
            self.send_json(400, {'error': {'code': 'INVALID_REQUEST', 'message': message}})
            return
        forecast = cached_forecast(float(capacity), target)
        started = time.monotonic()
        try:
            plan = optimizer.optimize(fleet_clean, forecast, mode, fixture and f'{fleets.presets()["fixtureVersion"]}/{fixture}')
            storage.attach(plan)  # the Dashboard's simulated grid battery takes what the EVs could not
        except optimizer.ForecastError as error:
            self.send_json(502, {'error': {'code': 'INVALID_MODEL_RESPONSE', 'message': str(error)}})
            return
        except ValueError as error:
            self.send_json(400, {'error': {'code': 'INVALID_REQUEST', 'message': str(error)}})
            return
        except RuntimeError:
            self.send_json(500, {'error': {'code': 'OPTIMIZER_FAILED', 'message': 'The optimizer could not produce a plan that respects every constraint.'}})
            return
        plan['solver']['elapsedMs'] = round((time.monotonic() - started) * 1000, 1)
        self.send_json(200, plan)

    def synthetic_v1(self):
        """A synthetic V1 scenario from the model's example request; never stored or treated as a forecast."""
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 <= length <= 4_000:
                raise ValueError('Invalid body size')
            options = json.loads(self.rfile.read(length) or b'{}')
            if not isinstance(options, dict):
                raise ValueError('Expected an object')
            horizon, scenario = options.get('horizon', 30), options.get('scenario', 'ordinary')
            issue_mode = options.get('issueTime', 'example')
            capacity = float(options.get('capacityMw', 100))
            number(capacity, 'capacity', minimum=0.001, maximum=10000)
            if (horizon not in (30, 60) or isinstance(horizon, bool) or scenario not in synthetic.SCENARIOS
                    or issue_mode not in synthetic.ISSUE_MODES):
                raise ValueError('Invalid options')
        except (ValueError, TypeError):
            self.send_json(400, {'error': {'code': 'INVALID_REQUEST', 'message': 'Use horizon 30 or 60, scenario "ordinary" or "high-curtailment", issueTime "example" or "current", and capacity 0.001-10000 MW.'}})
            return
        try:
            self.send_json(200, synthetic.run(horizon, scenario, capacity, issue_mode))
        except synthetic.SchemaDrift as error:
            self.send_json(502, {'error': {'code': 'EXAMPLE_SCHEMA_DRIFT', 'message': str(error)}})
        except (URLError, TimeoutError, OSError, HTTPException, ValueError, KeyError, TypeError, OverflowError) as error:
            diagnosis = diagnose(error)
            self.send_json(502, {'error': {'code': diagnosis['code'], 'message': diagnosis['message'], 'detail': diagnosis['detail']}})

    def do_POST(self):
        if urlsplit(self.path).path == '/api/v1/charging/optimize':
            self.charging_optimize()
            return
        if urlsplit(self.path).path == '/api/v1/synthetic-v1':
            self.synthetic_v1()
            return
        if urlsplit(self.path).path == '/api/v1/business/offers':
            self.offers_action()
            return
        if urlsplit(self.path).path != '/api/v1/chat':
            self.send_json(404, {'error': {'code': 'NOT_FOUND', 'message': 'Unknown API endpoint.'}})
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 64_000:
                raise ValueError('Invalid body size')
            messages, page, horizon, selectors = chat.validate_request(json.loads(self.rfile.read(length)))
            number(selectors['capacityMw'], 'capacity', minimum=0.001, maximum=10000)
            validate_demand(selectors['totalDemandKwh'], selectors['flexibleDemandKwh'])
            selectors['target'] = dashboard_target(selectors['target'])
        except (ValueError, TypeError):
            self.send_json(400, {'error': {'code': 'INVALID_REQUEST', 'message': 'Send a short question (up to 1000 characters).'}})
            return
        # Figures come from the server's own forecast and scenario, never from the browser.
        forecast = cached_forecast(selectors['capacityMw'], selectors['target'])
        scenario = build_scenario(forecast, selectors['totalDemandKwh'], selectors['flexibleDemandKwh'])
        try:  # the same fleet plan the page shows; Volt still answers everything else without it
            plan = optimizer.optimize(fleets.preset(selectors['fleetPreset']), forecast, selectors['uncertainty'],
                                      f'{fleets.presets()["fixtureVersion"]}/{selectors["fleetPreset"]}')
            storage.attach(plan)  # same grid battery as the Dashboard card
        except (ValueError, RuntimeError, KeyError, OSError) as error:
            print(f'Volt has no fleet plan ({error}).', flush=True)
            plan = None
        self.send_json(200, {'reply': chat.answer(messages, page, horizon, forecast, scenario, plan)})

    def business_impact(self, query):
        """Impact page: 202 with progress while the week is replayed, then the full result."""
        body = business.current(refresh=query.get('refresh', ['0'])[0] == '1')
        if body['status'] == 'preparing':
            self.send_json(202, body, {'Retry-After': '2'})
        elif body['status'] == 'failed':
            self.send_json(500, {'error': {'code': 'IMPACT_FAILED', 'message': body['message']}})
        else:
            self.send_json(200, body)

    def business_estimate(self, query):
        """Impact page calculator: an illustrative yearly saving for another fleet."""
        values, errors = business.parse_estimate({key: value[0] for key, value in query.items()})
        if errors:
            self.send_json(400, {'error': {'code': 'INVALID_REQUEST', 'message': 'Check the highlighted inputs.', 'fields': errors}})
            return
        self.send_json(200, business.estimate(**values))

    def offers_section(self):
        """The discount-window section of the Impact result, or None after answering 202/500/200-empty."""
        body = business.current()
        if body['status'] == 'preparing':
            self.send_json(202, {'status': 'preparing', 'progress': body.get('progress')}, {'Retry-After': '2'})
        elif body['status'] == 'failed':
            self.send_json(500, {'error': {'code': 'IMPACT_FAILED', 'message': body['message']}})
        elif body['status'] == 'empty' or not body.get('discountWindows'):
            self.send_json(200, {'status': 'empty', 'message': body.get('message') or 'No replayed nights to offer windows from.'})
        else:
            return body
        return None

    def business_offers(self, query):
        """EV page: the discount windows of the replayed week and this demo member's bookings."""
        body = self.offers_section()
        if body is None:
            return
        section = body['discountWindows']
        member = query.get('member', [''])[0]
        self.send_json(200, {
            'status': 'ready', 'version': section['version'], 'scenarioId': body['scenarioId'], 'dataMode': body['dataMode'],
            'label': section['label'], 'hub': section['hub'], 'battery': section['battery'], 'prices': section['prices'],
            'split': section['split'], 'windows': section['windows'], 'offers': section['offers'], 'sessionKwh': section['sessionKwh'],
            'member': offers.member_view(member) if offers.MEMBER_ID.match(member) else {'joined': False, 'bookings': []},
        })

    def offers_action(self):
        """EV page demo: join, leave, book or cancel a discount window. Not a real account or payment."""
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 4000:
                raise ValueError('Invalid body size')
            request = json.loads(self.rfile.read(length))
            if not isinstance(request, dict):
                raise ValueError('Body must be an object')
        except (ValueError, TypeError):
            self.send_json(400, {'error': {'code': 'INVALID_REQUEST', 'message': 'Send a member, an action and, to book, an offer and kWh.'}})
            return
        body = self.offers_section()
        if body is None:
            return
        try:
            member = offers.act(body['discountWindows'], request.get('member'), request.get('action'),
                                request.get('offerId'), request.get('kwh'))
        except ValueError as error:
            self.send_json(409, {'error': {'code': 'OFFER_UNAVAILABLE', 'message': str(error)}})
            return
        self.send_json(200, {'status': 'ready', 'member': member})

    def offers_estimate(self, query):
        """Impact page calculator: an illustrative month of discount windows for one site."""
        values, errors = offers.parse_calculator({key: value[0] for key, value in query.items()})
        if errors:
            self.send_json(400, {'error': {'code': 'INVALID_REQUEST', 'message': 'Check the highlighted inputs.', 'fields': errors}})
            return
        result = business.ready()  # never starts a build: without a finished replay only the site caps sessions
        known = ((result or {}).get('discountWindows') or {}).get('calculator', {}).get('capacity', {}).get('eligibleWindowsPerMonth')
        self.send_json(200, offers.calculate(**values, eligible_windows=known))

    def impact_day(self, query):
        """The Dashboard's fleet + grid battery plan for each half-hour of a replayed day (backend/dayplan.py),
        for the Battery and EV pages: ?date=YYYY-MM-DD&capacityMw=&preset= (a fleet preset id)."""
        try:
            capacity = float(query.get('capacityMw', ['100'])[0])
            number(capacity, 'capacity', minimum=0.001, maximum=10000)
            preset = query.get('preset', [DAY_PLAN_PRESET])[0]
            fleet = fleets.preset(preset)
            requested = query.get('date', [None])[0]
            day = date.fromisoformat(requested) if requested else default_replay_day()
        except (ValueError, TypeError):
            self.send_json(400, {'error': {'code': 'INVALID_REQUEST', 'message': 'Use date YYYY-MM-DD, capacity 0.001-10000 MW, and a fleet preset from /api/v1/charging/presets.'}})
            return
        try:
            with user_replay():
                status, body = 200, dayplan.build(fetch_day_replay(day, capacity), fleet, preset)
        except Busy:
            self.send_json(503, {'error': {'code': 'MODEL_BUSY', 'message': 'The model is busy with other replays; retry shortly.'}},
                           {'Retry-After': str(Busy.retry_after)})
            return
        except DateOutOfRange as error:
            status, body = 400, {'error': {'code': 'DATE_OUT_OF_RANGE', 'message': str(error)}}
        except (URLError, TimeoutError, OSError, HTTPException, ValueError, KeyError, TypeError, OverflowError):
            status, body = 200, dayplan.build(demo_day_replay(day, capacity), fleet, preset)
            body['dataMode'] = 'simulated'
        if status == 200 and body.get('dataMode') != 'simulated':
            try:
                schedule_prefetch(day, capacity)
            except Exception:  # prefetch is only an optimisation
                pass
        try:
            self.send_json(status, body)
        except (ConnectionError, TimeoutError):
            pass  # the browser moved on (e.g. picked another day); the replay stays cached

    def explorer(self, route):
        """Forecast page: model info and predictions for dataset dates of V1 (30/60 min) and V2 (daily)."""
        query = {k: v[0] for k, v in parse_qs(route.query).items()}
        try:
            name = route.path.removeprefix('/api/v1/explorer/')
            if name == 'short-term/predict':
                capacity = float(query.get('capacityMw', '100'))
                number(capacity, 'capacity', minimum=0.001, maximum=10000)
                target = timestamp(query.get('target'))
                if target.minute not in (0, 30) or target.second or target.microsecond:
                    raise ValueError('Target must be a UTC half-hour')
                action = partial(explorer.short_term_predict, target.strftime('%Y-%m-%dT%H:%M:%SZ'), capacity)
            elif name == 'short-term/day':
                day = date.fromisoformat(query.get('date', '')).isoformat()
                horizon = int(query.get('horizon', '30'))
                if horizon not in (30, 60):
                    raise ValueError('Horizon must be 30 or 60')
                # Optional viewer identity so the replay gate can drop this viewer's superseded work.
                client = query.get('client')
                if client is not None and not (0 < len(client) <= 64):
                    raise ValueError('Invalid client')
                seq = int(query['seq']) if 'seq' in query else None
                action = partial(explorer.short_term_day, day, horizon, client, seq, query.get('prefetch') == '1')
            elif name == 'short-term/observed':
                action = partial(explorer.day_observed, date.fromisoformat(query.get('date', '')).isoformat())
            elif name in ('daily/predict', 'daily/week'):
                day = date.fromisoformat(query.get('date', '')).isoformat()
                action = partial({'daily/predict': explorer.daily_predict, 'daily/week': explorer.daily_week}[name], day)
            elif name == 'formulas':
                action = explorer.model_formulas  # About page: both models' fitted formulas
            elif name in ('short-term', 'daily'):
                action = explorer.short_term_info if name == 'short-term' else explorer.daily_info
            else:
                self.send_json(404, {'error': {'code': 'NOT_FOUND', 'message': 'Unknown API endpoint.'}})
                return
        except (ValueError, TypeError):
            self.send_json(400, {'error': {'code': 'INVALID_REQUEST', 'message': 'Use a dataset date (YYYY-MM-DD), a UTC half-hour target time and capacity 0.001-10000 MW.'}})
            return
        try:
            self.send_json(200, action())
        except Busy:
            self.send_json(503, {'error': {'code': 'MODEL_BUSY', 'message': 'The model is busy with other replays; retry shortly.'}},
                           {'Retry-After': str(Busy.retry_after)})
        except Superseded:
            self.send_json(409, {'error': {'code': 'SUPERSEDED', 'message': 'A newer request from this page replaced this one.'}})
        except LookupError as error:
            self.send_json(404, {'error': {'code': 'NOT_IN_DATASET', 'message': str(error.args[0] if error.args else error)}})
        except (URLError, TimeoutError, OSError, HTTPException, ValueError, KeyError, TypeError, OverflowError) as error:
            diagnosis = diagnose(error)
            self.send_json(502, {'error': {'code': diagnosis['code'], 'message': diagnosis['message'], 'detail': diagnosis['detail']}})

    def sources(self, route):
        """Wind & Solar page (issue #65): recorded wind/solar curtailment plus the experimental split forecast."""
        query = {k: v[0] for k, v in parse_qs(route.query).items()}
        try:
            name = route.path.removeprefix('/api/v1/sources/')
            if name == 'coverage':
                action = sources.page_coverage
            elif name == 'info':
                action = sources.split_info
            elif name == 'day':
                capacity = float(query.get('capacityMw', '100'))
                number(capacity, 'capacity', minimum=0.001, maximum=10000)
                action = partial(sources.day, date.fromisoformat(query.get('date', '')).isoformat(), capacity)
            elif name == 'month':
                month = query.get('month', '')
                date.fromisoformat(f'{month}-01')
                if len(month) != 7:
                    raise ValueError('Month must be YYYY-MM')
                action = partial(sources.month, month)
            else:
                self.send_json(404, {'error': {'code': 'NOT_FOUND', 'message': 'Unknown API endpoint.'}})
                return
        except (ValueError, TypeError):
            self.send_json(400, {'error': {'code': 'INVALID_REQUEST', 'message': 'Use a date (YYYY-MM-DD), a month (YYYY-MM) and capacity 0.001-10000 MW.'}})
            return
        try:
            self.send_json(200, action())
        except sources.OutOfRange as error:
            self.send_json(404, {'error': {'code': 'NOT_IN_DATASET', 'message': str(error.args[0] if error.args else error)}})
        except (URLError, TimeoutError, OSError, HTTPException, ValueError, KeyError, TypeError, OverflowError) as error:
            diagnosis = diagnose(error)
            self.send_json(502, {'error': {'code': diagnosis['code'], 'message': diagnosis['message'], 'detail': diagnosis['detail']}})

    def do_GET(self):
        route = urlsplit(self.path)
        if route.path in ('/api/v1/forecast', '/api/v1/scenario'):
            try:
                query = parse_qs(route.query)
                if query.get('region', ['Ireland']) != ['Ireland']:
                    raise ValueError('Only Ireland is supported')
                capacity = float(query.get('capacityMw', ['100'])[0])
                number(capacity, 'capacity', minimum=0.001, maximum=10000)
                total = float(query.get('totalDemandKwh', ['1000'])[0])
                flexible = float(query.get('flexibleDemandKwh', ['500'])[0])
                validate_demand(total, flexible)
                target = dashboard_target(query.get('target', [None])[0])
                mode = query.get('selection', ['predicted'])[0]
                if mode not in targets.MODES:
                    raise ValueError('Unknown selection mode')
                kwh_per_charge = float(query.get('kwhPerCharge', [DEFAULT_KWH_PER_CHARGE])[0])
                charger_kw = float(query.get('chargerKw', [DEFAULT_CHARGER_KW])[0])
                validate_ev(kwh_per_charge, charger_kw)
            except (ValueError, TypeError):
                self.send_json(400, {'error': {'code': 'INVALID_REQUEST', 'message': 'Use Ireland, capacity 0.001-10000 MW, demand 0-1000000000 kWh with flexible demand no greater than total demand, 1-200 kWh per charge, 1-400 kW per charger and an optional V1 dataset target half-hour.'}})
                return
            try:
                forecast = cached_forecast(capacity, target, refresh=True, mode=mode)
                if route.path == '/api/v1/scenario':
                    forecast['scenario'] = build_scenario(forecast, total, flexible, kwh_per_charge, charger_kw)
                self.send_json(200, forecast)
            except (URLError, TimeoutError, OSError):
                self.send_json(502, {'error': {'code': 'MODEL_UNAVAILABLE', 'message': 'Cannot reach the model API. Start GridToEv on port 8000, then retry.'}})
            except (ValueError, KeyError, TypeError, OverflowError):
                self.send_json(502, {'error': {'code': 'INVALID_MODEL_RESPONSE', 'message': 'The model returned an invalid forecast. Check the model service and retry.'}})
            return
        if route.path == '/api/v1/impact/day':
            self.impact_day(parse_qs(route.query))
            return
        if route.path == '/api/v1/business/impact':
            self.business_impact(parse_qs(route.query))
            return
        if route.path == '/api/v1/business/estimate':
            self.business_estimate(parse_qs(route.query))
            return
        if route.path == '/api/v1/business/offers':
            self.business_offers(parse_qs(route.query))
            return
        if route.path == '/api/v1/business/offers/estimate':
            self.offers_estimate(parse_qs(route.query))
            return

        if route.path == '/api/v1/about/example':
            self.send_json(200, worked_example())  # About page: the real formulas on fixed example inputs
            return
        if route.path.startswith('/api/v1/sources/'):
            self.sources(route)
            return
        if route.path.startswith('/api/v1/explorer/'):
            self.explorer(route)
            return
        if route.path == '/api/v1/charging/presets':
            data = fleets.presets()
            self.send_json(200, dict(schemaVersion=data['schemaVersion'], fixtureVersion=data['fixtureVersion'],
                                     provenance=data['provenance'], note=data['note'], presets=data['presets']))
            return
        if route.path == '/api/v1/health':
            probe = parse_qs(route.query).get('probe', ['true']) != ['false']
            self.send_json(200, health(probe))
            return
        if route.path.startswith('/api/'):
            self.send_json(404, {'error': {'code': 'NOT_FOUND', 'message': 'Unknown API endpoint.'}})
            return
        super().do_GET()


if __name__ == '__main__':
    port = int(os.environ.get('API_PORT', '8080'))
    server = ProductServer(('127.0.0.1', port), partial(Handler, directory=str(ROOT / 'frontend')))
    # print(f'Open http://127.0.0.1:{port} (model: {MODEL_URL})', flush=True)
    print(f"""
          ==========================
          Open http://127.0.0.1:{port} to start the application.
          ==========================
          (model: {MODEL_URL})
          if the model is unavailable, clearly labelled demo data will be used.
          """, flush=True)
    threading.Thread(target=keep_model_warm, name='model-warm', daemon=True).start()
    import sys
    if '--open-browser' in sys.argv:
        import webbrowser
        webbrowser.open(f'http://127.0.0.1:{port}')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
