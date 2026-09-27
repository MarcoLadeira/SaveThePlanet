"""Deterministic flexible charging scenarios; no vehicle scheduling is claimed."""
import hashlib
import json
import math

# Stated, labelled assumptions for derived impact values; never presented as measured.
GRID_INTENSITY_T_PER_MWH = 0.25  # approximate Irish grid average, ~250 gCO2/kWh
EV_KWH_PER_KM = 0.18  # typical passenger EV consumption


def validate_demand(total_kwh, flexible_kwh):
    for value in (total_kwh, flexible_kwh):
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 <= value <= 1e9:
            raise ValueError('Charging demand must be finite and between 0 and 1000000000 kWh.')
    if flexible_kwh > total_kwh:
        raise ValueError('Flexible demand cannot exceed total charging demand.')


def interval_outcome(prediction, capacity_mwh, interval_hours, total, flexible):
    """Scenario result for one half-hour: recovery is capped by surplus, capacity and flexible demand."""
    at_risk = prediction['atRiskMwh']
    absorbed = min(at_risk, capacity_mwh, flexible)
    return dict(
        horizonMinutes=prediction['horizonMinutes'], targetAt=prediction['targetAt'],
        atRiskMwh=at_risk, potentialRecoveryMwh=absorbed,
        remainingWasteMwh=max(0, at_risk - absorbed),
        avoidedEmissionsTco2=absorbed * GRID_INTENSITY_T_PER_MWH,
        evRangeKm=absorbed * 1000 / EV_KWH_PER_KM,
        recoveryRate=absorbed / at_risk if at_risk else None,
        cleanChargingShare=absorbed / total if total else None,
        remainingDemandMwh=max(0, total - absorbed),
        remainingFlexibleMwh=max(0, flexible - absorbed),
        proposedPowerMw=absorbed / interval_hours,
        capacityEnergyMwh=capacity_mwh,
        powerLimitRespected=absorbed <= capacity_mwh,
    )


def build_scenario(forecast, total_kwh, flexible_kwh):
    validate_demand(total_kwh, flexible_kwh)
    total, flexible = total_kwh / 1000, flexible_kwh / 1000
    hours = forecast['intervalMinutes'] / 60
    capacity = forecast['flexibleCapacityMw'] * hours
    outcomes = [interval_outcome(p, capacity, hours, total, flexible) for p in forecast['predictions']]
    # Each outcome is an alternative use of the same demand, never an additive plan.
    best = max(outcomes, key=lambda item: (item['potentialRecoveryMwh'], -item['horizonMinutes']))
    identity = dict(capacityMw=forecast['flexibleCapacityMw'], totalDemandKwh=total_kwh,
                    flexibleDemandKwh=flexible_kwh, predictions=forecast['predictions'])
    scenario_id = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()[:12]
    return dict(
        id=scenario_id, dataMode='simulated' if forecast['dataMode'] == 'simulated' else 'derived-scenario',
        source=forecast['source'], totalDemandKwh=total_kwh,
        flexibleDemandKwh=flexible_kwh, totalDemandMwh=total, flexibleDemandMwh=flexible,
        recommendedHorizonMinutes=best['horizonMinutes'] if best['potentialRecoveryMwh'] > 0 else None,
        assumptions=dict(gridIntensityTco2PerMwh=GRID_INTENSITY_T_PER_MWH, evKwhPerKm=EV_KWH_PER_KM),
        outcomes=outcomes, commitmentsMet=None, missedTargets=None, connectedEvs=None,
        methodology=[
            'Potential recovery is the minimum of predicted surplus, flexible demand and power capacity times 0.5 hours.',
            'The two horizons are alternative scenarios using the same demand. Do not add their recovery values.',
            'All entered flexible demand is assumed available at either forecast target; 100% charging efficiency is assumed.',
            'Remaining demand must be scheduled separately. Vehicle deadlines, battery targets and baseline schedules are not supplied.',
            f'Avoided emissions assume each recovered MWh displaces grid-average charging at {GRID_INTENSITY_T_PER_MWH:g} tCO2/MWh (derived estimate).',
            f'EV range equivalent assumes {EV_KWH_PER_KM:g} kWh/km; it is illustrative, not a vehicle count.',
            'Results are projected from historical forecasts, not measured charging or emissions savings.',
        ],
    )


DAY_FIELDS = ('targetAt', 'atRiskMwh', 'potentialRecoveryMwh', 'remainingWasteMwh', 'avoidedEmissionsTco2', 'evRangeKm')


def build_day(replay, total_kwh, flexible_kwh):
    """Apply the scenario to each non-overlapping half-hour of a historical day replay.

    Unlike the +30/+60 alternatives, these intervals are consecutive and distinct, so
    their recovery can be summed, under the stated assumption that the same demand
    is available again in every half-hour.
    """
    validate_demand(total_kwh, flexible_kwh)
    total, flexible = total_kwh / 1000, flexible_kwh / 1000
    hours = replay['intervalMinutes'] / 60
    capacity = replay['flexibleCapacityMw'] * hours
    intervals = [{k: v for k, v in interval_outcome(p, capacity, hours, total, flexible).items() if k in DAY_FIELDS}
                 for p in replay['predictions']]
    totals = {k: sum(i[k] for i in intervals) for k in DAY_FIELDS[1:]}
    return dict(
        date=replay['date'], range=replay['range'], source=replay['source'], dataMode='derived-scenario',
        modelVersion=replay['modelVersion'], intervalMinutes=replay['intervalMinutes'],
        horizonMinutes=replay['horizonMinutes'], flexibleCapacityMw=replay['flexibleCapacityMw'],
        totalDemandKwh=total_kwh, flexibleDemandKwh=flexible_kwh, intervals=intervals, totals=totals,
        assumptions=dict(gridIntensityTco2PerMwh=GRID_INTENSITY_T_PER_MWH, evKwhPerKm=EV_KWH_PER_KM),
        methodology=[
            'Each half-hour is a separate +30 minute historical forecast replayed from the GridToEv dataset; intervals do not overlap.',
            'The entered flexible demand is assumed to be available again in every half-hour, so daily totals are an upper-bound scenario.',
            'Potential recovery per half-hour is the minimum of predicted surplus, flexible demand and power capacity times 0.5 hours.',
            'Results are projected from historical forecasts, not measured charging or emissions savings.',
        ],
    )
