from functools import partial
from http.server import ThreadingHTTPServer
import json
import os
from pathlib import Path
import sys
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import chat
import server
from demo import demo_payload
from scenario import build_scenario
from server import Handler, normalize


def forecast(simulated=False):
    result = normalize(demo_payload(100), 100)
    if simulated:
        result.update(source='local-demo-fixture', dataMode='simulated')
    return result


def facts(simulated=False, horizon=30):
    f = forecast(simulated)
    return chat.build_facts(f, build_scenario(f, 1000, 500), horizon)


def ask(parsed, question='How much renewable energy is at risk?', simulated=False):
    return chat.assemble(parsed, question, 'overview', facts(simulated))


class RequestTests(unittest.TestCase):
    def test_accepts_only_selectors(self):
        messages, page, horizon, selectors = chat.validate_request({
            'messages': [{'role': 'user', 'text': '  hi  '}], 'page': 'forecast', 'horizon': 60,
            'capacityMw': 50, 'context': {'atRiskMwh': 999}})
        self.assertEqual(messages, [{'role': 'user', 'text': 'hi'}])
        self.assertEqual((page, horizon, selectors['capacityMw']), ('forecast', 60, 50.0))

    def test_rejects_bad_requests(self):
        for body in [None, {}, {'messages': []}, {'messages': [{'role': 'system', 'text': 'x'}]},
                     {'messages': [{'role': 'assistant', 'text': 'x'}]}, {'messages': [{'role': 'user', 'text': 'x' * 1001}]},
                     {'messages': [{'role': 'user', 'text': 'x'}], 'capacityMw': '100'}]:
            with self.subTest(body=body), self.assertRaises(ValueError):
                chat.validate_request(body)

    def test_unknown_page_and_horizon_default(self):
        _, page, horizon, _ = chat.validate_request({'messages': [{'role': 'user', 'text': 'x'}], 'page': 'evil', 'horizon': 45})
        self.assertEqual((page, horizon), ('overview', 30))


class SemanticsTests(unittest.TestCase):
    def test_at_risk_lists_separate_intervals_with_trusted_values(self):
        reply = ask({'intent': 'at_risk', 'text': 'Both targets are forecast from one issue time.'})
        card = reply['card']
        self.assertEqual([r['value'] for r in card['rows']], [0.3, 0.8])  # demo 0.35 / 0.80 rounded
        self.assertEqual([r['label'] for r in card['rows']], ['Forecast target +30 min', 'Forecast target +60 min'])
        self.assertIn('not an hourly total', card['note'])
        self.assertEqual((reply['navigate'], reply['source']), ('forecast', 'ai'))

    def test_provenance_marks_simulated_and_historical(self):
        self.assertEqual(ask({'intent': 'at_risk', 'text': 'ok.'}, simulated=True)['provenance']['label'], 'Simulated example')
        self.assertEqual(ask({'intent': 'at_risk', 'text': 'ok.'})['provenance']['mode'], 'historical')

    def test_dominant_component_only_when_supported(self):
        self.assertEqual(chat.main_component({'atRiskMwh': 10, 'constraintMwh': 7, 'curtailmentMwh': 3})['name'], 'Grid constraint')
        self.assertIsNone(chat.main_component({'atRiskMwh': 10, 'constraintMwh': 5, 'curtailmentMwh': 5}))
        self.assertIsNone(chat.main_component({'atRiskMwh': 0, 'constraintMwh': 0, 'curtailmentMwh': 0}))

    def test_missing_scenario_values_are_omitted(self):
        f = facts()
        for target in f['targets']:
            target['potentialRecoveryMwh'] = None
        self.assertEqual(chat.build_card('recovery', f)['rows'], [])

    def test_rejects_live_framing_and_invented_numbers(self):
        for text in ['In the next 30 minutes 0.3 MWh is at risk.', 'This increases to 0.8 MWh over the hour.',
                     'About 14.67 MWh is at risk.', 'Emissions were prevented.', 'Roughly 42% is recoverable.',
                     'Grid constraint is the primary factor driving these figures.', 'About 7 mwh is at risk.', 'That is 42 percent of it.']:
            with self.subTest(text=text):
                reply = ask({'intent': 'at_risk', 'text': text})
                self.assertEqual(reply['source'], 'standard')
                self.assertEqual(reply['text'], chat.STANDARD_TEXT['at_risk'])

    def test_probability_never_rounds_to_certainty(self):
        self.assertEqual(chat.likelihood(0.9996), '>99% likely')
        self.assertEqual(chat.likelihood(1), '100% likely')

    def test_parses_fenced_json(self):
        text = '```json\n{"intent": "concept", "text": "Hi."}\n```'
        result = {'candidates': [{'content': {'parts': [{'text': text}]}}]}
        class Response:
            def __enter__(self): return self
            def __exit__(self, *args): pass
        with patch.object(chat, 'urlopen', return_value=Response()), patch.object(chat.json, 'load', return_value=result):
            self.assertEqual(chat.call_model('m', 'k', [{'role': 'user', 'text': 'x'}], 'overview', {}, 1)['intent'], 'concept')

    def test_allows_numbers_that_match_facts(self):
        self.assertEqual(ask({'intent': 'at_risk', 'text': 'The +60 min target has 0.8 MWh at risk.'})['source'], 'ai')

    def test_strips_markdown_and_tags(self):
        reply = ask({'intent': 'concept', 'text': '**Curtailment** is a limit. - [[go:forecast]] See more. Third sentence.'},
                    question='What is curtailment?')
        self.assertNotIn('*', reply['text'])
        self.assertNotIn('[[', reply['text'])
        self.assertEqual(reply['text'].count('.'), 2)
        self.assertIsNone(reply['card'])

    def test_model_cannot_choose_arbitrary_navigation(self):
        reply = ask({'intent': 'navigation', 'text': 'Go there.', 'navigate': 'https://evil.example'})
        self.assertIsNone(reply['navigate'])
        self.assertEqual(ask({'intent': 'navigation', 'text': 'Go there.', 'navigate': 'settings'})['navigate'], 'settings')


class FallbackTests(unittest.TestCase):
    def test_local_answers_when_model_unavailable(self):
        f = forecast()
        with patch.object(chat, 'ask_gemini', side_effect=URLError('down')):
            reply = chat.answer([{'role': 'user', 'text': 'How much could EV charging recover?'}], 'overview', 30,
                                f, build_scenario(f, 1000, 500))
        self.assertEqual((reply['intent'], reply['source']), ('recovery', 'standard'))
        self.assertIn('standard answer', reply['notice'])
        self.assertTrue(reply['card']['rows'])

    def test_local_classifier(self):
        cases = {'What is curtailment?': 'concept', 'how uncertain is it': 'uncertainty', 'what is at risk': 'at_risk',
                 'write me a poem': 'off_topic', 'why is energy wasted': 'breakdown'}
        for question, intent in cases.items():
            with self.subTest(question=question):
                self.assertEqual(chat.local_intent(question, 'overview'), intent)
        self.assertEqual(chat.local_intent('Summarise this page', 'charging'), 'recovery')

    def test_falls_back_through_model_chain(self):
        calls = []
        def fake(model, *args):
            calls.append(model)
            if model == 'primary':
                raise HTTPError('u', 503, 'busy', {}, None)
            return {'intent': 'concept', 'text': 'ok'}
        env = {'GEMINI_API_KEY': 'k', 'GEMINI_MODEL': 'primary', 'GEMINI_FALLBACK_MODELS': 'backup'}
        chat.cooldown.clear()
        with patch.dict(os.environ, env), patch.object(chat, 'call_model', fake), patch.object(chat.time, 'sleep'):
            chat.ask_gemini([{'role': 'user', 'text': 'hi'}], 'overview', {})
            chat.ask_gemini([{'role': 'user', 'text': 'hi'}], 'overview', {})
        # The failed primary is skipped during its cool-down on the second question.
        self.assertEqual(calls, ['primary', 'primary', 'backup', 'backup'])
        chat.cooldown.clear()

    def test_missing_key(self):
        with patch.dict(os.environ, {'GEMINI_API_KEY': ''}), self.assertRaises(chat.ChatError) as caught:
            chat.ask_gemini([{'role': 'user', 'text': 'hi'}], 'overview', {})
        self.assertEqual(caught.exception.code, 'CHAT_NOT_CONFIGURED')


class RouteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory='frontend'))
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f'http://127.0.0.1:{cls.server.server_port}/api/v1/chat'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def post(self, body):
        request = Request(self.url, data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'}, method='POST')
        try:
            with urlopen(request) as response:
                return response.status, json.load(response)
        except HTTPError as error:
            return error.code, json.load(error)

    def test_client_context_cannot_inject_figures(self):
        server.forecast_cache.clear()
        with patch('server.fetch_forecast', side_effect=URLError('down')), \
                patch.object(chat, 'ask_gemini', return_value={'intent': 'at_risk', 'text': 'Here it is.'}):
            status, body = self.post({'messages': [{'role': 'user', 'text': 'what is at risk'}],
                                      'context': {'predictions': [{'atRiskMwh': 999}]}, 'atRiskMwh': 999})
        self.assertEqual(status, 200)
        rows = body['reply']['card']['rows']
        self.assertEqual([r['value'] for r in rows], [0.3, 0.8])
        self.assertEqual(body['reply']['provenance']['mode'], 'simulated')

    def test_invalid_demand_is_rejected(self):
        status, body = self.post({'messages': [{'role': 'user', 'text': 'hi'}], 'totalDemandKwh': 10, 'flexibleDemandKwh': 20})
        self.assertEqual((status, body['error']['code']), (400, 'INVALID_REQUEST'))


if __name__ == '__main__':
    unittest.main()
