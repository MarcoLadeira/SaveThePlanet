from pathlib import Path
import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from urllib.error import HTTPError
import chat
from chat import ChatError, ask_gemini, build_payload, validate_request


class ChatTests(unittest.TestCase):
    def test_validates_and_trims_messages(self):
        messages, page, context = validate_request({'messages': [{'role': 'user', 'text': '  hi  '}], 'page': 'forecast', 'context': {'a': 1}})
        self.assertEqual(messages, [{'role': 'user', 'text': 'hi'}])
        self.assertEqual((page, context), ('forecast', '{"a":1}'))

    def test_rejects_bad_requests(self):
        for body in [None, {}, {'messages': []}, {'messages': [{'role': 'system', 'text': 'x'}]},
                     {'messages': [{'role': 'assistant', 'text': 'x'}]}, {'messages': [{'role': 'user', 'text': 'x' * 1001}]}]:
            with self.subTest(body=body), self.assertRaises(ValueError):
                validate_request(body)

    def test_unknown_page_defaults_and_roles_map(self):
        messages, page, context = validate_request({'messages': [{'role': 'assistant', 'text': 'a'}, {'role': 'user', 'text': 'b'}], 'page': 'evil'})
        payload = build_payload(messages, page, context)
        self.assertEqual(page, 'overview')
        self.assertEqual([c['role'] for c in payload['contents']], ['model', 'user'])
        self.assertIn('Only help with this app', payload['system_instruction']['parts'][0]['text'])

    def test_missing_key_is_reported(self):
        with patch.dict(os.environ, {'GEMINI_API_KEY': ''}), self.assertRaises(ChatError) as caught:
            ask_gemini([{'role': 'user', 'text': 'hi'}], 'overview', 'none')
        self.assertEqual(caught.exception.code, 'CHAT_NOT_CONFIGURED')


    def test_falls_back_when_primary_is_overloaded(self):
        calls = []
        def fake(model, *args):
            calls.append(model)
            if model == 'primary':
                raise HTTPError('u', 503, 'busy', {}, None)
            return 'ok from ' + model
        env = {'GEMINI_API_KEY': 'k', 'GEMINI_MODEL': 'primary', 'GEMINI_FALLBACK_MODELS': 'backup'}
        with patch.dict(os.environ, env), patch.object(chat, 'call_model', fake), patch.object(chat.time, 'sleep'):
            self.assertEqual(ask_gemini([{'role': 'user', 'text': 'hi'}], 'overview', 'none'), 'ok from backup')
        self.assertEqual(calls, ['primary', 'primary', 'backup'])

    def test_all_busy_reports_busy(self):
        def fake(*args):
            raise HTTPError('u', 503, 'busy', {}, None)
        with patch.dict(os.environ, {'GEMINI_API_KEY': 'k'}), patch.object(chat, 'call_model', fake),                 patch.object(chat.time, 'sleep'), self.assertRaises(ChatError) as caught:
            ask_gemini([{'role': 'user', 'text': 'hi'}], 'overview', 'none')
        self.assertEqual(caught.exception.code, 'CHAT_BUSY')


if __name__ == '__main__':
    unittest.main()
