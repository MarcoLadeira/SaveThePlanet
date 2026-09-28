"""Smoke test: the hosted GridToEv deployment supports every route the Forecast page uses.

Opt-in because it calls the real service (slow, needs the API key):

    GRID_TO_EV_SMOKE=1 python -m unittest backend/tests/test_hosted_smoke.py -v

Uses GRID_TO_EV_API_BASE_URL / GRID_TO_EV_API_KEY from the environment or the root .env.
"""
from pathlib import Path
import os
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from config import load_env

load_env(Path(__file__).resolve().parents[2] / '.env')
import explorer

ENABLED = os.environ.get('GRID_TO_EV_SMOKE') == '1' and bool(os.environ.get('GRID_TO_EV_API_KEY'))


@unittest.skipUnless(ENABLED, 'Set GRID_TO_EV_SMOKE=1 and GRID_TO_EV_API_KEY to run against the hosted model')
class HostedRouteSmokeTests(unittest.TestCase):
    """Each test exercises real upstream routes through the same code the page uses."""

    @classmethod
    def setUpClass(cls):
        explorer._cache.clear()
        # /model-info, /dataset/info, /dataset/available-times (+ window route if verification needs it)
        cls.v1 = explorer.short_term_info()
        # /model-info/daily-curtailment, /dataset/daily-curtailment/coverage
        cls.v2 = explorer.daily_info()

    def test_v1_info_and_verified_issue_times(self):
        dataset = self.v1['dataset']
        self.assertEqual(dataset['count'], dataset['reportedCount'])
        self.assertIn(dataset['verification'], ('listed', 'count', 'replay'))
        self.assertEqual(self.v1['times'], sorted(set(self.v1['times'])))
        self.assertTrue(self.v1['model']['partitions'])
        self.assertTrue(self.v1['model']['caveats'])

    def test_v1_target_prediction_with_actual(self):
        # /predict/from-dataset (both horizons) + /actuals/v1/batch
        times = set(self.v1['times'])
        target = next(t for t in reversed(self.v1['times'])
                      if explorer.iso(explorer.utc(t) + explorer.timedelta(minutes=30)) in times)
        target = explorer.iso(explorer.utc(target) + explorer.timedelta(minutes=30))
        result = explorer.short_term_predict(target, 100)
        self.assertEqual({p['horizonMinutes'] for p in result['predictions']}, {30, 60})
        self.assertTrue(all(p['targetAt'] == target for p in result['predictions']))
        self.assertIn(result['actual']['status'], ('available', 'pending', 'missing'))

    def test_v1_day_replay_is_target_aligned(self):
        # /predict/window/from-dataset per horizon + /actuals/v1/batch
        day = self.v1['times'][len(self.v1['times']) // 2][:10]
        replay = explorer.short_term_day(day, 30)
        self.assertEqual(len(replay['observed']), 48)
        self.assertTrue(replay['points'])
        self.assertTrue(all(p['targetAt'].startswith(day) for p in replay['points']))

    def test_dataset_missing_404_is_recognised(self):
        # The final issue time has no +60 row; the model must answer with its dataset-missing code.
        with self.assertRaises(explorer.HTTPError) as caught:
            explorer.call('/predict/from-dataset', {'issue_timestamp_utc': self.v1['times'][-1], 'forecast_horizon_minutes': 60})
        self.assertTrue(explorer.missing_row(caught.exception), caught.exception.model_detail)

    def test_v2_day_prediction_and_week(self):
        # /predict/curtailment/day + /actuals/daily-curtailment
        day = self.v2['dataset']['to']
        result = explorer.daily_predict(day)
        self.assertEqual(result['date'], day)
        self.assertTrue(0 <= result['probability'] <= 1)
        self.assertIn(result['actual']['status'], ('available', 'pending', 'missing'))
        week = explorer.daily_week(self.v2['dataset']['from'])
        self.assertEqual(len(week['days']), 7)
        self.assertEqual(week['days'][0]['date'], self.v2['dataset']['from'])
        self.assertTrue(self.v2['model']['caveats'])


if __name__ == '__main__':
    unittest.main()
