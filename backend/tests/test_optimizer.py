import copy
from functools import partial
from http.server import ThreadingHTTPServer
import json
import random
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import test_server as support
from test_server import sample
import eligibility
import fleet as fleets
import optimizer
import server
from server import Handler, normalize


def site(**overrides):
    return dict(dict(id='s', name='Site', region='IE', hypotheticalConstraintZone=False,
                     chargers=2, chargerKw=22, sitePowerKw=100), **overrides)


def ev(vid, arrive=0, depart=120, kwh=10, kw=22, site_id='s'):
    return dict(id=vid, site=site_id, arriveMin=arrive, departMin=depart, requiredKwh=kwh, maxKw=kw)


def make_fleet(vehicles, sites=None, efficiency=1.0):
    return fleets.validate(dict(chargingEfficiency=efficiency, sites=sites or [site()], vehicles=vehicles))


def forecast(at_risk=0.5, curtailment=None, lower=None):
    result = normalize(sample(), 100)
    for p in result['predictions']:
        p.update(atRiskMwh=at_risk, curtailmentMwh=at_risk if curtailment is None else curtailment,
                 constraintMwh=at_risk - (at_risk if curtailment is None else curtailment),
                 lowerMwh=at_risk if lower is None else lower)
    return result


class UnitsAndIntervalTests(unittest.TestCase):
    def test_target_label_end_and_start(self):
        issued = '2026-01-31T22:00:00+00:00'
        self.assertEqual(optimizer.target_slot(issued, '2026-01-31T22:30:00+00:00'), 0)
        self.assertEqual(optimizer.target_slot(issued, '2026-01-31T23:00:00+00:00'), 1)
        self.assertEqual(optimizer.target_slot(issued, '2026-01-31T22:30:00+00:00', label='start'), 1)
        for bad in ('2026-01-31T22:00:00+00:00', '2026-01-31T22:45:00+00:00'):
            with self.assertRaises(ValueError):
                optimizer.target_slot(issued, bad)

    def test_dst_change_uses_utc_arithmetic(self):
        # Irish clocks go back at 01:00 UTC on 25 October 2026; UTC slots stay 30 minutes apart.
        self.assertEqual(optimizer.target_slot('2026-10-25T00:30:00+00:00', '2026-10-25T01:30:00+00:00'), 1)
        self.assertEqual(optimizer.target_slot('2026-10-25T01:30:00+01:00', '2026-10-25T01:30:00+00:00'), 1)

    def test_kw_times_half_hour_and_mwh_pools(self):
        plan = optimizer.run_policy(make_fleet([ev('a', kwh=100, kw=22)]), 4, 'arrival-order')
        self.assertEqual(plan.alloc['a'][0], 11)  # 22 kW x 0.5 h
        pools = eligibility.opportunity_pools(dict(atRiskMwh=.5, curtailmentMwh=.2, constraintMwh=.3, lowerMwh=.25), 'expected')
        self.assertEqual(pools, dict(curtailment=200, constraint=300))  # MWh x 1000

    def test_efficiency_converts_grid_to_battery_energy(self):
        result = optimizer.optimize(make_fleet([ev('a', kwh=9, depart=60)], efficiency=0.9), forecast())
        vehicle = result['alternatives'][0]['optimized']['vehicles'][0]
        self.assertTrue(vehicle['met'])
        self.assertAlmostEqual(sum(s['gridKwh'] for s in vehicle['schedule']), 10)


class HardConstraintTests(unittest.TestCase):
    def test_random_fleets_never_break_constraints(self):
        rng = random.Random(39)
        for trial in range(60):
            sites = [site(id=f's{i}', chargers=rng.randint(0, 4), chargerKw=rng.choice([7.4, 11, 22]),
                          sitePowerKw=rng.choice([0, 11, 22, 50, 200]), hypotheticalConstraintZone=rng.random() < .5)
                     for i in range(rng.randint(1, 3))]
            vehicles = []
            for i in range(rng.randint(0, 25)):
                arrive = rng.randint(-120, 300)
                vehicles.append(ev(f'v{i}', arrive, arrive + rng.randint(1, 360), rng.uniform(0, 60),
                                   rng.choice([3.7, 7.4, 11, 22]), rng.choice(sites)['id']))
            fleet = make_fleet(vehicles, sites, rng.choice([.85, .9, 1]))
            pools = dict(curtailment=rng.uniform(0, 80), constraint=rng.uniform(0, 80))
            for policy in optimizer.POLICIES:
                with self.subTest(trial=trial, policy=policy):
                    plan = optimizer.run_policy(fleet, fleets.slot_count(fleet), policy, rng.randint(0, 2), pools)
                    self.assertEqual(optimizer.check_plan(plan), [])
                    claimed = optimizer.attribute(fleet, optimizer.window_energy(plan, 0), pools)
                    self.assertLessEqual(sum(claimed.values()), sum(pools.values()) + 1e-6)

    def test_checker_catches_violations(self):
        fleet = make_fleet([ev('a', arrive=30, depart=90), ev('b'), ev('c')], [site(chargers=1, sitePowerKw=10)])
        plan = optimizer.run_policy(fleet, fleets.slot_count(fleet), 'arrival-order')
        plan.alloc['a'][0] = 1  # before arrival
        plan.alloc['b'][2] = 50  # above rate, above site power, more than required
        problems = ' '.join(optimizer.check_plan(plan))
        for text in ('not plugged in', 'vehicle/charger rate', 'more than required', 'more vehicles than chargers', 'site power'):
            self.assertIn(text, problems)

    def test_arrival_and_departure_round_inwards(self):
        vehicle = ev('a', arrive=10, depart=100)
        self.assertEqual(list(fleets.available_slots(vehicle, 10)), [1, 2])
        self.assertEqual(list(fleets.available_slots(ev('b', arrive=0, depart=29), 10)), [])
        self.assertEqual(list(fleets.available_slots(ev('c', arrive=-90, depart=60), 10)), [0, 1])


class ObjectiveTests(unittest.TestCase):
    def test_two_horizons_are_alternatives_not_summed(self):
        # The same 11 kWh can go in either window, but only once: each alternative plans it independently.
        result = optimizer.optimize(make_fleet([ev('a', kwh=11, depart=60)]), forecast())
        thirty, sixty = result['alternatives']
        self.assertEqual(thirty['optimized']['window']['claimedKwh'], 11)
        self.assertEqual(sixty['optimized']['window']['claimedKwh'], 11)
        for alternative in result['alternatives']:
            self.assertEqual(alternative['optimized']['gridKwh'], 11)
        # A car that leaves at +30 cannot use the +60 window.
        early = optimizer.optimize(make_fleet([ev('a', kwh=11, depart=30)]), forecast())
        self.assertEqual(early['alternatives'][1]['optimized']['window']['claimedKwh'], 0)
        self.assertEqual(result['selectedHorizonMinutes'], 30)
        self.assertNotIn('totalClaimedKwh', result)

    def test_optimizer_shifts_flexible_charging_into_window(self):
        # One charger; the baseline fills slot 0 on arrival, so the +60 window (slot 1) sees less.
        fleet = make_fleet([ev('a', kwh=11, depart=240), ev('b', kwh=5, depart=240)], [site(chargers=2, sitePowerKw=22)])
        sixty = optimizer.optimize(fleet, forecast())['alternatives'][1]
        self.assertLess(sixty['baseline']['window']['claimedKwh'], sixty['optimized']['window']['claimedKwh'])
        self.assertTrue(sixty['improvement']['improved'])
        self.assertEqual(sixty['optimized']['vehiclesMissed'], 0)

    def test_hard_constraints_can_block_any_improvement(self):
        fleet = fleets.preset('constrained-site')
        for alternative in optimizer.optimize(fleet, forecast(0.5))['alternatives']:
            self.assertFalse(alternative['improvement']['improved'])
            self.assertEqual(alternative['optimized']['window']['limitedBy'][0]['code'], 'site-power')
            self.assertGreater(alternative['optimized']['vehiclesMissed'], 0)

    def test_optimized_is_never_worse_than_baseline(self):
        for preset in fleets.presets()['presets']:
            for mode in eligibility.UNCERTAINTY_MODES:
                for alternative in optimizer.optimize(preset, forecast(), mode)['alternatives']:
                    self.assertLessEqual(optimizer.rank(alternative['optimized']), optimizer.rank(alternative['baseline']))

    def test_forecast_caps_the_claim(self):
        fleet = make_fleet([ev('a', kwh=50, depart=240)])
        thirty = optimizer.optimize(fleet, forecast(0.004))['alternatives'][0]
        self.assertEqual(thirty['optimized']['window']['claimedKwh'], 4)
        self.assertEqual(thirty['optimized']['window']['limitedBy'][0]['code'], 'forecast-window')

    def test_conservative_mode_uses_p10_and_reports_probability(self):
        plan = optimizer.optimize(make_fleet([ev('a', kwh=50)]), forecast(0.01, lower=0.004), 'conservative')
        opportunity = plan['alternatives'][0]['opportunity']
        self.assertEqual(opportunity['availableKwh'], 4)
        self.assertEqual(opportunity['eventProbability'], .8)
        self.assertEqual(plan['alternatives'][0]['optimized']['window']['claimedKwh'], 4)


class EdgeCaseTests(unittest.TestCase):
    def test_zero_vehicles(self):
        result = optimizer.optimize(make_fleet([]), forecast())
        self.assertEqual(result['alternatives'][0]['optimized']['status'], 'empty')
        self.assertIsNone(result['alternatives'][0]['improvement']['claimedPercent'])

    def test_zero_forecast_energy(self):
        result = optimizer.optimize(make_fleet([ev('a')]), forecast(0))
        alternative = result['alternatives'][0]
        self.assertEqual(alternative['optimized']['window']['claimedKwh'], 0)
        self.assertIsNone(alternative['improvement']['windowShareOfOpportunity'])
        self.assertTrue(alternative['optimized']['vehicles'][0]['met'])  # still charged, just not claimed

    def test_zero_requirement_and_zero_chargers(self):
        result = optimizer.optimize(make_fleet([ev('a', kwh=0), ev('b')], [site(chargers=0)]), forecast())
        vehicles = {v['id']: v for v in result['alternatives'][0]['optimized']['vehicles']}
        self.assertTrue(vehicles['a']['met'])
        self.assertEqual(vehicles['b']['limitingReason']['code'], 'chargers')

    def test_deadline_reasons(self):
        result = optimizer.optimize(make_fleet([ev('late', depart=60, kwh=40, kw=11), ev('gone', arrive=0, depart=20)]), forecast())
        vehicles = {v['id']: v for v in result['alternatives'][0]['optimized']['vehicles']}
        self.assertEqual(vehicles['late']['limitingReason']['code'], 'deadline')
        self.assertEqual(vehicles['gone']['limitingReason']['code'], 'not-connected')

    def test_invalid_fleets_rejected(self):
        good = dict(sites=[site()], vehicles=[ev('a')])
        cases = [
            lambda f: f['vehicles'][0].update(departMin=0),
            lambda f: f['vehicles'][0].update(requiredKwh=float('nan')),
            lambda f: f['vehicles'][0].update(maxKw=0),
            lambda f: f['vehicles'][0].update(site='nowhere'),
            lambda f: f['vehicles'].append(ev('a')),
            lambda f: f['sites'][0].update(chargers=1.5),
            lambda f: f['sites'][0].update(region='UK'),
            lambda f: f.update(chargingEfficiency=0),
            lambda f: f.update(sites=[]),
            lambda f: f['vehicles'][0].update(arriveMin=True),
        ]
        for index, mutate in enumerate(cases):
            with self.subTest(index=index):
                broken = copy.deepcopy(good)
                mutate(broken)
                with self.assertRaises(ValueError):
                    fleets.validate(broken)
        with self.assertRaises(ValueError):
            eligibility.opportunity_pools(dict(atRiskMwh=1, curtailmentMwh=1, constraintMwh=0, lowerMwh=1), 'optimistic')

    def test_presets_fixture_is_valid(self):
        data = fleets.presets()
        self.assertEqual(data['provenance'], 'simulated')
        for item in data['presets']:
            fleet = fleets.validate(item)
            self.assertTrue(10 <= len(fleet['vehicles']) <= 30)


class EligibilityTests(unittest.TestCase):
    def test_nothing_is_verified_eligible(self):
        for zone in (True, False):
            claims = eligibility.site_claims(site(hypotheticalConstraintZone=zone))
            self.assertEqual(claims['curtailment']['status'], 'conditional')
            self.assertEqual(claims['constraint']['status'], 'conditional' if zone else 'unknown')
            self.assertNotIn('eligible', [c['status'] for c in claims.values()])
        self.assertEqual(eligibility.site_claims(site(region='NI'))['curtailment']['status'], 'ineligible')

    def test_constraint_energy_only_claimed_at_zone_sites(self):
        # All forecast energy is constraint; only the zone site may claim it.
        sites = [site(id='zone', hypotheticalConstraintZone=True), site(id='plain')]
        fleet = make_fleet([ev('z', kwh=50, site_id='zone'), ev('p', kwh=50, site_id='plain')], sites)
        window = optimizer.optimize(fleet, forecast(0.5, curtailment=0))['alternatives'][0]['optimized']['window']
        self.assertEqual(window['chargedKwh'], 22)
        self.assertEqual(window['claimedKwh'], 11)
        self.assertEqual(window['claimedByComponent'], dict(constraint=11, curtailment=0))

    def test_outside_ireland_is_never_claimed(self):
        fleet = make_fleet([ev('a', kwh=50)], [site(region='other')])
        self.assertEqual(optimizer.optimize(fleet, forecast())['alternatives'][0]['optimized']['window']['claimedKwh'], 0)


class OptimizeRouteTests(unittest.TestCase):
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

    def setUp(self):
        server.forecast_cache.clear()

    def post(self, body, raw=None):
        data = raw if raw is not None else json.dumps(body).encode()
        request = Request(self.url + '/api/v1/charging/optimize', data=data, method='POST',
                          headers={'Content-Type': 'application/json'})
        try:
            with urlopen(request) as response:
                return response.status, json.load(response)
        except HTTPError as error:
            return error.code, json.load(error)

    @patch('server.fetch_forecast')
    def test_preset_plan_uses_server_forecast(self, fetch):
        fetch.return_value = normalize(sample(), 100)
        status, body = self.post({'preset': 'depot-and-retail', 'forecast': {'atRiskMwh': 9999}})
        self.assertEqual(status, 200)
        self.assertEqual(body['forecast']['dataMode'], 'historical-prediction')
        self.assertEqual(body['dataMode'], 'simulated-fleet-on-historical-forecast')
        self.assertEqual(body['fleet']['provenance'], 'simulated')
        self.assertEqual(body['alternatives'][0]['opportunity']['forecastAtRiskMwh'], 42)  # ignores the browser value
        self.assertIn(body['selectedHorizonMinutes'], (30, 60))
        self.assertEqual(body['fleet']['fixture'], 'demo-fleets-2026-09-27/depot-and-retail')

    @patch('server.fetch_forecast', side_effect=URLError('down'))
    def test_model_failure_is_labelled_simulated(self, fetch):
        status, body = self.post({'preset': 'constrained-site'})
        self.assertEqual(status, 200)
        self.assertTrue(body['forecast']['fallback']['active'])
        self.assertEqual(body['dataMode'], 'simulated')

    @patch('server.fetch_forecast')
    def test_custom_fleet_and_invalid_requests(self, fetch):
        fetch.return_value = normalize(sample(), 100)
        status, body = self.post({'fleet': dict(sites=[site()], vehicles=[ev('a')]), 'uncertainty': 'conservative'})
        self.assertEqual(status, 200)
        self.assertIsNone(body['fleet']['fixture'])
        for payload in ({'preset': 'nope'}, {'uncertainty': 'wild'}, {'capacityMw': 0},
                        {'fleet': dict(sites=[site()], vehicles=[ev('a', depart=-10)])}, [1, 2]):
            with self.subTest(payload=payload):
                status, body = self.post(payload)
                self.assertEqual(status, 400)
                self.assertEqual(body['error']['code'], 'INVALID_REQUEST')
        self.assertEqual(self.post(None, raw=b'{not json')[0], 400)

    def test_presets_route(self):
        with urlopen(self.url + '/api/v1/charging/presets') as response:
            body = json.load(response)
        self.assertEqual(body['provenance'], 'simulated')
        self.assertEqual([p['id'] for p in body['presets']], ['depot-and-retail', 'constrained-site'])


if __name__ == '__main__':
    unittest.main()
