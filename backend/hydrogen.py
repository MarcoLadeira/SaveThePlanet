"""Beyond EVs: eligible spare renewable energy to EVs first, then a hypothetical electrolyser (issue #76).

The Impact page's Planet section asks where forecast spare renewable energy could go. For every
half-hour of the replayed week (the same nights, +30 minute forecasts and observations as the rest of
the page) this module:

1. takes the +30 minute forecast of curtailment (Ireland, system-wide) as context only;
2. keeps the part the participating sites could physically receive: at most the pilot region's
   hypothetical network access (ACCESS, kW x 0.5 h). Its status comes from eligibility.py:
   'conditional', because curtailment is system-wide and deliverability is not confirmed. The rest of
   the national forecast is 'not accessible' and is never shared out among our sites;
3. gives that eligible energy to EVs first: the Rewards hub battery (offers.py, unchanged) and then
   the participating EV sites, each vehicle limited by its charger, its site's connection and its
   plug-in hours, earliest departure first, without look-ahead;
4. charges the Dashboard's simulated grid battery (storage.py: the same battery, the same
   storage.charge()) with what EVs leave, from its 40% start, half-hour after half-hour through the
   week. Like the Dashboard's, it only charges, so once it reads 100% it stays full;
5. sends the surplus the full battery cannot take to a hypothetical electrolyser, limited by its rated
   power, minimum stable load, downtime, network access and daily hydrogen offtake;
6. leaves the rest visibly unused, with the reason.

What this module guarantees (tests in tests/test_hydrogen.py check each point):
- Conservation at the grid-side boundary, for every half-hour of every stage (optimizer.check_ledger):
      eligible = EV chargers + storage (hub battery + grid battery) + electrolyser + unused
  with charging and conversion losses inside the sinks. Nothing is forced to zero or to a share.
- The +30 and +60 minute forecasts of one half-hour are two estimates, never added: only +30 is used.
- EV figures are feasible: every EV session is met (from surplus when there is some, otherwise from the
  grid at the latest half-hour it still can be), and no charger, site connection or plug-in window is
  exceeded. The hub battery's energy is counted once, where it is drawn, never again as EV charging.
- kg of hydrogen = electrolyser input kWh / kWh per kg (50-55 kWh/kg, IEA). Never at 100% efficiency.
- The three stages share one eligible pool and one set of constraints. Each sizes EV participation to
  plan for an illustrative share (1/3, 2/3, all); the share EVs can really take is simulated, and is
  usually lower. The shares are hypotheses, not forecasts, guaranteed adoption or allocations.
- Missing or invalid inputs fail closed: the page shows the hydrogen scenario as unavailable.
- Everything is illustrative: the access, the EV sites and the electrolyser are hypothetical. The plant
  is ESB-inspired, not ESB's: no partnership, connection or agreement is implied. Hydrogen is potential,
  not delivered; its CO2 impact is not verified; it is not priced, and it never enters the EV Rewards
  50/25/25 split.
"""
from collections import OrderedDict
from datetime import datetime, timedelta, timezone
import math
import os
import threading

import business
import eligibility
import offers
import optimizer
import storage

VERSION = 'hydrogen/v1'
SLOT_MINUTES = business.SLOT_MINUTES
SLOT_HOURS = business.SLOT_HOURS
EPS = 1e-9
TOLERANCE_KWH = 1e-6  # per half-hour, on unrounded values
EV_EFFICIENCY = business.FLEET['chargingEfficiency']  # grid to battery, as the depot on this page
LHV_KWH_PER_KG = 33.3  # energy content of hydrogen, lower heating value
HHV_KWH_PER_KG = 39.4  # higher heating value: no low-temperature electrolyser uses less electricity per kg
MAX_KWH_PER_KG = 80.0
GREY_KG_CO2_PER_KG = (10.0, 12.0)  # hydrogen from unabated natural gas (IEA Global Hydrogen Review 2024)
GRID_BATTERY = storage.DEFAULT  # the Dashboard's simulated grid battery: the same one, never a copy
FULL_TOLERANCE_KWH = 0.01  # the battery reads 100% within 10 Wh of its capacity

# The eligible pool: the most forecast curtailment the pilot region's network is assumed able to deliver to
# the participating EV sites and the electrolyser together, in any half-hour. One shared bottleneck.
ACCESS = {
    'id': 'pilot-region', 'label': 'Hypothetical network access of the pilot sites', 'provenance': 'hypothetical',
    'kw': 1500.0, 'region': 'IE', 'hypotheticalConstraintZone': False,
    'note': ('Assumed: the pilot region\'s network could deliver up to 1.5 MW of forecast curtailment to the EV sites and '
             'the electrolyser together. No network study, EirGrid or ESB Networks confirmation.'),
}
PLANT = {
    'id': 'esb-inspired-1mw', 'name': 'ESB-inspired hypothetical pilot electrolyser', 'provenance': 'hypothetical',
    'enabled': True, 'ratedKw': 1000.0, 'minLoadFraction': 0.1, 'kwhPerKg': 55.0, 'kwhPerKgRange': [50.0, 55.0],
    'networkAccess': 'conditional', 'offtakeKgPerDay': None, 'downtime': [],
    'boundary': ('Electricity at the plant connection: stack plus balance of plant (power electronics, cooling, water '
                 'treatment). Excludes compression above the stack outlet pressure, storage and transport.'),
    'sizing': ('Sized like the 1 MW electrolyser demonstration ESB has planned at Aghada, which ESB describes as due in '
               '2026. This is not that plant: it is not operational, not connected to SaveThePlanet, and there is no '
               'agreement with ESB.'),
    'operation': ('10% minimum stable load (assumption). Ramping and a warm start take minutes, well inside a half-hour, '
                  'so they do not bind at this resolution; the minimum load does.'),
}
# Participating EV sites. The depot is the Impact page's own example depot (business.FLEET).
SEGMENTS = (
    {'id': 'depot', 'label': 'Fleet depots', 'unit': 'vans', 'vehiclesPerSite': 20, 'chargerKw': 11.0,
     'sitePowerKw': 180.0, 'days': 'every day', 'plugIn': '17:00–19:30 until 06:00–07:30', 'needKwh': [28, 45]},
    {'id': 'workplace', 'label': 'Workplace car parks', 'unit': 'cars', 'vehiclesPerSite': 20, 'chargerKw': 7.4,
     'sitePowerKw': 100.0, 'days': 'weekdays', 'plugIn': '08:00–09:30 until 16:30–18:00', 'needKwh': [10, 20]},
    {'id': 'public', 'label': 'Public chargers', 'unit': 'cars', 'vehiclesPerSite': 20, 'chargerKw': 22.0,
     'sitePowerKw': 300.0, 'days': 'every day', 'plugIn': '16:00–19:30, for 2.5 hours', 'needKwh': [15, 25]},
)
SEGMENT_IDS = tuple(s['id'] for s in SEGMENTS)


def _depot(i, k):
    arrive, depart = business.van_hours(i)  # the example depot's rota: 17:00-19:30 until 06:00-07:30
    return arrive, depart, float(28 + (i * 7 + k * 5) % 18)


def _workplace(i, k):
    return 8 * 60 + (i % 4) * 30, 16 * 60 + 30 + (i % 4) * 30, float(10 + (i * 3 + k * 5) % 11)


def _public(i, k):
    arrive = 16 * 60 + (i % 8) * 30
    return arrive, arrive + 150, float(15 + (i * 5 + k * 3) % 11)


# (arrive minute, depart minute, battery kWh) of vehicle i on day k, minutes from 00:00 UTC of its day.
PATTERNS = {'depot': _depot, 'workplace': _workplace, 'public': _public}
# Illustrative planning stages: EV participation is sized to plan for a share of the eligible energy.
STAGES = (
    {'id': 'pilot', 'label': 'Pilot', 'targetEvShare': 1 / 3, 'targetLabel': 'about 1/3', 'mix': {'depot': 1.0},
     'story': 'Today\'s simulated pilot: the Rewards hub and fleet depots. Hydrogen takes eligible energy the EVs cannot.'},
    {'id': 'growing', 'label': 'Growing EV market', 'targetEvShare': 2 / 3, 'targetLabel': 'about 2/3',
     'mix': {'depot': 0.6, 'workplace': 0.25, 'public': 0.15},
     'story': 'More depots, workplaces and public chargers join. EVs take more; hydrogen takes what is left.'},
    {'id': 'mature', 'label': 'Mature EV market', 'targetEvShare': 1.0, 'targetLabel': 'all of it',
     'mix': {'depot': 0.45, 'workplace': 0.3, 'public': 0.25},
     'story': 'Enough EVs to want all of it. Their timing still leaves some for hydrogen, or unused.'},
)
STAGE_IDS = tuple(s['id'] for s in STAGES)
REASONS = {
    'plant-at-capacity': 'More than the electrolyser\'s rated power',
    'below-minimum-load': 'Below the electrolyser\'s minimum stable load',
    'offtake-met': 'The day\'s hydrogen offtake is already met',
    'no-offtake': 'No hydrogen buyer (offtake) in this scenario',
    'plant-downtime': 'Electrolyser down for maintenance',
    'plant-no-access': 'The electrolyser has no network access to the surplus',
    'hydrogen-off': 'Hydrogen scenario switched off',
}
NOT_ELIGIBLE = {
    'beyond-access': 'More than the pilot sites\' network access: never shared out among them',
    'no-access': 'No network access to the forecast surplus',
}
SOURCES = [
    {'id': 'esb-hydrogen', 'label': 'ESB: hydrogen (Aghada demonstration, Moneypoint plans)',
     'url': 'https://esb.ie/what-we-do/generation-and-trading/hydrogen'},
    {'id': 'esb-insights-2025', 'label': 'ESB Emerging Technology Insights 2025 (1 MW Aghada electrolyser, due in 2026)',
     'url': 'https://cdn.esb.ie/media/docs/default-source/innovation/emerging-technology-insights-2025.pdf'},
    {'id': 'eirgrid-tes-2023', 'label': 'EirGrid Tomorrow\'s Energy Scenarios 2023 (hydrogen needs physical access to surplus)',
     'url': 'https://cms.eirgrid.ie/sites/default/files/publications/TES-2023-Final-Full-Report.pdf'},
    {'id': 'iea-ghr-2024', 'label': 'IEA Global Hydrogen Review 2024 (50–55 kWh/kg; natural-gas hydrogen emissions)',
     'url': 'https://iea.blob.core.windows.net/assets/89c1e382-dc59-46ca-aa47-9f7d41531ab5/GlobalHydrogenReview2024.pdf'},
    {'id': 'ijhe-2025', 'label': 'Curtailed Irish electricity to hydrogen: techno-economics and variability (2025)',
     'url': 'https://doi.org/10.1016/j.ijhydene.2025.150675'},
]


def enabled():
    """The hydrogen scenario is optional: HYDROGEN_SCENARIO=off leaves the Impact page exactly as before."""
    return os.environ.get('HYDROGEN_SCENARIO', 'on').strip().lower() not in ('off', '0', 'false', 'no')


def r1(value):
    return round(value + 0.0, 1)


def r3(value):
    return round(value + 0.0, 3)


def _kwh(value, what):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        raise ValueError(f'Invalid {what}: {value!r}')
    return float(value)


# ---------------------------------------------------------------- inputs

def timeline(nights):
    """The replayed half-hours in time order: the +30 minute forecast and the observation of each (kWh).

    Fails closed: overlapping or out-of-order half-hours, or a forecast or observation that is not a
    finite, non-negative number, raise ValueError. A missing forecast is no opportunity, not an error."""
    if not nights:
        raise ValueError('No replayed nights')
    starts, times, forecast, observed, spans = [], [], [], [], []
    for night in nights:
        slots = night['slots']
        if len(slots) != business.NIGHT_SLOTS:
            raise ValueError(f'Night {night.get("date")} does not have {business.NIGHT_SLOTS} half-hours')
        view = offers._forecast_30(night)  # the same +30 view as the Rewards replay: +60 is never added
        spans.append({'date': night['date'], 'from': len(starts), 'to': len(starts) + len(slots)})
        for slot in slots:
            moment = offers.utc(slot['start'])
            if times and moment <= times[-1]:
                raise ValueError('Replayed half-hours overlap or are out of order')
            f = view.get(slot['start'])
            seen = night['observed'].get(slot['start'])
            starts.append(slot['start'])
            times.append(moment)
            forecast.append(None if f is None else _kwh(f['curtailmentKwh'], 'forecast'))
            observed.append(None if seen is None else _kwh(seen, 'observation'))
    return {'starts': starts, 'times': times, 'forecast': forecast, 'observed': observed, 'nights': spans}


def access_claims(access=ACCESS):
    """Which forecast energy the pilot sites may be offered, from the shared eligibility rules."""
    return eligibility.site_claims({'region': access['region'], 'hypotheticalConstraintZone': access['hypotheticalConstraintZone']})


def pool_series(tl, access=ACCESS):
    """Eligible energy per half-hour: the +30 forecast of curtailment, capped by the shared network access.

    Only curtailment (system-wide, 'conditional') is offered; location-specific constraint energy is not
    in these forecasts and is not claimed."""
    claims = access_claims(access)
    cap = access['kw'] * SLOT_HOURS if claims['curtailment']['status'] in ('eligible', 'conditional') else 0.0
    return [0.0 if f is None else min(f, cap) for f in tl['forecast']]


def hub_series(nights, tl, pool, tariff=business.TARIFF):
    """The Rewards hub battery's grid draw in each half-hour (offers.replay, the Rewards section's own replay),
    within the eligible pool. It is an existing sink: it is served first and counted once, where it is drawn."""
    _, energy, _ = offers.replay(nights, tariff=tariff)
    draw = energy['drawBySlot']
    return [min(draw.get(start, 0.0), pool[t]) for t, start in enumerate(tl['starts'])]


def site_sessions(tl, segment):
    """One site's charging sessions over the replay: vehicle, arrival and departure half-hour, grid kWh.

    A session is kept only when all of its half-hours were replayed (none crosses a gap or an edge).
    Also returns the fair share each plugged-in vehicle can count on in each half-hour: its charger rate,
    or an equal share of the site connection among the vehicles due to be plugged in then."""
    index = {moment: t for t, moment in enumerate(tl['times'])}
    first, last = tl['times'][0].date(), tl['times'][-1].date()
    pattern, sessions, k, day = PATTERNS[segment['id']], [], 0, first  # k: days since the first night, as the depot's rota
    while day <= last:
        if segment['days'] != 'weekdays' or day.weekday() < 5:
            base = datetime(day.year, day.month, day.day, tzinfo=timezone.utc)
            for i in range(segment['vehiclesPerSite']):
                arrive, depart, need = pattern(i, k)
                a = index.get(base + timedelta(minutes=arrive))
                end = index.get(base + timedelta(minutes=depart - SLOT_MINUTES))
                if a is not None and end is not None and end - a == (depart - arrive) // SLOT_MINUTES - 1:
                    sessions.append({'i': i, 'day': day.isoformat(), 'a': a, 'd': end + 1, 'need': need / EV_EFFICIENCY})
        day += timedelta(days=1)
        k += 1
    n = len(tl['times'])
    plugged = [0] * n
    for s in sessions:
        for t in range(s['a'], s['d']):
            plugged[t] += 1
    rate, site = segment['chargerKw'] * SLOT_HOURS, segment['sitePowerKw'] * SLOT_HOURS
    fair = [min(rate, site / p) if p else 0.0 for p in plugged]
    suffix = [0.0] * (n + 1)
    for t in range(n - 1, -1, -1):
        suffix[t] = suffix[t + 1] + fair[t]
    for s in sessions:
        if s['need'] > suffix[s['a']] - suffix[s['d']] + 1e-6:
            raise ValueError(f'{segment["label"]}: a session needs more than its charger and site connection can give')
    return sessions, suffix


# ---------------------------------------------------------------- the allocation

def ev_series(tl, avail, fleet):
    """EV kWh taken from the eligible energy in each half-hour, in time order, without look-ahead.

    `avail` is the eligible energy left after the hub battery; `fleet` lists (segment, sites, sessions,
    fair suffix). All sites of a segment are identical, so each session stands for one vehicle per site.
    In each half-hour every plugged-in vehicle first takes what it must to leave on time (from surplus
    when there is some, else from the grid); then surplus goes to the earliest departures, within each
    vehicle's charger rate and its site's connection. Returns (ev per half-hour, need, from grid)."""
    n = len(avail)
    arrivals = [[] for _ in range(n)]
    order = {seg: j for j, seg in enumerate(SEGMENT_IDS)}
    need = 0.0
    for segment, sites, sessions, suffix in fleet:
        if sites <= 0:
            continue
        rate, site = segment['chargerKw'] * SLOT_HOURS, segment['sitePowerKw'] * SLOT_HOURS
        for s in sessions:
            arrivals[s['a']].append({**s, 'seg': segment['id'], 'm': sites, 'rate': rate, 'site': site, 'suffix': suffix,
                                     'rem': s['need'], 'key': (s['d'], order[segment['id']], s['i'])})
            need += sites * s['need']
    ev, grid, active = [0.0] * n, 0.0, []
    for t in range(n):
        for s in active:
            if s['d'] <= t and s['rem'] > 1e-6:  # a bug, never data: the rule above always meets every session
                raise RuntimeError(f'{s["seg"]} vehicle {s["i"]} left on {s["day"]} short of {s["rem"]:.3f} kWh')
        active = sorted([s for s in active if s['d'] > t] + arrivals[t], key=lambda s: s['key'])
        used = {}
        must_total = 0.0
        for s in active:
            s['must'] = max(0.0, s['rem'] - (s['suffix'][t + 1] - s['suffix'][s['d']]))
            used[s['seg']] = used.get(s['seg'], 0.0) + s['must']
            must_total += s['m'] * s['must']
        from_pool = min(avail[t], must_total)
        left = avail[t] - from_pool
        grid += must_total - from_pool
        for s in active:
            extra = 0.0
            if left > EPS:
                room = min(s['rate'] - s['must'], s['rem'] - s['must'], s['site'] - used[s['seg']])
                if room > EPS:
                    total = min(s['m'] * room, left)
                    extra = total / s['m']
                    used[s['seg']] += extra
                    left -= total
                    from_pool += total
            s['rem'] -= s['must'] + extra
        ev[t] = from_pool
    for s in active:
        if s['rem'] > 1e-6:
            raise RuntimeError(f'{s["seg"]} vehicle {s["i"]} left on {s["day"]} short of {s["rem"]:.3f} kWh')
    return ev, need, grid


def battery_series(residual, battery=None):
    """The Dashboard's grid battery through the week: in each half-hour storage.charge() takes what EVs left, from
    the level the previous half-hour ended at. Charge side only, as on the Dashboard: once it reads 100% it stays full
    and everything it cannot take is surplus for the hydrogen plant. Returns (grid kWh, level after, index when full)."""
    battery = battery or GRID_BATTERY
    capacity, level = battery['capacityKwh'], optimizer.r3(battery['capacityKwh'] * battery['startFraction'])
    grid, levels, full_at = [], [], None
    for t, offered in enumerate(residual):
        s = storage.charge({**battery, 'startFraction': level / capacity}, offered)
        grid.append(s['gridKwh'])
        level = s['endKwh']
        levels.append(level)
        if full_at is None and level >= capacity - FULL_TOLERANCE_KWH:
            full_at = t
    return grid, levels, full_at


def electrolyser_series(tl, residual, plant):
    """What the electrolyser takes of the energy left after EVs, half-hour by half-hour, and why the rest is unused.

    Limits: rated power x 0.5 h, its minimum stable load (it runs at that load or more, or not at all),
    downtime, network access and the day's hydrogen offtake (kg a day, None for no limit)."""
    cap = plant['ratedKw'] * SLOT_HOURS
    min_load = plant['minLoadFraction'] * cap
    per_kg = plant['kwhPerKg']
    offtake = plant['offtakeKgPerDay']
    down = [(offers.utc(w['from']), offers.utc(w['to'])) for w in plant['downtime']]
    made, h2, unused, why = {}, [], [], []
    for t, r in enumerate(residual):
        take, reason = 0.0, None
        if r > EPS:
            moment = tl['times'][t]
            if not plant['enabled']:
                reason = 'hydrogen-off'
            elif plant['networkAccess'] == 'none':
                reason = 'plant-no-access'
            elif any(a <= moment < b for a, b in down):
                reason = 'plant-downtime'
            else:
                limit = r
                if cap < limit:
                    limit, reason = cap, 'plant-at-capacity'
                if offtake is not None:
                    left = max(0.0, offtake - made.get(moment.date(), 0.0)) * per_kg
                    if left < limit:
                        limit, reason = left, 'no-offtake' if offtake <= 0 else 'offtake-met'
                if limit < min_load - EPS:
                    reason = 'below-minimum-load' if r < min_load - EPS else reason
                else:
                    take = limit
                    made[moment.date()] = made.get(moment.date(), 0.0) + take / per_kg
        h2.append(take)
        unused.append(max(0.0, r - take))
        why.append(reason if r - take > 1e-6 else None)
    return h2, unused, why


def slot_ledger(forecast, pool, hub, ev, h2, unused, per_kg):
    """One half-hour in the energy ledger (energy-ledger/v1 plus the electrolyser), unrounded."""
    predicted = forecast or 0.0
    return {'version': optimizer.LEDGER_VERSION, 'unit': 'kWh', 'boundary': 'grid-side',
            'predictedAtRiskKwh': predicted, 'eligibleOpportunityKwh': pool, 'notEligibleKwh': predicted - pool,
            'allocatedToChargersGridKwh': ev, 'allocatedToRealStorageKwh': hub, 'allocatedToHydrogenGridKwh': h2,
            'unallocatedOpportunityKwh': unused, 'batteryDeliveredKwh': ev * EV_EFFICIENCY,
            'chargingLossKwh': ev - ev * EV_EFFICIENCY, 'chargingEfficiency': EV_EFFICIENCY,
            'hydrogenKwhPerKg': per_kg, 'hydrogenKg': h2 / per_kg}


def check_hydrogen(ledger, plant=None):
    """Every problem with the electrolyser side of a ledger (empty when it is sound)."""
    problems = []
    h2, per_kg, kg = ledger.get('allocatedToHydrogenGridKwh'), ledger.get('hydrogenKwhPerKg'), ledger.get('hydrogenKg')
    for key, value in (('allocatedToHydrogenGridKwh', h2), ('hydrogenKwhPerKg', per_kg), ('hydrogenKg', kg)):
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < -TOLERANCE_KWH:
            problems.append(f'{key} must be a finite, non-negative number')
    if problems:
        return problems
    if not HHV_KWH_PER_KG <= per_kg <= MAX_KWH_PER_KG:
        problems.append(f'kWh per kg must be between {HHV_KWH_PER_KG:g} and {MAX_KWH_PER_KG:g}')
    elif abs(kg - h2 / per_kg) > 1e-3:
        problems.append('hydrogen kg != electrolyser input / kWh per kg')
    if plant is not None:
        cap = plant['ratedKw'] * SLOT_HOURS
        if h2 > cap + TOLERANCE_KWH:
            problems.append('electrolyser input exceeds its rated power')
        if TOLERANCE_KWH < h2 < plant['minLoadFraction'] * cap - TOLERANCE_KWH:
            problems.append('electrolyser runs below its minimum stable load')
    return problems


def check_slot(ledger, plant, access_kwh):
    problems = optimizer.check_ledger(ledger) + check_hydrogen(ledger, plant)
    if ledger['eligibleOpportunityKwh'] > access_kwh + TOLERANCE_KWH:
        problems.append('eligible energy exceeds the network access')
    return problems


# ---------------------------------------------------------------- stages

def size_stage(stage, pool_kwh, hub_kwh, site_need):
    """Sites per segment that plan for the stage's EV share: (share x eligible - hub) spread by the mix,
    in whole sites. Planning, not an outcome: what EVs can really take is simulated afterwards."""
    if stage.get('sites') is not None:
        return {seg: int(stage['sites'].get(seg, 0)) for seg in SEGMENT_IDS}
    fleet_kwh = max(0.0, stage['targetEvShare'] * pool_kwh - hub_kwh)
    return {seg: (int(math.floor(stage['mix'].get(seg, 0.0) * fleet_kwh / site_need[seg] + 0.5)) if site_need[seg] > 0 else 0)
            for seg in SEGMENT_IDS}


def aggregate_ledger(forecast, pool, hub, ev, h2, per_kg):
    """The stage's week in energy-ledger/v1 terms, rounded to 1 Wh; unused is derived so it balances exactly."""
    predicted, eligible, hub, ev, h2 = r3(forecast), r3(pool), r3(hub), r3(ev), r3(h2)
    unused = r3(eligible - hub - ev - h2)
    if -0.01 < unused < 0:  # rounding only: never shows a negative remainder
        unused, h2 = 0.0, r3(eligible - hub - ev)
    delivered = r3(ev * EV_EFFICIENCY)
    return {'version': optimizer.LEDGER_VERSION, 'unit': 'kWh', 'boundary': 'grid-side',
            'predictedAtRiskKwh': predicted, 'eligibleOpportunityKwh': eligible, 'notEligibleKwh': r3(predicted - eligible),
            'allocatedToChargersGridKwh': ev, 'allocatedToRealStorageKwh': hub, 'allocatedToHydrogenGridKwh': h2,
            'unallocatedOpportunityKwh': unused, 'batteryDeliveredKwh': delivered, 'chargingLossKwh': r3(ev - delivered),
            'chargingEfficiency': EV_EFFICIENCY, 'hydrogenKwhPerKg': per_kg, 'hydrogenKg': r3(h2 / per_kg),
            'storage': {'parts': [offers.BATTERY['name'], GRID_BATTERY['name']],
                        'note': ('The Rewards hub battery (its losses and discharge to EVs are in the energy flow above) and the '
                                 'Dashboard\'s simulated grid battery (charge side only).')}}


def run_stage(stage, tl, pool, hub, fleet, site_need, plant, access_kwh):
    sites = size_stage(stage, sum(pool), sum(hub), site_need)
    by_id = {segment['id']: (segment, sessions, suffix) for segment, sessions, suffix in fleet}
    ev, need, from_grid = ev_series(tl, [p - h for p, h in zip(pool, hub)],
                                    [(by_id[s][0], sites[s], by_id[s][1], by_id[s][2]) for s in SEGMENT_IDS])
    left = [max(0.0, p - h - e) for p, h, e in zip(pool, hub, ev)]
    battery, levels, full_at = battery_series(left)
    residual = [max(0.0, x - b) for x, b in zip(left, battery)]  # the surplus the grid battery could not take
    h2, unused, why = electrolyser_series(tl, residual, plant)
    problems = []
    for t in range(len(pool)):
        ledger = slot_ledger(tl['forecast'][t], pool[t], hub[t] + battery[t], ev[t], h2[t], unused[t], plant['kwhPerKg'])
        problems += [f'{tl["starts"][t]}: {p}' for p in check_slot(ledger, plant, access_kwh)]
    if problems:  # a bug, never data: refuse rather than show energy that does not add up
        raise RuntimeError(f'{stage["id"]} ledger does not balance: {problems[0]}')
    total_pool, total_hub, total_ev, total_h2, total_battery = sum(pool), sum(hub), sum(ev), sum(h2), sum(battery)
    ledger = aggregate_ledger(sum(f or 0.0 for f in tl['forecast']), total_pool, total_hub + total_battery, total_ev, total_h2,
                              plant['kwhPerKg'])
    problems = optimizer.check_ledger(ledger) + check_hydrogen(ledger)
    if problems:
        raise RuntimeError(f'{stage["id"]} week ledger does not balance: {problems[0]}')
    reasons = {}
    for u, code in zip(unused, why):
        if code:
            reasons[code] = reasons.get(code, 0.0) + u
    running = sum(1 for x in h2 if x > EPS)
    share = (lambda kwh: round(kwh / total_pool, 6) if total_pool > 0 else None)
    kg = ledger['hydrogenKg']
    vehicles = sum(sites[s['id']] * s['vehiclesPerSite'] for s in SEGMENTS)
    return {
        'id': stage['id'], 'label': stage.get('label', stage['id']), 'story': stage.get('story', ''),
        'targetLabel': stage.get('targetLabel'),
        'targetEvShare': round(stage['targetEvShare'], 6) if stage.get('targetEvShare') is not None else None,
        'plannedEvKwh': r1(stage['targetEvShare'] * total_pool) if stage.get('targetEvShare') is not None else None,
        'sites': sites, 'vehicles': vehicles,
        'segments': [{'id': s['id'], 'label': s['label'], 'unit': s['unit'], 'sites': sites[s['id']],
                      'vehicles': sites[s['id']] * s['vehiclesPerSite'], 'needKwh': r1(sites[s['id']] * site_need[s['id']])}
                     for s in SEGMENTS if sites[s['id']] > 0],
        'totals': {'eligibleKwh': ledger['eligibleOpportunityKwh'], 'hubKwh': r3(total_hub), 'batteryKwh': r3(total_battery),
                   'evKwh': ledger['allocatedToChargersGridKwh'], 'evTotalKwh': r3(ledger['allocatedToChargersGridKwh'] + total_hub),
                   'hydrogenKwh': ledger['allocatedToHydrogenGridKwh'], 'unusedKwh': ledger['unallocatedOpportunityKwh'],
                   'hydrogenKg': kg, 'hydrogenEnergyKwh': r1(kg * LHV_KWH_PER_KG),
                   'conversionLossKwh': r1(ledger['allocatedToHydrogenGridKwh'] - kg * LHV_KWH_PER_KG)},
        'shares': {'ev': share(ledger['allocatedToChargersGridKwh']), 'hub': share(total_hub), 'battery': share(total_battery),
                   'evTotal': share(ledger['allocatedToChargersGridKwh'] + total_hub),
                   'hydrogen': share(ledger['allocatedToHydrogenGridKwh']), 'unused': share(ledger['unallocatedOpportunityKwh'])},
        'ev': {'needKwh': r1(need), 'fromEligibleKwh': r1(total_ev), 'fromGridKwh': r1(from_grid),
               'note': 'Every EV session is met: from spare renewable energy when there is some while it is plugged in, '
                       'otherwise from the grid at the latest half-hour it still can.'},
        'hydrogen': {'kg': kg, 'utilisation': round(total_h2 / (plant['ratedKw'] * SLOT_HOURS * len(pool)), 6) if plant['ratedKw'] > 0 else None,
                     'halfHoursRunning': running, 'greyEquivalentT': [r1(kg * x / 1000) for x in GREY_KG_CO2_PER_KG]},
        'unusedReasons': [{'code': code, 'label': REASONS[code], 'kwh': r1(kwh)} for code, kwh in sorted(reasons.items(), key=lambda x: -x[1])],
        'verification': verification(tl, pool, hub, ev, h2, access_kwh),
        'gridBattery': grid_battery(tl, battery, levels, full_at, residual),
        'byNight': [night_totals(span, hub, ev, battery, h2, unused, why) for span in tl['nights']],
        'series': {'ev': [r1(x) for x in ev], 'battery': [r1(x) for x in battery], 'hydrogen': [r1(x) for x in h2],
                   'unused': [r1(x) for x in unused], 'batteryLevel': [round(x / GRID_BATTERY['capacityKwh'], 4) for x in levels],
                   'why': why},
        'ledger': ledger,
    }


def grid_battery(tl, battery, levels, full_at, surplus):
    """The Dashboard's grid battery over the week: how full it got, when it reached 100%, and the surplus it then
    passed on for hydrogen (what it could not take: the electrolyser's input plus what stays unused)."""
    b, capacity = GRID_BATTERY, GRID_BATTERY['capacityKwh']
    grid = sum(battery)
    stored = (levels[-1] if levels else capacity * b['startFraction']) - optimizer.r3(capacity * b['startFraction'])
    return {'name': b['name'], 'provenance': b['provenance'], 'capacityKwh': capacity, 'maxPowerKw': b['maxPowerKw'],
            'chargeEfficiency': b['chargeEfficiency'], 'startFraction': b['startFraction'],
            'endFraction': round((levels[-1] if levels else capacity * b['startFraction']) / capacity, 4),
            'gridKwh': r1(grid), 'storedKwh': r1(stored), 'lossKwh': r1(grid - stored),
            'fullAt': None if full_at is None else tl['starts'][full_at], 'fullIndex': full_at,
            'surplusAfterFullKwh': r1(sum(surplus)), 'releaseModelled': False,
            'note': ('The Dashboard\'s simulated grid battery, charged half-hour by half-hour through the replay week from '
                     f'{b["startFraction"]:.0%}. Charge side only, as on the Dashboard: once it reads 100% it stays full, and '
                     'everything it cannot take is surplus for the hydrogen plant.')}


def night_totals(span, hub, ev, battery, h2, unused, why):
    """One night of a stage: what EVs, the battery, the electrolyser and nobody took, and the main reason for the unused part."""
    a, b = span['from'], span['to']
    reasons = {}
    for u, code in zip(unused[a:b], why[a:b]):
        if code:
            reasons[code] = reasons.get(code, 0.0) + u
    return {'date': span['date'], 'evTotalKwh': r1(sum(hub[a:b]) + sum(ev[a:b])), 'batteryKwh': r1(sum(battery[a:b])),
            'hydrogenKwh': r1(sum(h2[a:b])),
            'unusedKwh': r1(sum(unused[a:b])), 'halfHoursRunning': sum(1 for x in h2[a:b] if x > EPS),
            'unusedReason': max(reasons, key=reasons.get) if reasons else None}


def verification(tl, pool, hub, ev, h2, access_kwh):
    """How much of the electrolyser's input fell in half-hours where curtailment was then recorded.

    Hydrogen is served last, so it is matched against what the observation leaves after the EVs. The
    rest was a false alarm (forecast, not recorded) or not observed. Recorded nationally: it still does
    not show the energy could reach the plant."""
    coincident = false_alarm = unknown = 0.0
    for t, x in enumerate(h2):
        if x <= EPS:
            continue
        seen = tl['observed'][t]
        if seen is None:
            unknown += x
            continue
        matched = min(x, max(0.0, min(seen, access_kwh) - hub[t] - ev[t]))
        coincident += matched
        false_alarm += x - matched
    total = coincident + false_alarm + unknown
    return {'recordedKwh': r1(coincident), 'falseAlarmKwh': r1(false_alarm), 'notObservedKwh': r1(unknown),
            'recordedShare': round(coincident / total, 6) if total > EPS else None}


# ---------------------------------------------------------------- the page's block

def config(overrides=None):
    """The access and plant for a run: the defaults, with validated overrides from parse_query()."""
    access, plant = dict(ACCESS), {**PLANT, 'downtime': list(PLANT['downtime'])}
    for key, value in (overrides or {}).items():
        if key == 'accessKw':
            access['kw'] = value
        elif key == 'plant':
            plant['enabled'] = value == 'on'
        else:
            plant[key] = value
    return access, plant


def validate(access, plant):
    """Every problem with an access/plant configuration (empty when usable)."""
    problems = []

    def number(value, name, low, high):
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
            problems.append(f'{name} must be between {low:g} and {high:g}')
    number(access['kw'], 'Network access (kW)', 0, 100_000)
    number(plant['ratedKw'], 'Electrolyser size (kW)', 0, 100_000)
    number(plant['minLoadFraction'], 'Minimum load', 0, 0.99)
    number(plant['kwhPerKg'], 'kWh per kg', HHV_KWH_PER_KG, MAX_KWH_PER_KG)
    if plant['offtakeKgPerDay'] is not None:
        number(plant['offtakeKgPerDay'], 'Offtake (kg a day)', 0, 1_000_000)
    if plant['networkAccess'] not in ('conditional', 'none'):
        problems.append('Electrolyser network access must be conditional or none')
    for w in plant['downtime']:
        try:
            if offers.utc(w['from']) >= offers.utc(w['to']):
                problems.append('Downtime must end after it starts')
        except (KeyError, TypeError, ValueError):
            problems.append('Downtime needs ISO from and to times')
    return problems


def build(nights, data_mode='historical-replay', tariff=business.TARIFF, overrides=None, scenario_id=None, stages=STAGES):
    """The Impact page's hydrogen block: the eligible pool of the replayed week, three EV stages and the electrolyser.

    `stages` may give explicit sites per segment ({'id', 'sites': {segment: n}}) instead of a planned share."""
    access, plant = config(overrides)
    problems = validate(access, plant)
    if problems:
        raise ValueError(problems[0])
    tl = timeline(nights)
    pool = pool_series(tl, access)
    hub = hub_series(nights, tl, pool, tariff)
    fleet, site_need = [], {}
    for segment in SEGMENTS:
        sessions, suffix = site_sessions(tl, segment)
        fleet.append((segment, sessions, suffix))
        site_need[segment['id']] = sum(s['need'] for s in sessions)
    access_kwh = access['kw'] * SLOT_HOURS
    stages = [run_stage(stage, tl, pool, hub, fleet, site_need, plant, access_kwh) for stage in stages]
    claims = access_claims(access)
    forecast_kwh = sum(f or 0.0 for f in tl['forecast'])
    nights_out = [{'date': span['date'], 'from': span['from'], 'to': span['to'],
                   'eligibleKwh': r1(sum(pool[span['from']:span['to']]))} for span in tl['nights']]
    busiest = max(range(len(nights_out)), key=lambda k: (nights_out[k]['eligibleKwh'], -k))
    not_eligible, reachable = {}, access_kwh > 0 and claims['curtailment']['status'] in ('eligible', 'conditional')
    for f, p in zip(tl['forecast'], pool):
        if f is not None and f - p > EPS:
            code = 'beyond-access' if reachable else 'no-access'
            not_eligible[code] = not_eligible.get(code, 0.0) + f - p
    block = {
        'version': VERSION, 'status': 'illustrative', 'scenarioId': scenario_id,
        'label': 'Illustrative hydrogen · simulated pilot · not an ESB agreement',
        'dataMode': data_mode, 'provenance': {'forecasts': 'simulated' if data_mode == 'simulated' else 'historical-prediction',
                                              'access': 'hypothetical', 'evSites': 'simulated', 'electrolyser': 'hypothetical'},
        'period': {'from': tl['starts'][0], 'to': (tl['times'][-1] + timedelta(minutes=SLOT_MINUTES)).strftime('%Y-%m-%dT%H:%M:%SZ'),
                   'nights': len(nights), 'nightDates': [span['date'] for span in tl['nights']], 'halfHours': len(pool)},
        'nights': nights_out, 'defaultNight': busiest, 'defaultStage': stages[0]['id'],
        'access': {**access, 'kwhPerHalfHour': r1(access_kwh), 'status': claims['curtailment']['status'],
                   'reason': claims['curtailment']['reason'], 'constraint': claims['constraint']},
        'plant': {**plant, 'capKwhPerHalfHour': r1(plant['ratedKw'] * SLOT_HOURS),
                  'minLoadKwh': r1(plant['minLoadFraction'] * plant['ratedKw'] * SLOT_HOURS),
                  'kwhPerKgRange': PLANT['kwhPerKgRange']},
        'forecast': {'atRiskKwh': r1(forecast_kwh), 'eligibleKwh': r1(sum(pool)), 'notEligibleKwh': r1(forecast_kwh - sum(pool)),
                     'notEligible': [{'code': c, 'label': NOT_ELIGIBLE[c], 'kwh': r1(v)} for c, v in not_eligible.items()],
                     'halfHoursWithForecast': sum(1 for f in tl['forecast'] if f is not None),
                     'halfHoursEligible': sum(1 for p in pool if p > EPS)},
        'segments': [dict(s) for s in SEGMENTS],
        'slots': {'start': tl['starts'], 'forecastKwh': [None if f is None else r1(f) for f in tl['forecast']],
                  'observedKwh': [None if o is None else r1(o) for o in tl['observed']],
                  'eligibleKwh': [r1(p) for p in pool], 'hubKwh': [r1(h) for h in hub]},
        'stages': stages,
        'checks': {'halfHours': len(pool) * len(stages), 'problems': 0, 'toleranceKwh': TOLERANCE_KWH,
                   'rule': 'eligible = EV chargers + hub battery + grid battery + electrolyser + unused, every half-hour of every stage'},
        'reasons': REASONS,
        'commercial': COMMERCIAL,
        'environment': environment(plant),
        'method': METHOD,
        'limitations': LIMITATIONS,
        'sources': SOURCES,
    }
    return block


COMMERCIAL = {
    'status': 'not-priced', 'label': 'Commercial potential: not yet priced',
    'buyer': ('An industrial electrolyser operator could pay for flexible electricity-use recommendations that stop eligible '
              'renewable energy going unused. ESB could pilot this; there is no contract, sale or agreement.'),
    'model': ('A separate software or performance fee, agreed per contract and paid only on verified net value to the plant. '
              'It never touches the EV Rewards 50/25/25 split, and no kWh earns both: each is allocated once.'),
    'needs': ['Power price and network charges at the plant', 'Conversion, operating and water costs',
              'What the hydrogen is worth to its buyer', 'Our servicing costs', 'Contract terms'],
}
def environment(plant):
    """What the hydrogen means for the planet, and what is not known: potential, not delivered, CO2 not verified."""
    kept = LHV_KWH_PER_KG / plant['kwhPerKg']
    return {
        'status': 'potential', 'label': 'Potential, not delivered',
        'keptShare': round(kept, 4),
        'why': (f'Hydrogen keeps renewable energy that would go unused for industry and long-duration use, but converting it '
                f'loses energy: at {plant["kwhPerKg"]:g} kWh per kg, about {kept:.0%} of the electricity ends up in the hydrogen '
                f'({LHV_KWH_PER_KG:g} kWh/kg).'),
        'co2': {'status': 'not-verified', 'label': 'CO₂ impact not verified',
                'baseline': ('Context only: hydrogen from unabated natural gas emits about 10–12 kg CO₂-eq per kg (IEA). Replacing '
                             'it would avoid that much only if the surplus would otherwise have been dispatched down, the energy '
                             'could reach the plant, and the electrolyser\'s own lifecycle emissions are counted.'),
                'notIncluded': ['The marginal emissions of the electricity used', 'Electrolyser manufacturing and upstream emissions',
                                'Compression, storage and transport', 'What the hydrogen would really replace']},
        'evUnchanged': 'The EV CO₂ estimate above is unchanged and separate.',
    }
METHOD = [
    'Eligible energy = the +30 minute forecast of curtailment, capped by the pilot sites\' network access x 0.5 h. '
    'The +60 minute forecast of the same half-hour is never added.',
    'EVs first: the Rewards hub battery (unchanged), then EV sites, earliest departure first, within each charger, site '
    'connection and plug-in window. Every session is met; energy from the grid outside surplus is not in this ledger.',
    'Grid battery next: the Dashboard\'s simulated grid battery (10 MWh, 5 MW, 90% charge efficiency) takes what EVs '
    'leave, from 40% full, half-hour after half-hour. Charge side only, as on the Dashboard: once it reads 100% it stays full.',
    'Electrolyser only then: the surplus the full battery cannot take, up to its rated power x 0.5 h, only at or above its '
    'minimum stable load, outside downtime and within the day\'s hydrogen offtake.',
    'Unused = eligible - EVs - hub battery - grid battery - electrolyser. It is never forced to zero.',
    'kg of hydrogen = electrolyser input kWh / kWh per kg (default 55, IEA range 50–55).',
    'Stages size EV sites to plan for 1/3, 2/3 or all of the eligible energy; the share EVs really take is simulated.',
]
LIMITATIONS = [
    'The network access, EV sites and electrolyser are hypothetical. The plant is ESB-inspired: no ESB partnership, '
    'connection, agreement or delivery is implied.',
    'Forecast curtailment is not recovered energy: whether it could reach these sites is not confirmed with EirGrid or ESB Networks.',
    'One replayed week, not seasonally adjusted. Stages are planning hypotheses, not forecasts of EV adoption.',
    'Hydrogen is potential, not delivered; its CO₂ impact is not verified and it is not priced.',
]


# ---------------------------------------------------------------- API: what-if (the page's toggle and assumptions)

QUERY_FIELDS = {
    # name: (label, minimum, maximum)
    'kwhPerKg': ('kWh per kg', HHV_KWH_PER_KG, MAX_KWH_PER_KG),
    'ratedKw': ('Electrolyser size (kW)', 0, 100_000),
    'accessKw': ('Network access (kW)', 0, 100_000),
    'minLoadPct': ('Minimum load (%)', 0, 99),
    'offtakeKgPerDay': ('Hydrogen offtake (kg a day)', 0, 1_000_000),
}


def parse_query(query):
    """Validate what-if overrides; returns (overrides, {field: message}). Omitted fields keep the defaults."""
    values, errors = {}, {}
    for name, (label, low, high) in QUERY_FIELDS.items():
        raw = query.get(name)
        if raw in (None, ''):
            continue
        try:
            value = float(raw)
        except (TypeError, ValueError):
            errors[name] = f'{label} must be a number.'
            continue
        if not math.isfinite(value) or not low <= value <= high:
            errors[name] = f'{label} must be between {low:,g} and {high:,g}.'
        elif name == 'minLoadPct':
            values['minLoadFraction'] = value / 100
        else:
            values[name] = value
    plant = query.get('plant')
    if plant not in (None, ''):
        if plant not in ('on', 'off'):
            errors['plant'] = 'Plant must be on or off.'
        else:
            values['plant'] = plant
    return values, errors


_inputs_lock = threading.Lock()
_inputs = OrderedDict()  # scenarioId -> (nights, data mode, tariff), for the what-if endpoint


def remember(scenario_id, nights, data_mode, tariff):
    with _inputs_lock:
        _inputs[scenario_id] = (nights, data_mode, tariff)
        _inputs.move_to_end(scenario_id)
        while len(_inputs) > 4:
            _inputs.popitem(last=False)


def estimate(scenario_id, overrides):
    """The hydrogen block again for the same replay with the page's overrides (None if that replay is unknown)."""
    with _inputs_lock:
        found = _inputs.get(scenario_id)
    if found is None:
        return None
    nights, data_mode, tariff = found
    return build(nights, data_mode, tariff, overrides, scenario_id)


def unavailable(error):
    """Fail closed: the rest of the Impact page still shows; this block says why hydrogen is missing."""
    return {'version': VERSION, 'status': 'unavailable',
            'message': 'The hydrogen scenario could not be calculated from this replay, so none of it is shown.',
            'reason': type(error).__name__}
