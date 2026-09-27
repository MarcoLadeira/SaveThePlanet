from pathlib import Path
import random
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import explorer
import server
import targets
import test_server as support


def forecast(target, mwh):
    return {'targetAt': target, 'predictions': [{'atRiskMwh': mwh}, {'atRiskMwh': mwh}]}


class SelectionTests(unittest.TestCase):
    def test_targets_need_both_horizon_issue_times(self):
        times = ['2026-01-14T14:00:00Z', '2026-01-14T14:30:00Z', '2026-01-14T16:00:00Z', '2026-01-14T16:30:00Z']
        # 15:00 (issued 14:30 / 14:00) and 17:00 (16:30 / 16:00) qualify; 14:30 and 16:30 lack a +60 issue time.
        self.assertEqual(targets.both_horizon_targets(times), ['2026-01-14T15:00:00Z', '2026-01-14T17:00:00Z'])

    def test_shortlist_keeps_targets_with_enough_observed_dispatch_down(self):
        explorer._cache.clear()
        times = ['2026-01-20T10:00:00Z', '2026-01-20T10:30:00Z', '2026-01-20T11:00:00Z']
        actuals = {'2026-01-20T11:00:00Z': {'dispatchDownMwh': 5.0}, '2026-01-20T11:30:00Z': {'dispatchDownMwh': 80.0}}
        with patch('explorer.short_term_info', return_value={'times': times}), \
                patch('explorer._v1_actuals', side_effect=lambda batch: {t: actuals[t] for t in batch if t in actuals}):
            self.assertEqual(targets.candidates(), [('2026-01-20T11:30:00Z', 80.0)])
        explorer._cache.clear()

    def test_pick_retries_until_the_model_predicts_extra_mwh(self):
        pool = [('A', 100.0), ('B', 100.0), ('C', 100.0)]
        predicted = {'A': 0.0, 'B': 3.0, 'C': 45.0}
        calls = []

        def fetch(capacity, target):
            calls.append(target)
            return forecast(target, predicted[target])
        with patch('targets.candidates', return_value=pool):
            for seed in range(20):
                calls.clear()
                result = targets.pick(100, fetch, random.Random(seed))
                self.assertEqual(result['targetAt'], 'C')
                self.assertTrue(result['selection']['metThreshold'])
                self.assertEqual(calls[-1], 'C')
                self.assertEqual(len(calls), len(set(calls)))  # never re-tries a target

    def test_pick_uses_the_best_prediction_when_none_meets_the_threshold(self):
        pool = [('A', 50.0), ('B', 50.0)]
        with patch('targets.candidates', return_value=pool):
            result = targets.pick(100, lambda c, t: forecast(t, {'A': 4.0, 'B': 9.0}[t]), random.Random(1))
        self.assertEqual(result['targetAt'], 'B')
        self.assertFalse(result['selection']['metThreshold'])

    def test_pick_prefers_higher_energy_targets(self):
        pool = [('LOW', 20.0), ('HIGH', 400.0)]
        with patch('targets.candidates', return_value=pool):
            picks = [targets.pick(1, lambda c, t: forecast(t, 50.0), random.Random(seed))['targetAt'] for seed in range(300)]
        self.assertGreater(picks.count('HIGH'), picks.count('LOW') * 5)

    def test_random_targets_vary_between_requests(self):
        pool = [(f'2026-01-{d:02d}T12:00:00Z', 100.0) for d in range(2, 30)]
        with patch('targets.candidates', return_value=pool):
            picks = {targets.pick(1, lambda c, t: forecast(t, 50.0))['targetAt'] for _ in range(20)}
        self.assertGreater(len(picks), 1)


class DashboardTargetTests(unittest.TestCase):
    setUp = staticmethod(support.start_hermetic_targets)
    tearDown = staticmethod(support.stop_hermetic_targets)

    def test_requested_target_is_validated(self):
        self.assertEqual(server.dashboard_target(support.FIXED_TARGET), support.FIXED_TARGET)
        self.assertIsNone(server.dashboard_target(None))
        for bad in ('2026-01-31T23:15:00Z', '2026-01-31T23:00:00', '2026-01-10T12:00:00Z', 'soon'):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                server.dashboard_target(bad)

    @patch('server.fetch_forecast')
    def test_given_target_is_fetched_directly_without_a_random_pick(self, fetch):
        fetch.return_value = server.normalize(support.sample(), 100)
        with patch('targets.pick') as pick:
            server.available_forecast(100, support.FIXED_TARGET)
        pick.assert_not_called()
        fetch.assert_called_once_with(100, support.FIXED_TARGET)


if __name__ == '__main__':
    unittest.main()
