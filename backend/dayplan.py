"""The Dashboard's fleet + grid battery plan, repeated for each half-hour of a replayed day.

For every +30 minute forecast of the day, this asks: "if charging were planned for this half-hour,
what would the Dashboard show?" It runs the same optimizer.plan_alternative() and storage.apply()
as POST /api/v1/charging/optimize, with the same plan start (one hour before the target, where the
+60 min forecast is issued), so the selected half-hour on the Battery and EV pages matches the
Dashboard's +30 min plan exactly.

Each half-hour is a separate what-if with the same simulated fleet and the same battery starting
charge, so recovered energy is NOT added up across the day: that would charge the same cars and
fill the same battery 48 times. Energy at risk is additive (48 distinct, non-overlapping forecasts)
and is the only day total returned.
"""
from datetime import timedelta

import fleet as fleets
import optimizer
import storage
from scenario import EV_KWH_PER_KM, GRID_INTENSITY_T_PER_MWH

VERSION = 'day-plan/v1'
PLAN_LEAD_MINUTES = 60  # the Dashboard plans from the +60 min issue time (its earliest forecast)
KG_PER_KWH = GRID_INTENSITY_T_PER_MWH  # 0.25 t/MWh is 0.25 kg/kWh
r3 = optimizer.r3


def plan_start(prediction):
    return (optimizer._parse(prediction['targetAt']) - timedelta(minutes=PLAN_LEAD_MINUTES)).isoformat()


def interval(fleet, prediction, mode='expected', battery=storage.DEFAULT):
    """The Dashboard's plan for one half-hour, trimmed to what the day charts need (kWh, grid-side)."""
    alt = optimizer.plan_alternative(fleet, prediction, mode, plan_start(prediction))
    ledger = storage.apply(alt['optimized']['ledger'], battery)
    problems = optimizer.check_ledger(ledger) + storage.check_storage(ledger)
    if problems:
        raise RuntimeError(f'Day plan broke the ledger at {prediction["targetAt"]}: {problems[0]}')
    s, at_risk_kwh = ledger['storage'], ledger['predictedAtRiskKwh']
    ev_grid, stored = ledger['allocatedToChargersGridKwh'], s['storedKwh']
    captured = r3(ev_grid + s['gridKwh'])
    return dict(
        targetAt=prediction['targetAt'], probability=prediction.get('probability'),
        atRiskMwh=prediction['atRiskMwh'], atRiskKwh=at_risk_kwh, eligibleKwh=ledger['eligibleOpportunityKwh'],
        evGridKwh=ev_grid, evBatteryKwh=ledger['batteryDeliveredKwh'],
        carsCharged=len(alt['optimized']['opportunityAllocations'] or []),
        storageGridKwh=s['gridKwh'], storedKwh=stored, storageStartFraction=s['startFraction'],
        storageEndFraction=s['endFraction'], storageLimitedBy=s['limitedBy'],
        capturedKwh=captured, notCapturedKwh=r3(max(0.0, at_risk_kwh - captured)),
        capturedShare=None if at_risk_kwh <= 0 else round(captured / at_risk_kwh, 6),
        # EVs displace grid charging they would have drawn anyway; the battery only what it stores.
        co2AvoidedKg=r3((ev_grid + stored) * KG_PER_KWH), evRangeKm=r3(ledger['batteryDeliveredKwh'] / EV_KWH_PER_KM))


def build(replay, fleet, preset_id, mode='expected', battery=storage.DEFAULT):
    fleet = fleets.validate(fleet)
    intervals = [interval(fleet, p, mode, battery) for p in replay['predictions']]
    return dict(
        version=VERSION, date=replay['date'], range=replay['range'], source=replay['source'],
        dataMode='simulated' if replay.get('dataMode') == 'simulated' else 'simulated-fleet-on-historical-forecast',
        modelVersion=replay['modelVersion'], intervalMinutes=replay['intervalMinutes'], horizonMinutes=replay['horizonMinutes'],
        flexibleCapacityMw=replay['flexibleCapacityMw'], additive=False,
        fleet=dict(preset=preset_id, provenance='simulated', vehicles=len(fleet['vehicles']), sites=len(fleet['sites']),
                   requiredKwh=r3(sum(v['requiredKwh'] for v in fleet['vehicles'])), chargingEfficiency=fleet['chargingEfficiency']),
        gridBattery=dict(battery),
        intervals=intervals,
        # Only the forecast energy is summed; recovery per half-hour is a what-if (see module docstring).
        totals=dict(atRiskMwh=sum(i['atRiskMwh'] for i in intervals)),
        methodology=[
            'Each half-hour is a separate +30 minute historical forecast replayed from the GridToEv dataset; intervals do not overlap.',
            'For each half-hour: the Dashboard plan if charging were planned for that half-hour, with the same simulated fleet '
            'and grid battery (same optimizer and energy ledger as the Dashboard).',
            'The fleet and battery are the same in every half-hour, so recovered energy is a what-if per half-hour and is never added up across the day.',
            f'Estimated CO2 avoided = (EV charging + energy stored in the battery) x {GRID_INTENSITY_T_PER_MWH:g} kg/kWh of grid-average electricity displaced.',
            f'EV range = energy into EV batteries / {EV_KWH_PER_KM:g} kWh per km; illustrative.',
            'Results are projected from historical forecasts on a simulated fleet and battery, not measured charging or emissions savings.',
        ])
