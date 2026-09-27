"""Deterministic flexible charging scenarios; no vehicle scheduling is claimed."""
from datetime import datetime, timedelta
import hashlib
import json
import math

# Illustrative EV translation defaults: a typical top-up session and a public AC charger.
DEFAULT_KWH_PER_CHARGE = 30
DEFAULT_CHARGER_KW = 22


def validate_demand(total_kwh, flexible_kwh):
    for value in (total_kwh, flexible_kwh):
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 <= value <= 1e9:
            raise ValueError('Charging demand must be finite and between 0 and 1000000000 kWh.')
    if flexible_kwh > total_kwh:
        raise ValueError('Flexible demand cannot exceed total charging demand.')


def validate_ev(kwh_per_charge, charger_kw):
    for value, maximum, name in ((kwh_per_charge, 200, 'Energy per charge'), (charger_kw, 400, 'Charger power')):
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 1 <= value <= maximum:
            raise ValueError(f'{name} must be between 1 and {maximum}.')


def charging_window(target_at, interval_minutes):
    """The forecast target labels the start of its half-hour interval."""
    end = datetime.fromisoformat(target_at) + timedelta(minutes=interval_minutes)
    return dict(startAt=target_at, endAt=end.isoformat())


def build_scenario(forecast, total_kwh, flexible_kwh, kwh_per_charge=DEFAULT_KWH_PER_CHARGE, charger_kw=DEFAULT_CHARGER_KW):
    validate_demand(total_kwh, flexible_kwh)
    validate_ev(kwh_per_charge, charger_kw)
    total, flexible = total_kwh / 1000, flexible_kwh / 1000
    capacity = forecast['flexibleCapacityMw'] * forecast['intervalMinutes'] / 60
    outcomes = []
    for prediction in forecast['predictions']:
        at_risk = prediction['atRiskMwh']
        absorbed = min(at_risk, capacity, flexible)
        power_kw = absorbed / (forecast['intervalMinutes'] / 60) * 1000
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
            window=charging_window(prediction['targetAt'], forecast['intervalMinutes']),
            evChargesEquivalent=absorbed * 1000 / kwh_per_charge,
            chargersNeeded=math.ceil(round(power_kw / charger_kw, 9)),
        ))
    # Each outcome is an alternative use of the same demand, never an additive plan.
    best = max(outcomes, key=lambda item: (item['potentialRecoveryMwh'], -item['horizonMinutes']))
    identity = dict(capacityMw=forecast['flexibleCapacityMw'], totalDemandKwh=total_kwh,
                    flexibleDemandKwh=flexible_kwh, kwhPerCharge=kwh_per_charge, chargerKw=charger_kw,
                    predictions=forecast['predictions'])
    recommended = best if best['potentialRecoveryMwh'] > 0 else None
    scenario_id = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()[:12]
    return dict(
        id=scenario_id, dataMode='simulated' if forecast['dataMode'] == 'simulated' else 'derived-scenario',
        source=forecast['source'], totalDemandKwh=total_kwh,
        flexibleDemandKwh=flexible_kwh, totalDemandMwh=total, flexibleDemandMwh=flexible,
        recommendedHorizonMinutes=recommended and recommended['horizonMinutes'],
        recommendedWindow=recommended and dict(recommended['window'], horizonMinutes=recommended['horizonMinutes']),
        evAssumptions=dict(kwhPerCharge=kwh_per_charge, chargerKw=charger_kw),
        outcomes=outcomes, commitmentsMet=None, missedTargets=None, connectedEvs=None,
        methodology=[
            'Potential recovery is the minimum of predicted surplus, flexible demand and power capacity times 0.5 hours.',
            'The two horizons are alternative scenarios using the same demand. Do not add their recovery values.',
            'All entered flexible demand is assumed available at either forecast target; 100% charging efficiency is assumed.',
            'Remaining demand must be scheduled separately. Vehicle deadlines, battery targets and baseline schedules are not supplied.',
            f'EV charges = potential recovery in kWh / {kwh_per_charge:g} kWh per charge. This is an energy equivalent, not a count of connected vehicles.',
            f'Chargers needed = charging power in kW / {charger_kw:g} kW per charger, rounded up, to deliver the energy within the half-hour.',
            'The charging window starts at the forecast target time and lasts one half-hour interval.',
            'Results are projected from historical forecasts, not measured charging or emissions savings.',
        ],
    )
