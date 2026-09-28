"""Deterministic, constraint-aware EV charging plans against a forecast opportunity window.

No language model is involved. Each plan assigns grid energy to (vehicle, half-hour)
pairs; every plan is checked against the hard constraints by check_plan() before it is
returned. See docs/CHARGING_OPTIMIZER.md.

Units: kW x 0.5 h = kWh; kWh / 1000 = MWh. Grid energy is what the charger draws;
battery energy = grid energy x charging efficiency.
"""
from datetime import datetime, timedelta
import hashlib
import json

import eligibility
import fleet as fleets

SLOT_HOURS = fleets.SLOT_MINUTES / 60
EPS = 1e-9
# GridToEv labels a half-hour by its END: the interval labelled T is the one completed at T
# (the model uses "the latest completed interval" at issue time as a feature and attaches
# every label to a strictly later target). So target T covers [T - 30 min, T).
# Documented in docs/CHARGING_OPTIMIZER.md; flip to 'start' if GridToEv confirms otherwise.
INTERVAL_LABEL = 'end'
SOLVER_ID = 'greedy-lexicographic-v1'
POLICIES = {
    'arrival-order': 'Charge on arrival, first come first served (baseline)',
    'deadline-first': 'Earliest departure first, chronologically',
    'opportunity-first': 'Fill the forecast window first, then earliest departure first',
}


def _parse(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00'))


def target_slot(issued_at, target_at, label=INTERVAL_LABEL):
    """Plan slot index of the forecast target half-hour."""
    minutes = (_parse(target_at) - _parse(issued_at)).total_seconds() / 60
    if minutes <= 0 or minutes % fleets.SLOT_MINUTES:
        raise ValueError('Target must be a whole number of half-hours after the issue time')
    index = int(minutes // fleets.SLOT_MINUTES)
    return index - 1 if label == 'end' else index


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
            energy, self.capped = limit, True
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
    elif policy == 'deadline-first':
        plan.chronological(deadline_order)
    elif policy == 'opportunity-first':
        if pools is not None and 0 <= slot < slots:
            candidates = [v for v in fleet['vehicles'] if eligibility.claimable_components(plan.sites[v['site']])]
            # Most urgent first, then the fastest chargers, so the window fills with energy that must move anyway.
            for vehicle in sorted(candidates, key=lambda v: (v['departMin'], -plan.rate(v), v['id'])):
                claimed = attribute(fleet, window_energy(plan, slot), pools)
                total_left = sum(pools.values()) - sum(claimed.values())
                zone = 'constraint' in eligibility.claimable_components(plan.sites[vehicle['site']])
                headroom = total_left if zone else pools['curtailment'] - claimed['curtailment']
                if headroom <= EPS:
                    plan.capped = True
                    continue
                plan.charge(vehicle, slot, limit=headroom)
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


def window_limits(plan, slot, pools, claimed):
    """What stopped each site charging more inside the forecast window."""
    if not 0 <= slot < plan.slots:
        return [dict(site=None, code='outside-plan', message='No vehicle is plugged in during the forecast window.')]
    if pools and sum(pools.values()) - sum(claimed.values()) <= 1e-6:
        return [dict(site=None, code='forecast-window', message='The fleet can take all the eligible forecast energy.')]
    limits = []
    for site in sorted(plan.sites.values(), key=lambda s: s['id']):
        key = (site['id'], slot)
        waiting = [v for v in plan.fleet['vehicles'] if v['site'] == site['id'] and slot in plan.available[v['id']]
                   and plan.alloc[v['id']].get(slot, 0) < plan.rate(v) * SLOT_HOURS - 1e-6
                   # it could have taken more here: energy is still unmet or was scheduled in another half-hour
                   and (plan.need[v['id']] > 1e-6 or sum(plan.alloc[v['id']].values()) > plan.alloc[v['id']].get(slot, 0) + 1e-6)]
        if not waiting:
            code, message = 'vehicles', f'{site["name"]}: every plugged-in vehicle is charging at full rate or already full.'
        elif plan.energy[key] >= site['sitePowerKw'] * SLOT_HOURS - 1e-6:
            code, message = 'site-power', f'{site["name"]}: at its {site["sitePowerKw"]:g} kW site limit.'
        elif plan.chargers[key] >= site['chargers']:
            code, message = 'chargers', f'{site["name"]}: all {site["chargers"]} chargers in use.'
        else:
            code, message = 'policy', f'{site["name"]}: this policy left capacity unused.'
        if not eligibility.claimable_components(site):
            message += ' Its charging is not claimed against the forecast.'
        limits.append(dict(site=site['id'], code=code, message=message))
    return limits


def summarize(plan, policy, slot, pools, issued_at):
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
    claimed = attribute(plan.fleet, in_window, pools) if pools else dict(constraint=0.0, curtailment=0.0)
    missed = [v for v in vehicles if not v['met']]
    limits = {}
    for v in missed:
        code = v['limitingReason']['code']
        limits[code] = limits.get(code, 0) + 1
    if plan.capped:
        limits['forecast-window'] = limits.get('forecast-window', 0) + 1
    grid_total = sum(sum(a.values()) for a in plan.alloc.values())
    return dict(
        policy=policy, description=POLICIES[policy],
        status='empty' if not vehicles else 'all-met' if not missed else 'partial',
        requiredKwh=r3(required), deliveredKwh=r3(delivered), gridKwh=r3(grid_total),
        unmetKwh=r3(max(0.0, required - delivered)), vehiclesMet=len(vehicles) - len(missed), vehiclesMissed=len(missed),
        window=dict(chargedKwh=r3(sum(in_window.values())), claimedKwh=r3(sum(claimed.values())),
                    claimedByComponent={k: r3(v) for k, v in claimed.items()},
                    limitedBy=window_limits(plan, slot, pools, claimed)),
        bindingLimits=[dict(code=k, count=v) for k, v in sorted(limits.items(), key=lambda kv: (-kv[1], kv[0]))],
        siteLoad=[dict(site=s, slot=t, kw=r3(plan.energy[(s, t)] / SLOT_HOURS), chargersInUse=plan.chargers[(s, t)])
                  for s in sorted(plan.sites) for t in range(plan.slots) if plan.chargers[(s, t)]],
        vehicles=vehicles)


def r3(value):
    return round(value + 0.0, 3)


def rank(summary):
    """Lexicographic objective: fewest vehicles missing their deadline, fewest missed kWh, then most claimed window energy."""
    return summary['vehiclesMissed'], round(summary['unmetKwh'], 6), -round(summary['window']['claimedKwh'], 6)


PREFERENCE = ('opportunity-first', 'deadline-first', 'arrival-order')  # tie-break between equal plans


def plan_alternative(fleet, prediction, mode):
    slots = fleets.slot_count(fleet)
    slot = target_slot(prediction['issuedAt'], prediction['targetAt'])
    pools = eligibility.opportunity_pools(prediction, mode)
    results = {}
    for policy in POLICIES:
        plan = run_policy(fleet, slots, policy, slot, pools)
        problems = check_plan(plan)
        if problems:  # a bug, never a user error: refuse rather than show an infeasible plan
            raise RuntimeError(f'{policy} produced an infeasible plan: {problems[0]}')
        results[policy] = summarize(plan, policy, slot, pools, prediction['issuedAt'])
    baseline = results['arrival-order']
    # The optimized plan is the best candidate; the baseline is a candidate too, so it is never worse.
    chosen = min(results.values(), key=lambda s: (rank(s), PREFERENCE.index(s['policy'])))
    issued = _parse(prediction['issuedAt'])
    start = issued + timedelta(minutes=fleets.SLOT_MINUTES * slot)
    base_claim, opt_claim = baseline['window']['claimedKwh'], chosen['window']['claimedKwh']
    available = sum(pools.values())
    return dict(
        horizonMinutes=prediction['horizonMinutes'], targetAt=prediction['targetAt'],
        window=dict(slot=slot, startAt=start.isoformat(), endAt=(start + timedelta(minutes=fleets.SLOT_MINUTES)).isoformat(),
                    intervalLabel=INTERVAL_LABEL, inPlan=0 <= slot < slots),
        opportunity=dict(
            mode=mode, availableKwh=r3(available), componentsKwh={k: r3(v) for k, v in pools.items()},
            forecastAtRiskMwh=prediction['atRiskMwh'], forecastP10Mwh=prediction['lowerMwh'],
            forecastP90Mwh=prediction['upperMwh'], eventProbability=prediction['probability']),
        baseline=baseline, optimized=chosen,
        candidates=[dict(policy=s['policy'], vehiclesMissed=s['vehiclesMissed'], unmetKwh=s['unmetKwh'],
                         claimedKwh=s['window']['claimedKwh'])
                    for s in results.values()],
        improvement=dict(
            claimedKwh=r3(opt_claim - base_claim),
            claimedPercent=None if base_claim <= EPS else r3((opt_claim - base_claim) / base_claim * 100),
            unmetKwh=r3(chosen['unmetKwh'] - baseline['unmetKwh']),
            windowShareOfOpportunity=None if available <= EPS else r3(opt_claim / available * 100),
            improved=rank(chosen) < rank(baseline)))


def optimize(fleet, forecast, mode='expected', fixture=None):
    """Plans for each forecast target as ALTERNATIVE uses of the same fleet; recoveries are never summed."""
    fleet = fleets.validate(fleet)
    predictions = sorted(forecast['predictions'], key=lambda p: p['horizonMinutes'])
    alternatives = [plan_alternative(fleet, p, mode) for p in predictions]
    best = min(alternatives, key=lambda a: (rank(a['optimized']), a['horizonMinutes']))
    other = [a for a in alternatives if a is not best]
    reason = _selection_reason(best, other[0] if other else None)
    identity = dict(fleet=fleet, mode=mode, predictions=predictions, solver=SOLVER_ID, label=INTERVAL_LABEL)
    return dict(
        id=hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()[:12],
        solver=dict(id=SOLVER_ID, kind='deterministic greedy with lexicographic selection', externalDependencies=[]),
        fleet=dict(schemaVersion=fleet['schemaVersion'], fixture=fixture, provenance='simulated',
                   vehicles=len(fleet['vehicles']), sites=[dict(s, claims=eligibility.site_claims(s)) for s in fleet['sites']],
                   chargingEfficiency=fleet['chargingEfficiency'], planSlots=fleets.slot_count(fleet)),
        forecast=dict(issuedAt=predictions[0]['issuedAt'] if predictions else None, modelVersion=forecast.get('modelVersion'),
                      source=forecast.get('source'), dataMode=forecast.get('dataMode'), fallback=forecast.get('fallback')),
        dataMode='simulated' if forecast.get('dataMode') == 'simulated' else 'simulated-fleet-on-historical-forecast',
        selectedHorizonMinutes=best['horizonMinutes'], selectionReason=reason, alternatives=alternatives,
        assumptions=ASSUMPTIONS, limitations=LIMITATIONS)


def _selection_reason(best, other):
    opt = best['optimized']
    text = (f'+{best["horizonMinutes"]} min: {opt["window"]["claimedKwh"]:g} kWh charged in the forecast window, '
            f'{opt["vehiclesMet"]} of {opt["vehiclesMet"] + opt["vehiclesMissed"]} vehicles fully charged.')
    if other is None:
        return text
    o = other['optimized']
    if rank(o) == rank(opt):
        return text + f' +{other["horizonMinutes"]} min gives the same result; the earlier window is preferred.'
    if o['unmetKwh'] > opt['unmetKwh'] + 1e-6:
        return text + f' +{other["horizonMinutes"]} min would leave {o["unmetKwh"] - opt["unmetKwh"]:.1f} kWh more demand unmet.'
    return text + f' +{other["horizonMinutes"]} min would use {opt["window"]["claimedKwh"] - o["window"]["claimedKwh"]:.1f} kWh less of its window.'


ASSUMPTIONS = [
    'The fleet is simulated: no real vehicles, chargers or telemetry.',
    f'A forecast target labels the half-hour ending at that time (interval label: {INTERVAL_LABEL}).',
    'Vehicles only charge in whole half-hours they are plugged in for: arrivals round up, departures round down.',
    'Charging rate is the lower of the vehicle and charger limits, drawn as constant power for the half-hour.',
    'Battery energy = grid energy x charging efficiency. Required kWh is energy into the battery.',
    'Each charger serves one vehicle per half-hour; the site power limit caps all its chargers together.',
    'The +30 and +60 minute targets are alternative plans for the same fleet from the same starting state. Never add them.',
    'Conservative mode scales the forecast down to its P10 quantity. P10 is a model estimate, not a guaranteed minimum.',
]
LIMITATIONS = [
    'Window energy is a projection: charging planned during forecast dispatch-down, not measured recovery of wasted energy.',
    'A national forecast cannot show that a particular site can absorb constrained generation; constraint claims need a hypothetical site flag and are never verified.',
    'No charger is controlled. Plans are recommendations for review.',
    'The solver is a deterministic heuristic, not a proven optimum; it never returns a plan that breaks a hard constraint.',
]
