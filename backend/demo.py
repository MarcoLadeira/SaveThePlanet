"""Synthetic demo data. Without a clock it is the fixed, versioned example;
with one it follows the clock so the dashboard updates in real time.

Like the model path, both horizons forecast the same target half-hour, each
from its own issue time (target - 30 min and target - 60 min)."""
from datetime import datetime, timedelta, timezone
import math

FIXED_TARGET = '2026-01-31T13:00:00Z'
FIXED = (
    # horizon, issued, probability, total, curtailment, constraint, P10, P50, P90
    (30, '12:30', .65, .35, .10, .25, .15, .32, .55),
    (60, '12:00', .85, .80, .20, .60, .40, .75, 1.10),
)
LIVE_STEP_SECONDS = 15


def row(capacity, version, issued, target, horizon, probability, total, curtailed, constrained, low, median, high):
    return dict(
        model_version=version, issue_timestamp_utc=issued, target_timestamp_utc=target,
        forecast_horizon_minutes=horizon, dispatch_down_probability=probability,
        risk_level='high' if probability >= .7 else 'medium' if probability >= .4 else 'low',
        predicted_dispatch_down_mwh=total, predicted_curtailment_mwh=curtailed,
        predicted_constraint_mwh=constrained, prediction_interval_p10_mwh=low,
        prediction_interval_p50_mwh=median, prediction_interval_p90_mwh=high,
        flexible_load_capacity_mw=capacity, recoverable_surplus_mwh=min(total, capacity * .5),
    )


def live_energy(at):
    hours = at.hour + at.minute / 60 + at.second / 3600
    value = (.5 + .28 * math.sin(2 * math.pi * (hours - 5) / 24)
             + .1 * math.sin(2 * math.pi * hours / .78 + 1.1)
             + .05 * math.sin(2 * math.pi * hours / .12 + .4))
    return round(max(.08, value), 2)


def demo_day_rows(capacity, day):
    """48 synthetic +30 minute predictions across one UTC day, shaped like the model's window replay."""
    start = datetime(day.year, day.month, day.day, tzinfo=timezone.utc)
    scale = .75 + .5 * ((day.toordinal() * 37) % 11) / 10
    rows = []
    for step in range(48):
        issued = start + timedelta(minutes=30 * step)
        target = issued + timedelta(minutes=30)
        total = round(max(.05, live_energy(target) * scale), 2)
        curtailed = round(total * (.3 + .08 * math.sin(target.hour / 3)), 2)
        rows.append(row(capacity, 'demo-live-v1', issued.isoformat(), target.isoformat(), 30,
                        round(min(.95, .3 + .55 * total), 2), total, curtailed, round(total - curtailed, 2),
                        round(total * .55, 2), round(total * .92, 2), round(total * 1.35, 2)))
    return rows


def demo_payload(capacity, now=None):
    if now is None:
        return {'predictions': [
            row(capacity, 'demo-fixture-v1', f'2026-01-31T{issued}:00Z', FIXED_TARGET, horizon,
                probability, total, curtailed, constrained, low, median, high)
            for horizon, issued, probability, total, curtailed, constrained, low, median, high in FIXED
        ]}
    step = now.replace(microsecond=0) - timedelta(seconds=now.second % LIVE_STEP_SECONDS)
    target = step + timedelta(minutes=30)
    rows = []
    for horizon in (30, 60):
        issued = target - timedelta(minutes=horizon)
        # The longer horizon is a little less certain about the same target.
        total = round(live_energy(target) * (1 if horizon == 30 else 1.12), 2)
        curtailed = round(total * (.3 + .08 * math.sin(target.hour / 3)), 2)
        rows.append(row(capacity, 'demo-live-v1', issued.isoformat(), target.isoformat(), horizon,
                        round(min(.95, .3 + .55 * total), 2), total, curtailed, round(total - curtailed, 2),
                        round(total * .55, 2), round(total * .92, 2), round(total * 1.35, 2)))
    return {'predictions': rows}
