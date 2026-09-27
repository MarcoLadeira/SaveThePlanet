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
from scenario import build_scenario, validate_demand
from demo import demo_payload
from http.client import HTTPException
from config import load_env
import chat
import explorer
import synthetic
import targets

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


def normalize(payload, capacity):
    rows = payload['predictions']
    if not isinstance(rows, list) or len(rows) != 2:
        raise ValueError('Expected both forecast horizons')
    points = []
    for row in rows:
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
        points.append(dict(horizonMinutes=int(horizon), issuedAt=issued.isoformat(), targetAt=target.isoformat(),
                           modelVersion=version, probability=number(row['dispatch_down_probability'], 'probability', maximum=1),
                           risk=risk, atRiskMwh=total, curtailmentMwh=curtailment, constraintMwh=constraint,
                           lowerMwh=lower, medianMwh=median, upperMwh=upper, potentialRecoveryMwh=recovered))
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
# predicts to have extra dispatch-down (see targets.py); TARGET_TIMESTAMP, the dataset's
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


def available_forecast(capacity, target=None):
    """Always try the model, then use validated demo data for upstream failures.

    Without a target, a random dataset target predicted to have extra dispatch-down is chosen.
    """
    started = time.monotonic()
    try:
        forecast = fetch_forecast(capacity, target) if target else targets.pick(capacity, fetch_forecast)
    except (URLError, TimeoutError, OSError, HTTPException, ValueError, KeyError, TypeError, OverflowError) as error:
        reason = record_model_status(started, error=error)['fallbackReason']
    else:
        record_model_status(started, forecast['modelVersion'])
        return forecast
    forecast = normalize(demo_payload(capacity, datetime.now(timezone.utc)), capacity)
    forecast.update(source='local-demo-fixture', dataMode='simulated',
                    fallback={'active': True, 'reason': reason})
    return forecast

FORECAST_CACHE_SECONDS = 300
forecast_cache_lock = threading.Lock()
forecast_cache = {}


def cached_forecast(capacity, target=None, refresh=False):
    """Forecast shared by the pages and Volt, so both quote the same validated figures.

    The pages send back the target they were given, so a random target stays fixed across
    live refreshes and Volt answers about the same half-hour. No target picks a new one.
    """
    now = time.monotonic()
    with forecast_cache_lock:
        hit = forecast_cache.get((capacity, target)) if target else None
        if hit and not refresh and now - hit[0] < FORECAST_CACHE_SECONDS:
            return json.loads(json.dumps(hit[1]))
    forecast = available_forecast(capacity, target)
    if forecast['dataMode'] != 'simulated':
        with forecast_cache_lock:
            forecast_cache[(capacity, forecast['targetAt'].replace('+00:00', 'Z'))] = (now, forecast)
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
            capacity = float(options.get('capacityMw', 100))
            number(capacity, 'capacity', minimum=0.001, maximum=10000)
            if horizon not in (30, 60) or isinstance(horizon, bool) or scenario not in synthetic.SCENARIOS:
                raise ValueError('Invalid options')
        except (ValueError, TypeError):
            self.send_json(400, {'error': {'code': 'INVALID_REQUEST', 'message': 'Use horizon 30 or 60, scenario "ordinary" or "high-curtailment", and capacity 0.001-10000 MW.'}})
            return
        try:
            self.send_json(200, synthetic.run(horizon, scenario, capacity))
        except (URLError, TimeoutError, OSError, HTTPException, ValueError, KeyError, TypeError, OverflowError) as error:
            diagnosis = diagnose(error)
            self.send_json(502, {'error': {'code': diagnosis['code'], 'message': diagnosis['message'], 'detail': diagnosis['detail']}})

    def do_POST(self):
        if urlsplit(self.path).path == '/api/v1/synthetic-v1':
            self.synthetic_v1()
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
        self.send_json(200, {'reply': chat.answer(messages, page, horizon, forecast, scenario)})

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
                action = partial(explorer.short_term_day, day, horizon)
            elif name == 'short-term/observed':
                action = partial(explorer.day_observed, date.fromisoformat(query.get('date', '')).isoformat())
            elif name in ('daily/predict', 'daily/week'):
                day = date.fromisoformat(query.get('date', '')).isoformat()
                action = partial({'daily/predict': explorer.daily_predict, 'daily/week': explorer.daily_week}[name], day)
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
        except LookupError as error:
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
            except (ValueError, TypeError):
                self.send_json(400, {'error': {'code': 'INVALID_REQUEST', 'message': 'Use Ireland, capacity 0.001-10000 MW, demand 0-1000000000 kWh with flexible demand no greater than total demand, and an optional V1 dataset target half-hour.'}})
                return
            try:
                forecast = cached_forecast(capacity, target, refresh=True)
                if route.path == '/api/v1/scenario':
                    forecast['scenario'] = build_scenario(forecast, total, flexible)
                self.send_json(200, forecast)
            except (URLError, TimeoutError, OSError):
                self.send_json(502, {'error': {'code': 'MODEL_UNAVAILABLE', 'message': 'Cannot reach the model API. Start GridToEv on port 8000, then retry.'}})
            except (ValueError, KeyError, TypeError, OverflowError):
                self.send_json(502, {'error': {'code': 'INVALID_MODEL_RESPONSE', 'message': 'The model returned an invalid forecast. Check the model service and retry.'}})
            return
        if route.path.startswith('/api/v1/explorer/'):
            self.explorer(route)
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

    def warm_targets():
        # Build the high-MWh target shortlist (~7 s) before the first page asks for it.
        try:
            targets.candidates()
        except (URLError, TimeoutError, OSError, HTTPException, ValueError, KeyError, TypeError):
            pass  # the first request retries; the page falls back to demo data if the model is down
    threading.Thread(target=warm_targets, daemon=True).start()
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
