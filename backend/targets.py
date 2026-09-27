"""Random high-MWh targets for the dashboard's historical dataset prediction.

Instead of always showing the dataset's final half-hour, the dashboard shows a randomly
chosen target half-hour from the V1 dataset, prioritising targets the model predicts to
have extra dispatch-down energy:

1. Candidates: every dataset target that has both a +30 and a +60 minute issue time and
   whose observed EirGrid dispatch-down is at least MIN_PREDICTED_MWH (one cheap batch
   lookup per 200 targets, cached for the life of the server; the dataset is fixed).
2. Pick one at random, weighted by that observed energy, and ask the model for both
   horizons.
3. Keep it only if the model *predicts* at least MIN_PREDICTED_MWH at both horizons;
   otherwise try another candidate. After MAX_ATTEMPTS the pick with the highest
   predicted energy is used.
"""
import random
import threading

import explorer

MIN_PREDICTED_MWH = 20.0
MAX_ATTEMPTS = 6
_lock = threading.Lock()


def both_horizon_targets(times):
    """Target half-hours the model can forecast at both +30 and +60 minutes."""
    available, last = set(times), max(times)
    return [t for t in explorer.valid_targets(times) if len(explorer.forecast_issues(t, available, last)) == 2]


def candidates():
    """[(target, observed MWh)] for targets with at least MIN_PREDICTED_MWH observed dispatch-down."""
    def build():
        targets = both_horizon_targets(explorer.short_term_info()['times'])
        batches = [targets[i:i + 200] for i in range(0, len(targets), 200)]
        actuals = {}
        for found in explorer.parallel(*[lambda b=b: explorer._v1_actuals(b) for b in batches]):
            actuals.update(found)
        pool = [(t, actuals[t]['dispatchDownMwh']) for t in targets
                if t in actuals and (actuals[t]['dispatchDownMwh'] or 0) >= MIN_PREDICTED_MWH]
        if not pool:
            raise ValueError('No dataset targets with enough dispatch-down to choose from')
        return pool
    with _lock:  # build the pool once even if several requests arrive together
        return explorer.cached('dashboard-target-pool', None, build)


def is_dataset_target(target):
    return target in set(both_horizon_targets(explorer.short_term_info()['times']))


def least_predicted(forecast):
    return min(p['atRiskMwh'] for p in forecast['predictions'])


def pick(capacity, fetch, rng=None):
    """A forecast for a random high-MWh target. `fetch(capacity, target)` returns a normalized forecast."""
    rng = rng or random.Random()
    pool, tried, best = list(candidates()), set(), None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        remaining = [(t, mwh) for t, mwh in pool if t not in tried]
        if not remaining:
            break
        target = rng.choices([t for t, _ in remaining], weights=[mwh for _, mwh in remaining])[0]
        tried.add(target)
        forecast = fetch(capacity, target)
        if best is None or least_predicted(forecast) > least_predicted(best):
            best = forecast
        if least_predicted(forecast) >= MIN_PREDICTED_MWH:
            break
    best['selection'] = dict(mode='random-high-mwh', minPredictedMwh=MIN_PREDICTED_MWH,
                             candidates=len(pool), attempts=attempt,
                             metThreshold=least_predicted(best) >= MIN_PREDICTED_MWH)
    return best
