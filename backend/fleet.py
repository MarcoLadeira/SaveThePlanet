"""Simulated fleet schema (fleet/v1): validation, presets and half-hour availability.

Times are minutes relative to the forecast issue time, so one fixture can be replayed
against any historical forecast. Nothing here is real telemetry.
"""
import json
import math
from pathlib import Path

SCHEMA_VERSION = 'fleet/v1'
PRESETS_PATH = Path(__file__).resolve().parents[1] / 'data' / 'fleets' / 'presets-v1.json'
SLOT_MINUTES = 30
MAX_VEHICLES = 200
MAX_SITES = 20
MAX_HORIZON_MINUTES = 24 * 60  # plans cover at most 48 half-hours after the issue time
REGIONS = ('IE', 'NI', 'other')
_presets = None


def presets():
    """The versioned demo fixture, loaded once."""
    global _presets
    if _presets is None:
        _presets = json.loads(PRESETS_PATH.read_text(encoding='utf-8'))
    return _presets


def preset(preset_id):
    for item in presets()['presets']:
        if item['id'] == preset_id:
            return item
    raise ValueError(f'Unknown fleet preset {preset_id!r}')


def _number(value, name, minimum=0.0, maximum=None, exclusive_min=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f'{name} must be a finite number')
    if value < minimum or (exclusive_min and value == minimum) or (maximum is not None and value > maximum):
        raise ValueError(f'{name} is out of range')
    return float(value)


def _text(value, name, limit=60):
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise ValueError(f'{name} must be a short non-empty string')
    return value.strip()


def validate(fleet):
    """Validate a fleet/v1 object and return a clean copy. Raises ValueError with a readable message."""
    if not isinstance(fleet, dict):
        raise ValueError('Fleet must be an object')
    efficiency = _number(fleet.get('chargingEfficiency', 0.9), 'chargingEfficiency', 0, 1, exclusive_min=True)
    sites_in, vehicles_in = fleet.get('sites'), fleet.get('vehicles')
    if not isinstance(sites_in, list) or not 1 <= len(sites_in) <= MAX_SITES:
        raise ValueError(f'Fleet needs 1-{MAX_SITES} sites')
    if not isinstance(vehicles_in, list) or len(vehicles_in) > MAX_VEHICLES:
        raise ValueError(f'Fleet can have at most {MAX_VEHICLES} vehicles')
    sites = {}
    for raw in sites_in:
        if not isinstance(raw, dict):
            raise ValueError('Each site must be an object')
        site_id = _text(raw.get('id'), 'site id', 30)
        if site_id in sites:
            raise ValueError(f'Duplicate site id {site_id}')
        region = raw.get('region', 'IE')
        if region not in REGIONS:
            raise ValueError(f'Site region must be one of {", ".join(REGIONS)}')
        chargers = raw.get('chargers')
        if isinstance(chargers, bool) or not isinstance(chargers, int) or not 0 <= chargers <= 500:
            raise ValueError('Site chargers must be a whole number from 0 to 500')
        sites[site_id] = dict(
            id=site_id, name=_text(raw.get('name', site_id), 'site name'), region=region,
            hypotheticalConstraintZone=raw.get('hypotheticalConstraintZone', False) is True,
            chargers=chargers, chargerKw=_number(raw.get('chargerKw'), 'chargerKw', 0, 350, exclusive_min=True),
            sitePowerKw=_number(raw.get('sitePowerKw'), 'sitePowerKw', 0, 100_000))
    vehicles, seen = [], set()
    for raw in vehicles_in:
        if not isinstance(raw, dict):
            raise ValueError('Each vehicle must be an object')
        vehicle_id = _text(raw.get('id'), 'vehicle id', 30)
        if vehicle_id in seen:
            raise ValueError(f'Duplicate vehicle id {vehicle_id}')
        seen.add(vehicle_id)
        if raw.get('site') not in sites:
            raise ValueError(f'{vehicle_id} refers to an unknown site')
        arrive = _number(raw.get('arriveMin'), f'{vehicle_id} arriveMin', -MAX_HORIZON_MINUTES, MAX_HORIZON_MINUTES)
        depart = _number(raw.get('departMin'), f'{vehicle_id} departMin', -MAX_HORIZON_MINUTES, MAX_HORIZON_MINUTES)
        if depart <= arrive:
            raise ValueError(f'{vehicle_id} must depart after it arrives')
        vehicles.append(dict(
            id=vehicle_id, site=raw['site'], arriveMin=arrive, departMin=depart,
            requiredKwh=_number(raw.get('requiredKwh'), f'{vehicle_id} requiredKwh', 0, 500),
            maxKw=_number(raw.get('maxKw'), f'{vehicle_id} maxKw', 0, 350, exclusive_min=True)))
    return dict(schemaVersion=SCHEMA_VERSION, chargingEfficiency=efficiency,
                sites=list(sites.values()), vehicles=vehicles)


def slot_count(fleet):
    """Half-hours from the issue time to the last departure, capped at 48."""
    latest = max((v['departMin'] for v in fleet['vehicles']), default=0)
    return max(0, min(MAX_HORIZON_MINUTES, math.floor(latest / SLOT_MINUTES) * SLOT_MINUTES)) // SLOT_MINUTES


def available_slots(vehicle, slots):
    """Indices of whole half-hours a vehicle is plugged in for.

    Slot i covers [issue + 30i, issue + 30(i+1)). Arrivals round up and departures round
    down to the half-hour, so a vehicle is never scheduled while absent. Charging before
    the issue time is outside the plan: the requirement is what remains at the issue time.
    """
    first = max(0, math.ceil(vehicle['arriveMin'] / SLOT_MINUTES))
    last = min(slots, math.floor(vehicle['departMin'] / SLOT_MINUTES))
    return range(first, max(first, last))
