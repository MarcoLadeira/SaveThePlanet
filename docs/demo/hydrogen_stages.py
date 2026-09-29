"""Writes docs/demo/data/hydrogen-stages-2026-01-24.json for slide 12 (issue #76).

The Impact page's hydrogen scenario (backend/hydrogen.py) run on GridToEv V1 model 1.1.0's real +30-minute
predictions for the replay week 24-31 January 2026 (backend/.cache/v1-plus30-index-1.1.0-1434.json). That file
holds the total energy at risk per half-hour, so it stands in for the curtailment forecast the app uses.
Run: python docs/demo/hydrogen_stages.py
"""
from datetime import datetime, timedelta
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'backend'))
import business  # noqa: E402
import hydrogen  # noqa: E402

index = json.loads((ROOT / 'backend/.cache/v1-plus30-index-1.1.0-1434.json').read_text())['targets']
nights = []
for k in range(7):
    day = (datetime(2026, 1, 24) + timedelta(days=k)).date().isoformat()
    slots = business.night_slots(day)
    forecasts = []
    for s in slots:
        p = index.get(s['start'])
        if p is None:
            continue
        issued = datetime.fromisoformat(s['start'].replace('Z', '+00:00')) - timedelta(minutes=30)
        forecasts.append({'targetAt': s['start'], 'issuedAt': issued.strftime('%Y-%m-%dT%H:%M:%SZ'),
                          'curtailmentKwh': p['mwh'] * 1000, 'probability': p['probability']})
    nights.append({'date': day, 'index': k, 'slots': slots, 'forecasts': forecasts, 'observed': {s['start']: None for s in slots}})
block = hydrogen.build(nights)
out = {
    'what': 'Where the eligible spare energy of the replay week could go, in three EV-market stages (backend/hydrogen.py).',
    'source': 'GridToEv V1 model 1.1.0, +30-minute predictions of energy at risk, 24-31 January 2026 (predictions, not outcomes).',
    'assumptions': 'Hypothetical 1.5 MW network access; EVs first, then the Dashboard grid battery (10 MWh, from 40%); '
                   'once it is full the surplus goes to a hypothetical 1 MW electrolyser (55 kWh/kg). Simulated; no ESB agreement.',
    'eligibleMwh': round(block['forecast']['eligibleKwh'] / 1000, 1),
    'stages': [{'id': s['id'], 'label': s['label'], 'vehicles': s['vehicles'], 'targetEvShare': s['targetEvShare'],
                'shares': {k: round(s['shares'][k], 4) for k in ('evTotal', 'battery', 'hydrogen', 'unused')},
                'hydrogenMwh': round(s['totals']['hydrogenKwh'] / 1000, 1), 'hydrogenKg': round(s['totals']['hydrogenKg']),
                'batteryFullAt': s['gridBattery']['fullAt']} for s in block['stages']],
}
path = Path(__file__).with_name('data') / 'hydrogen-stages-2026-01-24.json'
path.write_text(json.dumps(out, indent=1) + '\n')
print('wrote', path)
