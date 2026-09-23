from functools import partial
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import sys
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import Handler, normalize


def sample():
    return {'predictions': [dict(model_version='test', issue_timestamp_utc='2026-01-31T22:00:00Z',
        target_timestamp_utc=f'2026-01-31T{target}:00Z', forecast_horizon_minutes=horizon,
        dispatch_down_probability=.8, risk_level='high', predicted_dispatch_down_mwh=42,
        predicted_curtailment_mwh=12, predicted_constraint_mwh=30, prediction_interval_p10_mwh=20,
        prediction_interval_p50_mwh=40, prediction_interval_p90_mwh=60,
        flexible_load_capacity_mw=100, recoverable_surplus_mwh=42)
        for horizon, target in [(30, '22:30'), (60, '23:00')]]}


class ContractTests(unittest.TestCase):
    def test_maps_both_horizons_and_provenance(self):
        result = normalize(sample(), 100)
        self.assertEqual(result['dataMode'], 'historical-prediction')
        self.assertEqual([p['horizonMinutes'] for p in result['predictions']], [30, 60])
        self.assertEqual(result['predictions'][0]['potentialRecoveryMwh'], 42)

    def test_rejects_invalid_model_data(self):
        cases = [('dispatch_down_probability', 2), ('predicted_dispatch_down_mwh', float('nan')),
                 ('recoverable_surplus_mwh', 100), ('flexible_load_capacity_mw', .1),
                 ('prediction_interval_p10_mwh', 90), ('issue_timestamp_utc', '2026-01-31T22:00:00'),
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
        fetch.assert_called_once_with(100)
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
            fetch.side_effect = error
            status, body = self.get('/api/v1/forecast')
            self.assertEqual(status, 502)
            self.assertEqual(body['error']['code'], code)


if __name__ == '__main__':
    unittest.main()

