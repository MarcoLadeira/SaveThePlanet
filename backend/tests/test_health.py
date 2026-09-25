import io
import os
import socket
import unittest
from http.client import IncompleteRead
from unittest.mock import patch
from urllib.error import HTTPError, URLError
import test_server as support
import server
from server import diagnose, normalize


def http_error(code, body=b''):
    return HTTPError('http://model', code, 'error', {}, io.BytesIO(body))


class DiagnoseTests(unittest.TestCase):
    def test_network_failures_are_explained(self):
        cases = [(URLError(ConnectionRefusedError()), 'MODEL_CONNECTION_REFUSED'),
                 (URLError(socket.gaierror()), 'MODEL_DNS_FAILURE'),
                 (URLError(TimeoutError()), 'MODEL_TIMEOUT'), (TimeoutError(), 'MODEL_TIMEOUT'),
                 (URLError('offline'), 'MODEL_UNREACHABLE'),
                 (IncompleteRead(b''), 'MODEL_INCOMPLETE_RESPONSE')]
        for error, code in cases:
            with self.subTest(code=code):
                result = diagnose(error)
                self.assertEqual(result['code'], code)
                self.assertEqual(result['fallbackReason'], 'MODEL_UNAVAILABLE')

    def test_http_failures_include_status_and_upstream_detail(self):
        for status, code in [(401, 'MODEL_AUTH_FAILED'), (403, 'MODEL_AUTH_FAILED'), (404, 'MODEL_ENDPOINT_NOT_FOUND'),
                             (422, 'MODEL_REJECTED_REQUEST'), (429, 'MODEL_RATE_LIMITED'),
                             (503, 'MODEL_SERVER_ERROR'), (418, 'MODEL_HTTP_ERROR')]:
            with self.subTest(status=status):
                result = diagnose(http_error(status, b'{"detail": "timestamp outside dataset"}'))
                self.assertEqual((result['code'], result['httpStatus']), (code, status))
                self.assertEqual(result['detail'], 'timestamp outside dataset')
        validation = diagnose(http_error(422, b'{"detail": [{"msg": "field required"}, {"msg": "bad horizon"}]}'))
        self.assertEqual(validation['detail'], 'field required; bad horizon')
        self.assertIsNone(diagnose(http_error(500, b'<html>oops</html>'))['detail'])

    def test_invalid_response_keeps_validation_reason(self):
        result = diagnose(ValueError('Inconsistent recoverable energy'))
        self.assertEqual((result['code'], result['fallbackReason']), ('INVALID_MODEL_RESPONSE', 'INVALID_MODEL_RESPONSE'))
        self.assertEqual(result['detail'], 'Inconsistent recoverable energy')
        self.assertIn('risk_level', diagnose(KeyError('risk_level'))['detail'])


class HealthHttpTests(unittest.TestCase):
    setUpClass = classmethod(support.HttpTests.setUpClass.__func__)
    tearDownClass = classmethod(support.HttpTests.tearDownClass.__func__)
    get = support.HttpTests.get

    @patch.dict(os.environ, {'GRID_TO_EV_API_KEY': 'super-secret-key'})
    @patch('server.fetch_forecast')
    def test_reports_live_then_down_with_reason(self, fetch):
        fetch.return_value = normalize(support.sample(), 100)
        status, body = self.get('/api/v1/health')
        self.assertEqual(status, 200)
        self.assertEqual((body['status'], body['mode'], body['model']['state']), ('ok', 'live', 'up'))
        self.assertEqual(body['model']['modelVersion'], 'test')
        self.assertIsNone(body['model']['error'])
        self.assertTrue(body['model']['apiKeyConfigured'])

        fetch.side_effect = http_error(401, b'{"detail": "Invalid API key"}')
        status, body = self.get('/api/v1/health')
        self.assertEqual((status, body['status'], body['mode']), (200, 'degraded', 'fallback'))
        self.assertEqual(body['model']['error']['code'], 'MODEL_AUTH_FAILED')
        self.assertEqual(body['model']['error']['httpStatus'], 401)
        self.assertEqual(body['model']['modelVersion'], 'test', 'last known version is kept')
        self.assertTrue(body['fallbackAvailable'])
        raw = str(body)
        self.assertNotIn('super-secret-key', raw)
        self.assertNotIn(server.MODEL_URL, raw)

    @patch('server.fetch_forecast', side_effect=URLError(ConnectionRefusedError()))
    def test_passive_health_reports_last_forecast_without_calling_model(self, fetch):
        self.assertTrue(self.get('/api/v1/scenario')[1]['fallback']['active'])
        fetch.reset_mock()
        status, body = self.get('/api/v1/health?probe=false')
        fetch.assert_not_called()
        self.assertEqual(body['model']['error']['code'], 'MODEL_CONNECTION_REFUSED')
        self.assertIsInstance(body['model']['latencyMs'], int)
