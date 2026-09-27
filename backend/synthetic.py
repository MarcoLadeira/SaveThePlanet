"""Synthetic V1 scenarios for POST /predict/v1/from-raw.

Each scenario starts from the complete example request published in the model's
own OpenAPI document (paths["/predict/v1/from-raw"].post.requestBody.content
["application/json"].example), so no dataset access is needed, and varies it:

- Numeric inputs are scaled to 90-110% of their example values; example zeros stay zero.
- The five repeated history signals are also kept inside demo bounds taken from the
  model's January 2026 dataset (see HISTORY_BOUNDS). These are demo bounds, not
  verified ranges for today, and they win when they conflict with the 90-110% rule.
- Observed past dispatch-down stays zero, or 10-230 MWh for the labelled
  high-curtailment scenario.
- 48 consecutive history rows end 30 minutes before a current UTC :00/:30 issue time.
- Related values stay coherent (availability >= generation, all-island >= Ireland,
  ratios in [0, 1], only API-signed fields may be negative, :30 prices copy :00).
- Availability timestamps are no later than the issue time. They are synthetic
  metadata, not proof of publication.

Results are synthetic scenarios, never forecasts of the actual grid: the server
does not cache or store them.
"""
import copy
from datetime import datetime, timedelta, timezone
import os
import random

import explorer

LABEL = 'Synthetic scenario — not a forecast of today’s actual grid conditions.'
EXAMPLE_PATH = ('paths', '/predict/v1/from-raw', 'post', 'requestBody', 'content', 'application/json', 'example')
EXAMPLE_CACHE_SECONDS = 3600
SCENARIOS = ('ordinary', 'high-curtailment')

# Approximate bounds of the five repeated history signals in the model's January 2026 dataset.
HISTORY_BOUNDS = {
    'eirgrid_ie_wind_generation_mw': (190.0, 3220.0),
    'eirgrid_ie_demand_mw': (3650.0, 5465.0),
    'entsoe_price_eur_mwh': (85.0, 203.0),
    'eirgrid_snsp_ratio': (0.31, 0.70),
    'eirgrid_all_island_oversupply_mw': (0.0, 0.0),  # ordinary scenario; no verified bound for anything else
}
HIGH_DISPATCH_DOWN_MWH = (10.0, 230.0)
# The only numeric inputs the API allows to be negative.
SIGNED_FIELDS = {'entsoe_price_eur_mwh', 'eirgrid_ewic_flow_mw', 'eirgrid_greenlink_flow_mw',
                 'eirgrid_interjurisdictional_flow_mw'}
IRELAND_TO_ALL_ISLAND = [(f'eirgrid_ie_{name}', f'eirgrid_all_island_{name}') for name in (
    'generation_mw', 'demand_mw', 'wind_availability_mw', 'wind_generation_mw',
    'solar_availability_mw', 'solar_generation_mw', 'hydro_generation_mw')]
AVAILABILITY_PAIRS = [(f'eirgrid_{area}_{kind}_availability_mw', f'eirgrid_{area}_{kind}_generation_mw')
                      for area in ('ie', 'all_island') for kind in ('wind', 'solar')]
PENETRATION = [  # ratio field, numerator, denominator
    ('eirgrid_ie_wind_penetration_ratio', 'eirgrid_ie_wind_generation_mw', 'eirgrid_ie_demand_mw'),
    ('eirgrid_ie_solar_penetration_ratio', 'eirgrid_ie_solar_generation_mw', 'eirgrid_ie_demand_mw'),
    ('eirgrid_all_island_wind_penetration_ratio', 'eirgrid_all_island_wind_generation_mw', 'eirgrid_all_island_demand_mw'),
    ('eirgrid_all_island_solar_penetration_ratio', 'eirgrid_all_island_solar_generation_mw', 'eirgrid_all_island_demand_mw'),
    ('eirgrid_all_island_oversupply_ratio', 'eirgrid_all_island_oversupply_mw', 'eirgrid_all_island_demand_mw'),
]


def example_request():
    """The complete example request from the model's OpenAPI document (cached; returns a copy)."""
    def build():
        node = explorer.call('/openapi.json')
        for key in EXAMPLE_PATH:
            node = node[key]
        if not isinstance(node, dict) or len(node.get('history', [])) != 48:
            raise ValueError('OpenAPI example for /predict/v1/from-raw is missing or incomplete')
        return node
    return copy.deepcopy(explorer.cached('v1-raw-example', EXAMPLE_CACHE_SECONDS, build))


def half_hour_floor(moment):
    moment = moment.astimezone(timezone.utc).replace(second=0, microsecond=0)
    return moment.replace(minute=0 if moment.minute < 30 else 30)


def iso(moment):
    return moment.strftime('%Y-%m-%dT%H:%M:%SZ')


def is_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def clamp(value, low, high):
    return min(max(value, low), high)


def vary(value, factor):
    """Scale by a 90-110% factor; zeros stay zero."""
    return 0.0 if value == 0 else value * clamp(factor, 0.9, 1.1)


def _dispatch_down_walk(rng, count):
    low, high = HIGH_DISPATCH_DOWN_MWH
    value, series = rng.uniform(low + 40, high - 40), []
    for _ in range(count):
        value = clamp(value + rng.uniform(-25, 25), low, high)
        series.append(round(value, 3))
    return series


def build_request(example, horizon, scenario='ordinary', now=None, rng=None, capacity=None):
    """A varied, coherent /predict/v1/from-raw body. Raises ValueError for bad options."""
    if horizon not in (30, 60):
        raise ValueError('Horizon must be 30 or 60 minutes')
    if scenario not in SCENARIOS:
        raise ValueError('Unknown scenario')
    rng = rng or random.Random(os.urandom(16))
    issue = half_hour_floor(now or datetime.now(timezone.utc))
    body = copy.deepcopy(example)
    high = scenario == 'high-curtailment'
    dispatch = _dispatch_down_walk(rng, 49) if high else [0.0] * 49

    # History: one smooth factor per signal plus small per-row jitter, all within 90-110%.
    history = []
    signals = [k for k, v in example['history'][0].items() if is_number(v) and k != 'observed_dispatch_down_mwh']
    base = {k: rng.uniform(0.93, 1.07) for k in signals}
    for i, source in enumerate(example['history']):
        at = issue - timedelta(minutes=30 * (48 - i))
        row = {'timestamp_utc': iso(at), 'available_at_utc': iso(at)}  # synthetic metadata, <= issue
        for key in signals:
            value = vary(source[key], base[key] + rng.uniform(-0.03, 0.03))
            if key in HISTORY_BOUNDS:
                value = clamp(value, *HISTORY_BOUNDS[key])
            row[key] = round(value, 4)
        row['observed_dispatch_down_mwh'] = dispatch[i]
        if at.minute == 30 and history:  # hourly price carried into the :30 half-hour
            row['entsoe_price_eur_mwh'] = history[-1]['entsoe_price_eur_mwh']
        history.append(row)
    body['history'] = history

    # Current observation: vary every numeric value, then restore physical coherence.
    current = {k: (round(vary(v, rng.uniform(0.9, 1.1)), 4) if is_number(v) else v)
               for k, v in example['current_observation'].items()}
    for key, bounds in HISTORY_BOUNDS.items():
        if key in current:
            current[key] = clamp(current[key], *bounds)
    if issue.minute == 30:
        current['entsoe_price_eur_mwh'] = history[-1]['entsoe_price_eur_mwh']
    for availability, generation in AVAILABILITY_PAIRS[:2]:
        current[availability] = max(current[availability], current[generation])
    for ireland, all_island in IRELAND_TO_ALL_ISLAND:
        current[all_island] = max(current[all_island], current[ireland])
    for availability, generation in AVAILABILITY_PAIRS[2:]:
        current[availability] = max(current[availability], current[generation])
    for ratio, numerator, denominator in PENETRATION:
        current[ratio] = clamp(current[numerator] / current[denominator], 0, 1) if current[denominator] else 0.0
    current['observed_dispatch_down_mwh'] = dispatch[48]
    current['available_at_utc'] = iso(issue)
    body.update(issue_timestamp_utc=iso(issue), forecast_horizon_minutes=horizon, current_observation=current)
    if capacity is not None:
        body['flexible_load_capacity_mw'] = capacity
    return body


def check_request(body, scenario='ordinary'):
    """Every rule the synthetic request must satisfy; returns a list of problems (empty if valid)."""
    problems = []
    issue = datetime.fromisoformat(body['issue_timestamp_utc'].replace('Z', '+00:00'))
    if issue.minute not in (0, 30) or issue.second:
        problems.append('issue time is not on a :00/:30 boundary')
    if body['forecast_horizon_minutes'] not in (30, 60):
        problems.append('horizon must be 30 or 60')
    history, current = body['history'], body['current_observation']
    if len(history) != 48:
        problems.append('history must have exactly 48 rows')
    for i, row in enumerate(history):
        at = datetime.fromisoformat(row['timestamp_utc'].replace('Z', '+00:00'))
        if at != issue - timedelta(minutes=30 * (48 - i)):
            problems.append(f'history row {i} is not the expected consecutive half-hour')
        if datetime.fromisoformat(row['available_at_utc'].replace('Z', '+00:00')) > issue:
            problems.append(f'history row {i} is available after the issue time')
        for key, (low, high) in HISTORY_BOUNDS.items():
            if not low - 1e-9 <= row[key] <= high + 1e-9:
                problems.append(f'history row {i} {key}={row[key]} outside {low}-{high}')
        dd = row['observed_dispatch_down_mwh']
        if (scenario == 'ordinary' and dd != 0) or (scenario != 'ordinary' and not HIGH_DISPATCH_DOWN_MWH[0] <= dd <= HIGH_DISPATCH_DOWN_MWH[1]):
            problems.append(f'history row {i} dispatch-down {dd} breaks the {scenario} rule')
        if at.minute == 30 and i and row['entsoe_price_eur_mwh'] != history[i - 1]['entsoe_price_eur_mwh']:
            problems.append(f'history row {i} :30 price does not copy the preceding :00')
    if datetime.fromisoformat(current['available_at_utc'].replace('Z', '+00:00')) > issue:
        problems.append('current observation is available after the issue time')
    if issue.minute == 30 and history and current['entsoe_price_eur_mwh'] != history[-1]['entsoe_price_eur_mwh']:
        problems.append('current :30 price does not copy the preceding :00')
    for key, value in list(current.items()) + [(k, v) for row in history for k, v in row.items()]:
        if is_number(value) and value < 0 and key not in SIGNED_FIELDS:
            problems.append(f'{key} is negative')
    for key, value in current.items():
        if key.endswith('_ratio') and is_number(value) and not 0 <= value <= 1:
            problems.append(f'{key} outside 0-1')
    for availability, generation in AVAILABILITY_PAIRS:
        if current[availability] < current[generation]:
            problems.append(f'{availability} below {generation}')
    for ireland, all_island in IRELAND_TO_ALL_ISLAND:
        if current[all_island] < current[ireland]:
            problems.append(f'{all_island} below {ireland}')
    return problems


def summary(body):
    """What the page shows about the generated inputs."""
    history, current = body['history'], body['current_observation']
    ranges = {key: [min(r[key] for r in history), max(r[key] for r in history)]
              for key in list(HISTORY_BOUNDS) + ['observed_dispatch_down_mwh']}
    return {
        'issuedAt': body['issue_timestamp_utc'],
        'historyFrom': history[0]['timestamp_utc'], 'historyTo': history[-1]['timestamp_utc'],
        'historyRows': len(history), 'historyRanges': ranges,
        'current': {key: current[key] for key in (
            'eirgrid_ie_wind_generation_mw', 'eirgrid_ie_demand_mw', 'entsoe_price_eur_mwh',
            'eirgrid_snsp_ratio', 'eirgrid_all_island_oversupply_mw', 'observed_dispatch_down_mwh')},
    }


def run(horizon, scenario='ordinary', capacity=None):
    """Generate a scenario, call the model and return a clearly labelled synthetic result."""
    body = build_request(example_request(), horizon, scenario, capacity=capacity)
    problems = check_request(body, scenario)
    if problems:  # never send a request that breaks the stated rules
        raise ValueError('Synthetic request failed its own checks: ' + '; '.join(problems[:3]))
    response = explorer.call('/predict/v1/from-raw', body)
    prediction = explorer._v1_point(response)
    return {
        'synthetic': True, 'label': LABEL, 'scenario': scenario,
        'scenarioLabel': 'High-curtailment scenario (synthetic)' if scenario == 'high-curtailment' else 'Ordinary scenario (synthetic)',
        'modelVersion': response.get('model_version'),
        'inputProvenance': response.get('input_provenance'), 'inputNotice': response.get('input_notice'),
        'prediction': prediction, 'inputs': summary(body), 'request': body,
        'notes': [
            'Inputs are the API’s own example request varied to 90–110% (example zeros stay zero).',
            'History bounds come from the model’s January 2026 dataset: demo bounds, not verified ranges for today.',
            'Availability timestamps are synthetic metadata, not proof of publication.',
        ],
    }
