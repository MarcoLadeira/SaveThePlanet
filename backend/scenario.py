"""Deterministic flexible charging scenarios; no vehicle scheduling is claimed."""
import hashlib
import json
import math


def validate_demand(total_kwh, flexible_kwh):
    for value in (total_kwh, flexible_kwh):
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 <= value <= 1e9:
            raise ValueError('Charging demand must be finite and between 0 and 1000000000 kWh.')
    if flexible_kwh > total_kwh:
        raise ValueError('Flexible demand cannot exceed total charging demand.')


def build_scenario(forecast, total_kwh, flexible_kwh):
    validate_demand(total_kwh, flexible_kwh)
    total, flexible = total_kwh / 1000, flexible_kwh / 1000
    capacity = forecast['flexibleCapacityMw'] * forecast['intervalMinutes'] / 60
    outcomes = []
    for prediction in forecast['predictions']:
        at_risk = prediction['atRiskMwh']
        absorbed = min(at_risk, capacity, flexible)
        outcomes.append(dict(
            horizonMinutes=prediction['horizonMinutes'], targetAt=prediction['targetAt'],
            atRiskMwh=at_risk, potentialRecoveryMwh=absorbed,
            remainingWasteMwh=max(0, at_risk - absorbed),
            recoveryRate=absorbed / at_risk if at_risk else None,
            cleanChargingShare=absorbed / total if total else None,
            remainingDemandMwh=max(0, total - absorbed),
            remainingFlexibleMwh=max(0, flexible - absorbed),
            proposedPowerMw=absorbed / (forecast['intervalMinutes'] / 60),
            capacityEnergyMwh=capacity,
            powerLimitRespected=absorbed <= capacity,
        ))
    # Each outcome is an alternative use of the same demand, never an additive plan.
    best = max(outcomes, key=lambda item: (item['potentialRecoveryMwh'], -item['horizonMinutes']))
    identity = dict(capacityMw=forecast['flexibleCapacityMw'], totalDemandKwh=total_kwh,
                    flexibleDemandKwh=flexible_kwh, predictions=forecast['predictions'])
    scenario_id = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()[:12]
    return dict(
        id=scenario_id, dataMode='derived-scenario', totalDemandKwh=total_kwh,
        flexibleDemandKwh=flexible_kwh, totalDemandMwh=total, flexibleDemandMwh=flexible,
        recommendedHorizonMinutes=best['horizonMinutes'] if best['potentialRecoveryMwh'] > 0 else None,
        outcomes=outcomes, commitmentsMet=None, missedTargets=None, connectedEvs=None,
        methodology=[
            'Potential recovery is the minimum of predicted surplus, flexible demand and power capacity times 0.5 hours.',
            'The two horizons are alternative scenarios using the same demand. Do not add their recovery values.',
            'All entered flexible demand is assumed available at either forecast target; 100% charging efficiency is assumed.',
            'Remaining demand must be scheduled separately. Vehicle deadlines, battery targets and baseline schedules are not supplied.',
            'Results are projected from historical forecasts, not measured charging or emissions savings.',
        ],
    )
