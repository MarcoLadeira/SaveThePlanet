"""Wind & Solar page (issue #65): where Ireland's curtailed renewable power came from, and when.

Four GridToEv routes, all called here so the API key never reaches the browser:

- GET  /actuals/curtailment/sources/coverage   which days EirGrid recorded (recorded)
- GET  /actuals/curtailment/sources            one day's wind/solar split, 48 half-hours (recorded)
- POST /predict/curtailment/sources/day        V2's daily total split into wind/solar (experimental forecast)
- GET  /model-info/curtailment/sources         how that split works and how accurate it is so far

Rules kept throughout: a null from the API means *unknown* and stays None (never 0); the
forecast is an optional panel, so its failures are returned as a status, never raised, and the
recorded data still renders. Everything derived (peak, best charging window, errors, EV
equivalents) is computed here, once, and covered by tests.
"""
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from http.client import HTTPException
import json
import logging
import math
import threading
import time
from urllib.error import HTTPError, URLError

import explorer
from scenario import DEFAULT_KWH_PER_CHARGE, EV_KWH_PER_KM, GRID_INTENSITY_T_PER_MWH

log = logging.getLogger(__name__)

FORECAST_FIRST_DAY = '2024-04-01'  # the split forecast has no archived weather before this day
SLOT_HOURS = 0.5
WINDOW_SLOTS = 8  # best charging window: up to 4 hours of consecutive half-hours
SOLAR_HOURS_MIN_MWH = 1.0  # EirGrid records tiny night-time solar values; ignore them in the summary only
INFO_SECONDS = explorer.INFO_CACHE_SECONDS
PENDING_SECONDS = 600  # a pending/missing day may be published at the next archive refresh
FINAL_STATUSES = {'available', 'solar_not_published'}  # history that will not change
MONTH_WORKERS = 6  # recorded-day lookups are light (~0.5 s); bound them so a month never floods GridToEv
SUGGEST_LOOKBACK_DAYS = 14
RECONCILE_TOLERANCE_MWH = 0.01
UPSTREAM_ERRORS = (HTTPError, URLError, TimeoutError, OSError, HTTPException, ValueError, KeyError, TypeError)



class OutOfRange(Exception):
    """The requested day or month is outside what the page can show (HTTP 404). Not a LookupError, so a
    KeyError from a malformed upstream answer is never mistaken for it."""


_lock = threading.Lock()
_cache = {}  # key -> (stored_at, ttl_seconds or None, value)


def _cached(key, build, ttl_for):
    """Memoise build(); ttl_for(value) says how long to keep it (None = forever, 0 = do not keep)."""
    now = time.monotonic()
    with _lock:
        hit = _cache.get(key)
        if hit and (hit[1] is None or now - hit[0] < hit[1]):
            return hit[2]
    value = build()
    ttl = ttl_for(value)
    if ttl != 0:
        with _lock:
            _cache[key] = (now, ttl, value)
    return value


def clear_cache():
    with _lock:
        _cache.clear()


def _num(value, name, optional=True):
    """A finite float, or None when the API says unknown. Never turns None into 0."""
    return explorer.finite(value, name, optional=optional)


def _add_minutes(stamp, minutes):
    return explorer.iso(explorer.utc(stamp) + timedelta(minutes=minutes))


def _today():
    return datetime.now(timezone.utc).date()


# ---------------------------------------------------------------- coverage
def coverage():
    def build():
        body = explorer.call('/actuals/curtailment/sources/coverage')
        return {
            'archiveFrom': explorer.utc(body['first_half_hour_utc']).date().isoformat(),
            'archiveLastHalfHour': body['last_half_hour_utc'],
            'solarFrom': body.get('solar_first_published_utc'),
            'completeFrom': body.get('complete_day_min_utc'),
            'completeTo': body.get('complete_day_max_utc'),
            'completeDays': body.get('complete_day_count'),
            'source': body.get('source'),
            'notice': body.get('notice'),
        }
    return _cached('coverage', build, lambda _: INFO_SECONDS)


def date_range():
    """The days the page can open: the whole recorded archive (early days are wind only) up to
    today, since days after the archive can still have a forecast."""
    c = coverage()
    return c['archiveFrom'], max(c['completeTo'] or c['archiveFrom'], _today().isoformat())


def validate_day(value):
    day = date.fromisoformat(str(value)).isoformat()
    first, last = date_range()
    if not first <= day <= last:
        raise OutOfRange(f'Pick a day from {first} to {last}.')
    return day


# ---------------------------------------------------------------- recorded (EirGrid)
def _recorded(body, day):
    rows = body.get('half_hours') or []
    halves = [{'at': explorer.iso(explorer.utc(r['timestamp_utc'])),
               'windMwh': _num(r.get('wind_curtailment_mwh'), 'wind'),
               'solarMwh': _num(r.get('solar_curtailment_mwh'), 'solar')} for r in rows]
    status = body.get('status')
    if status in FINAL_STATUSES and len(halves) != 48:
        raise ValueError(f'Expected 48 half-hours for {day}, got {len(halves)}')
    return {
        'status': status, 'date': body.get('target_date_utc') or day,
        'windMwh': _num(body.get('wind_curtailment_mwh'), 'wind'),
        'solarMwh': _num(body.get('solar_curtailment_mwh'), 'solar'),
        'totalMwh': _num(body.get('total_curtailment_mwh'), 'total'),
        'windSharePercent': _num(body.get('wind_share_percent'), 'wind share'),
        'solarSharePercent': _num(body.get('solar_share_percent'), 'solar share'),
        'completeHalfHours': body.get('complete_half_hour_count'),
        'archiveLatest': body.get('source_latest_timestamp_utc'),
        'summary': body.get('summary'),
        'halfHours': halves or None,
    }


def recorded_day(day):
    """One recorded day. Published history is kept forever; pending/missing days for 10 minutes."""
    return _cached(('recorded', day),
                   lambda: _recorded(explorer.call(f'/actuals/curtailment/sources?target_date_utc={day}&include_half_hours=true'), day),
                   lambda value: None if value['status'] in FINAL_STATUSES else PENDING_SECONDS)


# ---------------------------------------------------------------- experimental forecast
def _error_detail(error):
    """The FastAPI `detail` of an upstream error, as text."""
    try:
        raw = error.read()
        detail = json.loads(raw or b'null').get('detail')
    except (ValueError, AttributeError, OSError):
        return None
    finally:
        error.close()
    if isinstance(detail, dict):
        detail = detail.get('message') or detail.get('error')
    return str(detail)[:300] if detail else None


def _forecast(body, day):
    total = _num(body['predicted_curtailment_mwh'], 'total', optional=False)
    wind = _num(body['predicted_wind_curtailment_mwh'], 'wind', optional=False)
    solar = _num(body['predicted_solar_curtailment_mwh'], 'solar', optional=False)
    gap = abs(wind + solar - total)
    if gap > RECONCILE_TOLERANCE_MWH or (body.get('reconciliation_error_mwh') or 0) > RECONCILE_TOLERANCE_MWH:
        log.warning('source split for %s does not add up: wind %.3f + solar %.3f vs total %.3f', day, wind, solar, total)
    proxy = body.get('capacity_proxy') or {}
    return {
        'status': 'ok', 'date': body.get('target_date_utc') or day,
        'version': body.get('model_version'), 'parentVersion': body.get('parent_model_version'),
        'experimental': bool(body.get('experimental', True)), 'validationStatus': body.get('validation_status'),
        'issuedAt': body.get('issue_timestamp_utc'), 'weatherAvailableAt': body.get('forecast_max_available_at_utc'),
        'probability': _num(body['curtailment_event_probability'], 'probability', optional=False),
        'totalMwh': total, 'windMwh': wind, 'solarMwh': solar,
        'windSharePercent': _num(body.get('predicted_wind_share_percent'), 'wind share'),
        'solarSharePercent': _num(body.get('predicted_solar_share_percent'), 'solar share'),
        'capacity': {'windMw': _num(proxy.get('wind_mw'), 'wind MW'), 'solarMw': _num(proxy.get('solar_mw'), 'solar MW'),
                     'dataThrough': proxy.get('published_data_through_utc')},
        'summary': body.get('summary'), 'notice': body.get('notice'),
    }


def forecast_split(day):
    """Never raises: {'status': 'ok' | 'not_forecastable' | 'unavailable', ...}. Only successes are cached
    (a day's forecast is fixed at 00:00 UTC that day); failures are asked again next time."""
    if day < FORECAST_FIRST_DAY:
        return {'status': 'not_forecastable', 'message': 'The wind/solar forecast starts on 1 April 2024.'}

    def build():
        try:
            return _forecast(explorer.call('/predict/curtailment/sources/day', {'target_date_utc': day}), day)
        except HTTPError as error:
            detail = _error_detail(error)
            if error.code == 422:
                return {'status': 'not_forecastable', 'message': detail or 'The model cannot forecast this day.'}
            return {'status': 'unavailable', 'message': detail or f'The model service answered HTTP {error.code}.'}
        except UPSTREAM_ERRORS as error:
            return {'status': 'unavailable', 'message': 'The model service could not be reached.'
                    if not isinstance(error, (ValueError, KeyError, TypeError)) else 'The model returned an unexpected answer.'}
    return _cached(('forecast', day), build, lambda value: None if value['status'] == 'ok' else 0)


def split_info():
    """The split method, from /model-info/curtailment/sources. Never raises."""
    def build():
        try:
            body = explorer.call('/model-info/curtailment/sources')
        except UPSTREAM_ERRORS as error:
            detail = _error_detail(error) if isinstance(error, HTTPError) else None
            return {'status': 'unavailable', 'message': detail or 'The model information could not be reached.'}
        validation = body.get('validation') or {}
        fresh = validation.get('fresh_confirmation') or {}
        test = validation.get('provisional_2026_test') or {}
        return {
            'status': 'ok', 'version': body.get('model_version'), 'parentVersion': body.get('parent_model_version'),
            'experimental': bool(body.get('experimental', True)), 'method': body.get('method'),
            'plainLanguage': body.get('plain_language'), 'formula': body.get('formula'),
            'intercept': _num(body.get('intercept'), 'intercept'), 'slope': _num(body.get('slope'), 'slope'),
            'fittedOn': body.get('fitted_on') or [], 'constants': body.get('fixed_constants') or {},
            'capacityRule': body.get('capacity_rule'), 'capacityThrough': body.get('capacity_history_through_utc'),
            'requestable': {'from': body.get('requestable_date_min_utc'), 'to': body.get('requestable_date_max_utc')},
            'validation': {
                'status': validation.get('status'),
                'fresh': {'status': fresh.get('status'), 'rows': fresh.get('rows'), 'required': fresh.get('required_rows')},
                'provisional': {'note': test.get('note'), 'baseline': test.get('baseline'),
                                'maeMwh': _num(test.get('combined_source_mae_mwh'), 'mae'),
                                'baselineMaeMwh': _num(test.get('baseline_combined_source_mae_mwh'), 'baseline mae'),
                                'solarMaeMwh': _num(test.get('solar_active_solar_mae_mwh'), 'solar mae'),
                                'baselineSolarMaeMwh': _num(test.get('baseline_solar_active_solar_mae_mwh'), 'baseline solar mae')},
            },
            'limitations': body.get('limitations') or [],
        }
    return _cached('info', build, lambda value: INFO_SECONDS if value['status'] == 'ok' else 0)


# ---------------------------------------------------------------- derived values
def ev_equivalent(mwh):
    """An energy comparison, not scheduled cars: 100% charging efficiency, as on the About page."""
    if mwh is None:
        return None
    kwh = mwh * 1000
    return {'kwh': round(kwh, 1), 'charges': round(kwh / DEFAULT_KWH_PER_CHARGE, 1), 'kwhPerCharge': DEFAULT_KWH_PER_CHARGE,
            'rangeKm': round(kwh / EV_KWH_PER_KM), 'co2Tonnes': round(mwh * GRID_INTENSITY_T_PER_MWH, 1)}


def _slot_totals(halves):
    """Curtailed MWh per half-hour. Solar that EirGrid did not publish is left out (wind only),
    and the caller is told, rather than being counted as zero."""
    wind_only = any(h['solarMwh'] is None for h in halves)
    return [(h['windMwh'] or 0) + (h['solarMwh'] or 0) for h in halves], wind_only


def best_window(halves, capacity_mw, slots=WINDOW_SLOTS):
    """The run of up to `slots` consecutive half-hours in which flexible charging of `capacity_mw`
    could have absorbed the most curtailed energy: sum(min(curtailed, capacity x 0.5 h)).
    Ties (common once the cap binds) go to the most curtailed energy, then the shortest run (no empty
    half-hours padding it), then the earliest."""
    totals, _ = _slot_totals(halves)
    cap = capacity_mw * SLOT_HOURS
    best = None
    for start in range(len(totals)):
        absorbed = curtailed = 0.0
        for length in range(1, slots + 1):
            end = start + length
            if end > len(totals):
                break
            absorbed += min(totals[end - 1], cap)
            curtailed += totals[end - 1]
            key = (round(absorbed, 6), round(curtailed, 6), -length, -start)
            if absorbed > 0 and (best is None or key > best[0]):
                best = (key, start, length, absorbed, curtailed)
    if best is None:
        return None
    _, start, length, absorbed, curtailed = best
    return {'start': halves[start]['at'], 'end': _add_minutes(halves[start + length - 1]['at'], 30), 'slots': length,
            'capacityMw': capacity_mw, 'absorbableMwh': round(absorbed, 3), 'curtailedMwh': round(curtailed, 3),
            'ev': ev_equivalent(absorbed)}


def day_profile(halves):
    """Peak half-hour and the span of real solar curtailment (>= 1 MWh) for the summary line."""
    totals, wind_only = _slot_totals(halves)
    if not any(totals):
        return {'peak': None, 'solarHours': None, 'curtailedHalfHours': 0, 'windOnly': wind_only}
    peak = max(range(len(totals)), key=lambda i: (totals[i], -i))
    solar = [i for i, h in enumerate(halves) if (h['solarMwh'] or 0) >= SOLAR_HOURS_MIN_MWH]
    return {
        'peak': {'at': halves[peak]['at'], 'totalMwh': round(totals[peak], 3),
                 'windMwh': halves[peak]['windMwh'], 'solarMwh': halves[peak]['solarMwh']},
        'solarHours': {'from': halves[solar[0]]['at'], 'to': _add_minutes(halves[solar[-1]]['at'], 30)} if solar else None,
        'curtailedHalfHours': sum(1 for t in totals if t > 0), 'windOnly': wind_only,
    }


def potential_ratio(wind_share_percent, info):
    """Work the split formula backwards: wind share -> forecast wind:solar potential energy ratio.
    share = 1 / (1 + e^-(a + b x)), x = ln((wind + 1) / (solar + 1))  =>  x = (logit(share) - a) / b."""
    if wind_share_percent is None or info.get('status') != 'ok' or not info.get('slope'):
        return None
    share = wind_share_percent / 100
    if not 0 < share < 1:
        return None
    x = (math.log(share / (1 - share)) - info['intercept']) / info['slope']
    return {'x': round(x, 4), 'ratio': round(math.exp(x), 3)}


def compare(recorded, forecast):
    """Forecast minus recorded. The split's own error (share points) is kept apart from V2's total error."""
    if forecast.get('status') != 'ok' or recorded.get('totalMwh') is None:
        return None
    diff = lambda predicted, actual: None if actual is None else round(predicted - actual, 3)
    share = recorded.get('windSharePercent')
    return {
        'totalErrorMwh': diff(forecast['totalMwh'], recorded['totalMwh']),
        'windErrorMwh': diff(forecast['windMwh'], recorded['windMwh']),
        'solarErrorMwh': diff(forecast['solarMwh'], recorded['solarMwh']),
        'shareErrorPoints': None if share is None or forecast['windSharePercent'] is None
        else round(forecast['windSharePercent'] - share, 2),
        'nothingCurtailed': recorded['totalMwh'] == 0,
    }


def derived(recorded, forecast, info, capacity_mw):
    halves = recorded.get('halfHours')
    return {
        'profile': day_profile(halves) if halves else None,
        'bestWindow': best_window(halves, capacity_mw) if halves else None,
        'recordedEv': ev_equivalent(recorded.get('totalMwh')),
        'comparison': compare(recorded, forecast),
        'potentialRatio': potential_ratio(forecast.get('windSharePercent'), info) if forecast.get('status') == 'ok' else None,
    }


# ---------------------------------------------------------------- page routes
def day(value, capacity_mw):
    """Everything about one day in one answer: recorded, forecast and derived values."""
    day = validate_day(value)
    recorded, forecast, info = explorer.parallel(lambda: recorded_day(day), lambda: forecast_split(day), split_info)
    return {'date': day, 'recorded': recorded, 'forecast': forecast, 'derived': derived(recorded, forecast, info, capacity_mw)}


# The page asks for the two halves separately: a recorded day takes ~0.6 s upstream, but a cold
# forecast ~7 s (GridToEv fetches the archived weather), so the recorded figures never wait for it.
def recorded_view(value, capacity_mw):
    day = validate_day(value)
    recorded = recorded_day(day)
    halves = recorded.get('halfHours')
    return {'date': day, 'recorded': recorded, 'derived': {
        'profile': day_profile(halves) if halves else None,
        'bestWindow': best_window(halves, capacity_mw) if halves else None,
        'recordedEv': ev_equivalent(recorded.get('totalMwh')),
    }}


def forecast_view(value):
    day = validate_day(value)
    recorded, forecast, info = explorer.parallel(lambda: recorded_day(day), lambda: forecast_split(day), split_info)
    return {'date': day, 'forecast': forecast, 'comparison': compare(recorded, forecast),
            'potentialRatio': potential_ratio(forecast.get('windSharePercent'), info) if forecast.get('status') == 'ok' else None}


def suggested_day():
    """The most recent day with recorded curtailment, so the page never opens on an empty day."""
    def build():
        last = date.fromisoformat(coverage()['completeTo'])
        days = [(last - timedelta(days=i)).isoformat() for i in range(SUGGEST_LOOKBACK_DAYS)]
        with ThreadPoolExecutor(max_workers=MONTH_WORKERS) as pool:
            found = list(pool.map(_recorded_or_none, days))
        return next((d for d, r in zip(days, found) if r and (r['totalMwh'] or 0) > 0), days[0])
    return _cached('suggested', build, lambda _: INFO_SECONDS)


def page_coverage():
    first, last = date_range()
    return {**coverage(), 'from': first, 'to': last, 'forecastFrom': FORECAST_FIRST_DAY, 'suggestedDay': suggested_day()}


def _recorded_or_none(day):
    try:
        return recorded_day(day)
    except UPSTREAM_ERRORS:
        return None


def month(value):
    """Daily totals for one calendar month (the heat-map). Days are fetched at most MONTH_WORKERS at a
    time and share the per-day cache, so a month that was browsed day by day costs nothing."""
    start = date.fromisoformat(f'{value}-01')
    first, last = date_range()
    days = []
    d = start
    while d.month == start.month:
        if first <= d.isoformat() <= min(last, _today().isoformat()):
            days.append(d.isoformat())
        d += timedelta(days=1)
    if not days:
        raise OutOfRange('That month has no recorded days.')
    with ThreadPoolExecutor(max_workers=MONTH_WORKERS) as pool:
        found = list(pool.map(_recorded_or_none, days))
    rows = []
    for d, r in zip(days, found):
        if r is None:
            rows.append({'date': d, 'status': 'error', 'windMwh': None, 'solarMwh': None, 'totalMwh': None, 'solarSharePercent': None})
        else:
            rows.append({'date': d, 'status': r['status'], 'windMwh': r['windMwh'], 'solarMwh': r['solarMwh'],
                         'totalMwh': r['totalMwh'], 'solarSharePercent': r['solarSharePercent']})
    known = [r for r in rows if r['totalMwh'] is not None]
    wind = sum(r['windMwh'] or 0 for r in known)
    solar = sum(r['solarMwh'] or 0 for r in known if r['solarMwh'] is not None)
    total = sum(r['totalMwh'] for r in known)
    return {'month': value, 'days': rows,
            'totals': {'windMwh': round(wind, 3), 'solarMwh': round(solar, 3), 'totalMwh': round(total, 3),
                       'solarSharePercent': round(solar / total * 100, 2) if total else None,
                       'daysKnown': len(known), 'daysCurtailed': sum(1 for r in known if r['totalMwh'] > 0)}}
