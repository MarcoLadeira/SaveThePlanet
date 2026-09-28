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
    def test_earlier_times_accepted_only_when_the_reported_count_proves_no_gaps(self):
        dataset = {'available_issue_timestamp_min_utc': '2026-01-02T00:00:00+00:00', 'available_issue_timestamp_count': 4}
        with patch('explorer.call') as call:
            times, how = explorer._available_times(dataset, ['2026-01-02T01:30:00+00:00', '2026-01-02T01:00:00+00:00'])
        call.assert_not_called()
        self.assertEqual(how, 'count')
        self.assertEqual(times, ['2026-01-02T00:00:00Z', '2026-01-02T00:30:00Z', '2026-01-02T01:00:00Z', '2026-01-02T01:30:00Z'])

    def test_earlier_times_with_a_gap_are_verified_by_replay(self):
        # 00:00-01:30 are candidates before the listed 02:00, but 00:30 is missing (count 4, not 5).
        dataset = {'available_issue_timestamp_min_utc': '2026-01-02T00:00:00+00:00', 'available_issue_timestamp_count': 4}
        present = {'2026-01-02T00:00:00Z', '2026-01-02T01:00:00Z', '2026-01-02T01:30:00Z'}

        def fake(path, body):
            start = explorer.utc(body['start_timestamp_utc'])
            slots = [explorer.iso(start + explorer.timedelta(minutes=30 * i)) for i in range(int(body['duration_hours'] * 2))]
            gap = next((t for t in slots if t not in present), None)
            if gap:
                raise http_error(404, json.dumps({'detail': {'error': 'dataset_window_not_available',
                                                             'first_missing_issue_timestamp_utc': gap}}).encode())
            return {'predictions': [{'issue_timestamp_utc': t} for t in slots]}
        explorer._cache.clear()
        with patch('explorer.call', side_effect=fake):
            times, how = explorer._available_times(dataset, ['2026-01-02T02:00:00+00:00'])
        self.assertEqual(how, 'replay')
        self.assertEqual(times, ['2026-01-02T00:00:00Z', '2026-01-02T01:00:00Z', '2026-01-02T01:30:00Z', '2026-01-02T02:00:00Z'])

    def test_real_errors_during_verification_are_raised(self):
        dataset = {'available_issue_timestamp_min_utc': '2026-01-02T00:00:00+00:00', 'available_issue_timestamp_count': 1}
        explorer._cache.clear()
        with patch('explorer.call', side_effect=http_error(404, b'{"detail":"Not Found"}')), self.assertRaises(HTTPError):
            explorer._available_times(dataset, ['2026-01-02T01:00:00+00:00'])

    def test_contiguous_runs_split_at_gaps(self):
        runs = explorer.contiguous_runs(['2026-01-14T14:00:00Z', '2026-01-14T14:30:00Z', '2026-01-14T16:00:00Z'])
        self.assertEqual([len(run) for run in runs], [2, 1])

    def test_forecast_rows_stop_at_the_last_labelled_target(self):
        times = {'2026-01-31T22:00:00Z', '2026-01-31T22:30:00Z'}
        # The final 22:30 issue has a +30 row (23:00) but no +60 row (23:30).
        self.assertEqual(explorer.forecast_issues('2026-01-31T23:00:00Z', times),
                         {30: '2026-01-31T22:30:00Z', 60: '2026-01-31T22:00:00Z'})
        self.assertEqual(explorer.forecast_issues('2026-01-31T23:30:00Z', times), {})
        self.assertEqual(explorer.valid_targets(times), ['2026-01-31T22:30:00Z', '2026-01-31T23:00:00Z'])

    def test_targets_beside_a_dataset_gap_keep_their_remaining_horizon(self):
        times = {'2026-01-14T14:00:00Z', '2026-01-14T14:30:00Z', '2026-01-14T16:00:00Z', '2026-01-14T16:30:00Z'}
        self.assertEqual(explorer.forecast_issues('2026-01-14T15:30:00Z', times), {60: '2026-01-14T14:30:00Z'})
        self.assertEqual(explorer.forecast_issues('2026-01-14T16:00:00Z', times), {})

    def test_partition_lookup(self):
        self.assertEqual(explorer.partition_of('2026-03-15', V2_INFO['dataset']['partitions']), 'test')
        self.assertIsNone(explorer.partition_of('2025-03-15', V2_INFO['dataset']['partitions']))


class ModelCallTests(unittest.TestCase):
    def setUp(self):
        explorer._cache.clear()

    @patch('explorer.short_term_info', return_value=V1_INFO)
    @patch('explorer.call')
    def test_target_gets_both_horizons_from_their_own_issue_times(self, call, _info):
        requests = []

        def fake(path, body=None):
            if path == '/predict/from-dataset':
                requests.append((body['issue_timestamp_utc'], body['forecast_horizon_minutes']))
                return v1_row(body['issue_timestamp_utc'], body['forecast_horizon_minutes'])
            return {'actuals': [{'status': 'available', 'target_timestamp_utc': '2026-01-31T23:00:00Z',
                                 'actual_dispatch_down_mwh': 12.0, 'actual_curtailment_mwh': 0.0, 'actual_constraint_mwh': 12.0}]}
        call.side_effect = fake
        result = explorer.short_term_predict('2026-01-31T23:00:00Z', 100)
        self.assertEqual(sorted(requests), [('2026-01-31T22:00:00Z', 60), ('2026-01-31T22:30:00Z', 30)])
        self.assertEqual([p['targetAt'] for p in result['predictions']], ['2026-01-31T23:00:00Z'] * 2)
        self.assertEqual(result['actual']['dispatchDownMwh'], 12.0)
        self.assertEqual([p['partition'] for p in result['predictions']], ['test', 'test'])

    @patch('explorer.short_term_info', return_value={**V1_INFO, 'times': ['2026-01-08T23:30:00Z', '2026-01-09T00:00:00Z']})
    @patch('explorer.call')
    def test_midnight_target_uses_previous_evening_issue_and_stays_on_its_day(self, call, _info):
        call.side_effect = lambda path, body=None: (v1_row(body['issue_timestamp_utc'], body['forecast_horizon_minutes'])
                                                    if path == '/predict/from-dataset' else {'actuals': []})
        result = explorer.short_term_predict('2026-01-09T00:00:00Z', 100)
        self.assertEqual(result['targetAt'], '2026-01-09T00:00:00Z')
        self.assertEqual([(p['horizonMinutes'], p['issuedAt']) for p in result['predictions']], [(30, '2026-01-08T23:30:00Z')])

    @patch('explorer.short_term_info', return_value=V1_INFO)
    @patch('explorer.call')
    def test_missing_horizon_row_is_skipped_not_fatal(self, call, _info):
        def fake(path, body=None):
            if path == '/predict/from-dataset':
                if body['forecast_horizon_minutes'] == 60:
                    raise not_found()
                return v1_row(body['issue_timestamp_utc'], 30)
            return {'actuals': []}
        call.side_effect = fake
        result = explorer.short_term_predict('2026-01-31T23:00:00Z', 100)
        self.assertEqual([p['horizonMinutes'] for p in result['predictions']], [30])
        self.assertIsNone(result['actual'])

    @patch('explorer.short_term_info', return_value=V1_INFO)
    @patch('explorer.call')
    def test_other_404s_are_not_treated_as_missing_rows(self, call, _info):
        for body in (b'{"detail":"Not Found"}', b'{"detail":{"error":"something_else"}}', b'not json'):
            with self.subTest(body=body):
                call.side_effect = lambda path, b=None, body=body: (_ for _ in ()).throw(http_error(404, body))
                with self.assertRaises(HTTPError):
                    explorer.short_term_predict('2026-01-31T23:00:00Z', 100)

    def test_call_keeps_upstream_error_body_readable(self):
        upstream = HTTPError('http://model/x', 404, 'Not Found', {},
                             BytesIO(b'{"detail":{"error":"dataset_window_not_available","first_missing_issue_timestamp_utc":"2026-01-14T15:00:00+00:00"}}'))
        with patch('explorer.urlopen', side_effect=upstream), self.assertRaises(HTTPError) as caught:
            explorer.call('/predict/window/from-dataset', {})
        self.assertTrue(explorer.missing_row(caught.exception))
        self.assertIn(b'dataset_window_not_available', caught.exception.read())

    @patch('explorer.short_term_info', return_value=V1_INFO)
    @patch('explorer.call')
    def test_target_without_dataset_issue_time_never_calls_model(self, call, _info):
        for target in ('2026-01-31T12:00:00Z', '2026-01-31T23:30:00Z'):  # 23:30 is past the last labelled target
            with self.subTest(target=target), self.assertRaises(LookupError):
                explorer.short_term_predict(target, 100)
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
            self.assertEqual(path, '/actuals/v1/window')  # observed values: one window call per day
            first = explorer.utc(body['start_target_timestamp_utc'])
            return {'actuals': [{'status': 'available', 'actual_dispatch_down_mwh': 1.0,
                                 'target_timestamp_utc': explorer.iso(first + explorer.timedelta(minutes=30 * i))}
                                for i in range(int(body['duration_hours'] * 2))]}
        call.side_effect = fake
        for horizon, start in ((30, '2026-01-08T23:30:00Z'), (60, '2026-01-08T23:00:00Z')):
            with self.subTest(horizon=horizon), patch('explorer.short_term_info', return_value={**V1_INFO, 'times': times}):
                requests.clear()
                day = explorer.short_term_day('2026-01-09', horizon)
                # One window per request, for this horizon only: the hosted service slows down badly
                # when replays run in parallel.
                self.assertEqual([(r['start_timestamp_utc'], r['forecast_horizons_minutes']) for r in requests], [(start, [horizon])])
                targets = sorted(p['targetAt'] for p in day['points'])
                self.assertEqual({p['horizonMinutes'] for p in day['points']}, {horizon})
                self.assertEqual((len(targets), targets[0], targets[-1]), (48, '2026-01-09T00:00:00Z', '2026-01-09T23:30:00Z'))
                self.assertEqual(len(day['observed']), 48)

    @patch('explorer.RETRY_BACKOFF_SECONDS', 0)
    @patch('explorer.call')
    def test_day_replay_retries_a_timed_out_window_once(self, call):
        start = explorer.utc('2026-01-08T00:00:00Z')
        times = [explorer.iso(start + explorer.timedelta(minutes=30 * i)) for i in range(96)]
        attempts = []

        def fake(path, body=None):
            if path == '/predict/window/from-dataset':
                attempts.append(1)
                if len(attempts) == 1:
                    raise TimeoutError()
                first = explorer.utc(body['start_timestamp_utc'])
                return {'predictions': [v1_row(explorer.iso(first + explorer.timedelta(minutes=30 * i)), 30)
                                        for i in range(int(body['duration_hours'] * 2))]}
            return {'actuals': []}
        call.side_effect = fake
        with patch('explorer.short_term_info', return_value={**V1_INFO, 'times': times}):
            day = explorer.short_term_day('2026-01-09', 30)
        self.assertEqual((len(attempts), len(day['points'])), (2, 48))

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
    @patch('explorer._daily_actuals', side_effect=lambda days: {d: None for d in days})
    @patch('explorer._daily_prediction', side_effect=lambda day: {'date': day})
    def test_week_starts_on_the_selected_day(self, _prediction, _actuals, _info):
        days = [d['date'] for d in explorer.daily_week('2025-06-10')['days']]
        self.assertEqual((days[0], days[-1], len(days)), ('2025-06-10', '2025-06-16', 7))

    @patch('explorer.daily_info', return_value=V2_INFO)
    @patch('explorer.call')
    def test_week_actuals_come_from_one_window_call_and_are_reused(self, call, _info):
        def fake(path, body=None):
            if path == '/predict/curtailment/day':
                return {'model_version': '2', 'curtailment_event_probability': .5, 'predicted_curtailment_mwh': 10.0}
            self.assertEqual(path, '/actuals/daily-curtailment/window')
            start = explorer.date.fromisoformat(body['start_date_utc'])
            return {'actuals': [{'status': 'available', 'actual_curtailment_mwh': 100.0 + i, 'actual_curtailment_event': True,
                                 'target_date_utc': (start + explorer.timedelta(days=i)).isoformat()} for i in range(body['days'])]}
        call.side_effect = fake
        week = explorer.daily_week('2025-06-10')
        actual_calls = [c for c in call.call_args_list if c.args[0].startswith('/actuals')]
        self.assertEqual(len(actual_calls), 1)
        self.assertEqual([d['actual']['curtailmentMwh'] for d in week['days']], [100.0 + i for i in range(7)])
        call.reset_mock()
        self.assertEqual(explorer.daily_predict('2025-06-12')['actual']['curtailmentMwh'], 102.0)
        call.assert_not_called()  # clicking a day in the week needs no further requests

    @patch('explorer.daily_info', return_value=V2_INFO)
    @patch('explorer._daily_actuals', side_effect=lambda days: {d: None for d in days})
    @patch('explorer._daily_prediction', side_effect=lambda day: {'date': day})
    def test_week_is_clipped_to_dataset_end(self, _prediction, _actuals, _info):
        days = [d['date'] for d in explorer.daily_week('2026-08-30')['days']]
        self.assertEqual(days, ['2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28', '2026-08-29', '2026-08-30'])

    def _actuals_api(self, calls, skip=()):
        """A fake actuals API that records every call; dates in `skip` are omitted from windows."""
        def fake(path, body=None):
            calls.append((path, body))
            if path.startswith('/actuals/daily-curtailment?'):
                day = path.rsplit('=', 1)[1]
                return {'status': 'available', 'target_date_utc': day, 'actual_curtailment_mwh': float(day[-2:]),
                        'actual_curtailment_event': True}
            start = explorer.date.fromisoformat(body['start_date_utc'])
            days = [(start + explorer.timedelta(days=i)).isoformat() for i in range(body['days'])]
            return {'actuals': [{'status': 'available', 'target_date_utc': d, 'actual_curtailment_mwh': float(d[-2:]),
                                 'actual_curtailment_event': True} for d in days if d not in skip]}
        return fake

    def test_interleaved_cache_fetches_each_uncached_run(self):
        # Review repro: cache Wednesday, then request Tuesday-Thursday.
        calls = []
        with patch('explorer.call', side_effect=self._actuals_api(calls)):
            explorer._daily_actuals(['2025-06-11'])
            calls.clear()
            result = explorer._daily_actuals(['2025-06-10', '2025-06-11', '2025-06-12'])
        self.assertEqual({d: a['curtailmentMwh'] for d, a in result.items()},
                         {'2025-06-10': 10.0, '2025-06-11': 11.0, '2025-06-12': 12.0})
        self.assertEqual(sorted(path for path, _ in calls),
                         ['/actuals/daily-curtailment?target_date_utc=2025-06-10',
                          '/actuals/daily-curtailment?target_date_utc=2025-06-12'])

    def test_single_day_then_week_and_week_then_single_day(self):
        week = [f'2025-06-{d:02d}' for d in range(10, 17)]
        for order in (('single', 'week'), ('week', 'single')):
            with self.subTest(order=order):
                explorer._cache.clear()
                calls = []
                with patch('explorer.call', side_effect=self._actuals_api(calls)):
                    for step in order:
                        result = explorer._daily_actuals(['2025-06-13'] if step == 'single' else week)
                with patch('explorer.call', side_effect=AssertionError('everything should be cached')):
                    final = explorer._daily_actuals(week)
                self.assertEqual([final[d]['curtailmentMwh'] for d in week], [float(d[-2:]) for d in week])
                # single -> week: the day, then the runs either side of it (10-12, 14-16); week -> single: one window.
                self.assertEqual(sum(1 for path, _ in calls if path.startswith('/actuals/daily-curtailment')), 3 if order == ('single', 'week') else 1)

    def test_unanswered_dates_are_reported_missing_but_not_cached(self):
        calls = []
        days = ['2025-06-10', '2025-06-11', '2025-06-12']
        with patch('explorer.call', side_effect=self._actuals_api(calls, skip={'2025-06-12'})):
            first = explorer._daily_actuals(days)
        self.assertEqual(first['2025-06-12']['status'], 'missing')
        with patch('explorer.call', side_effect=self._actuals_api(calls)):
            second = explorer._daily_actuals(days)
        self.assertEqual(second['2025-06-12']['curtailmentMwh'], 12.0)  # asked again, not stuck as missing
        self.assertEqual(calls[-1][0], '/actuals/daily-curtailment?target_date_utc=2025-06-12')

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
                     '/api/v1/explorer/short-term/predict?target=2026-01-20T12:00:00', '/api/v1/explorer/short-term/predict?target=2026-01-20T12:15:00Z',
                     '/api/v1/explorer/short-term/predict?target=2026-01-20T12:00:00Z&capacityMw=0'):
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

    def test_busy_gate_is_503_with_retry_after(self):
        from gate import Busy
        with patch('explorer.short_term_day', side_effect=Busy()):
            try:
                urlopen(self.url + '/api/v1/explorer/short-term/day?date=2026-01-20&horizon=30&client=tab-1&seq=3')
                self.fail('expected 503')
            except HTTPError as error:
                self.assertEqual((error.code, error.headers['Retry-After'], json.load(error)['error']['code']), (503, '5', 'MODEL_BUSY'))

    def test_superseded_request_is_409_and_passes_viewer_identity(self):
        from gate import Superseded
        with patch('explorer.short_term_day', side_effect=Superseded()) as replay:
            status, body = self.get('/api/v1/explorer/short-term/day?date=2026-01-20&horizon=60&client=tab-1&seq=4&prefetch=1')
        self.assertEqual((status, body['error']['code']), (409, 'SUPERSEDED'))
        replay.assert_called_once_with('2026-01-20', 60, 'tab-1', 4, True)

    def test_unknown_explorer_route_is_404(self):
        self.assertEqual(self.get('/api/v1/explorer/nope')[0], 404)


if __name__ == '__main__':
    unittest.main()
