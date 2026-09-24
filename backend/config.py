"""Load simple KEY=value configuration without external dependencies."""
import os
import re
from pathlib import Path


def load_env(path: Path, environ=None):
    """Load .env once at startup; explicit process variables take precedence.

    Supports blank lines, comments, optional export, and single/double quoted
    values. Values are literal: no shell execution or variable interpolation.
    """
    target = os.environ if environ is None else environ
    if not path.exists():
        return
    values = {}
    for line_number, line in enumerate(path.read_text(encoding='utf-8-sig').splitlines(), 1):
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        if line.startswith('export '):
            line = line[7:].lstrip()
        key, separator, value = line.partition('=')
        key, value = key.strip(), value.strip()
        if not separator or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', key):
            raise ValueError(f'Invalid .env entry on line {line_number}; expected KEY=value.')
        if value.startswith(('"', "'")):
            quote = value[0]
            end = value.find(quote, 1)
            if end < 0 or (value[end + 1:].strip() and not value[end + 1:].lstrip().startswith('#')):
                raise ValueError(f'Invalid .env quoting on line {line_number}.')
            value = value[1:end]
        else:
            value = re.split(r'\s+#', value, maxsplit=1)[0].rstrip()
        values[key] = value
    for key, value in values.items():
        target.setdefault(key, value)
