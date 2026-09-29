"""Simulated grid battery on the Dashboard's energy bridge: the ledger's "allocated to real storage" term.

It runs after the EV plan and takes only the eligible forecast energy the fleet could not, within its
power and capacity limits. optimizer.run_policy / check_plan (which the Impact page also uses) are not
changed; only the dashboard and Volt call attach().

Charge side only: the model forecasts one half-hour at a time, so when the stored energy is released
later is not modelled. The battery is simulated, like the fleet: no real storage asset is claimed.

Units: kW x 0.5 h = kWh. Grid draw is what the battery takes from the grid; stored = grid draw x
charge efficiency; the difference is conversion loss.
"""
import math

import fleet as fleets
import optimizer

SLOT_HOURS = fleets.SLOT_MINUTES / 60
TOLERANCE_KWH = 1e-6
# One default battery for every fleet preset, on its own grid connection at the site (so it does not
# share the chargers' site power limit). 10 MWh / 5 MW is a modest two-hour grid battery.
DEFAULT = dict(
    name='Grid battery (simulated)', provenance='simulated',
    capacityKwh=10_000.0, maxPowerKw=5_000.0, startFraction=0.4, chargeEfficiency=0.9,
)
ASSUMPTIONS = [
    'A simulated grid battery (10 MWh, 5 MW, 90% charge efficiency, starting 40% full) sits on its own grid '
    'connection at the fleet site. It takes only the eligible energy the EV fleet could not, after the EV plan.',
    'The battery starts each forecast half-hour from the same charge; the +30 and +60 min estimates are never chained.',
    'Charge side only: when the stored energy is released later is not modelled.',
    'The baseline (charge on arrival) comparison is EV charging only; the battery is the same in both.',
]


def r3(value):
    return optimizer.r3(value)


def floor3(value):
    """Round down to 1 Wh, so rounding never pushes the battery past a limit."""
    return math.floor(value * 1000 + 1e-9) / 1000


def charge(battery, offered_kwh):
    """How much of the offered grid energy the battery takes in one half-hour, and why it stops."""
    capacity, eff = battery['capacityKwh'], battery['chargeEfficiency']
    start = r3(capacity * battery['startFraction'])
    power_cap = battery['maxPowerKw'] * SLOT_HOURS  # grid kWh the connection allows in the half-hour
    room_cap = (capacity - start) / eff  # grid kWh that would fill it to 100%
    offered = max(0.0, offered_kwh)
    grid = floor3(min(offered, power_cap, room_cap))
    stored = min(r3(grid * eff), r3(capacity - start))
    end = r3(start + stored)
    if offered <= min(power_cap, room_cap) + TOLERANCE_KWH:
        limited = 'took-everything' if offered > 0 else 'nothing-offered'
    else:
        limited = 'power-limit' if power_cap <= room_cap else 'full'
    return dict(
        name=battery['name'], provenance=battery['provenance'], capacityKwh=capacity, maxPowerKw=battery['maxPowerKw'],
        chargeEfficiency=eff, startKwh=start, gridKwh=grid, storedKwh=stored, lossKwh=r3(grid - stored), endKwh=end,
        startFraction=round(start / capacity, 6), endFraction=round(end / capacity, 6), limitedBy=limited,
        powerUsedKw=r3(grid / SLOT_HOURS), releaseModelled=False)


def limit_reason(s):
    if s['limitedBy'] == 'power-limit':
        return dict(code='storage-power-limit', message=(
            f"The simulated grid battery charges at most {s['maxPowerKw']:,.0f} kW, "
            f"so it can take {s['gridKwh']:,.0f} kWh in this half-hour."))
    if s['limitedBy'] == 'full':
        return dict(code='storage-full', message='The simulated grid battery is full.')
    return None


def apply(ledger, battery=DEFAULT):
    """Fill the ledger's storage term from the energy the EVs left unallocated (in place)."""
    if ledger['allocatedToRealStorageKwh'] != 0:
        raise RuntimeError('Ledger already has storage allocated')
    s = charge(battery, ledger['unallocatedOpportunityKwh'])
    chargers, eligible = ledger['allocatedToChargersGridKwh'], ledger['eligibleOpportunityKwh']
    unallocated = r3(ledger['unallocatedOpportunityKwh'] - s['gridKwh'])
    reason = limit_reason(s)
    ledger.update(
        allocatedToRealStorageKwh=s['gridKwh'], unallocatedOpportunityKwh=unallocated,
        unallocatedReasons=(([reason] if reason else []) + ledger['unallocatedReasons']) if unallocated > 0 else [],
        storage=s,
        # utilizationFraction stays the EV chargers' share; this one includes the battery.
        usedWithStorageFraction=None if eligible <= 0 else round((chargers + s['gridKwh']) / eligible, 6),
        outcome=('no-opportunity' if eligible <= 0 else 'fully-allocated' if unallocated <= 0
                 else 'not-allocated' if chargers + s['gridKwh'] <= 0 else 'partially-allocated'))
    return ledger


def check_storage(ledger):
    """Every battery limit or conservation violation in a ledger with storage (empty when it holds)."""
    s, tol, problems = ledger.get('storage'), TOLERANCE_KWH, []
    if not s:
        return ['ledger has no storage record']
    for key in ('startKwh', 'gridKwh', 'storedKwh', 'lossKwh', 'endKwh'):
        if not isinstance(s[key], (int, float)) or not math.isfinite(s[key]) or s[key] < -tol:
            return [f'storage {key} must be a finite, non-negative number']
    if abs(s['gridKwh'] - ledger['allocatedToRealStorageKwh']) > tol:
        problems.append('storage grid draw != ledger storage allocation')
    if s['gridKwh'] > s['maxPowerKw'] * SLOT_HOURS + tol:
        problems.append('battery charged faster than its power limit')
    if s['endKwh'] > s['capacityKwh'] + tol:
        problems.append('battery filled past its capacity')
    if abs(s['gridKwh'] - s['storedKwh'] - s['lossKwh']) > tol:
        problems.append('storage grid draw != stored + loss')
    if s['storedKwh'] > s['gridKwh'] * s['chargeEfficiency'] + 1e-3:
        problems.append('more energy stored than the charge efficiency allows')
    if abs(s['startKwh'] + s['storedKwh'] - s['endKwh']) > tol:
        problems.append('battery end charge != start + stored')
    return problems


def attach(result, battery=DEFAULT):
    """Add the battery to every optimized ledger of an optimizer.optimize() result and re-check them.

    Baseline ledgers stay EV-only. result['ledger'] is the selected alternative's ledger object, so
    each distinct ledger is filled once.
    """
    ledgers = {id(a['optimized']['ledger']): a['optimized']['ledger'] for a in result['alternatives']}
    ledgers.setdefault(id(result['ledger']), result['ledger'])
    for ledger in ledgers.values():
        apply(ledger, battery)
        problems = optimizer.check_ledger(ledger) + check_storage(ledger)
        if problems:
            raise RuntimeError(f'Grid battery broke the ledger: {problems[0]}')
    result['gridBattery'] = dict(battery)
    result['assumptions'] = [a for a in result['assumptions'] if not a.startswith('No physical storage')] + ASSUMPTIONS
    return result
