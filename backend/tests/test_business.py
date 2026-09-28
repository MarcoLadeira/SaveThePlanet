"""Business and environmental impact (Impact page): strategies, money, CO2, annualisation and the API."""
from datetime import datetime, timedelta, timezone
from functools import partial
from http.server import ThreadingHTTPServer
import json
import math
from pathlib import Path
import sys
import threading
import time
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError
from urllib.request import urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import business
import explorer
from server import Handler

SITE_KWH = business.FLEET['sitePowerKw'] * business.SLOT_HOURS


def iso(moment):
    return moment.strftime('%Y-%m-%dT%H:%M:%SZ')


def night(day='2026-01-24', index=0, surplus=(), forecast=None, observed=None, issued_late=False, drop_forecasts=(),
          drop_observed=()):
    """One night of inputs. `surplus` lists slot numbers with curtailment; the forecast matches unless given."""
    slots = business.night_slots(day)
    forecast = set(surplus if forecast is None else forecast)
    observed = set(surplus if observed is None else observed)
    forecasts = [{'targetAt': s['start'],
                  'issuedAt': iso(datetime.fromisoformat(s['start'].replace('Z', '+00:00')) - timedelta(minutes=20 if issued_late else 30)),
                  'curtailmentKwh': 50_000.0 if i in forecast else 0.0, 'probability': .9 if i in forecast else .1}
                 for i, s in enumerate(slots) if i not in drop_forecasts]
    seen = {s['start']: (None if i in drop_observed else 50_000.0 if i in observed else 0.0) for i, s in enumerate(slots)}
    return {'date': day, 'index': index, 'slots': slots, 'forecasts': forecasts, 'observed': seen}


def slot_of(hour, minute=0):
    """Slot number of a clock time in a night that starts at 12:00."""
    minutes = hour * 60 + minute
    return (minutes - business.NIGHT_START_MINUTE) // 30 if minutes >= 12 * 60 else (minutes + 1440 - business.NIGHT_START_MINUTE) // 30


NIGHT_SURPLUS = list(range(slot_of(2), slot_of(5)))  # curtailment 02:00-05:00
META = {'dataMode': 'historical-replay', 'source': 'test', 'modelVersion': 'test-v1', 'provenance': business.PROVENANCE,
        'fallback': {'active': False, 'reason': None}}
NO_SEASON = {'available': False, 'factor': None, 'reason': 'test'}


def plans(n):
    vehicles = business.fleet_vehicles(n['index'])
    known = business.ForecastView(n['forecasts'])
    return {sid: business.plan_night(sid, n['slots'], vehicles, known)[0] for sid in business.STRATEGY_IDS}, vehicles


def scores(n):
    made, vehicles = plans(n)
    return {sid: business.score_night(made[sid], n['slots'], vehicles, n['observed']) for sid in business.STRATEGY_IDS}


class AssumptionTests(unittest.TestCase):
    def test_tariff_bands_cover_the_day_with_peak_inside_day(self):
        self.assertEqual(business.band_at(23 * 60)['id'], 'night')
        self.assertEqual(business.band_at(3 * 60)['id'], 'night')
        self.assertEqual(business.band_at(7 * 60 + 59)['id'], 'night')
        self.assertEqual(business.band_at(8 * 60)['id'], 'day')
        self.assertEqual(business.band_at(17 * 60)['id'], 'peak')
        self.assertEqual(business.band_at(19 * 60)['id'], 'day')
        self.assertEqual(business.band_at(24 * 60 + 60)['id'], 'night')  # minutes past midnight wrap

    def test_fleet_is_identical_for_every_strategy_and_run(self):
        self.assertEqual(business.fleet_vehicles(3), business.fleet_vehicles(3))
        needs = [v['requiredKwh'] for k in range(18) for v in business.fleet_vehicles(k)]
        self.assertEqual((min(needs), max(needs)), (28, 45))
        self.assertAlmostEqual(business.grid_kwh_per_ev_day(), 36.5 / 0.9)

    def test_night_has_48_half_hours_from_noon_to_noon(self):
        slots = business.night_slots('2026-01-24')
        self.assertEqual(len(slots), 48)
        self.assertEqual((slots[0]['start'], slots[-1]['start']), ('2026-01-24T12:00:00Z', '2026-01-25T11:30:00Z'))


class StrategyTests(unittest.TestCase):
    def test_every_strategy_meets_every_van_with_losses_counted(self):
        result = scores(night(surplus=NIGHT_SURPLUS))
        required = sum(v['requiredKwh'] for v in business.fleet_vehicles(0))
        for sid, s in result.items():
            self.assertEqual(s['vehiclesMet'], 20, sid)
            self.assertAlmostEqual(s['unmetKwh'], 0, places=6)
            self.assertAlmostEqual(s['batteryKwh'], required, places=6)
            self.assertAlmostEqual(s['gridKwh'], required / 0.9, places=6)  # the grid supplies losses too
            self.assertAlmostEqual(s['lossKwh'], s['gridKwh'] - s['batteryKwh'], places=9)

    def test_plans_respect_rates_site_limit_and_plug_in_times(self):
        n = night(surplus=NIGHT_SURPLUS)
        made, vehicles = plans(n)
        for sid, plan in made.items():
            for i, slot in enumerate(n['slots']):
                self.assertLessEqual(sum(plan[v['id']][i] for v in vehicles), SITE_KWH + 1e-9, sid)
                for v in vehicles:
                    kwh = plan[v['id']][i]
                    self.assertGreaterEqual(kwh, 0)
                    self.assertLessEqual(kwh, 11 * 0.5 + 1e-9)
                    if kwh:
                        self.assertTrue(v['arriveMin'] <= slot['minute'] and slot['minute'] + 30 <= v['departMin'], (sid, v['id'], i))

    def test_normal_charges_on_arrival_and_smart_rules_wait_for_night(self):
        made, vehicles = plans(night())
        evening = range(slot_of(17), slot_of(23))
        self.assertGreater(sum(made['normal'][v['id']][i] for v in vehicles for i in evening), 0)
        for sid in ('basic', 'ai'):
            self.assertEqual(sum(made[sid][v['id']][i] for v in vehicles for i in evening), 0, sid)

    def test_smart_charging_is_cheaper_than_normal(self):
        result = scores(night())
        self.assertLess(result['basic']['costEur'], result['normal']['costEur'])
        self.assertAlmostEqual(result['ai']['costEur'], result['basic']['costEur'], places=6)  # no surplus: same night price

    def test_ai_moves_charging_into_forecast_surplus(self):
        result = scores(night(surplus=NIGHT_SURPLUS))
        self.assertGreater(result['ai']['absorbedKwh'], result['basic']['absorbedKwh'])
        self.assertLess(result['ai']['costEur'], result['basic']['costEur'])
        self.assertLess(result['ai']['co2Kg'], result['basic']['co2Kg'])

    def test_a_missed_forecast_can_make_the_ai_worse_than_the_rule(self):
        early = list(range(slot_of(23), slot_of(1)))  # surplus the forecast did not see
        result = scores(night(surplus=early, forecast=[]))
        self.assertLess(result['ai']['absorbedKwh'], result['basic']['absorbedKwh'])
        self.assertGreater(result['ai']['costEur'], result['basic']['costEur'])

    def test_a_false_alarm_earns_no_surplus_credit(self):
        result = scores(night(forecast=NIGHT_SURPLUS, observed=[]))
        self.assertEqual(result['ai']['absorbedKwh'], 0)
        self.assertEqual(result['ai']['surplusCreditEur'], 0)
        self.assertEqual(result['ai']['vehiclesMet'], 20)

    def test_tight_site_limit_is_reported_not_hidden(self):
        fleet = dict(business.FLEET, sitePowerKw=40)
        n = night()
        vehicles = business.fleet_vehicles(0, fleet)
        known = business.ForecastView(n['forecasts'])
        for sid in business.STRATEGY_IDS:
            plan, _ = business.plan_night(sid, n['slots'], vehicles, known, fleet)
            s = business.score_night(plan, n['slots'], vehicles, n['observed'], fleet)
            self.assertLess(s['vehiclesMet'], 20, sid)
            self.assertGreater(s['unmetKwh'], 0, sid)
            self.assertLessEqual(s['peakKw'], 40 + 1e-9)

    def test_every_plan_passes_the_energy_bridge_checker(self):
        for n in (night(surplus=NIGHT_SURPLUS), night(surplus=list(range(slot_of(23), slot_of(1))), forecast=[]), night()):
            made, vehicles = plans(n)
            for sid, plan in made.items():
                self.assertEqual(business.bridge_check(plan, n['slots'], vehicles), [], sid)

    def test_the_energy_bridge_checker_catches_an_infeasible_plan(self):
        n = night()
        made, vehicles = plans(n)
        plan = {vid: list(row) for vid, row in made['normal'].items()}
        plan['EV-01'][0] = 5.0  # charging at 12:00, hours before the van arrives
        problems = business.bridge_check(plan, n['slots'], vehicles)
        self.assertTrue(any('not plugged in' in p for p in problems), problems)
        with patch('business.plan_night', return_value=(plan, [])):
            with self.assertRaises(RuntimeError):
                business.evaluate([n])

    def test_unknown_strategy_is_rejected(self):
        n = night()
        with self.assertRaises(ValueError):
            business.plan_night('oracle', n['slots'], business.fleet_vehicles(0), business.ForecastView([]))


class NoLookAheadTests(unittest.TestCase):
    def test_forecasts_issued_after_the_decision_are_invisible(self):
        late = plans(night(surplus=NIGHT_SURPLUS, issued_late=True))[0]['ai']
        blind = plans(night(surplus=NIGHT_SURPLUS, forecast=[]))[0]['ai']
        self.assertEqual(late, blind)

    def test_later_forecasts_do_not_change_earlier_decisions(self):
        cut = slot_of(3)
        a = plans(night(forecast=NIGHT_SURPLUS))[0]['ai']
        b = plans(night(forecast=[i for i in NIGHT_SURPLUS if i < cut] + list(range(cut, slot_of(7)))))[0]['ai']
        for van in a:
            self.assertEqual(a[van][:cut], b[van][:cut], van)

    def test_observed_outcomes_never_change_a_plan(self):
        a = plans(night(forecast=NIGHT_SURPLUS, observed=[]))[0]
        b = plans(night(forecast=NIGHT_SURPLUS, observed=list(range(48))))[0]
        self.assertEqual(a, b)

    def test_forecast_view_hides_the_future(self):
        f = {'targetAt': '2026-01-25T03:00:00Z', 'issuedAt': '2026-01-25T02:30:00Z', 'curtailmentKwh': 1.0}
        view = business.ForecastView([f])
        self.assertIsNone(view.get(f['targetAt'], datetime(2026, 1, 25, 2, 29, tzinfo=timezone.utc)))
        self.assertIs(view.get(f['targetAt'], datetime(2026, 1, 25, 2, 30, tzinfo=timezone.utc)), f)
        self.assertIsNone(view.get('2026-01-25T03:30:00Z', datetime(2026, 1, 26, tzinfo=timezone.utc)))


class MissingDataTests(unittest.TestCase):
    def test_missing_forecasts_fall_back_to_the_rule_and_are_counted(self):
        n = night(surplus=NIGHT_SURPLUS, drop_forecasts=set(NIGHT_SURPLUS))
        result = business.evaluate([n])
        self.assertEqual(result['totals']['ai']['vehiclesMet'], 20)
        self.assertEqual(result['calls']['noForecast'], len(NIGHT_SURPLUS))
        self.assertEqual(business.coverage([n])['missingForecasts'], len(NIGHT_SURPLUS))

    def test_missing_observations_are_paid_but_never_credited(self):
        n = night(surplus=NIGHT_SURPLUS, drop_observed=set(NIGHT_SURPLUS))
        s = scores(n)['ai']
        self.assertEqual(s['absorbedKwh'], 0)
        self.assertGreater(s['unscoredKwh'], 0)
        self.assertEqual(business.coverage([n])['missingObservations'], len(NIGHT_SURPLUS))

    def test_nights_need_both_days_and_failed_days_are_listed(self):
        days = ['2026-01-24', '2026-01-25', '2026-01-26']
        day = {'forecasts': [], 'observed': {}, 'modelVersion': 'x'}
        nights = business.build_nights(days, {'2026-01-24': day, '2026-01-25': day})
        self.assertEqual([n['date'] for n in nights], ['2026-01-24'])
        self.assertEqual(business.coverage(nights, ['2026-01-26'])['failedDays'], ['2026-01-26'])

    def test_no_nights_is_an_empty_result(self):
        result = business.build_result([], META, NO_SEASON)
        self.assertEqual(result['status'], 'empty')
        self.assertIn('message', result)
        self.assertNotIn('kpis', result)


def result_for(nights, seasonal=NO_SEASON, costs=business.COSTS):
    return business.build_result(nights, META, seasonal, costs=costs)


WEEK = [night(day=f'2026-01-{24 + k}', index=k, surplus=NIGHT_SURPLUS if k % 2 == 0 else ()) for k in range(7)]


class FinanceTests(unittest.TestCase):
    def test_waterfall_kpis_and_strategy_costs_agree_to_the_euro(self):
        r = result_for(WEEK)
        steps = {s['id']: s['valueEur'] for s in r['waterfall']}
        self.assertEqual(steps['baseline'] + steps['timing'] + steps['ai'] + steps['running'], steps['final'])
        self.assertEqual(r['kpis']['annualSavingsEur'], steps['baseline'] - steps['final'])
        self.assertEqual(r['kpis']['aiSavingsEur'], -steps['ai'])
        cost = {s['id']: s['annual']['costEur'] for s in r['strategies']}
        self.assertEqual(cost['normal'], steps['baseline'])
        self.assertEqual(cost['normal'] - cost['basic'], -steps['timing'])
        self.assertEqual(cost['basic'] - cost['ai'], r['kpis']['aiSavingsEur'])
        self.assertEqual(cost['ai'] + business.COSTS['annualEur'], steps['final'])
        self.assertTrue(all(isinstance(s['valueEur'], int) for s in r['waterfall']))

    def test_payback_and_roi(self):
        fin = result_for(WEEK)['financials']
        self.assertEqual(fin['paybackStatus'], 'months')
        self.assertAlmostEqual(fin['paybackMonths'], round(15000 / fin['netSavingsEur'] * 12, 1))
        self.assertEqual(fin['roiNetEur'], 5 * fin['netSavingsEur'] - 15000)

    def test_payback_is_not_achieved_when_net_savings_are_not_positive(self):
        r = result_for(WEEK, costs=dict(business.COSTS, annualEur=10_000_000))
        self.assertLess(r['kpis']['annualSavingsEur'], 0)
        self.assertIsNone(r['kpis']['paybackMonths'])
        self.assertEqual(r['kpis']['paybackStatus'], 'not-achieved')
        exact = business.financials({'normal': {'costEur': 100, 'co2T': 1}, 'basic': {'costEur': 80, 'co2T': 1},
                                     'ai': {'costEur': 70, 'co2T': 1}}, {'implementationEur': 500, 'annualEur': 30})
        self.assertEqual((exact['netSavingsEur'], exact['paybackStatus']), (0, 'not-achieved'))

    def test_negative_ai_savings_flow_through_as_a_cost(self):
        fin = business.financials({'normal': {'costEur': 1000, 'co2T': 2}, 'basic': {'costEur': 600, 'co2T': 2},
                                   'ai': {'costEur': 650, 'co2T': 1.5}}, {'implementationEur': 1000, 'annualEur': 100})
        self.assertEqual(fin['aiSavingsEur'], -50)
        self.assertEqual(fin['finalCostEur'], 750)
        self.assertEqual(fin['netSavingsEur'], 250)
        self.assertEqual(business.waterfall(fin)[2]['valueEur'], 50)  # a rise, drawn upwards

    def test_zero_implementation_cost_pays_back_immediately(self):
        fin = business.financials({'normal': {'costEur': 100, 'co2T': 1}, 'basic': {'costEur': 80, 'co2T': 1},
                                   'ai': {'costEur': 70, 'co2T': 1}}, {'implementationEur': 0, 'annualEur': 0})
        self.assertEqual((fin['paybackMonths'], fin['roiPct']), (0.0, None))

    def test_annualisation_uses_the_average_night_and_operating_days(self):
        total = {'gridKwh': 700.0, 'absorbedKwh': 140.0, 'tariffCostEur': 112.0}
        year = business.annualise(total, 7, 1.0, days=260)
        self.assertAlmostEqual(year['gridKwh'], 100 * 260)
        self.assertAlmostEqual(year['surplusKwh'], 20 * 260)
        self.assertAlmostEqual(year['costEur'], (16 - 20 * 0.08) * 260)
        self.assertAlmostEqual(year['co2T'], 80 * 0.25 * 260 / 1000)
        self.assertAlmostEqual(year['renewableShare'], 0.2)
        none = business.annualise(total, 7, 0.0, days=260)
        self.assertEqual(none['surplusKwh'], 0)
        capped = business.annualise(total, 7, 50.0, days=260)
        self.assertAlmostEqual(capped['renewableShare'], 1.0)  # never more surplus than charging
        self.assertIsNone(business.annualise({'gridKwh': 0, 'absorbedKwh': 0, 'tariffCostEur': 0}, 1, 1)['renewableShare'])

    def test_scenarios_bracket_the_expected_case(self):
        season = business.seasonal_adjustment([f'2026-01-{d}' for d in range(24, 31)], [f'd{i}' for i in range(200)],
                                              {**{f'2026-01-{d}': {'curtailmentMwh': 50, 'event': True} for d in range(24, 31)},
                                               **{f'd{i}': {'curtailmentMwh': 50 if i % 2 else 0, 'event': bool(i % 2)} for i in range(200)}})
        self.assertAlmostEqual(season['factor'], 0.5)
        s = result_for(WEEK, season)['scenarios']
        self.assertLessEqual(s['conservative']['annualSavingsEur'], s['expected']['annualSavingsEur'])
        self.assertLessEqual(s['expected']['annualSavingsEur'], s['optimistic']['annualSavingsEur'])
        self.assertEqual((s['conservative']['basis'], s['conservative']['surplusFactor']), ('no-surplus', 0))
        self.assertEqual((s['expected']['basis'], s['expected']['surplusFactor']), ('seasonal', 0.5))
        self.assertEqual((s['optimistic']['basis'], s['optimistic']['surplusFactor']), ('evaluation-week', 1))

    def test_scenario_labels_follow_the_numbers_when_surplus_favours_normal_charging(self):
        evening = list(range(slot_of(17), slot_of(22)))  # surplus only while normal charging runs
        week = [night(day=f'2026-01-{24 + k}', index=k, surplus=evening) for k in range(7)]
        s = result_for(week)['scenarios']
        self.assertEqual(s['conservative']['basis'], 'evaluation-week')
        self.assertEqual(s['optimistic']['basis'], 'no-surplus')
        self.assertLessEqual(s['conservative']['annualSavingsEur'], s['expected']['annualSavingsEur'])
        self.assertLessEqual(s['expected']['annualSavingsEur'], s['optimistic']['annualSavingsEur'])
        self.assertLess(result_for(week)['kpis']['co2ReductionT'], 0)  # waiting for night costs CO2 here

    def test_scaling_is_per_site(self):
        r = result_for(WEEK)
        ten = next(row for row in r['scaling'] if row['sites'] == 10)
        self.assertEqual(ten['annualSavingsEur'], 10 * r['kpis']['annualSavingsEur'])
        self.assertEqual(ten['implementationEur'], 10 * 15000)


class EmissionsTests(unittest.TestCase):
    def test_co2_counts_grid_energy_not_covered_by_observed_surplus(self):
        s = scores(night(surplus=NIGHT_SURPLUS))['ai']
        self.assertAlmostEqual(s['co2Kg'], (s['gridKwh'] - s['absorbedKwh']) * 0.25)

    def test_reduction_is_normal_minus_ai_in_tonnes(self):
        r = result_for(WEEK)
        co2 = {s['id']: s['annual']['co2T'] for s in r['strategies']}
        self.assertEqual(r['kpis']['co2ReductionT'], round(co2['normal'] - co2['ai'], 2))
        self.assertLess(co2['normal'], 1000)  # tonnes, not kg
        self.assertEqual(r['emissions']['status'], 'estimated')

    def test_renewable_share_is_a_fraction(self):
        for s in result_for(WEEK)['strategies']:
            self.assertTrue(0 <= s['annual']['renewableShare'] <= 1)


class SeasonalTests(unittest.TestCase):
    def test_too_little_history_is_unavailable_and_falls_back_to_the_week(self):
        season = business.seasonal_adjustment(['a', 'b', 'c'], ['a', 'b', 'c'], {d: {'curtailmentMwh': 1, 'event': True} for d in 'abc'})
        self.assertFalse(season['available'])
        r = result_for(WEEK, season)
        self.assertEqual(r['seasonal']['appliedFactor'], 1.0)

    def test_a_calm_evaluation_period_cannot_be_scaled(self):
        year = [f'y{i}' for i in range(200)]
        actuals = {**{d: {'curtailmentMwh': 5, 'event': True} for d in year}, **{p: {'curtailmentMwh': 0, 'event': False} for p in 'pqr'}}
        self.assertFalse(business.seasonal_adjustment(list('pqr'), year, actuals)['available'])

    def test_missing_daily_values_are_left_out(self):
        year = [f'y{i}' for i in range(200)]
        actuals = {**{d: {'curtailmentMwh': 5, 'event': True} for d in year[:100]},
                   **{d: {'curtailmentMwh': None, 'event': None} for d in year[100:]},
                   **{p: {'curtailmentMwh': 5, 'event': True} for p in 'pqr'}}
        self.assertFalse(business.seasonal_adjustment(list('pqr'), year, actuals)['available'])  # only 100 seen


class DatasetTests(unittest.TestCase):
    def times(self, first, last, skip=()):
        out, t = [], first
        while t <= last:
            if t not in skip:
                out.append(iso(t))
            t += timedelta(minutes=30)
        return out

    def test_window_is_the_latest_consecutive_run_chosen_by_position(self):
        first, last = datetime(2026, 1, 2, tzinfo=timezone.utc), datetime(2026, 1, 31, 22, 30, tzinfo=timezone.utc)
        days = business.evaluation_days(self.times(first, last))
        self.assertEqual(days, [f'2026-01-{d}' for d in range(24, 32)])

    def test_days_with_gaps_break_the_run(self):
        first, last = datetime(2026, 1, 2, tzinfo=timezone.utc), datetime(2026, 1, 31, 22, 30, tzinfo=timezone.utc)
        gap = {datetime(2026, 1, 28, h, m, tzinfo=timezone.utc) for h in range(12) for m in (0, 30)}
        self.assertEqual(business.evaluation_days(self.times(first, last, gap)), ['2026-01-29', '2026-01-30', '2026-01-31'])

    def test_only_the_30_minute_forecast_is_used(self):
        points = [{'targetAt': '2026-01-24T12:00:00Z', 'issuedAt': '2026-01-24T11:30:00Z', 'horizonMinutes': 30,
                   'curtailmentMwh': 2.5, 'probability': .9},
                  {'targetAt': '2026-01-24T12:00:00Z', 'issuedAt': '2026-01-24T11:00:00Z', 'horizonMinutes': 60,
                   'curtailmentMwh': 9.0, 'probability': .9}]
        with patch('business._replay', return_value={'points': points, 'modelVersion': 'v'}), \
                patch('business._observed', return_value={}):
            day = business.load_day('2026-01-24')
        self.assertEqual(len(day['forecasts']), 1)
        self.assertEqual(day['forecasts'][0]['curtailmentKwh'], 2500.0)  # MWh -> kWh, never 2.5 + 9


class ComputeTests(unittest.TestCase):
    def test_model_outage_gives_the_labelled_simulated_example(self):
        with patch('explorer.short_term_info', side_effect=URLError('down')):
            r = business.compute()
        self.assertEqual((r['status'], r['dataMode'], r['fallback']), ('ready', 'simulated', {'active': True, 'reason': 'MODEL_UNAVAILABLE'}))
        self.assertEqual(r['provenance']['forecasts'], 'simulated')
        for s in r['strategies']:
            self.assertTrue(s['requirements']['allMet'], s['id'])

    def test_simulated_example_is_deterministic(self):
        a, b = business.simulated_result('X'), business.simulated_result('X')
        for key in ('generatedAt',):
            a.pop(key), b.pop(key)
        self.assertEqual(a, b)

    def test_frontend_fixture_matches_the_backend(self):
        """frontend/tests/fixtures/business-impact.json is this module's output; regenerate it when the contract changes."""
        path = Path(__file__).resolve().parents[2] / 'frontend' / 'tests' / 'fixtures' / 'business-impact.json'
        fixture = json.loads(path.read_text(encoding='utf-8'))
        current = json.loads(json.dumps(business.simulated_result('MODEL_UNAVAILABLE')))
        fixture.pop('generatedAt'), current.pop('generatedAt')
        self.assertEqual(fixture, current)

    def test_historical_run_uses_the_replays_and_reports_failed_days(self):
        first, last = datetime(2026, 1, 2, tzinfo=timezone.utc), datetime(2026, 1, 31, 22, 30, tzinfo=timezone.utc)
        times = DatasetTests.times(None, first, last)
        info = {'times': times, 'model': {'version': 'v1-test'}}

        def load(day, urgent):
            if day == '2026-01-27':
                raise ValueError('bad rows')
            n = night(day=day)
            return {'forecasts': [f for f in n['forecasts']], 'observed': dict(n['observed']), 'modelVersion': 'v1-test'}
        steps = []
        with patch('explorer.short_term_info', return_value=info), patch('business.load_day', side_effect=load), \
                patch('business.model_seasonal', return_value=NO_SEASON):
            r = business.compute(lambda done, total, stage: steps.append((done, total, stage)))
        self.assertEqual(r['dataMode'], 'historical-replay')
        self.assertEqual(r['coverage']['failedDays'], ['2026-01-27'])
        self.assertEqual(r['period']['nightDates'], ['2026-01-24', '2026-01-25', '2026-01-28', '2026-01-29', '2026-01-30'])
        # Eight days replayed, then the observed year, then the scoring: ten steps.
        self.assertEqual(steps[0], (0, 10, 'Replaying historical forecasts'))
        self.assertEqual(steps[-2:], [(8, 10, 'Checking a full year of observed curtailment'),
                                      (9, 10, 'Scoring three charging strategies')])
        self.assertEqual(r['provenance']['fleet'], 'simulated')


class CalculatorTests(unittest.TestCase):
    def test_estimate_formula(self):
        r = business.estimate(20, 50, 0.1, 200)
        kwh = business.grid_kwh_per_ev_day()
        self.assertEqual(r['grossSavingsEur'], round(20 * kwh * 0.5 * 0.1 * 200))
        self.assertEqual(r['yearlySavingsEur'], r['grossSavingsEur'])
        self.assertEqual(r['paybackStatus'], 'no-investment')
        self.assertTrue(r['illustrative'])

    def test_ev_count_is_checked_against_the_example_site_by_the_energy_bridge(self):
        small, crowded, huge = (business.estimate(n, 50, 0.1, 200) for n in (20, 100, 10000))
        self.assertEqual((small['feasibility']['vehiclesMet'], small['feasibility']['deliverableShare']), (20, 1.0))
        self.assertIsNone(small['feasibility']['limitedBy'])
        self.assertLess(crowded['feasibility']['vehiclesMet'], 100)
        self.assertLess(crowded['feasibility']['deliverableShare'], 1)
        self.assertEqual(crowded['feasibility']['limitedBy'], 'site-power')  # 180 kW binds before 20 chargers
        self.assertLess(crowded['grossSavingsEur'], 5 * small['grossSavingsEur'], 'extra EVs beyond the site add less')
        self.assertEqual(huge['grossSavingsEur'], business.estimate(200, 50, 0.1, 200)['grossSavingsEur'], 'a full site adds nothing')
        self.assertEqual(huge['feasibility']['evsPlanned'], 200)
        self.assertEqual(small['feasibility']['checkedBy'], business.optimizer.SOLVER_ID)
        # The site can deliver no more than its connection allows over the night.
        night_hours = (business.van_hours(3)[1] - business.FEASIBILITY_START_MINUTE) / 60
        self.assertLessEqual(crowded['feasibility']['deliverableKwhPerDay'], business.FLEET['sitePowerKw'] * night_hours + 1e-6)

    def test_every_input_changes_the_result(self):
        base = business.estimate(20, 50, 0.1, 200)['yearlySavingsEur']
        for changed in (dict(evs=40), dict(shiftablePct=25), dict(priceDiffEurPerKwh=0.2), dict(operatingDays=100)):
            args = {**dict(evs=20, shiftablePct=50, priceDiffEurPerKwh=0.1, operatingDays=200), **changed}
            self.assertNotEqual(business.estimate(**args)['yearlySavingsEur'], base, changed)

    def test_costs_and_payback(self):
        r = business.estimate(20, 50, 0.1, 200, implementationEur=5000, annualEur=500)
        self.assertEqual(r['yearlySavingsEur'], r['grossSavingsEur'] - 500)
        self.assertAlmostEqual(r['paybackMonths'], round(5000 / r['yearlySavingsEur'] * 12, 1))
        loss = business.estimate(1, 1, 0.01, 1, implementationEur=5000, annualEur=500)
        self.assertEqual((loss['paybackStatus'], loss['paybackMonths']), ('not-achieved', None))
        zero = business.estimate(20, 0, 0.1, 200)
        self.assertEqual(zero['yearlySavingsEur'], 0)

    def test_invalid_inputs_are_rejected_per_field(self):
        values, errors = business.parse_estimate({'evs': '2.5', 'shiftablePct': '120', 'priceDiffEurPerKwh': 'abc',
                                                  'operatingDays': 'nan', 'implementationEur': '-1'})
        self.assertEqual(set(errors), {'evs', 'shiftablePct', 'priceDiffEurPerKwh', 'operatingDays', 'implementationEur'})
        values, errors = business.parse_estimate({'evs': '20', 'shiftablePct': '50', 'priceDiffEurPerKwh': '0.1', 'operatingDays': '200'})
        self.assertEqual(errors, {})
        self.assertEqual(values['annualEur'], 0)
        _, errors = business.parse_estimate({})
        self.assertEqual(set(errors), {'evs', 'shiftablePct', 'priceDiffEurPerKwh', 'operatingDays'})

    def test_defaults_come_from_the_simulated_depot(self):
        r = result_for(WEEK)
        d = r['calculator']['defaults']
        self.assertEqual((d['evs'], d['operatingDays']), (20, 260))
        self.assertTrue(0 < d['shiftablePct'] <= 100)
        estimate = business.estimate(**{k: d[k] for k in ('evs', 'shiftablePct', 'priceDiffEurPerKwh', 'operatingDays')})
        # The defaults reproduce the depot's savings before costs, within a euro (the price has five decimals).
        self.assertLessEqual(abs(estimate['grossSavingsEur'] - r['financials']['grossSavingsEur']), 1)
        with_costs = business.estimate(**{k: d[k] for k in business.CALCULATOR_FIELDS})
        self.assertLessEqual(abs(with_costs['yearlySavingsEur'] - r['kpis']['annualSavingsEur']), 1)
        simulated = business.simulated_result('MODEL_UNAVAILABLE')
        d = simulated['calculator']['defaults']
        estimate = business.estimate(**{k: d[k] for k in ('evs', 'shiftablePct', 'priceDiffEurPerKwh', 'operatingDays')})
        self.assertLessEqual(abs(estimate['grossSavingsEur'] - simulated['financials']['grossSavingsEur']), 1)


class StateTests(unittest.TestCase):
    def setUp(self):
        business.reset()

    def tearDown(self):
        business.reset()

    def wait(self):
        for _ in range(200):
            body = business.current()
            if body['status'] != 'preparing':
                return body
            time.sleep(0.01)
        self.fail('never finished')

    def test_prepares_then_serves_the_same_result(self):
        gate = threading.Event()

        def slow(*args):
            gate.wait(2)
            return business.simulated_result('MODEL_UNAVAILABLE')
        with patch('business.compute', side_effect=slow):
            self.assertEqual(business.current()['status'], 'preparing')
            gate.set()
            first = self.wait()
        self.assertEqual(first['status'], 'ready')
        self.assertIs(business.current(), first)

    def test_refresh_retries_after_a_simulated_fallback_but_keeps_real_results(self):
        with patch('business.compute', return_value=business.simulated_result('MODEL_UNAVAILABLE')):
            self.wait()
        with patch('business.compute', return_value=result_for(WEEK)) as compute:
            self.assertEqual(business.current(refresh=True)['status'], 'preparing')
            real = self.wait()
            self.assertEqual(real['dataMode'], 'historical-replay')
            self.assertIs(business.current(refresh=True), real)
            self.assertEqual(compute.call_count, 1)

    def test_a_crash_is_reported_as_failed_not_as_data(self):
        with patch('business.compute', side_effect=RuntimeError('bug')):
            self.assertEqual(self.wait()['status'], 'failed')


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

    def get(self, path):
        try:
            with urlopen(self.url + path) as response:
                return response.status, json.load(response)
        except HTTPError as error:
            return error.code, json.load(error)

    def test_impact_route_prepares_then_returns_the_result(self):
        release = threading.Event()

        def slow(*args):
            release.wait(2)
            return result_for(WEEK)
        with patch('business.compute', side_effect=slow):
            status, body = self.get('/api/v1/business/impact')
            self.assertEqual((status, body['status']), (202, 'preparing'))
            release.set()
            for _ in range(200):
                status, body = self.get('/api/v1/business/impact')
                if status == 200:
                    break
                time.sleep(0.01)
        self.assertEqual((status, body['status'], body['version']), (200, 'ready', 'business-impact/v1'))
        self.assertTrue(all(math.isfinite(s['valueEur']) for s in body['waterfall']))

    def test_failed_build_is_a_500(self):
        with patch('business.compute', side_effect=RuntimeError('bug')):
            for _ in range(200):
                status, body = self.get('/api/v1/business/impact')
                if status != 202:
                    break
                time.sleep(0.01)
        self.assertEqual((status, body['error']['code']), (500, 'IMPACT_FAILED'))

    def test_estimate_route(self):
        status, body = self.get('/api/v1/business/estimate?evs=20&shiftablePct=50&priceDiffEurPerKwh=0.1&operatingDays=200')
        self.assertEqual(status, 200)
        self.assertEqual(body['grossSavingsEur'], business.estimate(20, 50, 0.1, 200)['grossSavingsEur'])
        status, body = self.get('/api/v1/business/estimate?evs=-3&shiftablePct=50&priceDiffEurPerKwh=0.1&operatingDays=200')
        self.assertEqual((status, body['error']['code']), (400, 'INVALID_REQUEST'))
        self.assertIn('evs', body['error']['fields'])


if __name__ == '__main__':
    unittest.main()
