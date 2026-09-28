from io import BytesIO
from pathlib import Path
import random
import sys
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server
import targets
import test_server as support

POPULATION = [f'2026-01-{d:02d}T{h:02d}:00:00Z' for d in range(2, 30) for h in (3, 9, 15, 21)]


def forecast(target, mwh):
    return {'targetAt': target, 'predictions': [{'atRiskMwh': mwh}, {'atRiskMwh': mwh}]}


def missing_row_error():
    error = HTTPError('http://model', 404, 'Not Found', {}, BytesIO(b'{}'))
    error.model_detail = {'error': 'dataset_timestamp_not_available'}
    return error


class SelectionTests(unittest.TestCase):
    def setUp(self):
        patcher = patch('targets.dataset_targets', return_value=POPULATION)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_targets_need_both_horizon_rows(self):
        times = ['2026-01-14T14:00:00Z', '2026-01-14T14:30:00Z', '2026-01-14T16:00:00Z', '2026-01-14T16:30:00Z']
        # 15:00 (issued 14:30 / 14:00) and 17:00 (16:30 / 16:00) qualify; 14:30 and 16:30 lack a +60 issue time.
        self.assertEqual(targets.both_horizon_targets(times), ['2026-01-14T15:00:00Z', '2026-01-14T17:00:00Z'])

    def test_selection_never_looks_at_observed_outcomes(self):
        with patch('explorer._v1_actuals', side_effect=AssertionError('observed outcomes must not be used')), \
                patch('explorer.call', side_effect=AssertionError('only the injected fetch may be used')):
            result = targets.pick(100, lambda c, t: forecast(t, 50.0), rng=random.Random(1))
        self.assertFalse(result['selection']['usesObservedOutcomes'])
        self.assertIn('predictions only', result['selection']['note'])

    def test_candidates_are_a_uniform_sample_of_the_whole_dataset(self):
        seen = []
        for seed in range(200):
            targets.pick(1, lambda c, t: (seen.append(t), forecast(t, 50.0))[1], rng=random.Random(seed))
        self.assertGreater(len(set(seen)), len(POPULATION) * 0.6)  # no shortlist: most of the population appears

    def test_keeps_the_first_candidate_predicted_above_the_threshold(self):
        order = POPULATION[:targets.MAX_ATTEMPTS]
        predicted = {t: 0.0 for t in POPULATION}
        predicted[order[3]] = 45.0
        calls = []

        def fetch(capacity, target):
            calls.append(target)
            return forecast(target, predicted[target])
        rng = random.Random(0)
        with patch.object(rng, 'sample', return_value=order):
            result = targets.pick(100, fetch, rng=rng)
        self.assertEqual(result['targetAt'], order[3])
        self.assertEqual(calls, order[:4])
        self.assertTrue(result['selection']['metThreshold'])

    def test_below_threshold_is_reported_not_claimed(self):
        values = {t: 3.0 for t in POPULATION}
        values[POPULATION[5]] = 9.0
        rng = random.Random(0)
        with patch.object(rng, 'sample', return_value=POPULATION[:targets.MAX_ATTEMPTS]):
            result = targets.pick(100, lambda c, t: forecast(t, values[t]), rng=rng)
        self.assertEqual(result['targetAt'], POPULATION[5])
        self.assertFalse(result['selection']['metThreshold'])
        self.assertEqual(result['selection']['attempts'], targets.MAX_ATTEMPTS)
        self.assertIn('No sampled half-hour reached', result['selection']['note'])

    def test_zero_prediction_everywhere_still_returns_an_honest_result(self):
        result = targets.pick(100, lambda c, t: forecast(t, 0.0), rng=random.Random(2))
        self.assertFalse(result['selection']['metThreshold'])

    def test_candidate_errors_skip_that_candidate(self):
        rng = random.Random(0)
        order = POPULATION[:targets.MAX_ATTEMPTS]
        errors = {order[0]: missing_row_error(), order[1]: ValueError('bad row')}

        def fetch(capacity, target):
            if target in errors:
                raise errors[target]
            return forecast(target, 30.0)
        with patch.object(rng, 'sample', return_value=order):
            result = targets.pick(100, fetch, rng=rng)
        self.assertEqual((result['targetAt'], result['selection']['attempts']), (order[2], 3))

    def test_model_outage_is_raised_not_skipped(self):
        def fetch(capacity, target):
            raise URLError('down')
        with self.assertRaises(URLError):
            targets.pick(100, fetch, rng=random.Random(0))

    def test_every_candidate_failing_raises(self):
        def fetch(capacity, target):
            raise ValueError('bad')
        with self.assertRaises(ValueError):
            targets.pick(100, fetch, rng=random.Random(0))

    def test_unfiltered_mode_takes_one_random_target_whatever_its_prediction(self):
        calls = []
        result = targets.pick(100, lambda c, t: (calls.append(t), forecast(t, 0.0))[1], mode='unfiltered',
                              rng=random.Random(3))
        self.assertEqual(len(calls), 1)
        self.assertEqual(result['selection']['mode'], 'unfiltered')
        self.assertIn('whatever its predicted energy', result['selection']['note'])

    def test_later_pinned_requests_keep_the_selection_record(self):
        result = targets.pick(100, lambda c, t: forecast(t, 50.0), rng=random.Random(4))
        self.assertEqual(targets.selection_for(result['targetAt'])['mode'], 'predicted')
        self.assertEqual(targets.selection_for('2020-01-01T00:00:00Z')['mode'], 'pinned')


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
    def test_given_target_is_fetched_directly_without_a_new_pick(self, fetch):
        fetch.return_value = server.normalize(support.sample(), 100)
        with patch('targets.pick') as pick:
            server.available_forecast(100, support.FIXED_TARGET)
        pick.assert_not_called()
        fetch.assert_called_once_with(100, support.FIXED_TARGET)


if __name__ == '__main__':
    unittest.main()
