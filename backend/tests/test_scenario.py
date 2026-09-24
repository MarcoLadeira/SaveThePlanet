import unittest
from unittest.mock import patch
import test_server as support
from test_server import sample
from server import normalize
from scenario import build_scenario, validate_demand


class ScenarioTests(unittest.TestCase):
    def forecast(self):
        return normalize(sample(), 100)

    def test_demand_limits_recovery_and_accounts_for_energy(self):
        result = build_scenario(self.forecast(), 1000, 500)
        for outcome in result['outcomes']:
            self.assertEqual(outcome['potentialRecoveryMwh'], .5)
            self.assertEqual(outcome['remainingDemandMwh'], .5)
            self.assertEqual(outcome['proposedPowerMw'], 1)
            self.assertAlmostEqual(outcome['atRiskMwh'], outcome['potentialRecoveryMwh'] + outcome['remainingWasteMwh'])
            self.assertEqual(outcome['cleanChargingShare'], .5)
        self.assertEqual(result['recommendedHorizonMinutes'], 30)
        self.assertIsNone(result['commitmentsMet'])

    def test_power_limits_recovery(self):
        forecast = self.forecast()
        forecast['flexibleCapacityMw'] = .1
        result = build_scenario(forecast, 1000, 500)
        self.assertEqual(result['outcomes'][0]['potentialRecoveryMwh'], .05)
        self.assertTrue(result['outcomes'][0]['powerLimitRespected'])

    def test_forecast_limits_recovery_and_best_horizon(self):
        forecast = self.forecast()
        forecast['predictions'][0]['atRiskMwh'] = .1
        forecast['predictions'][1]['atRiskMwh'] = .2
        result = build_scenario(forecast, 1000, 500)
        self.assertEqual(result['recommendedHorizonMinutes'], 60)
        self.assertEqual(result['outcomes'][1]['potentialRecoveryMwh'], .2)

    def test_zero_demand_or_surplus(self):
        result = build_scenario(self.forecast(), 0, 0)
        self.assertIsNone(result['recommendedHorizonMinutes'])
        self.assertIsNone(result['outcomes'][0]['cleanChargingShare'])
        forecast = self.forecast()
        for p in forecast['predictions']:
            p['atRiskMwh'] = 0
        result = build_scenario(forecast, 1000, 500)
        self.assertIsNone(result['outcomes'][0]['recoveryRate'])
        self.assertEqual(result['outcomes'][0]['potentialRecoveryMwh'], 0)
        self.assertIsNone(result['recommendedHorizonMinutes'])

    def test_invalid_demand(self):
        for total, flexible in [(1, 2), (-1, 0), (1, -1), (float('nan'), 0), (1, float('inf')), (1e10, 1)]:
            with self.subTest(total=total, flexible=flexible), self.assertRaises(ValueError):
                validate_demand(total, flexible)

    def test_identity_stable_but_changes_with_assumptions(self):
        first = build_scenario(self.forecast(), 1000, 500)
        self.assertEqual(first['id'], build_scenario(self.forecast(), 1000, 500)['id'])
        self.assertNotEqual(first['id'], build_scenario(self.forecast(), 1000, 100)['id'])


class ScenarioHttpTests(unittest.TestCase):
    setUpClass = classmethod(support.HttpTests.setUpClass.__func__)
    tearDownClass = classmethod(support.HttpTests.tearDownClass.__func__)
    get = support.HttpTests.get

    @patch('server.fetch_forecast')
    def test_shared_response(self, fetch):
        fetch.return_value = normalize(sample(), 100)
        status, body = self.get('/api/v1/scenario?totalDemandKwh=1000&flexibleDemandKwh=500')
        self.assertEqual(status, 200)
        self.assertEqual(body['scenario']['outcomes'][0]['potentialRecoveryMwh'], .5)
        self.assertEqual(body['predictions'][0]['atRiskMwh'], body['scenario']['outcomes'][0]['atRiskMwh'])
        fetch.assert_called_once_with(100)

    @patch('server.fetch_forecast')
    def test_invalid_demand_rejected_before_model_call(self, fetch):
        for query in ('totalDemandKwh=1&flexibleDemandKwh=2', 'totalDemandKwh=nan', 'flexibleDemandKwh=-1'):
            self.assertEqual(self.get('/api/v1/scenario?' + query)[0], 400)
        fetch.assert_not_called()
