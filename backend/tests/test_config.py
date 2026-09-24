import tempfile
import unittest
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from config import load_env


class EnvTests(unittest.TestCase):
    def test_quotes_comments_and_process_precedence(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / '.env'
            path.write_text('\ufeff# comment\nURL=https://example.test\nKEY="secret#value=x" # comment\nexport PORT=8080\nEMPTY=\nSINGLE=\'literal $VALUE\'\nTIMEOUT=3 # seconds\n', encoding='utf-8')
            env = {'PORT': '9000'}
            load_env(path, env)
            self.assertEqual(env, {'URL':'https://example.test','KEY':'secret#value=x','PORT':'9000', 'EMPTY':'','SINGLE':'literal $VALUE','TIMEOUT':'3'})

    def test_missing_file_is_optional(self):
        with tempfile.TemporaryDirectory() as directory:
            env = {}
            load_env(Path(directory) / 'missing.env', env)
            self.assertEqual(env, {})

    def test_malformed_entry_does_not_leak_secret_or_partially_apply(self):
        for bad in ('not a key=secret', 'SECRET="secret', 'SECRET="secret" garbage'):
            with self.subTest(bad=bad), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / '.env'
                path.write_text('GOOD=1\n'+bad, encoding='utf-8')
                env = {}
                with self.assertRaises(ValueError) as error:
                    load_env(path, env)
                self.assertNotIn('secret', str(error.exception))
                self.assertEqual(env, {})

