from functools import partial
from http.server import ThreadingHTTPServer
from io import BytesIO
import json
from pathlib import Path
import sys
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import explorer
from server import Handler


def v1_row(issue, horizon, mwh=10.0):
    target = explorer.iso(explorer.utc(issue) + explorer.timedelta(minutes=horizon))
    return dict(model_version='1.1.0', issue_timestamp_utc=issue, target_timestamp_utc=target,
                forecast_horizon_minutes=horizon, dispatch_down_probability=.9, dispatch_down_event_prediction=True,
                risk_level='high', predicted_dispatch_down_mwh=mwh, predicted_curtailment_mwh=2.0,
                predicted_constraint_mwh=mwh - 2, prediction_interval_p10_mwh=5.0, prediction_interval_p50_mwh=9.0,
                prediction_interval_p90_mwh=15.0, flexible_load_capacity_mw=100.0, recoverable_surplus_mwh=mwh)


def http_error(code, body):
    """An HTTPError as explorer.call re-raises it: body re-readable, parsed detail attached."""
    error = HTTPError('http://model', code, 'Error', {}, BytesIO(body))
    error.model_detail = explorer._model_detail(body)
    return error


def not_found():
    return http_error(404, b'{"detail":{"error":"dataset_timestamp_not_available"}}')


V1_INFO = {'model': {'partitions': {'train': {'from': '2026-01-02T00:00:00Z', 'to': '2026-01-22T22:00:00Z', 'rows': 1},
                                    'test': {'from': '2026-01-27T11:00:00Z', 'to': '2026-01-31T22:30:00Z', 'rows': 1}}},
           'times': ['2026-01-31T22:00:00Z', '2026-01-31T22:30:00Z']}
V2_INFO = {'dataset': {'from': '2024-04-01', 'to': '2026-08-30',
                       'partitions': {'test': {'from': '2026-01-01', 'to': '2026-08-30', 'rows': 242}}}}


class HelperTests(unittest.TestCase):
    def test_available_times_fills_contiguous_prefix_before_listed_times(self):
        dataset = {'available_issue_timestamp_min_utc': '2026-01-02T00:00:00+00:00'}
        times = explorer._available_times(dataset, ['2026-01-02T01:30:00+00:00', '2026-01-02T01:00:00+00:00'])
        self.assertEqual(times, ['2026-01-02T00:00:00Z', '2026-01-02T00:30:00Z', '2026-01-02T01:00:00Z', '2026-01-02T01:30:00Z'])

    def test_contiguous_runs_split_at_gaps(self):
        runs = explorer.contiguous_runs(['2026-01-14T14:00:00Z', '2026-01-14T14:30:00Z', '2026-01-14T16:00:00Z'])
        self.assertEqual([len(run) for run in runs], [2, 1])

    def test_partition_lookup(self):
        self.assertEqual(explorer.partition_of('2026-03-15', V2_INFO['dataset']['partitions']), 'test')
        self.assertIsNone(explorer.partition_of('2025-03-15', V2_INFO['dataset']['partitions']))


class ModelCallTests(unittest.TestCase):
    def setUp(self):
        explorer._cache.clear()

    @patch('explorer.short_term_info', return_value=V1_INFO)
    @patch('explorer.call')
    def test_missing_horizon_row_is_skipped_not_fatal(self, call, _info):
        def fake(path, body=None):
            if path == '/predict/from-dataset':
                if body['forecast_horizon_minutes'] == 60:
                    raise not_found()
                return v1_row(body['issue_timestamp_utc'], 30)
            return {'actuals': [{'status': 'available', 'target_timestamp_utc': '2026-01-31T23:00:00Z',
                                 'actual_dispatch_down_mwh': 12.0, 'actual_curtailment_mwh': 0.0, 'actual_constraint_mwh': 12.0}]}
        call.side_effect = fake
        result = explorer.short_term_predict('2026-01-31T22:30:00Z', 100)
        self.assertEqual([p['horizonMinutes'] for p in result['predictions']], [30])
        self.assertEqual(result['predictions'][0]['actual']['dispatchDownMwh'], 12.0)
        self.assertEqual(result['partition'], 'test')

    @patch('explorer.short_term_info', return_value=V1_INFO)
    @patch('explorer.call')
    def test_other_404s_are_not_treated_as_missing_rows(self, call, _info):
        for body in (b'{"detail":"Not Found"}', b'{"detail":{"error":"something_else"}}', b'not json'):
            with self.subTest(body=body):
                call.side_effect = lambda path, b=None, body=body: (_ for _ in ()).throw(http_error(404, body))
                with self.assertRaises(HTTPError):
                    explorer.short_term_predict('2026-01-31T22:30:00Z', 100)

    def test_call_keeps_upstream_error_body_readable(self):
        upstream = HTTPError('http://model/x', 404, 'Not Found', {},
                             BytesIO(b'{"detail":{"error":"dataset_window_not_available","first_missing_issue_timestamp_utc":"2026-01-14T15:00:00+00:00"}}'))
        with patch('explorer.urlopen', side_effect=upstream), self.assertRaises(HTTPError) as caught:
            explorer.call('/predict/window/from-dataset', {})
        self.assertTrue(explorer.missing_row(caught.exception))
        self.assertIn(b'dataset_window_not_available', caught.exception.read())

    @patch('explorer.short_term_info', return_value=V1_INFO)
    @patch('explorer.call')
    def test_issue_time_outside_dataset_never_calls_model(self, call, _info):
        with self.assertRaises(LookupError):
            explorer.short_term_predict('2026-01-31T12:00:00Z', 100)
        call.assert_not_called()

    @patch('explorer.call')
    def test_day_replay_covers_the_days_48_targets_at_each_horizon(self, call):
        start = explorer.utc('2026-01-08T00:00:00Z')
        times = [explorer.iso(start + explorer.timedelta(minutes=30 * i)) for i in range(96)]  # 8-9 Jan
        requests = []

        def fake(path, body=None):
            if path == '/predict/window/from-dataset':
                requests.append(body)
                first = explorer.utc(body['start_timestamp_utc'])
                horizon = body['forecast_horizons_minutes'][0]
                return {'predictions': [v1_row(explorer.iso(first + explorer.timedelta(minutes=30 * i)), horizon)
                                        for i in range(int(body['duration_hours'] * 2))]}
            return {'actuals': [{'status': 'available', 'target_timestamp_utc': t, 'actual_dispatch_down_mwh': 1.0}
                                for t in body['target_timestamps_utc']]}
        call.side_effect = fake
        with patch('explorer.short_term_info', return_value={**V1_INFO, 'times': times}):
            day = explorer.short_term_day('2026-01-09')
        self.assertEqual(sorted((r['start_timestamp_utc'], r['forecast_horizons_minutes'][0]) for r in requests),
                         [('2026-01-08T23:00:00Z', 60), ('2026-01-08T23:30:00Z', 30)])
        for horizon in (30, 60):
            targets = sorted(p['targetAt'] for p in day['points'] if p['horizonMinutes'] == horizon)
            self.assertEqual((len(targets), targets[0], targets[-1]), (48, '2026-01-09T00:00:00Z', '2026-01-09T23:30:00Z'))
        self.assertEqual(len(day['observed']), 48)

    @patch('explorer.daily_info', return_value=V2_INFO)
    @patch('explorer.call')
    def test_daily_prediction_with_actual(self, call, _info):
        call.side_effect = lambda path, body=None: (
            {'model_version': '2.0.0', 'curtailment_event_probability': .8, 'predicted_curtailment_mwh': 900.0,
             'issue_timestamp_utc': '2026-03-15T00:00:00+00:00'} if body else
            {'status': 'pending', 'actual_curtailment_mwh': None, 'actual_curtailment_event': None})
        result = explorer.daily_predict('2026-03-15')
        self.assertEqual((result['probability'], result['predictedMwh'], result['partition']), (.8, 900.0, 'test'))
        self.assertEqual(result['actual']['status'], 'pending')
        self.assertIsNone(result['actual']['curtailmentMwh'])

    @patch('explorer.daily_info', return_value=V2_INFO)
    @patch('explorer._daily_one', side_effect=lambda day: {'date': day})
    def test_week_starts_on_the_selected_day(self, _one, _info):
        days = [d['date'] for d in explorer.daily_week('2025-06-10')['days']]
        self.assertEqual((days[0], days[-1], len(days)), ('2025-06-10', '2025-06-16', 7))

    @patch('explorer.daily_info', return_value=V2_INFO)
    @patch('explorer._daily_one', side_effect=lambda day: {'date': day})
    def test_week_is_clipped_to_dataset_end(self, _one, _info):
        days = [d['date'] for d in explorer.daily_week('2026-08-30')['days']]
        self.assertEqual(days, ['2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28', '2026-08-29', '2026-08-30'])

    @patch('explorer.daily_info', return_value=V2_INFO)
    def test_daily_rejects_dates_outside_dataset(self, _info):
        for day in ('2024-03-31', '2026-08-31'):
            with self.subTest(day=day), self.assertRaises(LookupError):
                explorer.daily_predict(day)


class ExplorerHttpTests(unittest.TestCase):
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

    @patch('explorer.daily_predict')
    def test_invalid_input_is_400_without_model_call(self, predict):
        for path in ('/api/v1/explorer/daily/predict?date=15-03-2026', '/api/v1/explorer/daily/predict',
                     '/api/v1/explorer/short-term/predict?issue=2026-01-20T12:00:00', '/api/v1/explorer/short-term/predict?issue=2026-01-20T12:00:00Z&capacityMw=0'):
            with self.subTest(path=path):
                self.assertEqual(self.get(path)[0], 400)
        predict.assert_not_called()

    @patch('explorer.daily_predict', side_effect=LookupError('That date is not in the daily model dataset.'))
    def test_date_outside_dataset_is_404(self, _predict):
        status, body = self.get('/api/v1/explorer/daily/predict?date=2020-01-01')
        self.assertEqual((status, body['error']['code']), (404, 'NOT_IN_DATASET'))

    @patch('explorer.daily_info', side_effect=TimeoutError())
    def test_upstream_failure_is_502_with_diagnosis(self, _info):
        status, body = self.get('/api/v1/explorer/daily')
        self.assertEqual((status, body['error']['code']), (502, 'MODEL_TIMEOUT'))

    def test_unknown_explorer_route_is_404(self):
        self.assertEqual(self.get('/api/v1/explorer/nope')[0], 404)


if __name__ == '__main__':
    unittest.main()
