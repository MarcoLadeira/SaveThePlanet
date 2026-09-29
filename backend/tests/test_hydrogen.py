"""Beyond EVs (issue #76): eligible energy to EVs first, then a hypothetical electrolyser; conservation, limits,
unit conversion, the EV-growth stages, bad inputs and the API."""
from datetime import date, datetime, timedelta, timezone
from functools import partial
from http.server import ThreadingHTTPServer
import json
import math
import os
from pathlib import Path
import sys
import threading
import time
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import business
import hydrogen
import offers
import optimizer
import storage
from server import Handler
from tests.test_business import META, NO_SEASON, iso, slot_of

NO_EVS = ({'id': 'none', 'sites': {}},)
CAP = hydrogen.PLANT['ratedKw'] * hydrogen.SLOT_HOURS  # 500 kWh per half-hour
ACCESS = hydrogen.ACCESS['kw'] * hydrogen.SLOT_HOURS  # 750 kWh per half-hour
DAYTIME = list(range(slot_of(12), slot_of(16)))  # 12:00-16:00: no EV plugged in, the hub battery never charges then
OVERNIGHT = list(range(slot_of(0), slot_of(5)))  # 00:00-05:00: depot vans plugged in, night tariff
FILL = storage.DEFAULT['capacityKwh'] * (1 - storage.DEFAULT['startFraction']) / storage.DEFAULT['chargeEfficiency']  # 6,666.7 kWh
# The electrolyser alone: the Dashboard's grid battery already full, so every surplus kWh reaches the plant.
FULL_BATTERY = partial(patch.object, hydrogen, 'GRID_BATTERY', {**storage.DEFAULT, 'startFraction': 1.0})


def week(days=3, start='2026-01-26', kwh=100_000.0, slots=None, observed=None, plus60=False, drop=()):
    """Nights from `start` (a Monday by default): `kwh` of forecast curtailment in `slots` (every slot if None),
    or kwh(k, i) per night k and slot i. Observed matches the forecast unless given as observed(k, i)."""
    nights = []
    for k in range(days):
        day = (date.fromisoformat(start) + timedelta(days=k)).isoformat()
        cells = business.night_slots(day)
        forecasts, seen = [], {}
        for i, s in enumerate(cells):
            value = kwh(k, i) if callable(kwh) else (kwh if slots is None or i in slots else 0.0)
            target = datetime.fromisoformat(s['start'].replace('Z', '+00:00'))
            if (k, i) not in drop:
                forecasts.append({'targetAt': s['start'], 'issuedAt': iso(target - timedelta(minutes=30)),
                                  'curtailmentKwh': value, 'probability': 0.9 if value else 0.1})
            if plus60:  # a second, different estimate of the same half-hour: never added
                forecasts.append({'targetAt': s['start'], 'issuedAt': iso(target - timedelta(minutes=60)),
                                  'curtailmentKwh': value * 3 + 1000.0, 'probability': 0.5})
            seen[s['start']] = value if observed is None else observed(k, i)
        nights.append({'date': day, 'index': k, 'slots': cells, 'forecasts': forecasts, 'observed': seen})
    return nights


def stage(block, stage_id=None):
    return next(s for s in block['stages'] if stage_id is None or s['id'] == stage_id)


def assert_balances(test, block):
    """Every published half-hour and every week ledger adds up: eligible = hub + EVs + grid battery + electrolyser + unused."""
    eligible, hub = block['slots']['eligibleKwh'], block['slots']['hubKwh']
    for s in block['stages']:
        series = s['series']
        for t, pool in enumerate(eligible):
            parts = hub[t] + series['ev'][t] + series['battery'][t] + series['hydrogen'][t] + series['unused'][t]
            test.assertAlmostEqual(parts, pool, delta=0.3, msg=f'{s["id"]} half-hour {t}')
            test.assertTrue(min(hub[t], series['ev'][t], series['battery'][t], series['hydrogen'][t], series['unused'][t]) >= 0)
            test.assertLessEqual(series['hydrogen'][t], CAP + 0.05)
        test.assertEqual(optimizer.check_ledger(s['ledger']), [])
        test.assertEqual(hydrogen.check_hydrogen(s['ledger']), [])
        t = s['totals']
        test.assertAlmostEqual(t['hubKwh'] + t['batteryKwh'] + t['evKwh'] + t['hydrogenKwh'] + t['unusedKwh'], t['eligibleKwh'], delta=2e-3)


class ConservationTests(unittest.TestCase):
    def test_every_half_hour_of_every_stage_balances(self):
        # Surplus on and off through day and night, over a week, with the default three stages.
        block = hydrogen.build(week(7, kwh=lambda k, i: [0.0, 300.0, 5_000.0, 80_000.0][(i // 5 + k) % 4]))
        self.assertEqual(block['checks']['problems'], 0)
        self.assertEqual(block['checks']['halfHours'], 7 * 48 * 3)
        assert_balances(self, block)
        self.assertEqual([s['totals']['eligibleKwh'] for s in block['stages']], [block['forecast']['eligibleKwh']] * 3,
                         'one eligible pool for every stage')

    def test_eligible_energy_is_the_forecast_capped_by_the_network_access(self):
        block = hydrogen.build(week(2, kwh=lambda k, i: 90_000.0 if i % 2 else 400.0), stages=NO_EVS)
        for f, pool in zip(block['slots']['forecastKwh'], block['slots']['eligibleKwh']):
            self.assertEqual(pool, min(f, ACCESS))
        f = block['forecast']
        self.assertAlmostEqual(f['atRiskKwh'], 2 * 24 * (90_000 + 400), delta=0.1)
        self.assertAlmostEqual(f['eligibleKwh'], 2 * 24 * (750 + 400), delta=0.1)
        self.assertEqual([n['code'] for n in f['notEligible']], ['beyond-access'])
        self.assertAlmostEqual(f['notEligibleKwh'], f['atRiskKwh'] - f['eligibleKwh'], delta=0.2)
        self.assertEqual(block['access']['status'], 'conditional', 'curtailment is system-wide: never verified')

    def test_overlapping_forecasts_are_never_added(self):
        plain = hydrogen.build(week(2, kwh=lambda k, i: 1_000.0 * (i % 7)))
        both = hydrogen.build(week(2, kwh=lambda k, i: 1_000.0 * (i % 7), plus60=True))
        self.assertEqual(both['slots']['eligibleKwh'], plain['slots']['eligibleKwh'])
        self.assertEqual(both['forecast'], plain['forecast'])
        self.assertEqual([s['totals'] for s in both['stages']], [s['totals'] for s in plain['stages']])

    def test_a_missing_forecast_is_no_opportunity(self):
        block = hydrogen.build(week(1, kwh=1_000.0, drop={(0, 3), (0, 4)}), stages=NO_EVS)
        self.assertEqual(block['slots']['forecastKwh'][3:5], [None, None])
        self.assertEqual(block['slots']['eligibleKwh'][3:5], [0.0, 0.0])
        self.assertEqual(block['forecast']['halfHoursWithForecast'], 46)


class ElectrolyserTests(unittest.TestCase):
    @FULL_BATTERY()
    def test_kg_is_input_over_kwh_per_kg_never_100_percent(self):
        nights = week(1, kwh=500.0, slots=range(11))  # 11 half-hours of 500 kWh, no EVs: 5,500 kWh in
        s = stage(hydrogen.build(nights, stages=NO_EVS))
        self.assertEqual((s['totals']['hydrogenKwh'], s['totals']['hydrogenKg']), (5500.0, 100.0))
        self.assertAlmostEqual(s['totals']['hydrogenEnergyKwh'], 100 * hydrogen.LHV_KWH_PER_KG, delta=0.1)
        self.assertGreater(s['totals']['conversionLossKwh'], 0.35 * 5500, 'converting loses about 40% at 55 kWh/kg')
        self.assertLess(s['totals']['hydrogenKg'], 5500 / hydrogen.HHV_KWH_PER_KG, 'never at 100% efficiency')
        leaner = stage(hydrogen.build(nights, overrides={'kwhPerKg': 50.0}, stages=NO_EVS))
        self.assertEqual(leaner['totals']['hydrogenKg'], 110.0)
        self.assertEqual(leaner['totals']['hydrogenKwh'], 5500.0, 'the energy taken does not depend on the conversion')

    @FULL_BATTERY()
    def test_plant_capacity_binds_and_the_leftover_stays_unused(self):
        s = stage(hydrogen.build(week(2, kwh=200_000.0), stages=NO_EVS))  # high surplus all day and night
        hub = sum(hydrogen.build(week(2, kwh=200_000.0), stages=NO_EVS)['slots']['hubKwh'])
        self.assertEqual(max(s['series']['hydrogen']), CAP)
        self.assertEqual(s['hydrogen']['utilisation'], 1.0)
        self.assertAlmostEqual(s['totals']['unusedKwh'], 96 * ACCESS - 96 * CAP - hub, delta=0.5)
        self.assertGreater(s['totals']['unusedKwh'], 0, 'finite capacity: never a false total recovery')
        self.assertEqual(s['unusedReasons'][0]['code'], 'plant-at-capacity')
        self.assertLess(s['shares']['hydrogen'], 1)

    @FULL_BATTERY()
    def test_minimum_stable_load(self):
        low = stage(hydrogen.build(week(1, kwh=40.0, slots=DAYTIME), stages=NO_EVS))  # below 10% of 500 kWh
        self.assertEqual(low['totals']['hydrogenKwh'], 0.0)
        self.assertEqual([r['code'] for r in low['unusedReasons']], ['below-minimum-load'])
        ok = stage(hydrogen.build(week(1, kwh=60.0, slots=DAYTIME), stages=NO_EVS))
        self.assertEqual(ok['totals']['hydrogenKwh'], 60.0 * len(DAYTIME))

    @FULL_BATTERY()
    def test_no_hydrogen_buyer_and_a_daily_offtake(self):
        nights = week(2, kwh=5_000.0, slots=DAYTIME)
        none = stage(hydrogen.build(nights, overrides={'offtakeKgPerDay': 0.0}, stages=NO_EVS))
        self.assertEqual((none['totals']['hydrogenKwh'], none['totals']['hydrogenKg']), (0.0, 0.0))
        self.assertEqual([r['code'] for r in none['unusedReasons']], ['no-offtake'])
        some = stage(hydrogen.build(nights, overrides={'offtakeKgPerDay': 20.0}, stages=NO_EVS))
        self.assertAlmostEqual(some['totals']['hydrogenKg'], 2 * 20.0, delta=1e-3, msg='20 kg a day, two days')
        self.assertIn('offtake-met', [r['code'] for r in some['unusedReasons']])

    def test_switching_hydrogen_off_keeps_the_evs_and_shows_the_remainder(self):
        nights = week(3, kwh=lambda k, i: 60_000.0 if i % 3 else 0.0)
        on = hydrogen.build(nights)
        off = hydrogen.build(nights, overrides={'plant': 'off'})
        for a, b in zip(on['stages'], off['stages']):
            self.assertEqual(a['series']['ev'], b['series']['ev'], 'EV allocation does not depend on the electrolyser')
            self.assertEqual(b['totals']['hydrogenKwh'], 0.0)
            self.assertAlmostEqual(b['totals']['unusedKwh'], a['totals']['unusedKwh'] + a['totals']['hydrogenKwh'], delta=0.01)
            self.assertEqual({r['code'] for r in b['unusedReasons']}, {'hydrogen-off'})
        assert_balances(self, off)

    def test_no_network_access(self):
        nights = week(2, kwh=80_000.0)
        blocked = hydrogen.build(nights, overrides={'accessKw': 0.0})
        self.assertEqual(blocked['forecast']['eligibleKwh'], 0.0)
        self.assertEqual([n['code'] for n in blocked['forecast']['notEligible']], ['no-access'])
        for s in blocked['stages']:
            self.assertEqual((s['totals']['evTotalKwh'], s['totals']['hydrogenKwh'], s['totals']['unusedKwh']), (0.0, 0.0, 0.0))
            self.assertIsNone(s['shares']['hydrogen'])
        plant = hydrogen.build(nights, overrides={'networkAccess': 'none'})
        self.assertEqual(sum(s['totals']['hydrogenKwh'] for s in plant['stages']), 0.0)
        self.assertEqual(stage(plant)['unusedReasons'][0]['code'], 'plant-no-access')

    @FULL_BATTERY()
    def test_downtime(self):
        nights = week(1, kwh=5_000.0, slots=DAYTIME)
        down = {'from': nights[0]['slots'][DAYTIME[0]]['start'], 'to': nights[0]['slots'][DAYTIME[2]]['start']}
        s = stage(hydrogen.build(nights, overrides={'downtime': [down]}, stages=NO_EVS))
        self.assertEqual(s['series']['hydrogen'][DAYTIME[0]:DAYTIME[2]], [0.0, 0.0])
        self.assertEqual(s['series']['why'][DAYTIME[0]], 'plant-downtime')
        self.assertEqual(s['hydrogen']['halfHoursRunning'], len(DAYTIME) - 2)


class GridBatteryTests(unittest.TestCase):
    def test_each_half_hour_is_the_dashboards_own_storage_charge(self):
        left = [300.0, 2_600.0, 0.0, 5_000.0, 5_000.0, 800.0]
        grid, levels, full_at = hydrogen.battery_series(left)
        level = storage.DEFAULT['capacityKwh'] * storage.DEFAULT['startFraction']
        for t, offered in enumerate(left):
            s = storage.charge({**storage.DEFAULT, 'startFraction': level / storage.DEFAULT['capacityKwh']}, offered)
            self.assertEqual((grid[t], levels[t]), (s['gridKwh'], s['endKwh']))
            level = s['endKwh']
        self.assertEqual(grid[0], storage.charge(storage.DEFAULT, 300.0)['gridKwh'], 'the first half-hour is the Dashboard card exactly')
        self.assertEqual(grid[1], 2500.0, 'held to its 5 MW power limit')
        self.assertEqual(full_at, 4, 'reads 100% in the fifth half-hour')
        self.assertGreaterEqual(levels[4], storage.DEFAULT['capacityKwh'] - hydrogen.FULL_TOLERANCE_KWH)
        self.assertEqual(levels, sorted(levels), 'charge side only: the level never falls')
        self.assertLessEqual(max(levels), storage.DEFAULT['capacityKwh'])

    def test_only_a_full_battery_sends_surplus_to_hydrogen(self):
        block = hydrogen.build(week(2, kwh=5_000.0, slots=DAYTIME + OVERNIGHT), stages=NO_EVS)
        s = stage(block)
        gb, full = s['gridBattery'], s['gridBattery']['fullIndex']
        self.assertAlmostEqual(s['totals']['batteryKwh'], FILL, delta=0.01, msg='40% to 100%: 6,000 kWh stored')
        self.assertEqual((gb['startFraction'], gb['endFraction'], gb['storedKwh']), (0.4, 1.0, 6000.0))
        self.assertEqual(gb['fullAt'], block['slots']['start'][full])
        self.assertEqual(sum(s['series']['hydrogen'][:full]), 0.0, 'no hydrogen before the battery reads 100%')
        self.assertGreater(sum(s['series']['hydrogen'][full:]), 0)
        self.assertEqual(sum(s['series']['battery'][full + 1:]), 0.0, 'a full battery takes nothing more')
        self.assertAlmostEqual(gb['surplusAfterFullKwh'], s['totals']['hydrogenKwh'] + s['totals']['unusedKwh'], delta=0.2,
                               msg='everything the full battery cannot take is the surplus for hydrogen')
        assert_balances(self, block)

    def test_a_battery_that_never_fills_sends_nothing_to_hydrogen(self):
        s = stage(hydrogen.build(week(1, kwh=500.0, slots=DAYTIME), stages=NO_EVS))  # 4,000 kWh: less than it can take
        self.assertEqual((s['gridBattery']['fullAt'], s['totals']['hydrogenKwh'], s['totals']['unusedKwh']), (None, 0.0, 0.0))
        self.assertAlmostEqual(s['totals']['batteryKwh'], 500.0 * len(DAYTIME), delta=0.01)
        self.assertLess(s['gridBattery']['endFraction'], 1)


class EvTests(unittest.TestCase):
    def test_evs_come_first_and_hydrogen_gets_only_the_residual(self):
        nights = week(3, kwh=300.0, slots=OVERNIGHT)  # a small surplus while the vans are plugged in
        block = hydrogen.build(nights, stages=({'id': 'depots', 'sites': {'depot': 5}},))
        s = stage(block)
        self.assertGreater(s['totals']['evKwh'], 0)
        for t, pool in enumerate(block['slots']['eligibleKwh']):
            residual = pool - block['slots']['hubKwh'][t] - s['series']['ev'][t]
            self.assertLessEqual(s['series']['hydrogen'][t], residual + 0.1)
        self.assertEqual(s['totals']['hubKwh'] + s['totals']['evKwh'] + s['totals']['hydrogenKwh'] + s['totals']['unusedKwh'],
                         s['totals']['eligibleKwh'])

    def test_every_session_is_met_within_charger_site_and_plug_in_limits(self):
        nights = week(4, kwh=lambda k, i: 100_000.0 if (i + k) % 5 else 0.0)
        tl = hydrogen.timeline(nights)
        for segment in hydrogen.SEGMENTS:
            with self.subTest(segment=segment['id']):
                sessions, suffix = hydrogen.site_sessions(tl, segment)
                self.assertTrue(sessions)
                ev, need, grid = hydrogen.ev_series(tl, [5_000.0] * len(tl['times']), [(segment, 3, sessions, suffix)])
                site = 3 * segment['sitePowerKw'] * hydrogen.SLOT_HOURS
                plugged = [sum(1 for s in sessions if s['a'] <= t < s['d']) for t in range(len(ev))]
                for t, kwh in enumerate(ev):
                    self.assertLessEqual(kwh, site + 1e-6, 'site connection')
                    self.assertLessEqual(kwh, 3 * plugged[t] * segment['chargerKw'] * hydrogen.SLOT_HOURS + 1e-6, 'charger rate')
                    if not plugged[t]:
                        self.assertEqual(kwh, 0.0, 'nothing charges while nothing is plugged in')
                self.assertAlmostEqual(sum(ev) + grid, need, delta=1e-6, msg='every session met: surplus + grid = need')
                self.assertAlmostEqual(grid, 0.0, delta=1e-6, msg='with surplus all the time, none comes from the grid')

    def test_without_surplus_evs_charge_from_the_grid_at_the_last_moment(self):
        nights = week(2, kwh=0.0)
        tl = hydrogen.timeline(nights)
        segment = hydrogen.SEGMENTS[0]
        sessions, suffix = hydrogen.site_sessions(tl, segment)
        ev, need, grid = hydrogen.ev_series(tl, [0.0] * len(tl['times']), [(segment, 1, sessions, suffix)])
        self.assertEqual(sum(ev), 0.0)
        self.assertAlmostEqual(grid, need, delta=1e-6)

    def test_ev_share_grows_with_demand_without_a_false_total(self):
        # Surplus day and night: the vans can only use what comes while they are plugged in.
        nights = week(4, kwh=60_000.0)
        stages = ({'id': 'base', 'sites': {'depot': 2}}, {'id': 'same', 'sites': {'depot': 2}},
                  {'id': 'double', 'sites': {'depot': 4}}, {'id': 'saturated', 'sites': {'depot': 400, 'workplace': 400, 'public': 400}})
        base, same, double, saturated = hydrogen.build(nights, stages=stages)['stages']
        self.assertEqual(base['series'], same['series'], 'zero growth: nothing changes')
        self.assertGreater(double['totals']['evKwh'], base['totals']['evKwh'])
        self.assertLessEqual(double['totals']['evKwh'], 2 * base['totals']['evKwh'] + 0.01)
        self.assertLessEqual(double['totals']['hydrogenKwh'], base['totals']['hydrogenKwh'] + 0.01)
        self.assertLessEqual(double['totals']['unusedKwh'], base['totals']['unusedKwh'] + 0.01)
        self.assertLess(saturated['shares']['evTotal'], 1, 'surplus outside plug-in hours: EVs never take it all')
        self.assertGreater(saturated['totals']['hydrogenKwh'], 0, 'hydrogen stays a flexible second market')
        self.assertEqual(double['vehicles'], 80)

    @FULL_BATTERY()
    def test_renewable_peaks_outside_charging_hours_go_to_hydrogen_or_stay_unused(self):
        nights = week(1, start='2026-01-24', kwh=90_000.0, slots=DAYTIME)  # a Saturday afternoon
        for s in hydrogen.build(nights)['stages']:
            self.assertEqual(s['totals']['evTotalKwh'], 0.0, s['id'])
            self.assertAlmostEqual(s['totals']['hydrogenKwh'], len(DAYTIME) * CAP, delta=0.01)
            self.assertAlmostEqual(s['totals']['unusedKwh'], len(DAYTIME) * (ACCESS - CAP), delta=0.01)

    def test_shared_network_bottleneck(self):
        nights = week(3, kwh=80_000.0)
        block = hydrogen.build(nights, overrides={'accessKw': 300.0})
        for s in block['stages']:
            for t, pool in enumerate(block['slots']['eligibleKwh']):
                self.assertEqual(pool, 150.0)
                self.assertLessEqual(block['slots']['hubKwh'][t] + s['series']['ev'][t] + s['series']['hydrogen'][t], 150.05)
        self.assertLess(stage(block, 'mature')['totals']['hydrogenKwh'], stage(block, 'pilot')['totals']['hydrogenKwh'])
        assert_balances(self, block)

    def test_the_hub_battery_is_counted_once_as_the_rewards_replay_drew_it(self):
        nights = week(4, kwh=100_000.0, slots=OVERNIGHT)
        block = hydrogen.build(nights)
        _, energy, _ = offers.replay(nights)
        self.assertAlmostEqual(sum(block['slots']['hubKwh']), energy['gridChargedKwh'], delta=0.5)
        for s in block['stages']:
            self.assertAlmostEqual(s['totals']['evTotalKwh'], s['totals']['evKwh'] + s['totals']['hubKwh'], delta=1e-3)

    def test_stages_plan_for_a_share_but_report_what_is_feasible(self):
        nights = week(7, start='2026-01-24', kwh=lambda k, i: 70_000.0 if (i // 6 + k) % 3 else 0.0)
        block = hydrogen.build(nights)
        pilot, growing, mature = block['stages']
        self.assertEqual([s['targetEvShare'] for s in block['stages']], [round(1 / 3, 6), round(2 / 3, 6), 1.0])
        self.assertLess(pilot['vehicles'], growing['vehicles'])
        self.assertLess(growing['vehicles'], mature['vehicles'])
        for s in block['stages']:
            self.assertLessEqual(s['shares']['evTotal'], s['targetEvShare'] + 0.05, 'a planning share, never forced upwards')
            self.assertAlmostEqual(s['ev']['needKwh'], s['ev']['fromEligibleKwh'] + s['ev']['fromGridKwh'], delta=0.5)
        self.assertLess(pilot['shares']['evTotal'], growing['shares']['evTotal'])
        self.assertLess(growing['shares']['evTotal'], mature['shares']['evTotal'])
        self.assertLess(mature['shares']['evTotal'], 1, 'never 100% just because the stage is called mature')
        self.assertGreaterEqual(pilot['shares']['hydrogen'], mature['shares']['hydrogen'])


class InputTests(unittest.TestCase):
    def test_bad_inputs_fail_closed(self):
        good = week(1, kwh=1_000.0)
        for broken, text in ((lambda n: n[0]['forecasts'][0].update(curtailmentKwh=-5.0), 'forecast'),
                             (lambda n: n[0]['forecasts'][0].update(curtailmentKwh=float('nan')), 'forecast'),
                             (lambda n: n[0]['observed'].update({n[0]['slots'][0]['start']: 'lots'}), 'observation'),
                             (lambda n: n.append(json.loads(json.dumps(n[0]))), 'overlap'),
                             (lambda n: n[0]['slots'].pop(), 'half-hours')):
            with self.subTest(text=text):
                nights = json.loads(json.dumps(good))
                broken(nights)
                with self.assertRaises(ValueError) as caught:
                    hydrogen.build(nights)
                self.assertIn(text, str(caught.exception))
        with self.assertRaises(ValueError):
            hydrogen.build([])
        for overrides in ({'kwhPerKg': 30.0}, {'ratedKw': -1.0}, {'minLoadFraction': 1.0}, {'accessKw': float('inf')},
                          {'offtakeKgPerDay': -2.0}, {'networkAccess': 'maybe'}, {'downtime': [{'from': 'x', 'to': 'y'}]}):
            with self.subTest(overrides=overrides), self.assertRaises(ValueError):
                hydrogen.build(good, overrides=overrides)

    def test_what_if_query_validation(self):
        values, errors = hydrogen.parse_query({'kwhPerKg': '52.5', 'ratedKw': '2000', 'plant': 'off', 'minLoadPct': '20',
                                               'accessKw': '', 'offtakeKgPerDay': '300'})
        self.assertEqual(errors, {})
        self.assertEqual(values, {'kwhPerKg': 52.5, 'ratedKw': 2000.0, 'plant': 'off', 'minLoadFraction': 0.2, 'offtakeKgPerDay': 300.0})
        _, errors = hydrogen.parse_query({'kwhPerKg': '30', 'ratedKw': 'lots', 'plant': 'maybe', 'accessKw': 'nan', 'minLoadPct': '100'})
        self.assertEqual(set(errors), {'kwhPerKg', 'ratedKw', 'plant', 'accessKw', 'minLoadPct'})
        self.assertIn('39.4', errors['kwhPerKg'], 'below the higher heating value is physically impossible')


class ImpactTests(unittest.TestCase):
    def test_the_impact_result_carries_the_block_and_nothing_else_changes(self):
        nights = week(4, kwh=lambda k, i: 50_000.0 if i % 4 else 0.0)
        with_h2 = business.build_result(nights, META, NO_SEASON)
        with patch.dict(os.environ, {'HYDROGEN_SCENARIO': 'off'}):
            without = business.build_result(nights, META, NO_SEASON)
        self.assertIsNone(without['hydrogen'], 'switched off: the page shows exactly what it showed before')
        block = with_h2.pop('hydrogen')
        without.pop('hydrogen')
        with_h2.pop('generatedAt'), without.pop('generatedAt')
        self.assertEqual(with_h2, without, 'no other figure depends on the hydrogen scenario')
        self.assertEqual((block['version'], block['status'], block['scenarioId']), ('hydrogen/v1', 'illustrative', with_h2['scenarioId']))

    def test_labels_keep_hydrogen_hypothetical_unverified_and_out_of_the_rewards_split(self):
        block = business.simulated_result('MODEL_UNAVAILABLE')['hydrogen']
        self.assertIn('not an ESB agreement', block['label'])
        self.assertIn('hypothetical', block['plant']['name'])
        self.assertIn('no agreement with ESB', block['plant']['sizing'])
        self.assertEqual((block['commercial']['status'], block['commercial']['label']), ('not-priced', 'Commercial potential: not yet priced'))
        self.assertIn('50/25/25', block['commercial']['model'])
        self.assertEqual(block['environment']['co2']['status'], 'not-verified')
        self.assertEqual(block['dataMode'], 'simulated')
        money = [key for key in json.dumps(block).split('"') if key.endswith('Eur') or key.endswith('EurPerKwh')]
        self.assertEqual(money, [], 'no euros in the hydrogen scenario: it is not priced')
        text = json.dumps(block, ensure_ascii=False).lower()
        for claim in ('connected to esb', 'partnership with esb', 'esb has agreed', 'delivered to esb', 'guaranteed', 'co₂ saved'):
            self.assertNotIn(claim, text, 'never claim a partnership, a delivery or a verified saving')
        for caveat in ('no esb partnership', 'not an esb agreement', 'is not recovered energy', 'co₂ impact not verified'):
            self.assertIn(caveat, text)

    def test_a_broken_hydrogen_scenario_never_breaks_the_page(self):
        nights = week(2, kwh=20_000.0)
        with patch('hydrogen.build', side_effect=ValueError('bad data')):
            r = business.build_result(nights, META, NO_SEASON)
        self.assertEqual(r['status'], 'ready')
        self.assertEqual(r['hydrogen']['status'], 'unavailable')
        self.assertTrue(r['discountWindows'])

    def test_simulated_example_story(self):
        block = business.simulated_result('MODEL_UNAVAILABLE')['hydrogen']
        assert_balances(self, block)
        ev = [s['shares']['evTotal'] for s in block['stages']]
        self.assertEqual(ev, sorted(ev), 'EV share grows through the stages')
        self.assertLess(ev[-1], 1)
        self.assertEqual(block['defaultStage'], 'pilot')
        self.assertGreater(block['nights'][block['defaultNight']]['eligibleKwh'], 0)

    @FULL_BATTERY()
    def test_verification_separates_recorded_false_alarm_and_unobserved(self):
        nights = week(1, kwh=5_000.0, slots=DAYTIME,
                      observed=lambda k, i: None if i == DAYTIME[0] else 0.0 if i == DAYTIME[1] else 5_000.0)
        v = stage(hydrogen.build(nights, stages=NO_EVS))['verification']
        self.assertEqual((v['notObservedKwh'], v['falseAlarmKwh'], v['recordedKwh']), (CAP, CAP, CAP * (len(DAYTIME) - 2)))
        self.assertAlmostEqual(v['recordedShare'], (len(DAYTIME) - 2) / len(DAYTIME), places=6)


class RouteTests(unittest.TestCase):
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
        business.reset()

    def tearDown(self):
        business.reset()

    def call(self, path):
        try:
            with urlopen(self.url + path) as response:
                return response.status, json.load(response)
        except HTTPError as error:
            return error.code, json.load(error)

    def ready(self, nights):
        with patch('business.compute', return_value=business.build_result(nights, META, NO_SEASON)):
            for _ in range(300):
                status, body = self.call('/api/v1/business/impact')
                if status == 200:
                    return body
                time.sleep(0.01)
        self.fail('impact never became ready')

    def test_hydrogen_route_recomputes_the_same_replay(self):
        body = self.ready(week(3, kwh=lambda k, i: 90_000.0 if i % 3 else 0.0))
        status, same = self.call('/api/v1/business/hydrogen')
        self.assertEqual(status, 200)
        self.assertEqual(same['stages'], body['hydrogen']['stages'])
        status, off = self.call('/api/v1/business/hydrogen?plant=off')
        self.assertEqual(status, 200)
        self.assertEqual(sum(s['totals']['hydrogenKwh'] for s in off['stages']), 0.0)
        status, lean = self.call('/api/v1/business/hydrogen?kwhPerKg=50')
        self.assertGreater(stage(lean)['totals']['hydrogenKg'], stage(same)['totals']['hydrogenKg'])
        status, bad = self.call('/api/v1/business/hydrogen?kwhPerKg=20&plant=maybe')
        self.assertEqual((status, bad['error']['code']), (400, 'INVALID_REQUEST'))
        self.assertEqual(set(bad['error']['fields']), {'kwhPerKg', 'plant'})
        with patch.dict(hydrogen._inputs, clear=True):
            status, gone = self.call('/api/v1/business/hydrogen')
        self.assertEqual((status, gone['error']['code']), (409, 'REPLAY_CHANGED'))

    def test_hydrogen_route_is_202_while_preparing_and_404_when_switched_off(self):
        release = threading.Event()
        with patch('business.compute', side_effect=lambda *a: release.wait(2) or business.build_result(week(2), META, NO_SEASON)):
            status, body = self.call('/api/v1/business/hydrogen')
            release.set()
        self.assertEqual((status, body['status']), (202, 'preparing'))
        with patch.dict(os.environ, {'HYDROGEN_SCENARIO': 'off'}):
            status, body = self.call('/api/v1/business/hydrogen')
        self.assertEqual((status, body['error']['code']), (404, 'HYDROGEN_OFF'))


if __name__ == '__main__':
    unittest.main()
