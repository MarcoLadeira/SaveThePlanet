from functools import partial
import io
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import sys
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server
from server import Handler, normalize


FIXED_TARGET = '2026-01-31T23:00:00Z'
_hermetic = []


def start_hermetic_targets():
    """Replace the random-target shortlist with one fixed target so tests never call the model."""
    _hermetic[:] = [patch('targets.dataset_targets', return_value=[FIXED_TARGET]),
                    patch('targets.is_dataset_target', side_effect=lambda target: target == FIXED_TARGET)]
    for patcher in _hermetic:
        patcher.start()


def stop_hermetic_targets():
    for patcher in _hermetic:
        patcher.stop()


setUpModule, tearDownModule = start_hermetic_targets, stop_hermetic_targets


def sample():
    # Latest dataset target: +30 min issued 22:30 and +60 min issued 22:00 both predict 23:00.
    return {'predictions': [dict(model_version='test', issue_timestamp_utc=f'2026-01-31T{issued}:00Z',
        target_timestamp_utc='2026-01-31T23:00:00Z', forecast_horizon_minutes=horizon,
        dispatch_down_probability=.8, risk_level='high', predicted_dispatch_down_mwh=42,
        predicted_curtailment_mwh=12, predicted_constraint_mwh=30, prediction_interval_p10_mwh=20,
        prediction_interval_p50_mwh=40, prediction_interval_p90_mwh=60,
        flexible_load_capacity_mw=100, recoverable_surplus_mwh=42)
        for horizon, issued in [(30, '22:30'), (60, '22:00')]]}


class ContractTests(unittest.TestCase):
    def test_maps_both_horizons_and_provenance(self):
        result = normalize(sample(), 100)
        self.assertEqual(result['dataMode'], 'historical-prediction')
        self.assertEqual([p['horizonMinutes'] for p in result['predictions']], [30, 60])
        self.assertEqual(result['predictions'][0]['potentialRecoveryMwh'], 42)

    def test_rejects_invalid_model_data(self):
        cases = [('dispatch_down_probability', 2), ('predicted_dispatch_down_mwh', float('nan')),
                 ('recoverable_surplus_mwh', 100), ('flexible_load_capacity_mw', .1),
                 ('prediction_interval_p10_mwh', 90), ('issue_timestamp_utc', '2026-01-31T22:30:00'),
                 ('forecast_horizon_minutes', 24)]
        for key, value in cases:
            with self.subTest(key=key):
                payload = sample()
                payload['predictions'][0][key] = value
                with self.assertRaises(ValueError):
                    normalize(payload, 100)
        for payload in ({'predictions': []}, {'predictions': [sample()['predictions'][0]] * 2}):
            with self.assertRaises(ValueError):
                normalize(payload, 100)

    def test_horizons_must_share_the_target_and_are_labelled_historical(self):
        result = normalize(sample(), 100)
        self.assertEqual(result['targetAt'], '2026-01-31T23:00:00+00:00')
        self.assertEqual([p['issuedAt'] for p in result['predictions']], ['2026-01-31T22:30:00+00:00', '2026-01-31T22:00:00+00:00'])
        self.assertEqual((result['dataLabel'], result['live']), ('Historical dataset prediction', False))
        payload = sample()
        payload['predictions'][1].update(issue_timestamp_utc='2026-01-31T22:30:00Z', target_timestamp_utc='2026-01-31T23:30:00Z')
        with self.assertRaises(ValueError):
            normalize(payload, 100)

    def test_requests_latest_dataset_target_from_each_horizons_issue_time(self):
        sent = []

        class Response(io.BytesIO):
            def __enter__(self): return self
            def __exit__(self, *args): return False

        def fake_urlopen(request, timeout):
            body = json.loads(request.data)
            sent.append((request.full_url, body, request.get_header('X-api-key')))
            return Response(json.dumps(next(r for r in sample()['predictions']
                                            if r['forecast_horizon_minutes'] == body['forecast_horizon_minutes'])).encode())
        with patch('server.urlopen', fake_urlopen), patch.dict('os.environ', {'GRID_TO_EV_API_KEY': 'team-key'}):
            server.fetch_forecast(100)
        self.assertEqual([(url.endswith('/predict/from-dataset'), body['issue_timestamp_utc'], body['forecast_horizon_minutes'], key)
                          for url, body, key in sent],
                         [(True, '2026-01-31T22:30:00Z', 30, 'team-key'), (True, '2026-01-31T22:00:00Z', 60, 'team-key')])

    def test_demo_fallback_also_shares_one_target(self):
        from datetime import datetime, timezone
        from demo import demo_payload
        for now in (None, datetime(2026, 9, 27, 17, 5, 20, tzinfo=timezone.utc)):
            with self.subTest(now=now):
                result = normalize(demo_payload(100, now), 100)
                self.assertEqual(len({p['targetAt'] for p in result['predictions']}), 1)

    def test_zero_energy_and_capacity_bound(self):
        payload = sample()
        for row in payload['predictions']:
            row.update(flexible_load_capacity_mw=.1, recoverable_surplus_mwh=.05)
        self.assertEqual(normalize(payload, .1)['predictions'][0]['potentialRecoveryMwh'], .05)
        for row in payload['predictions']:
            row.update(predicted_dispatch_down_mwh=0, predicted_curtailment_mwh=0,
                       predicted_constraint_mwh=0, recoverable_surplus_mwh=0)
        self.assertEqual(normalize(payload, .1)['predictions'][0]['atRiskMwh'], 0)


class HttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory='frontend'))
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f'http://127.0.0.1:{cls.server.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def get(self, path):
        try:
            with urlopen(self.url + path) as response:
                return response.status, json.load(response)
        except HTTPError as error:
            return error.code, json.load(error)

    @patch('server.fetch_forecast')
    def test_capacity_forwarded(self, fetch):
        fetch.return_value = normalize(sample(), 100)
        status, body = self.get('/api/v1/forecast?region=Ireland&capacityMw=100')
        self.assertEqual(status, 200)
        fetch.assert_called_once_with(100, FIXED_TARGET)  # random pick from the (fixed) shortlist
        self.assertEqual(body['region'], 'Ireland')

    @patch('server.fetch_forecast')
    def test_invalid_request_does_not_call_model(self, fetch):
        for query in ('region=UK', 'capacityMw=nan', 'capacityMw=0', 'capacityMw=10001'):
            self.assertEqual(self.get('/api/v1/forecast?' + query)[0], 400)
        fetch.assert_not_called()

    @patch('server.fetch_forecast')
    def test_upstream_failures(self, fetch):
        for error, code in [(TimeoutError(), 'MODEL_UNAVAILABLE'), (ValueError(), 'INVALID_MODEL_RESPONSE'),
                            (KeyError(), 'INVALID_MODEL_RESPONSE')]:
            server.forecast_cache.clear()
            fetch.side_effect = error
            status, body = self.get('/api/v1/forecast')
            self.assertEqual(status, 200)
            self.assertEqual(body['fallback']['reason'], code)
            self.assertEqual(body['dataMode'], 'simulated')


class LastGoodForecastTests(unittest.TestCase):
    def setUp(self):
        server.forecast_cache.clear()

    @patch('server.fetch_forecast')
    def test_brief_outage_keeps_the_pinned_targets_last_real_forecast(self, fetch):
        fetch.return_value = normalize(sample(), 100)
        live = server.cached_forecast(100, FIXED_TARGET, refresh=True)
        fetch.side_effect = TimeoutError()
        kept = server.cached_forecast(100, FIXED_TARGET, refresh=True)
        self.assertEqual(kept['predictions'], live['predictions'])
        self.assertEqual(kept['stale']['reason'], 'MODEL_UNAVAILABLE')  # shown as last real, not as fresh
        with patch('server.time.monotonic', return_value=server.time.monotonic() + server.STALE_FORECAST_SECONDS + 1):
            self.assertTrue(server.cached_forecast(100, FIXED_TARGET, refresh=True)['fallback']['active'])


def forecast_for(target, mwh=42):
    """A normalized real forecast for any target half-hour (both horizons)."""
    moment = server.timestamp(target)
    rows = []
    for horizon in (30, 60):
        issued = (moment - server.timedelta(minutes=horizon)).strftime('%Y-%m-%dT%H:%M:%SZ')
        rows.append(dict(sample()['predictions'][0], issue_timestamp_utc=issued, target_timestamp_utc=target,
                         forecast_horizon_minutes=horizon, predicted_dispatch_down_mwh=mwh, predicted_curtailment_mwh=12,
                         predicted_constraint_mwh=mwh - 12, recoverable_surplus_mwh=min(mwh, 50)))
    return normalize({'predictions': rows}, 100)


class TargetPinningTests(unittest.TestCase):
    """A -> B -> outage -> recovery: every consumer stays on the pinned target (review P0.4)."""
    A, B = '2026-01-11T21:30:00Z', '2026-01-26T07:30:00Z'

    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory='frontend'))
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f'http://127.0.0.1:{cls.server.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def setUp(self):
        server.forecast_cache.clear()
        for patcher in (patch('targets.dataset_targets', return_value=[self.A, self.B]),
                        patch('targets.is_dataset_target', side_effect=lambda t: t in (self.A, self.B)),
                        patch('server.fetch_forecast', side_effect=self.fake_model)):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.model_up = True

    def fake_model(self, capacity, target):
        if not self.model_up:
            raise TimeoutError()
        return forecast_for(target)

    def get(self, path):
        try:
            with urlopen(self.url + path) as response:
                return json.load(response)
        except HTTPError as error:
            return json.load(error)

    def chat(self, target):
        body = json.dumps({'messages': [{'role': 'user', 'text': 'How much energy is at risk?'}], 'target': target}).encode()
        request = Request(self.url + '/api/v1/chat', data=body, headers={'Content-Type': 'application/json'}, method='POST')
        with patch.dict('os.environ', {'GEMINI_API_KEY': ''}), urlopen(request) as response:
            return json.load(response)['reply']['provenance']

    def test_a_then_b_then_outage_then_recovery(self):
        a = self.get(f'/api/v1/scenario?target={self.A}')
        self.assertEqual((a['pinnedTarget'], a['stale']), (self.A, None))
        b = self.get(f'/api/v1/scenario?target={self.B}')
        self.assertEqual(b['pinnedTarget'], self.B)

        self.model_up = False
        # Dashboard, Charging and Impact cards (all /api/v1/scenario) stay on B, marked stale.
        during = self.get(f'/api/v1/scenario?target={self.B}')
        self.assertEqual((during['pinnedTarget'], during['predictions'][0]['targetAt'][:16]), (self.B, self.B[:16]))
        self.assertIsNotNone(during['stale'])
        self.assertNotEqual(during['pinnedTarget'], self.A)
        # Volt answers about the same pinned half-hour and says the result is the last real one.
        volt = self.chat(self.B)
        self.assertEqual(volt['targetAt'][:16], self.B[:16])
        self.assertTrue(volt['stale'])
        # A new (untargeted) request during the outage never borrows A or B: it is an offline example.
        fresh = self.get('/api/v1/scenario')
        self.assertEqual(fresh['dataMode'], 'simulated')
        self.assertIsNone(fresh['fallback']['requestedTarget'])
        self.assertNotIn(fresh['predictions'][0]['targetAt'][:16], (self.A[:16], self.B[:16]))

        self.model_up = True
        after = self.get(f'/api/v1/scenario?target={self.B}')
        self.assertEqual((after['pinnedTarget'], after['stale'], after['dataMode']), (self.B, None, 'historical-prediction'))

    def test_pinned_target_without_a_real_forecast_gets_a_labelled_offline_example(self):
        self.model_up = False
        body = self.get(f'/api/v1/scenario?target={self.A}')
        self.assertEqual(body['dataMode'], 'simulated')
        self.assertEqual((body['pinnedTarget'], body['fallback']['requestedTarget']), (self.A, self.A))
        self.assertEqual(body['dataLabel'], 'Offline example (simulated)')

if __name__ == '__main__':
    unittest.main()


class PortOwnershipTests(unittest.TestCase):
    @unittest.skipUnless(sys.platform == 'win32', 'Windows exclusive port ownership')
    def test_second_backend_cannot_bind_same_port(self):
        from server import ProductServer
        first = ProductServer(('127.0.0.1', 0), Handler)
        try:
            with self.assertRaises(OSError):
                second = ProductServer(first.server_address, Handler)
                second.server_close()
        finally:
            first.server_close()
