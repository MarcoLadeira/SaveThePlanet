"""Dashboard headline: the daily model (V2) for the dashboard's day.

The dashboard's target half-hour (targets.py) sits on a day EirGrid recorded curtailment on. This
module answers, for that whole UTC day: V2's chance of curtailment and predicted MWh, the
experimental wind/solar split of that prediction (sources.py), and what EirGrid recorded (total,
and wind vs solar). The battery and EV cards keep planning the one V1 half-hour, as before.
Upstream failures of the optional parts (split, recorded split) are reported, never raised.
"""
import explorer
import sources


def _recorded_split(day):
    try:
        r = sources.recorded_day(day)
    except sources.UPSTREAM_ERRORS:
        return None
    return {'status': r['status'], 'windMwh': r['windMwh'], 'solarMwh': r['solarMwh'],
            'windSharePercent': r['windSharePercent'], 'solarSharePercent': r['solarSharePercent']}


def headline(value):
    """{date, model, probability, predictedMwh, split, recorded}. 404 (LookupError) outside V2's dataset."""
    day, info = explorer.validate_day(value)
    prediction, actual, split, recorded = explorer.parallel(
        lambda: explorer._daily_prediction(day), lambda: explorer._daily_actuals([day])[day],
        lambda: sources.forecast_split(day), lambda: _recorded_split(day))
    model = info['model']
    return {
        'date': day,
        'model': {'id': 'v2', 'version': prediction.get('modelVersion') or model['version'], 'experimental': model['experimental'],
                  'test': {k: model['test'].get(k) for k in ('rows', 'dailyMaeMwh', 'zeroBaselineMaeMwh', 'rocAuc')}},
        'issuedAt': prediction.get('issuedAt'), 'weatherAvailableAt': prediction.get('weatherAvailableAt'),
        'probability': prediction['probability'], 'predictedMwh': prediction['predictedMwh'],
        'split': ({k: split[k] for k in ('windMwh', 'solarMwh', 'windSharePercent', 'solarSharePercent', 'version')}
                  | {'status': 'ok'}) if split.get('status') == 'ok' else {'status': split.get('status'), 'message': split.get('message')},
        'recorded': {'status': actual['status'], 'curtailmentMwh': actual['curtailmentMwh'],
                     'split': recorded if recorded and recorded['status'] == 'available' else None},
    }


def warm(days):
    """Fetch the headline for each dashboard day ahead of time (background, best effort)."""
    for day in days:
        try:
            headline(day)
        except Exception:  # a cold cache only costs the first viewer a few seconds
            pass
