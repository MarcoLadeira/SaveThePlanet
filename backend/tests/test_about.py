"""The About page's worked example must match the calculations the pages actually use."""
from functools import partial
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import sys
import threading
import unittest
from urllib.request import urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import scenario
from server import Handler


def example_forecast():
    """The example's inputs as a two-horizon forecast, run through the real scenario builder."""
    x = scenario.EXAMPLE_INPUTS
    rows = [dict(horizonMinutes=h, targetAt='2026-01-20T12:00:00+00:00', atRiskMwh=x['atRiskMwh'])
            for h in (30, 60)]
    return dict(intervalMinutes=x['intervalMinutes'], flexibleCapacityMw=x['flexibleCapacityMw'],
                dataMode='historical-prediction', source='test', predictions=rows)


class WorkedExampleTests(unittest.TestCase):
    def test_example_matches_the_scenario_builder_used_by_the_pages(self):
        x = scenario.EXAMPLE_INPUTS
        built = scenario.build_scenario(example_forecast(), x['totalDemandKwh'], x['flexibleDemandKwh'])
        outcome = built['outcomes'][0]
        steps = scenario.worked_example()['steps']
        self.assertEqual(steps['potentialRecoveryMwh'], outcome['potentialRecoveryMwh'])
        self.assertEqual(steps['chargingSessionsEquivalent'], outcome['evChargesEquivalent'])
        self.assertEqual(steps['avoidedEmissionsTco2'], outcome['avoidedEmissionsTco2'])
        self.assertEqual(steps['evRangeKm'], outcome['evRangeKm'])
        self.assertEqual(steps['remainingAtRiskMwh'], outcome['remainingWasteMwh'])

    def test_example_follows_the_documented_formulas(self):
        x, steps = scenario.EXAMPLE_INPUTS, scenario.worked_example()['steps']
        # Energy at risk = curtailment + constraints.
        self.assertEqual(steps['atRiskMwh'], x['curtailmentMwh'] + x['constraintMwh'])
        # Potential = min(at risk, flexible kWh / 1,000, capacity MW x 0.5 h).
        expected = min(steps['atRiskMwh'], x['flexibleDemandKwh'] / 1000, x['flexibleCapacityMw'] * 0.5)
        self.assertEqual(steps['potentialRecoveryMwh'], expected)
        # EV energy = MWh x 1,000; sessions = kWh / kWh per charge.
        self.assertEqual(steps['potentialKwh'], expected * 1000)
        self.assertAlmostEqual(steps['chargingSessionsEquivalent'], expected * 1000 / scenario.DEFAULT_KWH_PER_CHARGE)
        # The numbers the page shows: 42 MWh at risk -> 0.5 MWh -> 500 kWh -> about 16.7 sessions.
        self.assertEqual((steps['atRiskMwh'], steps['potentialRecoveryMwh'], steps['potentialKwh']), (42.0, 0.5, 500.0))
        self.assertAlmostEqual(steps['chargingSessionsEquivalent'], 16.67, places=2)

    def test_assumptions_come_from_the_backend_constants(self):
        a = scenario.worked_example()['assumptions']
        self.assertEqual((a['kwhPerCharge'], a['chargerKw'], a['gridIntensityTco2PerMwh'], a['evKwhPerKm'], a['chargingEfficiency']),
                         (scenario.DEFAULT_KWH_PER_CHARGE, scenario.DEFAULT_CHARGER_KW, scenario.GRID_INTENSITY_T_PER_MWH,
                          scenario.EV_KWH_PER_KM, 1.0))


class AboutHttpTests(unittest.TestCase):
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

    def test_example_endpoint_serves_the_worked_example_without_calling_the_model(self):
        with urlopen(self.url + '/api/v1/about/example') as response:
            body = json.load(response)
        self.assertEqual(body, json.loads(json.dumps(scenario.worked_example())))


if __name__ == '__main__':
    unittest.main()
