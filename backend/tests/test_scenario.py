import unittest
from unittest.mock import patch
import test_server as support

setUpModule, tearDownModule = support.start_hermetic_targets, support.stop_hermetic_targets
from test_server import sample
from server import normalize
from scenario import build_day, build_scenario, validate_demand, validate_ev


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

    def test_derived_impact_scales_with_recovery(self):
        result = build_scenario(self.forecast(), 1000, 500)
        factor = result['assumptions']['gridIntensityTco2PerMwh']
        for outcome in result['outcomes']:
            self.assertAlmostEqual(outcome['avoidedEmissionsTco2'], .5 * factor)
            self.assertAlmostEqual(outcome['evRangeKm'], 500 / result['assumptions']['evKwhPerKm'])
        zero = build_scenario(self.forecast(), 0, 0)
        self.assertEqual(zero['outcomes'][0]['avoidedEmissionsTco2'], 0)

    def test_power_limits_recovery(self):
        forecast = self.forecast()
        forecast['flexibleCapacityMw'] = .1
        result = build_scenario(forecast, 1000, 500)
        self.assertEqual(result['outcomes'][0]['potentialRecoveryMwh'], .05)
        self.assertTrue(result['outcomes'][0]['powerLimitRespected'])

    def test_forecast_limits_recovery_and_best_horizon(self):
        # Separate target half-hours are alternative windows: recommend the greater recovery.
        forecast = self.forecast()
        forecast['predictions'][0]['atRiskMwh'] = .1
        forecast['predictions'][1]['atRiskMwh'] = .2
        forecast['predictions'][1]['targetAt'] = '2026-01-31T23:30:00+00:00'
        result = build_scenario(forecast, 1000, 500)
        self.assertEqual((result['recommendedHorizonMinutes'], result['recommendationBasis']), (60, 'greatest-recovery'))
        self.assertEqual(result['outcomes'][1]['potentialRecoveryMwh'], .2)

    def test_two_vintages_of_one_target_plan_on_the_most_recent_forecast(self):
        # Same half-hour from two issue times: never cherry-pick the larger (more optimistic) estimate.
        forecast = self.forecast()
        forecast['predictions'][0]['atRiskMwh'] = .1
        forecast['predictions'][1]['atRiskMwh'] = .2
        result = build_scenario(forecast, 1000, 500)
        self.assertTrue(result['sharedTarget'])
        self.assertEqual((result['recommendedHorizonMinutes'], result['recommendationBasis']), (30, 'most-recent-forecast'))
        self.assertIn('two estimates of one charging window', ' '.join(result['methodology']))

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


class EvTranslationTests(unittest.TestCase):
    def forecast(self, recovery=None):
        forecast = normalize(sample(), 100)
        if recovery is not None:
            for p in forecast['predictions']:
                p['atRiskMwh'] = recovery
        return forecast

    def outcome(self, flexible_kwh=500, **ev):
        return build_scenario(self.forecast(), 1000, flexible_kwh, **ev)['outcomes'][0]

    def test_500_kwh_is_two_separate_readings(self):
        o = self.outcome()
        self.assertAlmostEqual(o['evChargesEquivalent'], 500 / 30)  # 16.7 x 30 kWh energy equivalents
        self.assertEqual(o['minConcurrentPorts'], 46)  # 500 kWh / (22 kW x 0.5 h) = 45.5 -> 46
        self.assertEqual(o['portKwhLimit'], 11)  # one 22 kW port gives at most 11 kWh per half-hour
        self.assertAlmostEqual(o['kwhPerPort'], 500 / 46)
        self.assertLessEqual(o['kwhPerPort'], o['portKwhLimit'])

    def test_home_and_public_charger_power(self):
        self.assertEqual(self.outcome(charger_kw=7)['minConcurrentPorts'], 143)  # 500 / 3.5
        self.assertEqual(self.outcome(charger_kw=22)['minConcurrentPorts'], 46)
        self.assertEqual(self.outcome(kwh_per_charge=50)['evChargesEquivalent'], 10)

    def test_exact_port_boundary_does_not_round_up(self):
        self.assertEqual(self.outcome(flexible_kwh=440)['minConcurrentPorts'], 40)  # 440 / 11 exactly
        self.assertEqual(self.outcome(flexible_kwh=440.001)['minConcurrentPorts'], 41)

    def test_zero_and_fractional_recovery(self):
        zero = self.outcome(flexible_kwh=0)
        self.assertEqual((zero['evChargesEquivalent'], zero['minConcurrentPorts'], zero['kwhPerPort']), (0, 0, 0))
        small = self.outcome(flexible_kwh=5)
        self.assertAlmostEqual(small['evChargesEquivalent'], 5 / 30)
        self.assertEqual(small['minConcurrentPorts'], 1)

    def test_assumptions_are_echoed_and_part_of_the_id(self):
        default = build_scenario(self.forecast(), 1000, 500)
        home = build_scenario(self.forecast(), 1000, 500, kwh_per_charge=50, charger_kw=7)
        self.assertEqual(default['evAssumptions'], {'kwhPerCharge': 30, 'chargerKw': 22})
        self.assertEqual(home['outcomes'][0]['potentialRecoveryMwh'], default['outcomes'][0]['potentialRecoveryMwh'])
        self.assertNotEqual(home['id'], default['id'])

    def test_no_time_window_is_claimed(self):
        result = build_scenario(self.forecast(), 1000, 500)
        self.assertNotIn('recommendedWindow', result)
        self.assertNotIn('window', result['outcomes'][0])

    def test_day_intervals_carry_probability_for_the_charging_scatter(self):
        forecast = self.forecast()
        replay = dict(date='2026-01-31', range={}, source='test', modelVersion='test', intervalMinutes=30,
                      horizonMinutes=30, flexibleCapacityMw=100, predictions=forecast['predictions'])
        day = build_day(replay, 1000, 500)
        self.assertEqual([i['probability'] for i in day['intervals']], [.8, .8])
        self.assertNotIn('probability', day['totals'])

    def test_invalid_ev_assumptions(self):
        for kwh, kw in ((0, 22), (201, 22), (30, 0), (30, 401), (float('nan'), 22), (True, 22)):
            with self.subTest(kwh=kwh, kw=kw), self.assertRaises(ValueError):
                validate_ev(kwh, kw)


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
        fetch.assert_called_once_with(100, support.FIXED_TARGET)

    @patch('server.fetch_forecast')
    def test_ev_assumptions_pass_through(self, fetch):
        fetch.return_value = normalize(sample(), 100)
        status, body = self.get('/api/v1/scenario?totalDemandKwh=1000&flexibleDemandKwh=500&kwhPerCharge=50&chargerKw=7')
        self.assertEqual(status, 200)
        self.assertEqual(body['scenario']['evAssumptions'], {'kwhPerCharge': 50, 'chargerKw': 7})
        self.assertEqual(body['scenario']['outcomes'][0]['minConcurrentPorts'], 143)

    @patch('server.fetch_forecast')
    def test_invalid_demand_rejected_before_model_call(self, fetch):
        for query in ('totalDemandKwh=1&flexibleDemandKwh=2', 'totalDemandKwh=nan', 'flexibleDemandKwh=-1',
                      'kwhPerCharge=0', 'chargerKw=1000', 'kwhPerCharge=abc'):
            self.assertEqual(self.get('/api/v1/scenario?' + query)[0], 400)
        fetch.assert_not_called()
