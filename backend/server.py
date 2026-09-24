"""Small product API and static frontend host. Run: python backend/server.py."""
from datetime import datetime, timezone
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import math
import os
import socket
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlsplit
from urllib.request import Request, urlopen
from scenario import build_scenario, validate_demand
from demo import demo_payload
from http.client import HTTPException
from config import load_env

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


# def fetch_forecast(capacity):
#     headers = {'Accept': 'application/json'}
#     key = os.environ.get('GRID_TO_EV_API_KEY')
#     if key:
#         headers['X-API-Key'] = key
#     request = Request(f'{MODEL_URL}/predict/latest?flexible_load_capacity_mw={capacity}', headers=headers)
#     with urlopen(request, timeout=TIMEOUT) as response:
#         return normalize(json.load(response), capacity)


def available_forecast(capacity):
    """Always try the model, then use validated demo data for upstream failures."""
    try:
        return fetch_forecast(capacity)
    except (URLError, TimeoutError, OSError, HTTPException):
        reason = 'MODEL_UNAVAILABLE'
    except (ValueError, KeyError, TypeError, OverflowError):
        reason = 'INVALID_MODEL_RESPONSE'
    forecast = normalize(demo_payload(capacity), capacity)
    forecast.update(source='local-demo-fixture', dataMode='simulated',
                    fallback={'active': True, 'reason': reason})
    return forecast

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
