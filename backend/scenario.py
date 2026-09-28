"""Deterministic flexible charging scenarios; no vehicle scheduling is claimed."""
import hashlib
import json
import math

# Stated, labelled assumptions for derived impact values; never presented as measured.
GRID_INTENSITY_T_PER_MWH = 0.25  # approximate Irish grid average, ~250 gCO2/kWh
EV_KWH_PER_KM = 0.18  # typical passenger EV consumption
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


def ev_translation(outcome, interval_minutes, kwh_per_charge, charger_kw):
    """Two separate, conditional readings of the same potential recovery.

    - evChargesEquivalent: recovered kWh expressed as charging sessions of kwh_per_charge.
      An energy comparison only; it does not say those sessions fit in the interval.
    - minConcurrentPorts: the fewest ports that could draw the recovered energy within the
      interval at continuous rated power, with 100% efficiency and a vehicle accepting power
      on every port. A theoretical minimum, not a dispatchable plan.
    """
    hours = interval_minutes / 60
    recovered_kwh = outcome['potentialRecoveryMwh'] * 1000
    ports = math.ceil(round(recovered_kwh / (charger_kw * hours), 9))
    return dict(evChargesEquivalent=recovered_kwh / kwh_per_charge,
                minConcurrentPorts=ports,
                portKwhLimit=charger_kw * hours,
                kwhPerPort=recovered_kwh / ports if ports else 0)


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


def build_scenario(forecast, total_kwh, flexible_kwh, kwh_per_charge=DEFAULT_KWH_PER_CHARGE, charger_kw=DEFAULT_CHARGER_KW):
    validate_demand(total_kwh, flexible_kwh)
    validate_ev(kwh_per_charge, charger_kw)
    total, flexible = total_kwh / 1000, flexible_kwh / 1000
    hours = forecast['intervalMinutes'] / 60
    capacity = forecast['flexibleCapacityMw'] * hours
    outcomes = [interval_outcome(p, capacity, hours, total, flexible) for p in forecast['predictions']]
    for outcome in outcomes:
        outcome.update(ev_translation(outcome, forecast['intervalMinutes'], kwh_per_charge, charger_kw))
    # Each outcome is an alternative use of the same demand, never an additive plan.
    shared_target = len({p['targetAt'] for p in forecast['predictions']}) == 1
    if shared_target:
        # Two forecast vintages of ONE half-hour, not two charging windows. Picking the larger
        # estimate would cherry-pick the more optimistic forecast, so plan on the most recent
        # vintage (+30 min, issued closest to the target).
        best = min(outcomes, key=lambda item: item['horizonMinutes'])
    else:
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
        evAssumptions=dict(kwhPerCharge=kwh_per_charge, chargerKw=charger_kw),
        sharedTarget=shared_target,
        recommendationBasis='most-recent-forecast' if shared_target else 'greatest-recovery',
        assumptions=dict(gridIntensityTco2PerMwh=GRID_INTENSITY_T_PER_MWH, evKwhPerKm=EV_KWH_PER_KM),
        outcomes=outcomes, commitmentsMet=None, missedTargets=None, connectedEvs=None,
        methodology=[
            'Potential recovery is the minimum of predicted surplus, flexible demand and power capacity times 0.5 hours.',
            ('Both horizons forecast the same half-hour from different issue times (+30 and +60 minutes before it): '
             'they are two estimates of one charging window, not two windows. The plan uses the most recent (+30 min) '
             'forecast rather than the larger estimate. Never add them.') if shared_target else
            'The two horizons are alternative scenarios using the same demand. Do not add their recovery values.',
            'All entered flexible demand is assumed available at either forecast target; 100% charging efficiency is assumed.',
            'Remaining demand must be scheduled separately. Vehicle deadlines, battery targets and baseline schedules are not supplied.',
            f'Avoided emissions assume each recovered MWh displaces grid-average charging at {GRID_INTENSITY_T_PER_MWH:g} tCO2/MWh (derived estimate).',
            f'EV range equivalent assumes {EV_KWH_PER_KM:g} kWh/km; it is illustrative, not a vehicle count.',
            f'EV charges = potential recovery in kWh / {kwh_per_charge:g} kWh per charge. This is an energy equivalent, not a count of connected vehicles.',
            f'Minimum ports = recovered kWh / ({charger_kw:g} kW x 0.5 h), rounded up: the fewest {charger_kw:g} kW ports that could draw it within the half-hour at continuous rated power, with a vehicle accepting power on every port and 100% efficiency. Each port then delivers at most {charger_kw * 0.5:g} kWh, so this is not the same as the charge-equivalent count.',
            'Upper-bound estimate: connected vehicles, available ports, onboard charger limits, conversion losses and local grid deliverability are not modelled.',
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
    intervals = [dict({k: v for k, v in interval_outcome(p, capacity, hours, total, flexible).items() if k in DAY_FIELDS},
                      probability=p.get('probability'))
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
