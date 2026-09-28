"""Discount windows: the business case behind the Impact page and the EV page's booking card (issue #56).

Drivers join for free, book a 07:00-09:00 or 17:00-19:00 discount window at a participating charger,
arrive and plug in. Our AI fills a battery with surplus renewable energy when the GridToEv forecast
calls it, and a window is offered at a discount only when that stored energy, all costs included, is
cheaper than the best basic smart charging the same driver could get in the same window. The extra
saving is shared 50/25/25: the driver's discount, the charging operator, and our commission.

What this module guarantees (tests in tests/test_offers.py check each point):
- Only the extra saving over basic smart charging is shared, never the saving over normal charging.
  The baseline is the cheapest tariff half-hours that still deliver the session inside its own window.
- 07:00-09:00 and 17:00-19:00 are commuter windows, not cheap or renewable by definition. 17:00-19:00
  is the tariff peak; a window is offered only from surplus already stored, and only when it pays.
- No look-ahead. The battery charges on the +30 minute forecast issued before each half-hour; an offer
  is locked 30 minutes before its window from energy already stored and settled. Observed curtailment
  is used only afterwards: energy bought on a false alarm is conventional grid energy, never offered.
- The battery is hypothetical (no real storage is claimed). Its capacity and power are finite and
  charge and discharge losses, wear, network charges and session costs are in the delivered cost.
- Sessions fit the site: the energy bridge (optimizer.run_policy / check_plan) plans each window's
  sessions on the example site's 20 x 11 kW chargers and 180 kW connection.
- Money is settled in whole cents, pre-VAT, and every split adds up exactly. A driver's locked
  discount is honoured when the actual saving is lower: the shortfall reduces the operator's share
  and our commission, never the driver's discount. No fee on cancelled or failed sessions.
- The +30 and +60 forecasts of one half-hour are two estimates, never added: only +30 is used.
- Prices, costs, demand and the battery are illustrative and labelled as such: nothing here is a
  real customer, booking, payment or verified carbon saving.
"""
from datetime import datetime, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP
from functools import lru_cache
import json
import math
from pathlib import Path
import re
import threading

import business
import eligibility
import fleet as fleets
import optimizer

VERSION = 'discount-windows/v1'
SLOT_MINUTES = business.SLOT_MINUTES
SLOT_HOURS = business.SLOT_HOURS
WINDOW_SLOTS = 4
WINDOW_MINUTES = WINDOW_SLOTS * SLOT_MINUTES
# Local time: the replay tariff clock is UTC, which is Irish time in winter (the evaluation period).
WINDOWS = (
    {'id': 'morning', 'label': '07:00–09:00', 'startMinute': 7 * 60},
    {'id': 'evening', 'label': '17:00–19:00', 'startMinute': 17 * 60},
)
SPLIT = {'driver': 50, 'operator': 25, 'platform': 25}
SESSION_KWH = 20.0  # delivered at the charger
DAYS_PER_MONTH = 30
QUOTE_KWH = (10.0, 15.0, 20.0, 22.0)  # charge sizes the EV page offers, each priced by the server
MIN_SAVING_EUR_PER_KWH = 0.02  # the AI only stores energy that could clear at least this at the peak
EPS = 1e-9

HUB = {'id': 'hub', 'name': 'Example charging hub', 'provenance': 'simulated', 'region': 'IE', 'public': True,
       'chargers': business.FLEET['chargers'], 'chargerKw': business.FLEET['chargerKw'],
       'sitePowerKw': business.FLEET['sitePowerKw'], 'hypotheticalConstraintZone': False}
BATTERY = {
    'name': 'Hypothetical site battery', 'provenance': 'hypothetical',
    'capacityKwh': 700.0, 'powerKw': 180.0, 'chargeEfficiency': 0.92, 'dischargeEfficiency': 0.92,
    'wearEurPerKwh': 0.08,
    'note': 'Not built and not claimed as real storage: an illustrative extension to show what stored surplus would cost.',
}
PRICES = {
    'provenance': 'illustrative', 'vat': 'All amounts exclude VAT; the driver\'s receipt adds VAT at the applicable rate to both prices.',
    'publicEurPerKwh': 0.49,  # the operator's approved public price, charged to everyone without a booking
    'networkEurPerKwh': 0.04,  # network and demand charges on energy that goes through the battery
    'sessionEurPerKwh': 0.025,  # the operator's extra site and session costs for a programme session
}
# Drivers assumed to want each window at the example hub: demand is an assumption, not a measurement.
DEMAND = {'morning': 10, 'evening': 20}
COSTS = {'provenance': 'illustrative', 'operatorFixedEurPerMonth': 100.0,
         'platformVariableEurPerSession': 0.10, 'platformFixedEurPerMonth': 120.0}
REASONS = {
    'no-stored-surplus': 'No surplus renewable energy is stored for this window.',
    'not-cheaper': 'Stored surplus is not cheaper than normal charging in this window.',
    'too-small': 'The saving would not cover the per-session costs.',
    'site-full': 'The site cannot deliver a session in this window.',
}


def utc(value):
    return datetime.fromisoformat(str(value).replace('Z', '+00:00')).astimezone(timezone.utc)


# ---------------------------------------------------------------- money

def cents(eur):
    """Euros to whole cents, halves rounded up (never a float in a settlement)."""
    return int((Decimal(repr(float(eur))) * 100).quantize(Decimal('1'), rounding=ROUND_HALF_UP))


def eur(amount_cents):
    return amount_cents / 100


def split(pool_cents, driver_cents=None):
    """Share one session's eligible saving: driver 50%, operator 25%, us 25%, summing to the pool exactly.

    `driver_cents` is a discount locked when the offer was booked. It is always honoured; if the
    settled pool turns out smaller, our commission (25% of the actual pool) is reduced first to what
    is left after the driver, and the operator carries the rest as a shortfall."""
    pool = max(0, int(pool_cents))
    driver = (pool + 1) // 2 if driver_cents is None else int(driver_cents)
    platform = min(pool // 4, max(0, pool - driver))
    operator = pool - driver - platform
    return {'poolCents': pool, 'driverCents': driver, 'operatorCents': operator, 'platformCents': platform,
            'shortfallCents': max(0, driver - pool)}


def settle_session(kwh, baseline_eur_per_kwh, ai_eur_per_kwh, driver_cents=None, status='completed'):
    """One delivered session: eligible pool = (baseline - AI all-in cost) x kWh, split in cents.

    A cancelled or failed session pays nothing to anyone: no discount, no share, no commission."""
    if status != 'completed':
        return {**split(0, 0), 'status': status}
    pool = cents(max(0.0, (baseline_eur_per_kwh - ai_eur_per_kwh) * kwh))
    return {**split(pool, driver_cents), 'status': status}


def monthly(sessions, kwh_per_session, saving_eur_per_kwh, operator_fixed_eur=COSTS['operatorFixedEurPerMonth'],
            platform_variable_eur=COSTS['platformVariableEurPerSession'], platform_fixed_eur=COSTS['platformFixedEurPerMonth']):
    """A month of qualifying sessions: the 50/25/25 split, both profit bridges and both break-evens.

    Savings are not profit: our commission pays our per-session cost and our monthly overhead first,
    and the operator's share pays its remaining programme costs. Costs already inside the saving (energy,
    losses, wear, network, session costs) are not subtracted again. Every figure is in whole cents."""
    n = int(sessions)
    one = split(cents(saving_eur_per_kwh * kwh_per_session))
    variable, platform_fixed, operator_fixed = cents(platform_variable_eur), cents(platform_fixed_eur), cents(operator_fixed_eur)
    gross, retained = one['platformCents'] * n, one['operatorCents'] * n
    platform_profit = gross - variable * n - platform_fixed
    operator_profit = retained - operator_fixed
    unit = one['platformCents'] - variable
    month = {
        'sessions': n, 'kwh': round(n * kwh_per_session, 1),
        'perSession': {key.replace('Cents', 'Eur'): eur(one[key]) for key in ('poolCents', 'driverCents', 'operatorCents', 'platformCents')},
        'poolEur': eur(one['poolCents'] * n), 'driversEur': eur(one['driverCents'] * n),
        'operator': {'retainedEur': eur(retained), 'fixedEur': eur(operator_fixed), 'profitEur': eur(operator_profit),
                     'breakEvenSessions': math.ceil(operator_fixed / one['operatorCents']) if one['operatorCents'] > 0 else None},
        'platform': {'grossEur': eur(gross), 'variableEur': eur(variable * n), 'fixedEur': eur(platform_fixed),
                     'profitEur': eur(platform_profit), 'unitContributionEur': eur(unit),
                     'breakEvenSessions': math.ceil(platform_fixed / unit) if unit > 0 else None},
    }
    month['yearly'] = {'poolEur': eur(one['poolCents'] * n * 12), 'driversEur': eur(one['driverCents'] * n * 12),
                       'operatorProfitEur': eur(operator_profit * 12), 'platformGrossEur': eur(gross * 12),
                       'platformProfitEur': eur(platform_profit * 12)}
    return month


# ---------------------------------------------------------------- physical limits

@lru_cache(maxsize=128)
def site_session_cap(kwh, window_minutes=WINDOW_MINUTES):
    """Sessions of `kwh` the example site can deliver in one window, planned and checked by the energy bridge.

    Every session is plugged in for the whole window (the upper-bound case); 20 x 11 kW chargers can
    give at most 22 kWh each in two hours, and the 180 kW connection is shared."""
    if kwh <= 0:
        return 0
    slots = window_minutes // SLOT_MINUTES
    for n in range(HUB['chargers'], 0, -1):
        sessions = [{'id': f'S-{i + 1:02d}', 'site': HUB['id'], 'arriveMin': 0, 'departMin': window_minutes,
                     'requiredKwh': kwh, 'maxKw': HUB['chargerKw']} for i in range(n)]
        plan = optimizer.run_policy(fleets.validate({'chargingEfficiency': 1.0, 'sites': [HUB], 'vehicles': sessions}),
                                    slots, optimizer.OPTIMIZED)
        problems = optimizer.check_plan(plan)
        if problems:  # a bug, never data
            raise RuntimeError(f'Energy bridge plan is infeasible: {problems[0]}')
        if all(sum(plan.alloc[s['id']].values()) >= kwh - 1e-6 for s in sessions):
            return n
    return 0


def max_session_kwh():
    return HUB['chargerKw'] * WINDOW_MINUTES / 60


def basic_smart_price(prices, kwh, credits=None):
    """EUR/kWh of the best basic smart charge for one session inside its window: cheapest half-hours
    first, at the charger's rate. `credits` gives each half-hour's surplus discount per kWh."""
    rate = HUB['chargerKw'] * SLOT_HOURS
    order = sorted(range(len(prices)), key=lambda i: (prices[i] - (credits[i] if credits else 0), i))
    left, cost = kwh, 0.0
    for i in order:
        take = min(rate, left)
        cost += take * (prices[i] - (credits[i] if credits else 0))
        left -= take
        if left <= EPS:
            break
    return cost / kwh if kwh > 0 else 0.0


def delivered_cost(stored_eur_per_kwh, battery=BATTERY, prices=PRICES):
    """All-in EUR per kWh at the charger for energy taken out of the battery."""
    return (stored_eur_per_kwh / battery['dischargeEfficiency'] + battery['wearEurPerKwh']
            + prices['networkEurPerKwh'] + prices['sessionEurPerKwh'])


def worth_storing(band_eur, tariff, battery=BATTERY):
    """Would surplus bought at this band clear the minimum saving against the most expensive window?"""
    peak = max(business.band_at(w['startMinute'] + k * SLOT_MINUTES, tariff)['eurPerKwh']
               for w in WINDOWS for k in range(WINDOW_SLOTS))
    stored = (band_eur - tariff['surplusDiscountEurPerKwh']) / battery['chargeEfficiency']
    return peak - delivered_cost(stored, battery) >= MIN_SAVING_EUR_PER_KWH


# ---------------------------------------------------------------- the replay

class Store:
    """The hypothetical battery's two pools: settled surplus (offerable) and conventional grid energy."""

    def __init__(self, battery):
        self.battery = battery
        self.surplus = self.surplus_eur = self.conventional = self.conventional_eur = 0.0

    @property
    def stored(self):
        return self.surplus + self.conventional

    def room_grid_kwh(self):
        return max(0.0, self.battery['capacityKwh'] - self.stored) / self.battery['chargeEfficiency']

    def take_surplus(self, stored_kwh):
        avg = self.surplus_eur / self.surplus if self.surplus > EPS else 0.0
        self.surplus -= stored_kwh
        self.surplus_eur -= stored_kwh * avg
        if self.surplus < 1e-9:
            self.surplus = self.surplus_eur = 0.0
        return stored_kwh * avg


def _forecast_30(night):
    """+30 minute forecasts only, by target: a +60 estimate of the same half-hour is never added."""
    view = {}
    for f in night['forecasts']:
        if utc(f['targetAt']) - utc(f['issuedAt']) == timedelta(minutes=30):
            view[f['targetAt']] = f
    return view


def _window_at(minute):
    """The window whose lock half-hour or delivery half-hours contain `minute` of the night."""
    m = minute % 1440
    for w in WINDOWS:
        if m == w['startMinute'] - SLOT_MINUTES:
            return w, 'lock'
        if w['startMinute'] <= m < w['startMinute'] + WINDOW_MINUTES:
            return w, 'window'
    return None, None


def replay(nights, kwh=SESSION_KWH, tariff=business.TARIFF, battery=BATTERY, prices=PRICES, demand=DEMAND, scenario=''):
    """Offers, bookings, settlement and the energy ledger over the replayed nights, in time order.

    Each night runs 12:00 to 12:00, so it holds that day's 17:00-19:00 window and the next morning's
    07:00-09:00 window. The battery carries its charge from one night to the next."""
    store = Store(battery)
    discount = tariff['surplusDiscountEurPerKwh']
    eff_in, eff_out = battery['chargeEfficiency'], battery['dischargeEfficiency']
    power_slot = battery['powerKw'] * SLOT_HOURS
    site_cap = site_session_cap(kwh)
    power_cap = int(battery['powerKw'] * WINDOW_MINUTES / 60 // kwh + 1e-9)
    energy = {'gridChargedKwh': 0.0, 'surplusChargedKwh': 0.0, 'conventionalChargedKwh': 0.0, 'chargeLossKwh': 0.0,
              'offeredKwh': 0.0, 'dischargeLossKwh': 0.0, 'conventionalReleasedKwh': 0.0, 'chargeCostEur': 0.0}
    calls = {'charged': 0, 'right': 0, 'falseAlarms': 0, 'unknown': 0}
    windows = []
    for night in nights:
        view = _forecast_30(night)
        observed = night['observed']
        slots = night['slots']
        for i, slot in enumerate(slots):
            w, phase = _window_at(slot['minute'])
            if phase == 'lock' and i + WINDOW_SLOTS < len(slots):
                windows.append(_lock(night, i, w, view, store, kwh, tariff, battery, prices, demand, site_cap, power_cap, scenario))
                continue
            if phase == 'window':
                if slot['minute'] % 1440 == w['startMinute'] and windows and windows[-1]['_start'] == slot['start']:
                    _deliver(windows[-1], slots[i:i + WINDOW_SLOTS], observed, store, kwh, tariff, battery, prices, energy)
                continue
            forecast = view.get(slot['start'])
            band = business.band_at(slot['minute'], tariff)['eurPerKwh']
            draw = min(power_slot, store.room_grid_kwh())
            if forecast is None or draw <= 1e-6 or forecast['curtailmentKwh'] < draw or not worth_storing(band, tariff, battery):
                continue
            seen = observed.get(slot['start'])
            credited = 0.0 if seen is None else min(draw, max(0.0, seen))
            calls['charged'] += 1
            calls['unknown' if seen is None else 'right' if credited >= draw - 1e-6 else 'falseAlarms'] += 1
            store.surplus += credited * eff_in
            store.surplus_eur += credited * (band - discount)
            store.conventional += (draw - credited) * eff_in
            store.conventional_eur += (draw - credited) * band
            energy['gridChargedKwh'] += draw
            energy['surplusChargedKwh'] += credited
            energy['conventionalChargedKwh'] += draw - credited
            energy['chargeLossKwh'] += draw * (1 - eff_in)
            energy['chargeCostEur'] += credited * (band - discount) + (draw - credited) * band
    for window in windows:
        window.pop('_start', None)
    energy['storedSurplusKwh'] = store.surplus
    energy['storedConventionalKwh'] = store.conventional
    return windows, energy, calls


def _lock(night, i, w, view, store, kwh, tariff, battery, prices, demand, site_cap, power_cap, scenario):
    """Decide one window 30 minutes before it starts, from what is known then."""
    slots = night['slots'][i + 1:i + 1 + WINDOW_SLOTS]
    day = slots[0]['start'][:10]
    offer_id = f'{scenario}:{day}:{w["id"]}'
    band = [business.band_at(s['minute'], tariff)['eurPerKwh'] for s in slots]
    # The +30 forecast issued now covers the window's first half-hour. If it calls surplus, normal
    # charging may be cheaper too, so the saving is judged as if the whole window had the discount.
    first = view.get(slots[0]['start'])
    surplus_forecast = first is not None and first['curtailmentKwh'] > 0
    credits = [tariff['surplusDiscountEurPerKwh'] if surplus_forecast else 0.0] * WINDOW_SLOTS
    baseline = basic_smart_price(band, kwh, credits)
    stored_avg = store.surplus_eur / store.surplus if store.surplus > EPS else None
    ai_cost = delivered_cost(stored_avg, battery, prices) if stored_avg is not None else None
    saving = math.floor((baseline - ai_cost) * 1000 + 1e-6) / 1000 if ai_cost is not None else None
    by_energy = int(store.surplus * battery['dischargeEfficiency'] / kwh + 1e-9)
    sessions = min(site_cap, power_cap, by_energy, demand[w['id']])
    one = split(cents(saving * kwh)) if saving is not None and saving > 0 else None
    if by_energy <= 0:
        reason = 'no-stored-surplus'
    elif saving is None or saving <= 0:
        reason = 'not-cheaper'
    elif one['platformCents'] < cents(COSTS['platformVariableEurPerSession']) or one['operatorCents'] < 0:
        reason = 'too-small'
    elif sessions <= 0:
        reason = 'site-full'
    else:
        reason = None
    record = {
        'id': offer_id, 'date': day, 'window': w['id'], 'label': w['label'], '_start': slots[0]['start'],
        'lockedAt': night['slots'][i]['start'], 'status': 'offer' if reason is None else 'none',
        'reason': reason, 'reasonText': REASONS.get(reason),
        'baselineEurPerKwh': round(baseline, 4), 'surplusForecastInWindow': surplus_forecast,
        'aiCostEurPerKwh': None if ai_cost is None else round(ai_cost, 4),
        'storedSurplusKwh': round(store.surplus, 1), 'capacity': {'site': site_cap, 'batteryPower': power_cap,
                                                                     'storedEnergy': by_energy, 'demand': demand[w['id']]},
    }
    if reason is None:
        discount_per_kwh = one['driverCents'] / 100 / kwh
        record.update({
            'sessions': sessions, 'kwhPerSession': kwh, 'source': 'stored-surplus',
            'savingEurPerKwh': saving, 'publicEurPerKwh': prices['publicEurPerKwh'],
            'discountEurPerKwh': round(discount_per_kwh, 4),
            'memberEurPerKwh': round(prices['publicEurPerKwh'] - discount_per_kwh, 4),
            'expected': {key.replace('Cents', 'Eur'): eur(one[key]) for key in ('poolCents', 'driverCents', 'operatorCents', 'platformCents')},
            '_locked': one['driverCents'], '_aiCost': ai_cost,
        })
        record['quotes'] = [quote(record, q) for q in QUOTE_KWH if q <= max_session_kwh()]
    return record


def _deliver(offer, slots, observed, store, kwh, tariff, battery, prices, energy):
    """Discharge an offer's sessions, settle them against what was observed, and release conventional energy."""
    eff_out = battery['dischargeEfficiency']
    discharge_room = battery['powerKw'] * WINDOW_MINUTES / 60  # kWh at the charger in this window
    if offer['status'] == 'offer':
        n = offer['sessions']
        stored = n * kwh / eff_out
        store.take_surplus(stored)
        energy['offeredKwh'] += n * kwh
        energy['dischargeLossKwh'] += stored - n * kwh
        discharge_room -= n * kwh
        # What basic smart charging would really have paid, now that the window's curtailment is known.
        # A half-hour without an observation is settled as if it had surplus (the saving is not claimed).
        band = [business.band_at(s['minute'], tariff)['eurPerKwh'] for s in slots]
        rate = HUB['chargerKw'] * SLOT_HOURS
        draw = min(n * rate, HUB['sitePowerKw'] * SLOT_HOURS)
        credits = [tariff['surplusDiscountEurPerKwh'] * (1.0 if observed.get(s['start']) is None
                                                          else min(1.0, max(0.0, observed[s['start']]) / draw)) for s in slots]
        actual = basic_smart_price(band, kwh, credits)
        one = settle_session(kwh, actual, offer.pop('_aiCost'), offer.pop('_locked'))
        offer['settled'] = {'baselineEurPerKwh': round(actual, 4), 'sessions': n, 'kwh': n * kwh,
                            **{key.replace('Cents', 'Eur'): eur(one[key] * n)
                               for key in ('poolCents', 'driverCents', 'operatorCents', 'platformCents', 'shortfallCents')}}
    # Energy stored after a false alarm goes to the operator's normal-price sessions at the evening peak:
    # it is not surplus, so it is never offered or shared.
    if offer['window'] == 'evening' and store.conventional > EPS:
        released = min(store.conventional, max(0.0, discharge_room) / eff_out)
        share = released / store.conventional
        store.conventional -= released
        store.conventional_eur -= store.conventional_eur * share
        energy['conventionalReleasedKwh'] += released * eff_out
        energy['dischargeLossKwh'] += released * (1 - eff_out)


def quote(offer, kwh):
    """A driver's price for `kwh` in an offer and how its saving is shared: whole cents, ex VAT."""
    one = split(cents(offer['savingEurPerKwh'] * kwh))
    public = cents(offer['publicEurPerKwh'] * kwh)
    return {'kwh': kwh, 'publicEur': eur(public), 'discountEur': eur(one['driverCents']), 'priceEur': eur(public - one['driverCents']),
            'split': {key.replace('Cents', 'Eur'): eur(one[key]) for key in ('poolCents', 'driverCents', 'operatorCents', 'platformCents')}}


def next_opportunities(windows):
    """For each window without an offer, the next one in the replay that has one (or None)."""
    upcoming = None
    for window in reversed(windows):
        if window['status'] != 'offer':
            window['next'] = None if upcoming is None else {'date': upcoming['date'], 'label': upcoming['label'], 'id': upcoming['id']}
        else:
            upcoming = window
    return windows


def ledger_totals(windows):
    """The replay's settled ledger: every euro of every session, summed in cents."""
    keys = ('poolEur', 'driverEur', 'operatorEur', 'platformEur', 'shortfallEur')
    total = {key: 0 for key in keys}
    sessions = kwh = 0
    for w in windows:
        s = w.get('settled')
        if not s:
            continue
        sessions += s['sessions']
        kwh += s['kwh']
        for key in keys:
            total[key] += cents(s[key])
    return {'sessions': sessions, 'kwh': kwh, **{key: eur(value) for key, value in total.items()},
            'balanced': total['poolEur'] == total['driverEur'] + total['operatorEur'] + total['platformEur']}


def build(nights, seasonal, scenario='', tariff=business.TARIFF):
    """The Impact page's discount-window section from the replayed nights (optional: None without nights)."""
    if not nights:
        return None
    windows, energy, calls = replay(nights, tariff=tariff, scenario=scenario)
    next_opportunities(windows)
    totals = ledger_totals(windows)
    count = len(nights)
    kwh = SESSION_KWH
    saving = round(totals['poolEur'] / totals['kwh'], 4) if totals['kwh'] else 0.0
    per_day = totals['sessions'] / count
    factor = seasonal.get('factor') if seasonal.get('available') else None
    site_cap = site_session_cap(kwh)
    site_month_cap = site_cap * len(WINDOWS) * DAYS_PER_MONTH
    # Windows worth offering a month: a window without stored surplus has no discount to sell. Stored
    # surplus depends on how often curtailment happens, so the month is scaled like the depot's surplus.
    offered_count = sum(1 for w in windows if w['status'] == 'offer')
    week_windows = min(len(WINDOWS) * DAYS_PER_MONTH, round(offered_count / count * DAYS_PER_MONTH))
    eligible_windows = week_windows if factor is None else min(len(WINDOWS) * DAYS_PER_MONTH, round(offered_count / count * DAYS_PER_MONTH * factor))
    month_cap = min(site_month_cap, site_cap * eligible_windows)
    week_sessions = min(site_month_cap, site_cap * week_windows, round(per_day * DAYS_PER_MONTH))
    expected_sessions = week_sessions if factor is None else min(month_cap, round(per_day * DAYS_PER_MONTH * factor))
    basis = 'evaluation-week' if factor is None else 'seasonal'
    scenarios = {
        'expected': {'basis': basis, 'inputs': {'sessions': expected_sessions, 'kwhPerSession': kwh, 'savingEurPerKwh': saving}},
        'evaluationWeek': {'basis': 'evaluation-week', 'inputs': {'sessions': week_sessions, 'kwhPerSession': kwh, 'savingEurPerKwh': saving}},
        'noSurplus': {'basis': 'no-surplus', 'inputs': {'sessions': 0, 'kwhPerSession': kwh, 'savingEurPerKwh': 0.0}},
        'example': {'basis': 'worked-example', 'inputs': {'sessions': 400, 'kwhPerSession': 20.0, 'savingEurPerKwh': 0.10}},
    }
    for s in scenarios.values():
        s['month'] = monthly(**{'sessions': s['inputs']['sessions'], 'kwh_per_session': s['inputs']['kwhPerSession'],
                                'saving_eur_per_kwh': s['inputs']['savingEurPerKwh']})
    expected = scenarios['expected']['month']
    offered = [w for w in windows if w['status'] == 'offer']
    by_window = {w['id']: {'offers': sum(1 for x in offered if x['window'] == w['id']),
                           'windows': sum(1 for x in windows if x['window'] == w['id'])} for w in WINDOWS}
    claims = eligibility.site_claims(HUB)
    released = energy['offeredKwh'] / BATTERY['dischargeEfficiency']
    return {
        'version': VERSION, 'status': 'projected', 'label': 'Illustrative replay · projected revenue · simulated profit',
        'hub': {**HUB, 'sessionCap': site_cap, 'maxSessionKwh': max_session_kwh()},
        'battery': BATTERY, 'prices': PRICES, 'costs': COSTS, 'demand': {**DEMAND, 'provenance': 'assumed'},
        'split': SPLIT, 'windows': [{'id': w['id'], 'label': w['label']} for w in WINDOWS],
        'sessionKwh': kwh, 'daysPerMonth': DAYS_PER_MONTH,
        'seasonal': {'applied': factor is not None, 'factor': None if factor is None else round(factor, 4)},
        'kpis': {'aiExtraSavingsEur': expected['poolEur'], 'driversSavedEur': expected['driversEur'],
                 'operatorProfitEur': expected['operator']['profitEur'], 'platformProfitEur': expected['platform']['profitEur'],
                 'platformGrossEur': expected['platform']['grossEur'], 'sessions': expected['sessions']},
        'month': expected,
        'scenarios': scenarios,
        'calculator': {'defaults': {**scenarios['expected']['inputs'], 'operatorFixedEur': COSTS['operatorFixedEurPerMonth'],
                                    'platformVariableEur': COSTS['platformVariableEurPerSession'],
                                    'platformFixedEur': COSTS['platformFixedEurPerMonth']},
                       'capacity': {'sessionsPerWindow': site_cap, 'windowsPerDay': len(WINDOWS), 'siteMaxPerMonth': site_month_cap,
                                    'eligibleWindowsPerMonth': eligible_windows, 'maxPerMonth': month_cap}},
        'offers': windows,
        'ledger': {**totals, 'nights': count, 'offers': len(offered), 'byWindow': by_window, 'forecastHorizonMinutes': 30},
        'energy': {
            'qualifyingKwh': round(energy['offeredKwh'], 1),
            'sources': {'directSurplusKwh': 0.0, 'storedSurplusKwh': round(energy['offeredKwh'], 1), 'conventionalKwh': 0.0},
            'battery': {'gridChargedKwh': round(energy['gridChargedKwh'], 1), 'surplusChargedKwh': round(energy['surplusChargedKwh'], 1),
                        'falseAlarmKwh': round(energy['conventionalChargedKwh'], 1), 'chargeLossKwh': round(energy['chargeLossKwh'], 1),
                        'dischargedKwh': round(energy['offeredKwh'] + energy['conventionalReleasedKwh'], 1),
                        'dischargeLossKwh': round(energy['dischargeLossKwh'], 1),
                        'roundTripEfficiency': round(BATTERY['chargeEfficiency'] * BATTERY['dischargeEfficiency'], 4),
                        'conventionalReleasedKwh': round(energy['conventionalReleasedKwh'], 1),
                        'unallocatedSurplusKwh': round(energy['storedSurplusKwh'], 1),
                        'unallocatedConventionalKwh': round(energy['storedConventionalKwh'], 1),
                        'storedSurplusUsedKwh': round(released, 1)},
            'calls': calls,
            'network': {'status': claims['curtailment']['status'], 'reason': claims['curtailment']['reason']},
            'notes': ['Cheaper energy is not verified avoided curtailment: the credit is conditional on the grid being able to deliver it.',
                      'Stored kWh are not all recovered kWh: charging and discharging lose energy, shown separately.',
                      'Surplus during a window lowers normal charging too, so it adds no extra saving to share: offers are served from stored surplus.'],
        },
        'methodology': METHODOLOGY,
        'limitations': LIMITATIONS,
    }


METHODOLOGY = [
    'Eligible pool per session = max(0, basic smart cost - AI all-in cost) x kWh, pre-VAT, avoidable costs only.',
    'Basic smart cost: the cheapest half-hours inside the same window that still deliver the session, at the charger rate.',
    'AI all-in cost: stored energy price / discharge efficiency + battery wear + network charges + session costs.',
    'Split: driver 50% (discount on the public price), operator 25%, our commission 25%. Our commission pays our '
    'per-session cost and monthly overhead before any profit; the operator\'s share pays its remaining programme costs.',
    'An offer is locked 30 minutes before its window from surplus already stored and settled, sized by the energy bridge '
    '(chargers, connection), battery power and stored energy, and only if both businesses have a non-negative unit contribution.',
    'Month: sessions per replayed day x 30 days, scaled by how often curtailment happens over a full year when that is known.',
]
LIMITATIONS = [
    'Simulation on historical data: the hub, battery, prices, costs and demand are illustrative, not a customer, a quote or a booking.',
    'The battery is hypothetical: no real storage is deployed or claimed.',
    'Surplus credit is conditional: curtailment is system-wide and network deliverability for a real site is not verified.',
    'Without real settlement data these are projected revenue and simulated profit, never money earned.',
    'Public chargers stay open to everyone at the normal price: joining is optional and never a condition for charging.',
]


# ---------------------------------------------------------------- calculator

CALCULATOR_FIELDS = {
    # name: (label, minimum, maximum, integer, optional)
    'sessions': ('Qualifying sessions per month', 0, 100_000, True, False),
    'kwhPerSession': ('kWh per session', 1, 100, False, False),
    'savingEurPerKwh': ('Extra saving per kWh', 0, 1, False, False),
    'operatorFixedEur': ('Operator programme costs per month', 0, 1_000_000, False, True),
    'platformVariableEur': ('Our cost per session', 0, 100, False, True),
    'platformFixedEur': ('Our overhead per month', 0, 1_000_000, False, True),
}
DEFAULT_COSTS = {'operatorFixedEur': COSTS['operatorFixedEurPerMonth'], 'platformVariableEur': COSTS['platformVariableEurPerSession'],
                 'platformFixedEur': COSTS['platformFixedEurPerMonth']}


def parse_calculator(query):
    """Validate calculator inputs; returns (values, {field: message}). Omitted costs use the defaults."""
    values, errors = {}, {}
    for name, (label, low, high, integer, optional) in CALCULATOR_FIELDS.items():
        raw = query.get(name)
        if raw in (None, ''):
            if optional:
                values[name] = DEFAULT_COSTS[name]
            else:
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


def calculate(sessions, kwhPerSession, savingEurPerKwh, operatorFixedEur, platformVariableEur, platformFixedEur,
              eligible_windows=None):
    """What-if month for one site. Sessions above what the site can physically deliver are not counted,
    nor, when the replay is known, sessions beyond the windows it found worth offering a month
    (`eligible_windows`): a window without stored surplus has no discount to sell."""
    per_window = site_session_cap(kwhPerSession)
    site_cap = per_window * len(WINDOWS) * DAYS_PER_MONTH
    windows = None if eligible_windows is None else max(0, min(int(eligible_windows), len(WINDOWS) * DAYS_PER_MONTH))
    cap = site_cap if windows is None else min(site_cap, per_window * windows)
    counted = min(int(sessions), cap)
    month = monthly(counted, kwhPerSession, savingEurPerKwh, operatorFixedEur, platformVariableEur, platformFixedEur)
    if kwhPerSession > max_session_kwh():
        limited_by, limit = 'session-kwh', f'An {HUB["chargerKw"]:g} kW charger delivers at most {max_session_kwh():g} kWh in a two-hour window.'
    elif counted < sessions and cap < site_cap:
        limited_by, limit = 'windows', (f'the replay found about {windows} windows a month worth offering, '
                                        f'at most {per_window} sessions of {kwhPerSession:g} kWh each.')
    elif counted < sessions:
        limited_by, limit = 'site', (f'the site fits {per_window} sessions of {kwhPerSession:g} kWh per window ({HUB["chargers"]} x '
                                     f'{HUB["chargerKw"]:g} kW chargers, {HUB["sitePowerKw"]:g} kW connection): at most {cap:,} a month.')
    else:
        limited_by, limit = None, None
    return {'version': VERSION, 'illustrative': True, 'month': month,
            'capacity': {'sessionsPerWindow': per_window, 'maxPerMonth': cap, 'siteMaxPerMonth': site_cap,
                         'eligibleWindowsPerMonth': windows, 'requested': int(sessions), 'counted': counted,
                         'capped': counted < sessions, 'limitedBy': limited_by, 'limit': limit},
            'noSpareEnergy': counted == 0 or savingEurPerKwh <= 0}


# ---------------------------------------------------------------- demo bookings (EV page)

STORE_PATH = Path(__file__).resolve().parent / '.cache' / 'discount-window-bookings.json'
MEMBER_ID = re.compile(r'^[a-z0-9-]{8,40}$')
_members_lock = threading.Lock()
_members = None


def _load_members():
    global _members
    if _members is None:
        try:
            _members = json.loads(STORE_PATH.read_text(encoding='utf-8'))
        except (OSError, ValueError):
            _members = {}
    return _members


def _save_members():
    try:
        STORE_PATH.parent.mkdir(parents=True, exist_ok=True)
        STORE_PATH.write_text(json.dumps(_members, indent=1), encoding='utf-8')
    except OSError:
        pass  # a demo convenience: bookings still work for this server run


def member_view(member_id):
    with _members_lock:
        member = _load_members().get(member_id)
        return {'joined': bool(member), 'bookings': list(member['bookings'].values()) if member else []}


def _offer(section, offer_id):
    for offer in (section or {}).get('offers', []):
        if offer['id'] == offer_id:
            return offer
    return None


def act(section, member_id, action, offer_id=None, kwh=None):
    """Demo sign-up and booking: join, leave, book or cancel. Not a real account, reservation or payment.

    Raises ValueError with a message for the driver when the request cannot be honoured."""
    if not isinstance(member_id, str) or not MEMBER_ID.match(member_id):
        raise ValueError('Unknown demo member.')
    with _members_lock:
        members = _load_members()
        member = members.get(member_id)
        if action == 'join':
            members.setdefault(member_id, {'joinedAt': datetime.now(timezone.utc).isoformat(), 'bookings': {}})
        elif action == 'leave':
            members.pop(member_id, None)
        elif action in ('book', 'cancel'):
            if not member:
                raise ValueError('Join the discount windows first (free).')
            offer = _offer(section, offer_id)
            if offer is None:
                raise ValueError('This offer has changed or expired. Pick a window again.')
            key = offer['id']
            if action == 'cancel':
                if key in member['bookings']:
                    member['bookings'][key].update(status='cancelled', settlement=settle_session(0, 0, 0, status='cancelled'))
            else:
                if offer['status'] != 'offer':
                    raise ValueError(offer.get('reasonText') or 'No discount in this window.')
                if isinstance(kwh, bool) or not isinstance(kwh, (int, float)) or not math.isfinite(kwh) \
                        or not 1 <= kwh <= max_session_kwh():
                    raise ValueError(f'Choose 1 to {max_session_kwh():g} kWh: the most an {HUB["chargerKw"]:g} kW charger delivers in two hours.')
                # One booking per window: booking again changes the kWh, it never adds a second fee.
                member['bookings'][key] = {'offerId': key, 'date': offer['date'], 'window': offer['window'], 'label': offer['label'],
                                           'status': 'reserved', **quote(offer, round(float(kwh), 1))}
        else:
            raise ValueError('Unknown action.')
        _save_members()
        member = members.get(member_id)
        return {'joined': bool(member), 'bookings': list(member['bookings'].values()) if member else []}


def reset_members():
    """Forget demo members (tests)."""
    global _members
    with _members_lock:
        _members = {}
