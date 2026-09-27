from datetime import datetime, timedelta, timezone
import threading
import unittest
from unittest.mock import patch

import test_server as support
import server
from scenario import build_day

FIRST = datetime(2026, 1, 2, tzinfo=timezone.utc)
LAST = datetime(2026, 1, 31, 22, 30, tzinfo=timezone.utc)
INFO = {'available_issue_timestamp_min_utc': FIRST.isoformat(), 'available_issue_timestamp_max_utc': LAST.isoformat()}


def window_row(issue, at_risk, capacity=100):
    target = issue + timedelta(minutes=30)
    return dict(model_version='test', issue_timestamp_utc=issue.isoformat(), target_timestamp_utc=target.isoformat(),
                forecast_horizon_minutes=30, dispatch_down_probability=.5, risk_level='medium',
                predicted_dispatch_down_mwh=at_risk, predicted_curtailment_mwh=0, predicted_constraint_mwh=at_risk,
                prediction_interval_p10_mwh=0, prediction_interval_p50_mwh=at_risk, prediction_interval_p90_mwh=at_risk,
                flexible_load_capacity_mw=capacity, recoverable_surplus_mwh=min(at_risk, capacity * .5))


def window(start, energies):
    return {'predictions': [window_row(start + timedelta(minutes=30 * i), e) for i, e in enumerate(energies)]}


class FakeModel:
    """Stands in for model_request; records window requests."""
    def __init__(self, energies):
        self.energies, self.windows = energies, []

    def __call__(self, path, body=None, timeout=None):
        if path == '/dataset/info':
            return INFO
        self.windows.append(body)
        start = datetime.fromisoformat(body['start_timestamp_utc'].replace('Z', '+00:00'))
        count = int(body['duration_hours'] * 2)
        return window(start, self.energies[:count])


def reset_state(test):
    server._day_cache.clear()
    server._day_inflight.clear()
    server._prefetch_plan.clear()
    server._user_replays = 0
    server._dataset_range = None
    # No background upstream calls from tests unless a test opts in.
    prefetch = patch('server.PREFETCH_DAYS', 0)
    prefetch.start()
    test.addCleanup(prefetch.stop)


class ImpactDayTests(unittest.TestCase):
    def setUp(self):
        reset_state(self)

    def replay(self, energies, day='2026-01-10'):
        fake = FakeModel(energies)
        with patch('server.model_request', fake):
            return server.fetch_day_replay(datetime.fromisoformat(day).date(), 100), fake

    def test_intervals_are_summed_with_demand_cap(self):
        replay, _ = self.replay([0, 2, 0.2, 80] + [0] * 44)
        day = build_day(replay, 1000, 500)
        self.assertEqual(len(day['intervals']), 48)
        # recovery per half-hour = min(at risk, 50 MWh capacity, 0.5 MWh flexible)
        self.assertEqual([i['potentialRecoveryMwh'] for i in day['intervals'][:4]], [0, .5, .2, .5])
        self.assertAlmostEqual(day['totals']['potentialRecoveryMwh'], 1.2)
        self.assertAlmostEqual(day['totals']['atRiskMwh'], 82.2)
        self.assertAlmostEqual(day['totals']['avoidedEmissionsTco2'], 1.2 * .25)
        self.assertEqual(day['range'], {'min': '2026-01-02', 'max': '2026-01-31'})
        for interval in day['intervals']:
            self.assertAlmostEqual(interval['atRiskMwh'], interval['potentialRecoveryMwh'] + interval['remainingWasteMwh'])

    def test_last_partial_day_requests_only_existing_issue_times(self):
        _, fake = self.replay([1] * 48, day='2026-01-31')
        self.assertEqual(fake.windows[0]['duration_hours'], 23.0)

    def test_replay_is_cached_per_day_and_capacity(self):
        fake = FakeModel([1] * 48)
        with patch('server.model_request', fake):
            server.fetch_day_replay(datetime(2026, 1, 10).date(), 100)
            server.fetch_day_replay(datetime(2026, 1, 10).date(), 100)
        self.assertEqual(len(fake.windows), 1)

    def test_rejects_out_of_range_dates(self):
        for day in ('2026-01-01', '2026-02-01'):
            with self.subTest(day=day), self.assertRaises(server.DateOutOfRange):
                self.replay([1] * 48, day=day)

    def test_rejects_invalid_window_rows(self):
        fake = FakeModel([1] * 48)

        def bad(path, body=None, timeout=None):
            payload = fake(path, body, timeout)
            if path != '/dataset/info':
                payload['predictions'][3]['recoverable_surplus_mwh'] = 99
            return payload
        with patch('server.model_request', bad), self.assertRaises(ValueError):
            server.fetch_day_replay(datetime(2026, 1, 10).date(), 100)


class PrefetchTests(unittest.TestCase):
    def setUp(self):
        reset_state(self)

    def test_neighbours_nearest_first_and_clipped(self):
        d = lambda day: datetime(2026, 1, day).date()
        self.assertEqual(server.neighbour_days(d(10), d(2), d(31), 3), [d(9), d(11), d(8), d(12), d(7), d(13)])
        self.assertEqual(server.neighbour_days(d(2), d(2), d(31), 3), [d(3), d(4), d(5)])

    def test_new_day_replaces_plan_and_skips_cached_days(self):
        with patch('server.PREFETCH_DAYS', 2), patch('server._prefetch_worker', object()),                 patch('server.model_request', FakeModel([1] * 48)):
            server._day_cache[('2026-01-11', 100)] = {}
            server.schedule_prefetch(datetime(2026, 1, 10).date(), 100)
            self.assertEqual(server._prefetch_plan, [('2026-01-09', 100), ('2026-01-08', 100), ('2026-01-12', 100)])
            server.schedule_prefetch(datetime(2026, 1, 20).date(), 100)
            # neighbours of the old day are dropped, not left queued ahead of the new ones
            self.assertEqual(server._prefetch_plan, [('2026-01-19', 100), ('2026-01-21', 100), ('2026-01-18', 100), ('2026-01-22', 100)])

    def test_prefetch_waits_while_user_replay_in_flight(self):
        server._prefetch_plan[:] = [('2026-01-11', 100)]
        picked = []
        replay = server.user_replay()
        replay.__enter__()
        worker = threading.Thread(target=lambda: picked.append(server._next_prefetch()), daemon=True)
        worker.start()
        worker.join(.3)
        self.assertEqual(picked, [])  # held back while the user waits
        replay.__exit__(None, None, None)
        worker.join(2)
        self.assertEqual(picked, [('2026-01-11', 100)])

    def test_concurrent_requests_share_one_upstream_call(self):
        fake, started, release = FakeModel([1] * 48), threading.Event(), threading.Event()

        def slow(path, body=None, timeout=None):
            if path != '/dataset/info':
                started.set()
                release.wait(5)
            return fake(path, body, timeout)
        results = []
        with patch('server.model_request', slow):
            first = threading.Thread(target=lambda: results.append(server.fetch_day_replay(datetime(2026, 1, 10).date(), 100)))
            first.start()
            started.wait(5)
            second = threading.Thread(target=lambda: results.append(server.fetch_day_replay(datetime(2026, 1, 10).date(), 100)))
            second.start()
            release.set()
            first.join(5)
            second.join(5)
        self.assertEqual(len(fake.windows), 1)
        self.assertEqual(len(results), 2)
        self.assertIs(results[0], results[1])


class ImpactDayHttpTests(unittest.TestCase):
    setUpClass = classmethod(support.HttpTests.setUpClass.__func__)
    tearDownClass = classmethod(support.HttpTests.tearDownClass.__func__)
    get = support.HttpTests.get

    def setUp(self):
        reset_state(self)

    def test_endpoint_returns_day(self):
        with patch('server.model_request', FakeModel([1] * 48)):
            status, body = self.get('/api/v1/impact/day?date=2026-01-10&capacityMw=100&totalDemandKwh=1000&flexibleDemandKwh=500')
        self.assertEqual(status, 200)
        self.assertEqual(body['date'], '2026-01-10')
        self.assertEqual(len(body['intervals']), 48)
        self.assertEqual(body['dataMode'], 'derived-scenario')

    def test_default_day_is_the_fixed_dataset_target_day(self):
        # The page normally sends the day of the dashboard's random target; without one the
        # server uses the day of the fixed dataset target, whatever the clock says.
        for now in (datetime(2026, 9, 27, 0, 5, tzinfo=timezone.utc), datetime(2026, 9, 27, 23, 55, tzinfo=timezone.utc)):
            with self.subTest(now=now):
                self.assertEqual(server.default_replay_day(now), server.timestamp(server.TARGET_TIMESTAMP).date())

    def test_defaults_to_configured_issue_day(self):
        with patch('server.model_request', FakeModel([1] * 48)):
            status, body = self.get('/api/v1/impact/day')
        self.assertEqual(status, 200)
        self.assertEqual(body['date'], server.default_replay_day().isoformat())

    def test_invalid_and_out_of_range_requests(self):
        with patch('server.model_request', FakeModel([1] * 48)):
            for query in ('date=10-01-2026', 'capacityMw=0', 'flexibleDemandKwh=2000'):
                self.assertEqual(self.get('/api/v1/impact/day?' + query)[0], 400)
            status, body = self.get('/api/v1/impact/day?date=2025-12-01')
        self.assertEqual(status, 400)
        self.assertEqual(body['error']['code'], 'DATE_OUT_OF_RANGE')

    def test_disconnected_client_is_ignored(self):
        handler = server.Handler.__new__(server.Handler)
        handler.send_json = lambda status, body: (_ for _ in ()).throw(ConnectionAbortedError())
        with patch('server.model_request', FakeModel([1] * 48)):
            handler.impact_day({'date': ['2026-01-10']})  # must not raise
        self.assertIn(('2026-01-10', 100.0), server._day_cache)

    def test_upstream_failures_serve_a_labelled_demo_day(self):
        for error in (TimeoutError(), KeyError('predictions')):
            with self.subTest(error=type(error).__name__), patch('server.model_request', side_effect=error):
                status, body = self.get('/api/v1/impact/day?date=2026-01-10')
            self.assertEqual(status, 200)
            self.assertEqual((body['dataMode'], body['source'], body['date']), ('simulated', 'local-demo-fixture', '2026-01-10'))
            self.assertEqual(len(body['intervals']), 48)
            self.assertTrue(all(i['atRiskMwh'] >= i['potentialRecoveryMwh'] >= 0 for i in body['intervals']))


if __name__ == '__main__':
    unittest.main()
