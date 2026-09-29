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

The plan follows the model's point forecast, like the Dashboard. That point is the model's trend
blend (GridToEv V1 serves it with an ML weight of 0), so it reads 0 MWh whenever the latest
observation did, even when the event classifier gives dispatch-down a ~100% chance and the quantile
regressors a median of several MWh. Each half-hour therefore also carries an `expected` outcome that
uses the whole forecast: the same optimizer and battery ledger run on the P10, P50 and P90 scenarios,
combined with Swanson's 30/40/30 rule and weighted by the event probability. It is a readout beside
the plan, never the plan itself (see docs/CHARGING_OPTIMIZER.md, Uncertainty).
"""
from datetime import timedelta

import fleet as fleets
import optimizer
import storage
from scenario import EV_KWH_PER_KM, GRID_INTENSITY_T_PER_MWH

VERSION = 'day-plan/v1'
PLAN_LEAD_MINUTES = 60  # the Dashboard plans from the +60 min issue time (its earliest forecast)
KG_PER_KWH = GRID_INTENSITY_T_PER_MWH  # 0.25 t/MWh is 0.25 kg/kWh
# Swanson's rule: the mean of a forecast approximated from its P10, P50 and P90 at weights 0.3/0.4/0.3.
SWANSON = (('lowerMwh', .3), ('medianMwh', .4), ('upperMwh', .3))
# Potential full EV charges (issue #80, reusing #49's reference): energy at risk delivered into an
# illustrative 70 kWh battery from 0 to 100%, after the fleet's charging efficiency. 70 kWh is a round
# figure close to the average pack of battery-electric cars sold in the EU in 2025 (IEA Global EV Outlook
# 2026), not an Irish fleet figure. It is an energy equivalent, not a count of cars actually charged.
REFERENCE_BATTERY_KWH = 70
EXPECTED_FIELDS = ('capturedKwh', 'evGridKwh', 'evBatteryKwh', 'storageGridKwh', 'storedKwh', 'co2AvoidedKg', 'evRangeKm')
r3 = optimizer.r3


def plan_start(prediction):
    return (optimizer._parse(prediction['targetAt']) - timedelta(minutes=PLAN_LEAD_MINUTES)).isoformat()


def plan(fleet, prediction, mode, battery):
    """The Dashboard's plan and checked energy ledger (EV fleet, then grid battery) for one forecast."""
    alt = optimizer.plan_alternative(fleet, prediction, mode, plan_start(prediction))
    ledger = storage.apply(alt['optimized']['ledger'], battery)
    problems = optimizer.check_ledger(ledger) + storage.check_storage(ledger)
    if problems:
        raise RuntimeError(f'Day plan broke the ledger at {prediction["targetAt"]}: {problems[0]}')
    return alt, ledger


def outcome(ledger):
    """The energy one plan captures (kWh, grid-side unless named) and what it is worth."""
    s, ev_grid = ledger['storage'], ledger['allocatedToChargersGridKwh']
    return dict(
        capturedKwh=r3(ev_grid + s['gridKwh']), evGridKwh=ev_grid, evBatteryKwh=ledger['batteryDeliveredKwh'],
        storageGridKwh=s['gridKwh'], storedKwh=s['storedKwh'],
        # EVs displace grid charging they would have drawn anyway; the battery only what it stores.
        co2AvoidedKg=r3((ev_grid + s['storedKwh']) * KG_PER_KWH), evRangeKm=r3(ledger['batteryDeliveredKwh'] / EV_KWH_PER_KM))


def curtailment_share(predictions):
    """The day's curtailment share of forecast dispatch-down: the split for a half-hour whose point forecast is 0."""
    total = sum(p['atRiskMwh'] for p in predictions)
    return sum(p['curtailmentMwh'] for p in predictions) / total if total > 0 else 0.0


def scenario(prediction, total_mwh, day_share):
    """The same forecast with total_mwh at risk, split like its point forecast (or like the day, when that is 0)."""
    share = prediction['curtailmentMwh'] / prediction['atRiskMwh'] if prediction['atRiskMwh'] > 0 else day_share
    curtailment = total_mwh * share
    return {**prediction, 'atRiskMwh': total_mwh, 'curtailmentMwh': curtailment, 'constraintMwh': total_mwh - curtailment}


def expected(fleet, prediction, day_share, battery, point=None):
    """Probability-weighted outcome over the model's P10/P50/P90 scenarios, each planned like the point forecast.

    expected = P(dispatch-down) x (0.3 g(P10) + 0.4 g(P50) + 0.3 g(P90)), where g is the plan's outcome.
    The probability gates the range because the served P10-P90 interval is widened by a fixed amount
    even when no dispatch-down is expected; where both are uncertain this errs low. The captured share
    is only given when dispatch-down is more likely than not: otherwise both expectations are slivers of
    a likely zero and their ratio is noise. point: the outcome already planned on the point forecast,
    reused when a quantile equals it.
    """
    p, runs = prediction['probability'], {} if point is None else {prediction['atRiskMwh']: point}
    totals = dict.fromkeys(EXPECTED_FIELDS, 0.0)
    for field, weight in SWANSON:
        q = prediction[field]
        if p <= 0 or q <= 0:  # nothing at risk captures nothing
            continue
        if q not in runs:
            runs[q] = outcome(plan(fleet, scenario(prediction, q, day_share), 'expected', battery)[1])
        for key in EXPECTED_FIELDS:
            totals[key] += p * weight * runs[q][key]
    at_risk = p * sum(weight * prediction[field] for field, weight in SWANSON) * 1000
    return dict({key: r3(value) for key, value in totals.items()}, atRiskKwh=r3(at_risk),
                capturedShare=None if at_risk <= 0 or p < .5 else round(min(1.0, totals['capturedKwh'] / at_risk), 6))


def full_charges(at_risk_kwh, efficiency):
    """Full 70 kWh EV charges the energy at risk could give, after charging losses (applied once)."""
    return r3(max(0.0, at_risk_kwh) * efficiency / REFERENCE_BATTERY_KWH)


def interval(fleet, prediction, mode='expected', battery=storage.DEFAULT, day_share=0.0):
    """The Dashboard's plan for one half-hour, trimmed to what the day charts need (kWh, grid-side)."""
    alt, ledger = plan(fleet, prediction, mode, battery)
    s, at_risk_kwh, planned = ledger['storage'], ledger['predictedAtRiskKwh'], outcome(ledger)
    return dict(
        targetAt=prediction['targetAt'], probability=prediction.get('probability'), risk=prediction.get('risk'),
        atRiskMwh=prediction['atRiskMwh'], atRiskKwh=at_risk_kwh, eligibleKwh=ledger['eligibleOpportunityKwh'],
        lowerMwh=prediction['lowerMwh'], medianMwh=prediction['medianMwh'], upperMwh=prediction['upperMwh'],
        carsCharged=len(alt['optimized']['opportunityAllocations'] or []),
        potentialFullCharges=full_charges(at_risk_kwh, fleet['chargingEfficiency']),
        storageStartFraction=s['startFraction'], storageEndFraction=s['endFraction'], storageLimitedBy=s['limitedBy'],
        **planned, notCapturedKwh=r3(max(0.0, at_risk_kwh - planned['capturedKwh'])),
        capturedShare=None if at_risk_kwh <= 0 else round(planned['capturedKwh'] / at_risk_kwh, 6),
        expected=expected(fleet, prediction, day_share, battery, planned if mode == 'expected' else None))


def build(replay, fleet, preset_id, mode='expected', battery=storage.DEFAULT):
    fleet = fleets.validate(fleet)
    day_share = curtailment_share(replay['predictions'])
    intervals = [interval(fleet, p, mode, battery, day_share) for p in replay['predictions']]
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
        # Energy at risk is additive across the day's distinct half-hours, so its full-charge equivalent is too.
        totals=dict(atRiskMwh=sum(i['atRiskMwh'] for i in intervals),
                    potentialFullCharges=r3(sum(i['potentialFullCharges'] for i in intervals))),
        evEquivalent=dict(referenceBatteryKwh=REFERENCE_BATTERY_KWH, chargingEfficiency=fleet['chargingEfficiency'],
                          basis='energy at risk (forecast), grid-side, times charging efficiency'),
        methodology=[
            'Each half-hour is a separate +30 minute historical forecast replayed from the GridToEv dataset; intervals do not overlap.',
            (f'Potential full EV charges = energy at risk (kWh) x {fleet["chargingEfficiency"]:.0%} charging efficiency / '
             f'{REFERENCE_BATTERY_KWH} kWh reference battery (0-100%). Energy at risk is additive across the day, so the '
             'day total is the sum of its half-hours. An energy equivalent if all of it reached EVs, not cars actually charged.'),
            'For each half-hour: the Dashboard plan if charging were planned for that half-hour, with the same simulated fleet '
            'and grid battery (same optimizer and energy ledger as the Dashboard).',
            'The fleet and battery are the same in every half-hour, so recovered energy is a what-if per half-hour and is never added up across the day.',
            f'Estimated CO2 avoided = (EV charging + energy stored in the battery) x {GRID_INTENSITY_T_PER_MWH:g} kg/kWh of grid-average electricity displaced.',
            f'EV range = energy into EV batteries / {EV_KWH_PER_KM:g} kWh per km; illustrative.',
            'The plan follows the point forecast, the model\'s trend blend. "Expected" re-runs the same plan on the model\'s '
            'P10, P50 and P90 scenarios, combines them 30/40/30 (Swanson\'s rule) and multiplies by the dispatch-down '
            'event probability, so it also uses the event classifier and quantile regressors.',
            'A scenario keeps its point forecast\'s curtailment/constraint split, or the day\'s split when the point forecast is 0.',
            'Results are projected from historical forecasts on a simulated fleet and battery, not measured charging or emissions savings.',
        ])
