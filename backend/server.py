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
from scenario import build_day, build_scenario, validate_demand
from demo import demo_payload
from http.client import HTTPException
from config import load_env
from chat import ChatError, ask_gemini, validate_request

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
    if [p['horizonMinutes'] for p in points] != [30, 60] or len({p['issuedAt'] for p in points}) != 1 or len({p['modelVersion'] for p in points}) != 1:
        raise ValueError('Forecast horizons must share an issue time and model')
    return dict(generatedAt=datetime.now(timezone.utc).isoformat(), source='grid-to-ev-model',
                dataMode='historical-prediction', region='Ireland', intervalMinutes=30,
                flexibleCapacityMw=capacity, modelVersion=points[0]['modelVersion'], predictions=points,
                fallback={'active': False, 'reason': None})


# Fixed historical issue time used for demos (must be within the dataset range)
ISSUE_TIMESTAMP = os.environ.get('GRID_TO_EV_ISSUE_TIMESTAMP', '2026-01-10T00:00:00+00:00')


def post_prediction(capacity, horizon):
    headers = {'Accept': 'application/json', 'Content-Type': 'application/json'}
    key = os.environ.get('GRID_TO_EV_API_KEY')
    if key:
        headers['X-API-Key'] = key
    body = json.dumps({
        'issue_timestamp_utc': ISSUE_TIMESTAMP,
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


def fetch_forecast(capacity):
    rows = [post_prediction(capacity, horizon) for horizon in (30, 60)]
    return normalize({'predictions': rows}, capacity)


# A 24-hour window replay takes ~15 s upstream (well beyond the per-call TIMEOUT), and the
# hosted model serves requests one at a time, so allow for one queued replay ahead of it.
WINDOW_TIMEOUT = 90
# Days either side of a served day that are replayed in the background, nearest first,
# so stepping through the date picker is usually instant.
PREFETCH_DAYS = 3
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


def fetch_day_replay(day, capacity):
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
        replay = _replay_day(day, capacity)
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


def neighbour_days(day, first, last, span=None):
    """Days within span (default PREFETCH_DAYS) of day, nearest first (+1, -1, +2, ...), clipped to the dataset."""
    span = PREFETCH_DAYS if span is None else span
    offsets = [sign * n for n in range(1, span + 1) for sign in (1, -1)]
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
            fetch_day_replay(date.fromisoformat(day), capacity)
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


def default_replay_day():
    return timestamp(ISSUE_TIMESTAMP).date()


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


def available_forecast(capacity):
    """Always try the model, then use validated demo data for upstream failures."""
    started = time.monotonic()
    try:
        forecast = fetch_forecast(capacity)
    except (URLError, TimeoutError, OSError, HTTPException, ValueError, KeyError, TypeError, OverflowError) as error:
        reason = record_model_status(started, error=error)['fallbackReason']
    else:
        record_model_status(started, forecast['modelVersion'])
        return forecast
    forecast = normalize(demo_payload(capacity), capacity)
    forecast.update(source='local-demo-fixture', dataMode='simulated',
                    fallback={'active': True, 'reason': reason})
    return forecast

def health(probe=True):
    """Backend status plus why the model is (un)available. Never exposes the URL or key."""
    if probe:
        available_forecast(1)
    with model_status_lock:
        model = dict(model_status)
    host = urlsplit(MODEL_URL).hostname or ''
    model.update(target='local' if host in ('127.0.0.1', 'localhost', '::1') else 'hosted',
                 apiKeyConfigured=bool(os.environ.get('GRID_TO_EV_API_KEY')), timeoutSeconds=TIMEOUT)
    mode = {'up': 'live', 'down': 'fallback'}.get(model['state'], 'unknown')
    return dict(status='ok' if mode == 'live' else 'degraded', checkedAt=datetime.now(timezone.utc).isoformat(),
                backend={'status': 'ok'}, mode=mode, fallbackAvailable=True, model=model)


class ProductServer(ThreadingHTTPServer):
    # Windows SO_REUSEADDR permits two servers to bind the same address, routing
    # requests to an obsolete process. Require one owner of the listening port.
    allow_reuse_address = os.name != 'nt'

    def server_bind(self):
        if os.name == 'nt':
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()

class Handler(SimpleHTTPRequestHandler):
    def send_json(self, status, body):
        encoded = json.dumps(body, allow_nan=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_POST(self):
        if urlsplit(self.path).path != '/api/v1/chat':
            self.send_json(404, {'error': {'code': 'NOT_FOUND', 'message': 'Unknown API endpoint.'}})
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 64_000:
                raise ValueError('Invalid body size')
            messages, page, context = validate_request(json.loads(self.rfile.read(length)))
        except (ValueError, TypeError):
            self.send_json(400, {'error': {'code': 'INVALID_REQUEST', 'message': 'Send a short question (up to 1000 characters).'}})
            return
        try:
            self.send_json(200, {'reply': ask_gemini(messages, page, context)})
        except ChatError as error:
            self.send_json(error.status, {'error': {'code': error.code, 'message': error.message}})
        except HTTPError as error:
            print(f'Gemini error {error.code}: {error.read().decode(errors="replace")[:500]}', flush=True)
            code = 'CHAT_RATE_LIMITED' if error.code == 429 else 'CHAT_UPSTREAM_ERROR'
            message = 'Volt is busy right now. Wait a moment and try again.' if error.code == 429 else 'The AI service rejected the request. Check GEMINI_API_KEY and GEMINI_MODEL.'
            self.send_json(502, {'error': {'code': code, 'message': message}})
        except (URLError, TimeoutError, OSError, HTTPException, ValueError):
            self.send_json(502, {'error': {'code': 'CHAT_UNAVAILABLE', 'message': 'Cannot reach the AI service. Check your connection and retry.'}})

    def impact_day(self, query):
        try:
            capacity = float(query.get('capacityMw', ['100'])[0])
            number(capacity, 'capacity', minimum=0.001, maximum=10000)
            total = float(query.get('totalDemandKwh', ['1000'])[0])
            flexible = float(query.get('flexibleDemandKwh', ['500'])[0])
            validate_demand(total, flexible)
            requested = query.get('date', [None])[0]
            day = date.fromisoformat(requested) if requested else default_replay_day()
        except (ValueError, TypeError):
            self.send_json(400, {'error': {'code': 'INVALID_REQUEST', 'message': 'Use date YYYY-MM-DD, capacity 0.001-10000 MW, and demand 0-1000000000 kWh with flexible demand no greater than total demand.'}})
            return
        try:
            with user_replay():
                status, body = 200, build_day(fetch_day_replay(day, capacity), total, flexible)
        except DateOutOfRange as error:
            status, body = 400, {'error': {'code': 'DATE_OUT_OF_RANGE', 'message': str(error)}}
        except (URLError, TimeoutError, OSError, HTTPException):
            status, body = 502, {'error': {'code': 'MODEL_UNAVAILABLE', 'message': 'Cannot reach the model for the day replay. Retry shortly.'}}
        except (ValueError, KeyError, TypeError, OverflowError):
            status, body = 502, {'error': {'code': 'INVALID_MODEL_RESPONSE', 'message': 'The model returned an invalid day replay.'}}
        if status == 200:
            try:
                schedule_prefetch(day, capacity)
            except Exception:  # prefetch is only an optimisation
                pass
        try:
            self.send_json(status, body)
        except (ConnectionError, TimeoutError):
            pass  # the browser moved on (e.g. picked another day); the replay stays cached

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
            except (ValueError, TypeError):
                self.send_json(400, {'error': {'code': 'INVALID_REQUEST', 'message': 'Use Ireland, capacity 0.001-10000 MW, and demand 0-1000000000 kWh with flexible demand no greater than total demand.'}})
                return
            try:
                forecast = available_forecast(capacity)
                if route.path == '/api/v1/scenario':
                    forecast['scenario'] = build_scenario(forecast, total, flexible)
                self.send_json(200, forecast)
            except (URLError, TimeoutError, OSError):
                self.send_json(502, {'error': {'code': 'MODEL_UNAVAILABLE', 'message': 'Cannot reach the model API. Start GridToEv on port 8000, then retry.'}})
            except (ValueError, KeyError, TypeError, OverflowError):
                self.send_json(502, {'error': {'code': 'INVALID_MODEL_RESPONSE', 'message': 'The model returned an invalid forecast. Check the model service and retry.'}})
            return
        if route.path == '/api/v1/impact/day':
            self.impact_day(parse_qs(route.query))
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
