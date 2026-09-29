"""Dashboard headline: the daily model (V2) for the dashboard's day. Hermetic: model calls are stubbed
with the real 11 Jan 2026 figures."""
from functools import partial
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import sys
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError
from urllib.request import urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import dayview
from server import Handler

INFO = {'model': {'version': '2.0.0-daily-experimental', 'experimental': True,
                  'test': {'rows': 242, 'dailyMaeMwh': 1723.39, 'zeroBaselineMaeMwh': 2310.37, 'rocAuc': 0.823, 'brierScore': 0.19}},
        'dataset': {'from': '2024-04-01', 'to': '2026-08-30'}}
PREDICTION = {'date': '2026-01-11', 'modelVersion': '2.0.0-daily-experimental', 'issuedAt': '2026-01-11T00:00:00+00:00',
              'weatherAvailableAt': '2026-01-10T23:00:00+00:00', 'probability': 0.9478, 'predictedMwh': 8962.79}
SPLIT = {'status': 'ok', 'windMwh': 8846.09, 'solarMwh': 116.69, 'windSharePercent': 98.7, 'solarSharePercent': 1.3,
         'version': '2.0.0-sources-experimental', 'capacity': {}}
RECORDED = {'status': 'available', 'windMwh': 6983.6, 'solarMwh': 27.09, 'windSharePercent': 99.61, 'solarSharePercent': 0.39}


def stubbed(split=SPLIT, recorded=RECORDED):
    def validate(value):
        if not '2024-04-01' <= value <= '2026-08-30':
            raise LookupError('That date is not in the daily model dataset.')
        return value, INFO
    return [patch('explorer.validate_day', side_effect=validate),
            patch('explorer._daily_prediction', return_value=PREDICTION),
            patch('explorer._daily_actuals', return_value={'2026-01-11': {'status': 'available', 'curtailmentMwh': 7010.69, 'event': True}}),
            patch('sources.forecast_split', return_value=split),
            patch('sources.recorded_day', **({'side_effect': recorded} if isinstance(recorded, Exception) else {'return_value': recorded}))]


class HeadlineTests(unittest.TestCase):
    def run_with(self, patches, fn):
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        return fn()

    def test_headline_joins_the_daily_forecast_its_split_and_the_record(self):
        h = self.run_with(stubbed(), lambda: dayview.headline('2026-01-11'))
        self.assertEqual((h['date'], h['probability'], h['predictedMwh']), ('2026-01-11', 0.9478, 8962.79))
        self.assertEqual((h['split']['status'], h['split']['windSharePercent']), ('ok', 98.7))
        self.assertEqual(h['recorded']['curtailmentMwh'], 7010.69)
        self.assertEqual(h['recorded']['split']['windSharePercent'], 99.61)
        self.assertEqual(set(h['model']['test']), {'rows', 'dailyMaeMwh', 'zeroBaselineMaeMwh', 'rocAuc'})

    def test_a_missing_split_or_record_is_reported_not_raised(self):
        down = {'status': 'unavailable', 'message': 'down'}
        h = self.run_with(stubbed(split=down, recorded=URLError('down')), lambda: dayview.headline('2026-01-11'))
        self.assertEqual(h['split'], {'status': 'unavailable', 'message': 'down'})
        self.assertIsNone(h['recorded']['split'])
        self.assertEqual(h['predictedMwh'], 8962.79)


class HeadlineHttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory='frontend'))
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f'http://127.0.0.1:{cls.server.server_port}/api/v1/dashboard/day'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def setUp(self):
        for p in stubbed():
            p.start()
            self.addCleanup(p.stop)

    def get(self, query):
        try:
            with urlopen(f'{self.url}?{query}') as response:
                return response.status, json.load(response)
        except HTTPError as error:
            with error:
                return error.code, json.loads(error.read() or b'{}')

    def test_route_serves_the_headline(self):
        status, body = self.get('date=2026-01-11')
        self.assertEqual((status, body['predictedMwh']), (200, 8962.79))

    def test_bad_and_out_of_range_dates(self):
        self.assertEqual(self.get('date=11-01-2026')[0], 400)
        self.assertEqual(self.get('date=2023-01-01')[0], 404)

    def test_a_malformed_model_answer_is_a_502_not_a_404(self):
        with patch('explorer._daily_prediction', side_effect=KeyError('predicted_curtailment_mwh')):
            self.assertEqual(self.get('date=2026-01-11')[0], 502)


if __name__ == '__main__':
    unittest.main()
