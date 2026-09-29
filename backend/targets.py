"""How the dashboard chooses its historical target half-hour.

Selection uses model predictions only, never observed outcomes.

- "predicted" (default): a half-hour the model predicts to have AT LEAST MIN_PREDICTED_MWH
  (10 MWh) at both horizons, mixed across forecast-confidence levels. The V1 model is nearly
  all-or-nothing: ~94% of half-hours it predicts above 0 MWh come with a ~100% probability,
  so plain random sampling almost always shows "100% high risk". A background index of the
  +30 min prediction for every dataset half-hour (built from day replays at prefetch
  priority, saved to disk) lets the dashboard first pick a confidence band at random, then a
  half-hour within it:
      certain    probability >= 99.5%
      likely     50% to 99.5%
      uncertain  below 50%
  Until the index is ready it samples uniformly and keeps the first half-hour predicted to
  have at least MIN_PREDICTED_MWH (usually "certain"). Note: with a 10 MWh minimum the
  "uncertain" band is empty for the January 2026 dataset (every low-probability prediction
  is below 10 MWh), so the mix is near-certain vs likely (~92-99%).
- "unfiltered": one uniformly random dataset half-hour, whatever its prediction.

Observed EirGrid outcomes are never used to choose (no hindsight/outcome-selection bias).
"""
import json
from pathlib import Path
import random
import threading
import time
from urllib.error import HTTPError

import explorer

MIN_PREDICTED_MWH = 10.0  # a candidate must be predicted AT LEAST this (MWh) at both horizons
MAX_ATTEMPTS = 10
RETRY_PASSES = 4  # background index: passes over days that failed (timeouts, busy gate)
RETRY_PAUSE_SECONDS = 30
MODES = ('predicted', 'unfiltered')
BANDS = (  # (name, lowest +30 min probability, label)
    ('certain', 0.995, 'near-certain (≥ 99.5%)'),
    ('likely', 0.5, 'likely (50–99.5%)'),
    ('uncertain', 0.0, 'uncertain (below 50%)'),
)
INDEX_DIR = Path(__file__).resolve().parent / '.cache'
_lock = threading.Lock()
_choices = {}  # target -> selection record, so later (pinned) requests can still explain it
_index = {}  # target -> {'probability': p, 'mwh': m} from +30 min day replays
_index_state = {'days': 0, 'total': 0, 'building': False, 'ready': False}
# Errors that rule out one candidate only. Anything else (network, timeout, 5xx) means the
# model is unavailable and is raised so the caller can fall back.
CANDIDATE_ERRORS = (ValueError, KeyError, TypeError)


def both_horizon_targets(times):
    """Target half-hours the model can forecast at both +30 and +60 minutes."""
    available, last = set(times), max(times)
    return [t for t in explorer.valid_targets(times) if len(explorer.forecast_issues(t, available, last)) == 2]


def dataset_targets():
    """Every dataset target with both horizons: the population that is sampled."""
    with _lock:
        return explorer.cached('dashboard-targets', None,
                               lambda: both_horizon_targets(explorer.short_term_info()['times']))


def is_dataset_target(target):
    return target in set(dataset_targets())


def least_predicted(forecast):
    return min(p['atRiskMwh'] for p in forecast['predictions'])


def band_of(probability):
    return next(name for name, lowest, _ in BANDS if probability >= lowest)


# ---------------------------------------------------------------- prediction index

def _index_file():
    info = explorer.short_term_info()
    version = info['model'].get('version', 'unknown')
    return INDEX_DIR / f"v1-plus30-index-{version}-{info['dataset']['count']}.json"


def _load_index():
    try:
        saved = json.loads(_index_file().read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return False
    _index.update(saved['targets'])
    _index_state.update(days=saved['days'], total=saved['days'], ready=True)
    return True


def build_index():
    """Index the +30 min prediction of every dataset half-hour (idempotent, background use).

    Each day is one replay through the shared gate at PREFETCH priority, so on-screen requests
    always go first. Progress is usable immediately; the finished index is saved to disk.
    """
    with _lock:
        if _index_state['building'] or _index_state['ready']:
            return
        _index_state['building'] = True
    try:
        if _load_index():
            return
        days = sorted({t[:10] for t in explorer.short_term_info()['times']})
        _index_state['total'] = len(days)
        pending = days
        for attempt in range(RETRY_PASSES):
            failed = []
            for day in pending:
                try:
                    replay = explorer.short_term_day(day, 30, prefetch=True)
                except Exception:  # timeout, busy gate, model hiccup: skip this day, retry it later
                    failed.append(day)
                    continue
                with _lock:
                    for p in replay['points']:
                        _index[p['targetAt']] = {'probability': p['probability'], 'mwh': p['atRiskMwh']}
                    _index_state['days'] += 1
            pending = failed
            if not pending:
                break
            time.sleep(RETRY_PAUSE_SECONDS * (attempt + 1))
        _index_state['failedDays'] = pending
        if pending:
            return  # usable but incomplete; not saved, so the next server start completes it
        INDEX_DIR.mkdir(exist_ok=True)
        _index_file().write_text(json.dumps({'days': len(days), 'targets': _index}), encoding='utf-8')
        _index_state['ready'] = True
    finally:
        _index_state['building'] = False


def start_index_build():
    threading.Thread(target=lambda: _safe(build_index), name='target-index', daemon=True).start()


def _safe(fn):
    try:
        fn()
    except Exception:  # best effort; selection falls back to plain sampling
        _index_state['building'] = False


def banded_candidates():
    """{band: [targets predicted >= MIN_PREDICTED_MWH at +30 min]} from whatever is indexed so far."""
    allowed = set(dataset_targets())
    bands = {name: [] for name, _, _ in BANDS}
    with _lock:
        for target, row in _index.items():
            if row['mwh'] >= MIN_PREDICTED_MWH and target in allowed:
                bands[band_of(row['probability'])].append(target)
    return {name: sorted(found) for name, found in bands.items() if found}


# ---------------------------------------------------------------- selection

def selection_note(record):
    if record['mode'] == 'unfiltered':
        return 'Unfiltered: a uniformly random dataset half-hour, whatever its predicted energy.'
    if not record['metThreshold']:
        return (f"No sampled half-hour was predicted to have at least {record['minPredictedMwh']:g} MWh at both "
                f"horizons in {record['attempts']} tries; "
                f"showing the highest prediction found.")
    band = record.get('bandLabel')
    how = (f"from the {band} confidence band, itself picked at random so the dashboard shows a mix of risk levels"
           if band else 'at random')
    return (f"Chosen {how}, among half-hours the model predicts to have at least {record['minPredictedMwh']:g} MWh "
            f"at both horizons. "
            f"Selected from predictions only, not observed outcomes, so it is not a typical half-hour.")


def selection_for(target):
    """The selection record for a target chosen earlier in this server run, or a neutral one."""
    return _choices.get(target) or {
        'mode': 'pinned', 'usesObservedOutcomes': False,
        'note': 'This half-hour was chosen earlier; how it was selected is not known to this server run.'}


def _candidates(mode, rng):
    """(ordered candidate targets, band name or None)."""
    population = dataset_targets()
    if mode == 'unfiltered':
        return rng.sample(population, 1), None
    bands = banded_candidates()
    if bands:
        band = rng.choice(sorted(bands))  # every available confidence level is equally likely
        pool = bands[band]
        return rng.sample(pool, min(MAX_ATTEMPTS, len(pool))), band
    return rng.sample(population, min(MAX_ATTEMPTS, len(population))), None


def pick(capacity, fetch, mode='predicted', rng=None):
    """A forecast for a sampled target. `fetch(capacity, target)` returns a normalized forecast."""
    if mode not in MODES:
        raise ValueError('Unknown selection mode')
    rng = rng or random.Random()
    sample, band = _candidates(mode, rng)
    best, attempts, last_error = None, 0, None
    for target in sample:
        attempts += 1
        try:
            forecast = fetch(capacity, target)
        except HTTPError as error:
            if not (explorer.missing_row(error) or error.code < 500):
                raise
            last_error = error  # this candidate has no usable row; try another
            continue
        except CANDIDATE_ERRORS as error:
            last_error = error
            continue
        if best is None or least_predicted(forecast) > least_predicted(best):
            best = forecast
        if mode == 'unfiltered' or least_predicted(forecast) >= MIN_PREDICTED_MWH:
            break
    if best is None:
        raise last_error or ValueError('No dataset target could be forecast')
    labels = {name: label for name, _, label in BANDS}
    record = dict(mode=mode, minPredictedMwh=MIN_PREDICTED_MWH, attempts=attempts, population=len(dataset_targets()),
                  metThreshold=mode == 'unfiltered' or least_predicted(best) >= MIN_PREDICTED_MWH,
                  band=band, bandLabel=labels.get(band), indexedDays=_index_state['days'],
                  usesObservedOutcomes=False)
    record['note'] = selection_note(record)
    _choices[best['targetAt'].replace('+00:00', 'Z')] = record
    best['selection'] = record
    return best


def index_status():
    bands = banded_candidates() if _index else {}
    return dict(_index_state, bands={name: len(found) for name, found in bands.items()})

