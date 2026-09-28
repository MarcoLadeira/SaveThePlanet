from datetime import datetime, timezone
from functools import partial
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import random
import sys
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import explorer
import synthetic
from server import Handler

# The example request published at /openapi.json for /predict/v1/from-raw (January 2026 dataset).
EXAMPLE = json.loads((Path(__file__).parent / 'fixtures' / 'v1_raw_example.json').read_text(encoding='utf-8'))
# The API's own schema components for the raw-input request (from /openapi.json).
SCHEMAS = json.loads((Path(__file__).parent / 'fixtures' / 'v1_raw_schemas.json').read_text(encoding='utf-8'))


def spec_with(example, schemas=SCHEMAS):
    return {'info': {'version': '1.1.0'}, 'components': {'schemas': schemas},
            'paths': {'/predict/v1/from-raw': {'post': {'requestBody': {'content': {'application/json': {'example': example}}}}}}}
AT_00 = datetime(2026, 9, 27, 18, 5, tzinfo=timezone.utc)
AT_30 = datetime(2026, 9, 27, 17, 44, tzinfo=timezone.utc)


def build(scenario='ordinary', now=AT_30, seed=1, horizon=30):
    return synthetic.build_request(EXAMPLE, horizon, scenario, now=now, rng=random.Random(seed))


class GeneratorTests(unittest.TestCase):
    def test_many_scenarios_satisfy_every_rule(self):
        for seed in range(150):
            for scenario in synthetic.SCENARIOS:
                for now in (AT_00, AT_30):
                    body = build(scenario, now, seed)
                    self.assertEqual(synthetic.check_request(body, scenario), [], (seed, scenario, now))

    def test_issue_time_and_48_consecutive_history_rows(self):
        body = build(now=AT_30)
        self.assertEqual(body['issue_timestamp_utc'], '2026-09-27T17:30:00Z')
        self.assertEqual(len(body['history']), 48)
        self.assertEqual((body['history'][0]['timestamp_utc'], body['history'][-1]['timestamp_utc']),
                         ('2026-09-26T17:30:00Z', '2026-09-27T17:00:00Z'))
        self.assertEqual(build(now=AT_00)['issue_timestamp_utc'], '2026-09-27T18:00:00Z')
        self.assertTrue(all(r['available_at_utc'] <= body['issue_timestamp_utc'] for r in body['history']))
        self.assertEqual(body['current_observation']['available_at_utc'], body['issue_timestamp_utc'])

    def test_values_vary_within_90_to_110_percent_and_zeros_stay_zero(self):
        body = build(seed=7)
        for key, value in EXAMPLE['current_observation'].items():
            if not synthetic.is_number(value) or key.endswith('_ratio') or key in synthetic.HISTORY_BOUNDS:
                continue  # ratios are recomputed; bounded signals may be pulled into their demo bounds
            new = body['current_observation'][key]
            if value == 0:
                self.assertEqual(new, 0, key)
            elif not any(key == pair[1] for pair in synthetic.IRELAND_TO_ALL_ISLAND + synthetic.AVAILABILITY_PAIRS):
                self.assertTrue(0.9 * abs(value) - 1e-6 <= abs(new) <= 1.1 * abs(value) + 1e-6, (key, value, new))
        self.assertNotEqual(build(seed=1)['current_observation'], build(seed=2)['current_observation'])

    def test_signed_fields_keep_their_sign_and_others_stay_non_negative(self):
        body = build(seed=3)
        self.assertLess(body['current_observation']['eirgrid_interjurisdictional_flow_mw'], 0)  # example is -126 MW
        self.assertEqual(synthetic.check_request(body), [])

    def test_ratios_are_recomputed_from_the_varied_values(self):
        current = build(seed=4)['current_observation']
        self.assertAlmostEqual(current['eirgrid_ie_wind_penetration_ratio'],
                               current['eirgrid_ie_wind_generation_mw'] / current['eirgrid_ie_demand_mw'])
        self.assertEqual(current['eirgrid_all_island_oversupply_ratio'], 0)

    def test_price_at_each_half_past_copies_the_preceding_hour(self):
        for now in (AT_00, AT_30):
            body = build(now=now)
            rows = body['history']
            for i, row in enumerate(rows[1:], 1):
                if row['timestamp_utc'][14:16] == '30':
                    self.assertEqual(row['entsoe_price_eur_mwh'], rows[i - 1]['entsoe_price_eur_mwh'])
        self.assertEqual(build(now=AT_30)['current_observation']['entsoe_price_eur_mwh'],
                         build(now=AT_30)['history'][-1]['entsoe_price_eur_mwh'])

    def test_dispatch_down_zero_or_labelled_high_curtailment(self):
        ordinary, high = build('ordinary'), build('high-curtailment')
        self.assertTrue(all(r['observed_dispatch_down_mwh'] == 0 for r in ordinary['history']))
        self.assertEqual(ordinary['current_observation']['observed_dispatch_down_mwh'], 0)
        values = [r['observed_dispatch_down_mwh'] for r in high['history']] + [high['current_observation']['observed_dispatch_down_mwh']]
        self.assertTrue(all(10 <= v <= 230 for v in values))

    def test_check_request_catches_broken_rules(self):
        body = build()
        body['history'][5]['eirgrid_ie_demand_mw'] = 6000
        body['current_observation']['eirgrid_ie_wind_availability_mw'] = 0
        body['current_observation']['eirgrid_snsp_ratio'] = 1.2
        problems = ' | '.join(synthetic.check_request(body))
        for fragment in ('outside 3650.0-5465.0', 'wind_availability_mw below', 'snsp_ratio outside 0-1'):
            self.assertIn(fragment, problems)

    def test_rejects_bad_options(self):
        for horizon, scenario in ((45, 'ordinary'), (30, 'storm')):
            with self.assertRaises(ValueError):
                synthetic.build_request(EXAMPLE, horizon, scenario)

    def test_example_is_read_from_the_openapi_document(self):
        explorer._cache.clear()
        with patch('explorer.call', return_value=spec_with(EXAMPLE)) as call:
            self.assertEqual(synthetic.example_request()['issue_timestamp_utc'], EXAMPLE['issue_timestamp_utc'])
            synthetic.example_request()
        call.assert_called_once_with('/openapi.json')  # cached after the first fetch
        self.assertEqual(synthetic.example_api_version(), '1.1.0')
        explorer._cache.clear()

    def test_schema_drift_is_detected_before_anything_is_sent(self):
        import copy
        extra = copy.deepcopy(EXAMPLE)
        extra['current_observation']['new_source_mw'] = 1.0
        missing = copy.deepcopy(EXAMPLE)
        del missing['current_observation']['eirgrid_ie_wind_availability_mw']
        for example, fragment in ((extra, 'fields not in V1RawCurrentObservation'), (missing, 'lacks required fields')):
            with self.subTest(fragment=fragment):
                explorer._cache.clear()
                with patch('explorer.call', return_value=spec_with(example)), self.assertRaises(synthetic.SchemaDrift) as caught:
                    synthetic.example_request()
                self.assertIn(fragment, str(caught.exception))
        explorer._cache.clear()

    def test_example_issue_time_mode_keeps_the_disclosed_january_date(self):
        body = synthetic.build_request(EXAMPLE, 30, 'ordinary', rng=random.Random(1), issue_mode='example')
        self.assertEqual(body['issue_timestamp_utc'], '2026-01-31T22:30:00Z')
        self.assertEqual(body['history'][0]['timestamp_utc'], '2026-01-30T22:30:00Z')
        self.assertEqual(synthetic.check_request(body), [])
        with self.assertRaises(ValueError):
            synthetic.build_request(EXAMPLE, 30, 'ordinary', issue_mode='tomorrow')


def model_response(body):
    issued = datetime.fromisoformat(body['issue_timestamp_utc'].replace('Z', '+00:00'))
    target = issued + explorer.timedelta(minutes=body['forecast_horizon_minutes'])
    return dict(model_version='1.1.0', issue_timestamp_utc=body['issue_timestamp_utc'],
                target_timestamp_utc=explorer.iso(target), forecast_horizon_minutes=body['forecast_horizon_minutes'],
                dispatch_down_probability=.9, dispatch_down_event_prediction=True, risk_level='high',
                predicted_dispatch_down_mwh=100.0, predicted_curtailment_mwh=10.0, predicted_constraint_mwh=90.0,
                prediction_interval_p10_mwh=80.0, prediction_interval_p50_mwh=95.0, prediction_interval_p90_mwh=120.0,
                flexible_load_capacity_mw=body['flexible_load_capacity_mw'], recoverable_surplus_mwh=50.0,
                input_provenance='user_supplied_unverified', input_notice='Caller supplied.')


class SyntheticHttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory='frontend'))
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f'http://127.0.0.1:{cls.server.server_port}/api/v1/synthetic-v1'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def post(self, payload):
        request = Request(self.url, data=json.dumps(payload).encode(), headers={'Content-Type': 'application/json'}, method='POST')
        try:
            with urlopen(request) as response:
                return response.status, json.load(response)
        except HTTPError as error:
            return error.code, json.load(error)

    @patch('synthetic.example_request', return_value=EXAMPLE)
    @patch('explorer.call')
    def test_result_is_labelled_synthetic_and_sends_a_valid_request(self, call, _example):
        call.side_effect = lambda path, body=None: model_response(body)
        status, result = self.post({'horizon': 60, 'scenario': 'high-curtailment', 'capacityMw': 50})
        self.assertEqual(status, 200)
        self.assertEqual(result['label'], 'Synthetic scenario — not a forecast of today’s actual grid conditions.')
        self.assertTrue(result['synthetic'])
        self.assertEqual(result['scenarioLabel'], 'High-curtailment scenario (synthetic)')
        self.assertIn('stress test', result['purpose'])
        self.assertIn('does not establish seasonal or physical feasibility', result['plausibilityLimit'])
        self.assertEqual(result['issueMode'], 'example')
        path, sent = call.call_args.args
        self.assertEqual(path, '/predict/v1/from-raw')
        self.assertEqual((sent['forecast_horizon_minutes'], sent['flexible_load_capacity_mw']), (60, 50))
        self.assertEqual(synthetic.check_request(sent, 'high-curtailment'), [])

    @patch('explorer.call')
    def test_invalid_options_are_rejected_without_calling_the_model(self, call):
        for payload in ({'horizon': 45}, {'scenario': 'storm'}, {'capacityMw': 0}, {'horizon': True}, {'issueTime': 'soon'}, ['x']):
            with self.subTest(payload=payload):
                self.assertEqual(self.post(payload)[0], 400)
        call.assert_not_called()

    @patch('synthetic.example_request', side_effect=synthetic.SchemaDrift('The API example no longer matches its schema: x'))
    def test_schema_drift_is_502_with_its_own_code(self, _example):
        status, body = self.post({})
        self.assertEqual((status, body['error']['code']), (502, 'EXAMPLE_SCHEMA_DRIFT'))

    @patch('synthetic.example_request', side_effect=TimeoutError())
    def test_model_failure_is_502(self, _example):
        status, body = self.post({})
        self.assertEqual((status, body['error']['code']), (502, 'MODEL_TIMEOUT'))


if __name__ == '__main__':
    unittest.main()
