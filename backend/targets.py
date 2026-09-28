"""How the dashboard chooses its historical target half-hour.

Selection uses model predictions only, never observed outcomes:

- "predicted" (default): sample dataset target half-hours uniformly at random (without
  replacement) and keep the first where the model predicts at least MIN_PREDICTED_MWH at
  both horizons. After MAX_ATTEMPTS the highest prediction found is shown and the pages say
  the threshold was not met. The result is deliberately not a typical half-hour, and the
  pages say that too.
- "unfiltered": one uniformly random dataset target half-hour, whatever its prediction
  (including zero).

Observed EirGrid outcomes are not used to shortlist or weight candidates, so the choice
carries no hindsight (outcome-selection) bias. That is a presentation choice, separate from
how the model itself was trained.
"""
import random
import threading
from urllib.error import HTTPError

import explorer

MIN_PREDICTED_MWH = 20.0
MAX_ATTEMPTS = 10
MODES = ('predicted', 'unfiltered')
_lock = threading.Lock()
_choices = {}  # target -> selection record, so later (pinned) requests can still explain it
# Errors that rule out one candidate only. Anything else (network, timeout, 5xx) means the
# model is unavailable and is raised so the caller can fall back.
CANDIDATE_ERRORS = (ValueError, KeyError, TypeError)


def both_horizon_targets(times):
    """Target half-hours the model can forecast at both +30 and +60 minutes."""
    available, last = set(times), max(times)
    return [t for t in explorer.valid_targets(times) if len(explorer.forecast_issues(t, available, last)) == 2]


def dataset_targets():
    """Every dataset target with both horizons: the unbiased population that is sampled."""
    with _lock:
        return explorer.cached('dashboard-targets', None,
                               lambda: both_horizon_targets(explorer.short_term_info()['times']))


def is_dataset_target(target):
    return target in set(dataset_targets())


def least_predicted(forecast):
    return min(p['atRiskMwh'] for p in forecast['predictions'])


def selection_note(record):
    if record['mode'] == 'unfiltered':
        return 'Unfiltered: a uniformly random dataset half-hour, whatever its predicted energy.'
    if record['metThreshold']:
        return (f"Chosen at random from dataset half-hours, keeping the first the model predicts to have at least "
                f"{record['minPredictedMwh']:g} MWh at both horizons. Selected from predictions only, not observed "
                f"outcomes, so it is not a typical half-hour.")
    return (f"No sampled half-hour reached the {record['minPredictedMwh']:g} MWh prediction threshold in "
            f"{record['attempts']} tries; showing the highest prediction found.")


def selection_for(target):
    """The selection record for a target chosen earlier in this server run, or a neutral one."""
    return _choices.get(target) or {
        'mode': 'pinned', 'usesObservedOutcomes': False,
        'note': 'This half-hour was chosen earlier; how it was selected is not known to this server run.'}


def pick(capacity, fetch, mode='predicted', rng=None):
    """A forecast for a sampled target. `fetch(capacity, target)` returns a normalized forecast."""
    if mode not in MODES:
        raise ValueError('Unknown selection mode')
    rng = rng or random.Random()
    population = dataset_targets()
    sample = rng.sample(population, min(1 if mode == 'unfiltered' else MAX_ATTEMPTS, len(population)))
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
    record = dict(mode=mode, minPredictedMwh=MIN_PREDICTED_MWH, attempts=attempts, population=len(population),
                  metThreshold=mode == 'unfiltered' or least_predicted(best) >= MIN_PREDICTED_MWH,
                  usesObservedOutcomes=False)
    record['note'] = selection_note(record)
    _choices[best['targetAt'].replace('+00:00', 'Z')] = record
    best['selection'] = record
    return best
