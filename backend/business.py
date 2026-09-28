"""Business and environmental impact of smarter EV charging (the Impact page).

Carlson's GridToEv +30 minute forecasts -> a simulated depot fleet charged three ways on identical
conditions -> electricity cost, estimated CO2 and surplus renewable energy -> a yearly projection and
an investment case. Contract and methodology: docs/BUSINESS_IMPACT.md.

What this module guarantees (tests in tests/test_business.py check each point):
- Every strategy charges the same vans, on the same nights, under the same tariff, chargers, site
  limit and starting state. Only the charging rule differs.
- No look-ahead. A decision for a half-hour is made 30 minutes before it starts and sees only
  forecasts issued by then (ForecastView). Observed outcomes never reach a plan: they are used
  afterwards, to score it.
- A forecast is not recovered energy. Surplus renewable energy is credited only where observed
  curtailment coincided with charging, capped by that charging. Curtailment is system-wide, so the
  claim is conditional: network deliverability for a real site is not verified. Location-specific
  constraint energy is not claimed at all.
- Charging losses are counted: the grid supplies each van's battery energy / efficiency.
- The +30 and +60 minute forecasts of one half-hour are two estimates, never added: only +30 is used.
- The year is not a copy of one winter week. Tariff savings recur every operating day; the part that
  depends on surplus renewable energy is scaled by how often curtailment happened over a full
  observed year (GridToEv's daily dataset) compared with the evaluation week.
- The fleet, prices and investment costs are illustrative assumptions and are labelled as such.
  Nothing here is a measured saving.
- Jerry's energy bridge (optimizer.py, issue #50) is the team's single definition of a feasible plan:
  every strategy's plan must pass its check_plan(), and the calculator's EV count is planned by it on
  the example site, so extra EVs only count while the site's chargers and connection can take them.
"""
from datetime import date, datetime, timedelta, timezone
from functools import lru_cache
from http.client import HTTPException
import hashlib
import json
import math
import threading
import time
from urllib.error import URLError

import explorer
import fleet as fleets
import optimizer
from gate import FOREGROUND, PREFETCH, Busy
from scenario import GRID_INTENSITY_T_PER_MWH

VERSION = 'business-impact/v1'
SLOT_MINUTES = 30
SLOT_HOURS = SLOT_MINUTES / 60
NIGHT_START_MINUTE = 12 * 60  # a night runs from 12:00 UTC on its date to 12:00 the next day
NIGHT_SLOTS = 48
EVAL_NIGHTS = 7
MIN_FORECAST_SHARE = 0.9  # a dataset day is usable when >= 90% of its half-hours have a +30 forecast
AI_BUFFER = 0.25  # the AI keeps a quarter of the cheap-hours capacity in reserve while it waits
GRID_KG_PER_KWH = GRID_INTENSITY_T_PER_MWH  # 0.25 t/MWh is 0.25 kg/kWh
EPS = 1e-9

FLEET = {
    'id': 'example-depot/v1', 'name': 'Example delivery depot', 'provenance': 'simulated',
    'vehicles': 20, 'chargers': 20, 'chargerKw': 11, 'vehicleMaxKw': 11, 'sitePowerKw': 180,
    'chargingEfficiency': 0.9,
    'pattern': ('20 vans plug in between 17:00 and 19:30 and leave between 06:00 and 07:30. '
                'Each needs 28-45 kWh in its battery per night.'),
}
TARIFF = {
    'id': 'example-business-tou/v1', 'provenance': 'illustrative', 'currency': 'EUR',
    'clock': 'UTC (Irish winter time)',
    # Earlier bands win where they overlap: peak sits inside the day band.
    'bands': [
        {'id': 'night', 'label': 'Night', 'from': '23:00', 'to': '08:00', 'eurPerKwh': 0.16},
        {'id': 'peak', 'label': 'Peak', 'from': '17:00', 'to': '19:00', 'eurPerKwh': 0.34},
        {'id': 'day', 'label': 'Day', 'from': '08:00', 'to': '23:00', 'eurPerKwh': 0.26},
    ],
    'surplusDiscountEurPerKwh': 0.08,
    'note': ('Illustrative business time-of-use prices, not a supplier quote. The surplus discount stands for a '
             'dynamic tariff or flexibility payment on energy used while renewable output is being curtailed.'),
}
COSTS = {
    'implementationEur': 15000, 'annualEur': 2400, 'provenance': 'illustrative',
    'note': 'Example one-off setup (software and charger integration) and yearly software cost. Replace with real quotes.',
}
OPERATING_DAYS = 260
ROI_YEARS = 5
SCALING_SITES = (1, 5, 10, 25)
STRATEGIES = (
    ('normal', 'Normal charging', 'Plug in and charge straight away at full power.'),
    ('basic', 'Basic smart charging',
     'A fixed rule: wait for the cheapest tariff hours, then charge. Start earlier only if a van would otherwise miss its departure.'),
    ('ai', 'Our AI charging',
     'Uses the GridToEv forecast issued 30 minutes ahead: charges when surplus renewable energy is forecast and it pays, '
     'otherwise waits inside the cheap hours while every van can still finish on time.'),
)
STRATEGY_IDS = tuple(s[0] for s in STRATEGIES)
SUM_KEYS = ('gridKwh', 'batteryKwh', 'lossKwh', 'tariffCostEur', 'surplusCreditEur', 'costEur', 'absorbedKwh',
            'co2Kg', 'vehicles', 'vehiclesMet', 'unmetKwh', 'unscoredKwh')
# Upstream failures that mean "the model is unavailable" rather than "this day failed".
MODEL_ERRORS = (URLError, TimeoutError, OSError, HTTPException)
REPLAY_ATTEMPTS = 8
BUSY_PAUSE_SECONDS = 5


def _utc(value):
    return datetime.fromisoformat(str(value).replace('Z', '+00:00')).astimezone(timezone.utc)


# ---------------------------------------------------------------- assumptions

def _minute_of(text):
    hours, minutes = text.split(':')
    return int(hours) * 60 + int(minutes)


def band_at(minute, tariff=TARIFF):
    """The tariff band for a minute of the (UTC) day."""
    m = minute % 1440
    for band in tariff['bands']:
        start, end = _minute_of(band['from']), _minute_of(band['to'])
        if (start <= m < end) if start < end else (m >= start or m < end):
            return band
    raise ValueError('Tariff bands must cover the whole day')


def van_hours(i):
    """(arrive, depart) of the i-th van, in minutes from 00:00 UTC on the night's date."""
    return 17 * 60 + (i % 6) * 30, 24 * 60 + 6 * 60 + (i % 4) * 30  # plugs in 17:00-19:30, leaves 06:00-07:30


def fleet_vehicles(night_index, fleet=FLEET):
    """The simulated depot's vans for one night; times are minutes from 00:00 UTC on the night's date.

    Deterministic, so every strategy and every run sees exactly the same fleet."""
    return [{'id': f'EV-{i + 1:02d}', 'arriveMin': van_hours(i)[0], 'departMin': van_hours(i)[1],
             'requiredKwh': float(28 + (i * 7 + night_index * 5) % 18),  # battery side, 28-45 kWh
             'maxKw': fleet['vehicleMaxKw']}
            for i in range(fleet['vehicles'])]


def example_site(fleet=FLEET):
    """The simulated depot as an energy-bridge site (fleet/v1)."""
    return {'id': 'depot', 'name': fleet['name'], 'region': 'IE', 'chargers': fleet['chargers'],
            'chargerKw': fleet['chargerKw'], 'sitePowerKw': fleet['sitePowerKw']}


def bridge_fleet(vehicles, start_minute, fleet=FLEET):
    """Vans as a validated fleet/v1 for the energy bridge, with times counted from `start_minute`."""
    return fleets.validate({'chargingEfficiency': fleet['chargingEfficiency'], 'sites': [example_site(fleet)],
                            'vehicles': [{'id': v['id'], 'site': 'depot', 'arriveMin': v['arriveMin'] - start_minute,
                                          'departMin': v['departMin'] - start_minute, 'requiredKwh': v['requiredKwh'],
                                          'maxKw': v['maxKw']} for v in vehicles]})


def bridge_check(plan, slots, vehicles, fleet=FLEET):
    """Every hard-constraint problem in a night plan, found by the energy bridge's own checker
    (optimizer.check_plan): plug-in hours, charger rate, charger count, site power, no overfilling."""
    checked = optimizer.Plan(bridge_fleet(vehicles, slots[0]['minute'], fleet), len(slots))
    for vid, row in plan.items():
        checked.alloc[vid] = {i: kwh for i, kwh in enumerate(row) if kwh > 0}
    return optimizer.check_plan(checked)


def grid_kwh_per_ev_day(fleet=FLEET):
    """Average grid energy one van draws per operating day, losses included (the pattern repeats every 18 nights)."""
    battery = sum(v['requiredKwh'] for k in range(18) for v in fleet_vehicles(k, fleet)) / (18 * fleet['vehicles'])
    return battery / fleet['chargingEfficiency']


# ---------------------------------------------------------------- one night

def night_slots(day):
    """The 48 half-hours of the night that starts on `day` (12:00 UTC to 12:00 the next day)."""
    start = datetime.fromisoformat(f'{day}T00:00:00+00:00') + timedelta(minutes=NIGHT_START_MINUTE)
    return [{'start': explorer.iso(start + timedelta(minutes=SLOT_MINUTES * i)), 'minute': NIGHT_START_MINUTE + SLOT_MINUTES * i}
            for i in range(NIGHT_SLOTS)]


class ForecastView:
    """The forecasts a depot would have had: each one only from the moment it was issued."""

    def __init__(self, forecasts):
        self._by_target = {f['targetAt']: f for f in forecasts}

    def get(self, target, now):
        found = self._by_target.get(target)
        if found is None or _utc(found['issuedAt']) > now:
            return None
        return found


def _allocate(requests, site_kwh, chargers):
    """Share one half-hour's site energy: every 'must' first, then the rest, earliest departure first."""
    order = sorted(requests, key=lambda r: (r[0]['departMin'], r[0]['id']))
    given, used = {}, 0.0
    for phase in ('must', 'want'):
        for vehicle, must, want in order:
            extra = (must if phase == 'must' else want) - given.get(vehicle['id'], 0.0)
            if extra <= EPS or (vehicle['id'] not in given and len(given) >= chargers):
                continue
            amount = min(extra, site_kwh - used)
            if amount <= EPS:
                continue
            given[vehicle['id']] = given.get(vehicle['id'], 0.0) + amount
            used += amount
    return given


def plan_night(strategy, slots, vehicles, known, fleet=FLEET, tariff=TARIFF):
    """Grid kWh drawn by each van in each half-hour of one night under one strategy.

    `known` is the only source of forecasts: each decision asks it for its own half-hour as of 30
    minutes before that half-hour starts. Observed outcomes never reach this function.
    Returns (plan {van: [kWh per slot]}, AI decisions [{slot, surplusForecast, forecastAvailable}]).
    """
    if strategy not in STRATEGY_IDS:
        raise ValueError('Unknown strategy')
    site_kwh = fleet['sitePowerKw'] * SLOT_HOURS
    discount = tariff['surplusDiscountEurPerKwh']
    prices = [band_at(s['minute'], tariff)['eurPerKwh'] for s in slots]
    plugged = [[v for v in vehicles if v['arriveMin'] <= s['minute'] and s['minute'] + SLOT_MINUTES <= v['departMin']]
               for s in slots]
    rates = {v['id']: min(v['maxKw'], fleet['chargerKw']) * SLOT_HOURS for v in vehicles}
    # What a van can count on in a later half-hour: its own rate, or an equal share of the site
    # limit among every van due to be plugged in then (the depot knows its own rota in advance).
    fair = [{v['id']: min(rates[v['id']], site_kwh / len(group)) for v in group} for group in plugged]
    remaining = {v['id']: v['requiredKwh'] / fleet['chargingEfficiency'] for v in vehicles}
    plan = {v['id']: [0.0] * len(slots) for v in vehicles}
    decisions = []
    for i, slot in enumerate(slots):
        forecast = None
        if strategy == 'ai':
            forecast = known.get(slot['start'], _utc(slot['start']) - timedelta(minutes=SLOT_MINUTES))
        # Enough curtailment forecast to cover the whole site's draw in this half-hour.
        surplus = forecast is not None and forecast['curtailmentKwh'] >= site_kwh
        requests = []
        for v in plugged[i]:
            need = remaining[v['id']]
            if need <= EPS:
                continue
            rate = min(rates[v['id']], need)
            later = [j for j in range(i + 1, len(slots)) if v['id'] in fair[j]]
            cheapest = min([prices[i]] + [prices[j] for j in later])
            cheap_later = sum(fair[j][v['id']] for j in later if prices[j] <= cheapest + EPS)
            if strategy == 'normal':
                must = want = rate
            elif strategy == 'basic':
                must = min(rate, max(0.0, need - cheap_later))
                want = rate if prices[i] <= cheapest + EPS else must
            else:
                # Inside the cheapest hours it waits for surplus, but keeps a reserve of capacity so the
                # vans still finish on time; outside them it follows the same guard as the basic rule.
                reserve = AI_BUFFER if prices[i] <= cheapest + EPS else 0.0
                must = min(rate, max(0.0, need - cheap_later * (1 - reserve)))
                want = rate if surplus and prices[i] - discount <= cheapest + EPS else must
            requests.append((v, must, want))
        for vid, kwh in _allocate(requests, site_kwh, fleet['chargers']).items():
            plan[vid][i] = kwh
            remaining[vid] -= kwh
        if strategy == 'ai' and plugged[i]:
            decisions.append({'slot': slot['start'], 'surplusForecast': surplus, 'forecastAvailable': forecast is not None})
    return plan, decisions


def score_night(plan, slots, vehicles, observed, fleet=FLEET, tariff=TARIFF):
    """Money, CO2 and surplus energy of one night's plan, judged against what was observed.

    `observed` maps each half-hour to observed curtailment in kWh (None when unknown). Charging in a
    half-hour with no observation is paid at the tariff and never credited with surplus energy.
    """
    efficiency = fleet['chargingEfficiency']
    discount = tariff['surplusDiscountEurPerKwh']
    grid_slots = [sum(plan[v['id']][i] for v in vehicles) for i in range(len(slots))]
    tariff_cost = absorbed = unscored = 0.0
    for i, slot in enumerate(slots):
        grid = grid_slots[i]
        tariff_cost += grid * band_at(slot['minute'], tariff)['eurPerKwh']
        seen = observed.get(slot['start'])
        if seen is None:
            unscored += grid
        else:
            absorbed += min(grid, max(0.0, seen))
    grid = sum(grid_slots)
    battery = grid * efficiency
    delivered = {v['id']: sum(plan[v['id']]) * efficiency for v in vehicles}
    return {
        'gridKwh': grid, 'batteryKwh': battery, 'lossKwh': grid - battery,
        'tariffCostEur': tariff_cost, 'surplusCreditEur': absorbed * discount, 'costEur': tariff_cost - absorbed * discount,
        'absorbedKwh': absorbed, 'co2Kg': (grid - absorbed) * GRID_KG_PER_KWH,
        'vehicles': len(vehicles), 'vehiclesMet': sum(1 for v in vehicles if delivered[v['id']] >= v['requiredKwh'] - 1e-6),
        'unmetKwh': sum(max(0.0, v['requiredKwh'] - delivered[v['id']]) for v in vehicles),
        'unscoredKwh': unscored, 'peakKw': max(grid_slots, default=0.0) / SLOT_HOURS,
    }


# ---------------------------------------------------------------- the evaluation period

def evaluate(nights, fleet=FLEET, tariff=TARIFF):
    """Run the three strategies on the same nights; totals per strategy plus AI forecast calls."""
    per = {sid: [] for sid in STRATEGY_IDS}
    calls = {'surplusCalls': 0, 'right': 0, 'falseAlarms': 0, 'missed': 0, 'unknown': 0, 'noForecast': 0}
    site_kwh = fleet['sitePowerKw'] * SLOT_HOURS
    shifted = 0.0
    rows = []
    for night in nights:
        vehicles = fleet_vehicles(night['index'], fleet)
        known = ForecastView(night['forecasts'])
        plans = {}
        scores = {}
        for sid in STRATEGY_IDS:
            plan, decisions = plan_night(sid, night['slots'], vehicles, known, fleet, tariff)
            problems = bridge_check(plan, night['slots'], vehicles, fleet)
            if problems:  # a bug, never data: refuse rather than show an infeasible plan
                raise RuntimeError(f'{sid} plan for {night["date"]} failed the energy bridge check: {problems[0]}')
            plans[sid] = plan
            scores[sid] = score_night(plan, night['slots'], vehicles, night['observed'], fleet, tariff)
            per[sid].append(scores[sid])
            for d in decisions:
                seen = night['observed'].get(d['slot'])
                actual = None if seen is None else seen >= site_kwh
                calls['noForecast'] += not d['forecastAvailable']
                calls['surplusCalls'] += d['surplusForecast']
                if actual is None:
                    calls['unknown'] += 1
                elif d['surplusForecast']:
                    calls['right' if actual else 'falseAlarms'] += 1
                elif actual:
                    calls['missed'] += 1
        # Energy the AI moved to a different half-hour than normal charging would have used.
        for i in range(len(night['slots'])):
            normal = sum(plans['normal'][v['id']][i] for v in vehicles)
            ai = sum(plans['ai'][v['id']][i] for v in vehicles)
            shifted += max(0.0, normal - ai)
        rows.append({'date': night['date'], **{sid: {'costEur': round(scores[sid]['costEur'], 2),
                                                        'absorbedKwh': round(scores[sid]['absorbedKwh'], 1),
                                                        'vehiclesMet': scores[sid]['vehiclesMet']}
                                                  for sid in STRATEGY_IDS}})
    totals = {sid: {key: sum(n[key] for n in per[sid]) for key in SUM_KEYS} for sid in STRATEGY_IDS}
    for sid in STRATEGY_IDS:
        totals[sid]['peakKw'] = max((n['peakKw'] for n in per[sid]), default=0.0)
    return {'totals': totals, 'calls': calls, 'shiftedKwh': shifted, 'nights': rows}


def annualise(total, nights, factor, days=OPERATING_DAYS, tariff=TARIFF):
    """One strategy's year: per-night tariff cost x operating days, with the surplus part scaled by `factor`."""
    grid = total['gridKwh'] / nights
    absorbed = min(grid, total['absorbedKwh'] / nights * factor)
    cost = total['tariffCostEur'] / nights - absorbed * tariff['surplusDiscountEurPerKwh']
    return {'costEur': cost * days, 'co2T': (grid - absorbed) * GRID_KG_PER_KWH * days / 1000,
            'surplusKwh': absorbed * days, 'gridKwh': grid * days,
            'renewableShare': absorbed / grid if grid > 0 else None}


def financials(annual, costs=COSTS):
    """The yearly money story in whole euros. Every figure is derived from the same rounded parts, so
    the waterfall, the KPI cards and the investment details always agree to the euro."""
    base, basic, ai = (round(annual[sid]['costEur']) for sid in STRATEGY_IDS)
    running, implementation = round(costs['annualEur']), round(costs['implementationEur'])
    timing, ai_extra = base - basic, basic - ai
    final = base - timing - ai_extra + running
    net = base - final
    if net <= 0:
        payback, status = None, 'not-achieved'
    else:
        payback, status = round(implementation / net * 12, 1), 'months'
    horizon_net = ROI_YEARS * net - implementation
    return {
        'baselineCostEur': base, 'smartTimingSavingsEur': timing, 'aiSavingsEur': ai_extra,
        'grossSavingsEur': timing + ai_extra, 'annualCostsEur': running, 'implementationEur': implementation,
        'finalCostEur': final, 'netSavingsEur': net, 'paybackMonths': payback, 'paybackStatus': status,
        'roiYears': ROI_YEARS, 'roiNetEur': horizon_net,
        'roiPct': round(horizon_net / implementation * 100) if implementation > 0 else None,
        # From the same rounded tonnes the comparison chart shows, so the two always agree.
        'co2ReductionT': round(round(annual['normal']['co2T'], 2) - round(annual['ai']['co2T'], 2), 2),
    }


def waterfall(fin):
    return [
        {'id': 'baseline', 'label': 'Normal charging', 'kind': 'total', 'valueEur': fin['baselineCostEur']},
        {'id': 'timing', 'label': 'Smarter timing', 'kind': 'delta', 'valueEur': -fin['smartTimingSavingsEur']},
        {'id': 'ai', 'label': 'AI forecast', 'kind': 'delta', 'valueEur': -fin['aiSavingsEur']},
        {'id': 'running', 'label': 'Software costs', 'kind': 'delta', 'valueEur': fin['annualCostsEur']},
        {'id': 'final', 'label': 'With our AI', 'kind': 'total', 'valueEur': fin['finalCostEur']},
    ]


def seasonal_adjustment(period_days, year_days, actuals):
    """How often curtailment happened over a full observed year, relative to the evaluation days.

    `actuals` maps a date to GridToEv's daily observation ({'curtailmentMwh', 'event'}). The fleet
    draws far less than any curtailment event, so what matters is how often surplus occurs, not
    its size: the factor is a ratio of event-day frequencies.
    """
    def rate(days):
        seen = [actuals[d] for d in days if actuals.get(d) and actuals[d].get('curtailmentMwh') is not None]
        events = sum(1 for a in seen if (a['event'] if isinstance(a.get('event'), bool) else a['curtailmentMwh'] > 0))
        return (events / len(seen) if seen else None), len(seen)
    year_rate, year_n = rate(year_days)
    period_rate, period_n = rate(period_days)
    base = {'method': 'event-day frequency, full observed year vs evaluation days',
            'yearFrom': min(year_days, default=None), 'yearTo': max(year_days, default=None),
            'yearDays': year_n, 'yearEventRate': year_rate, 'periodDays': period_n, 'periodEventRate': period_rate}
    if year_rate is None or period_rate is None or year_n < 180 or period_n < 3:
        return {**base, 'available': False, 'factor': None,
                'reason': 'Not enough observed daily curtailment to adjust for the season.'}
    if period_rate == 0:
        return {**base, 'available': False, 'factor': None,
                'reason': 'The evaluation days had no curtailment days to scale from.'}
    return {**base, 'available': True, 'factor': year_rate / period_rate, 'reason': None}


def build_result(nights, meta, seasonal, fleet=FLEET, tariff=TARIFF, costs=COSTS, days=OPERATING_DAYS):
    """The whole Impact payload from simulated nights, provenance metadata and the seasonal adjustment."""
    if not nights:
        return empty_result(meta, 'No complete night of forecasts and observations was available to evaluate.')
    ev = evaluate(nights, fleet, tariff)
    count = len(nights)
    expected_factor = seasonal['factor'] if seasonal.get('available') else 1.0
    # Three assumptions about how often surplus renewable energy occurs over a year.
    factors = {'no-surplus': 0.0, 'seasonal' if seasonal.get('available') else 'evaluation-week': expected_factor,
               'evaluation-week': max(1.0, expected_factor)}
    expected_basis = 'seasonal' if seasonal.get('available') else 'evaluation-week'
    annual = {case: {sid: annualise(ev['totals'][sid], count, f, days, tariff) for sid in STRATEGY_IDS}
              for case, f in factors.items()}
    fin = {case: financials(annual[case], costs) for case in factors}
    expected, year = fin[expected_basis], annual[expected_basis]
    # Conservative and optimistic are the lowest and highest net savings of the two extremes. Surplus
    # usually favours the AI, but when normal charging happens to meet more of it (evening surplus),
    # counting no surplus at all is the optimistic case, so the labels follow the numbers.
    low, high = sorted(('no-surplus', 'evaluation-week'), key=lambda case: fin[case]['netSavingsEur'])
    cases = {'conservative': low, 'expected': expected_basis, 'optimistic': high}
    totals = ev['totals']
    strategies = []
    for sid, label, description in STRATEGIES:
        t = totals[sid]
        strategies.append({
            'id': sid, 'label': label, 'description': description,
            'annual': {'costEur': round(year[sid]['costEur']), 'co2T': round(year[sid]['co2T'], 2),
                       'surplusKwh': round(year[sid]['surplusKwh']), 'gridKwh': round(year[sid]['gridKwh']),
                       'renewableShare': None if year[sid]['renewableShare'] is None else round(year[sid]['renewableShare'], 4)},
            'period': {'nights': count, 'gridKwh': round(t['gridKwh'], 1), 'batteryKwh': round(t['batteryKwh'], 1),
                       'lossKwh': round(t['gridKwh'] - t['batteryKwh'], 1), 'costEur': round(t['costEur'], 2),
                       'tariffCostEur': round(t['tariffCostEur'], 2), 'surplusCreditEur': round(t['surplusCreditEur'], 2),
                       'absorbedKwh': round(t['absorbedKwh'], 1), 'co2Kg': round(t['co2Kg'], 1),
                       'unscoredKwh': round(t['unscoredKwh'], 1), 'peakKw': round(t['peakKw'], 1)},
            'requirements': {'met': int(t['vehiclesMet']), 'total': int(t['vehicles']), 'unmetKwh': round(t['unmetKwh'], 1),
                             'allMet': t['vehiclesMet'] == t['vehicles']},
        })
    kwh_ev = grid_kwh_per_ev_day(fleet)
    # Calculator defaults that reproduce the depot's savings before costs: the share as shown (one
    # decimal), then the price difference that makes EVs x kWh x share x price x days match. Five
    # decimals keep the calculator within a euro of the waterfall (four were ~EUR 10 out).
    share = round(ev['shiftedKwh'] / totals['normal']['gridKwh'] * 100, 1) if totals['normal']['gridKwh'] > 0 else 0.0
    shifted_year = fleet['vehicles'] * kwh_ev * share / 100 * days
    price_diff = max(0.0, expected['grossSavingsEur'] / shifted_year) if shifted_year > 0 else 0.0
    scenario_id = hashlib.sha256(json.dumps([VERSION, fleet, tariff, costs, days, meta.get('modelVersion'), meta['dataMode'],
                                             [n['date'] for n in nights]], sort_keys=True).encode()).hexdigest()[:12]
    first, last = nights[0]['date'], nights[-1]['date']
    period = {'from': first, 'to': (date.fromisoformat(last) + timedelta(days=1)).isoformat(), 'nights': count,
              'nightDates': [n['date'] for n in nights], 'operatingDays': days,
              'selection': ('The latest consecutive dataset days with forecasts, chosen by position only, '
                            'never by how much surplus they had.')}
    return {
        'version': VERSION, 'status': 'ready', 'scenarioId': scenario_id,
        'generatedAt': datetime.now(timezone.utc).isoformat(),
        **meta,
        'company': {**fleet, 'kwhPerEvDay': round(kwh_ev, 1)},
        'period': period,
        'tariff': tariff, 'costs': costs,
        'kpis': {'annualSavingsEur': expected['netSavingsEur'], 'co2ReductionT': expected['co2ReductionT'],
                 'aiSavingsEur': expected['aiSavingsEur'], 'paybackMonths': expected['paybackMonths'],
                 'paybackStatus': expected['paybackStatus']},
        'financials': expected,
        'waterfall': waterfall(expected),
        'strategies': strategies,
        'forecastCalls': ev['calls'],
        'nights': ev['nights'],
        'seasonal': {**seasonal, 'appliedFactor': round(expected_factor, 4)},
        'scenarios': {label: {'basis': case, 'surplusFactor': round(factors[case], 4),
                              'annualSavingsEur': fin[case]['netSavingsEur'], 'aiSavingsEur': fin[case]['aiSavingsEur'],
                              'co2ReductionT': fin[case]['co2ReductionT'], 'paybackMonths': fin[case]['paybackMonths'],
                              'paybackStatus': fin[case]['paybackStatus'], 'roiNetEur': fin[case]['roiNetEur']}
                      for label, case in cases.items()},
        'scaling': [{'sites': n, 'annualSavingsEur': n * expected['netSavingsEur'],
                     'co2ReductionT': round(n * expected['co2ReductionT'], 2),
                     'implementationEur': n * expected['implementationEur']} for n in SCALING_SITES],
        'calculator': {'kwhPerEvDay': round(kwh_ev, 1), 'illustrative': True,
                       'defaults': {'evs': fleet['vehicles'], 'shiftablePct': share,
                                    'priceDiffEurPerKwh': round(price_diff, 5), 'operatingDays': days,
                                    'implementationEur': costs['implementationEur'], 'annualEur': costs['annualEur']}},
        'emissions': {'gridIntensityKgPerKwh': GRID_KG_PER_KWH, 'status': 'estimated',
                      'method': ('Grid electricity at an average of 0.25 kg CO2 per kWh. Charging that coincided with observed '
                                 'curtailment is counted as surplus renewable energy with no extra emissions. The reduction '
                                 'compares normal charging with our AI charging on the same vans and nights.')},
        'methodology': methodology(fleet, tariff, days),
        'limitations': LIMITATIONS,
    }


def methodology(fleet, tariff, days):
    night, peak, day = (b['eurPerKwh'] for b in tariff['bands'])
    return [
        f"Each night, {fleet['vehicles']} simulated vans are charged three ways on identical conditions: the same arrivals, "
        f"departures and energy needs, {fleet['chargers']} x {fleet['chargerKw']:g} kW chargers and a {fleet['sitePowerKw']:g} kW site limit.",
        'Our AI sees only the GridToEv forecast issued 30 minutes before each half-hour; it never sees later forecasts or what actually happened.',
        f"Grid energy includes charging losses: battery energy / {fleet['chargingEfficiency']:g} efficiency.",
        'Every plan passes the energy bridge\'s constraint checker (plug-in hours, charger rate and count, site power).',
        f"Money: illustrative tariff (night EUR {night:g}, day EUR {day:g}, peak EUR {peak:g} per kWh) minus EUR "
        f"{tariff['surplusDiscountEurPerKwh']:g} per kWh used during observed curtailment.",
        'Surplus renewable energy: charging that coincided with observed curtailment, capped by that charging. It is not verified '
        'that a real site could absorb it (network deliverability).',
        f'Year: the average night x {days} operating days. The surplus part is scaled by how often curtailment happened over a '
        'full observed year compared with the evaluation week, so one windy winter week is not taken as typical.',
        'Conservative and optimistic are the lower and higher of two extremes: no surplus renewable energy all year, or every '
        'week as surplus-rich as the evaluation week.',
    ]


LIMITATIONS = [
    'Simulation on historical data: the fleet, tariff and costs are examples, not a customer or a supplier quote.',
    'Forecasts are historical replays of GridToEv, not live predictions; outcomes are observed EirGrid values from the same dataset.',
    'Whether a real site could absorb curtailed energy depends on its grid location and is not verified.',
    'Emissions use a flat grid average, not a marginal emission factor per half-hour.',
    ('The three strategies are this page\'s own week-long simulation; the energy bridge (issue #50) plans one forecast '
     'window at a time. Every plan here passes the bridge\'s constraint checker.'),
]


def empty_result(meta, message):
    return {'version': VERSION, 'status': 'empty', 'message': message, 'generatedAt': datetime.now(timezone.utc).isoformat(), **meta}


# ---------------------------------------------------------------- estimate calculator

CALCULATOR_FIELDS = {
    # name: (label, minimum, maximum, integer)
    'evs': ('Number of EVs', 1, 10000, True),
    'shiftablePct': ('Electricity that can be shifted', 0, 100, False),
    'priceDiffEurPerKwh': ('Price difference', 0, 1, False),
    'operatingDays': ('Operating days per year', 1, 366, True),
    'implementationEur': ('One-off implementation cost', 0, 10_000_000, False),
    'annualEur': ('Yearly running cost', 0, 1_000_000, False),
}
OPTIONAL_FIELDS = ('implementationEur', 'annualEur')


def parse_estimate(query):
    """Validate calculator inputs; returns (values, {field: message})."""
    values, errors = {}, {}
    for name, (label, low, high, integer) in CALCULATOR_FIELDS.items():
        raw = query.get(name)
        if raw in (None, ''):
            if name in OPTIONAL_FIELDS:
                values[name] = 0.0
                continue
            errors[name] = f'{label} is required.'
            continue
        try:
            value = float(raw)
        except (TypeError, ValueError):
            errors[name] = f'{label} must be a number.'
            continue
        if not math.isfinite(value) or not low <= value <= high:
            errors[name] = f'{label} must be between {low:,g} and {high:,g}.'
        elif integer and value != int(value):
            errors[name] = f'{label} must be a whole number.'
        else:
            values[name] = value
    return values, errors


FEASIBILITY_START_MINUTE = 17 * 60  # overnight plans start at 17:00, when the first vans plug in


@lru_cache(maxsize=256)
def _feasibility(evs):
    fleet = FLEET
    n = max(1, min(evs, fleets.MAX_VEHICLES))
    need = grid_kwh_per_ev_day(fleet) * fleet['chargingEfficiency']  # the depot's average battery kWh per van
    vans = [{'id': f'EV-{i + 1:03d}', 'arriveMin': van_hours(i)[0], 'departMin': van_hours(i)[1],
             'requiredKwh': need, 'maxKw': fleet['vehicleMaxKw']} for i in range(n)]
    planned = bridge_fleet(vans, FEASIBILITY_START_MINUTE, fleet)
    plan = optimizer.run_policy(planned, fleets.slot_count(planned), optimizer.OPTIMIZED)
    problems = optimizer.check_plan(plan)
    if problems:
        raise RuntimeError(f'Energy bridge plan is infeasible: {problems[0]}')
    eff = fleet['chargingEfficiency']
    delivered = sum(sum(row.values()) for row in plan.alloc.values())
    met = sum(1 for v in vans if sum(plan.alloc[v['id']].values()) * eff >= v['requiredKwh'] - 1e-6)
    blocked = {code: sum(b.get(key, 0) for b in plan.blocked.values())
               for code, key in (('site-power', 'sitePower'), ('chargers', 'chargers'))}
    limited = None if met == evs else max(blocked, key=blocked.get) if any(blocked.values()) else 'plug-in-hours'
    return (('checkedBy', optimizer.SOLVER_ID), ('evsPlanned', n), ('vehiclesMet', met),
            ('deliverableKwhPerDay', delivered), ('limitedBy', limited))


def feasibility(evs, fleet=FLEET):
    """What the example site can really charge overnight for `evs` vans, planned by the energy bridge.

    optimizer.run_policy plans every van at the depot's average need on its 20 chargers and 180 kW
    connection within each van's plug-in hours, and check_plan() proves the plan. Above the bridge's
    200-vehicle limit the site is long full, so 200 are planned and the rest add nothing."""
    result = dict(_feasibility(int(evs)))
    result['site'] = example_site(fleet)
    return result


def estimate(evs, shiftablePct, priceDiffEurPerKwh, operatingDays, implementationEur=0.0, annualEur=0.0, fleet=FLEET):
    """Yearly savings for another fleet, at the example site.

    energy = what the energy bridge can deliver overnight to these EVs at the example site (their
    need, capped by its chargers and connection); savings = energy x share shifted x price difference
    x days. The share and price difference are the user's assumptions, so the result is illustrative."""
    kwh = grid_kwh_per_ev_day(fleet)
    site = feasibility(evs, fleet)
    energy = min(evs * kwh, site['deliverableKwhPerDay'])
    shifted = energy * shiftablePct / 100 * operatingDays
    gross = round(shifted * priceDiffEurPerKwh)
    running, implementation = round(annualEur), round(implementationEur)
    net = gross - running
    if implementation <= 0:
        payback, status = None, 'no-investment'
    elif net <= 0:
        payback, status = None, 'not-achieved'
    else:
        payback, status = round(implementation / net * 12, 1), 'months'
    return {'version': VERSION, 'illustrative': True, 'kwhPerEvDay': round(kwh, 1), 'shiftedKwhPerYear': round(shifted),
            'grossSavingsEur': gross, 'annualCostsEur': running, 'yearlySavingsEur': net,
            'implementationEur': implementation, 'paybackMonths': payback, 'paybackStatus': status,
            'feasibility': {**site, 'evs': int(evs), 'deliverableKwhPerDay': round(energy, 1),
                            'requiredKwhPerDay': round(evs * kwh, 1), 'deliverableShare': round(energy / (evs * kwh), 4)},
            'effects': {'evs': 'Planned by the energy bridge on the example site: once its chargers and connection are full, more EVs add nothing.',
                        'shiftablePct': 'Share of each EV\'s daily charging that can move to cheaper hours.',
                        'priceDiffEurPerKwh': 'Average saving on each shifted kWh.',
                        'operatingDays': 'Days a year the fleet charges.'},
            'note': (f'{kwh:.1f} kWh per EV per day from the simulated depot, checked against the example site\'s '
                     f'{fleet["chargers"]} chargers and {fleet["sitePowerKw"]:g} kW connection. Prices are your assumptions.')}


# ---------------------------------------------------------------- data

def evaluation_days(times, nights=EVAL_NIGHTS):
    """The latest run of consecutive dataset days (up to nights + 1) whose half-hours mostly have a +30 forecast.

    Chosen by position in the dataset only, never by how much surplus the days had."""
    if not times:
        return []
    available, last = set(times), max(times)
    usable = []
    for day in sorted({t[:10] for t in times}):
        have = sum(1 for t in explorer.day_targets(day) if explorer.forecast_issues(t, available, last).get(30))
        if have >= MIN_FORECAST_SHARE * 48:
            usable.append(day)
    run = []
    for day in reversed(usable):
        if run and date.fromisoformat(run[-1]) - date.fromisoformat(day) != timedelta(days=1):
            break
        run.append(day)
    return sorted(run)[-(nights + 1):]


def build_nights(days, data):
    """Nights (day D 12:00 to D+1 12:00) whose two days both loaded; `index` fixes the fleet pattern."""
    nights = []
    for k in range(len(days) - 1):
        first, second = data.get(days[k]), data.get(days[k + 1])
        if not first or not second:
            continue
        slots = night_slots(days[k])
        starts = {s['start'] for s in slots}
        observed = {**first['observed'], **second['observed']}
        nights.append({'date': days[k], 'index': k, 'slots': slots,
                       'forecasts': [f for f in first['forecasts'] + second['forecasts'] if f['targetAt'] in starts],
                       'observed': {t: observed.get(t) for t in starts}})
    return nights


def _replay(day, urgent):
    """The day's +30 forecasts through the shared replay gate, waiting out busy periods."""
    for _ in range(REPLAY_ATTEMPTS):
        try:
            return explorer.short_term_day(day, 30, prefetch=not urgent())
        except Busy:
            time.sleep(BUSY_PAUSE_SECONDS)
    raise Busy()


def _observed(day):
    """Observed curtailment (kWh) for each half-hour of a day, from one /actuals/v1/window call."""
    def build():
        body = explorer.call('/actuals/v1/window', {'start_target_timestamp_utc': f'{day}T00:00:00Z', 'duration_hours': 24})
        rows = {a['targetAt']: a for a in map(explorer._v1_actual, body.get('actuals', []))}
        return {t: rows[t]['curtailmentMwh'] * 1000 if t in rows and rows[t]['curtailmentMwh'] is not None else None
                for t in explorer.day_targets(day)}
    return explorer.cached(('business-observed', day), None, build)


def load_day(day, urgent=lambda: False):
    replay = _replay(day, urgent)
    forecasts = [{'targetAt': p['targetAt'], 'issuedAt': p['issuedAt'], 'curtailmentKwh': p['curtailmentMwh'] * 1000,
                  'probability': p['probability']} for p in replay['points'] if p['horizonMinutes'] == 30]
    return {'forecasts': forecasts, 'observed': _observed(day), 'modelVersion': replay.get('modelVersion')}


def model_seasonal(period_days):
    """seasonal_adjustment() from GridToEv's daily dataset: the latest 365 observed days."""
    try:
        info = explorer.daily_info()
        first = date.fromisoformat(info['dataset']['from'])
        last = date.fromisoformat(info['dataset']['to'])
        year = [(last - timedelta(days=i)).isoformat() for i in range(365) if last - timedelta(days=i) >= first]
        wanted = sorted(set(year) | {d for d in period_days if first.isoformat() <= d <= last.isoformat()})
        actuals = {}
        for i in range(0, len(wanted), 42):  # six 7-day window calls at a time
            actuals.update(explorer._daily_actuals(wanted[i:i + 42]))
    except (*MODEL_ERRORS, LookupError, ValueError, TypeError) as error:
        return {'available': False, 'factor': None, 'reason': f'The daily dataset could not be read ({type(error).__name__}).'}
    return seasonal_adjustment(list(period_days), year, actuals)


def _fallback_reason(error):
    return 'MODEL_UNAVAILABLE' if isinstance(error, MODEL_ERRORS) else 'INVALID_MODEL_RESPONSE'


def compute(progress=lambda done, total, stage: None, urgent=lambda: False):
    """The Impact payload from the model, or the labelled simulated example if the model is unavailable."""
    try:
        info = explorer.short_term_info()
        days = evaluation_days(info['times'])
    except (*MODEL_ERRORS, ValueError, KeyError, TypeError) as error:
        return simulated_result(_fallback_reason(error))
    meta = {'dataMode': 'historical-replay', 'source': 'grid-to-ev-model', 'modelVersion': info['model'].get('version'),
            'provenance': PROVENANCE, 'fallback': {'active': False, 'reason': None}}
    if len(days) < 2:
        return empty_result(meta, 'The forecast dataset has no two consecutive days with forecasts to evaluate.')
    total = len(days) + 2  # one step per day replayed, then the observed year, then the scoring
    data, failures, model_error = {}, [], None
    for n, day in enumerate(days):
        progress(n, total, 'Replaying historical forecasts')
        try:
            data[day] = load_day(day, urgent)
        except (*MODEL_ERRORS, LookupError, ValueError, TypeError, Busy) as error:
            failures.append(day)
            if isinstance(error, MODEL_ERRORS):
                model_error = model_error or error
                if not data:  # the model went away before anything loaded: stop waiting on it
                    return simulated_result(_fallback_reason(error))
    if not data and model_error is not None:
        return simulated_result(_fallback_reason(model_error))
    nights = build_nights(days, data)
    meta['modelVersion'] = next((d['modelVersion'] for d in data.values() if d.get('modelVersion')), meta['modelVersion'])
    meta['coverage'] = coverage(nights, failures)
    progress(len(days), total, 'Checking a full year of observed curtailment')
    seasonal = model_seasonal(days) if nights else {'available': False, 'factor': None, 'reason': None}
    progress(len(days) + 1, total, 'Scoring three charging strategies')
    return build_result(nights, meta, seasonal)


PROVENANCE = {'forecasts': 'historical-prediction', 'outcomes': 'historical-observation', 'fleet': 'simulated',
              'prices': 'illustrative', 'costs': 'illustrative', 'emissions': 'estimated'}


def coverage(nights, failed_days=()):
    """How complete the plugged-in hours (17:00-07:30) were: missing forecasts and observations are counted, not filled in."""
    slots = forecasts = observations = 0
    for night in nights:
        have = {f['targetAt'] for f in night['forecasts']}
        for s in night['slots']:
            if 17 * 60 <= s['minute'] < 31 * 60 + 30:
                slots += 1
                forecasts += s['start'] in have
                observations += night['observed'].get(s['start']) is not None
    return {'halfHours': slots, 'missingForecasts': slots - forecasts, 'missingObservations': slots - observations,
            'failedDays': list(failed_days)}


# ---------------------------------------------------------------- simulated example (model unavailable)

DEMO_START = date(2026, 1, 24)
# Per night: (observed curtailment window, forecast window, MWh per half-hour); minutes from 00:00 on the night's date.
DEMO_WEATHER = [
    ((25 * 60, 29 * 60), (25 * 60, 29 * 60), 60),
    (None, None, 0),
    ((21 * 60, 26 * 60), (21 * 60 + 30, 26 * 60), 80),  # forecast half an hour late
    ((26 * 60, 30 * 60 + 30), (26 * 60, 30 * 60 + 30), 120),
    (None, (27 * 60, 28 * 60), 0),  # false alarm
    ((24 * 60, 27 * 60), (24 * 60, 27 * 60), 40),
    ((28 * 60 + 30, 31 * 60), (28 * 60 + 30, 31 * 60), 90),
]


def simulated_nights():
    nights = []
    for k, (actual, predicted, mwh) in enumerate(DEMO_WEATHER):
        day = (DEMO_START + timedelta(days=k)).isoformat()
        slots = night_slots(day)
        inside = lambda window, m: window is not None and window[0] <= m < window[1]
        forecasts = [{'targetAt': s['start'], 'issuedAt': explorer.iso(_utc(s['start']) - timedelta(minutes=30)),
                      'curtailmentKwh': (mwh or 50) * 1000.0 if inside(predicted, s['minute']) else 0.0,
                      'probability': 0.95 if inside(predicted, s['minute']) else 0.05} for s in slots]
        observed = {s['start']: mwh * 1000.0 if inside(actual, s['minute']) else 0.0 for s in slots}
        nights.append({'date': day, 'index': k, 'slots': slots, 'forecasts': forecasts, 'observed': observed})
    return nights


def simulated_result(reason):
    nights = simulated_nights()
    meta = {'dataMode': 'simulated', 'source': 'local-demo-fixture', 'modelVersion': 'demo-fixture-v1',
            'provenance': {**PROVENANCE, 'forecasts': 'simulated', 'outcomes': 'simulated'},
            'fallback': {'active': True, 'reason': reason}, 'coverage': coverage(nights)}
    seasonal = {'available': False, 'factor': None, 'reason': 'Simulated example: no seasonal adjustment.'}
    return build_result(nights, meta, seasonal)


# ---------------------------------------------------------------- background build

_lock = threading.Lock()
_state = {'status': 'idle', 'done': 0, 'total': 0, 'stage': None, 'result': None, 'urgent': False, 'startedAt': None}


def _progress(done, total, stage):
    with _lock:
        _state.update(done=done, total=total, stage=stage)


def _run():
    try:
        result = compute(_progress, lambda: _state['urgent'])
    except Exception:  # a bug, not an outage: report it rather than dressing it up as data
        with _lock:
            _state.update(status='failed', result=None)
        return
    with _lock:
        _state.update(status='ready', result=result)


def _start_locked():
    _state.update(status='preparing', done=0, total=0, stage='Starting', result=None, startedAt=time.time())
    threading.Thread(target=_run, name='business-impact', daemon=True).start()


def start_prefetch():
    """Warm the result in the background at server start (prefetch priority)."""
    with _lock:
        if _state['status'] == 'idle':
            _start_locked()


def current(refresh=False):
    """The finished result, or progress while it is prepared. A viewer waiting raises the replay priority.

    `refresh` retries after a failure or a simulated fallback; a real result is kept (the dataset is fixed)."""
    with _lock:
        _state['urgent'] = True
        result = _state['result']
        if refresh and (_state['status'] == 'failed' or (_state['status'] == 'ready' and result.get('dataMode') == 'simulated')):
            _state['status'] = 'idle'
        if _state['status'] == 'idle':
            _start_locked()
        if _state['status'] == 'ready':
            return _state['result']
        if _state['status'] == 'failed':
            return {'version': VERSION, 'status': 'failed', 'message': 'The impact calculation failed. Try again.'}
        return {'version': VERSION, 'status': 'preparing',
                'progress': {'done': _state['done'], 'total': _state['total'], 'stage': _state['stage']}}


def reset():
    """Forget the cached result (tests)."""
    with _lock:
        _state.update(status='idle', done=0, total=0, stage=None, result=None, urgent=False, startedAt=None)
