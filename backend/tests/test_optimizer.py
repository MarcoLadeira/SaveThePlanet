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

# Route tests pick a target without a model: use test_server's fixed target shortlist, never the network.
setUpModule, tearDownModule = support.start_hermetic_targets, support.stop_hermetic_targets


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
    def test_target_label_start_and_end(self):
        # V1 contract: target T labels [T, T + 30 min), counted from the plan start.
        start = '2026-01-31T22:00:00+00:00'
        self.assertEqual(optimizer.INTERVAL_LABEL, 'start')
        self.assertEqual(optimizer.target_slot(start, '2026-01-31T22:00:00+00:00'), 0)
        self.assertEqual(optimizer.target_slot(start, '2026-01-31T23:00:00+00:00'), 2)
        self.assertEqual(optimizer.target_slot(start, '2026-01-31T23:00:00+00:00', label='end'), 1)
        for bad in ('2026-01-31T21:30:00+00:00', '2026-01-31T22:45:00+00:00'):
            with self.assertRaises(ValueError):
                optimizer.target_slot(start, bad)

    def test_dst_change_uses_utc_arithmetic(self):
        # Irish clocks go back at 01:00 UTC on 25 October 2026; UTC slots stay 30 minutes apart.
        self.assertEqual(optimizer.target_slot('2026-10-25T00:30:00+00:00', '2026-10-25T01:30:00+00:00'), 2)
        self.assertEqual(optimizer.target_slot('2026-10-25T01:30:00+01:00', '2026-10-25T01:30:00+00:00'), 2)

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
    def test_two_vintages_of_one_half_hour_are_never_summed(self):
        # sample(): +60 issued 22:00 and +30 issued 22:30 both forecast 23:00-23:30 (slot 2 from 22:00).
        result = optimizer.optimize(make_fleet([ev('a', kwh=11, depart=120)]), forecast())
        thirty, sixty = result['alternatives']
        self.assertTrue(result['sharedTarget'])
        self.assertEqual(result['selectionBasis'], 'most-recent-forecast')
        self.assertEqual(result['selectedHorizonMinutes'], 30)
        self.assertEqual(result['forecast']['planStartAt'], '2026-01-31T22:00:00+00:00')
        for alternative in (thirty, sixty):
            self.assertEqual(alternative['window']['slot'], 2)
            self.assertEqual(alternative['window']['startAt'], '2026-01-31T23:00:00+00:00')
            self.assertEqual(alternative['optimized']['gridKwh'], 11)  # the same 11 kWh, planned once per estimate
        self.assertEqual(thirty['optimized']['window']['claimedKwh'], 11)
        self.assertNotIn('totalClaimedKwh', result)
        # A car that leaves when the half-hour starts cannot use it.
        early = optimizer.optimize(make_fleet([ev('a', kwh=11, depart=60)]), forecast())
        self.assertEqual(early['alternatives'][0]['optimized']['window']['claimedKwh'], 0)

    def test_distinct_targets_pick_the_best_plan(self):
        distinct = forecast()
        # An earlier, separate window: +30 issued 22:00 for 22:30 (the +60 forecast is issued 22:00 for 23:00).
        distinct['predictions'][0].update(targetAt='2026-01-31T22:30:00+00:00', issuedAt='2026-01-31T22:00:00+00:00')
        result = optimizer.optimize(make_fleet([ev('a', kwh=11, arrive=60, depart=120)]), distinct)
        self.assertFalse(result['sharedTarget'])
        self.assertEqual(result['selectionBasis'], 'best-plan')
        self.assertEqual(result['selectedHorizonMinutes'], 60)  # the car only arrives for the 23:00 window

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

    def test_optimized_never_uses_less_forecast_energy_than_baseline(self):
        for preset in fleets.presets()['presets']:
            for mode in eligibility.UNCERTAINTY_MODES:
                for alternative in optimizer.optimize(preset, forecast(), mode)['alternatives']:
                    self.assertGreaterEqual(alternative['optimized']['window']['claimedKwh'],
                                            alternative['baseline']['window']['claimedKwh'])

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
        self.assertEqual(alternative['optimized']['window']['limitedBy'][0]['code'], 'no-forecast')
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


def window_forecast(kwh, constraint_kwh=0.0):
    """Both horizons forecast `kwh` at risk in the 23:00 half-hour (slot 2 of the plan)."""
    return forecast(kwh / 1000, curtailment=(kwh - constraint_kwh) / 1000)


def selected(result):
    return result['alternatives'][0]['optimized']


class EnergyLedgerTests(unittest.TestCase):
    """Issue #50: account for every kWh from the forecast to EV batteries."""

    def assertBalances(self, ledger):
        self.assertEqual(optimizer.check_ledger(ledger), [])

    def test_exactly_ten_feasible_kwh(self):
        result = optimizer.optimize(make_fleet([ev('a', kwh=50, depart=240)], efficiency=0.9), window_forecast(10))
        ledger = result['ledger']
        self.assertEqual((ledger['eligibleOpportunityKwh'], ledger['allocatedToChargersGridKwh'],
                          ledger['unallocatedOpportunityKwh']), (10, 10, 0))
        self.assertEqual((ledger['batteryDeliveredKwh'], ledger['chargingLossKwh']), (9, 1))
        self.assertEqual((ledger['utilizationFraction'], ledger['outcome']), (1.0, 'fully-allocated'))
        self.assertEqual(ledger['unallocatedReasons'], [])
        self.assertBalances(ledger)

    def test_ten_available_eight_feasible(self):
        fleet = make_fleet([ev('a', kwh=50, depart=240)], [site(sitePowerKw=16)], efficiency=0.9)  # 16 kW x 0.5 h = 8 kWh
        ledger = optimizer.optimize(fleet, window_forecast(10))['ledger']
        self.assertEqual((ledger['allocatedToChargersGridKwh'], ledger['unallocatedOpportunityKwh']), (8, 2))
        self.assertEqual((ledger['batteryDeliveredKwh'], ledger['chargingLossKwh']), (7.2, 0.8))
        self.assertEqual((ledger['utilizationFraction'], ledger['outcome']), (0.8, 'partially-allocated'))
        self.assertEqual([r['code'] for r in ledger['unallocatedReasons']], ['site-power'])
        self.assertBalances(ledger)

    def test_ten_at_risk_but_nothing_eligible(self):
        ledger = optimizer.optimize(make_fleet([ev('a', kwh=50)], [site(region='other')]), window_forecast(10))['ledger']
        self.assertEqual((ledger['predictedAtRiskKwh'], ledger['eligibleOpportunityKwh'], ledger['notEligibleKwh']), (10, 0, 10))
        self.assertEqual((ledger['allocatedToChargersGridKwh'], ledger['outcome']), (0, 'no-opportunity'))
        self.assertIsNone(ledger['utilizationFraction'])
        self.assertEqual([r['code'] for r in ledger['notEligibleReasons']], ['no-eligible-site'])
        self.assertBalances(ledger)

    def test_ten_eligible_but_no_ev_capacity(self):
        for fleet, code in ((make_fleet([]), 'no-connected-ev'),
                            (make_fleet([ev('full', kwh=0, depart=240)]), 'vehicles-full'),
                            (make_fleet([ev('gone', depart=60)]), 'no-connected-ev')):
            with self.subTest(code=code):
                ledger = optimizer.optimize(fleet, window_forecast(10))['ledger']
                self.assertEqual((ledger['allocatedToChargersGridKwh'], ledger['unallocatedOpportunityKwh']), (0, 10))
                self.assertEqual((ledger['batteryDeliveredKwh'], ledger['outcome']), (0, 'not-allocated'))
                self.assertEqual(ledger['unallocatedReasons'][0]['code'], code)
                self.assertBalances(ledger)

    def test_one_22_kw_charger_takes_at_most_11_kwh_per_half_hour(self):
        ledger = optimizer.optimize(make_fleet([ev('a', kwh=500, depart=240)]), window_forecast(1000))['ledger']
        self.assertEqual(ledger['allocatedToChargersGridKwh'], 11)
        self.assertEqual(ledger['unallocatedOpportunityKwh'], 989)

    def test_equal_share_between_all_cars(self):
        # 60 kWh at risk, 60 cars each needing 1 kWh in the battery: at 100% efficiency every car gets exactly 1 kWh.
        sixty = [ev(f'c{i:02}', kwh=1, depart=240) for i in range(60)]
        wide = site(chargers=100, sitePowerKw=1000)
        result = optimizer.optimize(make_fleet(sixty, [wide]), window_forecast(60))
        shares = selected(result)['opportunityAllocations']
        self.assertEqual([s['gridKwh'] for s in shares], [1] * 60)
        self.assertEqual(result['ledger']['outcome'], 'fully-allocated')
        # At 90% each car needs 1.111 grid kWh, so the 60 kWh is split equally: 1 grid kWh = 0.9 kWh in each battery.
        result = optimizer.optimize(make_fleet(sixty, [wide], efficiency=0.9), window_forecast(60))
        self.assertEqual({(s['gridKwh'], s['batteryKwh']) for s in selected(result)['opportunityAllocations']}, {(1, 0.9)})
        self.assertEqual((result['ledger']['batteryDeliveredKwh'], result['ledger']['chargingLossKwh']), (54, 6))
        # 70 cars: everyone gets the same 60/70 kWh, nobody is left out.
        seventy = [ev(f'c{i:02}', kwh=1, depart=240) for i in range(70)]
        shares = selected(optimizer.optimize(make_fleet(seventy, [wide]), window_forecast(60)))['opportunityAllocations']
        self.assertEqual(len(shares), 70)
        for share in shares:  # equal to within the 1 Wh needed for the rows to add up to exactly 60
            self.assertAlmostEqual(share['gridKwh'], 60 / 70, delta=0.001)
        self.assertEqual(round(sum(s['gridKwh'] for s in shares), 3), 60)

    def test_full_or_slow_cars_leave_their_share_to_the_others(self):
        # 30 kWh; one car only needs 2 kWh and one can only take 3.7 kWh (7.4 kW): the other three share the rest.
        cars = [ev('small', kwh=2, depart=240), ev('slow', kwh=50, kw=7.4, depart=240)] + \
               [ev(f'big{i}', kwh=50, depart=240) for i in range(3)]
        result = optimizer.optimize(make_fleet(cars, [site(chargers=5, sitePowerKw=500)]), window_forecast(30))
        shares = {s['vehicle']: s['gridKwh'] for s in selected(result)['opportunityAllocations']}
        self.assertEqual((shares['small'], shares['slow']), (2, 3.7))
        self.assertEqual({shares[f'big{i}'] for i in range(3)}, {round((30 - 2 - 3.7) / 3, 3)})
        self.assertEqual(result['ledger']['allocatedToChargersGridKwh'], 30)

    def test_constraint_energy_without_a_zone_site_is_not_eligible(self):
        ledger = optimizer.optimize(make_fleet([ev('a', kwh=50, depart=240)]), window_forecast(10, constraint_kwh=6))['ledger']
        self.assertEqual((ledger['eligibleOpportunityKwh'], ledger['notEligibleKwh']), (4, 6))
        self.assertEqual([r['code'] for r in ledger['notEligibleReasons']], ['constraint-not-claimable'])
        self.assertBalances(ledger)

    def test_vintages_of_one_half_hour_each_get_their_own_ledger(self):
        result = optimizer.optimize(make_fleet([ev('a', kwh=50, depart=240)]), window_forecast(10))
        for alternative in result['alternatives']:
            self.assertEqual(alternative['optimized']['ledger']['allocatedToChargersGridKwh'], 10)
        self.assertEqual(result['ledger'], result['alternatives'][0]['optimized']['ledger'])  # +30, never 20

    def test_charge_state_carries_across_half_hours(self):
        # 12 battery kWh needed; the window takes 11 first, so only 1 more is charged in the other half-hours.
        vehicle = selected(optimizer.optimize(make_fleet([ev('a', kwh=12, depart=240)]), window_forecast(100)))['vehicles'][0]
        self.assertEqual(sum(s['gridKwh'] for s in vehicle['schedule']), 12)
        self.assertEqual([s['gridKwh'] for s in vehicle['schedule'] if s['inWindow']], [11])

    def test_invalid_forecasts_are_refused(self):
        for mutate in (lambda p: p.update(atRiskMwh=-1), lambda p: p.update(curtailmentMwh=float('nan')),
                       lambda p: p.update(curtailmentMwh=p['curtailmentMwh'] + 1),
                       lambda p: p.update(issuedAt='2026-01-31T22:45:00+00:00'), lambda p: p.pop('lowerMwh')):
            broken = window_forecast(10)
            mutate(broken['predictions'][0])
            with self.subTest(prediction=broken['predictions'][0]), self.assertRaises(optimizer.ForecastError):
                optimizer.optimize(make_fleet([ev('a')]), broken)

    def test_same_inputs_give_identical_results(self):
        runs = [json.dumps(optimizer.optimize(fleets.preset('depot-and-retail'), forecast(), 'expected', 'x'), sort_keys=True)
                for _ in range(3)]
        self.assertEqual(len(set(runs)), 1)

    def test_rounding_neither_forces_nor_breaks_100_percent(self):
        almost = optimizer.energy_ledger(100_000, 100_000, 99_999, 0.9, [], [])
        self.assertEqual((almost['utilizationFraction'], almost['outcome']), (0.99999, 'partially-allocated'))
        self.assertBalances(almost)
        noise = optimizer.energy_ledger(10, 10, 9.99999999999, 0.9, [], [])
        self.assertEqual((noise['utilizationFraction'], noise['outcome'], noise['unallocatedOpportunityKwh']),
                         (1.0, 'fully-allocated', 0))
        self.assertBalances(noise)
        odd = optimizer.energy_ledger(10, 10, 3.3333333, 0.9, [], [])  # 1 Wh rounding still balances exactly
        self.assertBalances(odd)

    def test_ledger_checker_catches_invented_or_lost_energy(self):
        good = optimizer.energy_ledger(15, 10, 8, 0.9, [], [])
        for key, value, text in (('allocatedToChargersGridKwh', 12, 'eligible opportunity !='),
                                 ('batteryDeliveredKwh', 8, 'delivered into batteries + charging loss'),
                                 ('eligibleOpportunityKwh', 20, 'exceeds the predicted'),
                                 ('unallocatedOpportunityKwh', -2, 'non-negative'),
                                 ('chargingLossKwh', float('inf'), 'finite'), ('unit', 'MWh', 'unit')):
            with self.subTest(key=key):
                self.assertTrue(any(text in p for p in optimizer.check_ledger(dict(good, **{key: value}))))
        shares = {'a': 5, 'b': 2}
        self.assertIn('per-vehicle', ' '.join(optimizer.check_ledger(good, shares)))

    def test_random_fleets_always_balance(self):
        rng = random.Random(50)
        for trial in range(80):
            sites = [site(id=f's{i}', chargers=rng.randint(0, 6), chargerKw=rng.choice([7.4, 11, 22, 50]),
                          sitePowerKw=rng.choice([0, 11, 22, 60, 300]), region=rng.choice(['IE', 'IE', 'other']),
                          hypotheticalConstraintZone=rng.random() < .5) for i in range(rng.randint(1, 3))]
            cars = [ev(f'v{i}', a := rng.randint(-60, 120), a + rng.randint(1, 300), rng.uniform(0, 60),
                       rng.choice([3.7, 7.4, 11, 22]), rng.choice(sites)['id']) for i in range(rng.randint(0, 30))]
            fleet = make_fleet(cars, sites, rng.choice([.85, .9, 1]))
            kwh = rng.choice([0, rng.uniform(0, 5), rng.uniform(0, 300), rng.uniform(0, 30_000)])
            with self.subTest(trial=trial):
                result = optimizer.optimize(fleet, window_forecast(kwh, kwh * rng.random()), rng.choice(['expected', 'conservative']))
                for alternative in result['alternatives']:
                    for plan in (alternative['baseline'], alternative['optimized']):
                        self.assertBalances(plan['ledger'])
                    shares, ledger = alternative['optimized']['opportunityAllocations'], alternative['optimized']['ledger']
                    # Per-vehicle rows add up to the ledger exactly (in Wh), after rounding.
                    for field, total in (('gridKwh', 'allocatedToChargersGridKwh'), ('batteryKwh', 'batteryDeliveredKwh'),
                                         ('lossKwh', 'chargingLossKwh')):
                        self.assertEqual(round(sum(s[field] for s in shares) * 1000), round(ledger[total] * 1000))


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
        # Issue #50: one auditable, self-consistent result for every page.
        self.assertEqual((body['unit'], body['networkEligibility']), ('kWh', 'unverified'))
        self.assertIn('network eligibility unverified', body['status'])
        self.assertTrue(body['intervalId'].startswith(body['forecast']['targetAt']))
        self.assertEqual(body['forecast']['horizonMinutes'], body['selectedHorizonMinutes'])
        self.assertEqual(optimizer.check_ledger(body['ledger']), [])
        self.assertEqual(body['ledger']['predictedAtRiskKwh'], 42_000)
        self.assertEqual(body['ledger']['allocatedToRealStorageKwh'], 0)
        self.assertEqual(optimizer.check_ledger(body['baselineLedger']), [])

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
