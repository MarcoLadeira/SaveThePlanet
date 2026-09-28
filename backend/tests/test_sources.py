"""Wind & Solar page (issue #65). Hermetic: GridToEv is replaced by real responses saved in
tests/fixtures/sources (captured 28 Sep 2026), so every number below is a real one."""
from datetime import date
from functools import partial
from http.server import ThreadingHTTPServer
import io
import json
import os
from pathlib import Path
import sys
import threading
import unittest
from urllib.error import HTTPError, URLError
from urllib.request import urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import explorer
import scenario
import sources
from server import Handler

FIXTURES = Path(__file__).resolve().parent / 'fixtures' / 'sources'


def fixture(name):
    return json.loads((FIXTURES / name).read_text(encoding='utf-8'))


def http_error(code, detail):
    error = HTTPError('http://model', code, 'error', {}, io.BytesIO(json.dumps({'detail': detail}).encode()))
    return error


class FakeModel:
    """Answers the four routes from fixtures and records every call."""
    def __init__(self, overrides=None):
        self.calls, self.overrides = [], overrides or {}

    def __call__(self, path, body=None):
        self.calls.append((path, body))
        key = 'forecast' if path.startswith('/predict/curtailment/sources/day') else path
        if key in self.overrides:
            result = self.overrides[key]
            if isinstance(result, Exception):
                raise result
            return result
        if path == '/actuals/curtailment/sources/coverage':
            return fixture('coverage.json')
        if path == '/model-info/curtailment/sources':
            return fixture('info.json')
        if path.startswith('/actuals/curtailment/sources?'):
            day = path.split('target_date_utc=')[1][:10]
            name = FIXTURES / f'recorded-{day}.json'
            if name.exists():
                return fixture(name.name)
            return {'status': 'available', 'target_date_utc': day, 'wind_curtailment_mwh': 0.0, 'solar_curtailment_mwh': 0.0,
                    'total_curtailment_mwh': 0.0, 'wind_share_percent': None, 'solar_share_percent': None,
                    'complete_half_hour_count': 48, 'summary': 'none',
                    'half_hours': [{'timestamp_utc': f'{day}T{h // 2:02d}:{h % 2 * 30:02d}:00+00:00',
                                    'wind_curtailment_mwh': 0.0, 'solar_curtailment_mwh': 0.0} for h in range(48)]}
        if path == '/predict/curtailment/sources/day':
            name = FIXTURES / f"forecast-{body['target_date_utc']}.json"
            if name.exists():
                return fixture(name.name)
            raise http_error(422, 'A future target day has not reached its 00:00 UTC issue time')
        raise AssertionError(f'unexpected upstream call {path}')

    def count(self, prefix):
        return sum(1 for path, _ in self.calls if path.startswith(prefix))


class SourcesTestCase(unittest.TestCase):
    def setUp(self):
        sources.clear_cache()
        self.model = FakeModel()
        self._call, self._today = explorer.call, sources._today
        explorer.call = self.model
        sources._today = lambda: date(2026, 9, 28)

    def tearDown(self):
        explorer.call, sources._today = self._call, self._today
        sources.clear_cache()


class RecordedTests(SourcesTestCase):
    def test_available_day_is_normalised_with_48_half_hours(self):
        r = sources.recorded_day('2026-05-10')
        self.assertEqual((r['status'], r['windMwh'], r['solarMwh'], r['totalMwh']), ('available', 4352.908, 2564.085, 6916.993))
        self.assertEqual((r['windSharePercent'], r['solarSharePercent']), (62.93, 37.07))
        self.assertEqual(len(r['halfHours']), 48)
        self.assertEqual(r['halfHours'][21], {'at': '2026-05-10T10:30:00Z', 'windMwh': 313.946, 'solarMwh': 202.04})

    def test_wind_plus_solar_equals_the_total_for_every_available_fixture(self):
        for day in ('2026-05-10', '2026-01-31'):
            r = sources.recorded_day(day)
            self.assertAlmostEqual(r['windMwh'] + r['solarMwh'], r['totalMwh'], delta=0.001)
            self.assertAlmostEqual(sum(h['windMwh'] + h['solarMwh'] for h in r['halfHours']), r['totalMwh'], delta=0.01)

    def test_zero_day_keeps_its_shares_unknown(self):
        r = sources.recorded_day('2026-01-31')
        self.assertEqual(r['totalMwh'], 0.0)
        self.assertIsNone(r['windSharePercent'])
        self.assertIsNone(r['solarSharePercent'])

    def test_wind_only_day_keeps_solar_unknown_never_zero(self):
        r = sources.recorded_day('2022-06-01')
        self.assertEqual(r['status'], 'solar_not_published')
        self.assertEqual(r['windMwh'], 0.0)
        self.assertIsNone(r['solarMwh'])
        self.assertIsNone(r['totalMwh'])
        self.assertTrue(all(h['solarMwh'] is None for h in r['halfHours']))

    def test_pending_day_has_no_numbers(self):
        r = sources.recorded_day('2026-09-15')
        self.assertEqual(r['status'], 'pending')
        self.assertIsNone(r['totalMwh'])
        self.assertIsNone(r['halfHours'])

    def test_a_published_day_with_missing_half_hours_is_rejected(self):
        body = fixture('recorded-2026-05-10.json')
        body['half_hours'] = body['half_hours'][:47]
        self.model.overrides['/actuals/curtailment/sources?target_date_utc=2026-05-10&include_half_hours=true'] = body
        with self.assertRaises(ValueError):
            sources.recorded_day('2026-05-10')

    def test_history_is_cached_forever_but_pending_days_are_asked_again(self):
        sources.recorded_day('2026-05-10')
        sources.recorded_day('2026-05-10')
        self.assertEqual(self.model.count('/actuals/curtailment/sources?target_date_utc=2026-05-10'), 1)
        sources.recorded_day('2026-09-15')
        with sources._lock:
            stored, ttl, value = sources._cache[('recorded', '2026-09-15')]
            sources._cache[('recorded', '2026-09-15')] = (stored - sources.PENDING_SECONDS - 1, ttl, value)
        sources.recorded_day('2026-09-15')
        self.assertEqual(self.model.count('/actuals/curtailment/sources?target_date_utc=2026-09-15'), 2)


class ForecastTests(SourcesTestCase):
    def test_forecast_is_normalised_and_adds_up(self):
        f = sources.forecast_split('2026-05-10')
        self.assertEqual(f['status'], 'ok')
        self.assertAlmostEqual(f['windMwh'] + f['solarMwh'], f['totalMwh'], places=6)
        self.assertEqual((f['windSharePercent'], f['solarSharePercent']), (71.38, 28.62))
        self.assertEqual(f['capacity'], {'windMw': 4346.66, 'solarMw': 943.105, 'dataThrough': '2026-03-31'})
        self.assertTrue(f['experimental'])
        self.assertEqual(f['validationStatus'], 'candidate_awaiting_fresh_confirmation')

    def test_days_before_the_forecast_starts_are_not_sent_upstream(self):
        f = sources.forecast_split('2024-03-31')
        self.assertEqual(f['status'], 'not_forecastable')
        self.assertEqual(self.model.count('/predict/'), 0)

    def test_the_model_s_422_reason_is_passed_through_unchanged(self):
        for message in ('No complete archived forecast before 2024-04-01',
                        'A future target day has not reached its 00:00 UTC issue time'):
            sources.clear_cache()
            self.model.overrides['forecast'] = http_error(422, message)
            self.assertEqual(sources.forecast_split('2026-05-10'), {'status': 'not_forecastable', 'message': message})

    def test_a_down_model_is_reported_not_raised_and_not_cached(self):
        for make in (lambda: http_error(503, 'Experimental wind/solar split is unavailable (it requires V2)'),
                     lambda: URLError('refused'), TimeoutError):
            sources.clear_cache()
            self.model.calls.clear()
            self.model.overrides['forecast'] = make()
            first = sources.forecast_split('2026-05-10')
            self.model.overrides['forecast'] = make()
            self.assertEqual((first['status'], sources.forecast_split('2026-05-10')['status']), ('unavailable', 'unavailable'))
            self.assertEqual(self.model.count('/predict/'), 2)  # failures are asked again, never cached
        self.model.overrides['forecast'] = http_error(503, 'Experimental wind/solar split is unavailable (it requires V2)')
        sources.clear_cache()
        self.assertIn('requires V2', sources.forecast_split('2026-05-10')['message'])

    def test_a_successful_forecast_is_cached_forever(self):
        sources.forecast_split('2026-05-10')
        sources.forecast_split('2026-05-10')
        self.assertEqual(self.model.count('/predict/'), 1)

    def test_the_page_still_gets_recorded_data_when_the_forecast_is_down(self):
        self.model.overrides['forecast'] = http_error(503, 'down')
        body = sources.day('2026-05-10', 100)
        self.assertEqual(body['recorded']['totalMwh'], 6916.993)
        self.assertEqual(body['forecast']['status'], 'unavailable')
        self.assertIsNone(body['derived']['comparison'])
        self.assertEqual(body['derived']['bestWindow']['absorbableMwh'], 400.0)


class InfoTests(SourcesTestCase):
    def test_model_info_is_normalised(self):
        i = sources.split_info()
        self.assertEqual(i['status'], 'ok')
        self.assertAlmostEqual(i['intercept'], -0.006300965543418819)
        self.assertAlmostEqual(i['slope'], 0.6318734222411123)
        self.assertEqual(i['fittedOn'], ['2024-04-01', '2025-12-31'])
        self.assertEqual(i['constants']['wind_cut_in_ms'], 3.0)
        self.assertEqual(i['validation']['fresh'], {'status': 'pending', 'rows': 0, 'required': 60})
        self.assertAlmostEqual(i['validation']['provisional']['maeMwh'], 1784.242847)
        self.assertEqual(len(i['limitations']), 4)

    def test_unavailable_info_is_reported_not_raised(self):
        self.model.overrides['/model-info/curtailment/sources'] = URLError('down')
        self.assertEqual(sources.split_info()['status'], 'unavailable')


class DerivedTests(SourcesTestCase):
    def halves(self, totals, day='2026-05-10'):
        return [{'at': f'{day}T{i // 2:02d}:{i % 2 * 30:02d}:00Z', 'windMwh': t, 'solarMwh': 0.0} for i, t in enumerate(totals)]

    def test_real_day_best_window_peak_and_solar_hours(self):
        halves = sources.recorded_day('2026-05-10')['halfHours']
        w = sources.best_window(halves, 100)
        self.assertEqual((w['start'], w['end'], w['slots']), ('2026-05-10T10:30:00Z', '2026-05-10T14:30:00Z', 8))
        self.assertEqual(w['absorbableMwh'], 400.0)
        self.assertAlmostEqual(w['curtailedMwh'], 3799.24, places=2)
        p = sources.day_profile(halves)
        self.assertEqual(p['peak']['at'], '2026-05-10T10:30:00Z')
        self.assertAlmostEqual(p['peak']['totalMwh'], 515.986)
        # 0.042 MWh of solar at 01:30 is a real record, but it is not "solar hours".
        self.assertEqual(halves[3]['solarMwh'], 0.042)
        self.assertEqual(p['solarHours'], {'from': '2026-05-10T07:00:00Z', 'to': '2026-05-10T16:30:00Z'})

    def test_window_uses_min_of_curtailed_and_capacity_times_half_an_hour(self):
        totals = [0] * 48
        totals[10:14] = [30, 80, 80, 10]
        w = sources.best_window(self.halves(totals), 100)  # cap 50 MWh per half-hour
        self.assertEqual(w['absorbableMwh'], 30 + 50 + 50 + 10)
        self.assertEqual(w['curtailedMwh'], 200)
        self.assertEqual((w['start'][11:16], w['end'][11:16]), ('05:00', '07:00'))

    def test_ties_go_to_most_curtailed_then_shortest_then_earliest(self):
        totals = [0] * 48
        totals[2:4] = [60, 60]      # absorbs 100, curtailed 120
        totals[20:22] = [90, 90]    # absorbs 100, curtailed 180: wins the tie
        self.assertEqual(sources.best_window(self.halves(totals), 100)['start'][11:16], '10:00')
        totals[20:22] = [60, 60]    # identical: the earliest wins, and no empty half-hours pad it
        w = sources.best_window(self.halves(totals), 100)
        self.assertEqual((w['start'][11:16], w['slots']), ('01:00', 2))

    def test_window_at_the_end_of_the_day_and_nothing_curtailed(self):
        totals = [0] * 48
        totals[46:] = [5, 7]
        w = sources.best_window(self.halves(totals), 100)
        self.assertEqual((w['start'][11:16], w['end'], w['absorbableMwh']), ('23:00', '2026-05-11T00:00:00Z', 12))
        self.assertIsNone(sources.best_window(self.halves([0] * 48), 100))
        self.assertIsNone(sources.day_profile(self.halves([0] * 48))['peak'])

    def test_ev_equivalents_use_the_scenario_constants(self):
        ev = sources.ev_equivalent(0.5)
        self.assertEqual(ev['kwh'], 500)
        self.assertEqual(ev['charges'], round(500 / scenario.DEFAULT_KWH_PER_CHARGE, 1))
        self.assertEqual(ev['rangeKm'], round(500 / scenario.EV_KWH_PER_KM))
        self.assertEqual(ev['co2Tonnes'], round(0.5 * scenario.GRID_INTENSITY_T_PER_MWH, 1))
        self.assertIsNone(sources.ev_equivalent(None))

    def test_real_forecast_versus_recorded_keeps_split_and_total_errors_apart(self):
        c = sources.day('2026-05-10', 100)['derived']['comparison']
        self.assertAlmostEqual(c['totalErrorMwh'], -4882.259, places=3)
        self.assertAlmostEqual(c['windErrorMwh'], -2900.446, places=3)
        self.assertAlmostEqual(c['solarErrorMwh'], -1981.813, places=3)
        self.assertEqual(c['shareErrorPoints'], 8.45)

    def test_nothing_curtailed_has_no_share_error(self):
        c = sources.day('2026-01-31', 100)['derived']['comparison']
        self.assertTrue(c['nothingCurtailed'])
        self.assertAlmostEqual(c['totalErrorMwh'], 52.17, places=2)
        self.assertIsNone(c['shareErrorPoints'])

    def test_split_formula_worked_backwards_gives_the_potential_ratio(self):
        r = sources.day('2026-05-10', 100)['derived']['potentialRatio']
        self.assertAlmostEqual(r['ratio'], 4.29, places=2)
        self.assertIsNone(sources.potential_ratio(100, sources.split_info()))


class RangeAndMonthTests(SourcesTestCase):
    def test_days_from_the_archive_start_to_today_are_accepted(self):
        self.assertEqual(sources.date_range(), ('2021-01-01', '2026-09-28'))
        self.assertEqual(sources.validate_day('2026-09-15'), '2026-09-15')
        for bad in ('2020-12-31', '2026-09-29'):
            with self.assertRaises(sources.OutOfRange):
                sources.validate_day(bad)

    def test_suggested_day_is_the_latest_day_with_curtailment(self):
        body = fixture('recorded-2026-05-10.json')
        body['target_date_utc'] = '2026-08-28'
        body['half_hours'] = [dict(h, timestamp_utc=h['timestamp_utc'].replace('2026-05-10', '2026-08-28')) for h in body['half_hours']]
        self.model.overrides['/actuals/curtailment/sources?target_date_utc=2026-08-28&include_half_hours=true'] = body
        self.assertEqual(sources.page_coverage()['suggestedDay'], '2026-08-28')

    def test_month_totals_share_the_day_cache(self):
        sources.recorded_day('2026-05-10')
        m = sources.month('2026-05')
        self.assertEqual(len(m['days']), 31)
        self.assertEqual(self.model.count('/actuals/curtailment/sources?target_date_utc=2026-05-10'), 1)
        self.assertEqual(m['totals']['totalMwh'], 6916.993)
        self.assertEqual(m['totals']['daysCurtailed'], 1)
        self.assertAlmostEqual(m['totals']['solarSharePercent'], 37.07, places=2)

    def test_future_days_of_the_current_month_are_left_out(self):
        self.assertEqual(sources.month('2026-09')['days'][-1]['date'], '2026-09-28')
        with self.assertRaises(sources.OutOfRange):
            sources.month('2027-01')


class SourcesHttpTests(SourcesTestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory='frontend'))
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f'http://127.0.0.1:{cls.server.server_port}/api/v1/sources/'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def get(self, path):
        try:
            with urlopen(self.url + path) as response:
                return response.status, response.read().decode()
        except HTTPError as error:
            with error:
                return error.code, error.read().decode()

    def test_day_route_returns_recorded_forecast_and_derived(self):
        status, text = self.get('day?date=2026-05-10&capacityMw=100')
        self.assertEqual(status, 200)
        body = json.loads(text)
        self.assertEqual(set(body), {'date', 'recorded', 'forecast', 'derived'})
        self.assertEqual(body['derived']['bestWindow']['absorbableMwh'], 400.0)

    def test_bad_requests_are_rejected_before_reaching_the_model(self):
        for path in ('day?date=10-05-2026', 'day?date=2026-05-10&capacityMw=0', 'month?month=2026-5', 'nope'):
            status, _ = self.get(path)
            self.assertIn(status, (400, 404), path)
        self.assertEqual(self.get('day?date=2020-01-01')[0], 404)
        self.assertEqual(self.model.count('/predict/'), 0)

    def test_coverage_info_and_month_routes(self):
        for path in ('coverage', 'info', 'month?month=2026-05'):
            self.assertEqual(self.get(path)[0], 200, path)

    def test_a_malformed_model_answer_is_a_502_not_a_404(self):
        self.model.overrides['/actuals/curtailment/sources?target_date_utc=2026-05-10&include_half_hours=true'] = {'half_hours': [{}]}
        self.assertEqual(self.get('day?date=2026-05-10')[0], 502)

    def test_the_api_key_never_reaches_the_browser(self):
        os.environ['GRID_TO_EV_API_KEY'], saved = 'secret-test-key-123', os.environ.get('GRID_TO_EV_API_KEY')
        try:
            for path in ('coverage', 'info', 'day?date=2026-05-10', 'month?month=2026-05'):
                self.assertNotIn('secret-test-key-123', self.get(path)[1])
        finally:
            if saved is None:
                os.environ.pop('GRID_TO_EV_API_KEY')
            else:
                os.environ['GRID_TO_EV_API_KEY'] = saved


if __name__ == '__main__':
    unittest.main()
