"""Deterministic, constraint-aware EV charging plans and the energy ledger (the "energy bridge").

No language model is involved. Each plan assigns grid energy to (vehicle, half-hour)
pairs; every plan is checked against the hard constraints by check_plan(), and every
ledger against the conservation equations by check_ledger(), before it is returned.
See docs/CHARGING_OPTIMIZER.md.

Units: kW x 0.5 h = kWh; kWh / 1000 = MWh. Grid energy is what the charger draws;
battery energy = grid energy x charging efficiency.

Conservation, for one forecast half-hour, all at the grid-side boundary:

    eligible opportunity = allocated to EV chargers + allocated to real storage (0) + unallocated
    allocated to EV chargers = delivered into batteries + charging loss
"""
from datetime import datetime, timedelta
import hashlib
import json
import math

import eligibility
import fleet as fleets

SLOT_HOURS = fleets.SLOT_MINUTES / 60
EPS = 1e-9
# Numerical tolerance for the ledger checks: ledger values are rounded to 1 Wh (3 decimals of kWh).
LEDGER_TOLERANCE_KWH = 1e-6
# A target timestamp labels the START of its half-hour: target T covers [T, T + 30 min)
# (the V1 dataset contract, see backend/README.md). Both horizons forecast the same target,
# each from its own issue time (+60 issued at T - 60, +30 at T - 30).
INTERVAL_LABEL = 'start'
SOLVER_ID = 'equal-share-v2'
LEDGER_VERSION = 'energy-ledger/v1'
NETWORK_ELIGIBILITY = 'unverified'
POLICIES = {
    'arrival-order': 'Charge on arrival, first come first served (baseline)',
    'equal-share': ('Share the forecast window energy equally between the plugged-in vehicles (max-min fair), '
                    'then charge the rest earliest departure first'),
}
BASELINE, OPTIMIZED = 'arrival-order', 'equal-share'


class ForecastError(ValueError):
    """The forecast handed to the optimizer is inconsistent (never a user error)."""


def _parse(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00'))


def target_slot(plan_start, target_at, label=INTERVAL_LABEL):
    """Plan slot index of the forecast target half-hour, counted from the plan start."""
    minutes = (_parse(target_at) - _parse(plan_start)).total_seconds() / 60
    if minutes < (0 if label == 'start' else fleets.SLOT_MINUTES) or minutes % fleets.SLOT_MINUTES:
        raise ValueError('Target must be a whole number of half-hours after the plan start')
    index = int(minutes // fleets.SLOT_MINUTES)
    return index - 1 if label == 'end' else index


def check_prediction(p):
    """Refuse a forecast that would make the ledger meaningless (negative, non-finite or unbalanced MWh)."""
    try:
        values = {k: p[k] for k in ('atRiskMwh', 'curtailmentMwh', 'constraintMwh', 'lowerMwh')}
        issued, target = _parse(p['issuedAt']), _parse(p['targetAt'])
        horizon = p['horizonMinutes']
    except (KeyError, TypeError, ValueError, AttributeError) as error:
        raise ForecastError(f'Forecast is missing or has an invalid field ({error})') from None
    for name, value in values.items():
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
            raise ForecastError(f'Forecast {name} must be a finite, non-negative number of MWh')
    if abs(values['curtailmentMwh'] + values['constraintMwh'] - values['atRiskMwh']) > 1e-3:
        raise ForecastError('Forecast curtailment and constraint must add up to the energy at risk')
    if (target - issued).total_seconds() != horizon * 60:
        raise ForecastError('Forecast target must be exactly one horizon after its issue time')


class Plan:
    """Mutable allocation state for one policy run."""

    def __init__(self, fleet, slots):
        self.fleet, self.slots = fleet, slots
        self.sites = {s['id']: s for s in fleet['sites']}
        self.eff = fleet['chargingEfficiency']
        self.need = {v['id']: v['requiredKwh'] / self.eff for v in fleet['vehicles']}  # grid kWh still needed
        self.available = {v['id']: set(fleets.available_slots(v, slots)) for v in fleet['vehicles']}
        self.alloc = {v['id']: {} for v in fleet['vehicles']}  # vehicle -> slot -> grid kWh
        self.chargers = {(s, t): 0 for s in self.sites for t in range(slots)}
        self.energy = {(s, t): 0.0 for s in self.sites for t in range(slots)}
        self.blocked = {v['id']: {} for v in fleet['vehicles']}  # vehicle -> reason -> count
        self.capped = False
        # Grid kWh each vehicle takes from the forecast opportunity (equal-share only; None for the baseline).
        self.share = None

    def rate(self, vehicle):
        return min(vehicle['maxKw'], self.sites[vehicle['site']]['chargerKw'])

    def charge(self, vehicle, slot, limit=None):
        """Give a vehicle as much energy as allowed in a slot. Returns grid kWh given."""
        vid, site = vehicle['id'], self.sites[vehicle['site']]
        if slot not in self.available[vid] or self.need[vid] <= EPS:
            return 0.0
        key, current = (site['id'], slot), self.alloc[vid].get(slot, 0.0)
        if not current and self.chargers[key] >= site['chargers']:
            self.blocked[vid]['chargers'] = self.blocked[vid].get('chargers', 0) + 1
            return 0.0
        headroom = site['sitePowerKw'] * SLOT_HOURS - self.energy[key]
        energy = min(self.rate(vehicle) * SLOT_HOURS - current, self.need[vid], headroom)
        if limit is not None and limit < energy:
            energy = limit
        if energy <= EPS:
            if headroom <= EPS:
                self.blocked[vid]['sitePower'] = self.blocked[vid].get('sitePower', 0) + 1
            return 0.0
        self.alloc[vid][slot] = current + energy
        self.need[vid] -= energy
        self.chargers[key] += 0 if current else 1
        self.energy[key] += energy
        return energy

    def chronological(self, order):
        for slot in range(self.slots):
            for vehicle in sorted(self.fleet['vehicles'], key=order):
                self.charge(vehicle, slot)


def arrival_order(v):
    return v['arriveMin'], v['id']


def deadline_order(v):
    return v['departMin'], v['id']


def progressive_fill(caps, groups):
    """Max-min fair ("water-filling") allocation.

    caps: {member: upper bound}. groups: [(members, capacity)], each a shared limit.
    Every unfrozen member rises by the same amount until its own cap or a group it belongs
    to is full; then it is frozen and the others keep rising. The groups used here (sites,
    the curtailment pool, the whole opportunity) nest, so the result also uses as much
    energy as the limits allow. Returns ({member: amount}, names of groups that filled).
    """
    amount = {m: 0.0 for m in caps}
    active = {m for m, cap in caps.items() if cap > EPS}
    full = set()
    while active:
        step = min(caps[m] - amount[m] for m in active)
        for members, capacity in groups:
            rising = members & active
            if rising:
                step = min(step, (capacity - sum(amount[m] for m in members)) / len(rising))
        step = max(0.0, step)
        for m in active:
            amount[m] += step
        frozen = {m for m in active if caps[m] - amount[m] <= EPS}
        for index, (members, capacity) in enumerate(groups):
            if members & active and capacity - sum(amount[m] for m in members) <= EPS * max(1.0, capacity):
                frozen |= members & active
                full.add(index)
        if not frozen:  # cannot happen with finite limits; never loop forever
            break
        active -= frozen
    return amount, full


def equal_share(plan, slot, pools):
    """Share the window's eligible forecast energy equally between the vehicles that can take it.

    Only vehicles plugged in for the whole window, still needing energy and at a site whose
    charging may be claimed against the forecast take part. A site with fewer chargers than
    such vehicles plugs in the ones that can take the most (then earliest departure), so as
    much of the opportunity as possible is used; the others wait and are reported.
    """
    plan.share = {}
    if pools is None or not 0 <= slot < plan.slots:
        return
    caps, by_site, zone_free = {}, {}, set()
    for site in sorted(plan.sites.values(), key=lambda s: s['id']):
        components = eligibility.claimable_components(site)
        if not components:
            continue
        waiting = [v for v in plan.fleet['vehicles'] if v['site'] == site['id']
                   and slot in plan.available[v['id']] and plan.need[v['id']] > EPS]
        cap = {v['id']: min(plan.rate(v) * SLOT_HOURS, plan.need[v['id']]) for v in waiting}
        # Prefer the earliest departures, unless plugging in the vehicles that can take the most
        # energy lets the site use more of the opportunity (the site power limit often decides).
        headroom = site_headroom(plan, site['id'], slot)
        usable = lambda order: min(headroom, sum(cap[v['id']] for v in order[:site['chargers']]))
        by_deadline = sorted(waiting, key=lambda v: (v['departMin'], -cap[v['id']], v['id']))
        by_energy = sorted(waiting, key=lambda v: (-cap[v['id']], v['departMin'], v['id']))
        waiting = by_deadline if usable(by_deadline) >= usable(by_energy) - EPS else by_energy
        for vehicle in waiting[site['chargers']:]:
            plan.blocked[vehicle['id']]['chargers'] = plan.blocked[vehicle['id']].get('chargers', 0) + 1
        plugged = {v['id'] for v in waiting[:site['chargers']]}
        caps.update((vid, cap[vid]) for vid in plugged)
        by_site[site['id']] = plugged
        if 'constraint' not in components:
            zone_free |= plugged  # may only use system-wide curtailment
    groups = [(members, site_headroom(plan, site_id, slot)) for site_id, members in sorted(by_site.items())]
    groups.append((zone_free, pools['curtailment']))
    groups.append((set(caps), pools['curtailment'] + pools['constraint']))
    amounts, full = progressive_fill(caps, groups)
    if full & {len(groups) - 2, len(groups) - 1}:
        plan.capped = True
    vehicles = {v['id']: v for v in plan.fleet['vehicles']}
    for vid in sorted(amounts):
        if amounts[vid] > EPS:
            given = plan.charge(vehicles[vid], slot, limit=amounts[vid])
            if given > EPS:
                plan.share[vid] = given


def site_headroom(plan, site_id, slot):
    return plan.sites[site_id]['sitePowerKw'] * SLOT_HOURS - plan.energy[(site_id, slot)]


def attribute(fleet, slot_energy_by_site, pools):
    """Largest claim of window energy against the pools each site may draw on.

    Constraint energy can only go to constraint-zone sites, so those claim it first;
    curtailment then covers the rest. Returns claimed kWh per component.
    """
    sites = {s['id']: s for s in fleet['sites']}
    left = dict(pools)
    claimed = dict(constraint=0.0, curtailment=0.0)
    leftovers = []
    for site_id, energy in sorted(slot_energy_by_site.items()):
        components = eligibility.claimable_components(sites[site_id])
        if 'constraint' in components:
            take = min(energy, left['constraint'])
            left['constraint'] -= take
            claimed['constraint'] += take
            energy -= take
        if 'curtailment' in components:
            leftovers.append(energy)
    for energy in leftovers:
        take = min(energy, left['curtailment'])
        left['curtailment'] -= take
        claimed['curtailment'] += take
    return claimed


def window_energy(plan, slot):
    by_site = {}
    if 0 <= slot < plan.slots:
        for site in plan.sites:
            by_site[site] = plan.energy[(site, slot)]
    return by_site


def run_policy(fleet, slots, policy, slot=None, pools=None):
    plan = Plan(fleet, slots)
    if policy == 'arrival-order':
        plan.chronological(arrival_order)
    elif policy == 'equal-share':
        # The window first, so energy that would otherwise be wasted is used before anything else.
        equal_share(plan, slot, pools)
        plan.chronological(deadline_order)
    else:
        raise ValueError(f'Unknown policy {policy}')
    return plan


def check_plan(plan):
    """Every hard-constraint violation in a plan (empty list when feasible)."""
    problems = []
    for vehicle in plan.fleet['vehicles']:
        vid, site = vehicle['id'], plan.sites[vehicle['site']]
        total = 0.0
        for slot, energy in plan.alloc[vid].items():
            total += energy
            if energy < -EPS:
                problems.append(f'{vid}: negative energy in slot {slot}')
            if slot not in plan.available[vid]:
                problems.append(f'{vid}: charged while not plugged in (slot {slot})')
            if energy > min(vehicle['maxKw'], site['chargerKw']) * SLOT_HOURS + EPS:
                problems.append(f'{vid}: exceeds vehicle/charger rate in slot {slot}')
        if total > vehicle['requiredKwh'] / plan.eff + 1e-6:
            problems.append(f'{vid}: delivered more than required')
    for site in plan.sites.values():
        for slot in range(plan.slots):
            users = sum(1 for v in plan.fleet['vehicles'] if v['site'] == site['id'] and slot in plan.alloc[v['id']])
            if users > site['chargers']:
                problems.append(f'{site["id"]}: more vehicles than chargers in slot {slot}')
            energy = sum(plan.alloc[v['id']].get(slot, 0) for v in plan.fleet['vehicles'] if v['site'] == site['id'])
            if energy > site['sitePowerKw'] * SLOT_HOURS + 1e-6:
                problems.append(f'{site["id"]}: exceeds site power in slot {slot}')
    return problems


def _limiting_reason(plan, vehicle):
    """Why a vehicle's requirement was not met, most fundamental first."""
    vid, slots = vehicle['id'], plan.available[vehicle['id']]
    if not slots:
        return dict(code='not-connected', message=f'{vid} is not plugged in for a whole half-hour inside the plan.')
    site = plan.sites[vehicle['site']]
    if not site['chargers']:
        return dict(code='chargers', message=f'The site for {vid} has no chargers.')
    alone = len(slots) * min(plan.rate(vehicle), site['sitePowerKw']) * SLOT_HOURS
    if alone * plan.eff + 1e-6 < vehicle['requiredKwh']:
        return dict(code='deadline', message=(
            f'{vid} needs {vehicle["requiredKwh"]:g} kWh but can take at most {alone * plan.eff:.1f} kWh '
            f'before it leaves, even charging alone at full rate.'))
    blocked = plan.blocked[vid]
    if blocked.get('chargers', 0) >= blocked.get('sitePower', 0) and blocked.get('chargers'):
        return dict(code='chargers', message=f'{vid} was waiting for a free charger in {blocked["chargers"]} half-hour(s).')
    if blocked.get('sitePower'):
        return dict(code='site-power', message=f'The site power limit was reached in {blocked["sitePower"]} half-hour(s) {vid} was plugged in.')
    return dict(code='rate', message=f'{vid} charged at its maximum rate whenever it was plugged in.')


def window_limits(plan, slot, pools, reachable, claimed):
    """What stopped each site charging more inside the forecast window."""
    if sum(pools.values()) <= 1e-6:
        return [dict(site=None, code='no-forecast', message='No renewable energy is forecast at risk in this window.')]
    if sum(reachable.values()) <= 1e-6:
        return [dict(site=None, code='site-not-eligible', message='No fleet site may claim the forecast energy at risk.')]
    if not 0 <= slot < plan.slots:
        return [dict(site=None, code='no-connected-ev', message='No vehicle is plugged in during the forecast window.')]
    if sum(reachable.values()) - sum(claimed.values()) <= 1e-6:
        return [dict(site=None, code='forecast-window', message='The fleet can take all the eligible forecast energy.')]
    limits = []
    for site in sorted(plan.sites.values(), key=lambda s: s['id']):
        key = (site['id'], slot)
        plugged = [v for v in plan.fleet['vehicles'] if v['site'] == site['id'] and slot in plan.available[v['id']]]
        waiting = [v for v in plugged
                   if plan.alloc[v['id']].get(slot, 0) < plan.rate(v) * SLOT_HOURS - 1e-6
                   # it could have taken more here: energy is still unmet or was scheduled in another half-hour
                   and (plan.need[v['id']] > 1e-6 or sum(plan.alloc[v['id']].values()) > plan.alloc[v['id']].get(slot, 0) + 1e-6)]
        if not eligibility.claimable_components(site):
            code, message = 'site-not-eligible', f'{site["name"]}: its charging is not claimed against the forecast.'
        elif not plugged:
            code, message = 'no-connected-ev', f'{site["name"]}: no vehicle is plugged in for the whole half-hour.'
        elif not waiting:
            code, message = 'vehicles-full', f'{site["name"]}: every plugged-in vehicle is charging at full rate or already full.'
        elif plan.energy[key] >= site['sitePowerKw'] * SLOT_HOURS - 1e-6:
            code, message = 'site-power', f'{site["name"]}: at its {site["sitePowerKw"]:g} kW site limit.'
        elif plan.chargers[key] >= site['chargers']:
            code, message = 'chargers', f'{site["name"]}: all {site["chargers"]} chargers in use.'
        else:
            code, message = 'policy', f'{site["name"]}: this policy left capacity unused.'
        limits.append(dict(site=site['id'], code=code, message=message))
    return limits


def r3(value):
    return round(value + 0.0, 3)


def eligible_pools(fleet, pools):
    """The part of the forecast opportunity at least one fleet site may claim, per component."""
    components = {c for site in fleet['sites'] for c in eligibility.claimable_components(site)}
    return {name: (kwh if name in components else 0.0) for name, kwh in pools.items()}


def not_eligible_reasons(prediction, pools, reachable, mode):
    """Why part of the predicted energy at risk is not an opportunity this fleet could use."""
    reasons = []
    if mode == 'conservative' and sum(pools.values()) < prediction['atRiskMwh'] * 1000 - LEDGER_TOLERANCE_KWH:
        reasons.append(dict(code='conservative-p10', message='Conservative mode scales the forecast down to its P10 estimate.'))
    if pools['constraint'] > EPS and reachable['constraint'] <= EPS:
        reasons.append(dict(code='constraint-not-claimable', message=(
            'Constraint energy is location-specific and no fleet site is (even hypothetically) behind the constraint.')))
    if pools['curtailment'] > EPS and reachable['curtailment'] <= EPS:
        reasons.append(dict(code='no-eligible-site', message='No fleet site is on the Irish grid the forecast covers.'))
    return reasons


def energy_ledger(predicted_kwh, eligible_kwh, allocated_kwh, efficiency, not_eligible, unallocated_reasons):
    """Where every kWh of the window's opportunity goes. Derived fields are computed from rounded values,
    so the published numbers balance exactly (to 1 Wh) and are never forced to 100%."""
    predicted, eligible, allocated = r3(predicted_kwh), r3(eligible_kwh), r3(allocated_kwh)
    delivered = r3(allocated * efficiency)
    unallocated = r3(eligible - allocated)
    return dict(
        version=LEDGER_VERSION, unit='kWh', boundary='grid-side',
        predictedAtRiskKwh=predicted, eligibleOpportunityKwh=eligible, notEligibleKwh=r3(predicted - eligible),
        notEligibleReasons=not_eligible,
        allocatedToChargersGridKwh=allocated, allocatedToRealStorageKwh=0.0, unallocatedOpportunityKwh=unallocated,
        unallocatedReasons=unallocated_reasons if unallocated > 0 else [],
        batteryDeliveredKwh=delivered, chargingLossKwh=r3(allocated - delivered), chargingEfficiency=efficiency,
        utilizationFraction=None if eligible <= 0 else round(allocated / eligible, 6),
        outcome=('no-opportunity' if eligible <= 0 else 'fully-allocated' if unallocated <= 0
                 else 'not-allocated' if allocated <= 0 else 'partially-allocated'))


def check_ledger(ledger, shares=None):
    """Every conservation or sign violation in a ledger (empty list when it balances)."""
    tol, problems = LEDGER_TOLERANCE_KWH, []
    keys = ('predictedAtRiskKwh', 'eligibleOpportunityKwh', 'notEligibleKwh', 'allocatedToChargersGridKwh',
            'allocatedToRealStorageKwh', 'unallocatedOpportunityKwh', 'batteryDeliveredKwh', 'chargingLossKwh')
    for key in keys:
        value = ledger.get(key)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < -tol:
            problems.append(f'{key} must be a finite, non-negative number')
    if problems:
        return problems
    L = ledger
    if abs(L['eligibleOpportunityKwh'] - L['allocatedToChargersGridKwh'] - L['allocatedToRealStorageKwh']
           - L['unallocatedOpportunityKwh']) > tol:
        problems.append('eligible opportunity != allocated to chargers + storage + unallocated')
    if abs(L['allocatedToChargersGridKwh'] - L['batteryDeliveredKwh'] - L['chargingLossKwh']) > tol:
        problems.append('allocated to chargers != delivered into batteries + charging loss')
    if L['eligibleOpportunityKwh'] > L['predictedAtRiskKwh'] + tol:
        problems.append('eligible opportunity exceeds the predicted energy at risk')
    if abs(L['predictedAtRiskKwh'] - L['eligibleOpportunityKwh'] - L['notEligibleKwh']) > tol:
        problems.append('predicted at risk != eligible + not eligible')
    if L['batteryDeliveredKwh'] > L['allocatedToChargersGridKwh'] + tol:
        problems.append('more energy delivered into batteries than drawn from the grid')
    efficiency = L.get('chargingEfficiency')
    if not isinstance(efficiency, (int, float)) or not 0 < efficiency <= 1:
        problems.append('charging efficiency must be in (0, 1]')
    if L.get('unit') != 'kWh':
        problems.append('ledger unit must be kWh')
    if shares is not None and abs(sum(shares.values()) - L['allocatedToChargersGridKwh']) > 1e-3:
        problems.append('per-vehicle opportunity allocations do not add up to the allocated energy')
    return problems


def summarize(plan, policy, slot, pools, issued_at, prediction, mode):
    issued = _parse(issued_at)
    vehicles, required, delivered = [], 0.0, 0.0
    for vehicle in plan.fleet['vehicles']:
        vid = vehicle['id']
        grid = sum(plan.alloc[vid].values())
        got = grid * plan.eff
        unmet = max(0.0, vehicle['requiredKwh'] - got)
        met = unmet <= 1e-6
        required += vehicle['requiredKwh']
        delivered += got
        vehicles.append(dict(
            id=vid, site=vehicle['site'], requiredKwh=r3(vehicle['requiredKwh']), deliveredKwh=r3(got),
            unmetKwh=r3(0 if met else unmet), met=met,
            arriveAt=(issued + timedelta(minutes=vehicle['arriveMin'])).isoformat(),
            departAt=(issued + timedelta(minutes=vehicle['departMin'])).isoformat(),
            schedule=[dict(slot=s, kw=r3(e / SLOT_HOURS), gridKwh=r3(e), inWindow=s == slot)
                      for s, e in sorted(plan.alloc[vid].items())],
            limitingReason=None if met else _limiting_reason(plan, vehicle)))
    in_window = window_energy(plan, slot)
    reachable = eligible_pools(plan.fleet, pools)
    claimed = attribute(plan.fleet, in_window, reachable)
    missed = [v for v in vehicles if not v['met']]
    limits = {}
    for v in missed:
        code = v['limitingReason']['code']
        limits[code] = limits.get(code, 0) + 1
    if plan.capped:
        limits['forecast-window'] = limits.get('forecast-window', 0) + 1
    limited_by = window_limits(plan, slot, pools, reachable, claimed)
    ledger = energy_ledger(prediction['atRiskMwh'] * 1000, sum(reachable.values()), sum(claimed.values()), plan.eff,
                           not_eligible_reasons(prediction, pools, reachable, mode), limited_by)
    grid_total = sum(sum(a.values()) for a in plan.alloc.values())
    sites = {v['id']: v['site'] for v in plan.fleet['vehicles']}
    return dict(
        policy=policy, description=POLICIES[policy],
        status='empty' if not vehicles else 'all-met' if not missed else 'partial',
        requiredKwh=r3(required), deliveredKwh=r3(delivered), gridKwh=r3(grid_total),
        unmetKwh=r3(max(0.0, required - delivered)), vehiclesMet=len(vehicles) - len(missed), vehiclesMissed=len(missed),
        window=dict(chargedKwh=r3(sum(in_window.values())), claimedKwh=r3(sum(claimed.values())),
                    claimedByComponent={k: r3(v) for k, v in claimed.items()}, limitedBy=limited_by),
        ledger=ledger,
        opportunityAllocations=None if plan.share is None else opportunity_allocations(plan, sites, ledger),
        bindingLimits=[dict(code=k, count=v) for k, v in sorted(limits.items(), key=lambda kv: (-kv[1], kv[0]))],
        siteLoad=[dict(site=s, slot=t, kw=r3(plan.energy[(s, t)] / SLOT_HOURS), chargersInUse=plan.chargers[(s, t)])
                  for s in sorted(plan.sites) for t in range(plan.slots) if plan.chargers[(s, t)]],
        vehicles=vehicles)


def apportion(values, total):
    """Round each value to 1 Wh so the rounded values add up exactly to round(total, 3) (largest remainder)."""
    wh = {k: v * 1000 for k, v in values.items()}
    floors = {k: math.floor(v + 1e-6) for k, v in wh.items()}
    spare = round(total * 1000) - sum(floors.values())
    for k in sorted(wh, key=lambda k: (-(wh[k] - floors[k]), k))[:max(0, spare)]:
        floors[k] += 1
    return {k: v / 1000 for k, v in floors.items()}


def opportunity_allocations(plan, sites, ledger):
    """Each vehicle's slice of the forecast opportunity: grid kWh in, battery kWh out, loss disclosed.
    The rows add up exactly to the ledger, so no Wh is lost or invented by rounding."""
    if abs(sum(plan.share.values()) - ledger['allocatedToChargersGridKwh']) > 1e-3:
        return []  # check_ledger reports the mismatch
    grid = apportion(plan.share, ledger['allocatedToChargersGridKwh'])
    battery = apportion({vid: kwh * plan.eff for vid, kwh in grid.items()}, ledger['batteryDeliveredKwh'])
    vehicles = {v['id']: v for v in plan.fleet['vehicles']}

    def limited_by(vid):
        """Why a vehicle got this much: its own charger rate, its own need, or the site's equal share."""
        share, vehicle = plan.share[vid], vehicles[vid]
        if share >= plan.rate(vehicle) * SLOT_HOURS - 1e-6:
            return 'charger-rate'
        if share >= vehicle['requiredKwh'] / plan.eff - 1e-6:
            return 'full'
        return 'equal-share'

    return [dict(vehicle=vid, site=sites[vid], gridKwh=grid[vid], batteryKwh=battery[vid], lossKwh=r3(grid[vid] - battery[vid]),
                 limitedBy=limited_by(vid), chargerKw=plan.rate(vehicles[vid]))
            for vid in sorted(grid)]


def rank(summary):
    """Lexicographic objective: most forecast window energy used, then fewest vehicles missing their
    deadline, then fewest missed kWh."""
    return -round(summary['window']['claimedKwh'], 6), summary['vehiclesMissed'], round(summary['unmetKwh'], 6)


def plan_alternative(fleet, prediction, mode, plan_start):
    check_prediction(prediction)
    slots = fleets.slot_count(fleet)
    slot = target_slot(plan_start, prediction['targetAt'])
    pools = eligibility.opportunity_pools(prediction, mode)
    results = {}
    for policy in POLICIES:
        plan = run_policy(fleet, slots, policy, slot, pools)
        problems = check_plan(plan)
        summary = summarize(plan, policy, slot, pools, plan_start, prediction, mode)
        problems += check_ledger(summary['ledger'], plan.share)
        if problems:  # a bug, never a user error: refuse rather than show an infeasible or unbalanced plan
            raise RuntimeError(f'{policy} produced an invalid plan: {problems[0]}')
        results[policy] = summary
    baseline, chosen = results[BASELINE], results[OPTIMIZED]
    if chosen['window']['claimedKwh'] < baseline['window']['claimedKwh'] - 1e-3:  # equal-share maximises it; else a bug
        raise RuntimeError('The optimized plan used less forecast energy than the baseline')
    start = _parse(plan_start) + timedelta(minutes=fleets.SLOT_MINUTES * slot)
    base_claim, opt_claim = baseline['window']['claimedKwh'], chosen['window']['claimedKwh']
    available = chosen['ledger']['eligibleOpportunityKwh']
    return dict(
        horizonMinutes=prediction['horizonMinutes'], targetAt=prediction['targetAt'], issuedAt=prediction['issuedAt'],
        window=dict(slot=slot, startAt=start.isoformat(), endAt=(start + timedelta(minutes=fleets.SLOT_MINUTES)).isoformat(),
                    intervalId=f'{start.isoformat()}/PT{fleets.SLOT_MINUTES}M', intervalLabel=INTERVAL_LABEL,
                    inPlan=0 <= slot < slots),
        opportunity=dict(
            mode=mode, availableKwh=r3(sum(pools.values())), eligibleKwh=available,
            componentsKwh={k: r3(v) for k, v in pools.items()},
            forecastAtRiskMwh=prediction['atRiskMwh'], forecastP10Mwh=prediction['lowerMwh'],
            forecastP90Mwh=prediction['upperMwh'], eventProbability=prediction['probability']),
        baseline=baseline, optimized=chosen,
        improvement=dict(
            claimedKwh=r3(opt_claim - base_claim),
            claimedPercent=None if base_claim <= EPS else r3((opt_claim - base_claim) / base_claim * 100),
            unmetKwh=r3(chosen['unmetKwh'] - baseline['unmetKwh']),
            windowShareOfOpportunity=None if available <= EPS else r3(opt_claim / available * 100),
            improved=opt_claim > base_claim + 1e-3))


def optimize(fleet, forecast, mode='expected', fixture=None):
    """One plan per forecast, from the same fleet and the same plan start; never summed.

    When both horizons forecast the same half-hour (the V1 dataset contract) they are two
    estimates of one window, and the plan follows the most recent one, like the scenario.
    Distinct targets are alternative windows and the best plan wins.
    """
    fleet = fleets.validate(fleet)
    predictions = sorted(forecast['predictions'], key=lambda p: p['horizonMinutes'])
    if not predictions:
        raise ForecastError('Forecast has no predictions')
    # Fleet times are minutes from the plan start: the earliest issue time, so both plans share the same fleet timeline.
    plan_start = min((p['issuedAt'] for p in predictions), key=_parse)
    alternatives = [plan_alternative(fleet, p, mode, plan_start) for p in predictions]
    shared = len({_parse(p['targetAt']) for p in predictions}) == 1
    if shared:
        best = alternatives[0]  # shortest horizon = most recent forecast of the same half-hour
    else:
        best = min(alternatives, key=lambda a: (rank(a['optimized']), a['horizonMinutes']))
    other = [a for a in alternatives if a is not best]
    reason = _selection_reason(best, other[0] if other else None, shared)
    identity = dict(fleet=fleet, mode=mode, predictions=predictions, solver=SOLVER_ID, label=INTERVAL_LABEL)
    simulated_forecast = forecast.get('dataMode') == 'simulated'
    result = dict(
        id=hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()[:12],
        solver=dict(id=SOLVER_ID, kind='deterministic max-min fair window allocation', externalDependencies=[]),
        fleet=dict(schemaVersion=fleet['schemaVersion'], fixture=fixture, provenance='simulated',
                   vehicles=len(fleet['vehicles']), sites=[dict(s, claims=eligibility.site_claims(s)) for s in fleet['sites']],
                   chargingEfficiency=fleet['chargingEfficiency'], planSlots=fleets.slot_count(fleet)),
        forecast=dict(planStartAt=plan_start, targetAt=forecast.get('targetAt'), pinnedTarget=forecast.get('pinnedTarget'),
                      horizonMinutes=best['horizonMinutes'], issuedAt=best['issuedAt'],
                      modelVersion=forecast.get('modelVersion'), source=forecast.get('source'),
                      dataMode=forecast.get('dataMode'), fallback=forecast.get('fallback'), stale=forecast.get('stale')),
        dataMode='simulated' if simulated_forecast else 'simulated-fleet-on-historical-forecast',
        status=('simulation on demo forecast' if simulated_forecast else 'simulation on historical forecast')
        + '; network eligibility unverified',
        networkEligibility=NETWORK_ELIGIBILITY, unit='kWh', intervalId=best['window']['intervalId'],
        selectedHorizonMinutes=best['horizonMinutes'], selectionReason=reason, alternatives=alternatives,
        selectionBasis='most-recent-forecast' if shared else 'best-plan', sharedTarget=shared,
        # The selected window's ledgers, for pages that only need the headline accounting.
        ledger=best['optimized']['ledger'], baselineLedger=best['baseline']['ledger'],
        assumptions=ASSUMPTIONS, limitations=LIMITATIONS)
    problems = check_result(result)
    if problems:
        raise RuntimeError(f'Optimizer result is incomplete: {problems[0]}')
    return result


def check_result(result):
    """Mandatory, self-consistent metadata on every result (issue #50)."""
    problems = []
    if result['dataMode'] not in ('simulated', 'simulated-fleet-on-historical-forecast'):
        problems.append('unknown dataMode')
    if result['networkEligibility'] != NETWORK_ELIGIBILITY or result['unit'] != 'kWh':
        problems.append('network eligibility and unit are mandatory')
    if not result['id'] or not result['intervalId'] or not result['forecast']['targetAt']:
        problems.append('scenario, interval and forecast ids are mandatory')
    if result['forecast']['dataMode'] == 'simulated' and result['dataMode'] != 'simulated':
        problems.append('a demo forecast must be labelled simulated')
    if result['ledger']['chargingEfficiency'] != result['fleet']['chargingEfficiency']:
        problems.append('ledger efficiency differs from the fleet')
    return problems


def _selection_reason(best, other, shared=False):
    opt, ledger = best['optimized'], best['optimized']['ledger']
    text = (f'+{best["horizonMinutes"]} min: {ledger["allocatedToChargersGridKwh"]:g} of '
            f'{ledger["eligibleOpportunityKwh"]:g} kWh eligible forecast energy shared between the plugged-in vehicles, '
            f'{opt["vehiclesMet"]} of {opt["vehiclesMet"] + opt["vehiclesMissed"]} vehicles fully charged.')
    if other is None:
        return text
    if shared:
        return text + (f' Planned on the most recent forecast; the +{other["horizonMinutes"]} min forecast is an earlier '
                       f'estimate of the same half-hour ({other["optimized"]["window"]["claimedKwh"]:g} kWh).')
    o = other['optimized']
    if rank(o) == rank(opt):
        return text + f' +{other["horizonMinutes"]} min gives the same result; the earlier window is preferred.'
    return text + f' +{other["horizonMinutes"]} min would use {opt["window"]["claimedKwh"] - o["window"]["claimedKwh"]:.1f} kWh less of its window.'


ASSUMPTIONS = [
    'The fleet is simulated: no real vehicles, chargers or telemetry.',
    f'A forecast target labels the half-hour starting at that time (interval label: {INTERVAL_LABEL}).',
    'Fleet times are minutes from the plan start: the earliest forecast issue time.',
    'Vehicles only charge in whole half-hours they are plugged in for: arrivals round up, departures round down.',
    'Charging rate is the lower of the vehicle and charger limits, drawn as constant power for the half-hour.',
    'Battery energy = grid energy x charging efficiency. Required kWh is energy into the battery; the difference is disclosed as charging loss.',
    'Each charger serves one vehicle per half-hour; the site power limit caps all its chargers together.',
    'The forecast window energy is shared equally between the vehicles plugged in for it (max-min fair): a vehicle only gets less than an equal share when it is full or at its charging rate, and the rest goes to the others.',
    'When a site has more such vehicles than chargers, the ones that can take the most energy are plugged in first, so as much of the opportunity as possible is used.',
    'When +30 and +60 forecast the same half-hour, they are two estimates of one window: the plan follows the most recent (+30 min). Never add them.',
    'Conservative mode scales the forecast down to its P10 quantity. P10 is a model estimate, not a guaranteed minimum.',
    'No physical storage battery is modelled: energy allocated to real storage is always 0.',
]
LIMITATIONS = [
    'Window energy is a projection: charging planned during forecast dispatch-down, not measured recovery of wasted energy.',
    'Network eligibility is unverified. A national forecast cannot show that a particular site can absorb constrained generation; constraint claims need a hypothetical site flag.',
    'Unallocated opportunity is forecast energy this fleet could not take, not measured grid waste.',
    'No charger is controlled. Plans are recommendations for review.',
]
