"""SaveThePlanet Rewards (issue #56): settlement, the 50/25/25 split, profit, the offer gate, the replay and the API."""
from datetime import datetime, timedelta
from functools import partial
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import business
import offers
from server import Handler
from tests.test_business import META, NO_SEASON, iso, night, slot_of

EVENING = slot_of(17)
NIGHT_SURPLUS = list(range(slot_of(1), slot_of(5)))  # curtailment 01:00-05:00, stored for the next evening


def week(nights=4, surplus=NIGHT_SURPLUS, **kwargs):
    return [night(day=(datetime(2026, 1, 24) + timedelta(days=k)).date().isoformat(), index=k, surplus=surplus, **kwargs)
            for k in range(nights)]


def evenings(windows):
    return [w for w in windows if w['window'] == 'evening']


class SettlementTests(unittest.TestCase):
    def test_worked_example_session_splits_exactly(self):
        # 20 kWh, basic smart EUR 0.34/kWh, AI all-in EUR 0.24/kWh: EUR 2.00 pool -> EUR 1 / 0.50 / 0.50.
        one = offers.settle_session(20, 0.34, 0.24)
        self.assertEqual((one['poolCents'], one['driverCents'], one['operatorCents'], one['platformCents']), (200, 100, 50, 50))
        self.assertEqual(one['shortfallCents'], 0)

    def test_worked_example_month(self):
        month = offers.monthly(400, 20, 0.10)
        self.assertEqual((month['poolEur'], month['driversEur']), (800.0, 400.0))
        self.assertEqual((month['operator']['retainedEur'], month['operator']['fixedEur'], month['operator']['profitEur']), (200.0, 100.0, 100.0))
        self.assertEqual((month['platform']['grossEur'], month['platform']['variableEur'], month['platform']['fixedEur'],
                          month['platform']['profitEur']), (200.0, 40.0, 120.0, 40.0))
        self.assertEqual((month['operator']['breakEvenSessions'], month['platform']['breakEvenSessions']), (200, 300))
        self.assertEqual(month['yearly']['platformProfitEur'], 480.0)

    def test_assumption_changes_recalculate_and_losses_stay_losses(self):
        below = offers.monthly(250, 20, 0.10)
        self.assertEqual((below['operator']['profitEur'], below['platform']['profitEur']), (25.0, -20.0))
        none = offers.monthly(0, 20, 0.10)
        self.assertEqual((none['poolEur'], none['platform']['grossEur']), (0.0, 0.0))
        self.assertEqual((none['operator']['profitEur'], none['platform']['profitEur']), (-100.0, -120.0))
        # SaveThePlanet's share never covers its per-session cost: no break-even, however many sessions.
        thin = offers.monthly(400, 20, 0.01)
        self.assertIsNone(thin['platform']['breakEvenSessions'])
        self.assertLess(thin['platform']['profitEur'], 0)
        costly = offers.monthly(400, 20, 0.10, operator_fixed_eur=300, platform_variable_eur=0.2, platform_fixed_eur=50)
        self.assertEqual((costly['operator']['profitEur'], costly['platform']['profitEur']), (-100.0, 70.0))

    def test_every_split_adds_up_to_the_cent(self):
        for pool in range(0, 1001):
            s = offers.split(pool)
            self.assertEqual(s['driverCents'] + s['operatorCents'] + s['platformCents'], pool)
            self.assertLessEqual(s['platformCents'] * 4, pool, 'the SaveThePlanet commission is never rounded up')
            self.assertGreaterEqual(s['driverCents'] * 2, pool, 'the driver never loses a rounding cent')
        month = offers.monthly(333, 17.3, 0.0917)
        per = month['perSession']
        self.assertAlmostEqual(per['driverEur'] + per['operatorEur'] + per['platformEur'], per['poolEur'], places=9)

    def test_locked_discount_is_honoured_and_the_shortfall_recorded(self):
        s = offers.split(100, driver_cents=150)
        self.assertEqual((s['driverCents'], s['platformCents'], s['operatorCents'], s['shortfallCents']), (150, 0, -50, 50))
        self.assertEqual(s['driverCents'] + s['operatorCents'] + s['platformCents'], 100)
        partial_ = offers.split(180, driver_cents=100)
        self.assertEqual((partial_['driverCents'], partial_['platformCents'], partial_['operatorCents']), (100, 45, 35))

    def test_no_fee_on_failed_or_cancelled_sessions(self):
        for status in ('failed', 'cancelled'):
            s = offers.settle_session(20, 0.34, 0.24, status=status)
            self.assertEqual((s['poolCents'], s['driverCents'], s['operatorCents'], s['platformCents']), (0, 0, 0, 0))

    def test_no_fee_without_extra_saving(self):
        s = offers.settle_session(20, 0.26, 0.30)
        self.assertEqual((s['poolCents'], s['platformCents']), (0, 0))


class CapacityTests(unittest.TestCase):
    def test_site_cap_comes_from_the_energy_bridge_and_is_physical(self):
        cap = offers.site_session_cap(20.0)
        self.assertGreater(cap, 0)
        self.assertLessEqual(cap * 20.0, offers.HUB['sitePowerKw'] * 2 + 1e-6, 'the 180 kW connection limits the window')
        self.assertLessEqual(cap, offers.HUB['chargers'])
        self.assertEqual(offers.site_session_cap(10.0), offers.HUB['chargers'], 'small sessions are limited by chargers')
        self.assertEqual(offers.site_session_cap(23.0), 0, 'an 11 kW charger gives at most 22 kWh in two hours')

    def test_calculator_caps_hypothetical_sessions(self):
        values, errors = offers.parse_calculator({'sessions': '5000', 'kwhPerSession': '20', 'savingEurPerKwh': '0.1'})
        self.assertEqual(errors, {})
        out = offers.calculate(**values)
        self.assertTrue(out['capacity']['capped'])
        self.assertEqual(out['month']['sessions'], out['capacity']['maxPerMonth'])
        self.assertIn('at most', out['capacity']['limit'])
        too_big = offers.calculate(**{**values, 'sessions': 100, 'kwhPerSession': 40})
        self.assertEqual((too_big['month']['sessions'], too_big['noSpareEnergy']), (0, True))
        self.assertIn('22 kWh', too_big['capacity']['limit'])

    def test_calculator_counts_only_windows_the_replay_found_worth_offering(self):
        values, _ = offers.parse_calculator({'sessions': '900', 'kwhPerSession': '20', 'savingEurPerKwh': '0.1'})
        out = offers.calculate(**values, eligible_windows=26)
        self.assertEqual((out['capacity']['counted'], out['capacity']['maxPerMonth'], out['capacity']['siteMaxPerMonth']), (416, 416, 960))
        self.assertIn('about 26 windows a month worth offering', out['capacity']['limit'])
        self.assertEqual(out['capacity']['limitedBy'], 'windows')
        self.assertEqual(offers.calculate(**values)['capacity']['counted'], 900, 'without a replay only the site caps sessions')
        none = offers.calculate(**values, eligible_windows=0)
        self.assertEqual((none['month']['sessions'], none['noSpareEnergy']), (0, True))
        # The replay's own scenarios stay inside the cap it reports.
        d = business.simulated_result('MODEL_UNAVAILABLE')['discountWindows']
        cap = d['calculator']['capacity']
        self.assertEqual(cap['maxPerMonth'], min(cap['siteMaxPerMonth'], cap['sessionsPerWindow'] * cap['eligibleWindowsPerMonth']))
        for key in ('expected', 'evaluationWeek', 'example'):
            self.assertLessEqual(d['scenarios'][key]['inputs']['sessions'], cap['maxPerMonth'], key)

    def test_calculator_validation(self):
        _, errors = offers.parse_calculator({'sessions': '1.5', 'kwhPerSession': '', 'savingEurPerKwh': '2'})
        self.assertEqual(set(errors), {'sessions', 'kwhPerSession', 'savingEurPerKwh'})
        values, errors = offers.parse_calculator({'sessions': '400', 'kwhPerSession': '20', 'savingEurPerKwh': '0.1'})
        self.assertEqual(errors, {})
        self.assertEqual(values['platformFixedEur'], 120.0, 'omitted costs use the stated defaults')
        month = offers.calculate(**values)['month']
        self.assertEqual((month['operator']['profitEur'], month['platform']['profitEur']), (100.0, 40.0))


class ReplayTests(unittest.TestCase):
    def test_evening_offers_only_from_stored_surplus(self):
        windows, energy, _ = offers.replay(week())
        first = evenings(windows)[0]
        self.assertEqual((first['status'], first['reason']), ('none', 'no-stored-surplus'), 'nothing stored before the first night')
        later = evenings(windows)[1:]
        self.assertTrue(later and all(w['status'] == 'offer' for w in later))
        for w in later:
            self.assertEqual(w['source'], 'stored-surplus')
            self.assertEqual(w['baselineEurPerKwh'], 0.34, '17:00-19:00 is the tariff peak, never assumed cheap')
            self.assertLessEqual(w['sessions'], offers.site_session_cap(20.0))
            self.assertAlmostEqual(w['memberEurPerKwh'], w['publicEurPerKwh'] - w['discountEurPerKwh'], places=4)
            s = w['settled']
            self.assertAlmostEqual(s['driverEur'] + s['operatorEur'] + s['platformEur'], s['poolEur'], places=9)
        self.assertEqual(energy['conventionalChargedKwh'], 0.0)

    def test_mornings_are_not_discounted_when_off_peak_is_cheaper(self):
        windows, _, _ = offers.replay(week())
        mornings = [w for w in windows if w['window'] == 'morning']
        self.assertTrue(mornings)
        self.assertTrue(all(w['status'] == 'none' and w['reason'] in ('not-cheaper', 'too-small') for w in mornings))

    def test_no_surplus_means_no_offer_and_a_next_opportunity(self):
        nights = week(3, surplus=())
        nights.append(night(day='2026-01-27', index=3, surplus=NIGHT_SURPLUS))
        nights.append(night(day='2026-01-28', index=4))
        windows, _, _ = offers.replay(nights)
        offers.next_opportunities(windows)
        self.assertEqual([w['status'] for w in evenings(windows)], ['none', 'none', 'none', 'none', 'offer'])
        self.assertEqual(windows[0]['next']['date'], '2026-01-28')
        self.assertEqual(windows[0]['next']['label'], '17:00–19:00')
        self.assertIsNone(offers.next_opportunities(offers.replay(week(2, surplus=()))[0])[0]['next'])

    def test_false_alarms_are_conventional_energy_and_never_offered(self):
        windows, energy, calls = offers.replay(week(forecast=NIGHT_SURPLUS, observed=()))
        self.assertTrue(all(w['status'] == 'none' for w in windows))
        self.assertGreater(energy['conventionalChargedKwh'], 0)
        self.assertEqual(energy['surplusChargedKwh'], 0)
        self.assertEqual(energy['offeredKwh'], 0)
        self.assertEqual(calls['falseAlarms'], calls['charged'])

    def test_no_look_ahead_the_lock_ignores_what_happens_later(self):
        plain = week()
        windy = week()
        for n in windy:  # curtailment during every evening window, observed only
            for i in range(EVENING, EVENING + 4):
                n['observed'][n['slots'][i]['start']] = 50_000.0
        a, _, _ = offers.replay(plain)
        b, _, _ = offers.replay(windy)
        for x, y in zip(evenings(a), evenings(b)):
            self.assertEqual((x['status'], x.get('sessions'), x.get('discountEurPerKwh')), (y['status'], y.get('sessions'), y.get('discountEurPerKwh')))
        # Normal charging turned out cheap too: the locked discount is honoured and the shortfall recorded.
        settled = [w['settled'] for w in evenings(b) if w['status'] == 'offer']
        self.assertTrue(settled)
        for s, w in zip(settled, [w for w in evenings(b) if w['status'] == 'offer']):
            self.assertEqual(s['driverEur'], w['expected']['driverEur'] * s['sessions'])
            self.assertGreater(s['shortfallEur'], 0)
            self.assertEqual(s['platformEur'], 0.0)

    def test_only_the_30_minute_forecast_is_used(self):
        plain = week()
        doubled = week()
        for n in doubled:  # +60 estimates calling a huge surplus at every half-hour: never added, never used
            n['forecasts'] += [{'targetAt': s['start'], 'curtailmentKwh': 900_000.0, 'probability': 1.0,
                                'issuedAt': iso(datetime.fromisoformat(s['start'].replace('Z', '+00:00')) - timedelta(minutes=60))}
                               for s in n['slots']]
        self.assertEqual(offers.replay(plain), offers.replay(doubled))

    def test_battery_limits_and_energy_balance(self):
        _, energy, _ = offers.replay(week(6))
        b = offers.BATTERY
        stored_in = energy['gridChargedKwh'] * b['chargeEfficiency']
        stored_out = (energy['offeredKwh'] + energy['conventionalReleasedKwh']) / b['dischargeEfficiency']
        self.assertAlmostEqual(stored_in, stored_out + energy['storedSurplusKwh'] + energy['storedConventionalKwh'], places=6)
        self.assertLessEqual(energy['storedSurplusKwh'] + energy['storedConventionalKwh'], b['capacityKwh'] + 1e-6)
        self.assertAlmostEqual(energy['chargeLossKwh'], energy['gridChargedKwh'] * (1 - b['chargeEfficiency']), places=6)

    def test_no_offer_when_stored_energy_costs_too_much(self):
        with patch.dict(offers.PRICES, networkEurPerKwh=0.2):
            windows, _, _ = offers.replay(week())
        self.assertTrue(all(w['status'] == 'none' for w in windows))


class SectionTests(unittest.TestCase):
    def test_impact_result_carries_the_section_without_changing_the_rest(self):
        nights = week(7)
        result = business.build_result(nights, META, NO_SEASON)
        d = result['discountWindows']
        self.assertEqual(d['version'], offers.VERSION)
        self.assertIn('simulated profit', d['label'])
        self.assertEqual(d['kpis']['platformProfitEur'], d['month']['platform']['profitEur'])
        self.assertEqual(d['kpis']['platformGrossEur'], d['month']['platform']['grossEur'])
        self.assertTrue(d['ledger']['balanced'])
        self.assertEqual(d['ledger']['forecastHorizonMinutes'], 30)
        self.assertEqual(d['energy']['network']['status'], 'conditional')
        self.assertEqual(d['battery']['provenance'], 'hypothetical')
        self.assertEqual(d['scenarios']['noSurplus']['month']['platform']['profitEur'], -120.0)
        self.assertEqual(d['scenarios']['example']['month']['platform']['profitEur'], 40.0)
        self.assertEqual(d['calculator']['defaults']['sessions'], d['kpis']['sessions'])
        without = dict(result)
        without.pop('discountWindows')
        again = business.build_result(nights, META, NO_SEASON)
        again.pop('discountWindows')
        for key in ('kpis', 'financials', 'waterfall', 'strategies', 'scenarios'):
            self.assertEqual(without[key], again[key])

    def test_simulated_example_makes_money_and_labels_it_projected(self):
        d = business.simulated_result('TEST')['discountWindows']
        month = d['month']
        self.assertGreater(month['platform']['profitEur'], 0)
        self.assertGreater(month['operator']['profitEur'], 0)
        self.assertLess(month['platform']['profitEur'], month['platform']['grossEur'], 'profit is shown after our costs')
        self.assertGreaterEqual(month['sessions'], month['platform']['breakEvenSessions'])
        self.assertLessEqual(month['sessions'], d['calculator']['capacity']['maxPerMonth'])

    def test_seasonal_factor_scales_sessions(self):
        nights = week(7)
        base = offers.build(nights, NO_SEASON)
        half = offers.build(nights, {'available': True, 'factor': 0.5})
        self.assertEqual(half['kpis']['sessions'], round(base['scenarios']['evaluationWeek']['inputs']['sessions'] * 0.5))


class MemberTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = patch.object(offers, 'STORE_PATH', Path(self.tmp.name) / 'bookings.json')
        self.path.start()
        offers.reset_members()
        self.section = offers.build(week(4), NO_SEASON, 'scn')
        self.offer = next(w for w in self.section['offers'] if w['status'] == 'offer')
        self.none = next(w for w in self.section['offers'] if w['status'] == 'none')

    def tearDown(self):
        offers.reset_members()
        self.path.stop()
        self.tmp.cleanup()

    def test_join_book_rebook_and_cancel(self):
        member = 'demo-member-1'
        with self.assertRaisesRegex(ValueError, 'Join SaveThePlanet Rewards first'):
            offers.act(self.section, member, 'book', self.offer['id'], 20)
        self.assertTrue(offers.act(self.section, member, 'join')['joined'])
        view = offers.act(self.section, member, 'book', self.offer['id'], 20)
        booking = view['bookings'][0]
        self.assertEqual(booking['status'], 'reserved')
        self.assertEqual(booking['split']['driverEur'], booking['discountEur'])
        self.assertAlmostEqual(booking['priceEur'], booking['publicEur'] - booking['discountEur'], places=9)
        view = offers.act(self.section, member, 'book', self.offer['id'], 12)
        self.assertEqual(len(view['bookings']), 1, 'booking again changes the kWh; it never adds a second fee')
        self.assertEqual(view['bookings'][0]['kwh'], 12)
        view = offers.act(self.section, member, 'cancel', self.offer['id'])
        cancelled = view['bookings'][0]
        self.assertEqual((cancelled['status'], cancelled['settlement']['platformCents']), ('cancelled', 0))
        self.assertTrue(json.loads(offers.STORE_PATH.read_text())[member]['bookings'])

    def test_refusals(self):
        member = 'demo-member-2'
        offers.act(self.section, member, 'join')
        with self.assertRaisesRegex(ValueError, 'changed or expired'):
            offers.act(self.section, member, 'book', 'old-scenario:2026-01-25:evening', 20)
        with self.assertRaisesRegex(ValueError, 'stored'):
            offers.act(self.section, member, 'book', self.none['id'], 20)
        with self.assertRaisesRegex(ValueError, '22 kWh'):
            offers.act(self.section, member, 'book', self.offer['id'], 30)
        with self.assertRaises(ValueError):
            offers.act(self.section, 'BAD ID', 'join')


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
        self.tmp = tempfile.TemporaryDirectory()
        self.path = patch.object(offers, 'STORE_PATH', Path(self.tmp.name) / 'bookings.json')
        self.path.start()
        offers.reset_members()

    def tearDown(self):
        business.reset()
        offers.reset_members()
        self.path.stop()
        self.tmp.cleanup()

    def call(self, path, body=None):
        data = None if body is None else json.dumps(body).encode()
        request = Request(self.url + path, data=data, headers={'Content-Type': 'application/json'} if data else {})
        try:
            with urlopen(request) as response:
                return response.status, json.load(response)
        except HTTPError as error:
            return error.code, json.load(error)

    def ready(self):
        with patch('business.compute', return_value=business.build_result(week(4), META, NO_SEASON)):
            for _ in range(300):
                status, body = self.call('/api/v1/business/offers?member=demo-member-9')
                if status == 200:
                    return body
                time.sleep(0.01)
        self.fail('offers never became ready')

    def test_offers_route_and_booking(self):
        body = self.ready()
        self.assertEqual((body['status'], body['member']['joined']), ('ready', False))
        offer = next(w for w in body['offers'] if w['status'] == 'offer')
        status, _ = self.call('/api/v1/business/offers', {'member': 'demo-member-9', 'action': 'book', 'offerId': offer['id'], 'kwh': 20})
        self.assertEqual(status, 409)
        status, joined = self.call('/api/v1/business/offers', {'member': 'demo-member-9', 'action': 'join'})
        self.assertEqual((status, joined['member']['joined']), (200, True))
        status, booked = self.call('/api/v1/business/offers', {'member': 'demo-member-9', 'action': 'book', 'offerId': offer['id'], 'kwh': 20})
        self.assertEqual((status, booked['member']['bookings'][0]['status']), (200, 'reserved'))
        status, bad = self.call('/api/v1/business/offers', {'member': 'demo-member-9', 'action': 'fly'})
        self.assertEqual((status, bad['error']['code']), (409, 'OFFER_UNAVAILABLE'))

    def test_offers_route_is_202_while_preparing(self):
        release = threading.Event()
        with patch('business.compute', side_effect=lambda *a: release.wait(2) or business.build_result(week(2), META, NO_SEASON)):
            status, body = self.call('/api/v1/business/offers')
            release.set()
        self.assertEqual((status, body['status']), (202, 'preparing'))

    def test_estimate_route(self):
        status, body = self.call('/api/v1/business/offers/estimate?sessions=400&kwhPerSession=20&savingEurPerKwh=0.1')
        self.assertEqual(status, 200)
        self.assertEqual(body['month']['platform']['profitEur'], 40.0)
        # With a finished replay, only the windows it found worth offering count.
        known = {'discountWindows': {'calculator': {'capacity': {'eligibleWindowsPerMonth': 10}}}}
        with patch('business.ready', return_value=known):
            status, body = self.call('/api/v1/business/offers/estimate?sessions=400&kwhPerSession=20&savingEurPerKwh=0.1')
        self.assertEqual((status, body['capacity']['counted'], body['capacity']['eligibleWindowsPerMonth']), (200, 160, 10))
        status, body = self.call('/api/v1/business/offers/estimate?sessions=-1&kwhPerSession=20&savingEurPerKwh=0.1')
        self.assertEqual((status, body['error']['code']), (400, 'INVALID_REQUEST'))
        self.assertIn('sessions', body['error']['fields'])


if __name__ == '__main__':
    unittest.main()
