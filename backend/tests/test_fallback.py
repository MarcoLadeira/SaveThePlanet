import io
import json
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError
from http.client import IncompleteRead
import test_server as support
from server import available_forecast, normalize
from demo import demo_payload
from scenario import build_scenario


class FallbackTests(unittest.TestCase):
    def test_fixture_uses_normal_contract_and_is_repeatable(self):
        for capacity in (.001, .1, 100, 10000):
            first = normalize(demo_payload(capacity), capacity)
            second = normalize(demo_payload(capacity), capacity)
            first.pop('generatedAt'); second.pop('generatedAt')
            self.assertEqual(first, second)
            for p in first['predictions']:
                self.assertLessEqual(p['potentialRecoveryMwh'], capacity * .5)
                self.assertAlmostEqual(p['atRiskMwh'], p['curtailmentMwh'] + p['constraintMwh'])

    @patch('server.urlopen')
    def test_real_adapter_failures_use_demo(self, open_url):
        failures = [URLError('offline'), TimeoutError(), HTTPError('http://model', 503, 'down', {}, None),
                    IncompleteRead(b'incomplete')]
        for failure in failures:
            with self.subTest(failure=type(failure).__name__):
                open_url.side_effect = failure
                result = available_forecast(100)
                self.assertEqual(result['fallback'], {'active': True, 'reason': 'MODEL_UNAVAILABLE'})
                self.assertEqual(result['source'], 'local-demo-fixture')
        open_url.side_effect = None
        for raw in (b'not json', b'{}', b'{"predictions": []}', b'null', b'[]'):
            with self.subTest(raw=raw):
                open_url.return_value.__enter__.return_value = io.BytesIO(raw)
                self.assertEqual(available_forecast(100)['fallback']['reason'], 'INVALID_MODEL_RESPONSE')

    @patch('server.fetch_forecast')
    def test_fallback_preserves_inputs_and_recovers(self, fetch):
        fetch.side_effect = TimeoutError()
        fallback = available_forecast(.1)
        derived = build_scenario(fallback, 100, 20)
        self.assertEqual(derived['dataMode'], 'simulated')
        self.assertEqual(derived['flexibleDemandKwh'], 20)
        self.assertEqual(derived['outcomes'][0]['potentialRecoveryMwh'], .02)
        self.assertEqual(derived['id'], build_scenario(available_forecast(.1), 100, 20)['id'])
        fetch.side_effect = None
        fetch.return_value = normalize(support.sample(), 100)
        live = available_forecast(100)
        self.assertFalse(live['fallback']['active'])
        self.assertEqual(live['source'], 'grid-to-ev-model')
        self.assertEqual(build_scenario(live, 100, 20)['dataMode'], 'derived-scenario')


class FallbackHttpTests(unittest.TestCase):
    setUpClass = classmethod(support.HttpTests.setUpClass.__func__)
    tearDownClass = classmethod(support.HttpTests.tearDownClass.__func__)
    get = support.HttpTests.get

    @patch('server.fetch_forecast', side_effect=TimeoutError())
    def test_both_routes_return_labelled_success(self, fetch):
        for route in ('forecast', 'scenario'):
            status, body = self.get(f'/api/v1/{route}?capacityMw=0.1&totalDemandKwh=100&flexibleDemandKwh=20')
            self.assertEqual(status, 200)
            self.assertTrue(body['fallback']['active'])
            self.assertEqual(body['dataMode'], 'simulated')
            if route == 'scenario':
                self.assertEqual(body['scenario']['outcomes'][0]['potentialRecoveryMwh'], .02)
                self.assertEqual(body['scenario']['dataMode'], 'simulated')

    @patch('server.fetch_forecast')
    def test_invalid_input_still_errors(self, fetch):
        self.assertEqual(self.get('/api/v1/scenario?region=UK')[0], 400)
        self.assertEqual(self.get('/api/v1/scenario?totalDemandKwh=1&flexibleDemandKwh=2')[0], 400)
        fetch.assert_not_called()
