"""Versioned, synthetic demo fixture. No network, randomness or wall-clock labels."""


def demo_payload(capacity):
    rows = []
    # horizon, target, probability, total, curtailment, constraint, P10, P50, P90
    for horizon, target, probability, total, curtailed, constrained, low, median, high in (
        (30, '12:30', .65, .35, .10, .25, .15, .32, .55),
        (60, '13:00', .85, .80, .20, .60, .40, .75, 1.10),
    ):
        rows.append(dict(
            model_version='demo-fixture-v1', issue_timestamp_utc='2026-01-31T12:00:00Z',
            target_timestamp_utc=f'2026-01-31T{target}:00Z', forecast_horizon_minutes=horizon,
            dispatch_down_probability=probability, risk_level='high' if probability >= .7 else 'medium',
            predicted_dispatch_down_mwh=total, predicted_curtailment_mwh=curtailed,
            predicted_constraint_mwh=constrained, prediction_interval_p10_mwh=low,
            prediction_interval_p50_mwh=median, prediction_interval_p90_mwh=high,
            flexible_load_capacity_mw=capacity, recoverable_surplus_mwh=min(total, capacity * .5),
        ))
    return {'predictions': rows}
